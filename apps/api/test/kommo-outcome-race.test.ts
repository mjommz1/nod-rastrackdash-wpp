import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversionEventsService } from "../src/conversion-events/conversion-events.service";
import { MetaCapiAdapter } from "../src/conversion-events/meta-capi.adapter";
import { deferred, kommoHarness } from "./support/kommo-stateful-harness";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function sendingHarness() {
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
    {
      hasNormalizedConnections: vi.fn(async () => true),
      resolveCapiRoute: vi.fn(async () => ({
        source: "manual",
        accessToken: "synthetic-only",
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
  return { ...h, event, fetcher, sender, log: h.state.conversionEventLog[0] };
}

// Statement-level READ COMMITTED simulator for successful interleavings.
// Distinct transaction clients share committed rows; no global transaction tail.
// Writes are atomic statements. This does not simulate PostgreSQL row locks,
// uncommitted visibility or rollback; those need independent real-DB validation.
function overlapUnknownDecision(h: Awaited<ReturnType<typeof sendingHarness>>) {
  const paused = deferred();
  const resume = deferred();
  const commits: number[] = [];
  const active = new Set<number>();
  const unknownWrites: Array<{ count: number }> = [];
  let sequence = 0;
  let recoveryTransaction = 0;
  let intercepted = false;
  const update = h.prisma.kommoConversionDedupe.updateMany;
  h.prisma.$transaction.mockImplementation(async (callback: any) => {
    const id = ++sequence;
    active.add(id);
    const tx = Object.create(h.prisma);
    tx.kommoConversionDedupe = {
      ...h.prisma.kommoConversionDedupe,
      updateMany: async (args: any) => {
        if (
          !intercepted &&
          args.data.publicationStatus === "delivery_unknown"
        ) {
          intercepted = true;
          recoveryTransaction = id;
          paused.resolve(); // Service already read both intent and log.
          await resume.promise;
          const result = await update(args);
          unknownWrites.push(result);
          return result;
        }
        return update(args);
      },
    };
    try {
      const result = await callback(tx);
      commits.push(id);
      return result;
    } finally {
      active.delete(id);
    }
  });
  return {
    paused,
    resume,
    commits,
    active,
    unknownWrites,
    recoveryTransaction: () => recoveryTransaction,
  };
}

describe("confirmed Kommo outcomes dominate stale unknown decisions", () => {
  it.each(["prepare", "manual"])(
    "%s pauses after reads while a distinct sender transaction commits sent",
    async (path) => {
      const h = await sendingHarness();
      const overlap = overlapUnknownDecision(h);
      const dispatched = deferred();
      const response = deferred<Response>();
      h.fetcher.mockImplementationOnce(async () => {
        dispatched.resolve();
        return response.promise;
      });
      const sending = h.sender.sendReadyEvent(h.log.id, {
        workspaceId: "workspace-a",
      });
      await dispatched.promise;
      const intent = h.state.kommoConversionDedupe[0];
      const target = structuredClone(intent.publicationIntent);
      const recovering =
        path === "prepare"
          ? h.sender.prepareKommoSenderRetry(h.log.id, "workspace-a")
          : h.service.reprocess(
              "workspace-a",
              h.event.id,
              "guard-owner",
              "platform_admin",
            );
      await overlap.paused.promise;
      expect(overlap.active.has(overlap.recoveryTransaction())).toBe(true);
      response.resolve(
        new Response(
          JSON.stringify({
            events_received: 1,
            messages: [],
            fbtrace_id: "synthetic-trace",
          }),
          { status: 200 },
        ),
      );
      expect(await sending).toMatchObject({ status: "sent" });
      expect(overlap.active.has(overlap.recoveryTransaction())).toBe(true);
      expect(overlap.commits).not.toContain(overlap.recoveryTransaction());
      expect(overlap.commits.length).toBe(3); // Claim, dispatch fence and finalization while recovery stays open.
      expect(h.log.status).toBe("sent");
      expect(intent).toMatchObject({
        publicationStatus: "sent",
        senderLeaseToken: null,
      });
      overlap.resume.resolve();
      expect(await recovering).toEqual(
        path === "prepare" ? "sent" : { status: "queued" },
      );
      expect(overlap.unknownWrites).toEqual([{ count: 0 }]);
      expect(intent).toMatchObject({
        publicationStatus: "sent",
        publicationErrorCode: null,
        senderAttempts: 1,
        senderRetryable: false,
        senderLeaseToken: null,
      });
      expect(intent.publicationIntent).toEqual(target);
      if (path === "manual")
        expect(h.state.auditLog.at(-1)).toMatchObject({
          actorUserId: "guard-owner",
          actorType: "platform_admin",
          resultStatus: "success",
        });
      expect(
        await (h.service as any).publishIntent(structuredClone(intent)),
      ).toBe("sent");
      expect(
        await h.sender.sendReadyEvent(h.log.id, { workspaceId: "workspace-a" }),
      ).toMatchObject({ status: "skipped" });
      expect(h.fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(["terminal", "unknown"])(
    "CAS loss rereads a concurrent %s sender outcome and grants no second dispatch",
    async (kind) => {
      const h = await sendingHarness();
      const overlap = overlapUnknownDecision(h);
      const dispatched = deferred();
      const response = deferred<Response>();
      h.fetcher.mockImplementationOnce(async () => {
        dispatched.resolve();
        return response.promise;
      });
      const sending = h.sender.sendReadyEvent(h.log.id, {
        workspaceId: "workspace-a",
      });
      await dispatched.promise;
      const recovering = h.sender.prepareKommoSenderRetry(
        h.log.id,
        "workspace-a",
      );
      await overlap.paused.promise;
      if (kind === "unknown")
        response.reject(new Error("synthetic accepted then response lost"));
      else response.resolve(new Response("{}", { status: 400 }));
      expect(await sending).toMatchObject({ status: "error" });
      expect(overlap.active.has(overlap.recoveryTransaction())).toBe(true);
      overlap.resume.resolve();
      expect(await recovering).toBe(
        kind === "unknown" ? "delivery_unknown" : "error",
      );
      expect(overlap.unknownWrites).toEqual([{ count: 0 }]);
      const intent = h.state.kommoConversionDedupe[0];
      expect(intent.publicationStatus).toBe(
        kind === "unknown" ? "delivery_unknown" : "publication_failed",
      );
      expect(Boolean(intent.senderLeaseToken)).toBe(kind === "unknown");
      expect(
        await h.sender.sendReadyEvent(h.log.id, { workspaceId: "workspace-a" }),
      ).toMatchObject({ status: "skipped" });
      expect(h.fetcher).toHaveBeenCalledOnce();
    },
  );

  it("unknown publication stays fenced after a year with no enqueue or claim reset", async () => {
    const h = await sendingHarness();
    h.fetcher.mockRejectedValueOnce(
      new Error("synthetic accepted then response lost"),
    );
    await h.sender.sendReadyEvent(h.log.id, { workspaceId: "workspace-a" });
    const intent = h.state.kommoConversionDedupe[0];
    const claim = intent.senderLeaseToken;
    h.conversionQueue.retrySend.mockClear();
    h.queue.enqueue.mockClear();
    h.advance(365 * 24 * 60 * 60 * 1000);
    expect(
      await (h.service as any).publishIntent(structuredClone(intent)),
    ).toBe("delivery_unknown");
    await (h.service as any).reconcileRecoverableEvents();
    expect(
      await h.service.reprocess("workspace-a", h.event.id, "guard-owner"),
    ).toMatchObject({ status: "blocked" });
    expect(intent).toMatchObject({
      publicationStatus: "delivery_unknown",
      senderLeaseToken: claim,
      senderAttempts: 1,
      senderRetryable: false,
    });
    expect(h.conversionQueue.retrySend).not.toHaveBeenCalled();
    expect(h.queue.enqueue).not.toHaveBeenCalled();
    expect(h.fetcher).toHaveBeenCalledOnce();
  });

  it("manual sent convergence and its audit roll back together on audit failure", async () => {
    const h = await sendingHarness();
    await h.sender.sendReadyEvent(h.log.id, { workspaceId: "workspace-a" });
    Object.assign(h.state.kommoConversionDedupe[0], {
      publicationStatus: "delivery_unknown",
      publicationErrorCode: "kommo_delivery_unknown",
    });
    const snapshot = structuredClone(h.state);
    h.queue.enqueue.mockClear();
    h.prisma.auditLog.create.mockRejectedValueOnce(
      new Error("synthetic audit failure"),
    );
    await expect(
      h.service.reprocess("workspace-a", h.event.id, "guard-owner"),
    ).rejects.toThrow("synthetic audit failure");
    expect(h.state).toEqual(snapshot);
    expect(h.queue.enqueue).not.toHaveBeenCalled();
    expect(h.fetcher).toHaveBeenCalledOnce();
  });

  it.each(["prepare", "manual", "publish", "reconcile"])(
    "%s repairs an existing stale unknown using a confirmed log without dispatch",
    async (path) => {
      const h = await sendingHarness();
      await h.sender.sendReadyEvent(h.log.id, { workspaceId: "workspace-a" });
      const intent = h.state.kommoConversionDedupe[0];
      Object.assign(intent, {
        publicationStatus: "delivery_unknown",
        publicationErrorCode: "kommo_delivery_unknown",
      });
      h.event.status = "blocked";
      h.event.errorCode = "kommo_delivery_unknown";
      h.conversionQueue.retrySend.mockClear();
      if (path === "prepare")
        expect(
          await h.sender.prepareKommoSenderRetry(h.log.id, "workspace-a"),
        ).toBe("sent");
      if (path === "manual")
        expect(
          await h.service.reprocess("workspace-a", h.event.id, "guard-owner"),
        ).toEqual({ status: "queued" });
      if (path === "publish")
        expect(
          await (h.service as any).publishIntent(structuredClone(intent)),
        ).toBe("sent");
      if (path === "reconcile") {
        h.advance(100_000);
        await (h.service as any).reconcileRecoverableEvents();
      }
      expect(intent).toMatchObject({
        publicationStatus: "sent",
        publicationErrorCode: null,
        senderAttempts: 1,
      });
      const read = (await h.service.listEvents("workspace-a", h.connection.id))
        .events[0];
      expect(read.errorCode).toBeNull();
      expect(read.results[0]).toMatchObject({
        senderStatus: "sent",
        publicationStatus: "sent",
        publicationErrorCode: null,
      });
      expect(h.conversionQueue.retrySend).not.toHaveBeenCalled();
      expect(h.fetcher).toHaveBeenCalledOnce();
    },
  );

  it("the read model clears stale unknown errors even before durable repair", async () => {
    const h = await sendingHarness();
    await h.sender.sendReadyEvent(h.log.id, { workspaceId: "workspace-a" });
    Object.assign(h.state.kommoConversionDedupe[0], {
      publicationStatus: "delivery_unknown",
      publicationErrorCode: "kommo_delivery_unknown",
    });
    Object.assign(h.event, {
      status: "blocked",
      errorCode: "kommo_delivery_unknown",
    });
    expect(
      (await h.service.listEvents("workspace-a", h.connection.id)).events[0],
    ).toMatchObject({
      status: "sent",
      errorCode: null,
      results: [
        expect.objectContaining({
          publicationStatus: "sent",
          publicationErrorCode: null,
        }),
      ],
    });
  });
});
