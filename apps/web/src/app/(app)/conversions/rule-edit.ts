import type {
  ProviderConversionRuleDto,
  ProviderConversionRuleOriginDto,
} from "@wpptrack/shared";
import {
  conversionEventCarriesValue,
  conversionEventRequiresValue,
  normalizeCurrencyCode,
} from "@wpptrack/shared";
import {
  moneyToCents,
  parseLines,
  scopeIssue,
  type DraftContext,
  type RuleDraft,
} from "./rule-draft";

/**
 * Editing an existing rule on the Conversions screen (PATCH
 * /conversion-rules/providers/:id). Pure, like rule-draft.ts: the draft
 * starts from the rule and only the fields the user changed are sent, so a
 * rename never touches the numbers, the phrases or the value.
 */

export type RuleEditDraft = RuleDraft & {
  /** Catalog rules: written variations per variant id, one string per attribute. */
  aliases: Record<string, string[]>;
  /** WhatsApp tag rules: one entry per label name. */
  labels: string[];
};

type Result<T> = { ok: true; value: T } | { ok: false; message: string };

/** What the edit form offers for each origin (mirrors the API checks). */
export type RuleEditCapabilities = {
  phrases: boolean;
  authorScope: boolean;
  messageValue: boolean;
  /** Labels can be edited (the rule matches them by name). */
  labels: boolean;
  /**
   * Labels shown read-only: a rule bound to one connection matches the
   * WhatsApp label by its id, which a typed name cannot provide.
   */
  labelsReadOnly: boolean;
  value: boolean;
  /**
   * Moeda da regra ("Padrão do workspace" ou BRL/USD/EUR): toda regra com
   * valor, menos catálogos, cujos preços carregam a moeda do catálogo.
   */
  currency: boolean;
  catalogAliases: boolean;
  /** Fase 5.3: filtro de produto (só regras de venda da Payt). */
  productFilter: boolean;
};

export function ruleEditCapabilities(
  rule: ProviderConversionRuleDto,
  origin: ProviderConversionRuleOriginDto,
): RuleEditCapabilities {
  const carriesValue = conversionEventCarriesValue(rule.conversionRule.eventName);

  return {
    phrases: origin === "message_phrase" || origin === "structured_catalog",
    authorScope: origin === "message_phrase" || origin === "structured_catalog",
    // Message rules edit value, value mode and example together.
    messageValue: origin === "message_phrase",
    labels: origin === "whatsapp_label" && rule.connectionId === null,
    labelsReadOnly: origin === "whatsapp_label" && rule.connectionId !== null,
    // Catálogos precificam cada opção; as demais origens têm valor médio.
    value:
      carriesValue &&
      (origin === "whatsapp_label" ||
        origin === "automation_umbler" ||
        origin === "automation_unnichat"),
    currency: carriesValue && origin !== "structured_catalog",
    catalogAliases: origin === "structured_catalog" && Boolean(rule.catalog),
    productFilter: origin === "automation_payt",
  };
}

function centsToInput(value: number | null | undefined): string {
  return value ? (value / 100).toFixed(2).replace(".", ",") : "";
}

function catalogAliases(
  catalog: ProviderConversionRuleDto["catalog"],
): Record<string, string[]> {
  if (!catalog) return {};

  return Object.fromEntries(
    catalog.variants.map((variant) => [
      variant.id,
      catalog.attributes.map((_, index) => (variant.aliases[index] ?? []).join(", ")),
    ]),
  );
}

export function ruleEditDraft(
  rule: ProviderConversionRuleDto,
  origin: ProviderConversionRuleOriginDto,
): RuleEditDraft {
  const [primaryPhrase = "", ...variations] = rule.triggerPhrases;
  const labels = origin === "whatsapp_label";

  return {
    origin,
    eventName: rule.conversionRule.eventName,
    scope: rule.scope ?? "specific_numbers",
    channelIds: [...rule.channelIds],
    connectionId: rule.connectionId,
    name: rule.conversionRule.name,
    primaryPhrase: labels ? "" : primaryPhrase,
    variationPhrases: labels ? "" : variations.join("\n"),
    exampleMessage: rule.exampleMessage ?? "",
    valueMode: rule.valueMode,
    messageAuthorScope: rule.messageAuthorScope ?? "team",
    averageValue: centsToInput(rule.conversionRule.defaultValueCents),
    contentName: rule.conversionRule.defaultContentName ?? "",
    labelNames: "",
    triggerLabels: [],
    // A moeda gravada continua; null (ou código fora de BRL/USD/EUR) aparece
    // como "Padrão do workspace" e só é enviada quando o usuário muda.
    currency: normalizeCurrencyCode(rule.conversionRule.defaultCurrency) ?? "",
    labels: labels ? [...rule.triggerPhrases] : [],
    productCodes: [...(rule.productFilterCodes ?? [])],
    catalog: {
      name: rule.catalog?.name ?? "",
      productName: rule.catalog?.productName ?? "",
      attributes: rule.catalog?.attributes.map((attribute) => attribute.label) ?? [],
      variants: [],
    },
    aliases: catalogAliases(rule.catalog),
  };
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function splitAliases(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean),
    ),
  ];
}

function phrasesFrom(draft: RuleEditDraft): Result<string[]> {
  const phrases = parseLines([draft.primaryPhrase, draft.variationPhrases].join("\n"));
  if (phrases.length === 0) {
    return { ok: false, message: "Informe ao menos uma frase." };
  }
  if (phrases.length > 20) {
    return { ok: false, message: "Use no máximo 20 frases." };
  }
  if (phrases.some((phrase) => phrase.length < 3)) {
    return { ok: false, message: "Cada frase precisa ter ao menos 3 letras." };
  }
  return { ok: true, value: phrases };
}

function valueChanges(
  rule: ProviderConversionRuleDto,
  draft: RuleEditDraft,
  extracting: boolean,
): Result<Record<string, unknown>> {
  const eventName = rule.conversionRule.eventName;
  const current = rule.conversionRule.defaultValueCents ?? null;
  const cents = moneyToCents(draft.averageValue);
  const required = !extracting && conversionEventRequiresValue(eventName);

  if (!cents && (required || draft.averageValue.trim())) {
    return { ok: false, message: "Informe um valor médio válido." };
  }
  // The API only lets the value go away when it comes from the message.
  if (!cents && current && !extracting) {
    return {
      ok: false,
      message: "Esta regra precisa de um valor médio. Informe um valor maior que zero.",
    };
  }

  const changes: Record<string, unknown> = {};
  if ((cents ?? null) !== current) {
    changes.defaultValueCents = cents ?? null;
  }
  const contentName = draft.contentName.trim() || null;
  if (contentName !== (rule.conversionRule.defaultContentName ?? null)) {
    changes.defaultContentName = contentName;
  }
  return { ok: true, value: changes };
}

/**
 * PATCH body with only what changed, or a message saying what to fix.
 * An empty object means "nothing to save".
 */
export function buildRuleUpdatePayload(
  rule: ProviderConversionRuleDto,
  draft: RuleEditDraft,
  context: DraftContext,
): Result<Record<string, unknown>> {
  const capabilities = ruleEditCapabilities(rule, draft.origin);
  const payload: Record<string, unknown> = {};

  const name = draft.name.trim();
  if (name.length < 2) {
    return { ok: false, message: "Dê um nome para a regra." };
  }
  if (name !== rule.conversionRule.name) payload.name = name;

  // Reach: only sent when it changed, so a rename never re-validates numbers.
  const currentScope = rule.scope ?? "specific_numbers";
  const scopeChanged = draft.scope !== currentScope;
  const numbersChanged =
    draft.scope === "specific_numbers" && !sameSet(draft.channelIds, rule.channelIds);
  if (scopeChanged || numbersChanged) {
    const issue = scopeIssue(draft, context);
    if (issue) return { ok: false, message: issue };
    if (draft.scope === "all_numbers") {
      payload.scope = "all_numbers";
    } else {
      if (scopeChanged) payload.scope = "specific_numbers";
      payload.channelIds = [...draft.channelIds];
    }
  }

  if (capabilities.phrases) {
    const phrases = phrasesFrom(draft);
    if (!phrases.ok) return phrases;
    if (!sameList(phrases.value, rule.triggerPhrases)) {
      payload.triggerPhrases = phrases.value;
    }
  }
  if (
    capabilities.authorScope &&
    draft.messageAuthorScope !== (rule.messageAuthorScope ?? "team")
  ) {
    payload.messageAuthorScope = draft.messageAuthorScope;
  }

  if (capabilities.messageValue) {
    const exampleMessage = draft.exampleMessage.trim() || null;
    if (exampleMessage !== (rule.exampleMessage ?? null)) {
      payload.exampleMessage = exampleMessage;
    }
    if (conversionEventCarriesValue(rule.conversionRule.eventName)) {
      const extracting = draft.valueMode === "message_extracted";
      if (draft.valueMode !== rule.valueMode) payload.valueMode = draft.valueMode;
      const values = valueChanges(rule, draft, extracting);
      if (!values.ok) return values;
      Object.assign(payload, values.value);
    }
  }

  if (capabilities.value) {
    const values = valueChanges(rule, draft, false);
    if (!values.ok) return values;
    Object.assign(payload, values.value);
  }

  if (capabilities.currency) {
    const current =
      normalizeCurrencyCode(rule.conversionRule.defaultCurrency) ?? "";
    if (draft.currency !== current) {
      // null = voltar a herdar a "Moeda das conversões" do workspace.
      payload.defaultCurrency = draft.currency || null;
    }
  }

  if (capabilities.productFilter) {
    const codes = [
      ...new Set(draft.productCodes.map((code) => code.toLocaleUpperCase("en-US"))),
    ];
    if (codes.length > 50) {
      return { ok: false, message: "Use no máximo 50 produtos no filtro." };
    }
    if (!sameSet(codes, rule.productFilterCodes ?? [])) {
      // [] = voltar a aceitar todos os produtos.
      payload.productFilterCodes = codes;
    }
  }

  if (capabilities.labels) {
    const names = [
      ...new Set(draft.labels.map((label) => label.trim()).filter(Boolean)),
    ];
    if (names.length === 0) {
      return { ok: false, message: "Informe ao menos uma etiqueta." };
    }
    if (names.length > 50) {
      return { ok: false, message: "Use no máximo 50 etiquetas." };
    }
    if (names.some((label) => label.length < 3)) {
      return { ok: false, message: "Cada etiqueta precisa ter ao menos 3 letras." };
    }
    if (!sameList(names, rule.triggerPhrases)) {
      // Rules without a connection match labels by name (never by id).
      payload.triggerLabels = names.map((label) => ({ id: label, name: label }));
    }
  }

  if (capabilities.catalogAliases && rule.catalog) {
    const catalog = rule.catalog;
    const nextAliases = catalog.variants.map((variant) =>
      catalog.attributes.map((_, index) =>
        splitAliases(draft.aliases[variant.id]?.[index] ?? ""),
      ),
    );
    const changed = catalog.variants.some((variant, row) =>
      catalog.attributes.some(
        (_, index) =>
          !sameList(nextAliases[row]![index]!, variant.aliases[index] ?? []),
      ),
    );
    if (changed) {
      if (nextAliases.some((row) => row.some((aliases) => aliases.length > 20))) {
        return { ok: false, message: "Use no máximo 20 jeitos de escrever cada opção." };
      }
      // Same options and prices: the API then only updates the aliases and
      // keeps the history of the rule.
      payload.catalog = {
        name: catalog.name,
        productName: catalog.productName,
        currency: catalog.currency,
        attributes: catalog.attributes.map((attribute) => ({
          key: attribute.key,
          label: attribute.label,
        })),
        variants: catalog.variants.map((variant, row) => ({
          attributeValues: variant.attributeValues,
          aliases: nextAliases[row],
          valueCents: variant.valueCents,
          contentName: variant.contentName,
        })),
      };
    }
  }

  return { ok: true, value: payload };
}
