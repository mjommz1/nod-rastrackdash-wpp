import { describe, expect, it } from "vitest";
import {
  reportCurrencyGroupSchema,
  reportFiltersSchema,
  reportOverviewSchema,
  reportTotalsSchema,
  unconvertedRevenueSchema,
} from "../src";

// Fase 5.2: contratos dos relatórios por moeda. Tudo é opcional: a resposta
// de antes (só BRL, sem campo de moeda) continua válida.

const totals = {
  spendCents: 60_000,
  metaConversationsStarted: 80,
  costPerMetaConversationCents: 750,
  realConversations: 2,
  costPerRealConversationCents: 30_000,
  organicLeads: 0,
  totalReceived: 2,
  trackingRate: 1,
  qualifiedLead: 1,
  costPerQualifiedLeadCents: 60_000,
  purchases: 1,
  firstPurchases: 1,
  repurchases: 0,
  costPerPurchaseCents: 60_000,
  trafficRevenueCents: 100_000,
  organicRevenueCents: 0,
  totalRevenueCents: 100_000,
  firstPurchaseRevenueCents: 100_000,
  repurchaseRevenueCents: 0,
  roasAcquisition: 1.67,
  roasWithRepurchase: 1.67,
  funnelSteps: [],
};

describe("report currency contracts", () => {
  it("keeps the pre-5.2 BRL report valid and accepts currency BRL", () => {
    const base = {
      workspaceId: "workspace_1",
      rangeLabel: "Periodo",
      campaigns: [],
      totals,
    };

    expect(reportOverviewSchema.parse(base).currency).toBeUndefined();
    expect(
      reportOverviewSchema.parse({ ...base, currency: "BRL" }),
    ).toMatchObject({ currency: "BRL" });
  });

  it("describes mixed currencies with one group per currency", () => {
    const usd = {
      ...totals,
      currency: "USD",
      adAccountIds: ["act_us"],
      exchangeRateMissing: true,
      unconvertedRevenue: [{ currency: "BRL", valueCents: 10_000 }],
    };

    const parsed = reportOverviewSchema.parse({
      workspaceId: "workspace_1",
      rangeLabel: "Periodo",
      campaigns: [],
      totals,
      currency: null,
      byCurrency: [
        {
          ...usd,
          currency: "BRL",
          adAccountIds: ["act_123"],
          exchangeRateMissing: false,
          unconvertedRevenue: [],
        },
        usd,
      ],
      summaryByCurrency: [usd],
      exchangeRateMissing: true,
      unconvertedRevenue: [{ currency: "BRL", valueCents: 10_000 }],
    });

    expect(parsed.byCurrency?.map((group) => group.currency)).toEqual([
      "BRL",
      "USD",
    ]);
    expect(() => reportCurrencyGroupSchema.parse(totals)).toThrow();
    expect(() =>
      reportCurrencyGroupSchema.parse({ ...usd, currency: "ARS" }),
    ).toThrow();
    expect(
      reportTotalsSchema.parse({ ...totals, currency: "EUR" }).currency,
    ).toBe("EUR");
  });

  it("never accepts negative or fractional unconverted revenue", () => {
    expect(() =>
      unconvertedRevenueSchema.parse({ currency: "USD", valueCents: -1 }),
    ).toThrow();
    expect(() =>
      unconvertedRevenueSchema.parse({ currency: "USD", valueCents: 1.5 }),
    ).toThrow();
  });

  it("limits the ad account filter to 50 ids of up to 120 characters", () => {
    expect(
      reportFiltersSchema.parse({ adAccountIds: ["act_1", "act_2"] })
        .adAccountIds,
    ).toEqual(["act_1", "act_2"]);
    expect(() =>
      reportFiltersSchema.parse({
        adAccountIds: Array.from({ length: 51 }, (_, i) => `act_${i}`),
      }),
    ).toThrow();
    expect(() =>
      reportFiltersSchema.parse({ adAccountIds: ["x".repeat(121)] }),
    ).toThrow();
  });
});
