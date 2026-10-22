"use client";

import {
  normalizeCurrencyCode,
  supportedCurrencyOptions,
  type CurrencyCode,
} from "@wpptrack/shared";
import { useState } from "react";
import { BackofficeActionForm } from "../../../components/backoffice-action-form";
import { PendingSubmitButton } from "../../../components/pending-submit-button";
import { saveConversionCurrencyAction } from "./currency-settings-actions";

/** Aviso mostrado antes de salvar a troca da moeda das conversões. */
export function conversionCurrencyChangeWarning(
  current: CurrencyCode,
  next: CurrencyCode,
): string {
  if (current === next) {
    return "Trocar a moeda do workspace afeta só as conversões novas. As já enviadas à Meta não mudam.";
  }

  return `Trocar de ${current} para ${next} afeta só as conversões novas. As já enviadas à Meta continuam em ${current}, e regras com moeda própria não mudam.`;
}

export function ConversionCurrencyForm({
  current,
  supportedCurrencies,
}: {
  current: CurrencyCode;
  supportedCurrencies: readonly string[];
}) {
  const [selected, setSelected] = useState<CurrencyCode>(current);
  const changed = selected !== current;

  return (
    <BackofficeActionForm
      action={saveConversionCurrencyAction}
      className="currency-settings-form"
    >
      <label className="conversion-field">
        <span className="field-label">Moeda das conversões</span>
        <select
          name="conversionCurrency"
          value={selected}
          onChange={(event) =>
            setSelected(
              normalizeCurrencyCode(event.currentTarget.value) ?? current,
            )
          }
        >
          {supportedCurrencyOptions
            .filter((option) => supportedCurrencies.includes(option.code))
            .map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
        </select>
      </label>
      <p
        className={`action-note${changed ? " warn" : ""}`}
        data-currency-warning={changed ? "changed" : "idle"}
        role={changed ? "alert" : undefined}
      >
        {conversionCurrencyChangeWarning(current, selected)}
      </p>
      <PendingSubmitButton
        className="button primary"
        label="Salvar moeda"
        pendingLabel="Salvando..."
        disabled={!changed}
      />
    </BackofficeActionForm>
  );
}
