"use client";

import { effectiveAccountCurrency, type CurrencyCode } from "@wpptrack/shared";
import { useEffect, useRef, useState } from "react";
import { maxAdAccountFilter } from "../lib/ad-account-params";

export type AdAccountFilterAccount = {
  adAccountId: string;
  adAccountName: string;
  businessName?: string;
  /** Moeda informada pela Meta (MetaReportingAccount.currency). */
  currency?: string | null;
};

export function adAccountFilterSummary(
  value: readonly string[],
  accounts: readonly AdAccountFilterAccount[],
): string {
  if (value.length === 0) {
    return "Todas as contas";
  }

  if (value.length === 1) {
    return (
      accounts.find((account) => account.adAccountId === value[0])
        ?.adAccountName ?? "1 conta"
    );
  }

  return `${value.length} contas`;
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

/**
 * Seleção de contas de anúncio (Visão Geral e Relatórios), dentro do
 * formulário de filtros. Cada conta mostra a moeda efetiva. Ao fechar a lista
 * com "Pronto" (ou clicando fora) e com a seleção alterada, o formulário é
 * aplicado sozinho; o botão "Aplicar" continua valendo para os demais campos.
 *
 * Na URL: 1 conta vira `adAccountId=<id>` e 2 ou mais viram
 * `adAccountIds=<id>,<id>` (o nome do campo escondido muda conforme a seleção).
 */
export function AdAccountFilter({
  accounts,
  appliedValue,
  className,
  currencies = {},
  label = "Conta de anúncio",
  onChange,
  presentationMode = false,
  value,
  variant = "field",
}: {
  accounts: readonly AdAccountFilterAccount[];
  /** O que está na URL agora: só aplica sozinho se a seleção mudou. */
  appliedValue: readonly string[];
  className?: string;
  currencies?: Readonly<Record<string, CurrencyCode>>;
  label?: string;
  onChange: (next: string[]) => void;
  presentationMode?: boolean;
  value: string[];
  /** "field": rótulo acima (Visão Geral). "control": só a caixa (Relatórios). */
  variant?: "field" | "control";
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const [submitRequested, setSubmitRequested] = useState(false);
  const fieldName = value.length > 1 ? "adAccountIds" : "adAccountId";
  const sorted = [...accounts].sort((left, right) =>
    left.adAccountName.localeCompare(right.adAccountName, "pt-BR"),
  );
  // Conta selecionada que saiu da lista (inativa) continua removível.
  const missing = value.filter(
    (id) => !accounts.some((account) => account.adAccountId === id),
  );
  const valueRef = useRef(value);
  valueRef.current = value;
  const appliedRef = useRef(appliedValue);
  appliedRef.current = appliedValue;

  function finish() {
    const details = detailsRef.current;

    if (!details?.open) {
      return;
    }

    details.open = false;

    if (!sameIds(valueRef.current, appliedRef.current)) {
      setSubmitRequested(true);
    }
  }

  // O campo escondido já está atualizado quando o efeito roda.
  useEffect(() => {
    if (!submitRequested) {
      return;
    }

    setSubmitRequested(false);
    detailsRef.current?.closest("form")?.requestSubmit();
  }, [submitRequested]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (
        detailsRef.current?.open &&
        !rootRef.current?.contains(event.target as Node | null)
      ) {
        finish();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  function toggle(id: string) {
    if (value.includes(id)) {
      onChange(value.filter((item) => item !== id));
    } else if (value.length < maxAdAccountFilter) {
      onChange([...value, id]);
    }
  }

  const hiddenInput = (
    <input type="hidden" name={fieldName} value={value.join(",")} />
  );
  const Wrapper = variant === "field" ? "label" : "div";

  if (presentationMode) {
    return (
      <Wrapper
        className={`${variant === "field" ? "filter-field overview-scope-filter " : ""}ad-account-filter${className ? ` ${className}` : ""}`}
      >
        {variant === "field" ? <span>{label}</span> : null}
        {hiddenInput}
        <span className="filter-control presentation-filter-placeholder">
          {value.length === 0
            ? "Todas as contas"
            : value.length === 1
              ? "Conta oculta"
              : `${value.length} contas ocultas`}
        </span>
      </Wrapper>
    );
  }

  return (
    <div
      className={`${variant === "field" ? "filter-field overview-scope-filter " : ""}ad-account-filter ad-account-filter-${variant}${className ? ` ${className}` : ""}`}
      ref={rootRef}
    >
      {variant === "field" ? <span>{label}</span> : null}
      {hiddenInput}
      <details
        className="ad-account-filter-details"
        ref={detailsRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            finish();
          }
        }}
      >
        <summary
          aria-label={variant === "control" ? label : undefined}
          className="ad-account-filter-trigger filter-control"
        >
          <span>{adAccountFilterSummary(value, accounts)}</span>
        </summary>
        <div
          className="ad-account-filter-panel"
          role="group"
          aria-label={label}
        >
          <ul>
            {[
              ...missing.map((id) => ({
                id,
                name: `Conta ${id} (indisponível)`,
                business: undefined as string | undefined,
                currency: undefined as CurrencyCode | undefined,
              })),
              ...sorted.map((account) => ({
                id: account.adAccountId,
                name: account.adAccountName,
                business: account.businessName,
                currency:
                  currencies[account.adAccountId] ??
                  effectiveAccountCurrency(account),
              })),
            ].map((item) => {
              const checked = value.includes(item.id);

              return (
                <li key={item.id}>
                  <label>
                    <input
                      checked={checked}
                      disabled={!checked && value.length >= maxAdAccountFilter}
                      onChange={() => toggle(item.id)}
                      type="checkbox"
                    />
                    <span className="ad-account-filter-name">
                      <strong>{item.name}</strong>
                      {item.business ? <small>{item.business}</small> : null}
                    </span>
                    {item.currency ? (
                      <span className="ad-account-filter-badge">
                        {item.currency}
                      </span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="ad-account-filter-actions">
            <button
              className="button ghost"
              disabled={value.length === 0}
              onClick={() => onChange([])}
              type="button"
            >
              Limpar
            </button>
            <button className="button" onClick={finish} type="button">
              Pronto
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}
