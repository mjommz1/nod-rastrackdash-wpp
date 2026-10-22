"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useRouter } from "next/navigation";

type ReportSortDirection = "asc" | "desc";

export type ReportSortAction = {
  active: boolean;
  direction: ReportSortDirection;
  href: string;
  label: string;
};

function sortActionName(action: ReportSortAction) {
  if (!action.active) {
    return action.label;
  }

  return `${action.label}, ${
    action.direction === "desc" ? "ordem decrescente" : "ordem crescente"
  }`;
}

function SortArrow({ action }: { action: ReportSortAction }) {
  if (!action.active) {
    return null;
  }

  const Icon = action.direction === "desc" ? ArrowDown : ArrowUp;

  return <Icon aria-hidden="true" className="report-sort-arrow" size={12} />;
}

function useSortNavigation() {
  const router = useRouter();

  // Ordering is applied by the API to the full filtered result, so sorting
  // always navigates to a new server request instead of reordering this page.
  return (href: string) => router.push(href, { scroll: false });
}

export function ReportSortHeader({
  cost,
  count,
  label,
}: {
  cost: ReportSortAction;
  count: ReportSortAction;
  label: string;
}) {
  const navigate = useSortNavigation();
  const active = count.active ? count : cost.active ? cost : null;

  return (
    <th
      aria-sort={
        active
          ? active.direction === "desc"
            ? "descending"
            : "ascending"
          : undefined
      }
      className="report-sort-column"
    >
      <button
        aria-label={sortActionName(count)}
        className={`report-sort-button${count.active ? " active" : ""}`}
        onClick={() => navigate(count.href)}
        type="button"
      >
        {label}
        <SortArrow action={count} />
      </button>
      <button
        aria-label={sortActionName(cost)}
        className={`report-sort-button report-sort-cost${cost.active ? " active" : ""}`}
        onClick={() => navigate(cost.href)}
        type="button"
      >
        Custo
        <SortArrow action={cost} />
      </button>
    </th>
  );
}

// The table header is hidden in the mobile card layout, so the same actions
// are offered here; CSS shows this toolbar only at that breakpoint.
export function ReportSortToolbar({ actions }: { actions: ReportSortAction[] }) {
  const navigate = useSortNavigation();

  if (actions.length === 0) {
    return null;
  }

  return (
    <div
      aria-label="Ordenar resultados"
      className="report-sort-toolbar"
      role="group"
    >
      <span className="micro-label">Ordenar por</span>
      <div>
        {actions.map((action) => (
          <button
            aria-label={sortActionName(action)}
            aria-pressed={action.active}
            className={action.active ? "active" : undefined}
            key={action.label}
            onClick={() => navigate(action.href)}
            type="button"
          >
            {action.label}
            <SortArrow action={action} />
          </button>
        ))}
      </div>
    </div>
  );
}
