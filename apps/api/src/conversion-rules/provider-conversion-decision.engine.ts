import type {
  ProviderConversionDecisionConversionDto,
  ProviderConversionDecisionDto,
  ProviderConversionDecisionOccurrenceDto,
  StructuredCatalogTestMessageResultDto,
} from "@wpptrack/shared";
import { Injectable } from "@nestjs/common";
import {
  conversionEventDedupeMode,
  conversionEventValuePolicy,
  normalizeCurrencyCode,
} from "@wpptrack/shared";
import {
  extractSingleMoneyValueCents,
  matchProviderMessageTrigger,
  matchStructuredCatalogMessage,
  providerMessageAuthorAllowed,
} from "./structured-catalog-message.parser";
import type {
  ProviderConversionDecisionInput,
  ProviderConversionRuleEvaluation,
} from "./provider-conversion-decision.types";

export const PROVIDER_CONVERSION_DECISION_ENGINE_VERSION = "decision-v1";
const PURCHASE_DEDUPE_WINDOW_SECONDS = 24 * 60 * 60;

@Injectable()
export class ProviderConversionDecisionEngine {
  evaluate(
    input: ProviderConversionDecisionInput,
  ): ProviderConversionDecisionDto | null {
    const evaluation = this.evaluateRule(input);
    if (evaluation.outcome === "not_applicable") return null;

    const conversion = this.conversion(evaluation.match);
    if (evaluation.outcome === "ignored_empty_template") {
      return {
        ...this.base(input, conversion, null),
        decisionCode: "ignored_empty_template",
        reasonCode: evaluation.reasonCode,
        leadResolution: input.leadResolution,
      };
    }

    if (input.leadResolution.status !== "resolved") {
      return {
        ...this.base(input, conversion, null),
        decisionCode: "ignored_untracked_lead",
        reasonCode: input.leadResolution.reasonCode,
        leadResolution: input.leadResolution,
      };
    }

    const businessDedupePolicy = this.businessDedupePolicy(input);
    if (evaluation.outcome === "review_required") {
      return {
        ...this.base(input, conversion, businessDedupePolicy),
        decisionCode: "review_required",
        reasonCode: evaluation.reasonCode,
        leadResolution: input.leadResolution,
      };
    }

    if (input.duplicateMatch?.duplicate) {
      return {
        ...this.base(input, conversion, businessDedupePolicy),
        decisionCode: "duplicate",
        reasonCode: "business_duplicate",
        leadResolution: input.leadResolution,
        duplicateOfDecisionId: input.duplicateMatch.decisionId,
        duplicateOfConversionEventLogId:
          input.duplicateMatch.conversionEventLogId,
      };
    }

    return {
      ...this.base(input, conversion, businessDedupePolicy),
      decisionCode: "eligible",
      reasonCode: evaluation.reasonCode,
      leadResolution: input.leadResolution,
    };
  }

  private evaluateRule(
    input: ProviderConversionDecisionInput,
  ): ProviderConversionRuleEvaluation {
    if (!input.rule.active) {
      return { outcome: "not_applicable", reasonCode: "rule_inactive" };
    }
    if (input.occurrence.eventName !== input.rule.eventName) {
      return { outcome: "not_applicable", reasonCode: "event_mismatch" };
    }

    switch (input.rule.triggerType) {
      case "structured_catalog":
        return this.evaluateStructuredCatalog(input);
      case "message_phrase":
        return this.evaluateAverageValueMessage(input);
      case "provider_automation":
        return this.evaluateAutomation(input);
      default:
        return this.assertNever(input.rule.triggerType);
    }
  }

  private evaluateStructuredCatalog(
    input: ProviderConversionDecisionInput,
  ): ProviderConversionRuleEvaluation {
    if (input.occurrence.source !== "message") {
      return { outcome: "not_applicable", reasonCode: "source_mismatch" };
    }
    if (!input.catalog) {
      return { outcome: "not_applicable", reasonCode: "catalog_unavailable" };
    }
    if (
      !input.occurrence.authorType ||
      !providerMessageAuthorAllowed(
        input.rule.authorScope ?? "team",
        input.occurrence.authorType,
      )
    ) {
      return { outcome: "not_applicable", reasonCode: "author_not_allowed" };
    }
    if (!input.catalog.catalog.active) {
      return { outcome: "not_applicable", reasonCode: "catalog_inactive" };
    }

    const match = matchStructuredCatalogMessage(
      input.catalog.catalog,
      input.occurrence.messageText,
      { triggerPhrases: input.rule.triggerPhrases },
    );

    if (
      match.classification === "ignored" &&
      match.reasonCode === "trigger_missing"
    ) {
      return { outcome: "not_applicable", reasonCode: "trigger_missing" };
    }
    if (
      match.classification === "ignored" &&
      match.reasonCode === "empty_template"
    ) {
      return {
        outcome: "ignored_empty_template",
        reasonCode: "empty_template",
        match,
      };
    }
    if (!match.matched) {
      return {
        outcome: "review_required",
        reasonCode: match.reasonCode,
        match,
      };
    }

    return {
      outcome: "eligible",
      reasonCode: "catalog_matched",
      match,
    };
  }

  private evaluateAverageValueMessage(
    input: ProviderConversionDecisionInput,
  ): ProviderConversionRuleEvaluation {
    if (input.occurrence.source !== "message") {
      return { outcome: "not_applicable", reasonCode: "source_mismatch" };
    }
    if (
      !input.occurrence.authorType ||
      !providerMessageAuthorAllowed(
        input.rule.authorScope ?? "team",
        input.occurrence.authorType,
      )
    ) {
      return { outcome: "not_applicable", reasonCode: "author_not_allowed" };
    }

    const matchedTriggerPhrase = matchProviderMessageTrigger(
      input.occurrence.messageText,
      input.rule.triggerPhrases,
    );
    if (!matchedTriggerPhrase) {
      return { outcome: "not_applicable", reasonCode: "trigger_missing" };
    }

    // Only events whose catalog policy is "required" (Purchase,
    // InitiateCheckout) are held back for review without a value. Events that
    // never carry value (QualifiedLead, OrderShipped, …) go straight through,
    // and "optional" events travel without value when none was configured.
    const valuePolicy = conversionEventValuePolicy(input.rule.eventName);
    if (valuePolicy === "none") {
      return {
        outcome: "eligible",
        reasonCode: "average_value_message_matched",
        match: this.valuelessMatch(matchedTriggerPhrase),
      };
    }

    const match = this.averageValueMatch(input, matchedTriggerPhrase);
    if (!match.matched) {
      if (valuePolicy === "required") {
        return {
          outcome: "review_required",
          reasonCode: "average_value_missing",
          match,
        };
      }

      return {
        outcome: "eligible",
        reasonCode: "average_value_message_matched",
        match: this.valuelessMatch(matchedTriggerPhrase),
      };
    }

    return {
      outcome: "eligible",
      reasonCode: "average_value_message_matched",
      match,
    };
  }

  private evaluateAutomation(
    input: ProviderConversionDecisionInput,
  ): ProviderConversionRuleEvaluation {
    if (input.occurrence.source !== "automation") {
      return { outcome: "not_applicable", reasonCode: "source_mismatch" };
    }

    // Umbler's signed callback has already selected its automation rule and
    // therefore arrives without labels. UAZAPI label webhooks must intersect
    // the labels configured on the rule before entering the value policy.
    if (input.occurrence.labels) {
      const labels = new Set(
        input.occurrence.labels.map((label) => label.trim().toLocaleLowerCase("pt-BR")),
      );
      const matched = input.rule.triggerPhrases.some((phrase) =>
        labels.has(phrase.trim().toLocaleLowerCase("pt-BR")),
      );
      if (!matched) {
        return { outcome: "not_applicable", reasonCode: "trigger_missing" };
      }
    }

    const valuePolicy = conversionEventValuePolicy(input.rule.eventName);
    if (valuePolicy === "none") {
      return {
        outcome: "eligible",
        reasonCode: "automation_matched",
        match: this.valuelessMatch(null),
      };
    }

    const match = this.averageValueMatch(input, null);
    if (!match.matched) {
      if (valuePolicy === "required") {
        return {
          outcome: "review_required",
          reasonCode: "average_value_missing",
          match,
        };
      }

      return {
        outcome: "eligible",
        reasonCode: "automation_matched",
        match: this.valuelessMatch(null),
      };
    }

    return {
      outcome: "eligible",
      reasonCode: "automation_matched",
      match,
    };
  }

  private averageValueMatch(
    input: ProviderConversionDecisionInput,
    matchedTriggerPhrase: string | null,
  ): StructuredCatalogTestMessageResultDto {
    // valueMode "message_extracted": the message carries the price, the
    // configured average value is only a fallback. Never invent a value.
    // An automation callback (Payt) carries the sale value itself; the
    // configured average value stays the fallback.
    const extractedValueCents =
      input.occurrence.source === "automation"
        ? (input.occurrence.observedValueCents ?? null)
        : this.extractedValueCents(input);
    const valueCents = extractedValueCents ?? input.rule.defaultValueCents;
    // Moeda: a da venda (payload) -> a da regra -> a do workspace -> BRL.
    // A rule without currency (null = inherit) uses the workspace currency.
    const currency =
      (input.occurrence.source === "automation"
        ? (input.occurrence.observedCurrency ?? null)
        : null) ??
      // Código fora de BRL/USD/EUR na regra conta como regra sem moeda.
      normalizeCurrencyCode(input.rule.defaultCurrency) ??
      (valueCents ? (input.occurrence.fallbackCurrency ?? "BRL") : null);
    const matched = Boolean(valueCents && currency);

    return {
      matched,
      reasonCode: matched ? "matched" : "missing_price",
      classification: matched ? "recognized" : "review_required",
      matchedTriggerPhrase,
      parsedAttributes: [],
      items: [],
      parsedValueCents: matched ? valueCents : null,
      calculatedValueCents: matched ? valueCents : null,
      // Non-null only when the value was read from the message itself, which is
      // what downstream production uses to report valueSource "actual".
      observedPaymentValueCents: matched ? extractedValueCents : null,
      catalogVariantId: null,
      contentName: input.rule.defaultContentName,
      currency: matched
        ? currency
        : normalizeCurrencyCode(input.rule.defaultCurrency),
    };
  }

  private extractedValueCents(
    input: ProviderConversionDecisionInput,
  ): number | null {
    if (input.rule.valueMode !== "message_extracted") return null;
    if (input.occurrence.source !== "message") return null;

    return extractSingleMoneyValueCents(input.occurrence.messageText);
  }

  /** Recognized match for events that travel to Meta without a value. */
  private valuelessMatch(
    matchedTriggerPhrase: string | null,
  ): StructuredCatalogTestMessageResultDto {
    return {
      matched: true,
      reasonCode: "matched",
      classification: "recognized",
      matchedTriggerPhrase,
      parsedAttributes: [],
      items: [],
      parsedValueCents: null,
      calculatedValueCents: null,
      observedPaymentValueCents: null,
      catalogVariantId: null,
      contentName: null,
      currency: null,
    };
  }

  private conversion(
    match: StructuredCatalogTestMessageResultDto,
  ): ProviderConversionDecisionConversionDto {
    return {
      matchedTriggerPhrase: match.matchedTriggerPhrase,
      items: match.items,
      valueCents: match.calculatedValueCents,
      observedPaymentValueCents: match.observedPaymentValueCents,
      currency: match.currency,
      contentName: match.contentName,
    };
  }

  private base(
    input: ProviderConversionDecisionInput,
    conversion: ProviderConversionDecisionConversionDto,
    businessDedupePolicy:
      | ProviderConversionDecisionOccurrenceDto["businessDedupePolicy"],
  ) {
    return {
      engineVersion: PROVIDER_CONVERSION_DECISION_ENGINE_VERSION,
      parserVersion: input.parserVersion,
      occurrence: this.occurrence(input, businessDedupePolicy),
      rule: input.rule,
      catalog: input.catalog,
      conversion,
    };
  }

  private occurrence(
    input: ProviderConversionDecisionInput,
    businessDedupePolicy:
      | ProviderConversionDecisionOccurrenceDto["businessDedupePolicy"],
  ): ProviderConversionDecisionOccurrenceDto {
    const occurrence = input.occurrence;

    return {
      source: occurrence.source,
      provider: occurrence.provider,
      workspaceId: occurrence.workspaceId,
      connectionId: occurrence.connectionId,
      channelId: occurrence.channelId,
      externalDeliveryId: occurrence.externalDeliveryId,
      externalEventId: occurrence.externalEventId,
      externalMessageId: occurrence.externalMessageId,
      occurrenceKey: occurrence.occurrenceKey,
      ...(occurrence.purchaseKey
        ? { purchaseKey: occurrence.purchaseKey }
        : {}),
      businessDedupePolicy,
      eventName: occurrence.eventName,
      occurredAt: occurrence.occurredAt,
      authorType: occurrence.authorType,
      contactIdentityHash: input.contactIdentityHash,
    };
  }

  private businessDedupePolicy(
    input: ProviderConversionDecisionInput,
  ): NonNullable<
    ProviderConversionDecisionOccurrenceDto["businessDedupePolicy"]
  > {
    if (input.leadResolution.status !== "resolved") {
      throw new Error("A business dedupe key requires a resolved paid lead");
    }

    // A sale with a merchant order identity (Payt) is deduplicated forever by
    // that identity (seller + order + event), never by the lead window.
    if (input.occurrence.provider === "payt" && input.occurrence.purchaseKey) {
      return { mode: "lifetime", scopeKey: input.occurrence.purchaseKey };
    }
    const scopeKey = [
      input.rule.eventName,
      input.occurrence.workspaceId,
      input.leadResolution.lead.id,
    ].join(":");

    // "lifetime" is reserved by the catalog for events that only make sense
    // once per lead (LeadSubmitted, QualifiedLead); everything else keeps the
    // 24h rolling window used by Purchase and InitiateCheckout.
    return conversionEventDedupeMode(input.rule.eventName) === "lifetime"
      ? {
          mode: "lifetime",
          scopeKey,
        }
      : {
          mode: "rolling_window",
          scopeKey,
          windowSeconds: PURCHASE_DEDUPE_WINDOW_SECONDS,
        };
  }

  private assertNever(value: never): never {
    throw new Error(`Unhandled provider conversion input: ${String(value)}`);
  }
}
