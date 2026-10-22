import { hashPhoneIdentity } from "../src/common/phone/phone-identity";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  conversionEventNameSchema,
  conversionEventRequiresValue,
  conversionEventCarriesValue,
} from "@wpptrack/shared";
import {
  observationHarness,
  payload,
  ruleInput,
} from "./support/pipedrive-observation-harness";
import { actor, deferred } from "./support/pipedrive-harness";
import { PipedriveAdapterError } from "../src/pipedrive/pipedrive.adapter";

beforeEach(() => {
  vi.stubEnv(
    "PIPEDRIVE_CRM_ENCRYPTION_KEY",
    Buffer.alloc(32, 7).toString("base64"),
  );
  vi.stubEnv("API_PUBLIC_URL", "https://api.synthetic.example.invalid");
});
afterEach(() => vi.unstubAllEnvs());
async function setup() {
  const h = observationHarness();
  const c = await h.seed();
  const issued = await h.webhooks.rotateSecret("workspace-a", c.id, actor);
  const token = new URL(issued.webhookUrl).searchParams.get("token")!;
  await h.webhooks.createRule("workspace-a", c.id, actor, ruleInput);
  const receive = (body = payload(h.now), secret = token) =>
    h.webhooks.receive(c.id, secret, body, "application/json");
  const event = () => h.state.pipedriveWebhookEvent![0]!;
  return { ...h, c, token, issued, receive, event };
}
describe("Pipedrive durable observation (simulated PostgreSQL, synthetic provider)", () => {
  it("delivers the real URL once, stores only the hash, and splits receipt from processing", async () => {
    const h = await setup();
    expect(h.issued.webhookUrl).toContain(h.token);
    expect(JSON.stringify(h.state)).not.toContain(h.token);
    expect(await h.receive()).toEqual({ status: "accepted" });
    expect(h.adapter.getPerson).not.toHaveBeenCalled();
    await h.webhooks.process(h.event().id, "workspace-a");
    expect(h.event()).toMatchObject({
      status: "observed",
      matchedLeadId: "lead-a",
      results: [
        {
          eventName: "QualifiedLead",
          status: "observed",
          valueCents: null,
          currency: null,
        },
      ],
    });
    expect(h.state.pipedriveConversionDedupe).toHaveLength(1);
    expect(h.client.lead.create).not.toHaveBeenCalled();
    expect(h.client.conversionEventLog.create).not.toHaveBeenCalled();
    const persisted = JSON.stringify(
      [h.state.pipedriveWebhookEvent, h.state.auditLog],
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    expect(persisted).not.toContain("5500000000000");
    expect(persisted).not.toContain(h.token);
  });
  it.each(["invalid", "array", "rotated", "revoked", "paused", "missing"])(
    "fails closed for %s authentication",
    async (kind) => {
      const h = await setup();
      let token: any = h.token;
      let id = h.c.id;
      if (kind === "invalid") token = "x";
      if (kind === "array") token = [h.token];
      if (kind === "rotated")
        await h.webhooks.rotateSecret("workspace-a", id, actor);
      if (kind === "revoked")
        await h.webhooks.revokeSecret("workspace-a", id, actor);
      if (kind === "paused")
        await h.service.setStatus("workspace-a", id, actor, "paused");
      if (kind === "missing") id = "foreign-id";
      await expect(
        h.webhooks.receive(id, token, payload(h.now), "application/json"),
      ).rejects.toMatchObject({ status: 404 });
      expect(h.state.pipedriveWebhookEvent).toHaveLength(0);
      expect(h.adapter.getPerson).not.toHaveBeenCalled();
    },
  );
  it.each(["oversize", "invalid", "prototype", "encoding", "non-json"])(
    "bounds %s payloads",
    async (kind) => {
      const h = await setup();
      let body = payload(h.now);
      let ct = "application/json";
      if (kind === "oversize") body = Buffer.alloc(102401);
      if (kind === "invalid") body = Buffer.from("{");
      if (kind === "prototype") body = Buffer.from('{"__proto__":{}}');
      if (kind === "encoding") body = Buffer.from([0xff]);
      if (kind === "non-json") ct = "text/plain";
      await expect(
        h.webhooks.receive(h.c.id, h.token, body, ct),
      ).rejects.toMatchObject({ status: 400 });
      expect(h.state.pipedriveWebhookEvent).toHaveLength(0);
    },
  );
  it.each(["company", "host", "missing-account", "old", "future"])(
    "rejects %s identity/timestamp",
    async (kind) => {
      const h = await setup();
      const b = JSON.parse(payload(h.now).toString());
      if (kind === "company") b.meta.company_id = 2;
      if (kind === "host") b.meta.host = "foreign.pipedrive.com";
      if (kind === "missing-account") delete b.meta.company_id;
      if (kind === "old")
        b.meta.timestamp = new Date(+h.now - 86400000 * 8).toISOString();
      if (kind === "future")
        b.meta.timestamp = new Date(+h.now + 300001).toISOString();
      await expect(
        h.receive(Buffer.from(JSON.stringify(b))),
      ).rejects.toMatchObject({ status: 400 });
      expect(h.state.pipedriveWebhookEvent).toHaveLength(0);
    },
  );
  it("idempotently persists concurrent duplicate receipts and processing", async () => {
    const h = await setup();
    await Promise.all([h.receive(), h.receive()]);
    expect(h.state.pipedriveWebhookEvent).toHaveLength(1);
    await Promise.all([
      h.webhooks.process(h.event().id, "workspace-a"),
      h.webhooks.process(h.event().id, "workspace-a"),
    ]);
    expect(h.adapter.getPerson).toHaveBeenCalledTimes(1);
    expect(h.state.pipedriveConversionDedupe).toHaveLength(1);
  });
  it.each([
    "phone-missing",
    "phone-ambiguous",
    "person-missing",
    "person-mismatch",
    "lead-missing",
    "foreign-lead",
    "channel",
    "ambiguous-route",
  ])("audits ignored %s without lead creation", async (kind) => {
    const h = await setup();
    const b = JSON.parse(payload(h.now).toString());
    if (kind === "phone-missing")
      h.adapter.getPerson.mockResolvedValue({ id: "1", phones: [] });
    if (kind === "phone-ambiguous") {
      // Ambiguous only when the phones match more than one DISTINCT lead.
      h.adapter.getPerson.mockResolvedValue({
        id: "1",
        phones: ["5500000000000", "5500000000001"],
      });
      h.state.lead!.push({
        ...h.state.lead![0],
        id: "lead-b",
        phoneHash: hashPhoneIdentity("5500000000001"),
      });
    }
    if (kind === "person-missing") b.data.person_id = null;
    if (kind === "person-mismatch")
      h.adapter.getPerson.mockResolvedValue({
        id: "2",
        phones: ["5500000000000"],
      });
    if (kind === "lead-missing") h.state.lead = [];
    if (kind === "foreign-lead") h.state.lead![0].workspaceId = "workspace-b";
    if (kind === "channel") h.route.channel.status = "paused";
    if (kind === "ambiguous-route") {
      h.state.pipedriveConnection![0].allowedChannelRouteIds.push("route-b");
      const original =
        h.client.inboundWebhookChannelRoute.findFirst.getMockImplementation();
      h.client.inboundWebhookChannelRoute.findFirst.mockImplementation(
        async (args: any) =>
          args.where.id === "route-b"
            ? { ...h.route, id: "route-b" }
            : original(args),
      );
    }
    await h.receive(Buffer.from(JSON.stringify(b)));
    await h.webhooks.process(h.event().id, "workspace-a");
    expect(h.event().status).toBe("ignored");
    expect(h.event().errorCode).toBeTruthy();
    expect(h.state.pipedriveConversionDedupe).toHaveLength(0);
    expect(h.client.lead.create).not.toHaveBeenCalled();
    expect(h.state.auditLog!.at(-1).action).toBe("pipedrive.webhook_processed");
  });
  it.each(conversionEventNameSchema.options)(
    "supports %s independently of WhatsApp keywords",
    async (eventName) => {
      const h = await setup();
      await h.webhooks.removeRule(
        "workspace-a",
        h.c.id,
        h.state.pipedriveConversionRule![0].id,
        actor,
      );
      h.state.conversionRule!.push({
        id: "keyword",
        workspaceId: "workspace-a",
        triggerType: "message_phrase",
        eventName: "Purchase",
        phrase: "synthetic phrase",
      });
      const keywords = structuredClone(h.state.conversionRule);
      await h.webhooks.createRule("workspace-a", h.c.id, actor, {
        ...ruleInput,
        eventName,
        ...(conversionEventCarriesValue(eventName) ? { currency: "BRL" } : {}),
      });
      await h.receive();
      await h.webhooks.process(h.event().id, "workspace-a");
      expect(h.event().results[0]).toMatchObject({
        eventName,
        status: "observed",
      });
      expect(h.state.conversionRule).toEqual(keywords);
      expect(h.client.conversionEventLog.create).not.toHaveBeenCalled();
    },
  );
  it.each([
    "stale-catalog",
    "unselected",
    "unchanged",
    "generation",
    "rotation",
    "crossworkspace",
  ])("ignores or isolates %s", async (kind) => {
    const h = await setup();
    const b = JSON.parse(payload(h.now).toString());
    if (kind === "unchanged") b.previous.stage_id = 11;
    if (kind === "unselected") {
      b.data.stage_id = 12;
      b.previous.stage_id = 13;
    }
    await h.receive(Buffer.from(JSON.stringify(b)));
    if (kind === "unchanged") {
      // A stage that did not change is not a transition: accepted, not stored.
      expect(h.state.pipedriveWebhookEvent).toHaveLength(0);
      expect(h.adapter.getPerson).not.toHaveBeenCalled();
      return;
    }
    if (kind === "stale-catalog")
      h.state.pipedriveConnection![0].catalogState = "stale";
    if (kind === "generation")
      h.state.pipedriveConnection![0].credentialGeneration++;
    if (kind === "rotation")
      await h.webhooks.rotateSecret("workspace-a", h.c.id, actor);
    const result = await h.webhooks.process(
      h.event().id,
      kind === "crossworkspace" ? "workspace-b" : "workspace-a",
    );
    if (kind === "crossworkspace")
      expect(result.status).toBe("missing_or_complete");
    else expect(h.event().status).toBe("ignored");
    expect(h.adapter.getPerson).not.toHaveBeenCalled();
    expect(h.state.pipedriveConversionDedupe).toHaveLength(0);
  });
  it("recovers durable retries after upstream failure, without provider error leakage", async () => {
    const h = await setup();
    await h.receive();
    h.adapter.getPerson.mockRejectedValueOnce(
      new PipedriveAdapterError("pipedrive_rate_limited"),
    );
    await h.webhooks.process(h.event().id, "workspace-a");
    expect(h.event()).toMatchObject({
      status: "retry",
      errorCode: "pipedrive_rate_limited",
      attempts: 1,
    });
    h.setNow(new Date(+h.now + 30001));
    await h.webhooks.sweep();
    expect(h.event()).toMatchObject({ status: "observed", attempts: 2 });
  });
  it("rejects stale in-flight credential results", async () => {
    const h = await setup();
    await h.receive();
    const wait = deferred<{ id: string; phones: string[] }>();
    h.adapter.getPerson.mockImplementationOnce(() => wait.promise);
    const run = h.webhooks.process(h.event().id, "workspace-a");
    await vi.waitFor(() => expect(h.adapter.getPerson).toHaveBeenCalled());
    h.state.pipedriveConnection![0].credentialGeneration++;
    wait.resolve({ id: "1", phones: ["5500000000000"] });
    await run;
    expect(h.event().status).toBe("ignored");
    expect(h.state.pipedriveConversionDedupe).toHaveLength(0);
  });
  it("stores a redelivery of the same transition (new meta.id/attempt) only once", async () => {
    const h = await setup();
    await h.receive();
    const redelivery = JSON.parse(payload(h.now).toString());
    redelivery.meta.id = "synthetic-redelivery";
    redelivery.meta.attempt = 2;
    await h.receive(Buffer.from(JSON.stringify(redelivery)));
    expect(h.state.pipedriveWebhookEvent).toHaveLength(1);
  });
  it("dedupes separate deliveries for the same verified account/deal/event and ignores older stages", async () => {
    const h = await setup();
    await h.receive();
    await h.webhooks.process(h.event().id, "workspace-a");
    h.setNow(new Date(+h.now + 1000));
    const newer = JSON.parse(payload(h.now).toString());
    newer.meta.id = "synthetic-event-2";
    newer.meta.timestamp = new Date(
      Date.parse(newer.meta.timestamp) + 1000,
    ).toISOString();
    await h.receive(Buffer.from(JSON.stringify(newer)));
    await h.webhooks.process(
      h.state.pipedriveWebhookEvent![1].id,
      "workspace-a",
    );
    expect(h.state.pipedriveWebhookEvent![1].status).toBe("duplicate");
    expect(h.state.pipedriveConversionDedupe).toHaveLength(1);
    const older = JSON.parse(payload(new Date(+h.now - 500)).toString());
    older.meta.id = "synthetic-event-3";
    older.meta.timestamp = new Date(
      Date.parse(older.meta.timestamp) + 0,
    ).toISOString();
    await h.receive(Buffer.from(JSON.stringify(older)));
    await h.webhooks.process(
      h.state.pipedriveWebhookEvent![2].id,
      "workspace-a",
    );
    expect(h.state.pipedriveWebhookEvent![2].errorCode).toBe("out_of_order");
  });
});

describe("Pipedrive rules, ingress and recovery boundaries", () => {
  it.each([
    ["Purchase", "deal", 0, "BRL", "BRL", "ignored", null],
    ["Purchase", "deal", 12.5, "BRL", "USD", "ignored", null],
    ["Purchase", "deal", 12.5, "BRL", "BRL", "observed", 1250],
    ["Purchase", "fixed", 0, "USD", "BRL", "observed", 999],
    ["ViewContent", "deal", 0, "BRL", "BRL", "observed", null],
    ["ViewContent", "deal", -5, "BRL", "BRL", "observed", null],
    ["ViewContent", "deal", 12.5, null, "BRL", "observed", 1250],
    // Fase 5.1: negócio e regra sem moeda usam a do workspace (BRL aqui).
    ["ViewContent", "deal", 12.5, null, null, "observed", 1250],
    // Negócio em moeda fora de BRL/USD/EUR nunca vai à Meta.
    ["Purchase", "deal", 12.5, "BRL", "GBP", "ignored", null],
    ["QualifiedLead", "deal", 12.5, null, "BRL", "observed", null],
  ])(
    "evaluates %s/%s value %s (%s/%s)",
    async (
      eventName,
      valueMode,
      value,
      currency,
      sourceCurrency,
      status,
      cents,
    ) => {
      const h = await setup();
      await h.webhooks.removeRule(
        "workspace-a",
        h.c.id,
        h.state.pipedriveConversionRule![0].id,
        actor,
      );
      await h.webhooks.createRule("workspace-a", h.c.id, actor, {
        ...ruleInput,
        eventName,
        valueMode,
        currency,
        ...(valueMode === "fixed" ? { fixedValueCents: 999 } : {}),
      } as any);
      const body = JSON.parse(payload(h.now).toString());
      body.data.value = value;
      body.data.currency = sourceCurrency;
      await h.receive(Buffer.from(JSON.stringify(body)));
      await h.webhooks.process(h.event().id, "workspace-a");
      expect(h.event().results[0]).toMatchObject({ status, valueCents: cents });
      expect(h.client.conversionEventLog.create).not.toHaveBeenCalled();
    },
  );
  it("validates merged PATCH and only the exact workspace/connection catalog", async () => {
    const h = await setup();
    const rule = h.state.pipedriveConversionRule![0];
    await expect(
      h.webhooks.updateRule("workspace-a", h.c.id, rule.id, actor, {
        eventName: "Purchase",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (await h.webhooks.listRules("workspace-a", h.c.id))[0].eventName,
    ).toBe("QualifiedLead");
    const updated = await h.webhooks.updateRule(
      "workspace-a",
      h.c.id,
      rule.id,
      actor,
      {
        eventName: "Purchase",
        currency: "brl" as never, // caixa baixa é normalizada no serviço
        valueMode: "fixed",
        fixedValueCents: 500,
      },
    );
    expect(updated).toMatchObject({
      eventName: "Purchase",
      currency: "BRL",
      fixedValueCents: 500,
    });
    await expect(
      h.webhooks.createRule("workspace-a", h.c.id, actor, {
        ...ruleInput,
        pipelineId: "2",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      h.webhooks.createRule("workspace-a", h.c.id, actor, {
        ...ruleInput,
        eventName: "Purchase",
        mode: "production",
        currency: "BRL",
      } as any),
    ).rejects.toMatchObject({
      status: 409,
      message: "pipedrive_production_disabled",
    });
  });
  it.each([
    "rules",
    "events",
    "rotate",
    "revoke",
    "create",
    "patch",
    "delete",
    "retry",
  ])("isolates %s management targets", async (kind) => {
    const h = await setup();
    const id = h.state.pipedriveConversionRule![0].id;
    const run = () =>
      kind === "rules"
        ? h.webhooks.listRules("workspace-b", h.c.id)
        : kind === "events"
          ? h.webhooks.listEvents("workspace-b", h.c.id)
          : kind === "rotate"
            ? h.webhooks.rotateSecret("workspace-b", h.c.id, actor)
            : kind === "revoke"
              ? h.webhooks.revokeSecret("workspace-b", h.c.id, actor)
              : kind === "create"
                ? h.webhooks.createRule("workspace-b", h.c.id, actor, ruleInput)
                : kind === "patch"
                  ? h.webhooks.updateRule("workspace-b", h.c.id, id, actor, {
                      active: false,
                    })
                  : kind === "delete"
                    ? h.webhooks.removeRule("workspace-b", h.c.id, id, actor)
                    : h.webhooks.retryEvent(
                        "workspace-b",
                        h.c.id,
                        "foreign-event",
                        actor,
                      );
    const before = structuredClone(h.state);
    await expect(run()).rejects.toMatchObject({ status: 404 });
    expect(h.state).toEqual(before);
  });
  it("does not invent a URL when API_PUBLIC_URL is invalid", async () => {
    const h = await setup();
    const before = structuredClone(h.state.pipedriveConnection);
    vi.stubEnv("API_PUBLIC_URL", "");
    await expect(
      h.webhooks.rotateSecret("workspace-a", h.c.id, actor),
    ).rejects.toMatchObject({
      status: 503,
      message: "pipedrive_public_url_invalid",
    });
    expect(h.state.pipedriveConnection).toEqual(before);
  });
  it("fails receipt persistence without accepting delivery or echoing private DB text", async () => {
    const h = await setup();
    h.client.pipedriveWebhookEvent.create.mockRejectedValueOnce(
      new Error("private-token SQL"),
    );
    await expect(h.receive()).rejects.toMatchObject({
      status: 503,
      message: "pipedrive_persistence_failed",
    });
    expect(h.state.pipedriveWebhookEvent).toHaveLength(0);
  });
  it("enforces durable account rate bounds (relevant transitions only) across service instances", async () => {
    const h = await setup();
    h.state.pipedriveConnection![0].webhookRateWindowAt = h.now;
    h.state.pipedriveConnection![0].webhookRateCount = 1200;
    await expect(h.receive()).rejects.toMatchObject({ status: 429 });
    expect(h.state.pipedriveWebhookEvent).toHaveLength(0);
    h.setNow(new Date(+h.now + 60_001));
    await expect(h.receive()).resolves.toEqual({ status: "accepted" });
    expect(h.state.pipedriveWebhookEvent).toHaveLength(1);
  });
  it("never 429s or counts ignored edits, even in a bulk edit burst", async () => {
    const h = await setup();
    h.state.pipedriveConnection![0].webhookRateWindowAt = h.now;
    h.state.pipedriveConnection![0].webhookRateCount = 1200;
    const edit = JSON.parse(payload(h.now).toString());
    edit.previous = { custom_fields: { synthetic: null } };
    for (let i = 0; i < 50; i++)
      await expect(
        h.receive(Buffer.from(JSON.stringify(edit))),
      ).resolves.toEqual({ status: "accepted" });
    expect(h.state.pipedriveWebhookEvent).toHaveLength(0);
    expect(h.state.pipedriveConnection![0].webhookRateCount).toBe(1200);
  });
  it("has no shared pre-auth budget and never locks the connection for a bad token", async () => {
    const h = await setup();
    h.client.$queryRaw.mockClear();
    for (let i = 0; i < 700; i++)
      await expect(h.receive(payload(h.now), "invalid")).rejects.toMatchObject({
        status: 404,
      });
    expect(h.client.$queryRaw).not.toHaveBeenCalled();
    await expect(h.receive()).resolves.toEqual({ status: "accepted" });
  });
  it("receipt telemetry never bumps the configuration revision or updatedAt", async () => {
    const h = await setup();
    const before = structuredClone(h.state.pipedriveConnection![0]);
    await h.receive();
    const edit = JSON.parse(payload(h.now).toString());
    edit.previous = { custom_fields: { synthetic: null } };
    h.setNow(new Date(+h.now + 1000));
    await h.receive(Buffer.from(JSON.stringify(edit)));
    const after = h.state.pipedriveConnection![0];
    expect(after.mutationRevision).toBe(before.mutationRevision);
    expect(+after.updatedAt).toBe(+before.updatedAt);
    expect(+after.webhookLastReceivedAt).toBe(+h.webhooks.now());
    expect(after.webhookRateCount).toBe(1);
  });
  it("reclaims an expired processing lease after restart", async () => {
    const h = await setup();
    await h.receive();
    Object.assign(h.event(), {
      status: "processing",
      leaseToken: "expired",
      leaseExpiresAt: new Date(+h.now - 1),
      nextAttemptAt: null,
      attempts: 1,
    });
    await h.webhooks.sweep();
    expect(h.event()).toMatchObject({
      status: "observed",
      attempts: 2,
      leaseToken: null,
    });
  });
  it("leaves active leases alone and prevents a stale worker from committing", async () => {
    const h = await setup();
    await h.receive();
    const pending = deferred<{ id: string; phones: string[] }>();
    h.adapter.getPerson.mockImplementationOnce(() => pending.promise);
    const processing = h.webhooks.process(h.event().id, "workspace-a");
    await vi.waitFor(() => expect(h.adapter.getPerson).toHaveBeenCalled());
    const lease = h.event().leaseToken;
    await h.webhooks.sweep();
    expect(h.event().leaseToken).toBe(lease);
    h.setNow(new Date(+h.now + 90001));
    await h.webhooks.sweep();
    pending.resolve({ id: "1", phones: ["5500000000000"] });
    await processing;
    expect(h.event()).toMatchObject({ status: "observed", attempts: 2 });
    expect(h.state.pipedriveConversionDedupe).toHaveLength(1);
  });
  it("bounds retries and only allows owner recovery for failed transient errors", async () => {
    const h = await setup();
    await h.receive();
    h.adapter.getPerson.mockRejectedValue(new Error("private-provider-text"));
    for (let i = 0; i < 5; i++) {
      await h.webhooks.sweep();
      if (h.event().nextAttemptAt) h.setNow(new Date(+h.event().nextAttemptAt));
    }
    expect(h.event()).toMatchObject({
      status: "failed",
      attempts: 5,
      errorCode: "pipedrive_transport",
    });
    expect(
      JSON.stringify(await h.webhooks.listEvents("workspace-a", h.c.id)),
    ).not.toContain("private-provider-text");
    h.adapter.getPerson.mockResolvedValue({
      id: "1",
      phones: ["5500000000000"],
    });
    await h.webhooks.retryEvent("workspace-a", h.c.id, h.event().id, actor);
    await h.webhooks.sweep();
    expect(h.event().status).toBe("observed");
    await expect(
      h.webhooks.retryEvent("workspace-a", h.c.id, h.event().id, actor),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("blocks unauthorized credentials without letting stale failures block replacement", async () => {
    const h = await setup();
    await h.receive();
    h.adapter.getPerson.mockRejectedValueOnce(
      new PipedriveAdapterError("pipedrive_unauthorized"),
    );
    await h.webhooks.sweep();
    expect(h.state.pipedriveConnection![0]).toMatchObject({
      credentialHealthy: false,
      status: "blocked",
      lastErrorCode: "pipedrive_unauthorized",
    });
    expect(h.event().status).toBe("ignored");
  });
  it("rolls back dedupe when completing the observation fails", async () => {
    const h = await setup();
    await h.receive();
    const original =
      h.client.pipedriveWebhookEvent.updateMany.getMockImplementation();
    h.client.pipedriveWebhookEvent.updateMany.mockImplementation(
      async (arg: any) => {
        if (arg.data.status === "observed") throw new Error("private SQL");
        return original(arg);
      },
    );
    await expect(
      h.webhooks.process(h.event().id, "workspace-a"),
    ).rejects.toMatchObject({ status: 503 });
    expect(h.state.pipedriveConversionDedupe).toHaveLength(0);
    expect(h.event().status).toBe("processing");
    h.client.pipedriveWebhookEvent.updateMany.mockImplementation(original);
    h.setNow(new Date(+h.now + 90001));
    await h.webhooks.sweep();
    expect(h.event().status).toBe("observed");
    expect(h.state.pipedriveConversionDedupe).toHaveLength(1);
  });
  it("does not erase audited history/dedupe through connection deletion", async () => {
    const h = await setup();
    await h.receive();
    await h.webhooks.sweep();
    await expect(
      h.service.remove("workspace-a", h.c.id, actor),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.state.pipedriveConversionDedupe).toHaveLength(1);
  });
  it("fences a rule disabled during phone lookup", async () => {
    const h = await setup();
    await h.receive();
    const pending = deferred<{ id: string; phones: string[] }>();
    h.adapter.getPerson.mockImplementationOnce(() => pending.promise);
    const run = h.webhooks.process(h.event().id, "workspace-a");
    await vi.waitFor(() => expect(h.adapter.getPerson).toHaveBeenCalled());
    await h.webhooks.updateRule(
      "workspace-a",
      h.c.id,
      h.state.pipedriveConversionRule![0].id,
      actor,
      { active: false },
    );
    pending.resolve({ id: "1", phones: ["5500000000000"] });
    await run;
    expect(h.event().status).toBe("ignored");
    expect(h.state.pipedriveConversionDedupe).toHaveLength(0);
  });
  it("requires strict timestamps even for unchanged stages", async () => {
    const h = await setup();
    const body = JSON.parse(payload(h.now).toString());
    body.previous.stage_id = 11;
    body.meta.timestamp = "2026-02-30T18:00:00Z";
    await expect(
      h.receive(Buffer.from(JSON.stringify(body))),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("Pipedrive final authorization and ordering fences", () => {
  it("fails closed on conflicting stages with the same provider timestamp", async () => {
    const h = await setup();
    await h.receive();
    const conflict = JSON.parse(payload(h.now).toString());
    conflict.meta.id = "synthetic-conflict";
    conflict.data.stage_id = 12;
    conflict.previous.stage_id = 11;
    await h.receive(Buffer.from(JSON.stringify(conflict)));
    await h.webhooks.sweep();
    expect(h.state.pipedriveWebhookEvent!.map((r) => r.errorCode)).toEqual([
      "ordering_ambiguous",
      "ordering_ambiguous",
    ]);
    expect(h.state.pipedriveConversionDedupe).toHaveLength(0);
    expect(h.adapter.getPerson).not.toHaveBeenCalled();
  });
  it("rejects a server-verified cross-account person lookup before fetching the person", async () => {
    const h = await setup();
    await h.receive();
    h.adapter.verify.mockResolvedValueOnce({ id: "2", subdomain: "foreign" });
    await h.webhooks.sweep();
    expect(h.event()).toMatchObject({
      status: "ignored",
      errorCode: "pipedrive_account_mismatch",
    });
    expect(h.adapter.getPerson).not.toHaveBeenCalled();
    expect(h.state.pipedriveConnection![0].credentialHealthy).toBe(false);
  });
  it("rechecks channel authorization after upstream lookup", async () => {
    const h = await setup();
    await h.receive();
    const pending = deferred<{ id: string; phones: string[] }>();
    h.adapter.getPerson.mockImplementationOnce(() => pending.promise);
    const run = h.webhooks.process(h.event().id, "workspace-a");
    await vi.waitFor(() => expect(h.adapter.getPerson).toHaveBeenCalled());
    h.route.channel.status = "paused";
    pending.resolve({ id: "1", phones: ["5500000000000"] });
    await run;
    expect(h.event().errorCode).toBe("lead_channel_route_unauthorized");
    expect(h.state.pipedriveConversionDedupe).toHaveLength(0);
  });
  it("preserves terminal receipts and semantic dedupe after rule replacement", async () => {
    const h = await setup();
    await h.receive();
    await h.webhooks.sweep();
    const oldRule = h.state.pipedriveConversionRule![0];
    await h.webhooks.removeRule("workspace-a", h.c.id, oldRule.id, actor);
    await h.webhooks.createRule("workspace-a", h.c.id, actor, ruleInput);
    h.setNow(new Date(+h.now + 1000));
    const second = JSON.parse(payload(h.now).toString());
    second.meta.id = "synthetic-new-rule";
    second.meta.timestamp = new Date(
      Date.parse(second.meta.timestamp) + 1000,
    ).toISOString();
    await h.receive(Buffer.from(JSON.stringify(second)));
    await h.webhooks.sweep();
    expect(h.state.pipedriveWebhookEvent![1].status).toBe("duplicate");
    expect(h.state.pipedriveConversionDedupe).toHaveLength(1);
  });
  it("retains per-rule outcomes when multiple catalog events share a selected stage", async () => {
    const h = await setup();
    await h.webhooks.createRule("workspace-a", h.c.id, actor, {
      ...ruleInput,
      eventName: "Purchase",
      currency: "BRL",
    });
    const zero = JSON.parse(payload(h.now).toString());
    zero.data.value = 0;
    await h.receive(Buffer.from(JSON.stringify(zero)));
    await h.webhooks.sweep();
    expect(h.event().status).toBe("observed");
    expect(h.event().results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventName: "QualifiedLead",
          status: "observed",
        }),
        expect.objectContaining({
          eventName: "Purchase",
          status: "ignored",
          errorCode: "event_price_missing_or_nonpositive",
        }),
      ]),
    );
    expect(h.state.pipedriveConversionDedupe).toHaveLength(1);
  });
  it("does not accept timestamps predating current credentials", async () => {
    const h = await setup();
    await expect(
      h.receive(payload(new Date(+h.now - 1001))),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.state.pipedriveWebhookEvent).toHaveLength(0);
  });
  it("deactivates rules on a verified account replacement and fences old receipts", async () => {
    const h = await setup();
    await h.receive();
    h.adapter.verify.mockResolvedValue({ id: "2", subdomain: "synthetic" });
    await h.service.replaceCredential("workspace-a", h.c.id, actor, {
      apiToken: "synthetic-new-account-token",
    });
    expect(h.state.pipedriveConversionRule![0].active).toBe(false);
    expect(h.state.pipedriveConnection![0].allowedChannelRouteIds).toEqual([]);
    await h.webhooks.sweep();
    expect(h.event().status).toBe("ignored");
    expect(h.adapter.getPerson).not.toHaveBeenCalled();
  });
});
