"use client";

import { FlaskConical } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import type { ProviderConversionRuleActionResult } from "../conversions/actions";
import { ProviderCatalogTestResult } from "./provider-catalog-test-result";

type ProviderCatalogTestConsoleProps = {
  ruleId: string;
  testMessageAction: (
    formData: FormData,
  ) => Promise<ProviderConversionRuleActionResult>;
};

export function ProviderCatalogTestConsole({
  ruleId,
  testMessageAction,
}: ProviderCatalogTestConsoleProps) {
  const [pending, setPending] = useState(false);
  const [result, setResult] =
    useState<ProviderConversionRuleActionResult["testResult"]>(undefined);
  const [error, setError] = useState<string | null>(null);

  async function handleTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const form = event.currentTarget;
    const formData = new FormData(form);
    formData.set("ruleId", ruleId);
    setPending(true);
    setError(null);

    const response = await testMessageAction(formData);
    if (response.ok && response.testResult) {
      setResult(response.testResult);
    } else {
      setResult(undefined);
      setError(response.message);
    }

    setPending(false);
  }

  return (
    <form className="provider-catalog-test" onSubmit={handleTest}>
      <label>
        <span className="field-label">Testar mensagem real</span>
        <textarea
          name="messageText"
          rows={4}
          maxLength={8_192}
          placeholder="Cole a mensagem estruturada recebida da Umbler"
          required
        />
      </label>
      <button className="button" type="submit" disabled={pending}>
        <FlaskConical size={15} aria-hidden="true" />
        {pending ? "Testando..." : "Testar sem enviar"}
      </button>
      {result ? <ProviderCatalogTestResult result={result} /> : null}
      {error ? (
        <div className="feedback-banner error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
    </form>
  );
}
