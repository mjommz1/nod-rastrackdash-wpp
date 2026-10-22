import { describe, expect, it, vi } from "vitest";
import { providerConversionDecisionSchema } from "@wpptrack/shared";
import { pagePixelHarness } from "./helpers/ctwa-harness";
import { offline } from "./helpers/first-entry-offline";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import { ProviderConversionPaidLeadResolver } from "../../src/conversion-rules/provider-conversion-paid-lead-resolver.service";
import { buildProviderPurchaseIdentity } from "../../src/conversion-rules/provider-purchase-identity";
import { ProviderConversionProductionService } from "../../src/inbound-webhook-production/provider-conversion-production.service";
import { InboundWebhookMetaRouteReaderService } from "../../src/inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import { canRetryConversionEvent } from "../../src/conversion-events/conversion-event-retry";
import { CTWA_SEND_SKIPPED_ERROR_CODE } from "../../src/conversion-events/conversion-events.service";

/**
 * Payt "Compra aprovada" for a WhatsApp lead that entered through Unnichat
 * CTWA WITHOUT an ad id (authorized_ctwa_destination). Real entry pipeline,
 * paid-lead resolver, decision engine, production service, recorder, queue,
 * processor and Meta adapter; only storage and the fetch boundary are fakes.
 * All identifiers and phones are synthetic.
 *
 * Adapted to this edition: the workspace integration URL (Fase 5) and the
 * backoffice parser certification (certified by migration here) are not
 * ported, so their blocks are left out.
 */
const env = {
  NODE_ENV: "test",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
  API_PUBLIC_URL: "http://localhost:3333",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
};

type PaytSaleEvent = "Purchase" | "InitiateCheckout" | "CartAbandoned";
const paytStatusByEvent: Record<PaytSaleEvent, string> = {
  Purchase: "paid",
  InitiateCheckout: "waiting_payment",
  CartAbandoned: "lost_cart",
};
const paytAutomationByEvent: Record<PaytSaleEvent, string> = {
  Purchase: "purchase_paid",
  InitiateCheckout: "checkout_waiting_payment",
  CartAbandoned: "cart_abandoned",
};

async function paytNoAdScenario(
  options: {
    totalPriceCents?: number;
    /** Fase 4: the postback status decides the event. */
    eventName?: PaytSaleEvent;
    productCode?: string;
    /** The lead row carries an ad id (e.g. from an older per-ad route entry). */
    leadAdId?: string;
    /** The entry itself was an ad-hint CTWA entry for that same ad id. */
    entryAdHint?: boolean;
    /** The lead has no verified CTWA entry proof. */
    withoutProof?: boolean;
    /** Decision frozen before the CTWA fallback: no proof in the decision. */
    decisionWithoutProof?: boolean;
  } = {},
) {
  const saleEvent: PaytSaleEvent = options.eventName ?? "Purchase";
  const base = offline();
  const h = { ...base, ...pagePixelHarness(base) };
  h.channel.conversionEngineMode = "canonical";
  await h.production.processItem({
    workspaceId: "w",
    productionItemId: "item",
  });
  await h.processor.process(h.jobs[0]);
  expect(h.logs[0]).toMatchObject({
    eventName: "LeadSubmitted",
    adId: null,
    status: "sent",
  });
  h.prisma.inboundWebhookEvent.findFirst = vi.fn(async () => ({
    ...h.event,
    productionItem: h.item,
  }));
  if (options.leadAdId) {
    h.leads[0].adId = options.leadAdId;
    if (options.entryAdHint) {
      h.logs[0].adId = options.leadAdId;
      h.event.adId = options.leadAdId;
      h.event.classificationReason = "authorized_ctwa_destination_ad_hint";
    }
  }
  const restoreEventLookup = h.prisma.inboundWebhookEvent.findFirst;
  if (options.withoutProof)
    h.prisma.inboundWebhookEvent.findFirst = vi.fn(async () => null);

  const sale = {
    transaction_id: "SYNTH-ORDER-1",
    seller_id: "SYNTH-SELLER",
    status: paytStatusByEvent[saleEvent],
    test: true,
    customer: { phone: h.payload.phone },
    product: { code: options.productCode ?? "SYNTHPROD", name: "Curso" },
    transaction: {
      payment_status:
        saleEvent === "Purchase" ? "paid" : paytStatusByEvent[saleEvent],
      total_price: options.totalPriceCents ?? 19700,
      created_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
    },
  };
  const purchaseKey = buildProviderPurchaseIdentity({
    workspaceId: "w",
    provider: "payt",
    accountRef: sale.seller_id,
    orderRef: sale.transaction_id,
    eventName: saleEvent,
  });
  const leadResolution = await new ProviderConversionPaidLeadResolver(
    h.prisma,
  ).resolve({
    workspaceId: "w",
    phone: h.payload.phone,
    ctwaProofAnyChannel: true,
  });
  h.prisma.inboundWebhookEvent.findFirst = restoreEventLookup;
  if (options.decisionWithoutProof && leadResolution.status === "resolved")
    delete (leadResolution.lead as { ctwaDestination?: unknown })
      .ctwaDestination;
  const claims = new Map<string, any>();
  const claimDelegate = {
    findUnique: vi.fn(
      async ({ where }: any) =>
        claims.get(JSON.stringify(where.workspaceId_effectMode_purchaseKey)) ??
        null,
    ),
    findFirst: vi.fn(
      async ({ where }: any) =>
        [...claims.values()].find((claim) =>
          Object.entries(where).every(([key, value]) => claim[key] === value),
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: any) => {
      const key = JSON.stringify({
        workspaceId: data.workspaceId,
        effectMode: data.effectMode,
        purchaseKey: data.purchaseKey,
      });
      if (claims.has(key)) throw new Error("unique");
      const claim = { id: `claim_${claims.size}`, ...data };
      claims.set(key, claim);
      return claim;
    }),
  };
  h.prisma.providerPurchaseClaim = claimDelegate;
  h.prisma.purchaseReview = { updateMany: vi.fn(async () => ({ count: 0 })) };

  const executions = new Map<string, any>();
  function paytExecution(input: {
    id: string;
    ruleId: string;
    deliveryId: string;
    ruleChannels?: string[];
    /** Payt rules may sit on ANY WhatsApp connection of the workspace. */
    ruleConnectionId?: string;
    /** Callback received before the rule/channel production activation. */
    receivedBeforeActivation?: boolean;
    normalizedResult?: Record<string, unknown> | null;
    /** Fase 4: delivery routed by the workspace integration URL. */
    integrationEndpointId?: string;
    productFilterCodes?: string[];
  }) {
    const ruleConnectionId = input.ruleConnectionId ?? "c";
    const occurredAt = new Date();
    const rule: any = {
      providerRuleId: input.ruleId,
      conversionRuleId: `conversion_${input.ruleId}`,
      version: new Date().toISOString(),
      triggerType: "provider_automation",
      eventName: saleEvent,
      mode: "production",
      active: true,
      authorScope: null,
      triggerPhrases: [],
      defaultValueCents: null,
      defaultCurrency: null,
      defaultContentName: null,
      valueMode: "fixed",
      exampleMessage: null,
    };
    const decision = new ProviderConversionDecisionEngine().evaluate({
      parserVersion: "automation-v1",
      rule,
      catalog: null,
      leadResolution,
      contactIdentityHash: h.leads[0].phoneHash,
      occurrence: {
        source: "automation",
        provider: "payt",
        workspaceId: "w",
        // The Payt rule endpoint sits on the WhatsApp connection.
        connectionId: ruleConnectionId,
        channelId: "ch",
        externalDeliveryId: input.deliveryId,
        externalEventId: purchaseKey,
        externalMessageId: null,
        occurrenceKey: purchaseKey,
        purchaseKey,
        eventName: saleEvent,
        occurredAt: occurredAt.toISOString(),
        authorType: null,
        automation: paytAutomationByEvent[saleEvent],
        observedValueCents: sale.transaction.total_price,
        observedCurrency: "BRL",
      },
    });
    expect(decision?.decisionCode).toBe("eligible");
    expect(providerConversionDecisionSchema.safeParse(decision).success).toBe(
      true,
    );
    const execution: any = {
      id: input.id,
      workspaceId: "w",
      channelId: "ch",
      channel: h.channel,
      leadId: h.leads[0].id,
      providerRuleId: input.ruleId,
      sourceDeliveryId: input.deliveryId,
      externalExecutionKey: purchaseKey,
      status: "eligible",
      occurredAt,
      providerDecisionId: `decision_${input.id}`,
      providerDecision: {
        id: `decision_${input.id}`,
        workspaceId: "w",
        providerRuleId: input.ruleId,
        sourceDeliveryId: input.deliveryId,
        decisionCode: "eligible",
        occurrenceKey: purchaseKey,
        eventName: saleEvent,
        occurredAt,
        leadId: h.leads[0].id,
        decisionVersion: 1,
        decisionJson: decision,
      },
      providerRule: {
        ...rule,
        id: input.ruleId,
        connectionId: ruleConnectionId,
        mode: "production",
        productionActivatedAt: h.channel.productionActivatedAt,
        removedAt: null,
        productFilterCodes: input.productFilterCodes ?? [],
        conversionRule: { ...rule, active: true },
        parserRelease: {
          provider: "payt",
          version: "automation-v1",
          status: "certified",
        },
        connection: { ...h.channel.connection, id: ruleConnectionId },
        channels: (input.ruleChannels ?? ["ch"]).map((channelId) => ({
          channelId,
        })),
      },
      sourceDelivery: {
        ...h.event.delivery,
        id: input.deliveryId,
        connectionId: ruleConnectionId,
        providerRuleEndpointId: `endpoint_${input.ruleId}`,
        integrationEndpointId: input.integrationEndpointId ?? null,
        purpose: "conversion_automation",
        parserVersion: "automation-v1",
        firstReceivedAt: input.receivedBeforeActivation
          ? new Date(h.channel.productionActivatedAt.getTime() - 1_800_000)
          : occurredAt,
      },
      contactIdentityHash: h.leads[0].phoneHash,
      purchaseReview: null,
      normalizedResult: input.normalizedResult ?? null,
    };
    executions.set(execution.id, execution);
    return execution;
  }
  h.prisma.providerConversionRuleExecution = {
    findFirst: vi.fn(async ({ where }: any) =>
      typeof where.id === "string" ? (executions.get(where.id) ?? null) : null,
    ),
    update: vi.fn(async ({ where, data }: any) =>
      Object.assign(executions.get(where.id), data),
    ),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const execution = executions.get(where.id);
      if (!execution) return { count: 0 };
      Object.assign(execution, data);
      return { count: 1 };
    }),
  };
  const service = new ProviderConversionProductionService(
    h.prisma,
    { decrypt: () => Buffer.from(JSON.stringify(sale)) } as any,
    new InboundWebhookParserRegistry(),
    {} as any,
    new InboundWebhookMetaRouteReaderService(h.prisma),
    h.conversions,
    h.queue,
    // No billing module in this edition.
    env,
  );
  return {
    h,
    sale,
    purchaseKey,
    leadResolution,
    claims,
    paytExecution,
    service,
  };
}

describe("Payt purchase for a no-ad CTWA lead (authorized_ctwa_destination)", () => {
  it.each(["c", "payt_host_connection"])(
    "resolves the lead only by its verified entry proof and sends one page/pixel Purchase (rule on connection %s)",
    async (ruleConnectionId) => {
      const s = await paytNoAdScenario();
      expect(s.leadResolution).toMatchObject({
        status: "resolved",
        lead: {
          adId: null,
          ctwaClid: s.h.payload.ctwa_clid,
          ctwaDestination: {
            channelId: "ch",
            connectionId: "c",
            deliveryKind: "page_pixel",
            pageId: "synthetic_page",
          },
        },
      });
      const execution = s.paytExecution({
        id: "execution_a",
        ruleId: "rule_a",
        deliveryId: "payt_delivery_1",
        ruleConnectionId,
      });

      await expect(
        s.service.processExecution({
          workspaceId: "w",
          providerConversionExecutionId: execution.id,
        }),
      ).resolves.toEqual({ status: "materialized" });

      const purchase = s.h.logs.find((log) => log.eventName === "Purchase");
      expect(purchase).toMatchObject({
        adId: null,
        metaAccountId: null,
        campaignId: null,
        attributionStatus: "ctwa_ad_unknown",
        ctwaClid: s.h.payload.ctwa_clid,
        valueCents: 19700,
        currency: "BRL",
        valueSource: "actual",
        dedupeKey: s.purchaseKey,
        eventId: `conversion_purchase_${s.purchaseKey.slice(9)}`,
        status: "ready_to_send",
      });
      expect(purchase.sourcePayload).toMatchObject({
        provider: "payt",
        processingMode: "frozen_provider_conversion",
        ctwaDestination: { channelId: "ch", pageId: "synthetic_page" },
      });
      expect(s.claims.size).toBe(1);

      const job = s.h.jobs.at(-1);
      expect(await s.h.processor.process(job)).toMatchObject({
        status: "sent",
      });
      const sent = s.h.calls.at(-1)!;
      expect(sent.url).toContain("/synthetic_pixel/events");
      expect(sent.body.data[0]).toMatchObject({
        event_name: "Purchase",
        action_source: "business_messaging",
        messaging_channel: "whatsapp",
        user_data: {
          page_id: "synthetic_page",
          ctwa_clid: s.h.payload.ctwa_clid,
        },
        custom_data: { value: 197, currency: "BRL" },
      });
      expect(sent.body.data[0].custom_data).not.toHaveProperty("ad_id");
      // The entry LeadSubmitted was never re-created.
      expect(
        s.h.logs.filter((l) => l.eventName === "LeadSubmitted"),
      ).toHaveLength(1);
    },
  );

  it("sends one Purchase when the sale reaches two rules and is delivered three times", async () => {
    const s = await paytNoAdScenario();
    const first = s.paytExecution({
      id: "execution_a",
      ruleId: "rule_a",
      deliveryId: "payt_delivery_1",
    });
    const second = s.paytExecution({
      id: "execution_b",
      ruleId: "rule_b",
      deliveryId: "payt_delivery_2",
    });
    const results = [];
    for (const execution of [first, second, first])
      results.push(
        await s.service.processExecution({
          workspaceId: "w",
          providerConversionExecutionId: execution.id,
        }),
      );
    expect(results.map((r) => r.status)).toEqual([
      "materialized",
      "duplicate",
      "unchanged",
    ]);
    expect(second.reasonCode).toBe("purchase_duplicate");
    expect(s.h.logs.filter((l) => l.eventName === "Purchase")).toHaveLength(1);
    expect(s.claims.size).toBe(1);
  });

  it.each([
    "channel_of_other_connection",
    "channel_outside_rule",
    "lead_proof_revoked",
  ])("fails closed without a Meta event for %s", async (scenario) => {
    const s = await paytNoAdScenario();
    const execution = s.paytExecution({
      id: "execution_a",
      ruleId: "rule_a",
      deliveryId: "payt_delivery_1",
      ruleChannels: scenario === "channel_outside_rule" ? ["other"] : ["ch"],
    });
    if (scenario === "channel_of_other_connection")
      execution.channel = { ...s.h.channel, connectionId: "other_c" };
    if (scenario === "lead_proof_revoked")
      s.h.prisma.inboundWebhookEvent.findFirst = vi.fn(async () => null);
    await expect(
      s.service.processExecution({
        workspaceId: "w",
        providerConversionExecutionId: execution.id,
      }),
    ).rejects.toThrow();
    expect(s.h.logs.filter((l) => l.eventName === "Purchase")).toHaveLength(0);
    expect(s.claims.size).toBe(0);
  });
});

describe("Payt Purchase materialized by an operator-approved manual reprocess", () => {
  const approval = {
    approved: true,
    actorUserId: "synthetic_operator",
    approvedAt: new Date().toISOString(),
    reason: "operator_reprocess",
    decisionId: "decision_execution_a",
  };

  async function materializedPreActivationPurchase(
    normalizedResult: Record<string, unknown> | null,
  ) {
    const s = await paytNoAdScenario({ totalPriceCents: 83856 });
    const execution = s.paytExecution({
      id: "execution_a",
      ruleId: "rule_a",
      deliveryId: "payt_delivery_1",
      receivedBeforeActivation: true,
      normalizedResult,
    });
    await expect(
      s.service.processExecution({
        workspaceId: "w",
        providerConversionExecutionId: execution.id,
      }),
    ).resolves.toEqual({ status: "materialized" });
    const purchase = s.h.logs.find((log) => log.eventName === "Purchase");
    // Exact production shape: no ad, no pixel/page on the row, frozen payload
    // with the authorized page/pixel destination of the entry.
    expect(purchase).toMatchObject({
      status: "ready_to_send",
      valueCents: 83856,
      adId: null,
      pixelId: null,
      eventId: `conversion_purchase_${s.purchaseKey.slice(9)}`,
    });
    expect(purchase.pageId ?? null).toBeNull();
    expect(purchase.sourcePayload).toMatchObject({
      provider: "payt",
      triggerType: "provider_automation",
      processingMode: "frozen_provider_conversion",
      providerConversionExecutionId: execution.id,
      purchaseReviewId: null,
      ctwaDestination: {
        kind: "authorized_ctwa_destination",
        deliveryKind: "page_pixel",
      },
    });
    return { s, execution, purchase };
  }

  it("sends the page/pixel Purchase (business_messaging, page_id, ctwa_clid, 838.56 BRL)", async () => {
    const { s, purchase } = await materializedPreActivationPurchase({
      manualReplayApproval: approval,
    });
    const result = await s.h.processor.process(s.h.jobs.at(-1));
    expect(result).toMatchObject({ status: "sent" });
    expect(purchase).toMatchObject({
      status: "sent",
      pixelId: "synthetic_pixel",
      pageId: "synthetic_page",
    });
    const sent = s.h.calls.at(-1)!;
    expect(sent.url).toContain("/synthetic_pixel/events");
    expect(sent.body.data[0]).toMatchObject({
      event_name: "Purchase",
      event_id: purchase.eventId,
      action_source: "business_messaging",
      messaging_channel: "whatsapp",
      user_data: {
        page_id: "synthetic_page",
        ctwa_clid: s.h.payload.ctwa_clid,
      },
      custom_data: { value: 838.56, currency: "BRL" },
    });
    expect(sent.body.data[0].custom_data).not.toHaveProperty("ad_id");
  });

  it("never sends a pre-activation callback without the approval and records why it was skipped", async () => {
    const { s, execution, purchase } = await materializedPreActivationPurchase({
      manualReplayApproval: approval,
    });
    // The approval disappears (or never existed) before the send-time check.
    execution.normalizedResult = { technicalDelivery: { state: "queued" } };
    const calls = s.h.calls.length;
    const result = await s.h.processor.process(s.h.jobs.at(-1));
    expect(result).toMatchObject({
      status: "skipped",
      errorCode: CTWA_SEND_SKIPPED_ERROR_CODE,
    });
    expect(s.h.calls).toHaveLength(calls);
    expect(purchase).toMatchObject({
      status: "ready_to_send",
      errorCode: CTWA_SEND_SKIPPED_ERROR_CODE,
    });
    expect(purchase.errorMessage).toContain(
      "provider_delivery_before_activation",
    );
    // This edition's queue processor records the skipped attempt without the
    // error code (the conversion log above carries it).
    expect(s.h.prisma.jobAttempt.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "skipped" }),
      }),
    );
    // The owner can requeue it from the audit after fixing the cause.
    expect(canRetryConversionEvent(purchase)).toBe(true);
  });

  it("does not accept an approval on a rule that is not a provider automation", async () => {
    const { s, execution, purchase } = await materializedPreActivationPurchase({
      manualReplayApproval: approval,
    });
    execution.providerRule.conversionRule = {
      ...execution.providerRule.conversionRule,
      triggerType: "structured_catalog",
    };
    const calls = s.h.calls.length;
    await expect(s.h.processor.process(s.h.jobs.at(-1))).resolves.toMatchObject(
      { status: "skipped" },
    );
    expect(s.h.calls).toHaveLength(calls);
    expect(purchase.status).toBe("ready_to_send");
  });
});

describe("paid-lead resolution scope for no-ad CTWA", () => {
  it("keeps the no-ad proof opt-in: without a connection or the Payt flag the lead stays unattributed", async () => {
    const s = await paytNoAdScenario();
    await expect(
      new ProviderConversionPaidLeadResolver(s.h.prisma).resolve({
        workspaceId: "w",
        phone: s.h.payload.phone,
      }),
    ).resolves.toMatchObject({
      status: "not_found",
      reasonCode: "paid_attribution_missing",
    });
  });
});

describe("Payt purchase for a CTWA lead WITH an ad id and no saved per-ad Meta route", () => {
  const AD = "120210000000000999";

  it.each([
    ["the ad-hint entry (ad origin found, no saved route)", true],
    ["an older ad id on the lead (no ad entry origin)", false],
  ])(
    "falls back to the authorized page/pixel destination for %s",
    async (_label, entryAdHint) => {
      const s = await paytNoAdScenario({ leadAdId: AD, entryAdHint });
      expect(s.leadResolution).toMatchObject({
        status: "resolved",
        lead: {
          adId: AD,
          ctwaDestination: { channelId: "ch", deliveryKind: "page_pixel" },
        },
      });
      expect(s.h.channel.routes).toEqual([]);
      const execution = s.paytExecution({
        id: "execution_a",
        ruleId: "rule_a",
        deliveryId: "payt_delivery_1",
      });
      await expect(
        s.service.processExecution({
          workspaceId: "w",
          providerConversionExecutionId: execution.id,
        }),
      ).resolves.toEqual({ status: "materialized" });
      const purchase = s.h.logs.find((log) => log.eventName === "Purchase");
      expect(purchase).toMatchObject({
        adId: AD,
        metaAccountId: null,
        attributionStatus: "ctwa_ad_hint",
        metaBusinessConnectionId: "bm",
        metaConversionDestinationId: "dest",
        ctwaClid: s.h.payload.ctwa_clid,
        valueCents: 19700,
        dedupeKey: s.purchaseKey,
      });
      expect(purchase.sourcePayload).toMatchObject({
        provider: "payt",
        ctwaDestination: {
          kind: "authorized_ctwa_destination",
          channelId: "ch",
          pageId: "synthetic_page",
        },
      });
      expect(s.claims.size).toBe(1);
    },
  );

  it("keeps the resolved per-ad route unchanged when it exists", async () => {
    const s = await paytNoAdScenario({ leadAdId: AD, entryAdHint: true });
    const execution = s.paytExecution({
      id: "execution_a",
      ruleId: "rule_a",
      deliveryId: "payt_delivery_1",
    });
    const adRoute = vi
      .spyOn(s.service as any, "previewPurchaseRoute")
      .mockResolvedValue({
        status: "resolved",
        reason: "resolved",
        reportingAccountId: "account0_1",
        adAccountId: "act_synthetic",
        businessConnectionId: "bm",
        conversionDestinationId: "dest",
      });
    await expect(
      s.service.processExecution({
        workspaceId: "w",
        providerConversionExecutionId: execution.id,
      }),
    ).resolves.toEqual({ status: "materialized" });
    expect(adRoute).toHaveBeenCalledWith(expect.anything(), AD);
    const purchase = s.h.logs.find((log) => log.eventName === "Purchase");
    expect(purchase).toMatchObject({
      adId: AD,
      metaAccountId: "act_synthetic",
      attributionStatus: "attributed",
    });
    expect(purchase.sourcePayload).not.toHaveProperty("ctwaDestination");
  });

  it("still fails with the route reason when there is no verified CTWA proof", async () => {
    const s = await paytNoAdScenario({
      leadAdId: AD,
      entryAdHint: true,
      withoutProof: true,
    });
    expect(s.leadResolution).toMatchObject({
      status: "resolved",
      lead: { adId: AD },
    });
    expect((s.leadResolution as any).lead.ctwaDestination ?? null).toBeNull();
    const execution = s.paytExecution({
      id: "execution_a",
      ruleId: "rule_a",
      deliveryId: "payt_delivery_1",
    });
    // No verified entry receipt exists, so the live proof fails as well.
    s.h.prisma.inboundWebhookEvent.findFirst = vi.fn(async () => null);
    await expect(
      s.service.processExecution({
        workspaceId: "w",
        providerConversionExecutionId: execution.id,
      }),
    ).rejects.toMatchObject({
      // Workspace-inherited routing: the reason of the workspace ad route.
      code: expect.stringMatching(/^provider_conversion_route_/),
    });
    expect(s.h.logs.filter((l) => l.eventName === "Purchase")).toHaveLength(0);
    expect(s.claims.size).toBe(0);
  });
});

describe("Reprocess of a Payt ad-lead purchase frozen before the CTWA fallback", () => {
  const AD = "120210000000000999";

  it.each([
    ["ad-hint entry (ad origin found, route missing)", true],
    ["older ad id on the lead (no ad entry origin)", false],
  ])(
    "verifies the CTWA proof live and materializes via authorized_ctwa_destination: %s",
    async (_label, entryAdHint) => {
      const s = await paytNoAdScenario({
        leadAdId: AD,
        entryAdHint,
        decisionWithoutProof: true,
      });
      const execution = s.paytExecution({
        id: "execution_a",
        ruleId: "rule_a",
        deliveryId: "payt_delivery_1",
      });
      // The frozen decision is the pre-fix shape: ad lead, no proof.
      const frozenLead =
        execution.providerDecision.decisionJson.leadResolution.lead;
      expect(frozenLead.adId).toBe(AD);
      expect(frozenLead).not.toHaveProperty("ctwaDestination");
      expect(s.h.channel.routes).toEqual([]);

      await expect(
        s.service.processExecution({
          workspaceId: "w",
          providerConversionExecutionId: execution.id,
        }),
      ).resolves.toEqual({ status: "materialized" });
      const purchase = s.h.logs.find((log) => log.eventName === "Purchase");
      expect(purchase).toMatchObject({
        adId: AD,
        attributionStatus: "ctwa_ad_hint",
        metaConversionDestinationId: "dest",
        dedupeKey: s.purchaseKey,
      });
      expect(purchase.sourcePayload).toMatchObject({
        ctwaDestination: {
          kind: "authorized_ctwa_destination",
          channelId: "ch",
          pageId: "synthetic_page",
        },
      });
      // The frozen decision itself was never rewritten.
      expect(
        execution.providerDecision.decisionJson.leadResolution.lead,
      ).not.toHaveProperty("ctwaDestination");
    },
  );

  it("still fails with the route reason when the live proof does not verify", async () => {
    const s = await paytNoAdScenario({
      leadAdId: AD,
      entryAdHint: true,
      decisionWithoutProof: true,
    });
    const execution = s.paytExecution({
      id: "execution_a",
      ruleId: "rule_a",
      deliveryId: "payt_delivery_1",
    });
    s.h.prisma.inboundWebhookEvent.findFirst = vi.fn(async () => null);
    await expect(
      s.service.processExecution({
        workspaceId: "w",
        providerConversionExecutionId: execution.id,
      }),
    ).rejects.toMatchObject({
      // Workspace-inherited routing: the reason of the workspace ad route.
      code: expect.stringMatching(/^provider_conversion_route_/),
    });
    expect(s.h.logs.filter((l) => l.eventName === "Purchase")).toHaveLength(0);
  });
});

describe("Payt purchase of an ad lead on an Unnichat channel inheriting the workspace Meta routing", () => {
  const AD = "120210000000000555";

  async function inheritScenario() {
    // Entry resolved through the workspace ad route (classification
    // "route_resolved"): there is no CTWA destination proof for this lead.
    const s = await paytNoAdScenario({
      leadAdId: AD,
      entryAdHint: true,
      withoutProof: true,
    });
    s.h.event.classificationReason = "route_resolved";
    s.h.prisma.inboundWebhookEvent.findFirst = vi.fn(async () => null);
    s.h.channel.metaRoutingMode = "inherit_workspace";
    s.h.channel.routes = [];
    const execution = s.paytExecution({
      id: "execution_a",
      ruleId: "rule_a",
      deliveryId: "payt_delivery_1",
    });
    const workspaceRoute = vi.spyOn(
      (s.service as any).routes as InboundWebhookMetaRouteReaderService,
      "previewRoute",
    );
    return { s, execution, workspaceRoute };
  }

  it("resolves the purchase through the workspace ad route like the entry did", async () => {
    const { s, execution, workspaceRoute } = await inheritScenario();
    workspaceRoute.mockResolvedValue({
      status: "resolved",
      reason: "resolved",
      reportingAccountId: "account0_1",
      adAccountId: "act_synthetic",
      businessConnectionId: "bm",
      conversionDestinationId: "dest",
    } as any);
    await expect(
      s.service.processExecution({
        workspaceId: "w",
        providerConversionExecutionId: execution.id,
      }),
    ).resolves.toEqual({ status: "materialized" });
    expect(workspaceRoute).toHaveBeenCalledWith({ workspaceId: "w", adId: AD });
    const purchase = s.h.logs.find((log) => log.eventName === "Purchase");
    expect(purchase).toMatchObject({
      adId: AD,
      metaAccountId: "act_synthetic",
      attributionStatus: "attributed",
    });
    expect(purchase.sourcePayload).not.toHaveProperty("ctwaDestination");
  });

  it("keeps failing with the workspace route reason when the ad does not resolve and there is no proof", async () => {
    const { s, execution, workspaceRoute } = await inheritScenario();
    workspaceRoute.mockResolvedValue({
      status: "unresolved",
      reason: "ad_not_found",
    } as any);
    await expect(
      s.service.processExecution({
        workspaceId: "w",
        providerConversionExecutionId: execution.id,
      }),
    ).rejects.toMatchObject({ code: "provider_conversion_route_ad_not_found" });
  });
});

describe("Payt value without installment interest (decisions frozen before the fix)", () => {
  // Real-shaped 12x card sale: 12 x R$ 24,80 = R$ 297,60 with interest; the
  // sale value is R$ 247,00. The scenario freezes the decision with the
  // postback's total_price (the value the parser used before the fix).
  const installmentSale = (s: Awaited<ReturnType<typeof paytNoAdScenario>>) => {
    Object.assign(s.sale.transaction as Record<string, unknown>, {
      installments: 12,
      installment_price: 2480,
      total_price: 29760,
      price_without_installments: 24700,
    });
  };
  const run = (
    s: Awaited<ReturnType<typeof paytNoAdScenario>>,
    executionId: string,
  ) =>
    s.service.processExecution({
      workspaceId: "w",
      providerConversionExecutionId: executionId,
    });

  it("sends the corrected value once for a decision frozen with the legacy total_price", async () => {
    const s = await paytNoAdScenario({ totalPriceCents: 29760 });
    const first = s.paytExecution({
      id: "execution_a",
      ruleId: "rule_a",
      deliveryId: "payt_delivery_1",
    });
    const second = s.paytExecution({
      id: "execution_b",
      ruleId: "rule_b",
      deliveryId: "payt_delivery_2",
    });
    expect(first.providerDecision.decisionJson.conversion.valueCents).toBe(
      29760,
    );
    installmentSale(s);

    await expect(run(s, first.id)).resolves.toEqual({
      status: "materialized",
    });
    const purchases = s.h.logs.filter((log) => log.eventName === "Purchase");
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      eventId: `conversion_purchase_${s.purchaseKey.slice(9)}`,
      dedupeKey: s.purchaseKey,
      valueCents: 24700,
      currency: "BRL",
    });
    expect(purchases[0].sourcePayload.valueCorrection).toMatchObject({
      previousValueCents: 29760,
      reason: "payt_price_without_installments",
    });
    // The execution keeps the value that travelled.
    expect(first).toMatchObject({ status: "materialized", valueCents: 24700 });
    expect(s.claims.size).toBe(1);

    // The same sale through another rule never sends twice.
    await expect(run(s, second.id)).resolves.toEqual({ status: "duplicate" });
    expect(s.h.logs.filter((log) => log.eventName === "Purchase")).toHaveLength(
      1,
    );
    expect(s.claims.size).toBe(1);
  });

  it("sends a decision frozen after the fix as decided, without a correction mark", async () => {
    const s = await paytNoAdScenario({ totalPriceCents: 24700 });
    const execution = s.paytExecution({
      id: "execution_a",
      ruleId: "rule_a",
      deliveryId: "payt_delivery_1",
    });
    installmentSale(s);

    await expect(run(s, execution.id)).resolves.toEqual({
      status: "materialized",
    });
    const purchase = s.h.logs.find((log) => log.eventName === "Purchase");
    expect(purchase.valueCents).toBe(24700);
    expect(purchase.sourcePayload).not.toHaveProperty("valueCorrection");
    expect(execution).not.toHaveProperty("valueCents");
  });

  it("still refuses a frozen value that matches neither the new nor the legacy one", async () => {
    const s = await paytNoAdScenario({ totalPriceCents: 11111 });
    const execution = s.paytExecution({
      id: "execution_a",
      ruleId: "rule_a",
      deliveryId: "payt_delivery_1",
    });
    installmentSale(s);

    await expect(run(s, execution.id)).rejects.toMatchObject({
      code: "provider_conversion_source_event_mismatch",
    });
    expect(s.h.logs.filter((log) => log.eventName === "Purchase")).toHaveLength(
      0,
    );
    expect(s.claims.size).toBe(0);
  });
});
