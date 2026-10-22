import type {
  CurrencyCode,
  ReportFunnelStepDto,
  ReportSortDto,
  ReportSortKeyDto,
} from "@wpptrack/shared";
import { formatReportMoney } from "../../../lib/report-currency";

export type ReportInsightObjective =
  "real_conversations" | "qualified_lead" | "purchase";
export type ReportInsightKind = "volume" | "cost";

type ReportInsightMetricKey =
  "realConversations" | "qualifiedLead" | "purchases";
type ReportInsightCostKey =
  | "costPerRealConversationCents"
  | "costPerQualifiedLeadCents"
  | "costPerPurchaseCents";

export type ReportInsightMetrics = {
  spendCents: number;
  funnelSteps: ReportFunnelStepDto[];
  /**
   * Moeda dos valores em dinheiro (a da conta de anúncio, numa linha). Nos
   * totais do filtro, `null` quer dizer que o filtro mistura moedas: o
   * dinheiro nunca é comparado entre moedas.
   */
  currency?: CurrencyCode | null;
} & Record<ReportInsightMetricKey, number> &
  Record<ReportInsightCostKey, number | null>;

export type ReportInsightSourceRow = ReportInsightMetrics & {
  id: string;
  name: string;
};

export type ReportInsightSignal = {
  key: "low_sample" | "no_spend" | "volume_share" | "cost_vs_filter" | "tie";
  tone: "warn" | "neutral";
  label: string;
  basis: string;
};

export type ReportInsightItem<T extends ReportInsightSourceRow> = {
  id: string;
  position: number;
  row: T;
  volume: number;
  costCents: number | null;
  signals: ReportInsightSignal[];
};

export type ReportInsightRanking<T extends ReportInsightSourceRow> = {
  items: Array<ReportInsightItem<T>>;
  // Rows inside the fetched head that cannot be ranked: zero volume for the
  // volume ranking, unavailable cost for the cost ranking.
  excludedWithoutResult: number;
};

export const REPORT_INSIGHT_TOP_N = 5;
// One extra row reveals whether the last shown position ties with the next.
export const REPORT_INSIGHT_FETCH_SIZE = REPORT_INSIGHT_TOP_N + 1;
export const REPORT_INSIGHT_MIN_SAMPLE = 5;
export const REPORT_INSIGHT_SHARE_THRESHOLD = 0.5;
export const REPORT_INSIGHT_COST_DELTA_THRESHOLD = 0.2;

const objectives: Record<
  ReportInsightObjective,
  {
    costKey: ReportInsightCostKey;
    fallbackLabel: string;
    volumeKey: ReportInsightMetricKey;
  }
> = {
  real_conversations: {
    costKey: "costPerRealConversationCents",
    fallbackLabel: "Leads novos",
    volumeKey: "realConversations",
  },
  qualified_lead: {
    costKey: "costPerQualifiedLeadCents",
    fallbackLabel: "Leads qualificados",
    volumeKey: "qualifiedLead",
  },
  purchase: {
    costKey: "costPerPurchaseCents",
    fallbackLabel: "Compras",
    volumeKey: "purchases",
  },
};

export const reportInsightObjectiveKeys = Object.keys(
  objectives,
) as ReportInsightObjective[];

export function parseReportInsightObjective(
  value: string | undefined,
): ReportInsightObjective {
  return value === "qualified_lead" || value === "purchase"
    ? value
    : "real_conversations";
}

// Rankings reuse the API ordering, which sorts the whole filtered population
// before pagination. Missing costs always sort last on the server.
export function reportInsightSorts(objective: ReportInsightObjective): {
  volume: ReportSortDto;
  cost: ReportSortDto;
} {
  const { costKey, volumeKey } = objectives[objective];

  return {
    volume: { key: volumeKey satisfies ReportSortKeyDto, direction: "desc" },
    cost: { key: costKey satisfies ReportSortKeyDto, direction: "asc" },
  };
}

// The funnel only lists a step when the workspace configures or records it,
// so a missing step means "not tracked", which is different from zero.
export function reportInsightObjectiveTracked(
  objective: ReportInsightObjective,
  funnelSteps: ReportFunnelStepDto[],
): boolean {
  return funnelSteps.some((step) => step.key === objective);
}

export function reportInsightObjectiveLabel(
  objective: ReportInsightObjective,
  funnelSteps: ReportFunnelStepDto[],
): string {
  return (
    funnelSteps.find((step) => step.key === objective)?.label ??
    objectives[objective].fallbackLabel
  );
}

export function reportInsightVolume(
  objective: ReportInsightObjective,
  metrics: ReportInsightMetrics,
): number {
  return metrics[objectives[objective].volumeKey];
}

export function reportInsightCost(
  objective: ReportInsightObjective,
  metrics: ReportInsightMetrics,
): number | null {
  const value = metrics[objectives[objective].costKey];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatReportInsightMoney(
  cents: number,
  currency?: CurrencyCode | null,
): string {
  return formatReportMoney(cents, currency ?? "BRL");
}

/** O dinheiro da linha pode ser comparado com a média do filtro (mesma moeda). */
export function reportInsightSameCurrency(
  row: Pick<ReportInsightMetrics, "currency">,
  totals: Pick<ReportInsightMetrics, "currency"> | undefined,
): boolean {
  if (!totals || totals.currency === null) {
    return false;
  }

  return (row.currency ?? "BRL") === (totals.currency ?? "BRL");
}

function percentLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function rankingValue(
  kind: ReportInsightKind,
  volume: number,
  costCents: number | null,
): number | null {
  return kind === "volume" ? volume : costCents;
}

function itemSignals({
  costCents,
  kind,
  label,
  neighbors,
  objective,
  row,
  totals,
  volume,
}: {
  costCents: number | null;
  kind: ReportInsightKind;
  label: string;
  neighbors: Array<number | null>;
  objective: ReportInsightObjective;
  row: ReportInsightSourceRow;
  totals?: ReportInsightMetrics;
  volume: number;
}): ReportInsightSignal[] {
  const signals: ReportInsightSignal[] = [];
  const lowSample = volume < REPORT_INSIGHT_MIN_SAMPLE;

  if (lowSample) {
    signals.push({
      key: "low_sample",
      tone: "warn",
      label: "Amostra insuficiente",
      basis: `${volume} ${label} no periodo, abaixo do minimo de ${REPORT_INSIGHT_MIN_SAMPLE} usado nesta leitura. A posicao pode mudar com poucos eventos.`,
    });
  }

  if (row.spendCents === 0) {
    signals.push({
      key: "no_spend",
      tone: "warn",
      label: "Sem investimento registrado",
      basis: `Investimento de ${formatReportInsightMoney(0, row.currency)} no periodo: custo zero nao indica eficiencia. Confira a sincronizacao Meta deste periodo.`,
    });
  }

  const totalVolume = totals ? reportInsightVolume(objective, totals) : 0;

  if (!lowSample && totalVolume > 0) {
    const share = volume / totalVolume;

    if (share >= REPORT_INSIGHT_SHARE_THRESHOLD) {
      signals.push({
        key: "volume_share",
        tone: "neutral",
        label: `Concentra ${percentLabel(share)} do volume do filtro`,
        basis: `${volume} de ${totalVolume} ${label} do filtro. Sinal exibido a partir de ${percentLabel(REPORT_INSIGHT_SHARE_THRESHOLD)}.`,
      });
    }
  }

  // Nunca compara custos de moedas diferentes (filtro misto ou conta em
  // outra moeda que a do filtro).
  const averageCents =
    totals && reportInsightSameCurrency(row, totals)
      ? reportInsightCost(objective, totals)
      : null;

  if (
    !lowSample &&
    row.spendCents > 0 &&
    costCents !== null &&
    averageCents !== null &&
    averageCents > 0
  ) {
    const delta = (costCents - averageCents) / averageCents;

    if (Math.abs(delta) >= REPORT_INSIGHT_COST_DELTA_THRESHOLD) {
      signals.push({
        key: "cost_vs_filter",
        tone: "neutral",
        label: `Custo ${percentLabel(Math.abs(delta))} ${delta < 0 ? "abaixo" : "acima"} da media do filtro`,
        basis: `Media do filtro: ${formatReportInsightMoney(averageCents, totals?.currency)} por resultado (${label}). Sinal exibido a partir de ${percentLabel(REPORT_INSIGHT_COST_DELTA_THRESHOLD)} de diferenca.`,
      });
    }
  }

  const value = rankingValue(kind, volume, costCents);

  if (value !== null && neighbors.some((neighbor) => neighbor === value)) {
    signals.push({
      key: "tie",
      tone: "neutral",
      label: "Empate",
      basis: `Mesmo ${kind === "volume" ? "volume" : "custo"} de outro item do filtro; a ordem do empate segue o nome, definida pela API.`,
    });
  }

  return signals;
}

// Builds a ranking from rows already ordered by the API. The order is never
// changed here; items without a rankable value are only left out.
export function buildReportInsightRanking<T extends ReportInsightSourceRow>({
  kind,
  label,
  objective,
  rows,
  totals,
}: {
  kind: ReportInsightKind;
  label?: string;
  objective: ReportInsightObjective;
  rows: readonly T[];
  totals?: ReportInsightMetrics;
}): ReportInsightRanking<T> {
  const objectiveLabel =
    label ?? reportInsightObjectiveLabel(objective, totals?.funnelSteps ?? []);
  const values = rows.map((row) =>
    rankingValue(
      kind,
      reportInsightVolume(objective, row),
      reportInsightCost(objective, row),
    ),
  );
  const rankable = (value: number | null) =>
    kind === "volume" ? (value ?? 0) > 0 : value !== null;
  const shown = rows.slice(0, REPORT_INSIGHT_TOP_N);
  const items: Array<ReportInsightItem<T>> = [];
  let excludedWithoutResult = 0;

  shown.forEach((row, index) => {
    if (!rankable(values[index])) {
      excludedWithoutResult += 1;
      return;
    }

    const volume = reportInsightVolume(objective, row);
    const costCents = reportInsightCost(objective, row);

    items.push({
      id: row.id,
      position: index + 1,
      row,
      volume,
      costCents,
      signals: itemSignals({
        costCents,
        kind,
        label: objectiveLabel,
        neighbors: [values[index - 1] ?? null, values[index + 1] ?? null],
        objective,
        row,
        totals,
        volume,
      }),
    });
  });

  return { items, excludedWithoutResult };
}
