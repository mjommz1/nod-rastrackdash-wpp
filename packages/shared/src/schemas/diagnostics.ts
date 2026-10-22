import { z } from "zod";
import { conversionEventTestInputSchema } from "./conversion-events";
import {
  whatsappConnectionProviderSchema,
  whatsappConnectionStatusSchema,
} from "./integrations";

export const diagnosticSources = [
  "kommo",
  "meta",
  "uazapi",
  "umbler",
  "gupshup",
  "asaas",
  "external_mysql",
  "internal",
  "waha",
  "zapi",
  "data_crazy",
  "payt",
  "unnichat"
] as const;
export const diagnosticSeverities = [
  "info",
  "warning",
  "error",
  "critical"
] as const;

export const diagnosticSourceSchema = z.enum(diagnosticSources);
export const diagnosticSeveritySchema = z.enum(diagnosticSeverities);

export const diagnosticEventSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1).nullable(),
  source: diagnosticSourceSchema,
  eventType: z.string().min(1),
  severity: diagnosticSeveritySchema,
  status: z.string().min(1),
  occurredAt: z.string().datetime(),
  title: z.string().min(1),
  message: z.string().min(1),
  leadId: z.string().nullable(),
  phoneHash: z.string().nullable(),
  campaignId: z.string().nullable(),
  adSetId: z.string().nullable(),
  adId: z.string().nullable(),
  jobId: z.string().nullable(),
  errorCode: z.string().nullable()
});

export const diagnosticEventCreateSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  source: diagnosticSourceSchema,
  eventType: z.string().min(1),
  severity: diagnosticSeveritySchema.default("info"),
  status: z.string().min(1),
  title: z.string().min(1),
  message: z.string().min(1),
  occurredAt: z.string().datetime().optional(),
  leadId: z.string().min(1).optional(),
  phoneHash: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
  adSetId: z.string().min(1).optional(),
  adId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
  summaryPayload: z.record(z.unknown()).optional()
});

export const diagnosticEventListQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  source: diagnosticSourceSchema.optional(),
  status: z.string().min(1).optional(),
  severity: diagnosticSeveritySchema.optional(),
  eventType: z.string().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  leadId: z.string().min(1).optional(),
  phoneHash: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
  adSetId: z.string().min(1).optional(),
  adId: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const diagnosticSummaryQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional()
});

export const diagnosticSummarySchema = z.object({
  generatedAt: z.string().datetime(),
  range: z.object({
    since: z.string().datetime(),
    until: z.string().datetime()
  }),
  workspaceId: z.string().min(1).nullable(),
  status: z.enum(["healthy", "warning", "critical"]),
  totals: z.object({
    diagnosticEvents: z.number().int().nonnegative(),
    criticalEvents: z.number().int().nonnegative(),
    errorEvents: z.number().int().nonnegative(),
    webhooks: z.number().int().nonnegative(),
    failedWebhooks: z.number().int().nonnegative(),
    jobs: z.number().int().nonnegative(),
    failedJobs: z.number().int().nonnegative(),
    integrationCalls: z.number().int().nonnegative(),
    failedIntegrationCalls: z.number().int().nonnegative(),
    conversionEvents: z.number().int().nonnegative(),
    failedConversionEvents: z.number().int().nonnegative(),
    auditLogs: z.number().int().nonnegative(),
    metaReportingAccountsActive: z.number().int().nonnegative(),
    metaReportingAccountsError: z.number().int().nonnegative(),
    metaWhatsappNeedsReview: z.number().int().nonnegative(),
    metaConversionDestinationConfigured: z.boolean()
  })
});

export const diagnosticWebhookLogSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1).nullable(),
  whatsappInstanceId: z.string().min(1).nullable(),
  source: diagnosticSourceSchema,
  eventType: z.string().min(1),
  externalEventId: z.string().nullable(),
  status: z.string().min(1),
  receivedAt: z.string().datetime(),
  processedAt: z.string().datetime().nullable(),
  leadId: z.string().nullable(),
  phoneHash: z.string().nullable(),
  campaignId: z.string().nullable(),
  adSetId: z.string().nullable(),
  adId: z.string().nullable(),
  jobId: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  payloadAvailable: z.boolean()
});

export const diagnosticWebhookLogListQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  whatsappInstanceId: z.string().min(1).optional(),
  source: diagnosticSourceSchema.optional(),
  status: z.string().min(1).optional(),
  eventType: z.string().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  leadId: z.string().min(1).optional(),
  phoneHash: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
  adSetId: z.string().min(1).optional(),
  adId: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(200000).default(0)
});

export const diagnosticWebhookLogListSchema = z.array(
  diagnosticWebhookLogSchema
);

/**
 * Workspace-scoped, student-safe summary of WhatsApp webhook receipt.
 * Deliberately excludes ids/hashes/payloads — see recordWebhookLog callers
 * for the full (backoffice-only) log shape.
 */
export const whatsappWebhookReceiptStatusSchema = z.object({
  hasReceipts: z.boolean(),
  lastReceivedAt: z.string().datetime().nullable(),
  lastSource: diagnosticSourceSchema.nullable(),
  lastEventType: z.string().min(1).nullable(),
  lastStatus: z.string().min(1).nullable(),
  lastLeadCreated: z.boolean().nullable(),
  recentCount: z.number().int().nonnegative()
});

export const backofficeWhatsappWebhookConnectionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    provider: whatsappConnectionProviderSchema,
    status: whatsappConnectionStatusSchema,
    webhookConfigured: z.boolean(),
  })
  .strict();

export const backofficeWhatsappWebhookConnectionListSchema = z.array(
  backofficeWhatsappWebhookConnectionSchema,
);

export const backofficeWhatsappWebhookHistoryQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const backofficeWhatsappWebhookHistoryItemSchema = z
  .object({
    id: z.string().min(1),
    receivedAt: z.string().datetime(),
    status: z.string().min(1),
    source: diagnosticSourceSchema,
    provider: whatsappConnectionProviderSchema,
    eventType: z.string().min(1),
    externalEventId: z.string().nullable(),
    leadId: z.string().nullable(),
    errorCode: z.string().nullable(),
  })
  .strict();

export const backofficeWhatsappWebhookHistorySchema = z
  .object({
    items: z.array(backofficeWhatsappWebhookHistoryItemSchema),
    pagination: z
      .object({
        page: z.number().int().positive(),
        pageSize: z.number().int().positive(),
        total: z.number().int().nonnegative(),
        totalPages: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const backofficeWhatsappWebhookDetailSchema = z
  .object({
    webhook: backofficeWhatsappWebhookHistoryItemSchema,
    payloadAvailable: z.boolean(),
    payload: z.record(z.unknown()).nullable(),
  })
  .strict();

export const diagnosticWebhookPayloadSchema = diagnosticWebhookLogSchema
  .pick({
    id: true,
    workspaceId: true,
    whatsappInstanceId: true,
    source: true,
    eventType: true,
    externalEventId: true,
    status: true,
    receivedAt: true
  })
  .extend({
    payloadKind: z.literal("summary"),
    payloadAvailable: z.boolean(),
    payload: z.record(z.unknown()).nullable()
  });

export const diagnosticJobAttemptSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1).nullable(),
  queueName: z.string().min(1),
  jobId: z.string().min(1),
  jobName: z.string().min(1),
  attemptNumber: z.number().int().positive(),
  status: z.string().min(1),
  scheduledAt: z.string().datetime().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  nextRetryAt: z.string().datetime().nullable(),
  source: diagnosticSourceSchema,
  relatedEntityType: z.string().nullable(),
  relatedEntityId: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime()
});

export const diagnosticJobAttemptListQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  source: diagnosticSourceSchema.optional(),
  status: z.string().min(1).optional(),
  queueName: z.string().min(1).optional(),
  jobName: z.string().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10)
});

export const diagnosticJobAttemptListSchema = z.array(
  diagnosticJobAttemptSchema
);

export const diagnosticIntegrationLogSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1).nullable(),
  source: diagnosticSourceSchema,
  operation: z.string().min(1),
  status: z.string().min(1),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  httpStatus: z.number().int().nullable(),
  providerRequestId: z.string().nullable(),
  providerErrorCode: z.string().nullable(),
  providerErrorMessage: z.string().nullable(),
  leadId: z.string().nullable(),
  campaignId: z.string().nullable(),
  adSetId: z.string().nullable(),
  adId: z.string().nullable(),
  jobId: z.string().nullable()
});

export const diagnosticIntegrationLogListQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  source: diagnosticSourceSchema.optional(),
  status: z.string().min(1).optional(),
  operation: z.string().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  leadId: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
  adSetId: z.string().min(1).optional(),
  adId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  providerErrorCode: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10)
});

export const diagnosticIntegrationLogListSchema = z.array(
  diagnosticIntegrationLogSchema
);

export const diagnosticConversionEventLogSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1).nullable(),
  leadId: z.string().nullable(),
  phoneHash: z.string().nullable(),
  sourceTrigger: z.string().min(1),
  eventId: z.string().nullable(),
  eventName: z.string().min(1),
  status: z.string().min(1),
  pixelId: z.string().nullable(),
  metaAccountId: z.string().nullable(),
  campaignId: z.string().nullable(),
  adSetId: z.string().nullable(),
  adId: z.string().nullable(),
  attributionStatus: z.string().nullable(),
  dedupeKey: z.string().nullable(),
  ctwaClid: z.string().nullable(),
  valueCents: z.number().int().nullable(),
  valueSource: z
    .enum(["actual", "configured_average", "manual"])
    .nullable()
    .default(null),
  currency: z.string().nullable(),
  contentName: z.string().nullable(),
  customData: z.record(z.unknown()).nullable(),
  sentAt: z.string().datetime().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  jobId: z.string().nullable(),
  createdAt: z.string().datetime()
});

export const diagnosticConversionEventLogListQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  eventName: z.string().min(1).optional(),
  sourceTrigger: z.string().min(1).optional(),
  pixelId: z.string().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  leadId: z.string().min(1).optional(),
  phoneHash: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
  adSetId: z.string().min(1).optional(),
  adId: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10)
});

export const diagnosticConversionEventLogListSchema = z.array(
  diagnosticConversionEventLogSchema
);

export const diagnosticAuditLogSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1).nullable(),
  actorUserId: z.string().nullable(),
  actorType: z.string().min(1),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  reason: z.string().nullable(),
  sourceIp: z.string().nullable(),
  resultStatus: z.string().min(1),
  createdAt: z.string().datetime(),
  beforeSummary: z.record(z.unknown()).nullable(),
  afterSummary: z.record(z.unknown()).nullable()
});

export const diagnosticAuditLogListQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  actorUserId: z.string().min(1).optional(),
  actorType: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  targetType: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  resultStatus: z.string().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10)
});

export const diagnosticAuditLogListSchema = z.array(diagnosticAuditLogSchema);

export const diagnosticTimelineItemSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "diagnostic_event",
    "webhook_log",
    "integration_log",
    "conversion_event_log",
    "job_attempt",
    "audit_log"
  ]),
  label: z.string().min(1),
  status: z.string().min(1),
  occurredAt: z.string().datetime(),
  summaryPayload: z.record(z.unknown()).nullable()
});

export const diagnosticEventDetailSchema = diagnosticEventSchema.extend({
  summaryPayload: z.record(z.unknown()).nullable(),
  timeline: z.array(diagnosticTimelineItemSchema)
});

export const diagnosticRetryInputSchema = z.object({
  reason: z.string().trim().min(10).max(500)
});

export const diagnosticRetryResultSchema = z.object({
  ok: z.literal(true),
  status: z.literal("queued"),
  diagnosticEventId: z.string().min(1),
  auditLogId: z.string().min(1),
  jobAttemptId: z.string().min(1)
});

export const diagnosticConversionEventTestInputSchema =
  conversionEventTestInputSchema;

export type DiagnosticSourceDto = z.infer<typeof diagnosticSourceSchema>;
export type DiagnosticSeverityDto = z.infer<typeof diagnosticSeveritySchema>;
export type DiagnosticEventDto = z.infer<typeof diagnosticEventSchema>;
export type DiagnosticEventCreateDto = z.infer<
  typeof diagnosticEventCreateSchema
>;
export type DiagnosticEventListQueryDto = z.infer<
  typeof diagnosticEventListQuerySchema
>;
export type DiagnosticSummaryQueryDto = z.infer<
  typeof diagnosticSummaryQuerySchema
>;
export type DiagnosticSummaryDto = z.infer<typeof diagnosticSummarySchema>;
export type DiagnosticWebhookLogDto = z.infer<
  typeof diagnosticWebhookLogSchema
>;
export type DiagnosticWebhookLogListQueryDto = z.infer<
  typeof diagnosticWebhookLogListQuerySchema
>;
export type DiagnosticWebhookPayloadDto = z.infer<
  typeof diagnosticWebhookPayloadSchema
>;
export type WhatsappWebhookReceiptStatusDto = z.infer<
  typeof whatsappWebhookReceiptStatusSchema
>;
export type BackofficeWhatsappWebhookConnectionDto = z.infer<
  typeof backofficeWhatsappWebhookConnectionSchema
>;
export type BackofficeWhatsappWebhookHistoryQueryDto = z.infer<
  typeof backofficeWhatsappWebhookHistoryQuerySchema
>;
export type BackofficeWhatsappWebhookHistoryItemDto = z.infer<
  typeof backofficeWhatsappWebhookHistoryItemSchema
>;
export type BackofficeWhatsappWebhookHistoryDto = z.infer<
  typeof backofficeWhatsappWebhookHistorySchema
>;
export type BackofficeWhatsappWebhookDetailDto = z.infer<
  typeof backofficeWhatsappWebhookDetailSchema
>;
export type DiagnosticJobAttemptDto = z.infer<
  typeof diagnosticJobAttemptSchema
>;
export type DiagnosticJobAttemptListQueryDto = z.infer<
  typeof diagnosticJobAttemptListQuerySchema
>;
export type DiagnosticIntegrationLogDto = z.infer<
  typeof diagnosticIntegrationLogSchema
>;
export type DiagnosticIntegrationLogListQueryDto = z.infer<
  typeof diagnosticIntegrationLogListQuerySchema
>;
export type DiagnosticConversionEventLogDto = z.infer<
  typeof diagnosticConversionEventLogSchema
>;
export type DiagnosticConversionEventLogListQueryDto = z.infer<
  typeof diagnosticConversionEventLogListQuerySchema
>;
export type DiagnosticAuditLogDto = z.infer<typeof diagnosticAuditLogSchema>;
export type DiagnosticAuditLogListQueryDto = z.infer<
  typeof diagnosticAuditLogListQuerySchema
>;
export type DiagnosticTimelineItemDto = z.infer<
  typeof diagnosticTimelineItemSchema
>;
export type DiagnosticEventDetailDto = z.infer<
  typeof diagnosticEventDetailSchema
>;
export type DiagnosticRetryInputDto = z.infer<
  typeof diagnosticRetryInputSchema
>;
export type DiagnosticRetryResultDto = z.infer<
  typeof diagnosticRetryResultSchema
>;
export type DiagnosticConversionEventTestInputDto = z.infer<
  typeof diagnosticConversionEventTestInputSchema
>;
