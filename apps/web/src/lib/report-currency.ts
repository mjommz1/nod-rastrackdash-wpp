import {
  DEFAULT_CURRENCY_CODE,
  effectiveAccountCurrency,
  formatMoney,
  normalizeCurrencyCode,
  type CurrencyCode,
  type MetaReportingAccountDto,
  type ReportCurrencyGroupDto,
  type UnconvertedRevenueDto,
} from "@wpptrack/shared";

/**
 * Dinheiro de UMA moeda: é o formato que cada bloco de KPI lê. Valores de
 * moedas diferentes nunca são somados.
 */
export type CurrencyKpiGroup = {
  currency: CurrencyCode;
  spendCents: number;
  totalRevenueCents: number;
  trafficRevenueCents: number;
  roasAcquisition: number | null;
  costPerRealConversationCents: number | null;
  costPerMetaConversationCents: number | null;
  exchangeRateMissing: boolean;
  unconvertedRevenue: UnconvertedRevenueDto[];
  adAccountIds: string[];
};

type ReportCurrencyFields = {
  currency?: CurrencyCode | null;
  byCurrency?: ReportCurrencyGroupDto[];
  summaryByCurrency?: ReportCurrencyGroupDto[];
  exchangeRateMissing?: boolean;
  unconvertedRevenue?: UnconvertedRevenueDto[];
};

/** Texto de apoio quando faltou cotação (a variável é da API, não da tela). */
export const exchangeRateMissingHint =
  "Para converter vendas em outra moeda, ligue PTAX_SYNC_ENABLED na API (cotação do Banco Central).";

export const exchangeRateMissingLabel = "sem cotação";

const NO_BREAK_SPACE = String.fromCharCode(160);

/**
 * Dinheiro na moeda informada. Igual ao formatador compartilhado, mas com
 * espaço sem quebra entre o símbolo e o número, como a tela sempre mostrou
 * (R$ 1.234,56 não quebra de linha no meio).
 */
export function formatReportMoney(
  cents: number | null | undefined,
  currency: CurrencyCode | string | null | undefined = DEFAULT_CURRENCY_CODE,
): string {
  return formatMoney(cents, currency).replace(" ", NO_BREAK_SPACE);
}

/** "US$ 100,00 + € 20,00": receita que ficou fora por falta de cotação. */
export function unconvertedRevenueLabel(
  unconverted: readonly UnconvertedRevenueDto[] | null | undefined,
): string {
  return (unconverted ?? [])
    .filter((item) => item.valueCents > 0)
    .map((item) => formatReportMoney(item.valueCents, item.currency))
    .join(" + ");
}

/**
 * Um grupo de moeda só existe para o usuário quando teve movimento no
 * período: gasto, receita ou receita que ficou de fora sem cotação. Uma conta
 * em dólar parada nunca mostra um grupo zerado "US$ 0,00".
 */
export function currencyGroupHasActivity(
  group: Pick<
    ReportCurrencyGroupDto,
    "spendCents" | "totalRevenueCents" | "trafficRevenueCents"
  > & { unconvertedRevenue?: UnconvertedRevenueDto[] | null },
): boolean {
  return (
    (group.spendCents ?? 0) > 0 ||
    (group.totalRevenueCents ?? 0) > 0 ||
    (group.trafficRevenueCents ?? 0) > 0 ||
    (group.unconvertedRevenue ?? []).some((item) => item.valueCents > 0)
  );
}

function rawCurrencyGroups(
  report: ReportCurrencyFields,
  source: "totals" | "summary",
): ReportCurrencyGroupDto[] {
  const groups =
    source === "summary"
      ? (report.summaryByCurrency ?? report.byCurrency)
      : report.byCurrency;

  return groups ?? [];
}

/**
 * Moeda de um relatório com valores em uma só moeda (BRL por padrão). Quando
 * a API mandou grupos mas só uma moeda teve movimento, ela é a moeda do
 * relatório (layout de moeda única).
 */
export function reportCurrency(
  report: ReportCurrencyFields | null | undefined,
  source: "totals" | "summary" = "totals",
): CurrencyCode {
  const own = normalizeCurrencyCode(report?.currency);
  if (own || !report) {
    return own ?? DEFAULT_CURRENCY_CODE;
  }

  const groups = rawCurrencyGroups(report, source);
  const active = groups.filter(currencyGroupHasActivity);

  return (
    (active.length === 1 ? active[0]!.currency : undefined) ??
    (active.length === 0 ? groups[0]?.currency : undefined) ??
    DEFAULT_CURRENCY_CODE
  );
}

/**
 * Grupos por moeda quando o relatório mistura moedas de verdade (duas ou mais
 * com movimento no período); `[]` caso contrário. `summary` prefere
 * `summaryByCurrency` (Visão Geral com includeSummary).
 */
export function mixedCurrencyGroups(
  report: ReportCurrencyFields | null | undefined,
  source: "totals" | "summary" = "totals",
): ReportCurrencyGroupDto[] {
  if (!report || report.currency !== null) {
    return [];
  }

  const active = rawCurrencyGroups(report, source).filter(
    currencyGroupHasActivity,
  );

  return active.length > 1 ? active : [];
}

/**
 * Cotação que faltou numa moeda única: devolve o aviso da própria resposta
 * (ou do único grupo com movimento). Em relatório misto cada grupo traz o seu.
 */
export function singleCurrencyRateGap(
  report: ReportCurrencyFields | null | undefined,
  source: "totals" | "summary" = "totals",
): {
  exchangeRateMissing: boolean;
  unconvertedRevenue: UnconvertedRevenueDto[];
} {
  if (!report) {
    return { exchangeRateMissing: false, unconvertedRevenue: [] };
  }

  const groups = rawCurrencyGroups(report, source).filter(
    currencyGroupHasActivity,
  );
  const group = groups.length === 1 ? groups[0] : undefined;
  const exchangeRateMissing =
    report.exchangeRateMissing === true || group?.exchangeRateMissing === true;

  return {
    exchangeRateMissing,
    unconvertedRevenue:
      report.unconvertedRevenue ?? group?.unconvertedRevenue ?? [],
  };
}

export function currencyKpiGroup(
  group: ReportCurrencyGroupDto,
): CurrencyKpiGroup {
  return {
    currency: group.currency,
    spendCents: group.spendCents,
    totalRevenueCents: group.totalRevenueCents,
    trafficRevenueCents: group.trafficRevenueCents,
    roasAcquisition: group.roasAcquisition,
    costPerRealConversationCents: group.costPerRealConversationCents,
    costPerMetaConversationCents: group.costPerMetaConversationCents,
    exchangeRateMissing: group.exchangeRateMissing,
    unconvertedRevenue: group.unconvertedRevenue,
    adAccountIds: group.adAccountIds,
  };
}

/** Moeda de uma linha do relatório; sem ela, a do relatório. */
export function rowCurrency(
  row: { currency?: CurrencyCode | null } | null | undefined,
  fallback: CurrencyCode,
): CurrencyCode {
  return normalizeCurrencyCode(row?.currency) ?? fallback;
}

/** Moeda efetiva de uma conta (correção manual, Meta, BRL). */
export function reportingAccountCurrency(
  account: Pick<MetaReportingAccountDto, "currency"> & {
    currencyOverride?: string | null;
  },
): CurrencyCode {
  return effectiveAccountCurrency(account);
}
