import type {
  ConversionEventNameDto,
  CurrencyCode,
  ProviderConversionRuleCapabilitiesDto,
  ProviderConversionRuleOriginDto,
} from "@wpptrack/shared";
import {
  conversionEventCarriesValue,
  conversionEventRequiresValue,
} from "@wpptrack/shared";
import {
  contactMessageProviders,
  originChannelProviders,
  ruleOriginDefinition,
} from "./conversion-origins";
import type {
  ConversionConnection,
  ConversionNumber,
} from "./conversion-rules-view";

/**
 * Draft of the "Nova regra" flow and the create payload it produces. Pure
 * (no React, no server imports) so every scope/flag decision is unit tested.
 */

export type RuleScopeChoice = "all_numbers" | "specific_numbers";
export type MessageAuthorScope = "team" | "contact" | "both";
export type MessageValueMode = "fixed" | "message_extracted";

export type CatalogVariantDraft = {
  values: string[];
  price: string;
};

export type CatalogDraft = {
  name: string;
  productName: string;
  attributes: string[];
  variants: CatalogVariantDraft[];
};

export type TriggerLabel = { id: string; name: string };

export type RuleDraft = {
  origin: ProviderConversionRuleOriginDto;
  eventName: ConversionEventNameDto;
  scope: RuleScopeChoice;
  channelIds: string[];
  /** Automação da Umbler: a conexão que recebe a chamada. */
  connectionId: string | null;
  name: string;
  primaryPhrase: string;
  variationPhrases: string;
  exampleMessage: string;
  valueMode: MessageValueMode;
  messageAuthorScope: MessageAuthorScope;
  averageValue: string;
  contentName: string;
  labelNames: string;
  triggerLabels: TriggerLabel[];
  catalog: CatalogDraft;
  /**
   * Moeda da regra: "" = "Padrão do workspace" (null na API, herda a Moeda
   * das conversões); a moeda da venda, quando vier, sempre vence.
   */
  currency: "" | CurrencyCode;
  /** Payt: códigos de produto/oferta aceitos (vazio = todos os produtos). */
  productCodes: string[];
};

export type DraftContext = {
  numbers: readonly ConversionNumber[];
  connections: readonly ConversionConnection[];
  /** O que a API aceita (provedores por origem e por autor). */
  capabilities: ProviderConversionRuleCapabilitiesDto | null;
  /** "Moeda das conversões" (catálogo precisa de moeda concreta). */
  workspaceCurrency?: CurrencyCode;
  /**
   * Fase 5.3: a URL única/por evento está ativa no workspace. A regra nova
   * recebe por ela (a URL própria da regra nasce desativada).
   */
  singleUrl?: boolean;
};

export function emptyRuleDraft(
  origin: ProviderConversionRuleOriginDto,
): RuleDraft {
  const definition = ruleOriginDefinition(origin);

  return {
    origin,
    eventName:
      definition.lockedEvent ?? definition.allowedEvents?.[0] ?? "QualifiedLead",
    // "Todos os números" é o padrão: números novos entram sozinhos.
    scope: "all_numbers",
    channelIds: [],
    connectionId: null,
    name: "",
    primaryPhrase: "",
    variationPhrases: "",
    exampleMessage: "",
    valueMode: "fixed",
    messageAuthorScope: "team",
    averageValue: "",
    contentName: "",
    labelNames: "",
    triggerLabels: [],
    currency: "",
    productCodes: [],
    catalog: {
      name: "",
      productName: "",
      attributes: ["Tamanho"],
      variants: [{ values: [""], price: "" }],
    },
  };
}

type Result<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Conexão enviada com a regra. A automação da Umbler usa a conexão escolhida;
 * frase, catálogo e etiqueta só levam conexão quando todos os números
 * escolhidos são da mesma (formato histórico "preso à conexão"); "todos os
 * números" nunca leva conexão.
 */
export function resolveRuleConnectionId(
  draft: Pick<RuleDraft, "origin" | "scope" | "channelIds" | "connectionId">,
  context: Pick<DraftContext, "numbers" | "connections"> &
    Partial<Pick<DraftContext, "capabilities">>,
): string | null {
  const definition = ruleOriginDefinition(draft.origin);
  // Na ordem em que a pessoa escolheu.
  const chosen = draft.channelIds
    .map((id) => context.numbers.find((number) => number.id === id))
    .filter((number): number is ConversionNumber => Boolean(number));

  if (definition.connection === "same_provider") {
    return draft.connectionId;
  }

  if (definition.connection === "any") {
    // Venda da Payt: presa à conexão dos números escolhidos (ou, em "todos os
    // números", à do primeiro número compatível). Nunca uma conexão da Payt.
    const providers = originChannelProviders(
      draft.origin,
      context.capabilities ?? null,
    );
    return (
      chosen[0]?.connectionId ??
      context.numbers.find((number) => providers.includes(number.provider))
        ?.connectionId ??
      null
    );
  }

  if (draft.scope === "all_numbers") return null;
  if (chosen.length === 0) return null;

  const connectionIds = new Set(chosen.map((number) => number.connectionId));
  return connectionIds.size === 1 ? chosen[0]!.connectionId : null;
}

/** Provedores onde a regra roda, considerando "Quem pode enviar". */
export function draftChannelProviders(
  draft: Pick<RuleDraft, "origin" | "messageAuthorScope">,
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
): readonly string[] {
  return draft.origin === "message_phrase" && draft.messageAuthorScope === "contact"
    ? contactMessageProviders(capabilities)
    : originChannelProviders(draft.origin, capabilities);
}

export const paytSingleConnectionNote =
  "As vendas da Payt ficam ligadas à conexão dos números escolhidos: escolha números de uma mesma conexão.";

/** Why the chosen reach cannot be sent, or null when it is fine. */
export function scopeIssue(
  draft: Pick<
    RuleDraft,
    "origin" | "scope" | "channelIds" | "connectionId" | "messageAuthorScope"
  >,
  context: DraftContext,
): string | null {
  const definition = ruleOriginDefinition(draft.origin);

  if (definition.connection === "same_provider" && !draft.connectionId) {
    return "Escolha a conexão que vai chamar o endereço desta regra.";
  }

  if (draft.scope === "all_numbers") {
    return null;
  }

  if (draft.channelIds.length === 0) {
    return "Escolha ao menos um número.";
  }

  const chosen = context.numbers.filter((number) =>
    draft.channelIds.includes(number.id),
  );
  if (chosen.length !== draft.channelIds.length) {
    return "Um dos números escolhidos não está mais conectado. Atualize a página.";
  }
  const providers = draftChannelProviders(draft, context.capabilities);
  if (chosen.some((number) => !providers.includes(number.provider))) {
    return draft.origin === "message_phrase" && draft.messageAuthorScope === "contact"
      ? "Mensagens do contato só são lidas na Umbler. Escolha números da Umbler ou mude “Quem pode enviar”."
      : "Um dos números escolhidos ainda não funciona com esta origem.";
  }
  if (
    definition.connection === "same_provider" &&
    chosen.some((number) => number.connectionId !== draft.connectionId)
  ) {
    return "Escolha só números da conexão selecionada.";
  }
  if (
    definition.connection === "any" &&
    new Set(chosen.map((number) => number.connectionId)).size > 1
  ) {
    return paytSingleConnectionNote;
  }
  return null;
}

/** Chave aleatória (não secreta) de uma tentativa de criação; null sem crypto. */
export function mintRequestKey(): string | null {
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!webCrypto || typeof webCrypto.getRandomValues !== "function") return null;

  const buffer = new Uint8Array(24);
  webCrypto.getRandomValues(buffer);
  return `prc_${Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function parseLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * "1.397,00", "R$ 250", "US$ 250", "€ 99" e "250.5" para centavos; null quando
 * não é um valor positivo.
 */
export function moneyToCents(value: string): number | null {
  let normalized = value
    .trim()
    .replace(/(US\$|R\$|\$|€)/giu, "")
    .replace(/\s/gu, "");
  if (!normalized) return null;

  if (normalized.includes(",")) {
    normalized = normalized.replace(/\./gu, "").replace(",", ".");
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

function valueFields(
  draft: RuleDraft,
  extracting: boolean,
): Result<Record<string, unknown>> {
  if (!conversionEventCarriesValue(draft.eventName)) {
    return { ok: true, value: {} };
  }

  const cents = moneyToCents(draft.averageValue);
  const required =
    !extracting && conversionEventRequiresValue(draft.eventName);
  if (!cents && (required || draft.averageValue.trim())) {
    return { ok: false, message: "Informe um valor médio válido." };
  }

  return {
    ok: true,
    value: {
      ...(cents ? { defaultValueCents: cents } : {}),
      // Sem moeda = herdar a "Moeda das conversões" do workspace.
      ...(draft.currency ? { defaultCurrency: draft.currency } : {}),
      ...(draft.contentName.trim()
        ? { defaultContentName: draft.contentName.trim() }
        : {}),
    },
  };
}

function catalogAttributeKey(label: string, index: number): string {
  const normalized = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 60);

  return /^[a-z]/u.test(normalized) ? normalized : `atributo_${index + 1}`;
}

function catalogPayload(
  draft: RuleDraft,
  workspaceCurrency: CurrencyCode = "BRL",
): Result<Record<string, unknown>> {
  const catalog = draft.catalog;
  const labels = catalog.attributes.map((label) => label.trim());

  if (!catalog.name.trim() || !catalog.productName.trim()) {
    return {
      ok: false,
      message: "Informe o nome do catálogo e do produto.",
    };
  }
  if (labels.length === 0 || labels.some((label) => !label)) {
    return { ok: false, message: "Dê um nome a cada característica." };
  }
  const keys = labels.map(catalogAttributeKey);
  if (new Set(keys).size !== keys.length) {
    return {
      ok: false,
      message: "As características precisam ter nomes diferentes.",
    };
  }
  const variants = catalog.variants.map((variant) => ({
    attributeValues: labels.map((_, index) => (variant.values[index] ?? "").trim()),
    aliases: [],
    valueCents: moneyToCents(variant.price),
  }));
  if (
    variants.length === 0 ||
    variants.some(
      (variant) =>
        variant.attributeValues.some((value) => !value) || !variant.valueCents,
    )
  ) {
    return {
      ok: false,
      message: "Preencha cada opção do catálogo com as características e o preço.",
    };
  }
  const combinations = variants.map((variant) =>
    variant.attributeValues.map((value) => value.toLocaleLowerCase("pt-BR")).join("|"),
  );
  if (new Set(combinations).size !== combinations.length) {
    return { ok: false, message: "Cada opção do catálogo deve ser única." };
  }

  return {
    ok: true,
    value: {
      name: catalog.name.trim(),
      productName: catalog.productName.trim(),
      // Preços de catálogo precisam de moeda concreta.
      currency: draft.currency || workspaceCurrency,
      attributes: labels.map((label, index) => ({ key: keys[index], label })),
      variants,
    },
  };
}

/**
 * Create payload for POST /conversion-rules/providers. Rules always start in
 * observation (nothing is sent to Meta until "Ativar envio automático").
 */
export function buildRulePayload(
  draft: RuleDraft,
  context: DraftContext,
): Result<Record<string, unknown>> {
  const name = draft.name.trim();
  if (name.length < 2) {
    return { ok: false, message: "Dê um nome para a regra." };
  }

  const issue = scopeIssue(draft, context);
  if (issue) return { ok: false, message: issue };

  const definition = ruleOriginDefinition(draft.origin);
  const connectionId = resolveRuleConnectionId(draft, context);
  if (definition.connection !== "none" && !connectionId) {
    return {
      ok: false,
      message: "Conecte um número de WhatsApp antes de criar esta regra.",
    };
  }
  const eventName = definition.lockedEvent ?? draft.eventName;
  if (definition.allowedEvents && !definition.allowedEvents.includes(eventName)) {
    return {
      ok: false,
      message: "Esta origem não reconhece o evento escolhido.",
    };
  }
  const base = {
    name,
    ...(connectionId ? { connectionId } : {}),
    ...(draft.scope === "all_numbers" ? { scope: "all_numbers" } : {}),
    channelIds: draft.scope === "all_numbers" ? [] : [...draft.channelIds],
    mode: "observation",
  };

  switch (draft.origin) {
    case "automation_payt":
      // O valor de cada venda e o evento vêm do postback da Payt: nada de
      // valor médio, frases ou etiquetas.
      return {
        ok: true,
        value: {
          ...base,
          triggerType: "provider_automation",
          eventName,
          automationSource: "payt",
          ...(draft.productCodes.length > 0
            ? { productFilterCodes: [...draft.productCodes] }
            : {}),
          ...(context.singleUrl ? { perRuleUrl: false } : {}),
          // Moeda da venda -> da regra -> do workspace.
          ...(conversionEventCarriesValue(eventName) && draft.currency
            ? { defaultCurrency: draft.currency }
            : {}),
        },
      };
    case "automation_umbler":
    case "automation_unnichat": {
      const values = valueFields({ ...draft, eventName }, false);
      if (!values.ok) return values;
      return {
        ok: true,
        value: {
          ...base,
          triggerType: "provider_automation",
          eventName,
          ...values.value,
          ...(context.singleUrl ? { perRuleUrl: false } : {}),
        },
      };
    }
    case "whatsapp_label": {
      // Label ids only mean something inside one WhatsApp instance: send
      // them only for a rule bound to one connection.
      const picked = connectionId
        ? draft.triggerLabels.filter(
            (label) => label.id.trim() && label.name.trim(),
          )
        : [];
      const names =
        picked.length > 0
          ? picked.map((label) => label.name.trim())
          : parseLines(draft.labelNames);
      if (names.length === 0) {
        return {
          ok: false,
          message: "Informe ao menos uma etiqueta.",
        };
      }
      const values = valueFields(draft, false);
      if (!values.ok) return values;
      return {
        ok: true,
        value: {
          ...base,
          triggerType: "provider_automation",
          eventName,
          triggerPhrases: names,
          ...(picked.length > 0
            ? {
                triggerLabels: picked.map((label) => ({
                  id: label.id.trim(),
                  name: label.name.trim(),
                })),
              }
            : {}),
          ...values.value,
        },
      };
    }
    case "message_phrase": {
      const phrases = parseLines(
        [draft.primaryPhrase, draft.variationPhrases].join("\n"),
      );
      if (phrases.length === 0) {
        return { ok: false, message: "Informe a frase que dispara a regra." };
      }
      if (phrases.some((phrase) => phrase.length < 3)) {
        return {
          ok: false,
          message: "Cada frase precisa ter ao menos 3 letras.",
        };
      }
      const extracting =
        conversionEventCarriesValue(eventName) &&
        draft.valueMode === "message_extracted";
      const values = valueFields(draft, extracting);
      if (!values.ok) return values;
      return {
        ok: true,
        value: {
          ...base,
          triggerType: "message_phrase",
          eventName,
          valueMode: extracting ? "message_extracted" : "fixed",
          exampleMessage: draft.exampleMessage.trim() || null,
          triggerPhrases: phrases,
          messageAuthorScope: draft.messageAuthorScope,
          ...values.value,
        },
      };
    }
    case "structured_catalog": {
      const phrases = parseLines(
        [draft.primaryPhrase, draft.variationPhrases].join("\n"),
      );
      if (phrases.length === 0) {
        return {
          ok: false,
          message: "Informe a frase que abre o pedido (ex.: “Resumo do pedido”).",
        };
      }
      const catalog = catalogPayload(draft, context.workspaceCurrency);
      if (!catalog.ok) return catalog;
      return {
        ok: true,
        value: {
          ...base,
          triggerType: "structured_catalog",
          eventName: "Purchase",
          triggerPhrases: phrases,
          messageAuthorScope: draft.messageAuthorScope,
          catalog: catalog.value,
        },
      };
    }
  }
}
