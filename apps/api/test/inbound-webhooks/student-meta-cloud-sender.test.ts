import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studentReplayFixture } from "../support/student-replay-fixture";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import { MetaCapiAdapter } from "../../src/conversion-events/meta-capi.adapter";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";

// Real replay services + CAPI adapter; persistence and provider fetch are synthetic.
// PK conflicts model PostgreSQL uniqueness, not a PostgreSQL integration run.
async function senderFixture(mode: "production" | "replay" = "replay") {
  const h = studentReplayFixture();
  const encryption = new MetaTokenEncryptionService({
    META_TOKEN_ENCRYPTION_KEY: "fixture-key",
  });
  let accessToken = "synthetic-capi-token";
  h.business.credential = {
    ...h.business.credential,
    id: "credential",
    fingerprint: "original",
    updatedAt: new Date(),
    expiresAt: null,
    ...encryption.encrypt(accessToken),
  } as any;
  const readBusinesses =
    h.prisma.metaBusinessConnection.findMany.getMockImplementation()!;
  h.prisma.metaBusinessConnection.findMany.mockImplementation(
    async (args: any) =>
      (await readBusinesses(args)).map((b: any) => {
        const { encryptedAccessToken, tokenIv, tokenTag, ...credential } =
          b.credential;
        return { ...b, credential };
      }),
  );
  let batchId: string | undefined;
  if (mode === "replay") {
    batchId = (await h.authorize()).batchId;
    await h.replay.processBatch({ workspaceId: "ws", batchId });
  } else {
    h.delivery.firstReceivedAt = new Date();
    await h.production.processItem({
      workspaceId: "ws",
      productionItemId: "item",
    });
  }
  const log = h.logs[0];
  expect(log?.sourceTrigger).toBe("inbound_webhook:meta_cloud");
  Object.assign(log, { eventOccurredAt: h.event.occurredAt, sentAt: null });
  h.prisma.conversionEventLog.findUnique.mockImplementation(
    async ({ where }: any) =>
      structuredClone(h.logs.find((l) => l.id === where.id) ?? null),
  );
  const findLog =
    h.prisma.conversionEventLog.findFirst.getMockImplementation()!;
  h.prisma.conversionEventLog.findFirst.mockImplementation(async (args: any) =>
    structuredClone(await findLog(args)),
  );
  Object.assign(h.prisma, {
    providerConversionRuleExecution: { findFirst: vi.fn(async () => null) },
    integrationLog: { create: vi.fn(async () => ({ id: "integration-log" })) },
    diagnosticEvent: { create: vi.fn(async () => ({ id: "diagnostic" })) },
    purchaseReview: { updateMany: vi.fn(async () => ({ count: 0 })) },
  });
  const fetcher = vi.fn<typeof fetch>(
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

  h.prisma.metaReportingAccountDestination = {
    findMany: vi.fn(async () => [
      { active: true, conversionDestinationId: "dest" },
    ]),
  };
  h.prisma.$queryRaw.mockImplementation(async (query: any) => {
    const sql = query.sql ?? query.join?.("") ?? "";
    return sql.includes('SELECT "connectionId"')
      ? [structuredClone(h.event)]
      : [];
  });
  const resolver = {
    resolveCapiRoute: vi.fn(async () => ({
      source: "manual",
      accessToken,
      businessConnectionId: "bm",
      conversionDestinationId: "dest",
      reportingAccountId: "account-1",
      adAccountId: "act-1",
      pixelId: "pixel",
      pageId: "page",
    })),
  };
  const buildSender = () =>
    new ConversionEventsService(
      h.prisma,
      new MetaCapiAdapter({}, fetcher),
      new MetaTokenEncryptionService({
        META_TOKEN_ENCRYPTION_KEY: "fixture-key",
      }),
      resolver as never,
      h.license as never,
      h.env,
    );
  const send = () =>
    buildSender().sendReadyEvent(log.id, { workspaceId: "ws" });
  return {
    ...h,
    log,
    batchId,
    fetcher,
    resolver,
    send,
    setToken: (token: string) => {
      accessToken = token;
      Object.assign(h.business.credential, encryption.encrypt(token));
    },
  };
}
afterEach(() => vi.restoreAllMocks());
describe("persistent Meta Cloud one-dispatch fence", () => {
  it.each(["production", "replay"] as const)(
    "dispatches %s once under concurrent workers and restart, preserving CAPI identity",
    async (mode) => {
      const h = await senderFixture(mode);
      const results = await Promise.all([h.send(), h.send()]);
      expect(results.map((r) => r.status).sort()).toEqual(["sent", "skipped"]);
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      expect(
        h.audits.filter((a) => a.action === "inbound_webhook.dispatch.claim"),
      ).toEqual([
        expect.objectContaining({
          id: `inbound-meta-dispatch:${h.log.id}`,
          resultStatus: "sent",
        }),
      ]);
      const payload = JSON.parse(String(h.fetcher.mock.calls[0][1]?.body))
        .data[0];
      expect(payload).toMatchObject({
        event_name: "LeadSubmitted",
        event_id: h.log.eventId,
        user_data: { page_id: "page", ctwa_clid: "synthetic-clid" },
        custom_data: { ad_id: "ad-1" },
      });
      if (h.batchId)
        expect(
          await h.replay.getStudentReplayResult(
            h.actor,
            "connection",
            "channel",
            h.batchId,
          ),
        ).toMatchObject({ state: "delivered", delivered: 1 });
      h.log.status = "ready_to_send"; // A legacy diagnostic reopening cannot clear the permanent fence.
      expect(await h.send()).toMatchObject({ status: "skipped" });
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("fences a network timeout, reports UNKNOWN and never retries after repair", async () => {
    const h = await senderFixture();
    h.addEvent(2);
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    h.fetcher.mockImplementationOnce(async (_url, request) => {
      expect(request?.signal).toBe(controller.signal);
      queueMicrotask(() => controller.abort());
      return new Promise<Response>(() => undefined);
    });
    expect(await h.send()).toMatchObject({
      status: "error",
      errorCode: "MetaCapiDeliveryUnknown",
    });
    expect(
      await h.replay.getStudentReplayResult(
        h.actor,
        "connection",
        "channel",
        h.batchId!,
      ),
    ).toMatchObject({ state: "delivery_unknown", unknown: 1, delivered: 0 });
    expect((await h.preview()).canSendRemaining).toBe(false);
    h.log.status = "ready_to_send";
    h.setToken("repaired-token");
    expect(await h.send()).toMatchObject({ status: "skipped" });
    await expect(h.authorize("remaining")).rejects.toThrow();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("fences a timeout while reading an HTTP 200 acknowledgement and denies remaining", async () => {
    const h = await senderFixture();
    h.addEvent(2);
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const response = new Response("{}", { status: 200 });
    vi.spyOn(response, "json").mockImplementation(() => {
      queueMicrotask(() => controller.abort());
      return new Promise(() => undefined);
    });
    h.fetcher.mockResolvedValueOnce(response);
    expect(await h.send()).toMatchObject({
      status: "error",
      errorCode: "MetaCapiDeliveryUnknown",
    });
    expect(
      await h.replay.getStudentReplayResult(
        h.actor,
        "connection",
        "channel",
        h.batchId!,
      ),
    ).toMatchObject({ state: "delivery_unknown", unknown: 1, delivered: 0 });
    expect((await h.preview()).canSendRemaining).toBe(false);
    await expect(h.authorize("remaining")).rejects.toThrow();
    expect(await h.send()).toMatchObject({ status: "skipped" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["empty", "{}"],
    [
      "zero",
      JSON.stringify({
        events_received: 0,
        messages: [],
        fbtrace_id: "synthetic",
      }),
    ],
    [
      "missing count",
      JSON.stringify({ messages: [], fbtrace_id: "synthetic" }),
    ],
    [
      "string count",
      JSON.stringify({
        events_received: "1",
        messages: [],
        fbtrace_id: "synthetic",
      }),
    ],
    [
      "two events",
      JSON.stringify({
        events_received: 2,
        messages: [],
        fbtrace_id: "synthetic",
      }),
    ],
    ["invalid JSON", "{"],
    ["empty body", ""],
    [
      "error body",
      JSON.stringify({
        events_received: 1,
        messages: [],
        fbtrace_id: "synthetic",
        error: { message: "private provider details" },
      }),
    ],
    [
      "invalid messages",
      JSON.stringify({
        events_received: 1,
        messages: {},
        fbtrace_id: "synthetic",
      }),
    ],
    ["missing trace", JSON.stringify({ events_received: 1, messages: [] })],
  ])(
    "fails closed on HTTP 200 %s through adapter, canary and remaining authorization",
    async (_case, body) => {
      const h = await senderFixture();
      h.addEvent(2);
      h.fetcher.mockResolvedValueOnce(new Response(body, { status: 200 }));
      expect(await h.send()).toMatchObject({
        status: "error",
        errorCode: "MetaCapiDeliveryUnknown",
      });
      expect(
        await h.replay.getStudentReplayResult(
          h.actor,
          "connection",
          "channel",
          h.batchId!,
        ),
      ).toMatchObject({ state: "delivery_unknown", unknown: 1, delivered: 0 });
      expect((await h.preview()).canSendRemaining).toBe(false);
      await expect(h.authorize("remaining")).rejects.toThrow();
      h.log.status = "ready_to_send";
      expect(await h.send()).toMatchObject({ status: "skipped" });
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      expect(
        JSON.stringify(h.prisma.integrationLog.create.mock.calls),
      ).not.toContain("private provider details");
    },
  );
  it("keeps the committed claim after a crash persisting the provider response", async () => {
    const h = await senderFixture();
    h.prisma.conversionEventLog.update.mockRejectedValueOnce(
      new Error("synthetic write crash"),
    );
    await expect(h.send()).rejects.toThrow("synthetic write crash");
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(
      h.audits.find((a) => a.action === "inbound_webhook.dispatch.claim")
        .resultStatus,
    ).toBe("dispatch_started");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20_001);
    expect(
      await h.replay.getStudentReplayResult(
        h.actor,
        "connection",
        "channel",
        h.batchId!,
      ),
    ).toMatchObject({ state: "delivery_unknown", delivered: 0 });
    expect(await h.send()).toMatchObject({ status: "skipped" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not consume a claim on preflight credential failure, so an explicit configuration repair can send once", async () => {
    const h = await senderFixture();
    h.setToken("");
    expect(await h.send()).toMatchObject({ status: "not_configured" });
    expect(h.log.errorCode).toBe("MissingAccessToken");
    expect(
      h.audits.some((a) => a.action === "inbound_webhook.dispatch.claim"),
    ).toBe(false);
    expect(h.fetcher).not.toHaveBeenCalled();
    h.setToken("restored-token");
    h.log.status = "ready_to_send";
    expect(await h.send()).toMatchObject({ status: "sent" });
    expect(await h.send()).toMatchObject({ status: "skipped" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    "route",
    "credential rotation",
    "owner",
    "workspace",
    "channel",
    "license",
    "flag",
    "signing secret",
    "destination",
  ])(
    "revalidates %s after materialization and before dispatch",
    async (reason) => {
      const h = await senderFixture();
      if (reason === "route") h.route.active = false;
      if (reason === "credential rotation")
        (h.business.credential as any).fingerprint = "changed";
      if (reason === "owner") h.owner.role = "admin";
      if (reason === "workspace") h.event.workspaceId = "foreign";
      if (reason === "channel") h.channel.status = "paused";
      if (reason === "license")
        h.license.getLockState.mockResolvedValue({
          inert: false,
          locked: true,
        });
      if (reason === "flag") h.env.INBOUND_WEBHOOK_REPLAY_ENABLED = "false";
      if (reason === "signing secret") h.env.META_APP_SECRET = "";
      if (reason === "destination") h.destination.pageId = "changed";
      expect(await h.send()).toMatchObject({ status: "skipped" });
      expect(h.fetcher).not.toHaveBeenCalled();
      expect(
        h.audits.some((a) => a.action === "inbound_webhook.dispatch.claim"),
      ).toBe(false);
    },
  );
  it.each(["owner", "route", "credential", "log identity"])(
    "catches %s changes between the durable claim and fetch, leaving the fence closed",
    async (reason) => {
      const h = await senderFixture();
      const create = h.prisma.auditLog.create.getMockImplementation()!;
      h.prisma.auditLog.create.mockImplementation(async (args: any) => {
        const row = await create(args);
        if (args.data.action === "inbound_webhook.dispatch.claim") {
          if (reason === "owner") h.owner.role = "admin";
          if (reason === "route") h.route.active = false;
          if (reason === "credential") h.setToken("changed-after-claim");
          if (reason === "log identity") h.log.ctwaClid = "changed-click";
        }
        return row;
      });
      expect(await h.send()).toMatchObject({ status: "skipped" });
      expect(h.fetcher).not.toHaveBeenCalled();
      expect(
        h.audits.some((a) => a.action === "inbound_webhook.dispatch.claim"),
      ).toBe(true);
      h.owner.role = "owner";
      h.route.active = true;
      h.setToken("synthetic-capi-token");
      expect(await h.send()).toMatchObject({ status: "skipped" });
      expect(h.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(["owner", "route", "channel", "credential"])(
    "denies deferred %s mutation after prior reads and before final lock/read (synthetic scheduling only)",
    async (reason) => {
      const h = await senderFixture();
      let reached!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((r) => {
        reached = r;
      });
      const paused = new Promise<void>((r) => {
        resume = r;
      });
      const raw = h.prisma.$queryRaw.getMockImplementation()!;
      h.prisma.$queryRaw.mockImplementation(
        async (query: any, ...values: any[]) => {
          const sql = query.sql ?? query.join?.("") ?? "";
          if (
            sql.includes('FROM "Workspace"') &&
            h.audits.some((a) => a.action === "inbound_webhook.dispatch.claim")
          ) {
            reached();
            await paused;
          }
          return raw(query, ...values);
        },
      );
      const sending = h.send();
      await entered;
      expect(h.resolver.resolveCapiRoute).toHaveBeenCalled();
      expect(
        h.audits.some((a) => a.action === "inbound_webhook.dispatch.claim"),
      ).toBe(true);
      expect(h.fetcher).not.toHaveBeenCalled();
      if (reason === "owner") h.owner.role = "admin";
      if (reason === "route") h.route.active = false;
      if (reason === "channel") h.channel.status = "paused";
      if (reason === "credential") h.setToken("rotated-after-prior-read");
      resume();
      expect(await sending).toMatchObject({ status: "skipped" });
      expect(h.fetcher).not.toHaveBeenCalled();
      expect(await h.send()).toMatchObject({ status: "skipped" });
    },
  );
  it("keeps the committed claim and releases the dispatch transaction while fetch is pending", async () => {
    const h = await senderFixture();
    let entered!: () => void;
    let resume!: (r: Response) => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    let transactionOpen = false;
    const transaction = h.prisma.$transaction.getMockImplementation()!;
    h.prisma.$transaction.mockImplementation((fn: any) =>
      transaction(async (tx: any) => {
        transactionOpen = true;
        try {
          return await fn(tx);
        } finally {
          transactionOpen = false;
        }
      }),
    );
    h.fetcher.mockImplementationOnce(() => {
      expect(transactionOpen).toBe(true);
      expect(
        h.audits.some((a) => a.action === "inbound_webhook.dispatch.claim"),
      ).toBe(true);
      entered();
      return new Promise<Response>((r) => {
        resume = r;
      });
    });
    const sending = h.send();
    await started;
    await h.prisma.$transaction(async () => undefined);
    expect(transactionOpen).toBe(false);
    expect(await h.send()).toMatchObject({ status: "skipped" });
    resume(
      new Response(
        JSON.stringify({
          events_received: 1,
          messages: [],
          fbtrace_id: "synthetic",
        }),
        { status: 200 },
      ),
    );
    expect(await sending).toMatchObject({ status: "sent" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite a confirmed send with a stale concurrent preflight failure", async () => {
    const h = await senderFixture();
    const original = h.resolver.resolveCapiRoute.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.resolver.resolveCapiRoute.mockImplementationOnce(async () => {
      const route = await original();
      entered();
      await paused;
      return { ...route, accessToken: "" };
    });
    const stale = h.send();
    await ready;
    expect(await h.send()).toMatchObject({ status: "sent" });
    release();
    expect(await stale).toMatchObject({ status: "skipped" });
    expect(h.log).toMatchObject({ status: "sent", sentAt: expect.any(Date) });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("reports a bounded in-flight send as processing, polls its confirmation and never unlocks remaining early", async () => {
    const h = await senderFixture();
    h.addEvent(2);
    let release!: (response: Response) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.fetcher.mockImplementationOnce(async () => {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const sending = h.send();
    await entered;
    expect(
      await h.replay.getStudentReplayResult(
        h.actor,
        "connection",
        "channel",
        h.batchId!,
      ),
    ).toMatchObject({ state: "processing", delivered: 0 });
    expect((await h.preview()).canSendRemaining).toBe(false);
    release(
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
    expect(
      await h.replay.getStudentReplayResult(
        h.actor,
        "connection",
        "channel",
        h.batchId!,
      ),
    ).toMatchObject({ state: "delivered", delivered: 1 });
    expect((await h.preview()).canSendRemaining).toBe(true);
    expect(await h.authorize("remaining")).toMatchObject({
      batchId: expect.any(String),
    });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
});
