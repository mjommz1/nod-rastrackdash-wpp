import type {
  CurrencyCode,
  ProviderConversionDecisionCatalogSnapshotDto,
  ProviderConversionDecisionDto,
  ProviderConversionDecisionOccurrenceDto,
  ProviderConversionDecisionRuleSnapshotDto,
  ProviderConversionPaidLeadResolutionDto,
  StructuredCatalogTestMessageResultDto,
} from "@wpptrack/shared";

type OccurrenceIdentity = Omit<
  ProviderConversionDecisionOccurrenceDto,
  | "source"
  | "eventName"
  | "authorType"
  | "businessDedupePolicy"
  | "contactIdentityHash"
>;

export type ProviderConversionDecisionDuplicateMatch = {
  duplicate: boolean;
  decisionId: string | null;
  conversionEventLogId: string | null;
};

type ProviderConversionDecisionInputBase = {
  parserVersion: string;
  rule: ProviderConversionDecisionRuleSnapshotDto;
  catalog: ProviderConversionDecisionCatalogSnapshotDto | null;
  leadResolution: ProviderConversionPaidLeadResolutionDto;
  contactIdentityHash: string | null;
  duplicateMatch?: ProviderConversionDecisionDuplicateMatch;
};

export type ProviderConversionMessageOccurrenceInput = OccurrenceIdentity & {
  source: "message";
  eventName: ProviderConversionDecisionRuleSnapshotDto["eventName"];
  authorType: ProviderConversionDecisionOccurrenceDto["authorType"];
  messageText: string;
  /** Workspace "Moeda das conversoes" for a price read from the message. */
  fallbackCurrency?: CurrencyCode;
};

export type ProviderConversionAutomationOccurrenceInput = OccurrenceIdentity & {
  source: "automation";
  eventName: ProviderConversionDecisionRuleSnapshotDto["eventName"];
  authorType: null;
  automation: string;
  /** Sale value read from the callback (Payt); never invented. */
  observedValueCents?: number;
  /** Currency the sale/automation payload declares, when it declares one. */
  observedCurrency?: CurrencyCode;
  /**
   * Workspace "Moeda das conversoes": used when neither the payload nor the
   * rule names a currency (rule currency null = inherit). Absent = BRL.
   */
  fallbackCurrency?: CurrencyCode;
  labels?: string[];
  matchedLabel?: string;
};

export type ProviderConversionDecisionInput =
  ProviderConversionDecisionInputBase & {
    occurrence:
      | ProviderConversionMessageOccurrenceInput
      | ProviderConversionAutomationOccurrenceInput;
  };

export type ProviderConversionRuleEvaluation =
  | {
      outcome: "not_applicable";
      reasonCode:
        | "rule_inactive"
        | "source_mismatch"
        | "author_not_allowed"
        | "event_mismatch"
        | "trigger_missing"
        | "catalog_unavailable"
        | "catalog_inactive";
    }
  | {
      outcome: "ignored_empty_template";
      reasonCode: "empty_template";
      match: StructuredCatalogTestMessageResultDto;
    }
  | {
      outcome: "review_required";
      reasonCode: string;
      match: StructuredCatalogTestMessageResultDto;
    }
  | {
      outcome: "eligible";
      reasonCode:
        | "catalog_matched"
        | "average_value_message_matched"
        | "automation_matched";
      match: StructuredCatalogTestMessageResultDto;
    };

export type ProviderConversionCanonicalDecision = ProviderConversionDecisionDto;

export function providerConversionDecisionOutcome(
  decision: ProviderConversionDecisionDto,
): "ignored" | "review" | "eligible" | "duplicate" {
  switch (decision.decisionCode) {
    case "ignored_empty_template":
    case "ignored_untracked_lead":
      return "ignored";
    case "review_required":
      return "review";
    case "eligible":
      return "eligible";
    case "duplicate":
      return "duplicate";
    default:
      return assertNever(decision);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled provider conversion decision: ${String(value)}`);
}
