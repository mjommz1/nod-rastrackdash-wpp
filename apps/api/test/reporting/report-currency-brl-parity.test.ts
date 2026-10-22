import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExchangeRateTable } from "../../src/currency/exchange-rate.service";
import {
  brlReports,
  brlWorkspaceDb,
  createReportingService,
} from "./currency-report-harness";

// Fase 5.2, sem regressão: os relatórios de um workspace todo em BRL saem com
// os MESMOS números de antes da moeda por conta. O arquivo de referência foi
// gerado rodando este mesmo harness num worktree em a117299 (fim da Fase
// 5.1, sem nada da 5.2) e não muda.
const baseline = JSON.parse(
  readFileSync(
    resolve(__dirname, "fixtures", "brl-workspace-baseline.json"),
    "utf8",
  ),
) as Record<string, unknown>;

/** Remove só o que a Fase 5.2 acrescenta: a moeda (sempre "BRL" aqui). */
function withoutCurrency(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCurrency);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "currency")
        .map(([key, item]) => [key, withoutCurrency(item)]),
    );
  }
  return value;
}

/** Drops the two columns Fase 5.2 appends (Moeda, Receita sem cotacao). */
function csvWithoutNewColumns(csv: string): string {
  return csv
    .split("\n")
    .map((line) => (line ? line.split(",").slice(0, -2).join(",") : line))
    .join("\n");
}

describe("Fase 5.2: workspace todo em BRL não muda", () => {
  it("keeps every number of campaigns, ad sets, ads and summary identical", async () => {
    const reports = await brlReports(createReportingService(brlWorkspaceDb()));

    expect(withoutCurrency(reports.overview)).toEqual(baseline.overview);
    expect(withoutCurrency(reports.overviewByAccount)).toEqual(
      baseline.overviewByAccount,
    );
    expect(withoutCurrency(reports.adSets)).toEqual(baseline.adSets);
    expect(withoutCurrency(reports.ads)).toEqual(baseline.ads);
  });

  it("keeps the metric sort order and the pages identical", async () => {
    const reports = await brlReports(createReportingService(brlWorkspaceDb()));

    expect(withoutCurrency(reports.sortedCampaignsPage2)).toEqual(
      baseline.sortedCampaignsPage2,
    );
    expect(withoutCurrency(reports.sortedAdSets)).toEqual(
      baseline.sortedAdSets,
    );
    expect(withoutCurrency(reports.sortedAdsPage1)).toEqual(
      baseline.sortedAdsPage1,
    );
  });

  it("only adds currency BRL: no groups, no sem cotação, no rate lookup", async () => {
    const service = createReportingService(brlWorkspaceDb());
    const loadRateTable = vi.fn(async () => new ExchangeRateTable());
    Object.assign(service as object, { exchangeRates: { loadRateTable } });

    const reports = await brlReports(service);

    for (const report of [
      reports.overview,
      reports.overviewByAccount,
      reports.adSets,
      reports.ads,
      reports.sortedCampaignsPage2,
      reports.sortedAdSets,
      reports.sortedAdsPage1,
    ]) {
      expect(report.currency).toBe("BRL");
      expect(report.byCurrency).toBeUndefined();
      expect(report.exchangeRateMissing).toBeUndefined();
      expect(report.unconvertedRevenue).toBeUndefined();
    }
    expect(reports.overview.summary?.currency).toBe("BRL");
    expect(reports.overview.summaryByCurrency).toBeUndefined();
    expect(reports.overview.campaigns.map((row) => row.currency)).toEqual([
      "BRL",
      "BRL",
    ]);
    expect(loadRateTable).not.toHaveBeenCalled();
  });

  it("keeps the CSV columns in place and appends Moeda and Receita sem cotacao", async () => {
    const reports = await brlReports(createReportingService(brlWorkspaceDb()));
    const lines = reports.csv.split("\n");

    expect(csvWithoutNewColumns(reports.csv)).toBe(baseline.csv);
    expect(lines[0]).toMatch(/,Moeda,Receita sem cotacao$/u);
    expect(lines[1]).toMatch(/,BRL,$/u);
  });
});
