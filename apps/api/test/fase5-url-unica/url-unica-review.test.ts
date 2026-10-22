import { describe, expect, it, vi } from "vitest";
import { integrationUnattributedReasonLabel } from "@wpptrack/shared";
import { ProviderConversionObservationService } from "../../src/conversion-rules/provider-conversion-observation.service";
import {
  automationConversionIdentity,
  unnichatAutomationConversionIdentity,
} from "../../src/inbound-webhook-production/provider-conversion-production.service";
import {
  at,
  jeanChannels,
  jeanLeads,
  paytSale,
  umblerAutomation,
  W,
  world,
  type Channel,
  type Rule,
} from "./url-unica-world";

/**
 * Fase 5.3 — findings of the independent review (M1 Umbler number, M2 Payt
 * origin, M3 rule declining a routed callback, and the low ones).
 */

const umblerChannels: Channel[] = [
  { id: "umb_x", connectionId: "conn_umbler", provider: "umbler", phone: "5511900001111" },
  { id: "umb_y", connectionId: "conn_umbler", provider: "umbler", phone: "5511900002222" },
];
const umblerRules: Rule[] = [
  {
    id: "umbler_global",
    provider: "umbler",
    eventName: "QualifiedLead",
    scope: "all_numbers",
    connectionId: "conn_umbler",
    channelIds: [],
  },
  {
    id: "umbler_x",
    provider: "umbler",
    eventName: "QualifiedLead",
    scope: "specific_numbers",
    connectionId: "conn_umbler",
    channelIds: ["umb_x"],
  },
];

describe("M1 — Umbler: the rule decides on the number the URL por evento proved", () => {
  it("hands channel.phone's number (Y) to the global rule, never the last message's (X)", async () => {
    const w = world({
      channels: umblerChannels,
      rules: umblerRules,
      // Talked to Y two days ago and to X today: the body says Y.
      lastMessages: [
        { phone: "5511977770000", channelId: "umb_y" },
        { phone: "5511977770000", channelId: "umb_x" },
      ],
    });
    const { endpoint, token } = await w.connect("umbler", "QualifiedLead");
    await expect(
      w.post(endpoint.id, token, {
        ...umblerAutomation("lead_qualificado", "5511977770000"),
        channel: { phone: "5511900002222" },
      }),
    ).resolves.toMatchObject({ routing: "routed" });
    expect(w.observed).toHaveLength(1);
    expect(w.observed[0]).toMatchObject({
      providerRuleId: "umbler_global",
      routedChannelId: "umb_y",
    });
  });

  it("keeps the routed number for a later resend by the rule's old URL and for reprocesses", async () => {
    const w = world({
      channels: umblerChannels,
      rules: umblerRules,
      lastMessages: [{ phone: "5511977770000", channelId: "umb_x" }],
    });
    const { endpoint, token } = await w.connect("umbler", "QualifiedLead");
    const body = {
      ...umblerAutomation("lead_qualificado", "5511977770000"),
      channel: { phone: "5511900002222" },
    };
    await w.post(endpoint.id, token, body);
    await w.postOldUrl("umbler_global", body);
    expect(w.observed.map((call) => call.routedChannelId)).toEqual([
      "umb_y",
      "umb_y",
    ]);
    expect([...w.deliveries.values()][0].normalizedSummary).toMatchObject({
      routedChannelId: "umb_y",
    });
  });

  function observationWith(recentChannelId: string) {
    const channel = (id: string) => ({
      id,
      organizationId: "org",
      providerChannelId: id,
      status: "active",
      productionActivatedAt: at,
      conversionEngineMode: "canonical",
    });
    const prisma: any = {
      inboundWebhookChannel: {
        findFirst: vi.fn(async ({ where }: any) => channel(where.id)),
      },
      inboundWebhookEvent: {
        findFirst: vi.fn(async () => ({ channel: channel(recentChannelId) })),
      },
    };
    const service = new ProviderConversionObservationService(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ) as any;
    const rule = {
      id: "rule",
      scope: "specific_numbers",
      connectionId: "conn_umbler",
      parserRelease: { provider: "umbler" },
      conversionRule: { triggerType: "provider_automation", eventName: "QualifiedLead" },
      channels: [
        { channelId: "umb_x", channel: channel("umb_x") },
        { channelId: "umb_y", channel: channel("umb_y") },
      ],
    };
    const resolve = (routedChannelId?: string) =>
      service.resolveAutomationChannel({
        workspaceId: W,
        connectionId: "conn_umbler",
        phone: "5511977770000",
        deliveryReceivedAt: at,
        rule,
        routedChannelId,
      });
    return { resolve, prisma };
  }

  it("uses the routed number when it is in the rule scope, else does not own the callback", async () => {
    const { resolve, prisma } = observationWith("umb_x");
    await expect(resolve("umb_y")).resolves.toMatchObject({ id: "umb_y" });
    expect(prisma.inboundWebhookEvent.findFirst).not.toHaveBeenCalled();
    await expect(resolve("umb_z")).resolves.toBeNull();
    // Without the hint (old URL, never routed): the last message, as before.
    await expect(resolve(undefined)).resolves.toMatchObject({ id: "umb_x" });
  });

  it("gives Umbler the same business identity as Unnichat (one send for the two URLs)", () => {
    const base = {
      workspaceId: W,
      leadId: "lead",
      ctwaClid: "click",
      eventName: "QualifiedLead",
      dedupeMode: "lifetime" as const,
    };
    const old = automationConversionIdentity("umbler", { ...base, occurrenceKey: "o1" });
    const routed = automationConversionIdentity("umbler", { ...base, occurrenceKey: "o1" });
    expect(old).toBe(routed);
    // Lifetime: the same lead + click is one conversion whatever the callback.
    expect(automationConversionIdentity("umbler", { ...base, occurrenceKey: "o2" })).toBe(old);
    // Purchase: once per callback (the occurrence key comes only from the body).
    const purchase = (occurrenceKey: string) =>
      automationConversionIdentity("umbler", {
        ...base,
        eventName: "Purchase",
        dedupeMode: "rolling_window",
        occurrenceKey,
      });
    expect(purchase("o1")).toBe(purchase("o1"));
    expect(purchase("o1")).not.toBe(purchase("o2"));
    // Never collides with Unnichat; Unnichat ids did not change.
    expect(old).not.toBe(unnichatAutomationConversionIdentity({ ...base, occurrenceKey: "o1" }));
    expect(unnichatAutomationConversionIdentity({ ...base, occurrenceKey: "o1" })).toBe(
      automationConversionIdentity("unnichat", { ...base, occurrenceKey: "o1" }),
    );
  });
});

const paytGlobal: Rule = {
  id: "payt_global",
  provider: "payt",
  eventName: "Purchase",
  scope: "all_numbers",
  connectionId: "conn_unnichat_a",
  channelIds: [],
};
const payt1020: Rule = {
  id: "payt_1020",
  provider: "payt",
  eventName: "Purchase",
  scope: "specific_numbers",
  connectionId: "conn_unnichat_a",
  channelIds: ["ch_1020"],
};
const payt5520: Rule = { ...payt1020, id: "payt_5520", channelIds: ["ch_5520"] };

describe("M2 — Payt: the URL única picks the origin like the rule's own URL", () => {
  it("ad lead without materialized entry: uses its verified CTWA entry proof", async () => {
    const w = world({
      channels: jeanChannels,
      rules: [paytGlobal, payt1020],
      leads: [{ ...jeanLeads[0]!, adId: "ad_1", adEntries: [] }],
    });
    const { endpoint, token } = await w.connect("payt");
    await expect(w.post(endpoint.id, token, paytSale({ order: "M2A" }))).resolves.toMatchObject({
      routing: "routed",
    });
    expect(w.observed[0]).toMatchObject({ providerRuleId: "payt_1020" });
  });

  it("lead with entries on two numbers: only a rule owning exactly one of them takes it", async () => {
    const twoEntries = [{ ...jeanLeads[0]!, adId: "ad_1", adEntries: ["ch_1020", "ch_5520"] }];
    const one = world({ channels: jeanChannels, rules: [paytGlobal, payt1020], leads: twoEntries });
    const a = await one.connect("payt");
    await expect(one.post(a.endpoint.id, a.token, paytSale({ order: "M2B" }))).resolves.toMatchObject({
      routing: "routed",
    });
    expect(one.observed[0]).toMatchObject({ providerRuleId: "payt_1020" });

    // Two specific rules, one per entry: ambiguous (never guessed).
    const two = world({ channels: jeanChannels, rules: [payt1020, payt5520], leads: twoEntries });
    const b = await two.connect("payt");
    await expect(two.post(b.endpoint.id, b.token, paytSale({ order: "M2C" }))).resolves.toMatchObject({
      routing: "unattributed",
      reasonCode: "origin_channel_unresolved",
    });

    // Only the rule for all numbers: it sees both entries, as on its old URL.
    const global = world({ channels: jeanChannels, rules: [paytGlobal], leads: twoEntries });
    const c = await global.connect("payt");
    await expect(global.post(c.endpoint.id, c.token, paytSale({ order: "M2D" }))).resolves.toMatchObject({
      routing: "unattributed",
      reasonCode: "origin_channel_unresolved",
    });
    expect(two.observed).toHaveLength(0);
    expect(global.observed).toHaveLength(0);
  });
});

describe("M3 — a routed callback the rule does not convert is listed as unattributed", () => {
  it.each([
    ["ignored", "payt_lead_other_channel"],
    ["ignored", "payt_product_not_in_rule"],
    ["blocked", "payt_channel_missing_or_ambiguous"],
  ] as const)("disposition %s (%s) -> rule_declined", async (disposition, reasonCode) => {
    const w = world({ channels: jeanChannels, rules: [paytGlobal], leads: jeanLeads });
    const observe = (w.ingestion as any).conversionObservation.observeAutomation;
    observe.mockImplementationOnce(async (input: any) => {
      w.observed.push(input);
      return {
        decisionId: null,
        decisionCode: null,
        reasonCode,
        disposition,
        executionId: null,
        eligibleExecutionId: null,
        reviewId: null,
        channelId: null,
        leadResolved: true,
      };
    });
    const { endpoint, token } = await w.connect("payt");
    const result = await w.post(endpoint.id, token, paytSale({ order: `M3-${reasonCode}` }));
    expect(result).toMatchObject({ routing: "unattributed", reasonCode: "rule_declined" });
    const receipt = w.receipts.get(result.eventId);
    expect(receipt).toMatchObject({
      status: "unattributed",
      reasonCode: "rule_declined",
      routedProviderRuleId: "payt_global",
      routingOutcome: reasonCode,
    });
    const list = await w.service.listUnattributed(W, "payt");
    expect(list.items[0]).toMatchObject({
      reasonCode: "rule_declined",
      ruleReasonCode: reasonCode,
      reasonLabel: integrationUnattributedReasonLabel("rule_declined"),
    });
    expect(list.items[0]!.reasonLabel).toMatch(/regra/u);
  });

  it("keeps an observed or eligible callback as routed", async () => {
    const w = world({ channels: jeanChannels, rules: [paytGlobal], leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    const result = await w.post(endpoint.id, token, paytSale({ order: "M3-ok" }));
    expect(result).toMatchObject({ routing: "routed" });
    expect(w.receipts.get(result.eventId)).toMatchObject({
      status: "routed",
      routingOutcome: "observed",
    });
  });

  it("also reads the rule's decision when the delivery already existed (old URL first)", async () => {
    const w = world({ channels: jeanChannels, rules: [paytGlobal], leads: jeanLeads });
    const sale = paytSale({ order: "M3-dup" });
    await w.postOldUrl("payt_global", sale);
    const observe = (w.ingestion as any).conversionObservation.observeAutomation;
    observe.mockImplementationOnce(async () => ({
      decisionId: null,
      decisionCode: null,
      reasonCode: "payt_lead_other_channel",
      disposition: "ignored",
      executionId: null,
      eligibleExecutionId: null,
      reviewId: null,
      channelId: null,
      leadResolved: true,
    }));
    const { endpoint, token } = await w.connect("payt");
    await expect(w.post(endpoint.id, token, sale)).resolves.toMatchObject({
      routing: "unattributed",
      reasonCode: "rule_declined",
    });
  });

  it("never leaks the rule outcome in the public answer of the old URL", async () => {
    const w = world({ channels: jeanChannels, rules: [paytGlobal], leads: jeanLeads });
    const result = await w.postOldUrl("payt_global", paytSale({ order: "M3-pub" }));
    expect(result).not.toHaveProperty("ruleOutcome");
  });
});

describe("Low findings", () => {
  it("'Tentar de novo' evaluates the sale at its original receipt time (production gate)", async () => {
    const w = world({ channels: jeanChannels, rules: [], leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    const result = await w.post(endpoint.id, token, paytSale({ order: "LOW1" }));
    const receipt = w.receipts.get(result.eventId);
    receipt.firstReceivedAt = new Date("2026-10-01T10:00:00.000Z");
    w.addRule(paytGlobal);
    await w.service.retryEvent(W, result.eventId, "operator");
    expect(w.observed.at(-1)).toMatchObject({
      deliveryReceivedAt: new Date("2026-10-01T10:00:00.000Z"),
    });
    expect(w.observed.at(-1)!.manualReplayApproval).toBeUndefined();
    expect([...w.deliveries.values()][0].firstReceivedAt).toEqual(
      new Date("2026-10-01T10:00:00.000Z"),
    );
  });

  it("a receipt of a removed URL is not retryable (retry answers 404)", async () => {
    const w = world({ channels: jeanChannels, rules: [], leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    const result = await w.post(endpoint.id, token, paytSale({ order: "LOW2" }));
    expect((await w.service.listUnattributed(W, "payt")).items[0]?.retryable).toBe(true);
    await w.service.remove(W, endpoint.id, "operator");
    expect((await w.service.listUnattributed(W, "payt")).items[0]?.retryable).toBe(false);
    await expect(w.service.retryEvent(W, result.eventId, "operator")).rejects.toThrow(
      "Evento nao encontrado",
    );
  });
});
