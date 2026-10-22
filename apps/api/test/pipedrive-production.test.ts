import { PipedriveAdapterError } from "../src/pipedrive/pipedrive.adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  conversionEventNameSchema,
  conversionEventCarriesValue,
} from "@wpptrack/shared";
import {
  productionEnv,
  productionHarness,
} from "./support/pipedrive-production-harness";
import { ruleInput } from "./support/pipedrive-observation-harness";
import { ConversionEventProcessor } from "../src/common/queue/conversion-event.processor";
import { deferred } from "./support/pipedrive-harness";
import {
  actor,
  allowedLicense,
  lockedLicense,
} from "./support/pipedrive-harness";

beforeEach(productionEnv);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function selected(
  eventName: (typeof conversionEventNameSchema.options)[number] = "QualifiedLead",
) {
  const h = await productionHarness();
  await h.webhooks.createRule("workspace-a", h.c.id, actor, {
    ...ruleInput,
    mode: "production",
    eventName,
    ...(conversionEventCarriesValue(eventName) ? { currency: "BRL" } : {}),
  });
  h.setNow(new Date(+h.now + 1000));
  return h;
}

describe("Pipedrive canonical production flow, synthetic storage and injected Meta fetch only", () => {
  it.each(conversionEventNameSchema.options)(
    "materializes, publishes and sends catalog event %s exactly once",
    async (eventName) => {
      const h = await selected(eventName);
      const event = await h.receive();
      expect(h.state.conversionEventLog).toHaveLength(0); // HTTP acknowledgement precedes materialization.
      expect(await h.webhooks.process(event.id, "workspace-a")).toMatchObject({
        status: "materialized",
      });
      expect(h.state.conversionEventLog).toHaveLength(1);
      const log = h.state.conversionEventLog![0]!;
      expect(log).toMatchObject({
        sourceTrigger: "pipedrive_stage",
        eventName,
        leadId: "lead-a",
        ctwaClid: "synthetic-existing-ctwa",
      });
      expect(h.fetcher).not.toHaveBeenCalled();
      await h.webhooks.sweep();
      expect(h.jobs.size).toBe(1);
      expect(h.bull.add).toHaveBeenCalledWith(
        "send-ready-event",
        { conversionEventLogId: log.id, workspaceId: "workspace-a" },
        expect.objectContaining({
          attempts: 3,
          jobId: expect.stringMatching(/^conversion-send/),
        }),
      );
      const processor = new ConversionEventProcessor(h.conversions, h.client);
      expect(
        await processor.process({
          id: "synthetic-job",
          name: "send-ready-event",
          data: { conversionEventLogId: log.id, workspaceId: "workspace-a" },
          attemptsMade: 0,
        } as any),
      ).toMatchObject({ status: "sent" });
      const sent = JSON.parse(h.fetcher.mock.calls[0]![1].body as string);
      expect(sent.data[0]).toMatchObject({
        event_name: eventName,
        event_id: log.eventId,
      });
      expect(sent.data[0].user_data.ctwa_clid).toBe("synthetic-existing-ctwa");
      await h.receive();
      await h.webhooks.sweep();
      expect(
        await h.conversions.sendReadyEvent(log.id, {
          workspaceId: "workspace-a",
        }),
      ).toMatchObject({ status: "skipped" });
      expect(h.fetcher).toHaveBeenCalledOnce();
      expect(h.state.conversionEventLog).toHaveLength(1);
      expect(h.state.pipedriveConversionDedupe).toHaveLength(1);
      expect(h.client.lead.create).not.toHaveBeenCalled();
      const view = await h.webhooks.listEvents("workspace-a", h.c.id);
      expect(view[0]).toMatchObject({
        status: "materialized",
        results: [
          expect.objectContaining({
            deliveryStatus: "sent",
            conversionEventLogId: log.id,
          }),
        ],
      });
    },
  );
  // Student edition: no SaaS environment opt-in (the SaaS
  // PIPEDRIVE_CONVERSION_PRODUCTION_ENABLED flag does not exist). Like the
  // student Kommo, production is decided per rule and requires the license.
  it.each([
    "PIPEDRIVE_CONVERSION_PRODUCTION_ENABLED",
    "INBOUND_WEBHOOKS_ENABLED",
    "INBOUND_WEBHOOK_PRODUCTION_ENABLED",
    "INBOUND_CONVERSION_RULES_ENABLED",
    "INBOUND_CONVERSION_PRODUCTION_ENABLED",
  ])("production is per rule and does not depend on %s", async (key) => {
    const h = await productionHarness();
    vi.stubEnv(key, "false");
    const rule = await h.webhooks.createRule("workspace-a", h.c.id, actor, {
      ...ruleInput,
      mode: "production",
    });
    expect(rule).toMatchObject({ mode: "production" });
    expect(h.state.pipedriveConversionRule).toHaveLength(1);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("a locked license stops processing, materialization and publication", async () => {
    const h = await selected();
    const event = await h.receive();
    (h.webhooks as any).licenseClient = lockedLicense;
    expect(await h.webhooks.process(event.id, "workspace-a")).toMatchObject({
      status: "license_locked",
    });
    expect(await h.webhooks.sweep()).toMatchObject({ scanned: 0 });
    expect(h.state.conversionEventLog).toHaveLength(0);
    expect(h.state.pipedriveConversionDedupe).toHaveLength(0);
    expect(h.jobs.size).toBe(0);
    // Unlocked again: the durable inbox is processed normally.
    (h.webhooks as any).licenseClient = allowedLicense;
    expect(await h.webhooks.process(event.id, "workspace-a")).toMatchObject({
      status: "materialized",
    });
    expect(h.state.conversionEventLog).toHaveLength(1);
  });
  it("a missing license client is treated as locked (fail-closed)", async () => {
    const h = await selected();
    const event = await h.receive();
    (h.webhooks as any).licenseClient = undefined;
    expect(await h.webhooks.process(event.id, "workspace-a")).toMatchObject({
      status: "license_locked",
    });
    expect(h.state.conversionEventLog).toHaveLength(0);
  });
  it("observation does not consume production dedupe or authorize historical receipts", async () => {
    const h = await productionHarness();
    const r = await h.webhooks.createRule(
      "workspace-a",
      h.c.id,
      actor,
      ruleInput,
    );
    const e = await h.receive();
    await h.webhooks.process(e.id, "workspace-a");
    h.setNow(new Date(+h.now + 1000));
    await h.webhooks.updateRule("workspace-a", h.c.id, r.id, actor, {
      mode: "production",
    });
    h.setNow(new Date(+h.now + 1000));
    const fresh = await h.receive({
      meta: {
        action: "change",
        entity: "deal",
        version: "2.0",
        company_id: 1,
        host: "synthetic.pipedrive.com",
        id: "fresh",
        timestamp: h.now.toISOString(),
      },
    });
    const outcome = await h.webhooks.process(fresh.id, "workspace-a");
    expect(
      outcome,
      JSON.stringify(h.state.pipedriveWebhookEvent, (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      ),
    ).toMatchObject({ status: "materialized" });
    expect(
      h.state.pipedriveConversionDedupe!.map((r) => r.mode).sort(),
    ).toEqual(["observation", "production"]);
    expect(h.state.conversionEventLog).toHaveLength(1);
  });
  it.each(["adId", "ctwaClid", "whatsappInstanceId"])(
    "never creates attribution or dispatches without existing %s",
    async (field) => {
      const h = await selected();
      h.state.lead![0]![field] = null;
      const event = await h.receive();
      await h.webhooks.sweep();
      expect(h.state.pipedriveWebhookEvent![0]!.status).toBe("ignored");
      expect(h.state.conversionEventLog).toHaveLength(0);
      expect(h.jobs.size).toBe(0);
      expect(h.fetcher).not.toHaveBeenCalled();
      expect(h.client.lead.create).not.toHaveBeenCalled();
      expect(h.client.lead.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each(["missing", "wrong_destination", "wrong_account"])(
    "requires proven ad destination: %s",
    async (kind) => {
      const h = await selected();
      if (kind === "missing")
        h.client.metaAdDestinationAssignment.findUnique.mockResolvedValue(null);
      if (kind === "wrong_destination")
        h.assignment.conversionDestinationId = "foreign";
      if (kind === "wrong_account") h.assignment.reportingAccountId = "foreign";
      await h.receive();
      await h.webhooks.sweep();
      expect(h.state.pipedriveWebhookEvent![0]!.errorCode).toMatch(
        /lead_destination/,
      );
      expect(h.state.conversionEventLog).toHaveLength(0);
      expect(h.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    "uncertified",
    "paused_channel",
    "paused_provider",
    "removed_provider",
    "inactive_instance",
    "foreign_workspace",
    "invalid_route",
    "inactive_credential",
    "inactive_business",
    "inactive_reporting",
    "unconfigured_destination",
  ])("requires existing channel/asset policy: %s", async (kind) => {
    const h = await selected();
    switch (kind) {
      case "uncertified":
        h.route.channel.connection.parserRelease.status = "draft";
        break;
      case "paused_channel":
        h.route.channel.status = "paused";
        break;
      case "paused_provider":
        h.route.channel.connection.status = "paused";
        break;
      case "removed_provider":
        h.route.channel.connection.removedAt = h.now;
        break;
      case "inactive_instance":
        h.route.channel.whatsappInstance.status = "paused";
        break;
      case "foreign_workspace":
        h.route.channel.whatsappInstance.workspaceId = "workspace-b";
        break;
      case "invalid_route":
        h.route.validationStatus = "invalid";
        break;
      case "inactive_credential":
        h.route.metaBusinessConnection.credential.status = "revoked";
        break;
      case "inactive_business":
        h.route.metaBusinessConnection.status = "paused";
        break;
      case "inactive_reporting":
        h.route.metaReportingAccount.active = false;
        break;
      case "unconfigured_destination":
        h.route.metaConversionDestination.status = "unconfigured";
        break;
    }
    await h.receive();
    await h.webhooks.sweep();
    expect(h.state.conversionEventLog).toHaveLength(0);
    expect(h.jobs.size).toBe(0);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("does not backfill receipts predating production activation", async () => {
    const h = await productionHarness();
    const r = await h.webhooks.createRule(
      "workspace-a",
      h.c.id,
      actor,
      ruleInput,
    );
    const old = await h.receive();
    h.setNow(new Date(+h.now + 1000));
    await h.webhooks.updateRule("workspace-a", h.c.id, r.id, actor, {
      mode: "production",
    });
    expect(await h.webhooks.process(old.id, "workspace-a")).toMatchObject({
      status: "ignored",
    });
    expect(h.state.pipedriveWebhookEvent![0]!.errorCode).toBe(
      "production_activation_fence",
    );
    expect(h.state.conversionEventLog).toHaveLength(0);
  });
  it("allows immediate rule deactivation when production gates and catalog are unavailable", async () => {
    const h = await selected();
    vi.stubEnv("PIPEDRIVE_CONVERSION_PRODUCTION_ENABLED", "false");
    h.state.pipedriveConnection![0]!.catalogState = "stale";
    await h.webhooks.updateRule(
      "workspace-a",
      h.c.id,
      h.state.pipedriveConversionRule![0]!.id,
      actor,
      { active: false },
    );
    expect(h.state.pipedriveConversionRule![0]).toMatchObject({
      active: false,
      productionActivatedAt: null,
    });
  });
  it.each([
    "license_locked",
    "connection_pause",
    "unbound",
    "channel_pause",
    "destination_changed",
  ])("revokes committed publication before fetch: %s", async (kind) => {
    const h = await selected();
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    const log = h.state.conversionEventLog![0]!;
    switch (kind) {
      case "license_locked":
        (h.conversions as any).licenseClient = lockedLicense;
        break;
      case "connection_pause":
        h.state.pipedriveConnection![0]!.status = "paused";
        break;
      case "unbound":
        h.state.pipedriveConnection![0]!.allowedChannelRouteIds = [];
        break;
      case "channel_pause":
        h.route.channel.status = "paused";
        break;
      case "destination_changed":
        h.route.metaConversionDestination.pixelId = "other-pixel";
        break;
    }
    expect(
      await h.conversions.sendReadyEvent(log.id, {
        workspaceId: "workspace-a",
      }),
    ).toMatchObject({ status: "skipped" });
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("freezes committed publication across trigger edits and credential replacement", async () => {
    const h = await selected();
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    const log = h.state.conversionEventLog![0]!;
    h.state.pipedriveConversionRule = [];
    h.state.pipedriveConnection![0]!.credentialGeneration += 1;
    expect(
      await h.conversions.sendReadyEvent(log.id, {
        workspaceId: "workspace-a",
      }),
    ).toMatchObject({ status: "sent" });
    expect(h.fetcher).toHaveBeenCalledOnce();
  });
  it.each(["missing_token", "resolver_error", "no_resolver"])(
    "blocks sender without authorized Meta credentials: %s",
    async (kind) => {
      const h = await selected();
      const event = await h.receive();
      await h.webhooks.process(event.id, "workspace-a");
      if (kind === "missing_token")
        h.resolver.resolveCapiRoute.mockResolvedValue({
          ...(await h.resolver.resolveCapiRoute()),
          accessToken: null,
        } as any);
      if (kind === "resolver_error")
        h.resolver.resolveCapiRoute.mockRejectedValue(
          new Error("synthetic-private-token-provider-text"),
        );
      // Student edition: no normalized-connection probe; without a bound
      // resolver the sender has no authorized Meta credentials.
      if (kind === "no_resolver")
        (h.conversions as any).connectionResolver = undefined;
      const log = h.state.conversionEventLog![0]!;
      expect(
        await h.conversions.sendReadyEvent(log.id, {
          workspaceId: "workspace-a",
        }),
      ).toMatchObject({ status: "not_configured" });
      expect(h.fetcher).not.toHaveBeenCalled();
      expect(JSON.stringify(h.state.conversionEventLog)).not.toContain(
        "synthetic-private-token-provider-text",
      );
    },
  );
  it("rolls canonical log, outbox and completion back together, then safely reclaims receipt", async () => {
    const h = await selected();
    const event = await h.receive();
    const audit = h.client.auditLog.create;
    audit.mockImplementationOnce(async () => {
      throw new Error("synthetic-db-private");
    }); // final completion audit, after canonical creation
    await expect(h.webhooks.process(event.id, "workspace-a")).rejects.toThrow(
      "pipedrive_persistence_failed",
    );
    expect(h.state.conversionEventLog).toHaveLength(0);
    expect(h.state.pipedriveConversionDedupe).toHaveLength(0);
    expect(h.state.pipedriveWebhookEvent![0]!.status).toBe("processing");
    h.setNow(new Date(+h.now + 91000));
    await h.webhooks.sweep();
    expect(h.state.conversionEventLog).toHaveLength(1);
    expect(h.jobs.size).toBe(1);
  });
  it("committed outbox survives failed Redis handoff and worker restart without reprocessing receipt", async () => {
    const h = await selected();
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    h.retrySend.mockRejectedValueOnce(new Error("synthetic-queue-private"));
    await h.webhooks.sweep();
    expect(h.state.pipedriveConversionDedupe![0]).toMatchObject({
      publicationStatus: "publication_pending",
      publicationAttempts: 1,
      publicationErrorCode: "conversion_enqueue_failed",
    });
    h.setNow(new Date(+h.now + 61000));
    await h.webhooks.sweep();
    expect(h.jobs.size).toBe(1);
    expect(h.state.conversionEventLog).toHaveLength(1);
    expect(h.adapter.getPerson).toHaveBeenCalledOnce();
  });
  it("keeps unknown delivery fenced permanently after response loss and duplicate queue retries", async () => {
    const h = await selected();
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    const log = h.state.conversionEventLog![0]!;
    h.fetcher.mockRejectedValueOnce(new Error("synthetic-response-loss"));
    expect(
      await h.conversions.sendReadyEvent(log.id, {
        workspaceId: "workspace-a",
      }),
    ).toMatchObject({ status: "error", errorCode: "MetaCapiDeliveryUnknown" });
    h.setNow(new Date(+h.now + 86400000));
    await h.webhooks.sweep();
    expect(
      await h.conversions.preparePipedriveSenderRetry(log.id, "workspace-a"),
    ).toBe("delivery_unknown");
    expect(
      await h.conversions.sendReadyEvent(log.id, {
        workspaceId: "workspace-a",
      }),
    ).toMatchObject({ status: "skipped" });
    expect(h.fetcher).toHaveBeenCalledOnce();
    expect(h.jobs.size).toBe(0);
    expect(
      (await h.webhooks.listEvents("workspace-a", h.c.id))[0]!.results,
    ).toEqual([
      expect.objectContaining({
        deliveryStatus: "delivery_unknown",
        deliveryRetryable: false,
      }),
    ]);
  });
  it("crash after durable sender claim is unknown even if dispatch was never observed", async () => {
    const h = await selected();
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    const log = h.state.conversionEventLog![0]!;
    Object.assign(h.state.pipedriveConversionDedupe![0], {
      senderAttempts: 1,
      senderLeaseToken: "synthetic-crash-claim",
    });
    await h.webhooks.sweep();
    expect(h.state.pipedriveConversionDedupe![0]!.publicationStatus).toBe(
      "delivery_unknown",
    );
    await h.conversions.sendReadyEvent(log.id, { workspaceId: "workspace-a" });
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.jobs.size).toBe(0);
  });
  it("finalization failure after injected Meta acceptance fences replay without double emission", async () => {
    const h = await selected();
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    const log = h.state.conversionEventLog![0]!;
    h.client.conversionEventLog.updateMany.mockRejectedValueOnce(
      new Error("synthetic-completion-crash"),
    );
    await expect(
      h.conversions.sendReadyEvent(log.id, { workspaceId: "workspace-a" }),
    ).rejects.toThrow("pipedrive_sender_failed");
    await h.webhooks.sweep();
    expect(h.state.pipedriveConversionDedupe![0]!.publicationStatus).toBe(
      "delivery_unknown",
    );
    await h.conversions.sendReadyEvent(log.id, { workspaceId: "workspace-a" });
    expect(h.fetcher).toHaveBeenCalledOnce();
  });
  it("duplicate concurrent sender jobs dispatch once", async () => {
    const h = await selected();
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    const log = h.state.conversionEventLog![0]!;
    const results = await Promise.all([
      h.conversions.sendReadyEvent(log.id, { workspaceId: "workspace-a" }),
      h.conversions.sendReadyEvent(log.id, { workspaceId: "workspace-a" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["sent", "skipped"]);
    expect(h.fetcher).toHaveBeenCalledOnce();
  });
  it("foreign workspace cannot send or retry the canonical event", async () => {
    const h = await selected();
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    const log = h.state.conversionEventLog![0]!;
    await expect(
      h.conversions.sendReadyEvent(log.id, { workspaceId: "workspace-b" }),
    ).rejects.toThrow("Evento de conversao nao encontrado");
    expect(
      await h.conversions.preparePipedriveSenderRetry(log.id, "workspace-b"),
    ).toBe("error");
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it.each([0, -1, 21474836.48])(
    "Purchase rejects nonpositive or out-of-range deal amount %s",
    async (value) => {
      const h = await selected("Purchase");
      await h.receive({
        data: {
          id: 1,
          pipeline_id: 1,
          stage_id: 11,
          person_id: 1,
          value,
          currency: "BRL",
        },
      });
      await h.webhooks.sweep();
      expect(h.state.pipedriveWebhookEvent![0]!.status).toBe("ignored");
      expect(h.state.conversionEventLog).toHaveLength(0);
    },
  );
  it("fixed Purchase value and currency use canonical value-source semantics and leave keyword rules unchanged", async () => {
    const h = await productionHarness();
    const keyword = { id: "keyword-a", eventName: "Purchase", active: true };
    h.state.conversionRule!.push(keyword);
    await h.webhooks.createRule("workspace-a", h.c.id, actor, {
      ...ruleInput,
      mode: "production",
      eventName: "Purchase",
      valueMode: "fixed",
      fixedValueCents: 1500,
      currency: "BRL",
    });
    h.setNow(new Date(+h.now + 1000));
    await h.receive({
      data: {
        id: 1,
        pipeline_id: 1,
        stage_id: 11,
        person_id: 1,
        value: 0,
        currency: "USD",
      },
    });
    await h.webhooks.sweep();
    expect(h.state.conversionEventLog![0]).toMatchObject({
      valueCents: 1500,
      currency: "BRL",
      valueSource: "configured_average",
      purchaseKind: "first_purchase",
    });
    expect(h.state.conversionRule).toEqual([keyword]);
    expect(h.client.conversionRule.updateMany).not.toHaveBeenCalled();
  });
  it("refreshes a stale production catalog before materialization without dropping the receipt", async () => {
    const h = await selected();
    h.state.pipedriveConnection![0]!.catalogState = "stale";
    const event = await h.receive();
    expect(await h.webhooks.process(event.id, "workspace-a")).toMatchObject({
      status: "materialized",
    });
    expect(h.adapter.listPipelines).toHaveBeenCalledTimes(2); // setup plus real processing refresh
    expect(h.state.conversionEventLog).toHaveLength(1);
  });
  it("transient stale-catalog refresh failure retries durably instead of losing the acknowledged receipt", async () => {
    const h = await selected();
    h.state.pipedriveConnection![0]!.catalogState = "stale";
    h.adapter.listPipelines.mockRejectedValueOnce(
      new PipedriveAdapterError("pipedrive_transport"),
    );
    const event = await h.receive();
    expect(await h.webhooks.process(event.id, "workspace-a")).toMatchObject({
      status: "retry",
    });
    expect(h.state.conversionEventLog).toHaveLength(0);
    h.setNow(new Date(+h.now + 31000));
    await h.webhooks.sweep();
    expect(h.state.pipedriveWebhookEvent![0]!.status).toBe("materialized");
    expect(h.state.conversionEventLog).toHaveLength(1);
  });
  it("fences provider account/generation and stale stage changes during person lookup", async () => {
    const h = await selected();
    const held = deferred<{ id: string; phones: string[] }>();
    h.adapter.getPerson.mockImplementationOnce(() => held.promise);
    const event = await h.receive();
    const processing = h.webhooks.process(event.id, "workspace-a");
    await vi.waitFor(() => expect(h.adapter.getPerson).toHaveBeenCalledOnce());
    h.state.pipedriveConnection![0]!.credentialGeneration += 1;
    held.resolve({ id: "1", phones: ["5500000000000"] });
    await processing;
    expect(h.state.pipedriveWebhookEvent![0]!.errorCode).toBe(
      "connection_fence_changed",
    );
    expect(h.state.conversionEventLog).toHaveLength(0);
  });
  it("catalog stage revoked during lookup cannot materialize", async () => {
    const h = await selected();
    const held = deferred<{ id: string; phones: string[] }>();
    h.adapter.getPerson.mockImplementationOnce(() => held.promise);
    const event = await h.receive();
    const processing = h.webhooks.process(event.id, "workspace-a");
    await vi.waitFor(() => expect(h.adapter.getPerson).toHaveBeenCalledOnce());
    h.state.pipedriveStageCatalog!.find((s) => s.stageId === "11")!.available =
      false;
    held.resolve({ id: "1", phones: ["5500000000000"] });
    await processing;
    expect(h.state.pipedriveWebhookEvent![0]!.errorCode).toBe(
      "stage_unavailable",
    );
    expect(h.state.conversionEventLog).toHaveLength(0);
  });
  it("commit failure after synchronous injected fetch start remains fenced permanently", async () => {
    const h = await selected();
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    const log = h.state.conversionEventLog![0]!;
    const original = h.client.$transaction.getMockImplementation()!;
    h.client.$transaction.mockImplementation((callback: any) =>
      original(async (tx: any) => {
        const result = await callback(tx);
        if (result?.delivery) throw new Error("synthetic-dispatch-commit-loss");
        return result;
      }),
    );
    await expect(
      h.conversions.sendReadyEvent(log.id, { workspaceId: "workspace-a" }),
    ).rejects.toThrow("pipedrive_sender_failed");
    expect(h.fetcher).toHaveBeenCalledOnce();
    await h.webhooks.sweep();
    expect(
      await h.conversions.preparePipedriveSenderRetry(log.id, "workspace-a"),
    ).toBe("delivery_unknown");
    await h.conversions.sendReadyEvent(log.id, { workspaceId: "workspace-a" });
    expect(h.fetcher).toHaveBeenCalledOnce();
  });
  it("the final dispatch fence sees channel revocation after the durable claim", async () => {
    const h = await selected();
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    const log = h.state.conversionEventLog![0]!;
    const original = h.client.$transaction.getMockImplementation()!;
    h.client.$transaction.mockImplementation(async (callback: any) => {
      const result = await original(callback);
      if (typeof result === "string" && result.length > 20)
        h.route.channel.status = "paused";
      return result;
    });
    await expect(
      h.conversions.sendReadyEvent(log.id, { workspaceId: "workspace-a" }),
    ).rejects.toThrow("pipedrive_sender_failed");
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.state.pipedriveConversionDedupe![0]!.senderAttempts).toBe(1);
  });
  it("semantic duplicates show current delivery even after the original receipt leaves the bounded event view", async () => {
    const h = await selected();
    const original = await h.receive();
    await h.webhooks.process(original.id, "workspace-a");
    h.setNow(new Date(+h.now + 1000));
    const duplicate = await h.receive({
      meta: {
        action: "change",
        entity: "deal",
        version: "2.0",
        company_id: 1,
        host: "synthetic.pipedrive.com",
        id: "new-delivery",
        timestamp: h.now.toISOString(),
      },
    });
    await h.webhooks.process(duplicate.id, "workspace-a");
    const log = h.state.conversionEventLog![0]!;
    await h.conversions.sendReadyEvent(log.id, { workspaceId: "workspace-a" });
    for (let i = 0; i < 100; i++)
      h.state.pipedriveWebhookEvent!.push({
        ...structuredClone(original),
        id: `synthetic-newer-${i}`,
        createdAt: new Date(+h.now + i + 1),
        status: "ignored",
        results: [],
      });
    // Keep the duplicate inside the newest100 and original outside it.
    h.state.pipedriveWebhookEvent!.find(
      (r) => r.id === duplicate.id,
    )!.createdAt = new Date(+h.now + 200);
    const visible = await h.webhooks.listEvents("workspace-a", h.c.id);
    expect(visible.find((r) => r.id === original.id)).toBeUndefined();
    expect(visible.find((r) => r.id === duplicate.id)!.results).toEqual([
      expect.objectContaining({
        deliveryStatus: "sent",
        conversionEventLogId: log.id,
      }),
    ]);
  });
  it("old unresolved deliveries cannot starve a newer pending publication", async () => {
    const h = await selected();
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    const current = structuredClone(h.state.pipedriveConversionDedupe![0]!);
    const log = structuredClone(h.state.conversionEventLog![0]!);
    for (let i = 0; i < 25; i++) {
      const id = `synthetic-stuck-${i}`;
      const dealId = String(i + 10);
      const eventId = `synthetic-old-event-${i}`;
      h.state.pipedriveWebhookEvent!.push({
        ...structuredClone(event),
        id: eventId,
        dealId,
        status: "materialized",
        createdAt: new Date(+h.now - 86400000),
      });
      h.state.conversionEventLog!.push({
        ...structuredClone(log),
        id,
        eventId: id,
        dedupeKey: id,
        sourceEventId: eventId,
        status: "error",
        errorCode: "MetaCapiDeliveryUnknown",
      });
      h.state.pipedriveConversionDedupe!.push({
        ...structuredClone(current),
        id,
        dealId,
        sourceEventId: eventId,
        conversionEventLogId: id,
        publicationIntent: { ...current.publicationIntent, eventId: id },
        publicationStatus: "delivery_unknown",
        senderAttempts: 1,
        senderLeaseToken: `synthetic-claim-${i}`,
        publicationNextAttemptAt: h.now,
        createdAt: new Date(+h.now - 86400000),
      });
    }
    await h.webhooks.sweep();
    expect(h.jobs.size).toBe(0);
    h.setNow(new Date(+h.now + 31000));
    await h.webhooks.sweep();
    expect(h.jobs.has(log.id)).toBe(true);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});
