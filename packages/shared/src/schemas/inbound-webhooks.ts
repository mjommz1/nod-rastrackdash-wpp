import { z } from "zod";
import { conversionEventNameSchema } from "./conversion-events";
import { providerConversionDecisionCodeSchema } from "./provider-conversion-decisions";

export const inboundWebhookProviders = [
  "umbler",
  "gupshup",
  "uazapi",
  "meta_cloud",
  "data_crazy",
  // Fase 4a: plataforma de venda. Nao e um numero de WhatsApp: so existe
  // como release de parser das regras de venda (sem conexao propria).
  "payt",
  // Fase 4b: atendimento por WhatsApp. A conexao nasce presa ao numero do
  // cliente (connectedPhone): o webhook de entrada nao traz id de canal.
  "unnichat",
] as const;
export const inboundWebhookParserReleaseStatuses = [
  "observation_only",
  "certified",
  "retired",
] as const;
export const inboundWebhookConnectionStatuses = [
  "observation",
  "production",
  "paused",
] as const;
export const inboundWebhookMutableConnectionStatuses = [
  "observation",
  "production",
  "paused",
] as const;
export const inboundWebhookChannelStatuses = [
  "discovered",
  "active",
  "paused",
] as const;
export const inboundWebhookMutableChannelStatuses = [
  "active",
  "paused",
] as const;
export const inboundWebhookDeliveryStatuses = [
  "pending",
  "queued",
  "processing",
  "processed",
  "failed",
] as const;
export const inboundWebhookDeliveryPurposes = [
  "message_observation",
  "conversion_automation",
] as const;
export const inboundWebhookEventClassifications = [
  "eligible_route_resolved",
  "eligible_route_unresolved",
  "ignored_no_ctwa",
  "ignored_outbound",
  "ignored_private",
  "ignored_empty_template",
  "ignored_untracked_lead",
  "unsupported_event",
  "invalid_payload",
] as const;
export const inboundWebhookReplayStatuses = [
  "queued",
  "processing",
  "completed",
  "completed_with_failures",
  "failed",
] as const;
export const inboundWebhookReplayItemStatuses = [
  "queued",
  "processing",
  "materialized",
  "duplicate",
  "skipped",
  "failed",
] as const;
export const inboundWebhookReplaySelections = [
  "canary_1",
  "canary_5",
  "canary_10",
  "remaining",
] as const;
export const inboundWebhookParserRecoverySelections = [
  "canary_10",
  "batch_100",
  "batch_500",
  "remaining",
] as const;
export const inboundWebhookChannelReadinessStates = [
  "waiting",
  "blocked",
  "partial",
  "ready",
  "complete",
] as const;
export const inboundWebhookChannelReadinessBlockers = [
  "connection_paused",
  "channel_paused",
  "route_not_configured",
  "route_not_valid",
  "ctwa_not_observed",
  "ctwa_unresolved",
  "ctwa_ad_unavailable",
  "payload_unavailable",
  "payload_expiring_soon",
] as const;

export const inboundWebhookProviderSchema = z.enum(inboundWebhookProviders);
export const inboundWebhookParserReleaseStatusSchema = z.enum(
  inboundWebhookParserReleaseStatuses,
);
export const inboundWebhookConnectionStatusSchema = z.enum(
  inboundWebhookConnectionStatuses,
);
export const inboundWebhookMutableConnectionStatusSchema = z.enum(
  inboundWebhookMutableConnectionStatuses,
);
export const inboundWebhookChannelStatusSchema = z.enum(
  inboundWebhookChannelStatuses,
);
export const inboundWebhookMutableChannelStatusSchema = z.enum(
  inboundWebhookMutableChannelStatuses,
);
export const inboundWebhookDeliveryStatusSchema = z.enum(
  inboundWebhookDeliveryStatuses,
);
export const inboundWebhookDeliveryPurposeSchema = z.enum(
  inboundWebhookDeliveryPurposes,
);
export const inboundWebhookEventClassificationSchema = z.enum(
  inboundWebhookEventClassifications,
);
export const inboundWebhookReplayStatusSchema = z.enum(
  inboundWebhookReplayStatuses,
);
export const inboundWebhookReplayItemStatusSchema = z.enum(
  inboundWebhookReplayItemStatuses,
);
export const inboundWebhookReplaySelectionSchema = z.enum(
  inboundWebhookReplaySelections,
);
export const inboundWebhookParserRecoverySelectionSchema = z.enum(
  inboundWebhookParserRecoverySelections,
);
export const inboundWebhookChannelReadinessStateSchema = z.enum(
  inboundWebhookChannelReadinessStates,
);
export const inboundWebhookChannelReadinessBlockerSchema = z.enum(
  inboundWebhookChannelReadinessBlockers,
);

const idSchema = z.string().trim().min(1).max(255);
const parserVersionSchema = z.string().trim().min(1).max(80);
const dateTimeSchema = z.string().datetime();
const normalizedCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const oneTimeSecretSchema = z.string().min(43).max(512);

export const inboundWebhookDisplayNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .refine((value) => !/[\u0000-\u001f\u007f<>]/u.test(value), {
    message: "Nome de conexao invalido",
  });

// Numero de WhatsApp do cliente (nunca o telefone do lead de um webhook).
const inboundWebhookConnectedPhoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  // Same 10-15 digit range the API uses to normalize the phone identity.
  .refine(
    (value) => {
      const digits = value.replace(/\D/gu, "").length;
      return digits >= 10 && digits <= 15;
    },
    {
      message: "Informe o número com DDD (10 a 15 dígitos)",
    },
  );

export const inboundWebhookConnectionCreateInputSchema = z
  .object({
    provider: inboundWebhookProviderSchema,
    displayName: inboundWebhookDisplayNameSchema,
    // Fase 4b: obrigatorio so para Unnichat, cujo webhook de entrada e por
    // conexao/numero e nao traz id de canal.
    connectedPhone: inboundWebhookConnectedPhoneSchema.optional(),
  })
  .superRefine((input, context) => {
    if (input.provider === "unnichat" && !input.connectedPhone) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connectedPhone"],
        message: "Informe o número de WhatsApp conectado ao Unnichat",
      });
    }
    if (input.provider !== "unnichat" && input.connectedPhone !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connectedPhone"],
        message: "Este provedor cadastra o número pelo próprio webhook",
      });
    }
  });

export const inboundWebhookConnectionStatusUpdateInputSchema = z.object({
  status: inboundWebhookMutableConnectionStatusSchema,
});

export const inboundWebhookChannelStatusUpdateInputSchema = z.object({
  status: inboundWebhookMutableChannelStatusSchema,
});

// Lets a student register the WhatsApp number/channel the moment a
// Umbler/Gupshup connection exists, before any inbound webhook arrives, so
// conversion rules can be created against it immediately. The API assigns a
// provisional identity; a later real webhook merges into the same row.
export const inboundWebhookChannelCreateInputSchema = z.object({
  connectedPhone: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .refine((value) => /\d{8,}/u.test(value.replace(/\D/gu, "")), {
      message: "Informe um numero de telefone valido",
    }),
  channelName: inboundWebhookDisplayNameSchema.nullable().optional(),
});

export const inboundWebhookChannelRouteInputSchema = z.object({
  metaBusinessConnectionId: idSchema,
  metaReportingAccountId: idSchema.nullable().optional(),
  metaConversionDestinationId: idSchema.nullable().optional(),
});

/** Fase 4b (so Unnichat): inherit_workspace = segue a configuracao Meta do
 * workspace (par unico pagina + pixel); channel_override = so as rotas
 * salvas neste numero. */
export const inboundWebhookChannelRoutingModes = [
  "inherit_workspace",
  "channel_override",
] as const;
export const inboundWebhookChannelRoutingModeSchema = z.enum(
  inboundWebhookChannelRoutingModes,
);

export const inboundWebhookChannelRoutesUpdateInputSchema = z.object({
  routes: z.array(inboundWebhookChannelRouteInputSchema).max(100),
  // Ausente = mantem o modo atual (Unnichat) ou rotas manuais (demais).
  routingMode: inboundWebhookChannelRoutingModeSchema.optional(),
});

export const inboundWebhookParserReleaseSchema = z.object({
  id: idSchema,
  provider: inboundWebhookProviderSchema,
  version: parserVersionSchema,
  status: inboundWebhookParserReleaseStatusSchema,
  certifiedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});

export const inboundWebhookConnectionSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  provider: inboundWebhookProviderSchema,
  displayName: inboundWebhookDisplayNameSchema,
  parserVersion: parserVersionSchema,
  parserReleaseStatus: inboundWebhookParserReleaseStatusSchema.optional(),
  status: inboundWebhookConnectionStatusSchema,
  productionActivatedAt: dateTimeSchema.nullable(),
  lastDeliveryAt: dateTimeSchema.nullable(),
  lastSuccessfulParseAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});

export const inboundWebhookConnectionListSchema = z.array(
  inboundWebhookConnectionSchema,
);

export const inboundWebhookConnectionCreateResultSchema = z.object({
  connection: inboundWebhookConnectionSchema,
  secret: oneTimeSecretSchema,
  webhookUrl: z.string().url(),
});

export const inboundWebhookConnectionRotateSecretResultSchema = z.object({
  connectionId: idSchema,
  provider: inboundWebhookProviderSchema,
  secret: oneTimeSecretSchema,
  webhookUrl: z.string().url(),
  rotatedAt: dateTimeSchema,
});

export const inboundWebhookCapabilityProviderSchema = z.object({
  provider: inboundWebhookProviderSchema,
  parserVersion: parserVersionSchema,
  parserReleaseStatus: inboundWebhookParserReleaseStatusSchema.nullable(),
  creationEnabled: z.boolean(),
});

export const inboundWebhookCapabilitiesSchema = z.object({
  enabled: z.boolean(),
  productionEnabled: z.boolean(),
  providers: z.array(inboundWebhookCapabilityProviderSchema),
});

export const inboundWebhookObservationCountersSchema = z.object({
  eligibleRouted: z.number().int().nonnegative(),
  eligibleUnresolved: z.number().int().nonnegative(),
  ignoredNoCtwa: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
});

export const inboundWebhookConnectionOverviewSchema = z.object({
  connection: inboundWebhookConnectionSchema,
  counters: inboundWebhookObservationCountersSchema,
  // Fase 4b: release do parser de automacao (venda) do Unnichat.
  automationParserRelease: z
    .object({
      id: idSchema,
      version: z.string(),
      status: inboundWebhookParserReleaseStatusSchema,
    })
    .nullable()
    .optional(),
});

const backofficeInboundWebhookReceivedAtSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u);

const backofficeInboundWebhookDeliveryFilterShape = {
  workspaceId: idSchema.optional(),
  connectionId: idSchema.optional(),
  channelId: idSchema.optional(),
  provider: inboundWebhookProviderSchema.optional(),
  purpose: inboundWebhookDeliveryPurposeSchema.optional(),
  status: inboundWebhookDeliveryStatusSchema.optional(),
  classification: inboundWebhookEventClassificationSchema.optional(),
  receivedFrom: backofficeInboundWebhookReceivedAtSchema.optional(),
  receivedUntil: backofficeInboundWebhookReceivedAtSchema.optional(),
};

function validateBackofficeInboundWebhookPeriod(
  input: { receivedFrom?: string; receivedUntil?: string },
  context: z.RefinementCtx,
): void {
  if (
    input.receivedFrom &&
    input.receivedUntil &&
    input.receivedFrom > input.receivedUntil
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["receivedUntil"],
      message: "O fim do periodo deve ser posterior ao inicio",
    });
  }
}

export const backofficeInboundWebhookDeliveryQuerySchema = z
  .object({
    ...backofficeInboundWebhookDeliveryFilterShape,
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .superRefine(validateBackofficeInboundWebhookPeriod);

export const backofficeInboundWebhookDeliverySummaryQuerySchema = z
  .object({
    workspaceId: backofficeInboundWebhookDeliveryFilterShape.workspaceId,
    connectionId: backofficeInboundWebhookDeliveryFilterShape.connectionId,
    channelId: backofficeInboundWebhookDeliveryFilterShape.channelId,
    provider: backofficeInboundWebhookDeliveryFilterShape.provider,
    purpose: backofficeInboundWebhookDeliveryFilterShape.purpose,
    receivedFrom: backofficeInboundWebhookDeliveryFilterShape.receivedFrom,
    receivedUntil: backofficeInboundWebhookDeliveryFilterShape.receivedUntil,
  })
  .superRefine(validateBackofficeInboundWebhookPeriod);

export const backofficeInboundWebhookDeliverySummarySchema = z.object({
  all: z.number().int().nonnegative(),
  ctwaPending: z.number().int().nonnegative(),
  ctwaRouted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  noCtwa: z.number().int().nonnegative(),
  automationCallbacks: z.number().int().nonnegative(),
  awaitingParser: z.number().int().nonnegative(),
});

export const backofficeProviderConversionTraceStates = [
  "internal_outcome",
  "review_required",
  "observed",
  "queued",
  "sent",
  "duplicate",
  "blocked_configuration",
  "failed_retryable",
  "failed_permanent",
] as const;

export const backofficeProviderConversionTraceStateSchema = z.enum(
  backofficeProviderConversionTraceStates,
);

export const backofficeProviderConversionTraceQuerySchema = z
  .object({
    workspaceId: idSchema.optional(),
    connectionId: idSchema.optional(),
    channelId: idSchema.optional(),
    deliveryId: idSchema.optional(),
    providerRuleId: idSchema.optional(),
    eventName: conversionEventNameSchema.optional(),
    decisionCode: providerConversionDecisionCodeSchema.optional(),
    state: backofficeProviderConversionTraceStateSchema.optional(),
    receivedFrom: backofficeInboundWebhookReceivedAtSchema.optional(),
    receivedUntil: backofficeInboundWebhookReceivedAtSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .superRefine(validateBackofficeInboundWebhookPeriod);

export const backofficeProviderConversionTraceSummarySchema = z.object({
  all: z.number().int().nonnegative(),
  internalOutcome: z.number().int().nonnegative(),
  reviewRequired: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  blockedConfiguration: z.number().int().nonnegative(),
  failedRetryable: z.number().int().nonnegative(),
  failedPermanent: z.number().int().nonnegative(),
});

export const backofficeProviderConversionTraceItemSchema = z.object({
  decisionId: idSchema,
  decisionVersion: z.number().int().positive(),
  occurrenceKey: z.string().trim().min(1).max(500),
  occurredAt: dateTimeSchema,
  createdAt: dateTimeSchema,
  workspace: z.object({
    id: idSchema,
    name: z.string().trim().min(1).max(160),
  }),
  connection: z.object({
    id: idSchema,
    name: inboundWebhookDisplayNameSchema,
    provider: inboundWebhookProviderSchema,
  }),
  channel: z
    .object({
      id: idSchema,
      name: inboundWebhookDisplayNameSchema,
      connectedPhone: z.string().trim().min(1).max(32),
    })
    .nullable(),
  rule: z.object({
    id: idSchema,
    name: z.string().trim().min(1).max(160),
    eventName: conversionEventNameSchema,
    mode: z.enum(["observation", "production"]),
  }),
  decision: z.object({
    code: providerConversionDecisionCodeSchema,
    reasonCode: z.string().trim().min(1).max(160),
    engineVersion: z.string().trim().min(1).max(120),
    parserVersion: z.string().trim().min(1).max(120),
    valueCents: z.number().int().nonnegative().nullable(),
    currency: z.string().trim().min(3).max(3).nullable(),
  }),
  delivery: z.object({
    id: idSchema,
    purpose: inboundWebhookDeliveryPurposeSchema,
    status: inboundWebhookDeliveryStatusSchema,
    classification: inboundWebhookEventClassificationSchema.nullable(),
    firstReceivedAt: dateTimeSchema,
    lastReceivedAt: dateTimeSchema,
    payloadAvailable: z.boolean(),
    payloadExpiresAt: dateTimeSchema,
  }),
  review: z
    .object({
      id: idSchema,
      status: z.string().trim().min(1).max(80),
      classificationCode: z.string().trim().min(1).max(160),
      reasonCode: z.string().trim().min(1).max(160).nullable(),
      decidedAt: dateTimeSchema.nullable(),
    })
    .nullable(),
  execution: z
    .object({
      id: idSchema,
      status: z.string().trim().min(1).max(80),
      reasonCode: z.string().trim().min(1).max(160).nullable(),
      conversionEventLogId: idSchema.nullable(),
      attemptCount: z.number().int().nonnegative(),
      lastAttemptedAt: dateTimeSchema.nullable(),
      processedAt: dateTimeSchema.nullable(),
    })
    .nullable(),
  meta: z
    .object({
      id: idSchema,
      status: z.string().trim().min(1).max(80),
      eventName: conversionEventNameSchema,
      sentAt: dateTimeSchema.nullable(),
      pixelId: z.string().trim().min(1).max(255).nullable(),
      pageId: z.string().trim().min(1).max(255).nullable(),
      eventId: z.string().trim().min(1).max(500).nullable(),
      errorCode: z.string().trim().min(1).max(160).nullable(),
      errorMessage: z.string().trim().min(1).max(2_000).nullable(),
      requestPayload: z.unknown().nullable(),
      responseSummary: z.unknown().nullable(),
    })
    .nullable(),
  state: backofficeProviderConversionTraceStateSchema,
  retryable: z.boolean(),
  reevaluable: z.boolean(),
});

export const backofficeProviderConversionTraceListSchema = z.object({
  items: z.array(backofficeProviderConversionTraceItemSchema),
  total: z.number().int().nonnegative(),
  summary: backofficeProviderConversionTraceSummarySchema,
  facets: z.object({
    rules: z.array(
      z.object({
        id: idSchema,
        name: z.string().trim().min(1).max(160),
        eventName: conversionEventNameSchema,
      }),
    ),
  }),
});

export const backofficeProviderConversionReevaluationInputSchema = z.object({
  requestKey: z
    .string()
    .trim()
    .min(16)
    .max(255)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
});

export const backofficeProviderConversionReevaluationResultSchema = z.object({
  previousDecisionId: idSchema,
  decisionId: idSchema,
  decisionVersion: z.number().int().positive(),
  status: z.enum(["reevaluated", "existing"]),
  executionIds: z.array(idSchema),
  eligibleExecutionIds: z.array(idSchema),
});

export const providerConversionEngineModeSchema = z.enum([
  "legacy",
  "shadow",
  "canonical",
]);

export const backofficeProviderConversionRolloutQuerySchema = z
  .object({
    onlyMismatches: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .default("false"),
    comparisonResult: z.enum(["all", "matches", "mismatches"]).default("all"),
    decisionPresence: z
      .enum(["all", "with_decision", "without_decision"])
      .default("all"),
    decisionCode: providerConversionDecisionCodeSchema.optional(),
    eventName: conversionEventNameSchema.optional(),
    createdFrom: backofficeInboundWebhookReceivedAtSchema.optional(),
    createdUntil: backofficeInboundWebhookReceivedAtSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .superRefine((input, context) => {
    if (
      input.createdFrom &&
      input.createdUntil &&
      input.createdFrom > input.createdUntil
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["createdUntil"],
        message: "O fim do periodo deve ser igual ou posterior ao inicio",
      });
    }
  });

export const backofficeProviderConversionRolloutModeInputSchema = z.object({
  mode: providerConversionEngineModeSchema,
  confirmation: inboundWebhookDisplayNameSchema,
  acknowledgedComparisonCount: z.number().int().nonnegative().optional(),
  acknowledgedMismatchCount: z.number().int().nonnegative().optional(),
});

export const backofficeProviderConversionRolloutComparisonSchema = z.object({
  id: idSchema,
  occurrenceKey: z.string().trim().min(1).max(500),
  eventName: conversionEventNameSchema,
  authoritativeEngine: providerConversionEngineModeSchema,
  matches: z.boolean(),
  mismatchCode: z.string().trim().min(1).max(160).nullable(),
  legacy: z.object({
    engineVersion: z.string().trim().min(1).max(120).nullable(),
    decisionCode: providerConversionDecisionCodeSchema.nullable(),
    reasonCode: z.string().trim().min(1).max(160).nullable(),
  }),
  canonical: z.object({
    engineVersion: z.string().trim().min(1).max(120).nullable(),
    decisionCode: providerConversionDecisionCodeSchema.nullable(),
    reasonCode: z.string().trim().min(1).max(160).nullable(),
  }),
  sourceDeliveryId: idSchema,
  createdAt: dateTimeSchema,
});

export const backofficeProviderConversionRolloutSchema = z.object({
  channel: z.object({
    id: idSchema,
    displayName: inboundWebhookDisplayNameSchema,
    connectedPhone: z.string().trim().min(1).max(32),
    mode: providerConversionEngineModeSchema,
  }),
  counts: z.object({
    comparisons: z.number().int().nonnegative(),
    matches: z.number().int().nonnegative(),
    mismatches: z.number().int().nonnegative(),
  }),
  filteredCounts: z.object({
    comparisons: z.number().int().nonnegative(),
    matches: z.number().int().nonnegative(),
    mismatches: z.number().int().nonnegative(),
  }),
  pagination: z.object({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    hasPrevious: z.boolean(),
    hasNext: z.boolean(),
  }),
  mismatchReasons: z.array(
    z.object({
      code: z.string().trim().min(1).max(160),
      count: z.number().int().nonnegative(),
    }),
  ),
  latestComparisonAt: dateTimeSchema.nullable(),
  canActivateCanonical: z.boolean(),
  canonicalBlocker: z.string().trim().min(1).max(255).nullable(),
  comparisons: z.array(backofficeProviderConversionRolloutComparisonSchema),
});

export const backofficeInboundWebhookScopeChannelSchema = z.object({
  id: idSchema,
  displayName: inboundWebhookDisplayNameSchema,
  connectedPhone: z.string().trim().min(1).max(32),
  status: inboundWebhookChannelStatusSchema,
  conversionEngineMode: providerConversionEngineModeSchema,
  lastSeenAt: dateTimeSchema,
});

export const backofficeInboundWebhookScopeConnectionSchema = z.object({
  id: idSchema,
  displayName: inboundWebhookDisplayNameSchema,
  provider: inboundWebhookProviderSchema,
  status: inboundWebhookConnectionStatusSchema,
  lastDeliveryAt: dateTimeSchema.nullable(),
  channels: z.array(backofficeInboundWebhookScopeChannelSchema),
});

export const backofficeInboundWebhookScopeDirectInstanceSchema = z.object({
  id: idSchema,
  displayName: inboundWebhookDisplayNameSchema,
  provider: z.literal("uazapi"),
  status: z.enum([
    "pending_payment",
    "active",
    "disconnected",
    "suspended",
    "error",
  ]),
  connectedPhone: z.string().trim().min(1).max(32).nullable(),
  seatStatus: z
    .enum(["reserved", "active", "suspended", "released"])
    .nullable(),
  lastSeenAt: dateTimeSchema.nullable(),
});

export const backofficeInboundWebhookScopeWorkspaceSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(160),
  connections: z.array(backofficeInboundWebhookScopeConnectionSchema),
  directInstances: z.array(backofficeInboundWebhookScopeDirectInstanceSchema),
});

export const backofficeInboundWebhookOperationsScopeSchema = z.object({
  workspaces: z.array(backofficeInboundWebhookScopeWorkspaceSchema),
});

export const backofficeInboundWebhookDeliveryChannelSchema = z.object({
  id: idSchema,
  displayName: inboundWebhookDisplayNameSchema,
  connectedPhone: z.string().trim().min(1).max(32),
});

export const backofficeInboundWebhookDeliverySchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  workspaceName: z.string().trim().min(1).max(160),
  connectionId: idSchema,
  connectionName: inboundWebhookDisplayNameSchema,
  provider: inboundWebhookProviderSchema,
  providerEventType: z.string().trim().min(1).max(120).nullable(),
  parserVersion: parserVersionSchema,
  parserReleaseStatus: inboundWebhookParserReleaseStatusSchema,
  purpose: inboundWebhookDeliveryPurposeSchema,
  status: inboundWebhookDeliveryStatusSchema,
  classification: inboundWebhookEventClassificationSchema.nullable(),
  firstReceivedAt: dateTimeSchema,
  lastReceivedAt: dateTimeSchema,
  attemptCount: z.number().int().positive(),
  payloadAvailable: z.boolean(),
  payloadExpiresAt: dateTimeSchema,
  providerConversionsObservedAt: dateTimeSchema.nullable(),
  parseErrorCode: normalizedCodeSchema.nullable(),
  routingErrorCode: normalizedCodeSchema.nullable(),
  normalizedSummary: z.record(z.unknown()).nullable(),
  eventCount: z.number().int().nonnegative(),
  channels: z.array(backofficeInboundWebhookDeliveryChannelSchema),
});

export const backofficeInboundWebhookDeliveryListSchema = z.array(
  backofficeInboundWebhookDeliverySchema,
);

export const inboundWebhookChannelRouteSchema = z.object({
  id: idSchema,
  channelId: idSchema,
  metaBusinessConnectionId: idSchema.nullable(),
  metaReportingAccountId: idSchema.nullable(),
  metaConversionDestinationId: idSchema.nullable(),
  active: z.boolean(),
  validationStatus: normalizedCodeSchema,
  validationErrorCode: normalizedCodeSchema.nullable(),
  lastValidatedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});

export const inboundWebhookChannelReadinessSchema = z.object({
  state: inboundWebhookChannelReadinessStateSchema,
  blockers: z.array(inboundWebhookChannelReadinessBlockerSchema),
  routeCount: z.number().int().nonnegative(),
  validRouteCount: z.number().int().nonnegative(),
  /** CRM-only (Kommo/Pipedrive): whether this number, of any provider, may be
   * bound by its channel id to the verified unique workspace page/pixel. Does
   * not describe nor change inbound entry routing. */
  crmDestinationReadiness: z
    .object({
      status: z.enum(["verified", "not_ready"]),
      reason: z.string().min(1).max(120),
    })
    .optional(),
  totalCtwa: z.number().int().nonnegative(),
  routedCtwa: z.number().int().nonnegative(),
  unresolvedCtwa: z.number().int().nonnegative(),
  retainedCtwa: z.number().int().nonnegative(),
  retainedRoutedCtwa: z.number().int().nonnegative(),
  payloadUnavailableCtwa: z.number().int().nonnegative(),
  alreadyMaterializedCtwa: z.number().int().nonnegative(),
  nextPayloadExpiresAt: dateTimeSchema.nullable(),
  // Fase 4b (so Unnichat): de onde vem o roteamento Meta deste numero.
  // legacy_unknown = numero antigo sem modo salvo; precisa escolher um modo.
  routingSource: z
    .enum(["inherit_workspace", "channel_override", "legacy_unknown"])
    .optional(),
  effectiveRouteEligible: z.boolean().optional(),
  // Par unico pagina + pixel autorizado para leads CTWA sem ID do anuncio.
  ctwaDestinationReadiness: z
    .object({
      status: z.enum(["verified", "not_ready"]),
      reason: z.string().min(1).max(120),
    })
    .optional(),
  adUnavailableCtwa: z.number().int().nonnegative().optional(),
});

export const inboundWebhookChannelSchema = z.object({
  id: idSchema,
  connectionId: idSchema,
  organizationId: idSchema,
  providerChannelId: idSchema,
  connectedPhone: z.string().trim().min(1).max(32),
  channelName: z.string().trim().min(1).max(160).nullable(),
  // Set only for UAZAPI channels bridged to a WhatsApp instance; drives the
  // live label picker in the tag conversion rule builder.
  whatsappInstanceId: idSchema.nullable(),
  status: inboundWebhookChannelStatusSchema,
  productionActivatedAt: dateTimeSchema.nullable(),
  firstSeenAt: dateTimeSchema,
  lastSeenAt: dateTimeSchema,
  routes: z.array(inboundWebhookChannelRouteSchema),
  readiness: inboundWebhookChannelReadinessSchema,
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});

export const inboundWebhookChannelListSchema = z.array(
  inboundWebhookChannelSchema,
);

export const inboundWebhookNormalizedObservationSchema = z.object({
  id: idSchema,
  connectionId: idSchema,
  deliveryId: idSchema,
  channelId: idSchema,
  provider: inboundWebhookProviderSchema,
  providerEventType: z.string().trim().min(1).max(120).nullable(),
  externalMessageId: idSchema.nullable(),
  occurredAt: dateTimeSchema,
  connectedPhoneSuffix: z
    .string()
    .regex(/^\d{2,8}$/)
    .nullable(),
  contactIdentityHash: z.string().min(16).max(128).nullable(),
  adId: idSchema.nullable(),
  hasCtwa: z.boolean(),
  classification: inboundWebhookEventClassificationSchema,
  classificationReason: normalizedCodeSchema.nullable(),
  resolvedBusinessConnectionId: idSchema.nullable(),
  resolvedReportingAccountId: idSchema.nullable(),
  resolvedConversionDestinationId: idSchema.nullable(),
  createdAt: dateTimeSchema,
});

export const inboundWebhookNormalizedObservationListSchema = z.array(
  inboundWebhookNormalizedObservationSchema,
);

export const backofficeInboundWebhookPayloadSchema = z.object({
  delivery: backofficeInboundWebhookDeliverySchema,
  payload: z.record(z.unknown()).nullable(),
  events: inboundWebhookNormalizedObservationListSchema,
});

export const backofficeInboundWebhookReplayConfirmationInputSchema = z.object({
  confirmation: inboundWebhookDisplayNameSchema,
  selection: inboundWebhookReplaySelectionSchema.default("canary_1"),
  channelId: idSchema,
});

export const backofficeInboundWebhookReplayRetryInputSchema = z.object({
  confirmation: inboundWebhookDisplayNameSchema,
});

export const backofficeInboundWebhookReplayBatchSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  connectionId: idSchema,
  channelId: idSchema.nullable(),
  requestedByUserId: idSchema,
  selection: inboundWebhookReplaySelectionSchema,
  requestedLimit: z.number().int().min(1).max(500),
  status: inboundWebhookReplayStatusSchema,
  totalItems: z.number().int().nonnegative(),
  materializedCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  retryableFailedCount: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  startedAt: dateTimeSchema.nullable(),
  completedAt: dateTimeSchema.nullable(),
  lastRetriedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
});

export const backofficeInboundWebhookReplayChannelSchema = z.object({
  id: idSchema,
  displayName: inboundWebhookDisplayNameSchema,
  connectedPhone: z.string().min(1).nullable(),
  totalCtwa: z.number().int().nonnegative(),
  routeResolved: z.number().int().nonnegative(),
  routeUnresolved: z.number().int().nonnegative(),
  payloadAvailable: z.number().int().nonnegative(),
  alreadyMaterialized: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
});

export const backofficeInboundWebhookReplayPreviewSchema = z.object({
  connection: inboundWebhookConnectionSchema,
  parserRelease: inboundWebhookParserReleaseSchema,
  replayEnabled: z.boolean(),
  counts: z.object({
    totalCtwa: z.number().int().nonnegative(),
    routeResolved: z.number().int().nonnegative(),
    routeUnresolved: z.number().int().nonnegative(),
    payloadAvailable: z.number().int().nonnegative(),
    payloadExpired: z.number().int().nonnegative(),
    payloadUnavailable: z.number().int().nonnegative(),
    alreadyMaterialized: z.number().int().nonnegative(),
    eligible: z.number().int().nonnegative(),
  }),
  oldestOccurredAt: dateTimeSchema.nullable(),
  newestOccurredAt: dateTimeSchema.nullable(),
  nextPayloadExpiresAt: dateTimeSchema.nullable(),
  channels: z.array(backofficeInboundWebhookReplayChannelSchema),
  latestBatch: backofficeInboundWebhookReplayBatchSchema.nullable(),
  recentBatches: z.array(backofficeInboundWebhookReplayBatchSchema).max(10),
});

export const backofficeInboundWebhookProductionRecoveryInputSchema = z.object({
  confirmation: inboundWebhookDisplayNameSchema,
  selection: inboundWebhookReplaySelectionSchema.default("canary_1"),
  channelId: idSchema,
});

export const backofficeInboundWebhookProductionRecoveryChannelSchema = z.object(
  {
    id: idSchema,
    displayName: inboundWebhookDisplayNameSchema,
    connectedPhone: z.string().trim().min(1).max(32),
    status: inboundWebhookChannelStatusSchema,
    productionActivatedAt: dateTimeSchema.nullable(),
    totalCtwa: z.number().int().nonnegative(),
    historical: z.number().int().nonnegative(),
    routeUnresolved: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    alreadyQueued: z.number().int().nonnegative(),
    eligible: z.number().int().nonnegative(),
  },
);

export const backofficeInboundWebhookProductionRecoveryPreviewSchema = z.object(
  {
    workspace: z.object({
      id: idSchema,
      name: z.string().trim().min(1).max(160),
    }),
    connection: inboundWebhookConnectionSchema,
    productionEnabled: z.boolean(),
    counts: z.object({
      totalCtwa: z.number().int().nonnegative(),
      historical: z.number().int().nonnegative(),
      routeUnresolved: z.number().int().nonnegative(),
      unavailable: z.number().int().nonnegative(),
      alreadyQueued: z.number().int().nonnegative(),
      eligible: z.number().int().nonnegative(),
    }),
    channels: z.array(backofficeInboundWebhookProductionRecoveryChannelSchema),
  },
);

export const backofficeInboundWebhookProductionRecoveryResultSchema = z.object({
  connectionId: idSchema,
  channelId: idSchema,
  selection: inboundWebhookReplaySelectionSchema,
  selected: z.number().int().nonnegative(),
  persisted: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  existing: z.number().int().nonnegative(),
  queueFailures: z.number().int().nonnegative(),
});

export const backofficeInboundWebhookParserRecoveryInputSchema = z.object({
  confirmation: inboundWebhookDisplayNameSchema,
  selection: inboundWebhookParserRecoverySelectionSchema.default("canary_10"),
});

export const backofficeInboundWebhookParserRecoveryPreviewSchema = z.object({
  workspace: z.object({
    id: idSchema,
    name: z.string().trim().min(1).max(160),
  }),
  connection: inboundWebhookConnectionSchema,
  counts: z.object({
    awaitingParser: z.number().int().nonnegative(),
    recoverable: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    inFlight: z.number().int().nonnegative(),
  }),
  maxBatchSize: z.literal(500),
});

export const backofficeInboundWebhookParserRecoveryResultSchema = z.object({
  connectionId: idSchema,
  selection: inboundWebhookParserRecoverySelectionSchema,
  requestedLimit: z.number().int().min(1).max(500),
  selected: z.number().int().nonnegative(),
  claimed: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  existing: z.number().int().nonnegative(),
  queueFailures: z.number().int().nonnegative(),
  remainingRecoverable: z.number().int().nonnegative(),
});

export type InboundWebhookProviderDto = z.infer<
  typeof inboundWebhookProviderSchema
>;
export type InboundWebhookParserReleaseStatusDto = z.infer<
  typeof inboundWebhookParserReleaseStatusSchema
>;
export type InboundWebhookConnectionStatusDto = z.infer<
  typeof inboundWebhookConnectionStatusSchema
>;
export type InboundWebhookMutableConnectionStatusDto = z.infer<
  typeof inboundWebhookMutableConnectionStatusSchema
>;
export type InboundWebhookChannelStatusDto = z.infer<
  typeof inboundWebhookChannelStatusSchema
>;
export type InboundWebhookMutableChannelStatusDto = z.infer<
  typeof inboundWebhookMutableChannelStatusSchema
>;
export type InboundWebhookDeliveryStatusDto = z.infer<
  typeof inboundWebhookDeliveryStatusSchema
>;
export type InboundWebhookDeliveryPurposeDto = z.infer<
  typeof inboundWebhookDeliveryPurposeSchema
>;
export type InboundWebhookEventClassificationDto = z.infer<
  typeof inboundWebhookEventClassificationSchema
>;
export type InboundWebhookReplayStatusDto = z.infer<
  typeof inboundWebhookReplayStatusSchema
>;
export type InboundWebhookReplayItemStatusDto = z.infer<
  typeof inboundWebhookReplayItemStatusSchema
>;
export type InboundWebhookReplaySelectionDto = z.infer<
  typeof inboundWebhookReplaySelectionSchema
>;
export type InboundWebhookParserRecoverySelectionDto = z.infer<
  typeof inboundWebhookParserRecoverySelectionSchema
>;
export type InboundWebhookConnectionCreateInputDto = z.infer<
  typeof inboundWebhookConnectionCreateInputSchema
>;
export type InboundWebhookConnectionStatusUpdateInputDto = z.infer<
  typeof inboundWebhookConnectionStatusUpdateInputSchema
>;
export type InboundWebhookChannelStatusUpdateInputDto = z.infer<
  typeof inboundWebhookChannelStatusUpdateInputSchema
>;
export type InboundWebhookChannelCreateInputDto = z.infer<
  typeof inboundWebhookChannelCreateInputSchema
>;
export type InboundWebhookChannelRouteInputDto = z.infer<
  typeof inboundWebhookChannelRouteInputSchema
>;
export type InboundWebhookChannelRoutesUpdateInputDto = z.infer<
  typeof inboundWebhookChannelRoutesUpdateInputSchema
>;
export type InboundWebhookParserReleaseDto = z.infer<
  typeof inboundWebhookParserReleaseSchema
>;
export type InboundWebhookConnectionDto = z.infer<
  typeof inboundWebhookConnectionSchema
>;
export type InboundWebhookConnectionListDto = z.infer<
  typeof inboundWebhookConnectionListSchema
>;
export type InboundWebhookConnectionCreateResultDto = z.infer<
  typeof inboundWebhookConnectionCreateResultSchema
>;
export type InboundWebhookConnectionRotateSecretResultDto = z.infer<
  typeof inboundWebhookConnectionRotateSecretResultSchema
>;
export type InboundWebhookCapabilityProviderDto = z.infer<
  typeof inboundWebhookCapabilityProviderSchema
>;
export type InboundWebhookCapabilitiesDto = z.infer<
  typeof inboundWebhookCapabilitiesSchema
>;
export type InboundWebhookObservationCountersDto = z.infer<
  typeof inboundWebhookObservationCountersSchema
>;
export type InboundWebhookConnectionOverviewDto = z.infer<
  typeof inboundWebhookConnectionOverviewSchema
>;
export type BackofficeInboundWebhookDeliveryQueryDto = z.infer<
  typeof backofficeInboundWebhookDeliveryQuerySchema
>;
export type BackofficeInboundWebhookDeliverySummaryQueryDto = z.infer<
  typeof backofficeInboundWebhookDeliverySummaryQuerySchema
>;
export type BackofficeInboundWebhookDeliverySummaryDto = z.infer<
  typeof backofficeInboundWebhookDeliverySummarySchema
>;
export type BackofficeProviderConversionTraceStateDto = z.infer<
  typeof backofficeProviderConversionTraceStateSchema
>;
export type BackofficeProviderConversionTraceQueryDto = z.infer<
  typeof backofficeProviderConversionTraceQuerySchema
>;
export type BackofficeProviderConversionTraceSummaryDto = z.infer<
  typeof backofficeProviderConversionTraceSummarySchema
>;
export type BackofficeProviderConversionTraceItemDto = z.infer<
  typeof backofficeProviderConversionTraceItemSchema
>;
export type BackofficeProviderConversionTraceListDto = z.infer<
  typeof backofficeProviderConversionTraceListSchema
>;
export type BackofficeProviderConversionReevaluationInputDto = z.infer<
  typeof backofficeProviderConversionReevaluationInputSchema
>;
export type BackofficeProviderConversionReevaluationResultDto = z.infer<
  typeof backofficeProviderConversionReevaluationResultSchema
>;
export type ProviderConversionEngineModeDto = z.infer<
  typeof providerConversionEngineModeSchema
>;
export type BackofficeProviderConversionRolloutQueryDto = z.infer<
  typeof backofficeProviderConversionRolloutQuerySchema
>;
export type BackofficeProviderConversionRolloutModeInputDto = z.infer<
  typeof backofficeProviderConversionRolloutModeInputSchema
>;
export type BackofficeProviderConversionRolloutComparisonDto = z.infer<
  typeof backofficeProviderConversionRolloutComparisonSchema
>;
export type BackofficeProviderConversionRolloutDto = z.infer<
  typeof backofficeProviderConversionRolloutSchema
>;
export type BackofficeInboundWebhookScopeChannelDto = z.infer<
  typeof backofficeInboundWebhookScopeChannelSchema
>;
export type BackofficeInboundWebhookScopeConnectionDto = z.infer<
  typeof backofficeInboundWebhookScopeConnectionSchema
>;
export type BackofficeInboundWebhookScopeDirectInstanceDto = z.infer<
  typeof backofficeInboundWebhookScopeDirectInstanceSchema
>;
export type BackofficeInboundWebhookScopeWorkspaceDto = z.infer<
  typeof backofficeInboundWebhookScopeWorkspaceSchema
>;
export type BackofficeInboundWebhookOperationsScopeDto = z.infer<
  typeof backofficeInboundWebhookOperationsScopeSchema
>;
export type BackofficeInboundWebhookDeliveryChannelDto = z.infer<
  typeof backofficeInboundWebhookDeliveryChannelSchema
>;
export type BackofficeInboundWebhookDeliveryDto = z.infer<
  typeof backofficeInboundWebhookDeliverySchema
>;
export type BackofficeInboundWebhookDeliveryListDto = z.infer<
  typeof backofficeInboundWebhookDeliveryListSchema
>;
export type BackofficeInboundWebhookPayloadDto = z.infer<
  typeof backofficeInboundWebhookPayloadSchema
>;
export type InboundWebhookChannelRouteDto = z.infer<
  typeof inboundWebhookChannelRouteSchema
>;
export type InboundWebhookChannelReadinessStateDto = z.infer<
  typeof inboundWebhookChannelReadinessStateSchema
>;
export type InboundWebhookChannelReadinessBlockerDto = z.infer<
  typeof inboundWebhookChannelReadinessBlockerSchema
>;
export type InboundWebhookChannelReadinessDto = z.infer<
  typeof inboundWebhookChannelReadinessSchema
>;
export type InboundWebhookChannelDto = z.infer<
  typeof inboundWebhookChannelSchema
>;
export type InboundWebhookChannelListDto = z.infer<
  typeof inboundWebhookChannelListSchema
>;
export type InboundWebhookNormalizedObservationDto = z.infer<
  typeof inboundWebhookNormalizedObservationSchema
>;
export type InboundWebhookNormalizedObservationListDto = z.infer<
  typeof inboundWebhookNormalizedObservationListSchema
>;
export type BackofficeInboundWebhookReplayConfirmationInputDto = z.infer<
  typeof backofficeInboundWebhookReplayConfirmationInputSchema
>;
export type BackofficeInboundWebhookReplayRetryInputDto = z.infer<
  typeof backofficeInboundWebhookReplayRetryInputSchema
>;
export type BackofficeInboundWebhookReplayBatchDto = z.infer<
  typeof backofficeInboundWebhookReplayBatchSchema
>;
export type BackofficeInboundWebhookReplayChannelDto = z.infer<
  typeof backofficeInboundWebhookReplayChannelSchema
>;
export type BackofficeInboundWebhookReplayPreviewDto = z.infer<
  typeof backofficeInboundWebhookReplayPreviewSchema
>;
export type BackofficeInboundWebhookProductionRecoveryInputDto = z.infer<
  typeof backofficeInboundWebhookProductionRecoveryInputSchema
>;
export type BackofficeInboundWebhookProductionRecoveryChannelDto = z.infer<
  typeof backofficeInboundWebhookProductionRecoveryChannelSchema
>;
export type BackofficeInboundWebhookProductionRecoveryPreviewDto = z.infer<
  typeof backofficeInboundWebhookProductionRecoveryPreviewSchema
>;
export type BackofficeInboundWebhookProductionRecoveryResultDto = z.infer<
  typeof backofficeInboundWebhookProductionRecoveryResultSchema
>;
export type BackofficeInboundWebhookParserRecoveryInputDto = z.infer<
  typeof backofficeInboundWebhookParserRecoveryInputSchema
>;
export type BackofficeInboundWebhookParserRecoveryPreviewDto = z.infer<
  typeof backofficeInboundWebhookParserRecoveryPreviewSchema
>;
export type BackofficeInboundWebhookParserRecoveryResultDto = z.infer<
  typeof backofficeInboundWebhookParserRecoveryResultSchema
>;
