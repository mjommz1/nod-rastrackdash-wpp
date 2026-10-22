import { z } from "zod";
import { conversionEventNameSchema } from "./conversion-events";
import {
  messagePhraseValueModeSchema,
  providerConversionCatalogSchema,
  providerConversionMessageAuthorScopeSchema,
  providerConversionRuleModeSchema,
  providerConversionTechnicalDeliveryStateSchema,
  providerConversionTechnicalDeliveryStates,
  providerConversionTriggerTypeSchema,
  structuredCatalogParsedItemSchema,
} from "./conversion-rules";

const identifierSchema = z.string().trim().min(1).max(500);
const optionalIdentifierSchema = identifierSchema.nullable();
const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/u)
  .transform((value) => value.toUpperCase());

export const providerConversionDecisionCodes = [
  "ignored_empty_template",
  "ignored_untracked_lead",
  "review_required",
  "eligible",
  "duplicate",
] as const;

export const providerConversionDecisionCodeSchema = z.enum(
  providerConversionDecisionCodes,
);

export {
  providerConversionTechnicalDeliveryStates,
  providerConversionTechnicalDeliveryStateSchema,
};

export const providerConversionDecisionAuthorTypeSchema = z.enum([
  "contact",
  "organization_member",
  "bot",
  "unknown",
]);

const authorizedCtwaDestinationBaseSchema = z.object({
  kind: z.literal("authorized_ctwa_destination"),
  workspaceId: identifierSchema,
  channelId: identifierSchema,
  connectionId: identifierSchema,
  organizationId: identifierSchema,
  providerChannelId: identifierSchema,
  destinationId: identifierSchema,
  businessConnectionId: identifierSchema,
  credentialId: identifierSchema,
  credentialFingerprint: identifierSchema,
});

// Persisted backend intent of a CTWA lead without ad id (ctwa_clid present):
// the unique page + pixel the workspace's Meta setup authorizes for that
// WhatsApp number. Authorization is re-resolved from the current workspace
// configuration before materialization and dispatch, never from caller flags.
// Only the page/pixel delivery exists in this edition: it uses the scopes of
// the Meta login (business_management + ads_read/ads_management).
export const authorizedCtwaDestinationSchema = authorizedCtwaDestinationBaseSchema
  .extend({
    deliveryKind: z.literal("page_pixel"),
    pixelId: identifierSchema,
    pageId: identifierSchema,
  })
  .strict();

export type AuthorizedCtwaDestinationDto = z.infer<
  typeof authorizedCtwaDestinationSchema
>;

// ctwa_clid is mandatory: a lead without it never reaches Meta. The ad id may
// be missing only when the lead carries the typed CTWA origin proof.
export const providerConversionPaidLeadSchema = z
  .object({
    id: identifierSchema,
    phoneHash: identifierSchema,
    campaignId: optionalIdentifierSchema,
    adSetId: optionalIdentifierSchema,
    adId: optionalIdentifierSchema,
    ctwaClid: identifierSchema,
    ctwaDestination: authorizedCtwaDestinationSchema.optional(),
  })
  .superRefine((lead, context) => {
    if (!lead.adId && !lead.ctwaDestination)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "No-ad lead requires typed materialized CTWA origin proof",
        path: ["ctwaDestination"],
      });
  });

export const providerConversionPaidLeadResolutionSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("resolved"),
      reasonCode: z.literal("paid_lead_resolved"),
      lead: providerConversionPaidLeadSchema,
    }),
    z.object({
      status: z.literal("missing_identity"),
      reasonCode: z.literal("missing_contact_identity"),
    }),
    z.object({
      status: z.literal("not_found"),
      reasonCode: z.enum(["paid_lead_not_found", "paid_attribution_missing"]),
      candidateLeadId: optionalIdentifierSchema,
    }),
    z.object({
      status: z.literal("ambiguous"),
      reasonCode: z.literal("paid_lead_ambiguous"),
      candidateLeadIds: z.array(identifierSchema).min(2).max(10),
    }),
  ],
);

export const providerConversionUnresolvedPaidLeadSchema = z.union([
  z.object({
    status: z.literal("missing_identity"),
    reasonCode: z.literal("missing_contact_identity"),
  }),
  z.object({
    status: z.literal("not_found"),
    reasonCode: z.enum(["paid_lead_not_found", "paid_attribution_missing"]),
    candidateLeadId: optionalIdentifierSchema,
  }),
  z.object({
    status: z.literal("ambiguous"),
    reasonCode: z.literal("paid_lead_ambiguous"),
    candidateLeadIds: z.array(identifierSchema).min(2).max(10),
  }),
]);

export const providerConversionDecisionOccurrenceSchema = z.object({
  source: z.enum(["message", "automation"]),
  provider: z.string().trim().min(1).max(80),
  workspaceId: identifierSchema,
  connectionId: identifierSchema,
  channelId: optionalIdentifierSchema,
  externalDeliveryId: optionalIdentifierSchema,
  externalEventId: optionalIdentifierSchema,
  externalMessageId: optionalIdentifierSchema,
  occurrenceKey: identifierSchema,
  // Versioned sale identity (seller + order + event), set only by providers
  // whose callbacks carry a merchant order (Payt). Never contains PII.
  purchaseKey: z
    .string()
    .regex(/^purchase:[a-f0-9]{64}$/)
    .optional(),
  businessDedupePolicy: z
    .discriminatedUnion("mode", [
      z.object({
        mode: z.literal("lifetime"),
        scopeKey: identifierSchema,
      }),
      z.object({
        mode: z.literal("rolling_window"),
        scopeKey: identifierSchema,
        windowSeconds: z.number().int().positive(),
      }),
    ])
    .nullable(),
  eventName: conversionEventNameSchema,
  occurredAt: z.string().datetime(),
  authorType: providerConversionDecisionAuthorTypeSchema.nullable(),
  contactIdentityHash: optionalIdentifierSchema,
  labels: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
  matchedLabel: z.string().trim().min(1).max(240).optional(),
});

export const providerConversionDecisionRuleSnapshotSchema = z.object({
  providerRuleId: identifierSchema,
  conversionRuleId: identifierSchema,
  version: identifierSchema,
  triggerType: providerConversionTriggerTypeSchema,
  eventName: conversionEventNameSchema,
  mode: providerConversionRuleModeSchema,
  active: z.boolean(),
  authorScope: providerConversionMessageAuthorScopeSchema.nullable(),
  triggerPhrases: z.array(z.string().trim().min(1).max(240)).max(50),
  defaultValueCents: z.number().int().positive().nullable(),
  defaultCurrency: currencySchema.nullable(),
  defaultContentName: z.string().trim().min(1).max(180).nullable(),
  // Decisions persisted before U2 carry no value pipeline: they were all fixed.
  valueMode: messagePhraseValueModeSchema.default("fixed"),
  exampleMessage: z.string().max(2_000).nullable().default(null),
});

export const providerConversionDecisionCatalogSnapshotSchema = z.object({
  version: identifierSchema,
  catalog: providerConversionCatalogSchema,
});

export const providerConversionDecisionConversionSchema = z.object({
  matchedTriggerPhrase: z.string().trim().min(1).max(240).nullable(),
  items: z.array(structuredCatalogParsedItemSchema).max(100),
  valueCents: z.number().int().positive().nullable(),
  observedPaymentValueCents: z.number().int().positive().nullable(),
  currency: currencySchema.nullable(),
  contentName: z.string().trim().min(1).max(180).nullable(),
});

const providerConversionDecisionBaseSchema = z.object({
  engineVersion: identifierSchema,
  parserVersion: identifierSchema,
  reasonCode: z.string().trim().min(1).max(160),
  occurrence: providerConversionDecisionOccurrenceSchema,
  rule: providerConversionDecisionRuleSnapshotSchema,
  catalog: providerConversionDecisionCatalogSnapshotSchema.nullable(),
  conversion: providerConversionDecisionConversionSchema,
});

export const providerConversionDecisionSchema = z.discriminatedUnion(
  "decisionCode",
  [
    providerConversionDecisionBaseSchema.extend({
      decisionCode: z.literal("ignored_empty_template"),
      leadResolution: providerConversionPaidLeadResolutionSchema,
    }),
    providerConversionDecisionBaseSchema.extend({
      decisionCode: z.literal("ignored_untracked_lead"),
      leadResolution: providerConversionUnresolvedPaidLeadSchema,
    }),
    providerConversionDecisionBaseSchema.extend({
      decisionCode: z.literal("review_required"),
      leadResolution: z.object({
        status: z.literal("resolved"),
        reasonCode: z.literal("paid_lead_resolved"),
        lead: providerConversionPaidLeadSchema,
      }),
    }),
    providerConversionDecisionBaseSchema.extend({
      decisionCode: z.literal("eligible"),
      leadResolution: z.object({
        status: z.literal("resolved"),
        reasonCode: z.literal("paid_lead_resolved"),
        lead: providerConversionPaidLeadSchema,
      }),
    }),
    providerConversionDecisionBaseSchema.extend({
      decisionCode: z.literal("duplicate"),
      leadResolution: z.object({
        status: z.literal("resolved"),
        reasonCode: z.literal("paid_lead_resolved"),
        lead: providerConversionPaidLeadSchema,
      }),
      duplicateOfDecisionId: optionalIdentifierSchema,
      duplicateOfConversionEventLogId: optionalIdentifierSchema,
    }),
  ],
);

export type ProviderConversionDecisionCodeDto = z.infer<
  typeof providerConversionDecisionCodeSchema
>;
export type ProviderConversionTechnicalDeliveryStateDto = z.infer<
  typeof providerConversionTechnicalDeliveryStateSchema
>;
export type ProviderConversionPaidLeadDto = z.infer<
  typeof providerConversionPaidLeadSchema
>;
export type ProviderConversionPaidLeadResolutionDto = z.infer<
  typeof providerConversionPaidLeadResolutionSchema
>;
export type ProviderConversionDecisionOccurrenceDto = z.infer<
  typeof providerConversionDecisionOccurrenceSchema
>;
export type ProviderConversionDecisionRuleSnapshotDto = z.infer<
  typeof providerConversionDecisionRuleSnapshotSchema
>;
export type ProviderConversionDecisionCatalogSnapshotDto = z.infer<
  typeof providerConversionDecisionCatalogSnapshotSchema
>;
export type ProviderConversionDecisionConversionDto = z.infer<
  typeof providerConversionDecisionConversionSchema
>;
export type ProviderConversionDecisionDto = z.infer<
  typeof providerConversionDecisionSchema
>;
