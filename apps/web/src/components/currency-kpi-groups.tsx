import { currencySymbol, type UnconvertedRevenueDto } from "@wpptrack/shared";
import {
  currencyGroupHasActivity,
  exchangeRateMissingHint,
  exchangeRateMissingLabel,
  formatReportMoney,
  unconvertedRevenueLabel,
  type CurrencyKpiGroup,
} from "../lib/report-currency";

const currencyNames: Record<string, string> = {
  BRL: "Real",
  USD: "Dólar",
  EUR: "Euro",
};

function roasLabel(value: number | null): string {
  return value === null
    ? "-"
    : `${value.toLocaleString("pt-BR", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 0,
      })}x`;
}

export function currencyGroupLabel(currency: string): string {
  return `${currencyNames[currency] ?? currency} (${currencySymbol(currency)})`;
}

/**
 * Aviso de receita que ficou fora do total por falta de cotação: mostra o
 * valor na moeda original e explica, em uma frase, como converter.
 */
export function ExchangeRateMissingNote({
  unconvertedRevenue,
}: {
  unconvertedRevenue: readonly UnconvertedRevenueDto[];
}) {
  const label = unconvertedRevenueLabel(unconvertedRevenue);

  return (
    <p
      className="currency-unconverted-note"
      role="note"
      title={exchangeRateMissingHint}
    >
      {label
        ? `Fora da receita por falta de cotação: ${label}. `
        : "Há vendas sem cotação do dia. "}
      <span>{exchangeRateMissingHint}</span>
    </p>
  );
}

/**
 * Totais em dinheiro quando o recorte mistura moedas das contas de anúncio:
 * um bloco por moeda, lado a lado, sem somar valores de moedas diferentes.
 * Se a receita de um bloco não pôde ser convertida (sem cotação PTAX), o ROAS
 * mostra "sem cotação" e a receita que ficou de fora aparece na moeda original.
 */
export function CurrencyKpiGroups({
  groups,
  hideCosts = false,
  hideRevenue = false,
  title = "Totais por moeda",
}: {
  groups: CurrencyKpiGroup[];
  /** Custo por lead/conversa escondido (recorte em que o custo enganaria). */
  hideCosts?: boolean;
  /** Workspaces só de leads não têm receita nem ROAS. */
  hideRevenue?: boolean;
  title?: string;
}) {
  // Defesa: só moedas com movimento no período, e só quando há 2 ou mais
  // (uma moeda só usa os cartões normais).
  const activeGroups = groups.filter(currencyGroupHasActivity);

  if (activeGroups.length < 2) {
    return null;
  }

  return (
    <section
      className="currency-kpi-groups"
      aria-label={title}
      data-currency-groups={activeGroups.length}
    >
      <div className="currency-kpi-groups-heading">
        <span className="micro-label">{title}</span>
        <small>
          As contas de anúncio usam moedas diferentes: cada moeda tem seus
          próprios totais, sem somar valores.
        </small>
      </div>
      <div className="currency-kpi-group-list">
        {activeGroups.map((group) => (
          <article
            className="currency-kpi-group"
            data-currency={group.currency}
            key={group.currency}
          >
            <header>
              <span className="tag currency-badge">{group.currency}</span>
              <strong>{currencyGroupLabel(group.currency)}</strong>
              {group.exchangeRateMissing ? (
                <span
                  className="status-chip warn currency-rate-missing"
                  title="Alguma venda não pôde ser convertida pela PTAX do dia"
                  aria-label="Sem cotação: alguma venda não pôde ser convertida pela PTAX do dia"
                >
                  {exchangeRateMissingLabel}
                </span>
              ) : null}
            </header>
            <dl>
              <div>
                <dt>Investimento</dt>
                <dd>{formatReportMoney(group.spendCents, group.currency)}</dd>
              </div>
              {hideRevenue ? null : (
                <>
                  <div>
                    <dt>Receita</dt>
                    <dd>
                      {formatReportMoney(
                        group.totalRevenueCents,
                        group.currency,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>ROAS</dt>
                    <dd
                      className={
                        group.exchangeRateMissing
                          ? "currency-roas-missing"
                          : undefined
                      }
                    >
                      {group.exchangeRateMissing
                        ? exchangeRateMissingLabel
                        : roasLabel(group.roasAcquisition)}
                    </dd>
                  </div>
                </>
              )}
              <div>
                <dt>CPL</dt>
                <dd>
                  {hideCosts
                    ? "-"
                    : formatReportMoney(
                        group.costPerRealConversationCents,
                        group.currency,
                      )}
                </dd>
              </div>
              <div>
                <dt>Custo por conversa</dt>
                <dd>
                  {hideCosts
                    ? "-"
                    : formatReportMoney(
                        group.costPerMetaConversationCents,
                        group.currency,
                      )}
                </dd>
              </div>
            </dl>
            {group.exchangeRateMissing ? (
              <ExchangeRateMissingNote
                unconvertedRevenue={group.unconvertedRevenue}
              />
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
