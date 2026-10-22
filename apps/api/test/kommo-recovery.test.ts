import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conversionEventCatalogOrdered,
  conversionEventCarriesValue,
  conversionEventRequiresValue,
} from "@wpptrack/shared";
import { KommoAdapterError } from "../src/kommo/kommo.adapter";
import { KommoWebhookQueueService } from "../src/kommo/kommo-webhook-queue.service";
import { ConversionEventsService } from "../src/conversion-events/conversion-events.service";
import { KommoWebhookProcessor } from "../src/kommo/kommo-webhook.processor";
import { kommoHarness, deferred } from "./support/kommo-stateful-harness";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Kommo durable processing, generation and publication", () => {
  it("materializes an existing lead with immutable attribution and distinguishes queue from sent", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "queued",
    });
    expect(h.state.conversionEventLog).toHaveLength(1);
    expect(h.state.conversionEventLog[0]).toMatchObject({
      leadId: "captured-lead",
      campaignId: "campaign-a",
      adId: "ad-a",
      ctwaClid: "trusted-click",
      valueCents: 12000,
      eventId: "kommo:workspace-a:account-a:deal-a:Purchase",
      status: "ready_to_send",
    });
    expect(h.state.kommoConversionDedupe[0]).toMatchObject({
      publicationStatus: "queued",
      publicationIntent: { routeId: "route-a", destinationId: "destination-a" },
    });
    expect(h.prisma.lead.create).not.toHaveBeenCalled();
    h.state.conversionEventLog[0].status = "sent";
    h.advance(31_000);
    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "sent",
    });
  });

  it("reads authoritative sender status in the tenant-safe event outcomes API", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    h.state.conversionEventLog[0].status = "sent";
    const view = await h.service.listEvents("workspace-a", h.connection.id);
    expect(view.events[0].results[0]).toMatchObject({
      status: "materialized",
      senderStatus: "sent",
      publicationStatus: "sent",
    });
    await expect(
      h.service.listEvents("other", h.connection.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("enforces concurrent claims and prevents a late queue publication resetting processing", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    const dns = deferred();
    const continueGet = deferred();
    h.adapter.getLead.mockImplementationOnce(async () => {
      dns.resolve();
      await continueGet.promise;
      return {
        id: "deal-a",
        accountId: "account-a",
        contactIds: ["contact-a"],
      };
    });
    const queueReturn = deferred<string>();
    h.queue.enqueue.mockImplementationOnce(() => queueReturn.promise);
    const enqueue = (h.service as any).enqueueRecord(structuredClone(event));
    const processing = h.service.process(event.id, event.workspaceId);
    await dns.promise;
    await expect(
      h.service.process(event.id, event.workspaceId),
    ).rejects.toThrow("kommo_processing_lease_busy");
    queueReturn.resolve("existing-active");
    await enqueue;
    expect(h.state.kommoWebhookEvent[0].status).toBe("processing");
    expect(h.state.kommoWebhookEvent[0].leaseToken).toBeTruthy();
    continueGet.resolve();
    await processing;
    expect(h.state.conversionEventLog).toHaveLength(1);
  });

  it("uses immutable webhook stage/price rather than later GET snapshots", async () => {
    const h = kommoHarness();
    h.adapter.getLead.mockResolvedValue({
      id: "deal-a",
      accountId: "account-a",
      contactIds: ["contact-a"],
      pipelineId: "different",
      statusId: "143",
      price: 99999,
    } as any);
    const event = await h.receive({ priceCents: 1234 });
    await h.service.process(event.id, event.workspaceId);
    expect(h.state.conversionEventLog[0]).toMatchObject({
      valueCents: 1234,
      sourcePayload: { pipelineId: "p", statusId: "142" },
    });
  });

  it("rejects lease-lost publication completion after another recovery claims the intent", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    const returned = deferred();
    const entered = deferred();
    h.conversionQueue.retrySend.mockImplementationOnce(async () => {
      entered.resolve();
      await returned.promise;
      return { status: "queued" };
    });
    const processing = h.service.process(event.id, event.workspaceId);
    await entered.promise;
    const intent = h.state.kommoConversionDedupe[0];
    intent.publicationLeaseToken = "new-owner";
    intent.publicationStatus = "revoked";
    returned.resolve();
    await processing;
    expect(intent.publicationStatus).toBe("revoked");
  });

  it("blocks a provable semantic identity conflict without heuristic cross-origin matching", async () => {
    const h = kommoHarness();
    h.state.conversionEventLog.push({
      id: "other-source",
      dedupeKey: "kommo:workspace-a:account-a:deal-a:Purchase",
      workspaceId: "workspace-a",
      sourceTrigger: "other",
      eventName: "Purchase",
      leadId: "captured-lead",
    });
    const event = await h.receive();
    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "blocked",
      errorCode: "semantic_identity_conflict",
    });
    expect(h.state.kommoConversionDedupe).toHaveLength(0);
    expect(h.state.conversionEventLog).toHaveLength(1);
    expect(h.conversionQueue.retrySend).not.toHaveBeenCalled();
  });

  it("confirmed sending uses the immutable destination and sender event ID", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    const resolver = {
      hasNormalizedConnections: vi.fn(async () => true),
      resolveCapiRoute: vi.fn(async () => ({
        source: "manual",
        accessToken: "synthetic-meta-token",
        pixelId: "synthetic-pixel",
        pageId: "synthetic-page",
        reportingAccountId: "reporting-a",
        adAccountId: "act_synthetic",
        businessConnectionId: "business-a",
        conversionDestinationId: "destination-a",
      })),
    };
    h.metaAdapter.sendEvent.mockResolvedValue({
      status: "sent",
      requestPayload: null,
      responseSummary: { synthetic: true },
      errorCode: null,
      errorMessage: null,
    });
    const sender = new ConversionEventsService(
      h.prisma,
      h.metaAdapter as any,
      {} as any,
      resolver as any,
      h.license as any,
    );
    const log = h.state.conversionEventLog[0];
    expect(
      await sender.sendReadyEvent(log.id, { workspaceId: "workspace-a" }),
    ).toMatchObject({ status: "sent" });
    expect(resolver.resolveCapiRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        businessConnectionId: "business-a",
        conversionDestinationId: "destination-a",
        metaAccountId: "act_synthetic",
      }),
    );
    expect(h.metaAdapter.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: log.eventId,
        pixelId: "synthetic-pixel",
        pageId: "synthetic-page",
        ctwaClid: "trusted-click",
      }),
      expect.objectContaining({
        beforeDispatch: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(
      (await h.service.listEvents("workspace-a", h.connection.id)).events[0]
        .results[0].senderStatus,
    ).toBe("sent");
  });

  it("does not allow a resolver to substitute a different pixel during sender recovery", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    const resolver = {
      hasNormalizedConnections: vi.fn(async () => true),
      resolveCapiRoute: vi.fn(async () => ({
        source: "manual",
        accessToken: "synthetic-meta-token",
        pixelId: "wrong-pixel",
        pageId: "synthetic-page",
        reportingAccountId: "reporting-a",
        adAccountId: "act_synthetic",
        businessConnectionId: "business-a",
        conversionDestinationId: "destination-a",
      })),
    };
    const sender = new ConversionEventsService(
      h.prisma,
      h.metaAdapter as any,
      {} as any,
      resolver as any,
      h.license as any,
    );
    expect(
      await sender.sendReadyEvent(h.state.conversionEventLog[0].id, {
        workspaceId: "workspace-a",
      }),
    ).toMatchObject({ status: "not_configured" });
    expect(h.metaAdapter.sendEvent).not.toHaveBeenCalled();
  });

  it("fails closed if a destination's pixel changes after the committed intent", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    h.state.inboundWebhookChannelRoute[0].metaConversionDestination.pixelId =
      "different-pixel";
    h.advance(31_000);
    await h.service.process(event.id, event.workspaceId);
    expect(h.state.kommoConversionDedupe[0]).toMatchObject({
      publicationStatus: "revoked",
      publicationErrorCode: "publication_authorization_revoked",
    });
    expect(
      await h.conversions.sendReadyEvent(h.state.conversionEventLog[0].id, {
        workspaceId: "workspace-a",
      }),
    ).toMatchObject({ status: "skipped" });
    expect(h.metaAdapter.sendEvent).not.toHaveBeenCalled();
  });

  it("records production duplicates across reentry and allows a NEW deal repurchase", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    const reentry = await h.receive({ oldStatusId: "200", priceCents: 50000 });
    expect(
      await h.service.process(reentry.id, reentry.workspaceId),
    ).toMatchObject({
      status: "duplicate",
      results: [{ status: "duplicate" }],
    });
    expect(h.state.conversionEventLog).toHaveLength(1);
    h.adapter.getLead.mockResolvedValue({
      id: "deal-b",
      accountId: "account-a",
      contactIds: ["contact-a"],
    });
    const repurchase = await h.receive({ dealId: "deal-b" });
    await h.service.process(repurchase.id, repurchase.workspaceId);
    expect(h.state.conversionEventLog).toHaveLength(2);
    expect(h.state.conversionEventLog[1]).toMatchObject({
      purchaseKind: "repurchase",
      leadId: "captured-lead",
      eventId: "kommo:workspace-a:account-a:deal-b:Purchase",
    });
  });

  it("persists mixed canonical rule outcomes and keeps blocked reasons when another event queues", async () => {
    const h = kommoHarness();
    h.state.kommoConversionRule.push({
      ...h.state.kommoConversionRule[0],
      id: "qualified",
      eventName: "QualifiedLead",
      currency: null,
    });
    const event = await h.receive({ priceCents: 0 });
    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "queued",
      errorCode: "event_price_missing_or_nonpositive",
      results: [
        {
          ruleId: "rule-a",
          status: "blocked",
          errorCode: "event_price_missing_or_nonpositive",
        },
        {
          ruleId: "qualified",
          status: "materialized",
          publicationStatus: "queued",
        },
      ],
    });
    expect(h.state.kommoWebhookEvent[0].conversionEventLogId).toBeUndefined();
  });

  it("commits multiple canonical conversions and all outcomes atomically", async () => {
    const h = kommoHarness();
    h.state.kommoConversionRule.push({
      ...h.state.kommoConversionRule[0],
      id: "qualified",
      eventName: "QualifiedLead",
      currency: null,
    });
    const record = h.conversions.recordExternalConversion.bind(h.conversions);
    vi.spyOn(h.conversions, "recordExternalConversion").mockImplementation(
      async (input, client) => {
        if (input.eventName === "QualifiedLead")
          throw new Error("synthetic crash");
        return record(input, client);
      },
    );
    const event = await h.receive();
    await expect(
      h.service.process(event.id, event.workspaceId),
    ).rejects.toThrow("synthetic crash");
    expect(h.state.conversionEventLog).toHaveLength(0);
    expect(h.state.kommoConversionDedupe).toHaveLength(0);
    expect(h.state.kommoWebhookEvent[0].status).toBe("failed");
  });

  it("recovers a crash after commit without credentials/catalog/rules/identity evaluation", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    const publish = (h.service as any).publishIntent.bind(h.service);
    vi.spyOn(h.service as any, "publishIntent")
      .mockRejectedValueOnce(new Error("crash after commit"))
      .mockImplementation(publish);
    await expect(
      h.service.process(event.id, event.workspaceId),
    ).rejects.toThrow("crash after commit");
    expect(h.state.conversionEventLog).toHaveLength(1);
    expect(h.state.kommoConversionDedupe[0].publicationStatus).toBe(
      "publication_pending",
    );
    h.connection.credentialGeneration++;
    h.connection.accessTokenEncrypted = "invalid";
    h.connection.catalogState = "empty";
    h.state.kommoConversionRule = [];
    h.state.kommoPipelineCatalog = [];
    h.adapter.getLead.mockClear();
    h.advance(61_000);
    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "queued",
    });
    expect(h.adapter.getLead).not.toHaveBeenCalled();
    expect(h.state.conversionEventLog).toHaveLength(1);
    expect(h.conversionQueue.retrySend).toHaveBeenCalledWith(
      h.state.conversionEventLog[0].id,
      "workspace-a",
    );
  });

  it("counts publication retries from the claimed row when a sweep carries an old snapshot", async () => {
    const h = kommoHarness();
    h.conversionQueue.retrySend.mockRejectedValue(
      new Error("synthetic outage"),
    );
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    const snapshot = structuredClone(h.state.kommoConversionDedupe[0]);
    h.advance(61_000);
    await (h.service as any).publishIntent(
      structuredClone(h.state.kommoConversionDedupe[0]),
    );
    expect(h.state.kommoConversionDedupe[0].publicationAttempts).toBe(2);
    h.advance(121_000);
    await (h.service as any).publishIntent(snapshot);
    expect(h.state.kommoConversionDedupe[0].publicationAttempts).toBe(3);
  });

  it("retains publication failure audit with bounded scheduled retries and stable event_id", async () => {
    const h = kommoHarness();
    h.conversionQueue.retrySend.mockRejectedValue(
      new Error("synthetic redis outage"),
    );
    const event = await h.receive();
    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "publication_pending",
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      h.advance(901_000);
      await h.service.process(event.id, event.workspaceId);
    }
    expect(h.state.kommoConversionDedupe[0]).toMatchObject({
      publicationStatus: "publication_failed",
      publicationAttempts: 5,
      publicationErrorCode: "conversion_enqueue_failed",
    });
    expect(h.state.conversionEventLog).toHaveLength(1);
    expect(h.state.conversionEventLog[0].eventId).toBe(
      "kommo:workspace-a:account-a:deal-a:Purchase",
    );
    h.conversionQueue.retrySend.mockResolvedValue({ status: "queued" });
    await h.service.reprocess("workspace-a", event.id, "owner-a");
    await h.service.process(event.id, event.workspaceId);
    expect(h.state.kommoConversionDedupe[0].publicationStatus).toBe("queued");
    expect(h.state.auditLog.at(-1).action).toBe(
      "kommo.event_reprocess_requested",
    );
  });

  it("revokes committed intent after binding removal and sender rechecks revocation", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    h.connection.allowedChannelRouteIds = [];
    h.advance(31_000);
    await h.service.process(event.id, event.workspaceId);
    expect(h.state.kommoConversionDedupe[0].publicationStatus).toBe("revoked");
    expect(
      await h.conversions.sendReadyEvent(h.state.conversionEventLog[0].id, {
        workspaceId: "workspace-a",
      }),
    ).toMatchObject({ status: "skipped" });
    expect(h.metaAdapter.sendEvent).not.toHaveBeenCalled();
    expect(h.state.conversionEventLog[0].errorCode).toBe(
      "kommo_publication_revoked",
    );
  });

  it("does not overwrite processing/terminal state when publication finishes late or fails late", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    h.queue.enqueue.mockImplementationOnce(async () => {
      await h.service.process(event.id, event.workspaceId);
      return "existing-active-job";
    });
    await (h.service as any).enqueueRecord(structuredClone(event));
    expect(h.state.kommoWebhookEvent[0].status).toBe("queued");
    expect(h.state.kommoWebhookEvent[0].results[0].status).toBe("materialized");
    const other = await h.receive({ dealId: "failure-race" });
    h.queue.enqueue.mockImplementationOnce(async () => {
      const row = h.state.kommoWebhookEvent.find(
        (item) => item.id === other.id,
      )!;
      row.status = "blocked";
      row.revision++;
      throw new Error("late enqueue failure");
    });
    await expect(
      h.service.receive(h.connection.id, "synthetic-capability", [
        { ...h.stageEvent, dealId: "failure-race" },
      ]),
    ).rejects.toThrow("late enqueue failure");
    expect(
      h.state.kommoWebhookEvent.find((item) => item.id === other.id)?.status,
    ).toBe("blocked");
  });

  it("never resets an active processing lease while enqueue returns an existing active job", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    event.status = "processing";
    event.leaseToken = "live-worker";
    event.leaseExpiresAt = new Date(h.service.now().getTime() + 80_000);
    h.queue.enqueue.mockClear();
    await (h.service as any).enqueueRecord(structuredClone(event));
    expect(h.queue.enqueue).not.toHaveBeenCalled();
    expect(event.status).toBe("processing");
  });

  it("reclaims expired processing leases after crash and fences old worker completion", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    event.status = "processing";
    event.leaseToken = "crashed-worker";
    event.leaseExpiresAt = new Date(h.service.now().getTime() - 1);
    const old = structuredClone(event);
    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "queued",
    });
    expect(
      await (h.service as any).complete(old, "blocked", "late failure"),
    ).toMatchObject({ status: "lease_lost" });
    expect(h.state.kommoWebhookEvent[0].status).toBe("queued");
    expect(h.state.conversionEventLog).toHaveLength(1);
    // Rows created by the earlier processor have no lease at all. Startup and
    // the stalled worker must reclaim these under the same version predicate.
    const legacy = await h.receive({ dealId: "legacy-deal" });
    legacy.status = "processing";
    legacy.leaseToken = null;
    legacy.leaseExpiresAt = null;
    h.adapter.getLead.mockResolvedValue({
      id: "legacy-deal",
      accountId: "account-a",
      contactIds: ["contact-a"],
    });
    await h.service.onModuleInit();
    h.service.onModuleDestroy();
    expect(h.queue.enqueue).toHaveBeenCalledWith(legacy.id, "workspace-a");
    expect(await h.service.process(legacy.id, "workspace-a")).toMatchObject({
      status: "queued",
    });
    expect(h.state.conversionEventLog).toHaveLength(2);
  });

  it("a stalled BullMQ retry cannot complete an unexpired orphan processing claim", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    event.status = "processing";
    event.leaseToken = "orphan";
    event.leaseExpiresAt = new Date(h.service.now().getTime() + 5000);
    const processor = new KommoWebhookProcessor(h.service, h.prisma);
    const job: any = {
      id: "job-a",
      name: "process-stage-event",
      data: { eventId: event.id, workspaceId: event.workspaceId },
      attemptsMade: 1,
      opts: { attempts: 5 },
    };
    await expect(processor.process(job)).rejects.toThrow(
      "kommo_processing_lease_busy",
    );
    expect(event.status).toBe("processing");
    h.advance(6000);
    expect(await processor.process(job)).toMatchObject({ status: "queued" });
  });

  it("recovers more than 100 queued/orphan events with keyset pages, recurrence and timer disposal", async () => {
    vi.useFakeTimers();
    const h = kommoHarness();
    for (let item = 0; item < 205; item++)
      await h.receive({ dealId: `backlog-${item}` });
    h.queue.enqueue.mockClear();
    await h.service.onModuleInit();
    expect(h.queue.enqueue).toHaveBeenCalledTimes(205);
    const pages = h.prisma.kommoWebhookEvent.findMany.mock.calls.filter(
      ([args]: any) => args.take === 100,
    );
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages[1][0].where.id.gt).toBeTruthy();
    h.queue.enqueue.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.queue.enqueue).toHaveBeenCalledTimes(205);
    h.service.onModuleDestroy();
    h.queue.enqueue.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.queue.enqueue).not.toHaveBeenCalled();
  });

  it.each(["kommo_transport", "kommo_rate_limited"] as const)(
    "schedules bounded enrichment retry for %s and permits audited manual recovery",
    async (code) => {
      const h = kommoHarness();
      h.adapter.getLead.mockRejectedValue(new KommoAdapterError(code));
      const event = await h.receive();
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) h.advance(901_000);
        h.connection.catalogRefreshedAt = h.service.now();
        const result = await h.service.process(event.id, event.workspaceId);
        expect(result.status).toBe(attempt === 4 ? "dead" : "failed");
        h.connection.catalogRefreshedAt = h.service.now();
      }
      expect(h.state.conversionEventLog).toHaveLength(0);
      expect(h.state.kommoWebhookEvent[0].errorCode).toBe(code);
      h.queue.enqueue.mockClear();
      await h.receive();
      expect(h.queue.enqueue).not.toHaveBeenCalled();
      expect(h.state.kommoWebhookEvent[0]).toMatchObject({
        status: "dead",
        attempts: 5,
      });
      h.adapter.getLead.mockResolvedValue({
        id: "deal-a",
        accountId: "account-a",
        contactIds: ["contact-a"],
      });
      await h.service.reprocess("workspace-a", event.id, "owner-a");
      expect(
        await h.service.process(event.id, event.workspaceId),
      ).toMatchObject({ status: "queued" });
    },
  );

  it("serializes conversion authorization with replacement in the same connection row-lock domain", async () => {
    const h = kommoHarness();
    const entered = deferred();
    const continueCommit = deferred();
    const record = h.conversions.recordExternalConversion.bind(h.conversions);
    vi.spyOn(h.conversions, "recordExternalConversion").mockImplementation(
      async (input, client) => {
        entered.resolve();
        await continueCommit.promise;
        return record(input, client);
      },
    );
    const event = await h.receive();
    const processing = h.service.process(event.id, event.workspaceId);
    await entered.promise;
    h.adapter.verify.mockResolvedValue({ id: "account-b", subdomain: "other" });
    const replacing = h.service.replaceCredential(
      "workspace-a",
      h.connection.id,
      "owner-a",
      {
        accountOrigin: "https://other.kommo.com/",
        accessToken: "synthetic-replacement",
      },
    );
    await Promise.resolve();
    expect(h.connection.verifiedAccountId).toBe("account-a");
    continueCommit.resolve();
    await processing;
    await replacing;
    expect(h.state.conversionEventLog).toHaveLength(1);
    expect(h.connection.verifiedAccountId).toBe("account-b");
    const locks = h.prisma.$queryRaw.mock.calls.map(
      ([strings, ...parameters]: any) => ({
        sql: strings.join("?"),
        parameters,
      }),
    );
    expect(
      locks.filter(
        (call: any) =>
          call.sql.includes('FROM "KommoConnection"') &&
          call.sql.includes("FOR UPDATE") &&
          call.parameters[0] === "connection-a",
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("rejects old generation after enrichment even if replacement already committed", async () => {
    const h = kommoHarness();
    const entered = deferred();
    const proceed = deferred();
    h.adapter.getLead.mockImplementationOnce(async () => {
      entered.resolve();
      await proceed.promise;
      return {
        id: "deal-a",
        accountId: "account-a",
        contactIds: ["contact-a"],
      };
    });
    const event = await h.receive();
    const processing = h.service.process(event.id, event.workspaceId);
    await entered.promise;
    await h.service.replaceCredential(
      "workspace-a",
      h.connection.id,
      "owner-a",
      { accessToken: "synthetic-new-token" },
    );
    proceed.resolve();
    expect(await processing).toMatchObject({
      status: "blocked",
      errorCode: "credential_generation_mismatch",
    });
    expect(h.state.conversionEventLog).toHaveLength(0);
  });

  it("computes accountChanged from the locked current row for overlapping replacements", async () => {
    const h = kommoHarness();
    const delayed = deferred<{ id: string; subdomain: string }>();
    h.adapter.verify
      .mockImplementationOnce(() => delayed.promise)
      .mockResolvedValueOnce({ id: "account-b", subdomain: "other" });
    const backToA = h.service.replaceCredential(
      "workspace-a",
      h.connection.id,
      "owner-a",
      {
        accountOrigin: "https://synthetic.kommo.com/",
        accessToken: "synthetic-return",
      },
    );
    await Promise.resolve();
    await h.service.replaceCredential(
      "workspace-a",
      h.connection.id,
      "owner-a",
      {
        accountOrigin: "https://other.kommo.com/",
        accessToken: "synthetic-other",
      },
    );
    // Reintroduce a B catalog row to prove the return transition cleans it.
    h.state.kommoPipelineCatalog.push({
      id: "b-only",
      connectionId: h.connection.id,
      pipelineId: "b",
      statusId: "142",
      available: true,
    });
    delayed.resolve({ id: "account-a", subdomain: "synthetic" });
    await backToA;
    expect(h.connection.credentialGeneration).toBe(3);
    expect(
      h.state.kommoPipelineCatalog.some((row) => row.id === "b-only"),
    ).toBe(false);
    expect(h.connection.allowedChannelRouteIds).toEqual([]);
  });

  it("fences late catalog and health responses against a replacement generation", async () => {
    const h = kommoHarness();
    const catalog = deferred<any>();
    const health = deferred<any>();
    h.adapter.listPipelines.mockImplementationOnce(() => catalog.promise);
    h.adapter.verify
      .mockImplementationOnce(() => health.promise)
      .mockResolvedValueOnce({ id: "account-b", subdomain: "other" });
    const refresh = h.service.refreshCatalog("workspace-a", h.connection.id);
    const check = h.service.checkHealth("workspace-a", h.connection.id);
    await Promise.resolve();
    await h.service.replaceCredential(
      "workspace-a",
      h.connection.id,
      "owner-a",
      {
        accountOrigin: "https://other.kommo.com/",
        accessToken: "synthetic-other",
      },
    );
    catalog.resolve([
      {
        id: "old-only",
        name: "Old",
        sort: 1,
        statuses: [{ id: "142", name: "Old", type: null }],
      },
    ]);
    health.resolve({ id: "wrong-account", subdomain: "wrong" });
    await refresh;
    await check;
    expect(h.connection.status).toBe("active");
    expect(h.connection.credentialHealthy).toBe(true);
    expect(
      h.state.kommoPipelineCatalog.some((row) => row.pipelineId === "old-only"),
    ).toBe(false);
  });

  it("fails closed on AEAD corruption and never reports a decrypt failure as healthy", async () => {
    const h = kommoHarness();
    h.connection.accessTokenTag = Buffer.alloc(16, 0).toString("base64");
    const event = await h.receive();
    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "blocked",
      errorCode: "credential_decrypt_failed",
    });
    await expect(
      h.service.refreshCatalog("workspace-a", h.connection.id),
    ).rejects.toThrow("credential_decrypt_failed");
    expect(h.connection.credentialHealthy).toBe(false);
    expect(h.connection.catalogState).toBe("stale");
    expect(h.adapter.getLead).not.toHaveBeenCalled();
    expect(h.adapter.listPipelines).not.toHaveBeenCalled();
    expect(
      JSON.stringify(await h.service.get("workspace-a", h.connection.id)),
    ).not.toMatch(/accessToken|webhookSecret|synthetic-token/);
  });

  it("reports expired catalog as stale, blocks processing and refreshes on recurrence", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    h.advance(15 * 60_000);
    expect(await h.service.get("workspace-a", h.connection.id)).toMatchObject({
      catalogState: "stale",
    });
    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "blocked",
      errorCode: "stage_unavailable_or_catalog_stale",
    });
    await h.service.onModuleInit();
    h.service.onModuleDestroy();
    expect(h.adapter.listPipelines).toHaveBeenCalled();
    expect(h.connection.catalogState).toBe("fresh");
  });

  it("handles repeated system status IDs, renames and removed stages with honest refresh errors", async () => {
    const h = kommoHarness();
    h.adapter.listPipelines.mockResolvedValue([
      {
        id: "p",
        name: "Renamed",
        sort: 1,
        statuses: [{ id: "142", name: "Won", type: "won" }],
      },
      {
        id: "other",
        name: "Other",
        sort: 2,
        statuses: [{ id: "142", name: "Other won", type: "won" }],
      },
    ]);
    await h.service.refreshCatalog("workspace-a", h.connection.id);
    expect(
      h.state.kommoPipelineCatalog.filter((row) => row.available),
    ).toHaveLength(2);
    h.adapter.listPipelines.mockResolvedValue([]);
    await h.service.refreshCatalog("workspace-a", h.connection.id);
    expect(h.state.kommoConversionRule[0].active).toBe(false);
    expect(h.state.kommoPipelineCatalog.every((row) => !row.available)).toBe(
      true,
    );
    h.adapter.listPipelines.mockRejectedValue(
      new KommoAdapterError("kommo_transport"),
    );
    await expect(
      h.service.refreshCatalog("workspace-a", h.connection.id),
    ).rejects.toThrow("kommo_transport");
    expect(h.connection.catalogState).toBe("stale");
  });

  it("PATCH normalizes Purchase to QualifiedLead, permits null clearing, validates inverse values", async () => {
    const h = kommoHarness();
    expect(
      await h.service.updateRule(
        "workspace-a",
        h.connection.id,
        "rule-a",
        "owner-a",
        { eventName: "QualifiedLead" },
      ),
    ).toMatchObject({
      eventName: "QualifiedLead",
      currency: null,
      fixedValueCents: null,
    });
    await expect(
      h.service.updateRule(
        "workspace-a",
        h.connection.id,
        "rule-a",
        "owner-a",
        { eventName: "Purchase" },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await h.service.updateRule(
        "workspace-a",
        h.connection.id,
        "rule-a",
        "owner-a",
        {
          eventName: "Purchase",
          valueMode: "fixed",
          fixedValueCents: 300,
          currency: "BRL",
        },
      ),
    ).toMatchObject({ currency: "BRL", fixedValueCents: 300 });
    expect(
      await h.service.updateRule(
        "workspace-a",
        h.connection.id,
        "rule-a",
        "owner-a",
        { valueMode: "lead_price", fixedValueCents: null, contentName: null },
      ),
    ).toMatchObject({ fixedValueCents: null });
    await expect(
      h.service.updateRule(
        "workspace-a",
        h.connection.id,
        "rule-a",
        "owner-a",
        { currency: null },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("retries retained failed webhook jobs and never treats add of a dead job as publication", async () => {
    const job = {
      getState: vi.fn(async () => "failed"),
      retry: vi.fn(),
      remove: vi.fn(),
    };
    const queue: any = { getJob: vi.fn(async () => job), add: vi.fn() };
    const service = new KommoWebhookQueueService(queue);
    await service.enqueue("synthetic-event", "workspace-a");
    expect(job.retry).toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    job.retry.mockRejectedValueOnce(new Error("retry failed"));
    await expect(
      service.enqueue("synthetic-event", "workspace-a"),
    ).rejects.toThrow("retry failed");
  });
});

describe("Kommo identity/channel isolation", () => {
  function configureSingleDestinationFallback(h: any) {
    h.state.metaAd.push({
      id: "meta-ad-a",
      workspaceId: "workspace-a",
      adId: "ad-a",
      adAccountId: "act_synthetic",
    });
    h.state.metaReportingAccount.push({
      id: "reporting-a",
      workspaceId: "workspace-a",
      adAccountId: "act_synthetic",
      active: true,
      allowedDestinations: [
        {
          active: true,
          destination: {
            id: "destination-a",
            pixelId: "synthetic-pixel",
            pageId: "synthetic-page",
            status: "configured",
          },
        },
      ],
    });
  }

  it("proves a lead destination from its reporting account's sole configured destination", async () => {
    const h = kommoHarness();
    h.state.metaAdDestinationAssignment = [];
    configureSingleDestinationFallback(h);

    const event = await h.receive();

    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "queued",
    });
    expect(h.state.conversionEventLog).toHaveLength(1);
  });

  it("reuses the uniquely resolved inbound route for the same attributed lead", async () => {
    const h = kommoHarness();
    h.state.metaAdDestinationAssignment = [];
    h.state.inboundWebhookEvent.push({
      id: "inbound-event-a",
      workspaceId: "workspace-a",
      channelId: "channel-a",
      contactIdentityHash: h.state.lead[0].phoneHash,
      adId: "ad-a",
      hasCtwa: true,
      classification: "eligible_route_resolved",
      resolvedReportingAccountId: "reporting-a",
      resolvedConversionDestinationId: "destination-a",
      channel: { whatsappInstanceId: "instance-a" },
    });

    const event = await h.receive();

    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "queued",
    });
  });

  /** Official-API lead (no WhatsApp instance) on route-a's official number. */
  function officialApiLead(h: any) {
    h.state.metaAdDestinationAssignment = [];
    const lead = h.state.lead[0];
    lead.whatsappInstanceId = null;
    const route = h.state.inboundWebhookChannelRoute[0];
    route.channelId = "channel-a";
    route.channel.whatsappInstanceId = null;
    route.channel.whatsappInstance = null;
    route.channel.connection.provider = "gupshup";
    return lead;
  }

  /** Inbound route resolution of the lead's ad on an official number,
   * optionally carrying the lead's materialized entry receipt. */
  function officialInbound(
    h: any,
    lead: any,
    channelId: string,
    destinationId: string,
    entry: boolean,
  ) {
    const logId = `entry-log-${channelId}`;
    if (entry)
      h.state.conversionEventLog.push({
        id: logId,
        workspaceId: "workspace-a",
        leadId: lead.id,
        phoneHash: lead.phoneHash,
        ctwaClid: lead.ctwaClid,
        eventName: "LeadSubmitted",
        sourceTrigger: "inbound_webhook:gupshup",
        dedupeKey: `inbound-webhook:gupshup:${channelId}`,
        status: "sent",
        sourcePayload: {
          provider: "gupshup",
          connectionId: "gupshup-connection-a",
          inboundEventId: `inbound-${channelId}`,
          channelId,
          processingMode: "live_production",
        },
      });
    h.state.inboundWebhookEvent.push({
      id: `inbound-${channelId}`,
      workspaceId: "workspace-a",
      channelId,
      connectionId: "gupshup-connection-a",
      contactIdentityHash: lead.phoneHash,
      adId: "ad-a",
      hasCtwa: true,
      classification: "eligible_route_resolved",
      resolvedReportingAccountId: "reporting-a",
      resolvedConversionDestinationId: destinationId,
      channel: { whatsappInstanceId: null },
      productionItem: entry
        ? {
            workspaceId: "workspace-a",
            leadId: lead.id,
            conversionEventLogId: logId,
            status: "materialized",
          }
        : null,
    });
  }

  it("proves an official-API lead destination only from the number it arrived on", async () => {
    const h = kommoHarness();
    const lead = officialApiLead(h);
    // Two official numbers resolved the same ad to different pixels; the lead
    // entered only through channel-a.
    officialInbound(h, lead, "channel-a", "destination-a", true);
    officialInbound(h, lead, "channel-b", "destination-b", false);

    const event = await h.receive();

    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "queued",
    });
    expect(h.state.kommoConversionDedupe[0].publicationIntent).toMatchObject({
      routeId: "route-a",
      channelId: "channel-a",
      whatsappInstanceId: null,
      destinationId: "destination-a",
    });
  });

  it("refuses an official-API lead whose arrival number has no resolved route", async () => {
    const h = kommoHarness();
    const lead = officialApiLead(h);
    // The lead entered through channel-b; only channel-a (another official
    // number) resolved the ad's route.
    officialInbound(h, lead, "channel-a", "destination-a", false);
    officialInbound(h, lead, "channel-b", "destination-b", true);
    h.state.inboundWebhookEvent = h.state.inboundWebhookEvent.map((row: any) =>
      row.channelId === "channel-b"
        ? { ...row, classification: "entry_without_route" }
        : row,
    );

    const event = await h.receive();

    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "blocked",
      errorCode: "lead_destination_unproven",
    });
    expect(
      h.state.conversionEventLog.some(
        (row: any) => row.sourceTrigger === "kommo_stage",
      ),
    ).toBe(false);
  });

  it("keeps zero configured destinations unproven", async () => {
    const h = kommoHarness();
    h.state.metaAdDestinationAssignment = [];
    h.state.metaAd.push({
      id: "meta-ad-a",
      workspaceId: "workspace-a",
      adId: "ad-a",
      adAccountId: "act_synthetic",
    });
    h.state.metaReportingAccount.push({
      id: "reporting-a",
      workspaceId: "workspace-a",
      adAccountId: "act_synthetic",
      active: true,
      allowedDestinations: [],
    });

    const event = await h.receive();

    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "blocked",
      errorCode: "lead_destination_unproven",
    });
  });

  it("keeps multiple destinations without a unique page or pixel match unproven", async () => {
    const h = kommoHarness();
    h.state.metaAdDestinationAssignment = [];
    h.state.metaAd.push({
      id: "meta-ad-a",
      workspaceId: "workspace-a",
      adId: "ad-a",
      adAccountId: "act_synthetic",
    });
    h.state.metaReportingAccount.push({
      id: "reporting-a",
      workspaceId: "workspace-a",
      adAccountId: "act_synthetic",
      active: true,
      allowedDestinations: [
        {
          active: true,
          destination: { id: "destination-a", status: "configured" },
        },
        {
          active: true,
          destination: { id: "destination-b", status: "configured" },
        },
      ],
    });

    const event = await h.receive();

    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "blocked",
      errorCode: "lead_destination_unproven",
    });
  });

  it("still rejects an unbound channel after proving the sole destination", async () => {
    const h = kommoHarness();
    h.state.metaAdDestinationAssignment = [];
    configureSingleDestinationFallback(h);
    h.connection.allowedChannelRouteIds = [];

    const event = await h.receive();

    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "blocked",
      errorCode: "lead_channel_route_unauthorized",
    });
  });

  it("still rejects ambiguous allowed routes after proving the sole destination", async () => {
    const h = kommoHarness();
    h.state.metaAdDestinationAssignment = [];
    configureSingleDestinationFallback(h);
    h.connection.allowedChannelRouteIds.push("route-b");
    h.state.inboundWebhookChannelRoute.push({
      ...structuredClone(h.state.inboundWebhookChannelRoute[0]),
      id: "route-b",
    });

    const event = await h.receive();

    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "blocked",
      errorCode: "lead_channel_route_ambiguous",
    });
  });

  it.each([
    [
      "remote deal id",
      (h: any) =>
        h.adapter.getLead.mockResolvedValue({
          id: "wrong",
          accountId: "account-a",
          contactIds: ["contact-a"],
        }),
      "remote_lead_account_mismatch",
    ],
    [
      "remote account",
      (h: any) =>
        h.adapter.getLead.mockResolvedValue({
          id: "deal-a",
          accountId: "other",
          contactIds: ["contact-a"],
        }),
      "remote_lead_account_mismatch",
    ],
    [
      "contact ambiguity",
      (h: any) =>
        h.adapter.getLead.mockResolvedValue({
          id: "deal-a",
          accountId: "account-a",
          contactIds: ["one", "two"],
        }),
      "contact_ambiguous",
    ],
    [
      "contact id",
      (h: any) =>
        h.adapter.getContact.mockResolvedValue({
          id: "wrong",
          accountId: "account-a",
          phones: ["+5511999999999"],
        }),
      "remote_contact_account_mismatch",
    ],
    [
      "phone ambiguity",
      (h: any) =>
        h.adapter.getContact.mockResolvedValue({
          id: "contact-a",
          accountId: "account-a",
          phones: ["+5511999999999", "+5511888888888"],
        }),
      "phone_ambiguous",
    ],
    [
      "no captured lead",
      (h: any) => {
        h.state.lead = [];
      },
      "workspace_lead_not_found",
    ],
    [
      "no bindings",
      (h: any) => {
        h.connection.allowedChannelRouteIds = [];
      },
      "lead_channel_route_unauthorized",
    ],
    [
      "foreign instance",
      (h: any) => {
        h.state.inboundWebhookChannelRoute[0].channel.whatsappInstance.workspaceId =
          "other";
      },
      "lead_channel_route_unauthorized",
    ],
    [
      "observation channel",
      (h: any) => {
        h.state.inboundWebhookChannelRoute[0].channel.connection.status =
          "observation";
      },
      "lead_channel_route_unauthorized",
    ],
    [
      "paused channel",
      (h: any) => {
        h.state.inboundWebhookChannelRoute[0].channel.status = "paused";
      },
      "lead_channel_route_unauthorized",
    ],
    [
      "foreign route",
      (h: any) => {
        h.state.inboundWebhookChannelRoute[0].workspaceId = "other";
      },
      "lead_channel_route_unauthorized",
    ],
    [
      "revoked Meta",
      (h: any) => {
        h.state.inboundWebhookChannelRoute[0].metaBusinessConnection.credential.status =
          "revoked";
      },
      "lead_channel_route_unauthorized",
    ],
  ])(
    "blocks %s without a Lead write or conversion",
    async (_name, change: any, code) => {
      const h = kommoHarness();
      change(h);
      const event = await h.receive();
      expect(
        await h.service.process(event.id, event.workspaceId),
      ).toMatchObject({ status: "blocked", errorCode: code });
      expect(h.state.conversionEventLog).toHaveLength(0);
      expect(h.prisma.lead.create).not.toHaveBeenCalled();
      expect(h.conversionQueue.retrySend).not.toHaveBeenCalled();
    },
  );
  it("observation creates outcomes without production side effects", async () => {
    const h = kommoHarness();
    h.state.kommoConversionRule[0].mode = "observation";
    const event = await h.receive();
    expect(await h.service.process(event.id, event.workspaceId)).toMatchObject({
      status: "observed",
    });
    expect(h.state.conversionEventLog).toHaveLength(0);
  });
  it("requires tenant-owned active production routes when binding channels", async () => {
    const h = kommoHarness();
    await expect(
      h.service.setChannelBindings("workspace-a", h.connection.id, "owner-a", [
        "unknown",
      ]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      h.service.setChannelBindings("other", h.connection.id, "owner-a", []),
    ).rejects.toMatchObject({ status: 404 });
    await h.service.setChannelBindings(
      "workspace-a",
      h.connection.id,
      "owner-a",
      [],
      "platform_admin",
    );
    expect(h.state.auditLog.at(-1).actorType).toBe("platform_admin");
  });
  it.each(conversionEventCatalogOrdered.map((event) => [event.eventName]))(
    "uses the canonical %s event/value contract",
    async (eventName: any) => {
      const h = kommoHarness();
      Object.assign(h.state.kommoConversionRule[0], {
        eventName,
        currency: conversionEventCarriesValue(eventName) ? "BRL" : null,
      });
      const event = await h.receive();
      await h.service.process(event.id, event.workspaceId);
      expect(h.state.conversionEventLog[0]).toMatchObject({
        eventName,
        valueCents: conversionEventCarriesValue(eventName) ? 12000 : null,
      });
      if (conversionEventRequiresValue(eventName))
        expect(h.state.conversionEventLog[0].currency).toBe("BRL");
    },
  );
});
