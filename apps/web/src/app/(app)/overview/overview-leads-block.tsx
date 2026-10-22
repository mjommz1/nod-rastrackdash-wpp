import Link from "next/link";
import { OverviewLeadsHint } from "./overview-leads-hint";

/**
 * "Leads no período": the people behind the period, always visible, so a
 * zero (nobody came back) reads as a real zero instead of a missing line.
 * Only "Leads novos" is the CPL base; the other numbers are context.
 */

export type OverviewLeadsBlockItem = {
  key: "new" | "returning" | "repeat" | "conversations";
  label: string;
  /** `null` = the API did not send this number (shown as "-"). */
  value: number | null;
  caption: string;
  hint: string;
  /** Exact Leads list behind the number, when the Leads page can rebuild it. */
  href?: string | null;
  hrefLabel?: string;
};

export const overviewLeadsHints = {
  new: "Pessoas que falaram com você pela primeira vez neste período, vindas de anúncio. Cada pessoa conta uma vez, no dia do primeiro contato. É a base do custo por lead.",
  returning:
    "Já eram leads antes do período e chamaram de novo por anúncio. Não entram no custo por lead.",
  repeat:
    "Pessoas que iniciaram 2 ou mais conversas por anúncio no período, sejam leads novos ou antigos.",
  conversations:
    "Todas as conversas iniciadas por anúncio no período, como foram informadas à Meta. Uma pessoa pode iniciar várias.",
} as const;

export function OverviewLeadsBlock({
  available,
  items,
  rangeLabel,
}: {
  available: boolean;
  items: OverviewLeadsBlockItem[];
  rangeLabel: string;
}) {
  return (
    <section
      className="surface-panel overview-leads-block"
      aria-labelledby="overview-leads-title"
    >
      <div className="overview-leads-block-heading">
        <div>
          <span className="eyebrow">Leads no período</span>
          <h2 id="overview-leads-title">Quem chamou por anúncio</h2>
        </div>
        <span className="tag">{rangeLabel}</span>
      </div>

      <dl className="overview-leads-block-grid">
        {items.map((item) => {
          const hintId = `overview-leads-hint-${item.key}`;
          const value =
            available && item.value !== null ? String(item.value) : "-";

          return (
            <div
              className={`overview-leads-block-item${item.key === "new" ? " headline" : ""}`}
              data-leads-block={item.key}
              key={item.key}
            >
              <dt>
                <span>{item.label}</span>
                <OverviewLeadsHint
                  id={hintId}
                  label={item.label}
                  text={item.hint}
                />
              </dt>
              <dd>
                <strong>
                  {/* No link on "-": there is no number to reproduce. */}
                  {available && item.value !== null && item.href ? (
                    <Link
                      className="kpi-number-link"
                      href={item.href}
                      aria-label={
                        item.hrefLabel
                          ? `${value} - ${item.hrefLabel}`
                          : undefined
                      }
                    >
                      {value}
                    </Link>
                  ) : (
                    value
                  )}
                </strong>
                <small>
                  {available ? item.caption : "Aguardando resposta da API"}
                </small>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
