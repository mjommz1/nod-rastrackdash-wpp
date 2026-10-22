import { Socket } from "node:net";
import { request as httpsRequest } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KommoAdapter, KommoAdapterError } from "../src/kommo/kommo.adapter";
import { ConversionEventsService } from "../src/conversion-events/conversion-events.service";
import { MetaCapiAdapter } from "../src/conversion-events/meta-capi.adapter";
import { ConversionEventProcessor } from "../src/common/queue/conversion-event.processor";
import { ConversionEventsQueueService } from "../src/common/queue/conversion-events-queue.service";
import { kommoHarness, deferred } from "./support/kommo-stateful-harness";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "actual Node HTTPS consumes pinned DNS with autoSelectFamily=%s before synthetic socket cancellation",
  async (autoSelectFamily) => {
    const lookups: unknown[] = [];
    const errors: any[] = [];
    const dnsOptions: any[] = [];
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    const originalConnect = Socket.prototype.connect;
    vi.spyOn(Socket.prototype, "connect").mockImplementation(function (
      this: Socket,
      ...args: any[]
    ) {
      // Attach to the actual net socket before TLS wraps it. Node emits lookup
      // before native connect and rechecks connecting after this listener.
      this.once("lookup", (error, address, family) => {
        lookups.push({ error, address, family });
        this.destroy(
          Object.assign(new Error("synthetic socket boundary"), {
            code: "SYNTHETIC_STOP",
          }),
        );
      });
      return originalConnect.apply(this, args as any);
    });
    const adapter = new KommoAdapter({
      lookup,
      now: Date.now,
      request: (url: any, options: any, callback: any) => {
        const pinned = options.lookup;
        // Defer only the synthetic DNS completion so listeners can cancel before
        // Node reaches native connect. HTTPS/net and family selection are real.
        const req = httpsRequest(
          url,
          {
            ...options,
            agent: false,
            autoSelectFamily,
            lookup: (host: string, opts: any, cb: any) => {
              dnsOptions.push(opts);
              queueMicrotask(() => pinned(host, opts, cb));
            },
          },
          callback,
        );
        req.on("error", (error) => errors.push(error));
        return req;
      },
    } as any);
    await expect(
      adapter.verify("https://synthetic.kommo.com/", "synthetic-only"),
    ).rejects.toThrow("kommo_transport");
    expect(dnsOptions[0].all === true).toBe(autoSelectFamily);
    expect(lookups).toEqual([{ error: null, address: "8.8.8.8", family: 4 }]);
    expect(errors.map((error) => error.code)).toEqual(["SYNTHETIC_STOP"]);
    expect(lookup).toHaveBeenCalledOnce();
  },
);

async function sendingHarness() {
  const h = kommoHarness();
  const event = await h.receive();
  await h.service.process(event.id, event.workspaceId);
  const fetcher = vi.fn(
    async (_url: string, _options?: RequestInit) =>
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
    {
      hasNormalizedConnections: vi.fn(async () => true),
      resolveCapiRoute: vi.fn(async () => ({
        source: "manual",
        accessToken: "synthetic-meta-only",
        pixelId: "synthetic-pixel",
        pageId: "synthetic-page",
        reportingAccountId: "reporting-a",
        adAccountId: "act_synthetic",
        businessConnectionId: "business-a",
        conversionDestinationId: "destination-a",
      })),
    } as any,
    h.license as any,
  );
  const worker = new ConversionEventProcessor(sender, h.prisma);
  const log = h.state.conversionEventLog[0];
  const job: any = {
    id: "synthetic-send",
    name: "send-ready-event",
    data: { workspaceId: "workspace-a", conversionEventLogId: log.id },
    attemptsMade: 0,
  };
  return { ...h, event, fetcher, sender, worker, log, job };
}
function payloadIds(fetcher: ReturnType<typeof vi.fn>) {
  return fetcher.mock.calls.map(
    ([, options]: any) => JSON.parse(options.body).data[0].event_id,
  );
}

describe("fail-closed Kommo sender outcomes", () => {
  it.each(["response loss", "timeout", "typed network error"])(
    "acceptance before %s blocks worker, reconciliation and manual redispatch",
    async (kind) => {
      const h = await sendingHarness();
      const accepted: string[] = [];
      h.fetcher.mockImplementationOnce(async (_url: any, options: any) => {
        accepted.push(JSON.parse(options.body).data[0].event_id);
        const error = new Error(`synthetic ${kind}`);
        error.name =
          kind === "timeout" ? "TimeoutError" : "MetaCapiNetworkError";
        throw error;
      });
      expect(await h.worker.process(h.job)).toMatchObject({
        status: "error",
        errorCode: "MetaCapiDeliveryUnknown",
        errorMessage: expect.stringContaining("Reenvio bloqueado"),
      });
      const intent = h.state.kommoConversionDedupe[0];
      const target = structuredClone(intent.publicationIntent);
      const claim = intent.senderLeaseToken;
      expect(claim).toBeTruthy();
      expect(intent).toMatchObject({
        senderRetryable: false,
        senderAttempts: 1,
        publicationStatus: "delivery_unknown",
        publicationErrorCode: "kommo_delivery_unknown",
      });
      h.conversionQueue.retrySend.mockClear();
      h.queue.enqueue.mockClear();
      h.advance(365 * 24 * 60 * 60 * 1000);
      for (let i = 0; i < 3; i++) {
        h.job.attemptsMade = i + 1;
        expect(await h.worker.process(h.job)).toMatchObject({
          status: "skipped",
        });
        await (h.service as any).reconcileRecoverableEvents();
        expect(
          await h.service.reprocess(
            "workspace-a",
            h.event.id,
            "guard-owner",
            "platform_admin",
          ),
        ).toMatchObject({
          status: "blocked",
          errorCode: "kommo_delivery_unknown",
        });
      }
      expect(h.fetcher).toHaveBeenCalledOnce();
      expect(accepted).toEqual([h.log.eventId]);
      expect(payloadIds(h.fetcher)).toEqual([target.eventId]);
      expect(intent.publicationIntent).toEqual(target);
      expect(intent.senderLeaseToken).toBe(claim);
      expect(h.conversionQueue.retrySend).not.toHaveBeenCalled();
      expect(h.queue.enqueue).not.toHaveBeenCalled();
      expect(
        (await h.service.listEvents("workspace-a", h.connection.id)).events[0],
      ).toMatchObject({
        status: "blocked",
        errorCode: "kommo_delivery_unknown",
        errorMessage: expect.stringContaining("investigacao requerida"),
        results: [
          expect.objectContaining({ publicationStatus: "delivery_unknown" }),
        ],
      });
      expect(h.state.auditLog.at(-1)).toMatchObject({
        actorUserId: "guard-owner",
        actorType: "platform_admin",
      });
    },
  );

  it("actual queue failure before dispatch recovers through manual reprocess and reconciliation", async () => {
    const h = await sendingHarness();
    const intent = h.state.kommoConversionDedupe[0];
    intent.publicationStatus = "publication_pending";
    h.advance(31_000);
    const retained = {
      getState: vi.fn(async () => "failed"),
      remove: vi.fn(async () => {}),
    };
    const bull = {
      getJob: vi.fn(async () => retained),
      add: vi.fn(async (_name: any, data: any) => {
        expect(h.log.status).toBe("ready_to_send");
        expect(data).toEqual(h.job.data);
        return { id: "synthetic-retry" };
      }),
    };
    bull.add.mockRejectedValueOnce(
      new Error("synthetic queue failure before dispatch"),
    );
    const queue = new ConversionEventsQueueService(bull as any);
    h.conversionQueue.retrySend.mockImplementation((id, workspace) =>
      queue.retrySend(id, workspace),
    );
    expect(
      await (h.service as any).publishIntent(structuredClone(intent)),
    ).toBe("publication_pending");
    expect(intent).toMatchObject({
      senderAttempts: 0,
      senderLeaseToken: null,
      publicationErrorCode: "conversion_enqueue_failed",
    });
    expect(h.fetcher).not.toHaveBeenCalled();
    intent.publicationStatus = "publication_failed";
    h.event.status = "dead";
    expect(
      await h.service.reprocess("workspace-a", h.event.id, "guard-owner"),
    ).toMatchObject({ status: "queued" });
    h.advance(100_000);
    await (h.service as any).reconcileRecoverableEvents();
    expect(bull.add).toHaveBeenCalledTimes(2);
    expect(retained.remove).toHaveBeenCalledTimes(2);
    expect(intent.publicationStatus).toBe("queued");
    expect(await h.worker.process(h.job)).toMatchObject({ status: "sent" });
    expect(h.fetcher).toHaveBeenCalledOnce();
    expect(payloadIds(h.fetcher)).toEqual([h.log.eventId]);
  });

  it.each(["error", "ready_to_send"])(
    "legacy typed network retry permission never dispatches a %s log",
    async (status) => {
      const h = await sendingHarness();
      Object.assign(h.log, {
        status,
        errorCode: "MetaCapiNetworkError",
      });
      Object.assign(h.state.kommoConversionDedupe[0], {
        senderAttempts: 1,
        senderRetryable: true,
        senderLeaseToken: null,
      });
      h.conversionQueue.retrySend.mockClear();
      h.advance(31_000);
      await (h.service as any).reconcileRecoverableEvents();
      expect(
        await h.sender.prepareKommoSenderRetry(h.log.id, "workspace-a"),
      ).toBe("delivery_unknown");
      expect(
        await h.service.reprocess("workspace-a", h.event.id, "guard-owner"),
      ).toMatchObject({
        status: "blocked",
        errorCode: "kommo_delivery_unknown",
      });
      expect(await h.worker.process(h.job)).toMatchObject({
        status: "skipped",
      });
      expect(h.log.status).toBe(status);
      expect(h.state.kommoConversionDedupe[0].senderRetryable).toBe(false);
      expect(h.fetcher).not.toHaveBeenCalled();
      expect(h.conversionQueue.retrySend).not.toHaveBeenCalled();
    },
  );

  it.each(["completion", "rejection"])(
    "late queue %s cannot overwrite a sender unknown outcome",
    async (kind) => {
      const h = await sendingHarness();
      const intent = h.state.kommoConversionDedupe[0];
      intent.publicationStatus = "publication_pending";
      h.advance(31_000);
      h.fetcher.mockRejectedValueOnce(
        new Error("synthetic accepted then response lost"),
      );
      h.conversionQueue.retrySend.mockImplementationOnce(async () => {
        expect(await h.worker.process(h.job)).toMatchObject({
          errorCode: "MetaCapiDeliveryUnknown",
        });
        if (kind === "rejection")
          throw new Error("synthetic queue acknowledgement loss");
        return { status: "queued" };
      });
      expect(
        await (h.service as any).publishIntent(structuredClone(intent)),
      ).toBe("delivery_unknown");
      expect(intent).toMatchObject({
        publicationStatus: "delivery_unknown",
        publicationErrorCode: "kommo_delivery_unknown",
      });
      expect(intent.senderLeaseToken).toBeTruthy();
      expect(await h.worker.process(h.job)).toMatchObject({
        status: "skipped",
      });
      expect(h.fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(["revoked", "target_changed"])(
    "%s authorization blocks the actual sender before dispatch",
    async (kind) => {
      const h = await sendingHarness();
      if (kind === "revoked") h.connection.status = "paused";
      else
        h.state.inboundWebhookChannelRoute[0].metaConversionDestination.pixelId =
          "changed";
      h.conversionQueue.retrySend.mockClear();
      h.advance(31_000);
      await (h.service as any).reconcileRecoverableEvents();
      expect(await h.worker.process(h.job)).toMatchObject({
        status: "skipped",
      });
      expect(h.fetcher).not.toHaveBeenCalled();
      expect(h.conversionQueue.retrySend).not.toHaveBeenCalled();
      expect(h.state.kommoConversionDedupe[0].publicationStatus).toBe(
        "revoked",
      );
    },
  );

  it("blocked manual recovery still requires an atomic audit", async () => {
    const h = await sendingHarness();
    h.fetcher.mockRejectedValueOnce(new Error("synthetic response loss"));
    await h.worker.process(h.job);
    const before = structuredClone(h.state);
    h.queue.enqueue.mockClear();
    h.conversionQueue.retrySend.mockClear();
    h.prisma.auditLog.create.mockRejectedValueOnce(
      new Error("synthetic required audit failure"),
    );
    await expect(
      h.service.reprocess("workspace-a", h.event.id, "guard-owner"),
    ).rejects.toThrow("synthetic required audit failure");
    expect(h.state).toEqual(before);
    expect(h.queue.enqueue).not.toHaveBeenCalled();
    expect(h.conversionQueue.retrySend).not.toHaveBeenCalled();
    expect(await h.worker.process(h.job)).toMatchObject({ status: "skipped" });
    expect(h.fetcher).toHaveBeenCalledOnce();
  });

  it.each(["terminal", "unknown", "revoked", "target_changed", "sent"])(
    "manual reprocess and reconciliation grant no send for %s",
    async (kind) => {
      const h = await sendingHarness();
      if (kind === "terminal")
        h.fetcher.mockResolvedValueOnce(new Response("{}", { status: 400 }));
      else if (kind === "unknown")
        h.fetcher.mockRejectedValueOnce(new Error("synthetic network loss"));
      if (kind === "terminal")
        expect(await h.worker.process(h.job)).toMatchObject({
          status: "error",
        });
      else
        expect(await h.worker.process(h.job)).toMatchObject({
          status: kind === "unknown" ? "error" : "sent",
        });
      const intent = h.state.kommoConversionDedupe[0];
      if (kind === "unknown") intent.senderRetryable = true; // Even a legacy positive marker cannot prove non-delivery.
      if (kind === "revoked") h.connection.status = "paused";
      if (kind === "target_changed")
        h.state.inboundWebhookChannelRoute[0].metaConversionDestination.pixelId =
          "changed";

      intent.publicationStatus = "publication_failed";
      h.event.status = "dead";
      h.conversionQueue.retrySend.mockClear();
      await h.service.reprocess("workspace-a", h.event.id, "guard-owner");
      if (kind !== "unknown")
        await h.service.process(h.event.id, "workspace-a");
      h.advance(31_000);
      await (h.service as any).reconcileRecoverableEvents();
      expect(await h.worker.process(h.job)).toMatchObject({
        status: "skipped",
      });
      expect(h.fetcher).toHaveBeenCalledOnce();
      expect(h.conversionQueue.retrySend).not.toHaveBeenCalled();
      expect(intent.publicationStatus).toBe(
        kind === "unknown"
          ? "delivery_unknown"
          : kind === "terminal"
            ? "publication_failed"
            : "sent",
      );
    },
  );

  it("preserves exhausted attempt bounds across manual resets", async () => {
    const h = await sendingHarness();
    h.state.kommoConversionDedupe[0].senderAttempts = 5;
    expect(
      await h.sender.prepareKommoSenderRetry(h.log.id, "workspace-a"),
    ).toBe("delivery_unknown");
    expect(await h.worker.process(h.job)).toMatchObject({ status: "skipped" });
    expect(
      await h.service.reprocess("workspace-a", h.event.id, "guard-owner"),
    ).toMatchObject({ status: "blocked", errorCode: "kommo_delivery_unknown" });
    await h.service.process(h.event.id, "workspace-a");
    expect(await h.worker.process(h.job)).toMatchObject({ status: "skipped" });
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.state.kommoConversionDedupe[0].senderAttempts).toBe(5);
  });

  it("competing workers and publication leases cannot permit another send while one is in flight", async () => {
    const h = await sendingHarness();
    const entered = deferred();
    const release = deferred<Response>();
    h.fetcher.mockImplementationOnce(async () => {
      entered.resolve();
      return release.promise;
    });
    const first = h.worker.process(h.job);
    await entered.promise;
    expect(
      await h.worker.process({ ...h.job, id: "competing-worker" }),
    ).toMatchObject({ status: "skipped" });
    h.advance(100_000); // Publication lease expiry grants no sender permission.
    h.conversionQueue.retrySend.mockClear();
    const intent = structuredClone(h.state.kommoConversionDedupe[0]);
    await Promise.all([
      (h.service as any).publishIntent(intent),
      (h.service as any).publishIntent(intent),
    ]);
    expect(h.conversionQueue.retrySend).not.toHaveBeenCalled();
    expect(h.fetcher).toHaveBeenCalledOnce();
    expect(
      await h.service.reprocess("workspace-a", h.event.id, "guard-owner"),
    ).toMatchObject({ status: "blocked", errorCode: "kommo_delivery_unknown" });
    release.resolve(
      new Response(
        JSON.stringify({
          events_received: 1,
          messages: [],
          fbtrace_id: "synthetic-trace",
        }),
        { status: 200 },
      ),
    );
    expect(await first).toMatchObject({ status: "sent" });
    expect(h.state.kommoConversionDedupe[0]).toMatchObject({
      publicationStatus: "sent",
      senderLeaseToken: null,
    });
    expect(await h.worker.process(h.job)).toMatchObject({ status: "skipped" });
    expect(h.fetcher).toHaveBeenCalledOnce();
  });

  it("leaves unrelated provider sender error semantics unchanged", async () => {
    const h = await sendingHarness();
    h.log.sourceTrigger = "guimo_stage";
    h.fetcher.mockRejectedValueOnce(new Error("synthetic network loss"));
    await expect(h.worker.process(h.job)).rejects.toThrow();
    expect(await h.worker.process(h.job)).toMatchObject({ status: "skipped" });
    expect(h.log.status).toBe("error");
    expect(h.fetcher).toHaveBeenCalledOnce();
    expect(h.state.kommoConversionDedupe[0].senderAttempts).toBe(0);
  });

  it("an unknown interrupted send retains its durable claim rather than granting duplicate permission", async () => {
    const h = await sendingHarness();
    h.prisma.conversionEventLog.updateMany.mockRejectedValueOnce(
      new Error("synthetic persistence failure after send"),
    );
    await expect(h.worker.process(h.job)).rejects.toThrow(
      "synthetic persistence failure",
    );
    const intent = h.state.kommoConversionDedupe[0]; // committed row after rollback
    const claim = intent.senderLeaseToken;
    expect(h.state.conversionEventLog[0].status).toBe("ready_to_send");
    h.conversionQueue.retrySend.mockClear();
    h.advance(1_000_000);
    await (h.service as any).reconcileRecoverableEvents();
    expect(intent).toMatchObject({
      publicationStatus: "delivery_unknown",
      senderRetryable: false,
      senderLeaseToken: claim,
    });
    expect(
      await h.service.reprocess("workspace-a", h.event.id, "guard-owner"),
    ).toMatchObject({ status: "blocked", errorCode: "kommo_delivery_unknown" });
    expect(h.conversionQueue.retrySend).not.toHaveBeenCalled();
    expect(await h.worker.process(h.job)).toMatchObject({ status: "skipped" });
    expect(h.fetcher).toHaveBeenCalledOnce();
    expect(h.state.kommoConversionDedupe[0].senderLeaseToken).toBeTruthy();
  });
});

it("fair bounded catalog sweeps advance beyond 100 persistently failing accounts and dispose their timer", async () => {
  const h = kommoHarness();
  h.state.kommoConnection = Array.from({ length: 101 }, (_, i) => {
    const id = `connection-${String(i).padStart(3, "0")}`;
    return {
      ...structuredClone(h.connection),
      id,
      accountOrigin: `https://synthetic-${i}.kommo.com/`,
      catalogRefreshedAt: null,
      ...(h.service as any).encrypt(id, "synthetic-only"),
    };
  });
  h.adapter.listPipelines.mockRejectedValue(
    new KommoAdapterError("kommo_transport"),
  );
  await h.service.onModuleInit();
  expect(h.adapter.listPipelines).toHaveBeenCalledTimes(100);
  await (h.service as any).reconcileRecoverableEvents();
  expect(h.adapter.listPipelines).toHaveBeenCalledTimes(101);
  expect(h.adapter.listPipelines.mock.calls.at(-1)?.[0]).toBe(
    "https://synthetic-100.kommo.com/",
  );
  expect(
    h.state.kommoConnection.every(
      (row) => row.credentialHealthy && row.catalogState === "error",
    ),
  ).toBe(true);
  const timer = (h.service as any).recoveryTimer;
  h.service.onModuleDestroy();
  expect(timer._destroyed).toBe(true);
  await (h.service as any).reconcileSafely();
  expect(h.adapter.listPipelines).toHaveBeenCalledTimes(101);
});

describe("required management audits are durable before side effects", () => {
  it.each([
    "create",
    "credential",
    "status",
    "remove",
    "rotate",
    "rule_create",
    "rule_update",
    "rule_delete",
    "bindings",
    "reprocess",
    "recover",
  ])(
    "audit persistence failure rolls back %s and emits no queue",
    async (action) => {
      const h = kommoHarness();
      let eventId = "";
      if (action === "reprocess" || action === "recover") {
        const event = await h.receive();
        eventId = event.id;
        if (action === "reprocess") {
          await h.service.process(event.id, "workspace-a");
          h.state.kommoWebhookEvent[0].status = "dead";
          h.state.kommoConversionDedupe[0].publicationStatus =
            "publication_failed";
        }
      }
      h.queue.enqueue.mockClear();
      h.conversionQueue.retrySend.mockClear();
      const snapshot = structuredClone(h.state);
      h.prisma.auditLog.create.mockRejectedValueOnce(
        new Error("synthetic required audit failure"),
      );
      const id = h.connection.id;
      const calls: Record<string, () => Promise<any>> = {
        create: () =>
          h.service.create("workspace-a", "guard-owner", {
            displayName: "Synthetic",
            accountOrigin: "https://new-synthetic.kommo.com/",
            accessToken: "synthetic-only",
            allowedChannelRouteIds: ["route-a"],
          }),
        credential: () =>
          h.service.replaceCredential("workspace-a", id, "guard-owner", {
            accessToken: "synthetic-replacement",
          }),
        status: () =>
          h.service.setStatus("workspace-a", id, "guard-owner", "paused"),
        remove: () => h.service.remove("workspace-a", id, "guard-owner"),
        rotate: () => h.service.rotateSecret("workspace-a", id, "guard-owner"),
        rule_create: () =>
          h.service.createRule("workspace-a", id, "guard-owner", {
            name: "Synthetic qualification",
            pipelineId: "p",
            statusId: "142",
            eventName: "QualifiedLead",
            mode: "observation",
            active: true,
            valueMode: "lead_price",
          }),
        rule_update: () =>
          h.service.updateRule("workspace-a", id, "rule-a", "guard-owner", {
            name: "Changed",
          }),
        rule_delete: () =>
          h.service.deleteRule("workspace-a", id, "rule-a", "guard-owner"),
        bindings: () =>
          h.service.setChannelBindings("workspace-a", id, "guard-owner", []),
        reprocess: () =>
          h.service.reprocess("workspace-a", eventId, "guard-owner"),
        recover: () => h.service.recover("workspace-a", id, "guard-owner"),
      };
      await expect(calls[action]()).rejects.toThrow(
        "synthetic required audit failure",
      );
      expect(h.state).toEqual(snapshot);
      expect(h.queue.enqueue).not.toHaveBeenCalled();
      expect(h.conversionQueue.retrySend).not.toHaveBeenCalled();
      if (["create", "credential"].includes(action))
        expect(h.adapter.listPipelines).not.toHaveBeenCalled();
      if (action === "create") expect(h.adapter.verify).not.toHaveBeenCalled();
    },
  );

  it.each(["reprocess", "recover"])(
    "%s publishes only after committed audit with guard actor",
    async (action) => {
      const h = kommoHarness();
      const event = await h.receive();
      h.queue.enqueue.mockImplementation(async (id) => {
        expect(h.state.auditLog.at(-1)).toMatchObject({
          action:
            action === "recover"
              ? "kommo.recovery_requested"
              : "kommo.event_reprocess_requested",
          actorUserId: "guard-owner",
          actorType: "platform_admin",
        });
        return `synthetic-${id}`;
      });
      if (action === "recover")
        await h.service.recover(
          "workspace-a",
          h.connection.id,
          "guard-owner",
          "platform_admin",
        );
      else
        await h.service.reprocess(
          "workspace-a",
          event.id,
          "guard-owner",
          "platform_admin",
        );
    },
  );
});
