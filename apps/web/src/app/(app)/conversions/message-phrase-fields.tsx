"use client";

import type { ConversionEventNameDto } from "@wpptrack/shared";
import {
  conversionEventCarriesValue,
  conversionEventRequiresValue,
  formatMoney,
  normalizeCurrencyCode,
} from "@wpptrack/shared";
import { useWorkspaceCurrency } from "../../../components/workspace-currency";

type MessageAuthorScope = "team" | "contact" | "both";

type MessagePhraseValueMode = "fixed" | "message_extracted";

/** Campos de uma regra message_phrase, qualquer que seja o evento. */
type MessagePhraseValues = {
  averageValue: string;
  contentName: string;
  primaryPhrase: string;
  variationPhrases: string;
  exampleMessage: string;
  valueMode: MessagePhraseValueMode;
  messageAuthorScope: MessageAuthorScope;
};

export type MessagePhrasePreview = {
  matchedPhrase: string | null;
  valueCents: number | null;
  valueSource: "fixed" | "message" | "fallback" | null;
  ambiguousValue: boolean;
};

/**
 * Trigger phrases, example message and value pipeline of a message_phrase rule.
 * The preview mirrors the server heuristics: contains match on the normalized
 * phrase and a single distinct money value in the message.
 */
export function MessagePhraseFields({
  eventName,
  averageValue,
  contentName,
  primaryPhrase,
  variationPhrases,
  exampleMessage,
  valueMode,
  messageAuthorScope,
  contactAvailable = true,
  currency,
  onChange,
}: MessagePhraseValues & {
  eventName: ConversionEventNameDto;
  /** Algum número conectado lê mensagens do contato (hoje só a Umbler). */
  contactAvailable?: boolean;
  /** Moeda da regra ("" / null = padrão do workspace) para a prévia do valor. */
  currency?: string | null;
  onChange: (patch: Partial<MessagePhraseValues>) => void;
}) {
  const workspaceCurrency = useWorkspaceCurrency();
  const previewCurrency = normalizeCurrencyCode(currency) ?? workspaceCurrency;
  const carriesValue = conversionEventCarriesValue(eventName);
  const extracting = carriesValue && valueMode === "message_extracted";
  const preview = previewMessagePhrase({
    triggerPhrases: mergeTriggerPhrases(primaryPhrase, variationPhrases),
    exampleMessage,
    valueMode: extracting ? "message_extracted" : "fixed",
    averageValue,
  });

  return (
    <div className="provider-conversion-message-fields">
      <label>
        <span className="field-label">Frase principal</span>
        <input
          value={primaryPhrase}
          onChange={(event) => onChange({ primaryPhrase: event.target.value })}
          maxLength={2_400}
          placeholder="Ex.: A sua consulta está agendada"
          required
        />
      </label>
      <label>
        <span className="field-label">Variações (opcional)</span>
        <textarea
          value={variationPhrases}
          onChange={(event) =>
            onChange({ variationPhrases: event.target.value })
          }
          rows={3}
          maxLength={4_800}
          placeholder={
            "Uma por linha. Ex.: consulta confirmada\nestou confirmando sua consulta"
          }
        />
        <small className="action-note">
          Secretarias nem sempre usam a mesma frase. Cadastre variações comuns.
        </small>
      </label>

      <div className="provider-conversion-base-fields provider-conversion-base-fields-2col">
        <label>
          <span className="field-label">Exemplo da mensagem</span>
          <textarea
            value={exampleMessage}
            onChange={(event) =>
              onChange({ exampleMessage: event.target.value })
            }
            rows={3}
            maxLength={2_000}
            placeholder={
              carriesValue
                ? "Ex.: Pagamento confirmado no valor de R$ 1.397,00"
                : "Ex.: Perfeito! Vou te passar os valores agora."
            }
          />
        </label>
        <label>
          <span className="field-label">Quem pode enviar</span>
          <select
            value={messageAuthorScope}
            onChange={(event) =>
              onChange({
                messageAuthorScope: event.target.value as MessageAuthorScope,
              })
            }
          >
            <option value="team">Equipe ou bot</option>
            <option
              value="contact"
              disabled={!contactAvailable && messageAuthorScope !== "contact"}
            >
              Somente contato (só na Umbler)
            </option>
            <option value="both">Equipe, bot ou contato</option>
          </select>
        </label>
      </div>

      {carriesValue ? (
        <>
          <fieldset className="provider-conversion-value-modes">
            <legend className="field-label">Modo de valor</legend>
            <div>
              <label>
                <input
                  type="radio"
                  name="messagePhraseValueMode"
                  value="fixed"
                  checked={!extracting}
                  onChange={() => onChange({ valueMode: "fixed" })}
                />
                <span>Valor fixo</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="messagePhraseValueMode"
                  value="message_extracted"
                  checked={extracting}
                  onChange={() => onChange({ valueMode: "message_extracted" })}
                />
                <span>Extrair da mensagem</span>
              </label>
            </div>
          </fieldset>

          <div className="provider-conversion-base-fields provider-conversion-base-fields-2col">
            <label>
              <span className="field-label">
                {averageValueLabel(eventName, extracting)}
              </span>
              <input
                value={averageValue}
                onChange={(event) =>
                  onChange({ averageValue: event.target.value })
                }
                inputMode="decimal"
                placeholder="Ex.: 250,00"
                required={
                  !extracting && conversionEventRequiresValue(eventName)
                }
              />
            </label>
            <label>
              <span className="field-label">Produto (opcional)</span>
              <input
                value={contentName}
                onChange={(event) =>
                  onChange({ contentName: event.target.value })
                }
                maxLength={180}
                placeholder="Ex.: Consulta"
              />
            </label>
          </div>
        </>
      ) : null}

      <div className="provider-conversion-preview">
        <span className="micro-label">Prévia do reconhecimento</span>
        <strong>
          {preview.matchedPhrase
            ? `Frase gatilho reconhecida: ${preview.matchedPhrase}`
            : exampleMessage.trim()
              ? "Nenhuma frase gatilho encontrada no exemplo."
              : "Escreva um exemplo para conferir o reconhecimento."}
        </strong>
        <small>
          {carriesValue
            ? previewValueLabel(preview, extracting, eventName, previewCurrency)
            : "Este evento não envia valor monetário."}
        </small>
      </div>
    </div>
  );
}

function averageValueLabel(
  eventName: ConversionEventNameDto,
  extracting: boolean,
): string {
  if (extracting) return "Valor médio (fallback, opcional)";

  return conversionEventRequiresValue(eventName)
    ? "Valor médio"
    : "Valor médio (opcional)";
}

function previewValueLabel(
  preview: MessagePhrasePreview,
  extracting: boolean,
  eventName: ConversionEventNameDto,
  currency: string = "BRL",
): string {
  if (preview.ambiguousValue) {
    return "O exemplo tem mais de um valor. A regra vai pedir revisão manual.";
  }
  if (preview.valueCents === null) {
    if (extracting) {
      return conversionEventRequiresValue(eventName)
        ? "Nenhum valor no exemplo e sem valor médio de fallback: a conversão ficaria em revisão."
        : "Nenhum valor no exemplo. Este evento pode ser enviado sem valor.";
    }

    return conversionEventRequiresValue(eventName)
      ? "Informe o valor médio enviado por esta regra."
      : "Sem valor médio: este evento seria enviado sem valor.";
  }

  const money = formatMoney(preview.valueCents, currency);
  if (preview.valueSource === "message") {
    return `Valor extraído do exemplo: ${money}`;
  }
  if (preview.valueSource === "fallback") {
    return `Sem valor no exemplo. Seria enviado o valor médio: ${money}`;
  }

  return `Valor fixo enviado em toda conversão: ${money}`;
}

/**
 * Client-side rehearsal of the server decision for message_phrase rules:
 * normalized "contains" match of the trigger phrases plus the money value of
 * the example. Values only count when the example carries a single amount, the
 * same guard the parser applies before trusting a message value.
 */
export function previewMessagePhrase(input: {
  triggerPhrases: string;
  exampleMessage: string;
  valueMode: MessagePhraseValueMode;
  averageValue: string;
}): MessagePhrasePreview {
  const example = input.exampleMessage.trim();
  const matchedPhrase = matchTriggerPhrase(
    example,
    parseTriggerPhrases(input.triggerPhrases),
  );
  const fallbackCents = parseMoneyToCents(input.averageValue);

  if (input.valueMode === "fixed") {
    return {
      matchedPhrase,
      valueCents: fallbackCents,
      valueSource: fallbackCents === null ? null : "fixed",
      ambiguousValue: false,
    };
  }

  const values = messageMoneyValues(example);
  if (values.length > 1) {
    return {
      matchedPhrase,
      valueCents: null,
      valueSource: null,
      ambiguousValue: true,
    };
  }

  const extracted = values[0] ?? null;
  const valueCents = extracted ?? fallbackCents;
  return {
    matchedPhrase,
    valueCents,
    valueSource:
      valueCents === null ? null : extracted === null ? "fallback" : "message",
    ambiguousValue: false,
  };
}

function normalizeMessageText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ");
}

function matchTriggerPhrase(
  message: string,
  triggerPhrases: string[],
): string | null {
  if (!message) return null;

  const normalizedMessage = normalizeMessageText(message);
  return (
    triggerPhrases.find((phrase) => {
      const normalizedPhrase = normalizeMessageText(phrase);
      return (
        normalizedPhrase.length > 0 &&
        normalizedMessage.includes(normalizedPhrase)
      );
    }) ?? null
  );
}

const messageMoneyPattern =
  /(?:^|[^\d])((?:R\$\s*)?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}|(?:US\$\s*|\$\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?=$|[^\d])/giu;

/** Distinct money values of a message, in cents. Mirrors the server parser. */
function messageMoneyValues(message: string): number[] {
  const values = new Set<number>();
  for (const match of message.matchAll(messageMoneyPattern)) {
    const cents = parseMessageMoneyToken(match[1]);
    if (cents !== null) values.add(cents);
  }

  return [...values];
}

function parseMessageMoneyToken(token: string): number | null {
  const normalized = token.replace(/R\$|US\$|\$/giu, "").replace(/\s+/g, "");
  const decimalSeparator =
    normalized.lastIndexOf(",") > normalized.lastIndexOf(".") ? "," : ".";
  const [wholePart, decimalPart] = normalized.split(decimalSeparator);
  if (!wholePart || !/^\d{2}$/u.test(decimalPart ?? "")) return null;

  const wholeDigits = wholePart.replace(/[.,]/g, "");
  if (!/^\d+$/u.test(wholeDigits)) return null;

  const cents = Number(wholeDigits) * 100 + Number(decimalPart);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function parseTriggerPhrases(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((phrase) => phrase.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Combines the primary phrase and the "one per line" variations into the
 * single newline-separated string the rest of the pipeline expects.
 * Deduping, trimming and dropping empties happens downstream in
 * parseTriggerPhrases, which every caller of this string already runs.
 */
export function mergeTriggerPhrases(
  primaryPhrase: string,
  variationPhrases: string,
): string {
  return [primaryPhrase, variationPhrases]
    .filter((part) => part.trim())
    .join("\n");
}

export function parseMoneyToCents(value: string): number | null {
  let normalized = value.trim().replace(/R\$/gi, "").replace(/\s/g, "");
  if (!normalized) return null;

  if (normalized.includes(",")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else {
    const parts = normalized.split(".");
    if (parts.length > 2) {
      const decimal = parts.pop();
      normalized = `${parts.join("")}.${decimal}`;
    }
  }

  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
