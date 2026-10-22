import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import {
  ExchangeRateService,
  ExchangeRateTable,
} from "../../src/currency/exchange-rate.service";
import type { PtaxFetch } from "../../src/currency/ptax.client";
import type { MetaReportingService } from "../../src/reporting/meta-reporting.service";
import { convertEventValues } from "../../src/reporting/reporting-currency";
import type { ReportingMetricEvent } from "../../src/reporting/reporting-metrics.engine";
import {
  account,
  adTree,
  conversionLog,
  createReportingService,
  emptyDb,
  lead,
  WORKSPACE,
  type HarnessDb,
} from "./currency-report-harness";
import { bcbPayload, ptaxHarness, storedRate } from "./ptax-harness";

// Fase 5.2: gasto e receita na moeda de cada conta de anúncio. Os casos
// "duas moedas", "conta parada", "correção manual", "conjuntos/anúncios" e
// "CSV" vêm do SaaS (996e7c1 e 5b4fdd4, meta-reporting-service); os de PTAX
// desligada, fallback de dia útil e BCB fora são do aluno.

/** One BRL ad account and one USD ad account; a BRL sale on the USD ad. */
function twoCurrencyDb(options: { usdOverride?: string } = {}) {
  const db = emptyDb();
  db.reportingAccounts.push(
    account("act_123", "BRL"),
    account("act_us", "USD", options.usdOverride ?? null),
  );
  const br = adTree(db, {
    suffix: "br",
    adAccountId: "act_123",
    spendCents: 60_000,
    metaConversationsStarted: 80,
  });
  const us = adTree(db, {
    suffix: "us",
    adAccountId: "act_us",
    spendCents: 5_000,
    metaConversationsStarted: 10,
  });
  db.conversionLogs.push(
    conversionLog({
      id: "purchase_br",
      eventName: "Purchase",
      // 01/07 in Sao Paulo.
      occurredAt: "2026-07-01T15:00:00.000Z",
      phoneHash: "phone_br",
      attribution: br,
      valueCents: 100_000,
      currency: "BRL",
      purchaseKind: "first_purchase",
    }),
    conversionLog({
      id: "purchase_us",
      eventName: "Purchase",
      occurredAt: "2026-07-01T15:00:00.000Z",
      phoneHash: "phone_us",
      attribution: us,
      valueCents: 10_000,
      currency: "BRL",
      purchaseKind: "first_purchase",
    }),
  );

  return { db, br, us };
}

function withRates(
  service: MetaReportingService,
  rates: Array<{ currency: "USD" | "EUR"; date: string; rate: number }>,
) {
  const loadRateTable = vi.fn(async () => new ExchangeRateTable(rates));
  Object.assign(service as object, { exchangeRates: { loadRateTable } });
  return loadRateTable;
}

function withPtax(service: MetaReportingService, ptax: ExchangeRateService) {
  Object.assign(service as object, { exchangeRates: ptax });
}

const overview = (
  service: MetaReportingService,
  extra: Record<string, unknown> = {},
) =>
  service.getCampaignReportOverview({
    workspaceId: WORKSPACE,
    rangeLabel: "Periodo",
    ...extra,
  });

describe("relatórios por moeda: duas moedas (portado do SaaS)", () => {
  it("splits BRL and USD accounts and converts attributed revenue by PTAX", async () => {
    const { db } = twoCurrencyDb();
    const service = createReportingService(db);
    const loadRateTable = withRates(service, [
      { currency: "USD", date: "2026-07-01", rate: 5 },
    ]);

    const report = await overview(service);

    expect(report.currency).toBeNull();
    expect(loadRateTable).toHaveBeenCalledWith(
      expect.arrayContaining([
        { currency: "BRL", date: "2026-07-01" },
        { currency: "USD", date: "2026-07-01" },
      ]),
    );
    expect(report.campaigns.find((row) => row.id === "cmp_us")).toMatchObject({
      currency: "USD",
      spendCents: 5_000,
      totalRevenueCents: 2_000,
      roasWithRepurchase: 0.4,
    });
    expect(report.campaigns.find((row) => row.id === "cmp_br")).toMatchObject({
      currency: "BRL",
      totalRevenueCents: 100_000,
    });
    expect(report.byCurrency).toEqual([
      expect.objectContaining({
        currency: "BRL",
        adAccountIds: ["act_123"],
        spendCents: 60_000,
        totalRevenueCents: 100_000,
        exchangeRateMissing: false,
        unconvertedRevenue: [],
      }),
      expect.objectContaining({
        currency: "USD",
        adAccountIds: ["act_us"],
        spendCents: 5_000,
        metaConversationsStarted: 10,
        costPerMetaConversationCents: 500,
        purchases: 1,
        totalRevenueCents: 2_000,
        roasWithRepurchase: 0.4,
        exchangeRateMissing: false,
        unconvertedRevenue: [],
      }),
    ]);
    expect(report.exchangeRateMissing).toBeUndefined();
  });

  it("filters by ad account(s): only the currency of the filtered accounts", async () => {
    const { db } = twoCurrencyDb();
    const service = createReportingService(db);
    withRates(service, [{ currency: "USD", date: "2026-07-01", rate: 5 }]);

    const onlyUs = await overview(service, { adAccountIds: ["act_us"] });
    expect(onlyUs.currency).toBe("USD");
    expect(onlyUs.byCurrency).toBeUndefined();
    expect(onlyUs.campaigns.map((row) => row.id)).toEqual(["cmp_us"]);
    expect(onlyUs.totals).toMatchObject({
      spendCents: 5_000,
      totalRevenueCents: 2_000,
    });

    const single = await overview(service, { adAccountId: "act_123" });
    expect(single.currency).toBe("BRL");
    expect(single.campaigns.map((row) => row.id)).toEqual(["cmp_br"]);

    const both = await overview(service, {
      adAccountIds: ["act_us", "act_123"],
    });
    expect(both.currency).toBeNull();
    expect(both.campaigns).toHaveLength(2);

    const unknown = await overview(service, { adAccountIds: ["act_other"] });
    expect(unknown.campaigns).toEqual([]);
  });

  it("uses the manual override as the account currency", async () => {
    const { db } = twoCurrencyDb({ usdOverride: "EUR" });
    const service = createReportingService(db);
    withRates(service, [{ currency: "EUR", date: "2026-07-01", rate: 6.25 }]);

    const report = await overview(service);

    expect(report.byCurrency?.map((group) => group.currency)).toEqual([
      "BRL",
      "EUR",
    ]);
    expect(report.campaigns.find((row) => row.id === "cmp_us")).toMatchObject({
      currency: "EUR",
      totalRevenueCents: 1_600,
    });
  });

  it("splits ad set and ad reports by currency too", async () => {
    const { db } = twoCurrencyDb();
    const service = createReportingService(db);
    withRates(service, [{ currency: "USD", date: "2026-07-01", rate: 5 }]);
    const input = { workspaceId: WORKSPACE, rangeLabel: "Periodo" };

    const adSets = await service.getAdSetReportOverview(input);
    expect(adSets.currency).toBeNull();
    expect(adSets.adSets.find((row) => row.id === "adset_us")).toMatchObject({
      currency: "USD",
      totalRevenueCents: 2_000,
    });
    expect(adSets.byCurrency?.map((group) => group.currency)).toEqual([
      "BRL",
      "USD",
    ]);

    const ads = await service.getAdReportOverview(input);
    expect(ads.currency).toBeNull();
    expect(ads.ads.find((row) => row.id === "ad_us")).toMatchObject({
      currency: "USD",
      totalRevenueCents: 2_000,
    });
    expect(ads.byCurrency?.map((group) => group.currency)).toEqual([
      "BRL",
      "USD",
    ]);
  });

  it("exports the currency of every campaign in the CSV (last column)", async () => {
    const { db } = twoCurrencyDb();
    const service = createReportingService(db);
    withRates(service, [{ currency: "USD", date: "2026-07-01", rate: 5 }]);

    const csv = await service.getCampaignReportCsv({
      workspaceId: WORKSPACE,
      rangeLabel: "Periodo",
    });
    const lines = csv.content.trim().split("\n");

    expect(lines[0]).toMatch(
      /^Campanha,Status,Investimento,.*,Moeda,Receita sem cotacao$/u,
    );
    expect(lines.find((line) => line.startsWith("Campanha br,"))).toMatch(
      /^Campanha br,active,600\.00,.*,BRL,$/u,
    );
    expect(lines.find((line) => line.startsWith("Campanha us,"))).toMatch(
      /^Campanha us,active,50\.00,.*,USD,$/u,
    );
  });
});

/** Ad account idle in the period: no spend at any level. */
function idle(db: HarnessDb, suffix: string) {
  for (const row of [...db.campaigns, ...db.adSets, ...db.ads]) {
    if (row.campaignId === `cmp_${suffix}`) {
      row.spendCents = 0;
      row.metaConversationsStarted = 0;
    }
  }
}

describe("relatórios por moeda: só moedas com movimento (portado do SaaS)", () => {
  it("BRL active + USD account idle in the period: single BRL report", async () => {
    const { db } = twoCurrencyDb();
    idle(db, "us");
    db.conversionLogs = db.conversionLogs.filter(
      (event) => event.id === "purchase_br",
    );
    const service = createReportingService(db);
    const loadRateTable = withRates(service, []);

    const report = await overview(service, { includeSummary: true });

    expect(report.currency).toBe("BRL");
    expect(report.byCurrency).toBeUndefined();
    expect(report.summaryByCurrency).toBeUndefined();
    expect(report.summary?.currency).toBe("BRL");
    expect(report.totals).toMatchObject({ spendCents: 60_000 });
    expect(loadRateTable).not.toHaveBeenCalled();
  });

  it("only USD active (BRL account idle): single USD report", async () => {
    const { db } = twoCurrencyDb();
    idle(db, "br");
    db.conversionLogs = db.conversionLogs.filter(
      (event) => event.id === "purchase_us",
    );
    const service = createReportingService(db);
    withRates(service, [{ currency: "USD", date: "2026-07-01", rate: 5 }]);

    const report = await overview(service, { includeSummary: true });

    expect(report.currency).toBe("USD");
    expect(report.byCurrency).toBeUndefined();
    expect(report.summaryByCurrency).toBeUndefined();
    expect(report.totals).toMatchObject({
      spendCents: 5_000,
      totalRevenueCents: 2_000,
    });
  });

  it("no currency active: the workspace conversion currency, or the filtered account's", async () => {
    const { db } = twoCurrencyDb();
    idle(db, "br");
    idle(db, "us");
    db.conversionLogs.splice(0);
    db.workspace.conversionCurrency = "USD";
    const service = createReportingService(db);

    const report = await overview(service);
    expect(report.currency).toBe("USD");
    expect(report.byCurrency).toBeUndefined();

    const filtered = await overview(service, { adAccountIds: ["act_123"] });
    expect(filtered.currency).toBe("BRL");
    expect(filtered.byCurrency).toBeUndefined();
  });
});

/** USD account only; a BRL sale (Payt in real) attributed to its ad. */
function usdAccountWithBrlSale(occurredAt: string, valueCents = 10_000) {
  const db = emptyDb();
  db.reportingAccounts.push(account("act_us", "USD"));
  const us = adTree(db, {
    suffix: "us",
    adAccountId: "act_us",
    spendCents: 5_000,
    metaConversationsStarted: 10,
  });
  db.conversionLogs.push(
    conversionLog({
      id: "purchase_us",
      eventName: "Purchase",
      occurredAt,
      phoneHash: "phone_us",
      attribution: us,
      valueCents,
      currency: "BRL",
      purchaseKind: "first_purchase",
    }),
  );
  return db;
}

function organicSale(
  db: HarnessDb,
  input: { currency: string; valueCents: number; occurredAt: string },
) {
  db.leads.push(
    lead({
      id: "lead_organic",
      phoneHash: "phone_organic",
      firstMessageAt: input.occurredAt,
      attribution: null,
    }),
  );
  db.conversionLogs.push(
    conversionLog({
      id: "purchase_organic",
      eventName: "Purchase",
      occurredAt: input.occurredAt,
      phoneHash: "phone_organic",
      leadId: "lead_organic",
      attribution: null,
      valueCents: input.valueCents,
      currency: input.currency,
      purchaseKind: "first_purchase",
    }),
  );
}

describe("PTAX_SYNC_ENABLED desligada (padrão)", () => {
  it("does not look anything up: revenue stays in the original currency, ROAS sem cotação", async () => {
    const db = usdAccountWithBrlSale("2026-10-09T15:00:00.000Z");
    const service = createReportingService(db);
    const ptax = ptaxHarness({ enabled: false });
    withPtax(service, ptax.service);

    const report = await overview(service, { includeSummary: true });

    expect(ptax.fetchImpl).not.toHaveBeenCalled();
    expect(ptax.prisma.exchangeRate.findMany).not.toHaveBeenCalled();
    expect(report.currency).toBe("USD");
    expect(report.exchangeRateMissing).toBe(true);
    expect(report.unconvertedRevenue).toEqual([
      { currency: "BRL", valueCents: 10_000 },
    ]);
    // The sale still counts as a purchase; its value is apart, not mixed.
    expect(report.campaigns[0]).toMatchObject({
      currency: "USD",
      purchases: 1,
      totalRevenueCents: 0,
      exchangeRateMissing: true,
      unconvertedRevenue: [{ currency: "BRL", valueCents: 10_000 }],
    });
    expect(report.summary).toMatchObject({
      currency: "USD",
      exchangeRateMissing: true,
      unconvertedRevenue: [{ currency: "BRL", valueCents: 10_000 }],
    });
  });

  it("shows a sale with no ad in its own currency, side by side with BRL", async () => {
    const db = emptyDb();
    db.reportingAccounts.push(account("act_123", "BRL"));
    adTree(db, {
      suffix: "br",
      adAccountId: "act_123",
      spendCents: 30_000,
      metaConversationsStarted: 10,
    });
    organicSale(db, {
      currency: "USD",
      valueCents: 4_000,
      occurredAt: "2026-10-09T15:00:00.000Z",
    });
    const service = createReportingService(db);
    const ptax = ptaxHarness({ enabled: false });
    withPtax(service, ptax.service);

    const report = await overview(service, { includeSummary: true });

    expect(ptax.fetchImpl).not.toHaveBeenCalled();
    // Campaign totals are BRL only; the summary has a USD group too.
    expect(report.currency).toBeNull();
    expect(report.byCurrency).toEqual([
      expect.objectContaining({ currency: "BRL", spendCents: 30_000 }),
    ]);
    expect(report.summaryByCurrency).toEqual([
      expect.objectContaining({
        currency: "BRL",
        spendCents: 30_000,
        totalRevenueCents: 0,
      }),
      expect.objectContaining({
        currency: "USD",
        spendCents: 0,
        totalRevenueCents: 4_000,
        roasWithRepurchase: null,
        adAccountIds: [],
      }),
    ]);
  });
});

describe("PTAX_SYNC_ENABLED ligada", () => {
  const usdBulletins = vi.fn<PtaxFetch>(async () => ({
    ok: true,
    status: 200,
    // Thursday and Friday only: nothing on Saturday nor on the 12/10 holiday.
    json: async () =>
      bcbPayload([
        { date: "2026-10-08", rate: 5.0119 },
        { date: "2026-10-09", rate: 5 },
      ]),
  }));

  it("converts by the sale day; weekend and holiday use the previous business day", async () => {
    const db = usdAccountWithBrlSale("2026-10-10T15:00:00.000Z"); // Saturday
    db.conversionLogs.push(
      conversionLog({
        id: "purchase_holiday",
        eventName: "Purchase",
        // Monday 12/10 (holiday): no bulletin.
        occurredAt: "2026-10-12T15:00:00.000Z",
        phoneHash: "phone_us_2",
        attribution: {
          campaignId: "cmp_us",
          adSetId: "adset_us",
          adId: "ad_us",
        },
        valueCents: 5_000,
        currency: "BRL",
        purchaseKind: "first_purchase",
      }),
    );
    const service = createReportingService(db);
    const ptax = ptaxHarness({ enabled: true, fetchImpl: usdBulletins });
    withPtax(service, ptax.service);

    const report = await overview(service);

    // R$ 100 + R$ 50 at Friday's PTAX (5) = US$ 30.
    expect(report.currency).toBe("USD");
    expect(report.exchangeRateMissing).toBeUndefined();
    expect(report.totals).toMatchObject({
      spendCents: 5_000,
      totalRevenueCents: 3_000,
      roasWithRepurchase: 0.6,
    });
    expect(String(usdBulletins.mock.calls[0]![0])).toContain(
      "olinda.bcb.gov.br",
    );
    // Stored for the next reports.
    expect(ptax.rows.map((row) => row.date.toISOString().slice(0, 10))).toEqual(
      ["2026-10-08", "2026-10-09"],
    );
  });

  it("keeps a sale without an ad account in its original currency (no conversion)", async () => {
    const db = emptyDb();
    db.reportingAccounts.push(account("act_123", "BRL"));
    adTree(db, {
      suffix: "br",
      adAccountId: "act_123",
      spendCents: 30_000,
      metaConversationsStarted: 10,
    });
    organicSale(db, {
      currency: "EUR",
      valueCents: 2_500,
      occurredAt: "2026-10-09T15:00:00.000Z",
    });
    const service = createReportingService(db);
    const ptax = ptaxHarness({ enabled: true });
    withPtax(service, ptax.service);

    const report = await overview(service, { includeSummary: true });

    expect(ptax.fetchImpl).not.toHaveBeenCalled();
    expect(report.summaryByCurrency?.map((group) => group.currency)).toEqual([
      "BRL",
      "EUR",
    ]);
    expect(
      report.summaryByCurrency?.find((group) => group.currency === "EUR"),
    ).toMatchObject({ totalRevenueCents: 2_500, exchangeRateMissing: false });
  });

  it("BCB down: uses the last stored rate", async () => {
    const db = usdAccountWithBrlSale("2026-10-09T15:00:00.000Z");
    const service = createReportingService(db);
    const down = vi.fn<PtaxFetch>(async () => {
      throw new Error("ETIMEDOUT");
    });
    const ptax = ptaxHarness({
      enabled: true,
      fetchImpl: down,
      rows: [storedRate("2026-10-07", "USD", "4.00000000")],
    });
    withPtax(service, ptax.service);

    const report = await overview(service);

    expect(down).toHaveBeenCalled();
    expect(report.exchangeRateMissing).toBeUndefined();
    expect(report.totals).toMatchObject({ totalRevenueCents: 2_500 });
  });

  it("BCB down and nothing stored: sem cotação, the report still loads", async () => {
    const db = usdAccountWithBrlSale("2026-10-09T15:00:00.000Z");
    const service = createReportingService(db);
    const ptax = ptaxHarness({
      enabled: true,
      fetchImpl: vi.fn<PtaxFetch>(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      })),
    });
    withPtax(service, ptax.service);

    const report = await overview(service);

    expect(report.currency).toBe("USD");
    expect(report.exchangeRateMissing).toBe(true);
    expect(report.unconvertedRevenue).toEqual([
      { currency: "BRL", valueCents: 10_000 },
    ]);
    expect(report.totals).toMatchObject({ purchases: 1, totalRevenueCents: 0 });
  });

  it("an exchange-rate service that throws never breaks the report", async () => {
    const db = usdAccountWithBrlSale("2026-10-09T15:00:00.000Z");
    const service = createReportingService(db);
    Object.assign(service as object, {
      exchangeRates: {
        loadRateTable: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });

    const report = await overview(service);

    expect(report.exchangeRateMissing).toBe(true);
    expect(report.totals).toMatchObject({ purchases: 1 });
  });
});

describe("relatórios por moeda: ordenação, isolamento e códigos antigos (revisão)", () => {
  it("never interleaves currencies in a metric sort and keeps pages stable", async () => {
    const { db } = twoCurrencyDb();
    const cheap = adTree(db, {
      suffix: "br2",
      adAccountId: "act_123",
      spendCents: 1_000,
      metaConversationsStarted: 5,
    });
    db.conversionLogs.push(
      conversionLog({
        id: "purchase_br2",
        eventName: "Purchase",
        occurredAt: "2026-07-01T15:00:00.000Z",
        phoneHash: "phone_br2",
        attribution: cheap,
        valueCents: 3_000,
        currency: "BRL",
        purchaseKind: "first_purchase",
      }),
    );
    const service = createReportingService(db);
    withRates(service, [{ currency: "USD", date: "2026-07-01", rate: 5 }]);
    const sorted = (page: number) =>
      overview(service, {
        sort: { key: "costPerPurchaseCents", direction: "asc" },
        page,
        pageSize: 2,
      });

    const first = await sorted(1);
    const second = await sorted(2);

    // Plain metric order would be br2 (R$ 10), us (US$ 50), br (R$ 600).
    expect(first.currency).toBeNull();
    expect(first.campaigns.map((row) => [row.id, row.currency])).toEqual([
      ["cmp_br2", "BRL"],
      ["cmp_br", "BRL"],
    ]);
    expect(second.campaigns.map((row) => [row.id, row.currency])).toEqual([
      ["cmp_us", "USD"],
    ]);
    expect(first.pagination).toEqual({
      page: 1,
      pageSize: 2,
      totalItems: 3,
      totalPages: 2,
    });
    expect((await sorted(1)).campaigns.map((row) => row.id)).toEqual(
      first.campaigns.map((row) => row.id),
    );

    const adSets = await service.getAdSetReportOverview({
      workspaceId: WORKSPACE,
      rangeLabel: "Periodo",
      sort: { key: "costPerPurchaseCents", direction: "asc" },
    });
    expect(adSets.adSets.map((row) => row.currency)).toEqual([
      "BRL",
      "BRL",
      "USD",
    ]);
  });

  it("ignores an ad account id that belongs to another workspace", async () => {
    const { db } = twoCurrencyDb();
    const other = account("act_other", "USD");
    other.workspaceId = "workspace_2";
    db.reportingAccounts.push(other);
    const before = db.campaigns.length;
    adTree(db, {
      suffix: "other",
      adAccountId: "act_other",
      spendCents: 9_999,
      metaConversationsStarted: 3,
    });
    for (const row of [
      ...db.campaigns.slice(before),
      ...db.adSets.slice(before),
      ...db.ads.slice(before),
    ]) {
      row.workspaceId = "workspace_2";
    }
    const service = createReportingService(db);
    withRates(service, [{ currency: "USD", date: "2026-07-01", rate: 5 }]);

    const onlyOther = await overview(service, {
      adAccountIds: ["act_other"],
      includeSummary: true,
    });
    expect(onlyOther.campaigns).toEqual([]);
    expect(onlyOther.totals).toMatchObject({ spendCents: 0 });
    expect(onlyOther.byCurrency).toBeUndefined();

    const single = await overview(service, { adAccountId: "act_other" });
    expect(single.campaigns).toEqual([]);

    const mixed = await overview(service, {
      adAccountIds: ["act_other", "act_123"],
    });
    expect(mixed.campaigns.map((row) => row.id)).toEqual(["cmp_br"]);
    expect(mixed.currency).toBe("BRL");

    const ads = await service.getAdReportOverview({
      workspaceId: WORKSPACE,
      rangeLabel: "Periodo",
      adAccountIds: ["act_other"],
    });
    expect(ads.ads).toEqual([]);
  });

  it("a legacy currency code is summed as before on BRL and is sem cotação elsewhere", async () => {
    const { db, br, us } = twoCurrencyDb();
    db.conversionLogs = [
      conversionLog({
        id: "legacy_br",
        eventName: "Purchase",
        occurredAt: "2026-07-01T15:00:00.000Z",
        phoneHash: "phone_legacy_br",
        attribution: br,
        valueCents: 7_000,
        currency: "ars",
        purchaseKind: "first_purchase",
      }),
      conversionLog({
        id: "legacy_us",
        eventName: "Purchase",
        occurredAt: "2026-07-01T15:00:00.000Z",
        phoneHash: "phone_legacy_us",
        attribution: us,
        valueCents: 5_000,
        currency: "ARS",
        purchaseKind: "first_purchase",
      }),
    ];
    const service = createReportingService(db);
    const loadRateTable = withRates(service, []);
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    const report = await overview(service);
    const csv = await service.getCampaignReportCsv({
      workspaceId: WORKSPACE,
      rangeLabel: "Periodo",
    });

    expect(loadRateTable).not.toHaveBeenCalled();
    expect(report.campaigns.find((row) => row.id === "cmp_br")).toMatchObject({
      currency: "BRL",
      totalRevenueCents: 7_000,
    });
    expect(
      report.campaigns.find((row) => row.id === "cmp_br"),
    ).not.toHaveProperty("exchangeRateMissing");
    expect(report.campaigns.find((row) => row.id === "cmp_us")).toMatchObject({
      currency: "USD",
      purchases: 1,
      totalRevenueCents: 0,
      exchangeRateMissing: true,
      unconvertedRevenue: [{ currency: "ARS", valueCents: 5_000 }],
    });
    expect(
      csv.content.split("\n").find((line) => line.startsWith("Campanha us,")),
    ).toMatch(/,USD,ARS 50\.00$/u);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain(
      "REPORT_UNSUPPORTED_SALE_CURRENCY pairs=ARS->USD",
    );
    expect(messages.join(" ")).not.toContain("phone_legacy");
    warn.mockRestore();
  });

  it("keeps the own currency of a valueless sale with no ad", () => {
    const base = conversionLog({
      id: "no_value",
      eventName: "Purchase",
      occurredAt: "2026-07-01T15:00:00.000Z",
      phoneHash: "phone_x",
      attribution: null,
      valueCents: null,
      currency: "EUR",
    }) as unknown as ReportingMetricEvent;
    const legacy = {
      ...(base as object),
      currency: "ARS",
    } as ReportingMetricEvent;

    const [eur, ars] = convertEventValues([base, legacy], () => null, null);

    expect(eur!.currency).toBe("EUR");
    expect(ars!.currency).toBe("BRL");
  });
});
