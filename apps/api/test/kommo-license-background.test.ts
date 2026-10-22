import { describe, expect, it, vi } from "vitest";
import { MetaCapiAdapter } from "../src/conversion-events/meta-capi.adapter";
import { ConversionEventsService } from "../src/conversion-events/conversion-events.service";
import { deferred, kommoHarness } from "./support/kommo-stateful-harness";

const locked = {
  inert: false,
  locked: true,
  reason: "revoked",
  state: { status: "blocked" },
};
const allowed = {
  inert: false,
  locked: false,
  reason: null,
  state: { status: "active" },
};

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

describe("Kommo background license boundary", () => {
  it("leaves a durably accepted/queued event untouched when a later worker sees a lock", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    const before = structuredClone(h.state.kommoWebhookEvent[0]);
    h.queue.enqueue.mockClear();
    h.setLicense(locked);

    await expect(
      h.service.process(event.id, event.workspaceId),
    ).resolves.toEqual({
      status: before.status,
      errorCode: "license_locked",
    });
    expect(h.state.kommoWebhookEvent[0]).toEqual(before);
    expect(h.state.conversionEventLog).toHaveLength(0);
    expect(h.queue.enqueue).not.toHaveBeenCalled();
  });

  it("rechecks after enrichment and releases only its processing lease on a new lock", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    const entered = deferred();
    const resume = deferred();
    h.adapter.getLead.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return {
        id: "deal-a",
        accountId: "account-a",
        contactIds: ["contact-a"],
      };
    });
    const processing = h.service.process(event.id, event.workspaceId);
    await entered.promise;
    h.setLicense(locked);
    resume.resolve();

    await expect(processing).resolves.toEqual({
      status: "queued",
      errorCode: "license_locked",
    });
    expect(h.state.conversionEventLog).toHaveLength(0);
    expect(h.state.kommoWebhookEvent[0]).toMatchObject({
      status: "queued",
      leaseToken: null,
      leaseExpiresAt: null,
    });
  });

  it("rolls back the actual materialization transaction when a lock arrives after its authorization read", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    const entered = deferred();
    const resume = deferred();
    const original =
      h.prisma.kommoConversionDedupe.findUnique.getMockImplementation();
    h.prisma.kommoConversionDedupe.findUnique.mockImplementationOnce(
      async (args: any) => {
        entered.resolve();
        await resume.promise;
        return original(args);
      },
    );

    const processing = h.service.process(event.id, event.workspaceId);
    await entered.promise;
    h.setLicense(locked);
    resume.resolve();

    await expect(processing).resolves.toEqual({
      status: "queued",
      errorCode: "license_locked",
    });
    expect(h.state.kommoConversionDedupe).toHaveLength(0);
    expect(h.state.conversionEventLog).toHaveLength(0);
    expect(h.state.kommoWebhookEvent[0]).toMatchObject({
      status: "queued",
      leaseToken: null,
      leaseExpiresAt: null,
    });
  });

  it("rolls back fence and canonical log when the real Purchase-kind read completes after a lock", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    const entered = deferred();
    const resume = deferred();
    const original = h.prisma.conversionEventLog.count.getMockImplementation();
    h.prisma.conversionEventLog.count.mockImplementationOnce(
      async (args: any) => {
        entered.resolve();
        await resume.promise;
        return original(args);
      },
    );

    const processing = h.service.process(event.id, event.workspaceId);
    await entered.promise;
    h.setLicense(locked);
    resume.resolve();

    await expect(processing).resolves.toEqual({
      status: "queued",
      errorCode: "license_locked",
    });
    expect(h.state.kommoConversionDedupe).toHaveLength(0);
    expect(h.state.conversionEventLog).toHaveLength(0);
  });

  it("fails closed on a late canonical-log lookup error and uses harness rollback semantics", async () => {
    // This stateful mock snapshots all tables at transaction entry and restores
    // them when the actual service path throws; it is not a PostgreSQL claim.
    const h = kommoHarness();
    const event = await h.receive();
    const entered = deferred();
    const resume = deferred();
    const original = h.prisma.conversionEventLog.count.getMockImplementation();
    h.prisma.conversionEventLog.count.mockImplementationOnce(
      async (args: any) => {
        entered.resolve();
        await resume.promise;
        return original(args);
      },
    );

    const processing = h.service.process(event.id, event.workspaceId);
    await entered.promise;
    h.license.getLockState.mockRejectedValueOnce(
      new Error("late license lookup unavailable"),
    );
    resume.resolve();

    await expect(processing).resolves.toEqual({
      status: "queued",
      errorCode: "license_locked",
    });
    expect(h.state.kommoConversionDedupe).toHaveLength(0);
    expect(h.state.conversionEventLog).toHaveLength(0);
  });

  it("rolls back a newly written canonical log if a lock arrives before publication intent write", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    const entered = deferred();
    const resume = deferred();
    const original = h.prisma.conversionEventLog.create.getMockImplementation();
    h.prisma.conversionEventLog.create.mockImplementationOnce(
      async (args: any) => {
        const log = await original(args);
        entered.resolve();
        await resume.promise;
        return log;
      },
    );

    const processing = h.service.process(event.id, event.workspaceId);
    await entered.promise;
    expect(h.state.kommoConversionDedupe).toHaveLength(1);
    expect(h.state.conversionEventLog).toHaveLength(1);
    h.setLicense(locked);
    resume.resolve();

    await expect(processing).resolves.toEqual({
      status: "queued",
      errorCode: "license_locked",
    });
    expect(h.state.kommoConversionDedupe).toHaveLength(0);
    expect(h.state.conversionEventLog).toHaveLength(0);
  });

  it("fails closed on license lookup failure and resumes the same durable intent once allowed", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    h.license.getLockState.mockRejectedValueOnce(
      new Error("license lookup unavailable"),
    );
    await expect(
      h.service.process(event.id, event.workspaceId),
    ).resolves.toMatchObject({
      status: "queued",
      errorCode: "license_locked",
    });
    expect(h.state.conversionEventLog).toHaveLength(0);

    h.setLicense(allowed);
    await expect(
      h.service.process(event.id, event.workspaceId),
    ).resolves.toMatchObject({ status: "queued" });
    expect(h.state.conversionEventLog).toHaveLength(1);
  });

  it("permits work only when the canonical service explicitly declares licensing inert", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    h.setLicense({
      inert: true,
      locked: true,
      reason: "revoked",
      state: { status: "blocked" },
    });

    await expect(
      h.service.process(event.id, event.workspaceId),
    ).resolves.toMatchObject({ status: "queued" });
    expect(h.state.conversionEventLog).toHaveLength(1);
  });

  it("does not recover or enqueue while locked at startup/timer recovery", async () => {
    const h = kommoHarness();
    await h.receive();
    h.queue.enqueue.mockClear();
    h.setLicense(locked);

    await expect((h.service as any).reconcileRecoverableEvents()).resolves.toBe(
      0,
    );
    expect(h.queue.enqueue).not.toHaveBeenCalled();
  });

  it("rechecks after recovery intent/log reads before queue enqueue and resumes after re-enable", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    h.queue.enqueue.mockClear();
    const entered = deferred();
    const resume = deferred();
    const original =
      h.prisma.conversionEventLog.findFirst.getMockImplementation();
    h.prisma.conversionEventLog.findFirst.mockImplementationOnce(
      async (args: any) => {
        entered.resolve();
        await resume.promise;
        return original(args);
      },
    );

    const recovering = h.service.recover(
      event.workspaceId,
      h.connection.id,
      "operator-a",
      "platform_admin",
    );
    await entered.promise;
    h.setLicense(locked);
    resume.resolve();
    await expect(recovering).resolves.toEqual({ queued: 0 });
    expect(h.queue.enqueue).not.toHaveBeenCalled();
    expect(h.state.kommoConversionDedupe[0]).toMatchObject({
      publicationStatus: "queued",
      publicationLeaseToken: null,
    });

    h.setLicense(allowed);
    await expect(
      h.service.recover(
        event.workspaceId,
        h.connection.id,
        "operator-a",
        "platform_admin",
      ),
    ).resolves.toMatchObject({ queued: expect.any(Number) });
    expect(h.queue.enqueue).toHaveBeenCalled();
  });

  it("checks again immediately before dispatch, releases the sender claim, and never fabricates delivery", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            events_received: 1,
            messages: [],
            fbtrace_id: "synthetic-trace",
          }),
          { status: 200 },
        ),
    );
    const sender = new ConversionEventsService(
      h.prisma,
      new MetaCapiAdapter({}, fetcher as any),
      {} as any,
      resolver as any,
      h.license as any,
    );
    h.license.getLockState
      .mockReset()
      .mockResolvedValueOnce(allowed)
      .mockResolvedValueOnce(allowed)
      .mockResolvedValueOnce(locked);

    await expect(
      sender.sendReadyEvent(h.state.conversionEventLog[0].id, {
        workspaceId: "workspace-a",
      }),
    ).resolves.toMatchObject({ status: "skipped" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(h.state.conversionEventLog[0]).toMatchObject({
      status: "ready_to_send",
    });
    expect(h.state.kommoConversionDedupe[0]).toMatchObject({
      senderAttempts: 0,
      senderLeaseToken: null,
      publicationStatus: "queued",
    });
  });

  it("keeps an unknown-delivery fence intact when recovery is allowed again", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    const intent = h.state.kommoConversionDedupe[0];
    const log = h.state.conversionEventLog[0];
    intent.publicationStatus = "delivery_unknown";
    intent.senderLeaseToken = "unproven-dispatch";
    intent.senderAttempts = 1;
    log.status = "error";
    log.errorCode = "MetaCapiDeliveryUnknown";

    h.setLicense(allowed);
    await expect(
      h.conversions.prepareKommoSenderRetry(log.id, "workspace-a"),
    ).resolves.toBe("delivery_unknown");
    expect(intent).toMatchObject({
      publicationStatus: "delivery_unknown",
      senderLeaseToken: "unproven-dispatch",
      senderAttempts: 1,
    });
  });
});
