import type { ReportSortDto, ReportSortKeyDto } from "@wpptrack/shared";

export type SortableReportRow = {
  id: string;
  name: string;
} & Partial<Record<ReportSortKeyDto, number | null>>;

// Finite values (zero included) sort by the requested direction. Missing or
// nonfinite values always sort last. Ties fall back to name, then id, both
// ascending by code unit so the order never depends on the server locale.
export function sortReportRows<T extends SortableReportRow>(
  rows: readonly T[],
  sort: ReportSortDto,
): T[] {
  const directionFactor = sort.direction === "asc" ? 1 : -1;

  return [...rows].sort((left, right) => {
    const leftValue = finiteOrNull(left[sort.key]);
    const rightValue = finiteOrNull(right[sort.key]);

    if (leftValue !== rightValue) {
      if (leftValue === null) {
        return 1;
      }

      if (rightValue === null) {
        return -1;
      }

      return (leftValue - rightValue) * directionFactor;
    }

    return (
      compareCodeUnits(left.name, right.name) ||
      compareCodeUnits(left.id, right.id)
    );
  });
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const CURRENCY_ORDER = ["BRL", "USD", "EUR"];

/**
 * Fase 5.2: rows in more than one currency are grouped by currency (BRL, USD,
 * EUR) before the metric order, so values of different currencies are never
 * interleaved. One currency (every BRL-only workspace): same order as
 * sortReportRows.
 */
export function sortReportRowsByCurrency<
  T extends SortableReportRow & { currency?: string | null },
>(rows: readonly T[], sort: ReportSortDto): T[] {
  const sorted = sortReportRows(rows, sort);
  const currencies = new Set(sorted.map((row) => row.currency ?? "BRL"));

  if (currencies.size <= 1) {
    return sorted;
  }

  const rank = (row: T) => {
    const index = CURRENCY_ORDER.indexOf(row.currency ?? "BRL");
    return index >= 0 ? index : CURRENCY_ORDER.length;
  };

  // Array.prototype.sort is stable: the metric order stays inside each group.
  return sorted.sort((left, right) => rank(left) - rank(right));
}
