"use client";

import type { ConversionEventNameDto } from "@wpptrack/shared";
import { conversionEventCarriesValue } from "@wpptrack/shared";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

/**
 * Espelha o contrato aceito pelo parser da automacao da Umbler
 * (apps/api/src/inbound-webhooks/providers/umbler/umbler-automation-v1.parser.ts).
 * Mude os dois lados juntos se o schema mudar: o operador copia este JSON
 * literalmente para a automacao HTTP da Umbler.
 */
const UMBLER_AUTOMATION_V1_SCHEMA = "wpptrack.umbler.automation.v1";
const UMBLER_AUTOMATION_V1_SOURCE = "umbler_tag_automation";

export type UmblerAutomationKey = "lead_qualificado" | "compra_aprovada";

/** O parser da automacao so reconhece estes dois eventos. */
export function umblerAutomationKeyForEvent(
  eventName: ConversionEventNameDto,
): UmblerAutomationKey | null {
  if (eventName === "QualifiedLead") return "lead_qualificado";
  if (eventName === "Purchase") return "compra_aprovada";
  return null;
}

/** Referencia mais proxima quando o evento da regra nao mapeia para um automation valido. */
function umblerAutomationFallbackForEvent(
  eventName: ConversionEventNameDto,
): UmblerAutomationKey {
  return conversionEventCarriesValue(eventName)
    ? "compra_aprovada"
    : "lead_qualificado";
}

export function buildUmblerAutomationPayloadExample(
  automation: UmblerAutomationKey,
): Record<string, unknown> {
  return {
    schema: UMBLER_AUTOMATION_V1_SCHEMA,
    source: UMBLER_AUTOMATION_V1_SOURCE,
    automation,
    contact: { phone: "+55..." },
    conversation: {
      id: "CONVERSATION_ID",
      created_at_utc: "YYYY-MM-DD HH:mm:ss",
    },
  };
}

/**
 * Corpo JSON que a automacao HTTP da Umbler precisa enviar para o callback de
 * tag/automacao. Aparece logo apos criar (ou rotacionar) a URL de uso unico e
 * tambem no "Como configurar" de uma regra ja existente.
 */
export function UmblerAutomationPayloadPanel({
  eventName,
}: {
  eventName: ConversionEventNameDto;
}) {
  const automation = umblerAutomationKeyForEvent(eventName);
  const exampleAutomation =
    automation ?? umblerAutomationFallbackForEvent(eventName);
  const payloadJson = JSON.stringify(
    buildUmblerAutomationPayloadExample(exampleAutomation),
    null,
    2,
  );
  const [copied, setCopied] = useState(false);

  async function copyPayload() {
    try {
      await navigator.clipboard.writeText(payloadJson);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="provider-conversion-payload-helper">
      <div>
        <span className="micro-label">Corpo JSON da automação</span>
        <strong>Configuração HTTP na Umbler</strong>
      </div>
      {automation ? null : (
        <p className="action-note warn">
          O callback da Umbler só reconhece os eventos Lead qualificado
          (lead_qualificado) ou Compra aprovada (compra_aprovada). Troque o
          evento desta regra para um dos dois, ou use &quot;{exampleAutomation}
          &quot; como referência mais próxima.
        </p>
      )}
      <pre className="payload-block" data-presentation-sensitive-field="true">
        {payloadJson}
      </pre>
      <button
        className="button subtle"
        type="button"
        onClick={() => void copyPayload()}
      >
        {copied ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <Copy size={14} aria-hidden="true" />
        )}
        {copied ? "Copiado" : "Copiar JSON"}
      </button>
      <ol className="provider-conversion-payload-steps">
        <li>
          Copie o endereço da automação e cole no campo de URL da ação HTTP na
          Umbler.
        </li>
        <li>
          Método POST; o token de acesso já está no endereço, sem cabeçalho extra.
        </li>
        <li>Cole o corpo JSON acima no campo de body da ação HTTP.</li>
        <li>
          Mapeie contact.phone, conversation.id e conversation.created_at_utc
          para os campos reais do contato e da conversa na automação da Umbler.
        </li>
      </ol>
    </div>
  );
}
