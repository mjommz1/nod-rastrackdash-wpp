import { describe, expect, it } from "vitest";
import {
  ReportingMetricsEngine,
  type ReportingInsightInput,
  type ReportingMetricEvent,
  type ReportingMetricLead,
} from "../src/reporting/reporting-metrics.engine";

const engine = new ReportingMetricsEngine();

const insight: ReportingInsightInput = {
  metaConversationsStarted: 20,
  spendCents: 100000,
};

function lead(input: Partial<ReportingMetricLead>): ReportingMetricLead {
  return {
    adId: null,
    adSetId: null,
    businessSource: null,
    campaignId: null,
    ctwaClid: null,
    customerIdentityKey: "phone_a",
    firstMessageAt: new Date("2026-07-10T10:00:00.000Z"),
    id: "lead_1",
    phoneHash: "phone_a",
    ...input,
  };
}

function event(input: Partial<ReportingMetricEvent>): ReportingMetricEvent {
  return {
    adId: null,
    adSetId: null,
    businessSource: null,
    campaignId: null,
    ctwaClid: null,
    currency: "BRL",
    customerIdentityKey: "phone_a",
    eventName: "Purchase",
    eventOccurredAt: new Date("2026-07-10T11:00:00.000Z"),
    id: "event_1",
    phoneHash: "phone_a",
    purchaseKind: null,
    status: "sent",
    valueCents: 10000,
    ...input,
  };
}

describe("ReportingMetricsEngine", () => {
  it("counts a paid lead once even with its LeadSubmitted event", () => {
    const metrics = engine.calculate({
      events: [
        event({
          campaignId: "cmp_1",
          eventName: "LeadSubmitted",
          id: "lead_submitted_1",
          valueCents: null,
        }),
      ],
      insight,
      leads: [lead({ campaignId: "cmp_1" })],
      scope: { campaignId: "cmp_1" },
    });

    expect(metrics.realConversations).toBe(1);
    expect(metrics.totalReceived).toBe(1);
    expect(metrics.trackingRate).toBe(1);
    expect(metrics.costPerRealConversationCents).toBe(100000);
    expect(metrics.funnelSteps).toEqual([
      {
        key: "real_conversations",
        label: "Leads novos",
        value: 1,
        costCents: 100000,
      },
    ]);
  });

  it("separates paid conversations from organic leads and calculates tracking rate", () => {
    const metrics = engine.calculate({
      events: [],
      insight,
      leads: [
        lead({ campaignId: "cmp_1", id: "lead_paid", phoneHash: "phone_a" }),
        lead({
          businessSource: "organic",
          customerIdentityKey: "phone_b",
          id: "lead_organic",
          phoneHash: "phone_b",
        }),
        lead({
          customerIdentityKey: "phone_c",
          id: "lead_unattributed",
          phoneHash: "phone_c",
        }),
      ],
      scope: {},
    });

    expect(metrics.realConversations).toBe(1);
    expect(metrics.organicLeads).toBe(2);
    expect(metrics.totalReceived).toBe(3);
    expect(metrics.trackingRate).toBe(1 / 3);
  });

  it("treats ctwa_clid as paid attribution before Meta hierarchy is resolved", () => {
    const metrics = engine.calculate({
      events: [
        event({
          businessSource: "paid",
          ctwaClid: "ctwa_1",
          eventName: "LeadSubmitted",
          id: "lead_submitted_1",
          valueCents: null,
        }),
      ],
      insight,
      leads: [lead({ ctwaClid: "ctwa_1" })],
      scope: {},
    });

    expect(metrics.realConversations).toBe(1);
    expect(metrics.organicLeads).toBe(0);
    expect(metrics.totalReceived).toBe(1);
    expect(metrics.trackingRate).toBe(1);
  });

  it("counts failed business events and ignores skipped events", () => {
    const metrics = engine.calculate({
      events: [
        event({
          campaignId: "cmp_1",
          eventName: "QualifiedLead",
          id: "qualified_error",
          status: "error",
          valueCents: null,
        }),
        event({
          campaignId: "cmp_1",
          eventName: "Purchase",
          id: "purchase_error",
          status: "error",
          valueCents: 50000,
        }),
        event({
          campaignId: "cmp_1",
          eventName: "Purchase",
          id: "purchase_skipped",
          status: "skipped",
          valueCents: 90000,
        }),
      ],
      insight,
      leads: [lead({ campaignId: "cmp_1" })],
      scope: { campaignId: "cmp_1" },
    });

    expect(metrics.qualifiedLead).toBe(1);
    expect(metrics.purchases).toBe(1);
    expect(metrics.trafficRevenueCents).toBe(50000);
    expect(metrics.funnelSteps.map((step) => step.key)).toEqual([
      "real_conversations",
      "qualified_lead",
      "purchase",
      "first_purchase",
    ]);
  });

  it("splits traffic purchases by explicit and inferred purchase kind", () => {
    const metrics = engine.calculate({
      events: [
        event({
          campaignId: "cmp_1",
          eventOccurredAt: new Date("2026-07-10T11:00:00.000Z"),
          id: "explicit_first",
          purchaseKind: "first_purchase",
          valueCents: 100000,
        }),
        event({
          campaignId: "cmp_1",
          customerIdentityKey: "phone_b",
          eventOccurredAt: new Date("2026-07-11T11:00:00.000Z"),
          id: "inferred_first",
          phoneHash: "phone_b",
          valueCents: 70000,
        }),
        event({
          campaignId: "cmp_1",
          customerIdentityKey: "phone_b",
          eventOccurredAt: new Date("2026-07-12T11:00:00.000Z"),
          id: "inferred_repurchase",
          phoneHash: "phone_b",
          valueCents: 30000,
        }),
        event({
          campaignId: "cmp_1",
          customerIdentityKey: null,
          eventOccurredAt: new Date("2026-07-13T11:00:00.000Z"),
          id: "identity_missing",
          phoneHash: null,
          valueCents: 20000,
        }),
      ],
      insight,
      leads: [lead({ campaignId: "cmp_1" })],
      scope: { campaignId: "cmp_1" },
    });

    expect(metrics.purchases).toBe(4);
    expect(metrics.firstPurchases).toBe(3);
    expect(metrics.repurchases).toBe(1);
    expect(metrics.firstPurchaseRevenueCents).toBe(190000);
    expect(metrics.repurchaseRevenueCents).toBe(30000);
    expect(metrics.roasAcquisition).toBe(1.9);
    expect(metrics.roasWithRepurchase).toBe(2.2);
  });

  it("keeps configured empty funnel events visible and keeps organic revenue out of ROAS", () => {
    const metrics = engine.calculate({
      configuredEvents: new Set(["QualifiedLead", "Purchase"]),
      events: [
        event({
          businessSource: "organic",
          campaignId: null,
          customerIdentityKey: "phone_b",
          id: "organic_purchase",
          phoneHash: "phone_b",
          valueCents: 25000,
        }),
      ],
      insight,
      leads: [lead({ campaignId: "cmp_1" })],
      scope: {},
    });

    expect(metrics.qualifiedLead).toBe(0);
    expect(metrics.purchases).toBe(1);
    expect(metrics.trafficRevenueCents).toBe(0);
    expect(metrics.organicRevenueCents).toBe(25000);
    expect(metrics.totalRevenueCents).toBe(25000);
    expect(metrics.firstPurchaseRevenueCents).toBe(25000);
    expect(metrics.roasAcquisition).toBeNull();
    expect(metrics.roasWithRepurchase).toBeNull();
    expect(metrics.funnelSteps.map((step) => step.key)).toEqual([
      "real_conversations",
      "qualified_lead",
      "purchase",
      "first_purchase",
    ]);
  });

  it("does not count a conversation event without its lead as a lead", () => {
    const metrics = engine.calculate({
      events: [
        event({
          businessSource: "organic",
          customerIdentityKey: "phone_b",
          eventName: "LeadSubmitted",
          id: "organic_lead_submitted",
          phoneHash: "phone_b",
          valueCents: null,
        }),
      ],
      insight,
      leads: [],
      scope: {},
    });

    // Leads come from lead rows (first contact); an event alone is not one.
    expect(metrics.realConversations).toBe(0);
    expect(metrics.organicLeads).toBe(0);
    expect(metrics.totalReceived).toBe(0);
    expect(metrics.adConversationEvents).toBe(0);
  });

  it("does not inflate real conversations from downstream attributed events", () => {
    const metrics = engine.calculate({
      events: [
        event({
          campaignId: "cmp_1",
          eventName: "QualifiedLead",
          id: "qualified_without_lead",
          valueCents: null,
        }),
        event({
          campaignId: "cmp_1",
          eventName: "Purchase",
          id: "purchase_without_lead",
          valueCents: 50000,
        }),
      ],
      insight,
      leads: [],
      scope: { campaignId: "cmp_1" },
    });

    expect(metrics.realConversations).toBe(0);
    expect(metrics.organicLeads).toBe(0);
    expect(metrics.totalReceived).toBe(0);
    expect(metrics.qualifiedLead).toBe(1);
    expect(metrics.purchases).toBe(1);
  });

  it("does not inflate organic leads from organic downstream purchase events", () => {
    const metrics = engine.calculate({
      events: [
        event({
          businessSource: "organic",
          customerIdentityKey: "phone_b",
          id: "organic_purchase_without_lead",
          phoneHash: "phone_b",
          valueCents: 25000,
        }),
      ],
      insight,
      leads: [],
      scope: {},
    });

    expect(metrics.organicLeads).toBe(0);
    expect(metrics.totalReceived).toBe(0);
    expect(metrics.organicRevenueCents).toBe(25000);
    expect(metrics.firstPurchaseRevenueCents).toBe(25000);
  });

  it("includes organic repurchase revenue in the first and repurchase split without changing paid ROAS", () => {
    const metrics = engine.calculate({
      events: [
        event({
          campaignId: "cmp_1",
          customerIdentityKey: "phone_paid",
          eventOccurredAt: new Date("2026-07-10T11:00:00.000Z"),
          id: "paid_first",
          phoneHash: "phone_paid",
          valueCents: 100000,
        }),
        event({
          businessSource: "organic",
          customerIdentityKey: "phone_organic",
          eventOccurredAt: new Date("2026-07-10T12:00:00.000Z"),
          id: "organic_first",
          phoneHash: "phone_organic",
          valueCents: 25000,
        }),
        event({
          businessSource: "organic",
          customerIdentityKey: "phone_organic",
          eventOccurredAt: new Date("2026-07-11T12:00:00.000Z"),
          id: "organic_repurchase",
          phoneHash: "phone_organic",
          valueCents: 15000,
        }),
      ],
      insight,
      leads: [lead({ campaignId: "cmp_1" })],
      scope: {},
    });

    expect(metrics.trafficRevenueCents).toBe(100000);
    expect(metrics.organicRevenueCents).toBe(40000);
    expect(metrics.firstPurchaseRevenueCents).toBe(125000);
    expect(metrics.repurchaseRevenueCents).toBe(15000);
    expect(metrics.roasAcquisition).toBe(1);
    expect(metrics.roasWithRepurchase).toBe(1);
  });

  it("labels revenue calculated from the configured average purchase value", () => {
    const metrics = engine.calculate({
      events: [
        event({
          campaignId: "cmp_1",
          id: "estimated_purchase",
          valueCents: 400000,
          valueSource: "configured_average",
        }),
      ],
      insight,
      leads: [lead({ campaignId: "cmp_1" })],
      scope: { campaignId: "cmp_1" },
    });

    expect(metrics.totalRevenueCents).toBe(400000);
    expect(metrics.estimatedRevenueCents).toBe(400000);
    expect(metrics.hasEstimatedRevenue).toBe(true);
  });

  it("uses the configured labels, visibility and order for funnel stages", () => {
    const metrics = engine.calculate({
      funnelStages: [
        {
          eventName: "OrderDelivered",
          label: "Pedidos entregues",
          position: 1,
          visible: true,
        },
        {
          eventName: "QualifiedLead",
          label: "Oportunidades",
          position: 2,
          visible: true,
        },
        {
          eventName: "LeadSubmitted",
          label: "Conversas",
          position: 3,
          visible: false,
        },
      ],
      events: [
        event({
          campaignId: "cmp_1",
          eventName: "OrderDelivered",
          id: "delivered_1",
          valueCents: null,
        }),
        event({
          campaignId: "cmp_1",
          eventName: "QualifiedLead",
          id: "qualified_1",
          valueCents: null,
        }),
      ],
      insight,
      leads: [lead({ campaignId: "cmp_1" })],
      scope: { campaignId: "cmp_1" },
    });

    expect(metrics.funnelSteps).toEqual([
      {
        key: "event_order_delivered",
        label: "Pedidos entregues",
        value: 1,
        costCents: 100000,
      },
      {
        key: "qualified_lead",
        label: "Oportunidades",
        value: 1,
        costCents: 100000,
      },
    ]);
  });

  it("counts InitiateCheckout from funnel stages with cost per checkout", () => {
    const metrics = engine.calculate({
      funnelStages: [
        {
          eventName: "LeadSubmitted",
          label: "Conversas reais iniciadas",
          position: 1,
          visible: true,
        },
        {
          eventName: "InitiateCheckout",
          label: "Checkout iniciado",
          position: 2,
          visible: true,
        },
        {
          eventName: "Purchase",
          label: "Compras",
          position: 3,
          visible: true,
        },
      ],
      events: [
        event({
          campaignId: "cmp_1",
          eventName: "InitiateCheckout",
          id: "ic_1",
          valueCents: 25000,
        }),
        event({
          campaignId: "cmp_1",
          eventName: "InitiateCheckout",
          id: "ic_2",
          valueCents: 25000,
        }),
        event({
          campaignId: "cmp_1",
          eventName: "Purchase",
          id: "purchase_1",
          valueCents: 300000,
        }),
      ],
      insight,
      leads: [lead({ campaignId: "cmp_1" })],
      scope: { campaignId: "cmp_1" },
    });

    expect(metrics.funnelSteps).toEqual([
      {
        key: "real_conversations",
        label: "Leads novos",
        value: 1,
        costCents: 100000,
      },
      {
        key: "event_initiate_checkout",
        label: "Checkout iniciado",
        value: 2,
        costCents: 50000,
      },
      {
        key: "purchase",
        label: "Compras",
        value: 1,
        costCents: 100000,
      },
      {
        key: "first_purchase",
        label: "Primeira compra",
        value: 1,
        costCents: 100000,
      },
    ]);
  });
});

describe("ReportingMetricsEngine leads novos x leads que voltaram", () => {
  const leadSubmitted = (input: Partial<ReportingMetricEvent>) =>
    event({
      businessSource: "paid",
      campaignId: "cmp_new",
      eventName: "LeadSubmitted",
      valueCents: null,
      ...input,
    });

  it("counts each new person once even with several conversations the same day", () => {
    const metrics = engine.calculate({
      events: [
        leadSubmitted({ id: "conv_1", leadId: "lead_1" }),
        leadSubmitted({
          id: "conv_2",
          leadId: "lead_1",
          eventOccurredAt: new Date("2026-07-10T18:00:00.000Z"),
        }),
      ],
      insight,
      leads: [lead({ campaignId: "cmp_new" })],
      scope: {},
    });

    expect(metrics.realConversations).toBe(1);
    expect(metrics.adConversationEvents).toBe(2);
    expect(metrics.costPerRealConversationCents).toBe(100000);
  });

  it("keeps returning leads out of leads novos, CPL and the funnel", () => {
    const metrics = engine.calculate({
      events: [leadSubmitted({ id: "conv_new", leadId: "lead_1" })],
      insight,
      leads: [lead({ campaignId: "cmp_new" })],
      returningEvents: [
        leadSubmitted({
          id: "conv_back_1",
          leadId: "lead_old",
          phoneHash: "phone_old",
          customerIdentityKey: "phone_old",
        }),
        // Same person, second conversation in the period: still one person.
        leadSubmitted({
          id: "conv_back_2",
          leadId: "lead_old",
          phoneHash: "phone_old",
          customerIdentityKey: "phone_old",
          eventOccurredAt: new Date("2026-07-11T10:00:00.000Z"),
        }),
      ],
      scope: {},
    });

    expect(metrics.realConversations).toBe(1);
    expect(metrics.returningLeads).toBe(1);
    expect(metrics.adConversationEvents).toBe(3);
    expect(metrics.costPerRealConversationCents).toBe(100000);
    expect(metrics.funnelSteps[0]).toEqual({
      key: "real_conversations",
      label: "Leads novos",
      value: 1,
      costCents: 100000,
    });
  });

  it("does not add a returning lead to the results of the campaign that brought it back", () => {
    const input = {
      events: [],
      insight,
      // First contact (in the period) came from cmp_first.
      leads: [lead({ campaignId: "cmp_first" })],
      returningEvents: [
        leadSubmitted({
          campaignId: "cmp_back",
          id: "conv_back",
          leadId: "lead_old",
          phoneHash: "phone_old",
          customerIdentityKey: "phone_old",
        }),
      ],
    };
    const back = engine.calculate({
      ...input,
      scope: { campaignId: "cmp_back" },
    });
    const first = engine.calculate({
      ...input,
      scope: { campaignId: "cmp_first" },
    });

    expect(back.realConversations).toBe(0);
    expect(back.costPerRealConversationCents).toBeNull();
    expect(back.returningLeads).toBe(1);
    expect(first.realConversations).toBe(1);
    expect(first.returningLeads).toBe(0);
  });

  it("counts organic leads apart and never as leads de anuncio", () => {
    const metrics = engine.calculate({
      events: [],
      insight,
      leads: [
        lead({ campaignId: "cmp_new" }),
        lead({
          customerIdentityKey: "phone_organic",
          id: "lead_organic",
          phoneHash: "phone_organic",
        }),
      ],
      scope: {},
    });

    expect(metrics.realConversations).toBe(1);
    expect(metrics.organicLeads).toBe(1);
    expect(metrics.costPerRealConversationCents).toBe(100000);
  });

  it("ignores skipped and organic conversations when counting returns", () => {
    const metrics = engine.calculate({
      events: [],
      insight,
      leads: [],
      returningEvents: [
        leadSubmitted({ id: "skipped", leadId: "lead_a", status: "skipped" }),
        leadSubmitted({
          businessSource: "organic",
          campaignId: null,
          id: "organic",
          leadId: "lead_b",
        }),
      ],
      scope: {},
    });

    expect(metrics.returningLeads).toBe(0);
    expect(metrics.adConversationEvents).toBe(0);
  });

  it("puts each lead novo on the Sao Paulo day of its first contact", () => {
    const saoPauloDay = (date: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
      }).format(date);
    const counts = engine.dailyRealConversationCounts(
      {
        leads: [
          // 13/10 23:30 in Sao Paulo (02:30Z on the 14th).
          lead({
            campaignId: "cmp_new",
            firstMessageAt: new Date("2026-10-14T02:30:00.000Z"),
          }),
          // No message time: falls back to createdAt.
          lead({
            campaignId: "cmp_new",
            customerIdentityKey: "phone_b",
            firstMessageAt: null,
            createdAt: new Date("2026-10-14T15:00:00.000Z"),
            id: "lead_2",
            phoneHash: "phone_b",
          }),
          // Organic: not a lead de anuncio.
          lead({
            customerIdentityKey: "phone_c",
            firstMessageAt: new Date("2026-10-14T15:00:00.000Z"),
            id: "lead_3",
            phoneHash: "phone_c",
          }),
        ],
      },
      saoPauloDay,
    );
    const returning = engine.dailyReturningLeadCounts(
      {
        returningEvents: [
          leadSubmitted({
            eventOccurredAt: new Date("2026-10-14T12:00:00.000Z"),
            id: "back_1",
            leadId: "lead_old",
          }),
          leadSubmitted({
            eventOccurredAt: new Date("2026-10-14T20:00:00.000Z"),
            id: "back_2",
            leadId: "lead_old",
          }),
        ],
      },
      saoPauloDay,
    );

    expect(Object.fromEntries(counts)).toEqual({
      "2026-10-13": 1,
      "2026-10-14": 1,
    });
    expect(Object.fromEntries(returning)).toEqual({ "2026-10-14": 1 });
  });

  it("renames only the old default label of the LeadSubmitted stage", () => {
    const stages = (label: string) => [
      {
        eventName: "LeadSubmitted" as const,
        label,
        position: 1,
        visible: true,
      },
    ];
    const legacy = engine.calculate({
      events: [],
      funnelStages: stages("Conversas reais iniciadas"),
      insight,
      leads: [],
      scope: {},
    });
    const custom = engine.calculate({
      events: [],
      funnelStages: stages("Contatos do anuncio"),
      insight,
      leads: [],
      scope: {},
    });

    expect(legacy.funnelSteps[0]?.label).toBe("Leads novos");
    expect(custom.funnelSteps[0]?.label).toBe("Contatos do anuncio");
  });
});

describe("ReportingMetricsEngine conversaram mais de uma vez", () => {
  const conversation = (input: Partial<ReportingMetricEvent>) =>
    event({
      businessSource: "paid",
      campaignId: "cmp_1",
      eventName: "LeadSubmitted",
      valueCents: null,
      ...input,
    });

  it("counts each person with two or more paid conversations once, new or returning", () => {
    const metrics = engine.calculate({
      events: [
        // Lead novo: first conversation and a second one later the same day.
        conversation({ id: "new_1", leadId: "lead_1" }),
        conversation({
          id: "new_2",
          leadId: "lead_1",
          eventOccurredAt: new Date("2026-07-10T18:00:00.000Z"),
        }),
        conversation({
          id: "new_3",
          leadId: "lead_1",
          eventOccurredAt: new Date("2026-07-11T09:00:00.000Z"),
        }),
        // Another lead novo with a single conversation.
        conversation({
          id: "single",
          leadId: "lead_2",
          phoneHash: "phone_b",
          customerIdentityKey: "phone_b",
        }),
      ],
      insight,
      leads: [
        lead({ campaignId: "cmp_1" }),
        lead({
          campaignId: "cmp_1",
          customerIdentityKey: "phone_b",
          id: "lead_2",
          phoneHash: "phone_b",
        }),
      ],
      returningEvents: [
        conversation({
          id: "back_1",
          leadId: "lead_old",
          phoneHash: "phone_old",
          customerIdentityKey: "phone_old",
        }),
        conversation({
          id: "back_2",
          leadId: "lead_old",
          phoneHash: "phone_old",
          customerIdentityKey: "phone_old",
          eventOccurredAt: new Date("2026-07-11T10:00:00.000Z"),
        }),
      ],
      scope: {},
    });

    expect(metrics.repeatConversationLeads).toBe(2);
    expect(metrics.realConversations).toBe(2);
    expect(metrics.returningLeads).toBe(1);
    expect(metrics.adConversationEvents).toBe(6);
    // Context only: CPL stays on leads novos.
    expect(metrics.costPerRealConversationCents).toBe(50000);
  });

  it("ignores skipped and organic conversations", () => {
    const metrics = engine.calculate({
      events: [
        conversation({ id: "sent", leadId: "lead_1" }),
        conversation({ id: "skipped", leadId: "lead_1", status: "skipped" }),
        conversation({
          businessSource: "organic",
          campaignId: null,
          id: "organic",
          leadId: "lead_1",
        }),
      ],
      insight,
      leads: [lead({ campaignId: "cmp_1" })],
      scope: {},
    });

    expect(metrics.repeatConversationLeads).toBe(0);
    expect(metrics.adConversationEvents).toBe(1);
  });

  it("matches a conversation without lead id by phone hash and never counts the same event twice", () => {
    const shared = conversation({ id: "shared", leadId: "lead_1" });
    const metrics = engine.calculate({
      events: [
        shared,
        conversation({ id: "no_lead_id", leadId: null }),
        // A person with no Lead row is not a person on the Leads page.
        conversation({
          id: "orphan_1",
          leadId: null,
          phoneHash: "phone_orphan",
          customerIdentityKey: "phone_orphan",
        }),
        conversation({
          id: "orphan_2",
          leadId: null,
          phoneHash: "phone_orphan",
          customerIdentityKey: "phone_orphan",
        }),
      ],
      insight,
      leads: [lead({ campaignId: "cmp_1" })],
      // The same event can arrive in both lists: counted once.
      returningEvents: [shared],
      scope: {},
    });
    const duplicateOnly = engine.calculate({
      events: [shared],
      insight,
      leads: [lead({ campaignId: "cmp_1" })],
      returningEvents: [shared],
      scope: {},
    });

    expect(metrics.repeatConversationLeads).toBe(1);
    expect(duplicateOnly.repeatConversationLeads).toBe(0);
  });

  it("follows the campaign of each conversation inside a campaign scope", () => {
    const input = {
      events: [
        conversation({ id: "a_1", leadId: "lead_1", campaignId: "cmp_a" }),
        conversation({ id: "b_1", leadId: "lead_1", campaignId: "cmp_b" }),
        conversation({ id: "b_2", leadId: "lead_1", campaignId: "cmp_b" }),
      ],
      insight,
      leads: [lead({ campaignId: "cmp_a" })],
    };

    expect(
      engine.calculate({ ...input, scope: { campaignId: "cmp_a" } })
        .repeatConversationLeads,
    ).toBe(0);
    expect(
      engine.calculate({ ...input, scope: { campaignId: "cmp_b" } })
        .repeatConversationLeads,
    ).toBe(1);
    expect(
      engine.calculate({ ...input, scope: {} }).repeatConversationLeads,
    ).toBe(1);
  });
});
