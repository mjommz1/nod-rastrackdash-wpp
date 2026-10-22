import type { DiagnosticSourceDto } from "@wpptrack/shared";

export const DIAGNOSTIC_QUEUE = "diagnostic-events";
export const CONVERSION_EVENTS_QUEUE = "conversion-events";
export const META_REPORT_SYNC_QUEUE = "meta-report-sync";
export const EXTERNAL_DATA_SYNC_QUEUE = "external-data-sync";
export const INBOUND_WEBHOOK_QUEUE = "inbound-webhooks";
export const INBOUND_WEBHOOK_REPLAY_QUEUE = "inbound-webhook-replay";
export const INBOUND_WEBHOOK_PRODUCTION_QUEUE = "inbound-webhook-production";
export const OPS_ALERTS_QUEUE = "ops-alerts";
export const KOMMO_WEBHOOK_QUEUE = "kommo-webhooks";

export interface InboundWebhookJobPayload {
  deliveryId: string;
  connectionId: string;
  workspaceId: string;
  forceProviderConversions?: boolean;
}

export interface InboundWebhookReplayJobPayload {
  batchId: string;
  workspaceId: string;
}

export interface KommoWebhookJobPayload {
  eventId: string;
  workspaceId: string;
}

export interface InboundWebhookProductionJobPayload {
  productionItemId: string;
  workspaceId: string;
}

export interface ProviderConversionProductionJobPayload {
  providerConversionExecutionId: string;
  workspaceId: string;
}

export type InboundWebhookProductionQueueJobPayload =
  InboundWebhookProductionJobPayload | ProviderConversionProductionJobPayload;

export interface DiagnosticJobPayload {
  diagnosticEventId: string;
  workspaceId: string;
  source: DiagnosticSourceDto;
  message: string;
  occurredAt: string;
  conversionEventLogId?: string;
  retryReason?: string;
}

export interface ConversionEventJobPayload {
  conversionEventLogId: string;
  workspaceId: string;
}

export interface MetaReportSyncJobPayload {
  workspaceId: string;
  businessConnectionId: string | null;
  reportingAccountId: string | null;
  since: string;
  until: string;
}

export interface ExternalDataSyncJobPayload {
  connectorId: string;
  workspaceId: string;
  streams: Array<"leads" | "events">;
  projectionRefresh?: boolean;
  requestedByUserId?: string;
}
