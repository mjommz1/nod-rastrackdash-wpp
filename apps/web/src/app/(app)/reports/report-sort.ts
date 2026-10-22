import {
  reportSortDirectionSchema,
  reportSortKeySchema,
  type ReportSortDto,
  type ReportSortKeyDto,
} from "@wpptrack/shared";

type ReportSortMetricGroup = "overview" | "traffic" | "funnel" | "revenue";

export type ReportSortColumnKeys = {
  count: ReportSortKeyDto;
  cost: ReportSortKeyDto;
};

// Funnel columns render the count with its cost below; both values come from
// the same canonical row metrics the API orders by.
const funnelStepSortKeys: Record<string, ReportSortColumnKeys> = {
  real_conversations: {
    count: "realConversations",
    cost: "costPerRealConversationCents",
  },
  qualified_lead: {
    count: "qualifiedLead",
    cost: "costPerQualifiedLeadCents",
  },
  purchase: {
    count: "purchases",
    cost: "costPerPurchaseCents",
  },
};

export function reportSortColumnKeys(
  stepKey: string,
): ReportSortColumnKeys | null {
  return funnelStepSortKeys[stepKey] ?? null;
}

// Mirrors which funnel columns each metric group renders, so a sort is never
// applied to a column the user cannot see.
export function reportSortVisibleInMetricGroup(
  key: ReportSortKeyDto,
  metricGroup: ReportSortMetricGroup,
): boolean {
  if (metricGroup === "overview" || metricGroup === "funnel") {
    return true;
  }

  if (metricGroup === "traffic") {
    return key === "realConversations" || key === "costPerRealConversationCents";
  }

  return false;
}

// Unsupported keys are dropped instead of forwarded, because the API rejects
// them with 400. A direction without a valid key is dropped for the same
// reason; an invalid direction on a valid key falls back to descending.
export function parseReportSort(
  sort: string | undefined,
  dir: string | undefined,
  metricGroup: ReportSortMetricGroup,
): ReportSortDto | undefined {
  const key = reportSortKeySchema.safeParse(sort);

  if (!key.success || !reportSortVisibleInMetricGroup(key.data, metricGroup)) {
    return undefined;
  }

  const direction = reportSortDirectionSchema.safeParse(dir);

  return {
    key: key.data,
    direction: direction.success ? direction.data : "desc",
  };
}

export function nextReportSort(
  current: ReportSortDto | undefined,
  key: ReportSortKeyDto,
): ReportSortDto {
  if (current?.key !== key) {
    return { key, direction: "desc" };
  }

  return { key, direction: current.direction === "desc" ? "asc" : "desc" };
}
