"use client";

import {
  DEFAULT_CURRENCY_CODE,
  normalizeCurrencyCode,
  supportedCurrencyOptions,
  type CurrencyCode,
} from "@wpptrack/shared";
import { createContext, useContext, type ReactNode } from "react";

/**
 * "Moeda das conversões" do workspace atual, para os formulários de regra que
 * oferecem "Padrão do workspace (X)". Telas sem o provider caem em BRL, a
 * moeda histórica.
 */
const WorkspaceCurrencyContext = createContext<CurrencyCode>(
  DEFAULT_CURRENCY_CODE,
);

export function WorkspaceCurrencyProvider({
  currency,
  children,
}: {
  currency: CurrencyCode | null | undefined;
  children?: ReactNode;
}) {
  return (
    <WorkspaceCurrencyContext.Provider
      value={normalizeCurrencyCode(currency) ?? DEFAULT_CURRENCY_CODE}
    >
      {children}
    </WorkspaceCurrencyContext.Provider>
  );
}

export function useWorkspaceCurrency(): CurrencyCode {
  return useContext(WorkspaceCurrencyContext);
}

/** "" = herdar o padrão do workspace (null na API). */
export type RuleCurrencyChoice = "" | CurrencyCode;

export function ruleCurrencyChoice(value: unknown): RuleCurrencyChoice {
  return normalizeCurrencyCode(value) ?? "";
}

export function workspaceDefaultCurrencyLabel(currency: CurrencyCode): string {
  return `Padrão do workspace (${currency})`;
}

/**
 * Moeda de uma regra: "Padrão do workspace (X)" mantém a regra sem moeda
 * (null = herdar), então uma troca posterior da "Moeda das conversões" vale
 * para ela; BRL/USD/EUR fixam a regra. A moeda que a venda ou o negócio
 * declara sempre vence.
 */
export function RuleCurrencySelect({
  value,
  onChange,
  name,
  label = "Moeda",
  hint = "Usada quando a venda não informa a moeda.",
  disabled = false,
  className = "conversion-field",
}: {
  value: RuleCurrencyChoice;
  onChange?: (value: RuleCurrencyChoice) => void;
  /** Nome do campo em formulários de server action (não controlados). */
  name?: string;
  label?: string;
  hint?: string | null;
  disabled?: boolean;
  className?: string;
}) {
  const workspaceCurrency = useWorkspaceCurrency();
  const controlled = Boolean(onChange);

  return (
    <label className={className}>
      <span className="field-label">{label}</span>
      <select
        name={name}
        disabled={disabled}
        {...(controlled
          ? {
              value,
              onChange: (event) =>
                onChange?.(ruleCurrencyChoice(event.currentTarget.value)),
            }
          : { defaultValue: value })}
      >
        <option value="">
          {workspaceDefaultCurrencyLabel(workspaceCurrency)}
        </option>
        {supportedCurrencyOptions.map((option) => (
          <option key={option.code} value={option.code}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <small className="field-hint">{hint}</small> : null}
    </label>
  );
}

/**
 * Moeda obrigatória de uma regra de CRM (Kommo/Pipedrive): BRL/USD/EUR, e
 * regras novas começam na moeda do workspace. Um código gravado fora da lista
 * continua visível, para que editar a regra nunca troque a moeda sem querer;
 * a API recusa salvá-lo (400 "Moeda inválida") e, no envio, a regra usa a
 * moeda do workspace. `emptyLabel` mostra a opção "sem moeda" quando o campo é opcional
 * (por exemplo, negócio ganho que traz a própria moeda).
 */
export function CrmCurrencySelect({
  value,
  onChange,
  name = "currency",
  label = "Moeda",
  required = false,
  emptyLabel,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  name?: string;
  label?: string;
  required?: boolean;
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const normalized = value.trim().toUpperCase();
  const custom =
    normalized && !normalizeCurrencyCode(normalized) ? normalized : null;

  return (
    <label>
      <span className="field-label">{label}</span>
      <select
        name={name}
        value={normalized}
        onChange={(event) => onChange(event.currentTarget.value)}
        disabled={disabled}
        required={required}
      >
        <option value="">{emptyLabel ?? "Selecione a moeda"}</option>
        {supportedCurrencyOptions.map((option) => (
          <option key={option.code} value={option.code}>
            {option.label}
          </option>
        ))}
        {custom ? (
          <option value={custom}>
            {`${custom} (não aceita mais: escolha BRL, USD ou EUR)`}
          </option>
        ) : null}
      </select>
    </label>
  );
}
