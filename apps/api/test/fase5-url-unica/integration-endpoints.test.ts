import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  integrationEndpointCreateInputSchema,
  integrationUnattributedReasonLabel,
} from "@wpptrack/shared";
import {
  pickRoutedRule,
  type RoutingRule,
} from "../../src/inbound-webhooks/integration-endpoint-routing";
import { unnichatAutomationConversionIdentity } from "../../src/inbound-webhook-production/provider-conversion-production.service";
import {
  at,
  jeanChannels,
  jeanLeads,
  OTHER_WORKSPACE,
  paytSale,
  umblerAutomation,
  unnichatMovement,
  W,
  world,
  type Channel,
  type Rule,
} from "./url-unica-world";

/**
 * Fase 5.3 — URL única (Payt) e URLs por evento (Unnichat/Umbler), ported
 * from the SaaS (613beb3, d3725adf, 4cad4963, 73a9a56) plus one case per
 * risk of the approved design: double send between the URLs, old URL closed
 * while the platform still posts there, product filter discarding sales,
 * destination change by rule precedence, receipt idempotency, wrong token and
 * another workspace. Retention and the license lock have their own files.
 */

const paytFixture = (name: string) =>
  JSON.parse(
    readFileSync(resolve(__dirname, "../fase4-payt/fixtures", name), "utf8"),
  ) as Record<string, any>;

describe("pickRoutedRule (pure precedence)", () => {
  const channel = { id: "ch_1020", connectionId: "conn_a", provider: "unnichat" };
  const base = (
    id: string,
    scope: "all_numbers" | "specific_numbers",
    extra: Partial<RoutingRule> = {},
  ): RoutingRule => ({
    id,
    scope,
    connectionId: "conn_a",
    removedAt: null,
    createdAt: new Date(at.getTime() + id.length),
    productFilterCodes: [],
    conversionRule: {
      triggerType: "provider_automation",
      eventName: "Purchase",
      active: true,
    },
    parserRelease: { provider: "payt" },
    connection: { provider: "unnichat" },
    channels: scope === "specific_numbers" ? [{ channelId: "ch_1020" }] : [],
    ...extra,
  });

  it("prefers the specific rule of the number over the rule for all numbers", () => {
    const picked = pickRoutedRule(
      [base("global", "all_numbers"), base("specific", "specific_numbers")],
      channel,
      { productCodes: [] },
    );
    expect(picked?.id).toBe("specific");
  });

  it("falls back to the global rule when the specific one belongs to another number", () => {
    const other = base("specific", "specific_numbers", {
      channels: [{ channelId: "ch_5520" }],
    });
    expect(
      pickRoutedRule([base("global", "all_numbers"), other], channel, {
        productCodes: [],
      })?.id,
    ).toBe("global");
  });

  it("lets a specific rule replace the global one only for the products it accepts", () => {
    const rules = [
      base("global", "all_numbers"),
      base("specific_a", "specific_numbers", { productFilterCodes: ["PRODA"] }),
    ];
    expect(pickRoutedRule(rules, channel, { productCodes: ["PRODA"] })?.id).toBe(
      "specific_a",
    );
    expect(pickRoutedRule(rules, channel, { productCodes: ["PRODB"] })?.id).toBe(
      "global",
    );
  });

  it("breaks ties: product-filtered first, then the oldest", () => {
    const rules = [
      base("g_old", "all_numbers", { createdAt: new Date(1) }),
      base("g_filtered", "all_numbers", {
        createdAt: new Date(2),
        productFilterCodes: ["PRODA"],
      }),
    ];
    expect(pickRoutedRule(rules, channel, { productCodes: ["PRODA"] })?.id).toBe(
      "g_filtered",
    );
    expect(pickRoutedRule(rules, channel, { productCodes: ["PRODZ"] })?.id).toBe(
      "g_old",
    );
  });
});

const paytRules: Rule[] = [
  {
    id: "payt_global",
    provider: "payt",
    eventName: "Purchase",
    scope: "all_numbers",
    connectionId: "conn_unnichat_a",
    channelIds: [],
  },
  {
    id: "payt_1020",
    provider: "payt",
    eventName: "Purchase",
    scope: "specific_numbers",
    connectionId: "conn_unnichat_a",
    channelIds: ["ch_1020"],
  },
  {
    id: "payt_checkout",
    provider: "payt",
    eventName: "InitiateCheckout",
    scope: "all_numbers",
    connectionId: "conn_unnichat_a",
    channelIds: [],
  },
];

describe("Payt: one URL per workspace", () => {
  it("generates once, never lists the token and reveals it only on purpose (audited)", async () => {
    const w = world({ channels: jeanChannels, rules: paytRules, leads: jeanLeads });
    const first = await w.connect("payt");
    const second = await w.connect("payt");
    expect(second.endpoint.id).toBe(first.endpoint.id);
    expect(first.url.pathname).toBe(
      `/webhooks/inbound/integrations/${first.endpoint.id}`,
    );
    expect(first.token.length).toBeGreaterThan(30);
    expect((await w.service.list(W, false)).endpoints[0]?.url).toBeNull();
    expect((await w.service.list(W, true)).endpoints[0]?.url).toBeNull();
    const auditsBefore = w.audit.length;
    const revealed = await w.service.reveal(W, first.endpoint.id, "operator");
    expect(revealed.url).toBe(first.url.toString());
    expect(w.audit.slice(auditsBefore).map((entry) => entry.action)).toEqual([
      "integration_endpoint.url_revealed",
    ]);
    // The token is stored hashed and encrypted, never in clear nor in audits.
    const stored = w.integrationEndpoints.get(first.endpoint.id);
    expect(JSON.stringify(stored)).not.toContain(first.token);
    expect(JSON.stringify(w.audit)).not.toContain(first.token);
  });

  it("routes by the buyer's arrival number: specific rule on 1020, global rule on 5520", async () => {
    const w = world({ channels: jeanChannels, rules: paytRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");

    const on1020 = await w.post(
      endpoint.id,
      token,
      paytSale({ order: "A1", phone: "11991231020" }),
    );
    const on5520 = await w.post(
      endpoint.id,
      token,
      paytSale({ order: "B1", phone: "11987655520" }),
    );

    expect(on1020).toMatchObject({ routing: "routed" });
    expect(on5520).toMatchObject({ routing: "routed" });
    expect(w.observed.map((call) => call.providerRuleId)).toEqual([
      "payt_1020",
      "payt_global",
    ]);
    // The routed callback takes the rule's own path and is marked as routed.
    const delivery = [...w.deliveries.values()][0];
    expect(delivery).toMatchObject({
      providerRuleEndpointId: "endpoint_payt_1020",
      integrationEndpointWorkspaceId: W,
      integrationEndpointId: endpoint.id,
      connectionId: "conn_unnichat_a",
      purpose: "conversion_automation",
    });
    // Routed callbacks never move the old URL's "last received".
    expect(w.endpoints.get("endpoint_payt_1020").lastDeliveryAt).toBeNull();
    expect([...w.receipts.values()][0]).toMatchObject({
      status: "routed",
      reasonCode: null,
      routedProviderRuleId: "payt_1020",
      routedChannelId: "ch_1020",
      routedDeliveryId: delivery.id,
    });
  });

  it.each([
    ["waiting_payment", "order", "InitiateCheckout", "payt_checkout"],
    ["paid", "order", "Purchase", "payt_1020"],
  ])("maps status %s to %s", async (status, type, eventName, ruleId) => {
    const w = world({ channels: jeanChannels, rules: paytRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    await w.post(endpoint.id, token, paytSale({ status, type }));
    expect(w.observed).toHaveLength(1);
    expect(w.observed[0]).toMatchObject({
      providerRuleId: ruleId,
      automation: { eventName },
    });
    expect([...w.receipts.values()][0]).toMatchObject({
      eventName,
      status: "routed",
    });
  });

  it("records an abandoned cart without an active rule as unattributed, and ignores unsupported statuses", async () => {
    const w = world({ channels: jeanChannels, rules: paytRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    const cart = await w.post(
      endpoint.id,
      token,
      paytSale({ status: "lost_cart", type: "lost_cart" }),
    );
    const refund = await w.post(
      endpoint.id,
      token,
      paytSale({ status: "refunded", order: "R1" }),
    );
    expect(cart).toMatchObject({
      routing: "unattributed",
      reasonCode: "no_active_rule_for_event",
    });
    expect(refund).toMatchObject({
      routing: "ignored",
      reasonCode: "status_not_supported",
    });
    expect(w.observed).toHaveLength(0);
    const list = await w.service.listUnattributed(W, "payt");
    expect(list.items.map((item) => item.reasonLabel)).toEqual([
      "Nenhuma regra ativa para este evento",
    ]);
    expect(list.items[0]).toMatchObject({
      eventName: "CartAbandoned",
      retryable: true,
    });
  });

  it("stores the receipt idempotently: a provider retry is one receipt with more attempts", async () => {
    const w = world({ channels: jeanChannels, rules: paytRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    const sale = paytSale({ order: "I1", status: "refunded" });
    const first = await w.post(endpoint.id, token, sale, "1");
    const again = await w.post(endpoint.id, token, sale, "2");
    expect(first.duplicate).toBe(false);
    expect(again).toMatchObject({ duplicate: true, eventId: first.eventId });
    expect(w.receipts.size).toBe(1);
    expect(w.receipts.get(first.eventId)).toMatchObject({
      attemptCount: 2,
      status: "ignored",
    });
  });

  it("collapses provider retries and the same sale on the rule's old URL into ONE delivery", async () => {
    const w = world({ channels: jeanChannels, rules: paytRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    const sale = paytSale({ order: "D1" });

    await w.postOldUrl("payt_1020", sale); // old per-rule URL still active
    const retry1 = await w.post(endpoint.id, token, sale, "1");
    const retry2 = await w.post(endpoint.id, token, sale, "2");

    expect(retry1.duplicate).toBe(false);
    expect(retry2).toMatchObject({ duplicate: true, routing: "routed" });
    expect(w.receipts.size).toBe(1);
    expect([...w.receipts.values()][0].attemptCount).toBe(2);
    expect(w.deliveries.size).toBe(1);
    expect([...w.deliveries.values()][0].attemptCount).toBe(3);
    const keys = new Set(
      w.observed.map(
        (call) => `${call.providerRuleId}|${call.automation.externalExecutionKey}`,
      ),
    );
    expect(keys.size).toBe(1);
  });

  it("double send risk: the same sale through ANOTHER rule's old URL and the new URL carries ONE sale identity", async () => {
    // payt_global still has its old URL configured in Payt; the new URL routes
    // the same sale (buyer of 1020) to payt_1020. Two rules, two deliveries,
    // but the observation keys both by seller+order+event, which is the key of
    // the durable purchase claim (one winner, one send: see
    // url-unica-double-send.test.ts for the claim itself).
    const w = world({ channels: jeanChannels, rules: paytRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    const sale = paytSale({ order: "DS1" });
    await w.postOldUrl("payt_global", sale);
    await w.post(endpoint.id, token, sale);
    expect(w.observed.map((call) => call.providerRuleId)).toEqual([
      "payt_global",
      "payt_1020",
    ]);
    expect(w.deliveries.size).toBe(2);
    const [old, routed] = w.observed;
    expect(old.automation.accountRef).toBe(routed.automation.accountRef);
    expect(old.automation.orderRef).toBe(routed.automation.orderRef);
    expect(old.automation.eventName).toBe(routed.automation.eventName);
  });

  it("sends a provider retry of a routed sale back to the same rule, never downgrading it", async () => {
    const w = world({ channels: jeanChannels, rules: paytRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    const sale = paytSale({ order: "R9" });
    await w.post(endpoint.id, token, sale);
    // The routing inputs change (e.g. the specific rule was paused)...
    w.paidLeads.resolve.mockClear();
    w.prisma.providerConversionRuleConfig.findMany.mockResolvedValue([]);
    const retry = await w.post(endpoint.id, token, sale, "2");
    // ...but the retry goes to the rule that already owns the sale.
    expect(retry).toMatchObject({ duplicate: true, routing: "routed" });
    expect(w.paidLeads.resolve).not.toHaveBeenCalled();
    expect(w.observed.map((call) => call.providerRuleId)).toEqual([
      "payt_1020",
      "payt_1020",
    ]);
    expect([...w.receipts.values()][0]).toMatchObject({
      status: "routed",
      routedProviderRuleId: "payt_1020",
      attemptCount: 2,
    });
    expect([...w.deliveries.values()][0].attemptCount).toBe(2);
  });

  it("destination change by rule precedence: a new specific rule takes the next sales of its number, never the ones already routed", async () => {
    const w = world({
      channels: jeanChannels,
      rules: [paytRules[0]!],
      leads: jeanLeads,
    });
    const { endpoint, token } = await w.connect("payt");
    const before = paytSale({ order: "PR1" });
    await w.post(endpoint.id, token, before);
    // The operator creates a specific Purchase rule for 1020.
    w.addRule({ ...paytRules[1]!, createdAt: new Date(at.getTime() + 1_000) });
    await w.post(endpoint.id, token, paytSale({ order: "PR2" }));
    // 5520 has no specific rule: it stays with the global one.
    await w.post(
      endpoint.id,
      token,
      paytSale({ order: "PR3", phone: "11987655520" }),
    );
    // A provider retry of the first sale stays with the rule that owns it.
    await w.post(endpoint.id, token, before, "2");
    expect(w.observed.map((call) => call.providerRuleId)).toEqual([
      "payt_global",
      "payt_1020",
      "payt_global",
      "payt_global",
    ]);
  });

  it("product filter discarding sales: only the accepted products reach the filtered rule; the others are listed with the reason", async () => {
    const w = world({
      channels: jeanChannels,
      rules: [{ ...paytRules[1]!, productFilterCodes: ["PRODA"] }],
      leads: jeanLeads,
    });
    const { endpoint, token } = await w.connect("payt");
    expect(
      await w.post(endpoint.id, token, paytSale({ order: "X1", product: "PRODB" })),
    ).toMatchObject({ routing: "unattributed", reasonCode: "product_without_rule" });
    expect(
      await w.post(
        endpoint.id,
        token,
        paytSale({ order: "X2", product: "PRODA", phone: "11900000000" }),
      ),
    ).toMatchObject({ routing: "unattributed", reasonCode: "buyer_not_whatsapp_lead" });
    expect(
      await w.post(endpoint.id, token, paytSale({ order: "X3", product: "proda" })),
    ).toMatchObject({ routing: "routed" });
    expect(w.observed.map((call) => call.automation.orderRef)).toEqual(["X3"]);
    expect(integrationUnattributedReasonLabel("product_without_rule")).toBe(
      "Produto sem regra",
    );
    const unattributed = await w.service.listUnattributed(W, "payt");
    expect(unattributed.total).toBe(2);
    expect(
      unattributed.items.find((item) => item.reasonCode === "product_without_rule"),
    ).toMatchObject({ productCode: "PRODB", productName: "Mentoria" });
    // Detected products come from every received sale.
    expect([...w.receipts.values()].map((r) => r.productCode)).toEqual([
      "PRODB",
      "PRODA",
      "PRODA",
    ]);
    expect([...w.receipts.values()][0]).toMatchObject({
      offerCode: "OFR1",
      offerName: "Oferta principal",
      currency: "BRL",
    });
  });

  it("product filter never silences the global rule for another product", async () => {
    const w = world({
      channels: jeanChannels,
      rules: [
        paytRules[0]!,
        { ...paytRules[1]!, productFilterCodes: ["PRODA"] },
      ],
      leads: jeanLeads,
    });
    const { endpoint, token } = await w.connect("payt");
    await w.post(endpoint.id, token, paytSale({ order: "F1", product: "PRODA" }));
    await w.post(endpoint.id, token, paytSale({ order: "F2", product: "PRODB" }));
    expect(w.observed.map((call) => call.providerRuleId)).toEqual([
      "payt_1020",
      "payt_global",
    ]);
  });

  it("keeps the historical Purchase contract on the old URL: incomplete non-purchases are ignored, never failures", async () => {
    const w = world({ channels: jeanChannels, rules: paytRules, leads: jeanLeads });
    const waiting = paytFixture("order-nonpaid.sanitized.json");
    const { transaction_id: _t, cart_id: _c, seller_id: _s, ...noIds } = waiting;
    const payloads = [
      { ...waiting, customer: {}, transaction: { payment_status: "waiting_payment" } },
      { ...noIds, status: "lost_cart", type: "lost_cart" },
      waiting,
    ];
    for (const payload of payloads) {
      await expect(w.postOldUrl("payt_1020", payload)).resolves.toMatchObject({
        status: "accepted",
        observationStatus: "ignored",
      });
    }
    expect([...w.deliveries.values()].map((d) => d.parseErrorCode)).toEqual([
      "payt_automation_v1_not_purchase",
      "payt_automation_v1_not_purchase",
      "payt_automation_v1_not_purchase",
    ]);
    expect(w.observed).toHaveLength(0);
    await expect(
      w.postOldUrl("payt_1020", paytFixture("order-paid.sanitized.json")),
    ).resolves.toMatchObject({ observationStatus: "observed" });
  });

  it("old URL closed while the platform still posts there: generic 404, nothing stored, the rule keeps receiving by the new URL", async () => {
    const w = world({
      channels: jeanChannels,
      rules: [paytRules[1]!, { ...paytRules[0]!, publicUrlDisabledAt: at }],
      leads: jeanLeads,
    });
    await expect(
      w.postOldUrl("payt_1020", paytSale({ order: "L1" })),
    ).resolves.toMatchObject({ status: "accepted" });
    const stored = w.deliveries.size;
    await expect(
      w.postOldUrl("payt_global", paytSale({ order: "L2" })),
    ).rejects.toThrow("Webhook nao encontrado");
    // Nothing recorded for the closed URL; its "last received" does not move.
    expect(w.deliveries.size).toBe(stored);
    expect(w.endpoints.get("endpoint_payt_global").lastDeliveryAt).toBeNull();
    // The rule still receives through the URL única.
    const { endpoint, token } = await w.connect("payt");
    await w.post(endpoint.id, token, paytSale({ order: "L3", phone: "11987655520" }));
    expect(w.observed.at(-1)).toMatchObject({ providerRuleId: "payt_global" });
    // The checklist still shows the old URL of payt_1020 with its last receipt.
    const { legacyUrls } = await w.service.list(W, true);
    expect(
      legacyUrls.find((url) => url.providerRuleId === "payt_1020"),
    ).toMatchObject({ publicUrlDisabledAt: null });
    expect(
      legacyUrls.find((url) => url.providerRuleId === "payt_1020")?.lastDeliveryAt,
    ).not.toBeNull();
    // A disabled URL that never received anything is not listed.
    expect(
      legacyUrls.find((url) => url.providerRuleId === "payt_global"),
    ).toBeUndefined();
    // Reversible: reopening the URL accepts the platform again.
    w.endpoints.get("endpoint_payt_global").publicUrlDisabledAt = null;
    await expect(
      w.postOldUrl("payt_global", paytSale({ order: "L4", phone: "11987655520" })),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  it("re-routes an unattributed sale with 'Tentar de novo' once the rule exists", async () => {
    const w = world({ channels: jeanChannels, rules: [], leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    const result = await w.post(endpoint.id, token, paytSale({ order: "T1" }));
    expect(result).toMatchObject({
      routing: "unattributed",
      reasonCode: "no_active_rule_for_event",
    });
    w.addRule(paytRules[0]!);
    await expect(
      w.service.retryEvent(W, result.eventId, "operator"),
    ).resolves.toMatchObject({ status: "routed", providerRuleId: "payt_global" });
    expect(
      w.audit.some((entry) => entry.action === "integration_endpoint.event_retried"),
    ).toBe(true);
    // A routed receipt is not retried again: it belongs to the rule now.
    await expect(
      w.service.retryEvent(W, result.eventId, "operator"),
    ).rejects.toThrow("reprocesse pela regra");
  });

  it("keeps a receipt pending with a reason until routed (provider retry or 'Tentar de novo')", async () => {
    const w = world({ channels: jeanChannels, rules: paytRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    w.paidLeads.resolve.mockRejectedValueOnce(new Error("database down"));
    await expect(
      w.post(endpoint.id, token, paytSale({ order: "P1" })),
    ).rejects.toThrow("Webhook temporariamente indisponivel");
    const receipt = [...w.receipts.values()][0];
    expect(receipt).toMatchObject({ status: "pending", reasonCode: "routing_pending" });
    const list = await w.service.listUnattributed(W, "payt");
    expect(list.items[0]).toMatchObject({
      reasonCode: "routing_pending",
      reasonLabel: "Recebido; ainda não foi possível atribuir (tente de novo)",
    });
    await expect(
      w.service.retryEvent(W, receipt.id, "operator"),
    ).resolves.toMatchObject({ status: "routed" });
  });

  it("answers the same generic 404 for a wrong token, an unknown URL and a removed URL", async () => {
    const w = world({ channels: jeanChannels, rules: paytRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    await expect(w.post(endpoint.id, "wrong", paytSale({}))).rejects.toThrow(
      "Webhook nao encontrado",
    );
    await expect(w.post(endpoint.id, "", paytSale({}))).rejects.toThrow(
      "Webhook nao encontrado",
    );
    await expect(w.post("unknown-id", token, paytSale({}))).rejects.toThrow(
      "Webhook nao encontrado",
    );
    await w.service.remove(W, endpoint.id, "operator");
    await expect(w.post(endpoint.id, token, paytSale({}))).rejects.toThrow(
      "Webhook nao encontrado",
    );
    expect(w.receipts.size).toBe(0);
  });

  it("never lets another workspace read, reveal, rotate, remove or retry this workspace's URL", async () => {
    const w = world({ channels: jeanChannels, rules: [], leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    const result = await w.post(endpoint.id, token, paytSale({ order: "O1" }));
    await expect(
      w.service.reveal(OTHER_WORKSPACE, endpoint.id, "intruder"),
    ).rejects.toThrow("Endereco nao encontrado");
    await expect(
      w.service.rotate(OTHER_WORKSPACE, endpoint.id, "intruder"),
    ).rejects.toThrow("Endereco nao encontrado");
    await expect(
      w.service.remove(OTHER_WORKSPACE, endpoint.id, "intruder"),
    ).rejects.toThrow("Endereco nao encontrado");
    await expect(
      w.service.retryEvent(OTHER_WORKSPACE, result.eventId, "intruder"),
    ).rejects.toThrow("Evento nao encontrado");
    expect((await w.service.list(OTHER_WORKSPACE, true)).endpoints).toEqual([]);
    expect(
      (await w.service.listUnattributed(OTHER_WORKSPACE, null)).total,
    ).toBe(0);
  });

  it("rotates the token: the previous URL stops working at once", async () => {
    const w = world({ channels: jeanChannels, rules: paytRules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("payt");
    const rotated = await w.service.rotate(W, endpoint.id, "operator");
    const newToken = new URL(rotated.url!).searchParams.get("token")!;
    expect(newToken).not.toBe(token);
    await expect(w.post(endpoint.id, token, paytSale({}))).rejects.toThrow(
      "Webhook nao encontrado",
    );
    await expect(
      w.post(endpoint.id, newToken, paytSale({ order: "ROT1" })),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  it("keeps the manual production replay approval for callbacks routed by the new URL", async () => {
    const w = world({
      channels: jeanChannels,
      rules: paytRules,
      leads: jeanLeads,
      production: true,
    });
    const { endpoint, token } = await w.connect("payt");
    await w.post(endpoint.id, token, paytSale({ order: "M1" }));
    expect(w.observed[0].manualReplayApproval).toBeUndefined();
    expect(w.productionQueue.enqueueProviderConversion).not.toHaveBeenCalled();
  });

  it("accepts the sanitized paid fixture and keeps no buyer data in clear in the receipt", async () => {
    const w = world({
      channels: jeanChannels,
      rules: [paytRules[0]!],
      leads: [
        {
          id: "lead_fx",
          phone: "5511999999999",
          entryChannelId: "ch_1020",
          ctwaClid: "click-fx",
        },
      ],
    });
    const { endpoint, token } = await w.connect("payt");
    await expect(
      w.post(endpoint.id, token, paytFixture("order-paid.sanitized.json")),
    ).resolves.toMatchObject({ routing: "routed" });
    const receipt = [...w.receipts.values()][0];
    // Value without installment interest (Fase 5.0), product and offer codes.
    expect(receipt).toMatchObject({ valueCents: 233331, currency: "BRL" });
    expect(receipt.productCode).toBeTruthy();
    expect(JSON.stringify(receipt)).not.toContain("example.com");
    expect(JSON.stringify(receipt)).not.toContain("11999999999");
  });
});

describe("Unnichat: one URL per event for every number (Jean: 1020 and 5520)", () => {
  const rules: Rule[] = [
    {
      id: "qualified_1020",
      provider: "unnichat",
      eventName: "QualifiedLead",
      scope: "specific_numbers",
      connectionId: "conn_unnichat_a",
      channelIds: ["ch_1020"],
    },
    {
      id: "qualified_5520",
      provider: "unnichat",
      eventName: "QualifiedLead",
      scope: "specific_numbers",
      connectionId: "conn_unnichat_b",
      channelIds: ["ch_5520"],
    },
    {
      id: "purchase_b_all",
      provider: "unnichat",
      eventName: "Purchase",
      scope: "all_numbers",
      connectionId: "conn_unnichat_b",
      channelIds: [],
    },
  ];

  it("routes the same 'Lead Qualificado' URL by the ctwa_clid entry to the rule of that number", async () => {
    const w = world({ channels: jeanChannels, rules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("unnichat", "QualifiedLead");

    await w.post(
      endpoint.id,
      token,
      unnichatMovement({ phone: "5511991231020", ctwaClid: "click-a" }),
    );
    await w.post(
      endpoint.id,
      token,
      unnichatMovement({ phone: "5511987655520", ctwaClid: "click-b" }),
    );

    expect(
      w.observed.map((call) => [call.providerRuleId, call.connectionId]),
    ).toEqual([
      ["qualified_1020", "conn_unnichat_a"],
      ["qualified_5520", "conn_unnichat_b"],
    ]);
    // The URL decides the event, never the payload's event_name ("Lead").
    expect(
      w.observed.every((call) => call.automation.eventName === "QualifiedLead"),
    ).toBe(true);
  });

  it("uses a different URL per event; a number without a rule for it stays unattributed", async () => {
    const w = world({ channels: jeanChannels, rules, leads: jeanLeads });
    const purchase = await w.connect("unnichat", "Purchase");
    const qualified = await w.connect("unnichat", "QualifiedLead");
    expect(purchase.endpoint.id).not.toBe(qualified.endpoint.id);

    await expect(
      w.post(
        purchase.endpoint.id,
        purchase.token,
        unnichatMovement({ phone: "5511987655520", ctwaClid: "click-b" }),
      ),
    ).resolves.toMatchObject({ routing: "routed" });
    await expect(
      w.post(
        purchase.endpoint.id,
        purchase.token,
        unnichatMovement({ phone: "5511991231020", ctwaClid: "click-a" }),
      ),
    ).resolves.toMatchObject({
      routing: "unattributed",
      reasonCode: "no_rule_for_number",
    });
    await expect(
      w.post(
        qualified.endpoint.id,
        qualified.token,
        unnichatMovement({ phone: "5511991231020", ctwaClid: null }),
      ),
    ).resolves.toMatchObject({
      routing: "unattributed",
      reasonCode: "conversation_without_ad",
    });
    expect(w.observed.map((call) => call.providerRuleId)).toEqual([
      "purchase_b_all",
    ]);
  });

  it("refuses an event the platform cannot send", () => {
    expect(
      integrationEndpointCreateInputSchema.safeParse({
        provider: "umbler",
        eventName: "AddToCart",
      }).success,
    ).toBe(false);
    expect(
      integrationEndpointCreateInputSchema.safeParse({
        provider: "payt",
        eventName: "Purchase",
      }).success,
    ).toBe(false);
    expect(
      integrationEndpointCreateInputSchema.safeParse({ provider: "unnichat" })
        .success,
    ).toBe(false);
    expect(
      integrationEndpointCreateInputSchema.safeParse({ provider: "braip" })
        .success,
    ).toBe(false);
  });
});

describe("Umbler: one URL per event", () => {
  const channels: Channel[] = [
    {
      id: "umb_1020",
      connectionId: "conn_umbler",
      provider: "umbler",
      phone: "5511900001020",
    },
    {
      id: "umb_5520",
      connectionId: "conn_umbler",
      provider: "umbler",
      phone: "5511900005520",
    },
  ];
  const rules: Rule[] = [
    {
      id: "umbler_all",
      provider: "umbler",
      eventName: "QualifiedLead",
      scope: "all_numbers",
      connectionId: "conn_umbler",
      channelIds: [],
    },
    {
      id: "umbler_5520",
      provider: "umbler",
      eventName: "QualifiedLead",
      scope: "specific_numbers",
      connectionId: "conn_umbler",
      channelIds: ["umb_5520"],
    },
  ];

  it("routes by channel.phone or by the number of the contact's last message (specific beats global)", async () => {
    const w = world({
      channels,
      rules,
      lastMessages: [
        { phone: "5511977775520", channelId: "umb_5520" },
        { phone: "5511966661020", channelId: "umb_1020" },
      ],
    });
    const { endpoint, token } = await w.connect("umbler", "QualifiedLead");
    await w.post(endpoint.id, token, umblerAutomation("lead_qualificado", "5511977775520"));
    await w.post(endpoint.id, token, umblerAutomation("lead_qualificado", "5511966661020"));
    await w.post(endpoint.id, token, {
      ...umblerAutomation("lead_qualificado", "5511955550000"),
      channel: { phone: "+55 11 90000-5520" },
    });
    expect(w.observed.map((call) => call.providerRuleId)).toEqual([
      "umbler_5520",
      "umbler_all",
      "umbler_5520",
    ]);
  });

  it("never guesses: a contact that talked to two numbers is ambiguous, unless channel.phone says which", async () => {
    const w = world({
      channels,
      rules,
      lastMessages: [
        { phone: "5511977775520", channelId: "umb_5520" },
        { phone: "5511977775520", channelId: "umb_1020" },
      ],
    });
    const { endpoint, token } = await w.connect("umbler", "QualifiedLead");
    await expect(
      w.post(endpoint.id, token, umblerAutomation("lead_qualificado", "5511977775520")),
    ).resolves.toMatchObject({
      routing: "unattributed",
      reasonCode: "contact_multiple_numbers",
    });
    await expect(
      w.post(endpoint.id, token, {
        ...umblerAutomation("lead_qualificado", "5511977775520"),
        conversation: { id: "conv-other", created_at_utc: "2026-10-19 11:30:00" },
        channel: { phone: "5511900001020" },
      }),
    ).resolves.toMatchObject({ routing: "routed" });
    expect(w.observed.map((call) => call.providerRuleId)).toEqual(["umbler_all"]);
    await expect(
      w.post(endpoint.id, token, umblerAutomation("lead_qualificado", "5511900000000")),
    ).resolves.toMatchObject({ reasonCode: "contact_without_conversation" });
  });

  it("rejects a payload whose automation is not the URL's event", async () => {
    const w = world({
      channels,
      rules,
      lastMessages: [{ phone: "5511977775520", channelId: "umb_5520" }],
    });
    const { endpoint, token } = await w.connect("umbler", "QualifiedLead");
    await expect(
      w.post(endpoint.id, token, umblerAutomation("compra_aprovada")),
    ).resolves.toMatchObject({ routing: "invalid", reasonCode: "event_mismatch" });
    expect(w.observed).toHaveLength(0);
  });
});

describe("Unnichat automation conversion identity (double send between the URLs)", () => {
  it("is the same for the same fact whatever rule or execution evaluated it", () => {
    const base = { workspaceId: W, leadId: "lead_a", ctwaClid: "click-a" };
    const lifetime = (occurrenceKey: string) =>
      unnichatAutomationConversionIdentity({
        ...base,
        eventName: "QualifiedLead",
        dedupeMode: "lifetime",
        occurrenceKey,
      });
    // QualifiedLead: once per lead + click, whatever the callback.
    expect(lifetime("occ-1")).toBe(lifetime("occ-2"));
    const purchase = (occurrenceKey: string) =>
      unnichatAutomationConversionIdentity({
        ...base,
        eventName: "Purchase",
        dedupeMode: "rolling_window",
        occurrenceKey,
      });
    // Purchase: once per callback; two real purchases stay two events.
    expect(purchase("occ-1")).toBe(purchase("occ-1"));
    expect(purchase("occ-1")).not.toBe(purchase("occ-2"));
    expect(purchase("occ-1")).not.toBe(lifetime("occ-1"));
  });

  it("the same Unnichat callback through the old URL of one rule and the new URL of another carries the same occurrence", async () => {
    const rules: Rule[] = [
      {
        id: "qualified_all",
        provider: "unnichat",
        eventName: "QualifiedLead",
        scope: "all_numbers",
        connectionId: "conn_unnichat_a",
        channelIds: [],
      },
      {
        id: "qualified_1020",
        provider: "unnichat",
        eventName: "QualifiedLead",
        scope: "specific_numbers",
        connectionId: "conn_unnichat_a",
        channelIds: ["ch_1020"],
      },
    ];
    const w = world({ channels: jeanChannels, rules, leads: jeanLeads });
    const { endpoint, token } = await w.connect("unnichat", "QualifiedLead");
    const movement = unnichatMovement({ phone: "5511991231020", ctwaClid: "click-a" });
    await w.postOldUrl("qualified_all", movement);
    await w.post(endpoint.id, token, movement);
    expect(w.observed.map((call) => call.providerRuleId)).toEqual([
      "qualified_all",
      "qualified_1020",
    ]);
    // Same occurrence key -> same business identity -> one conversion log
    // (dedupeKey provider-automation:unnichat:<identity>).
    expect(w.observed[0].automation.externalExecutionKey).toBe(
      w.observed[1].automation.externalExecutionKey,
    );
  });
});
