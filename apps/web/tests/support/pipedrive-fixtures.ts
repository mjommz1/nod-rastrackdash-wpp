import type { InboundWebhookChannelDto } from "@wpptrack/shared";
import type {
  PipedriveCapabilitiesDto,
  PipedriveConnectionDetailDto,
  PipedriveConversionRuleDto,
  PipedriveEventDto,
  PipedriveEventResultDto,
} from "../../src/app/(app)/integrations/pipedrive-actions";

// Synthetic fixtures only: none of these payloads came from a real Pipedrive account.

export const eligibleChannel = {
  id: "channel_1",
  connectionId: "connection_1",
  organizationId: "organization_1",
  providerChannelId: "provider_channel_1",
  connectedPhone: "+5511999990000",
  channelName: "Comercial",
  whatsappInstanceId: null,
  status: "active",
  productionActivatedAt: "2026-07-01T00:00:00.000Z",
  firstSeenAt: "2026-07-21T10:00:00.000Z",
  lastSeenAt: "2026-07-21T11:00:00.000Z",
  routes: [
    {
      id: "route_1",
      channelId: "channel_1",
      metaBusinessConnectionId: "business_1",
      metaReportingAccountId: "reporting_1",
      metaConversionDestinationId: "destination_1",
      active: true,
      validationStatus: "valid",
      validationErrorCode: null,
      lastValidatedAt: "2026-07-21T11:00:00.000Z",
      createdAt: "2026-07-21T10:00:00.000Z",
      updatedAt: "2026-07-21T11:00:00.000Z",
    },
    {
      id: "route_2",
      channelId: "channel_1",
      metaBusinessConnectionId: "business_1",
      metaReportingAccountId: "reporting_1",
      metaConversionDestinationId: "destination_2",
      active: true,
      validationStatus: "valid",
      validationErrorCode: null,
      lastValidatedAt: "2026-07-21T11:00:00.000Z",
      createdAt: "2026-07-21T10:00:00.000Z",
      updatedAt: "2026-07-21T11:00:00.000Z",
    },
  ],
  readiness: {
    state: "ready",
    blockers: [],
    routeCount: 2,
    validRouteCount: 2,
    totalCtwa: 1,
    routedCtwa: 1,
    unresolvedCtwa: 0,
    retainedCtwa: 1,
    retainedRoutedCtwa: 1,
    payloadUnavailableCtwa: 0,
    alreadyMaterializedCtwa: 0,
    nextPayloadExpiresAt: null,
  },
  createdAt: "2026-07-21T10:00:00.000Z",
  updatedAt: "2026-07-21T11:00:00.000Z",
} satisfies InboundWebhookChannelDto;

export const pipelines = [
  {
    id: "pipeline_1",
    name: "Vendas",
    sort: 1,
    stages: [
      { id: "stage_1", name: "Qualificado", sort: 1 },
      { id: "stage_2", name: "Proposta enviada", sort: 2 },
      { id: "stage_3", name: "Ganho", sort: 3 },
    ],
  },
  {
    id: "pipeline_2",
    name: "Pos-venda",
    sort: 2,
    stages: [{ id: "stage_9", name: "Renovacao", sort: 1 }],
  },
];

export const baseRule = {
  id: "rule_1",
  connectionId: "pipedrive_connection_1",
  name: "Ganho do negócio",
  pipelineId: "pipeline_1",
  trigger: "stage_change",
  stageId: "stage_3",
  eventName: "Purchase",
  mode: "observation",
  productionActivatedAt: null,
  valueMode: "deal",
  fixedValueCents: null,
  currency: "BRL",
  contentName: null,
  active: true,
  createdAt: "2026-10-11T10:00:00.000Z",
  updatedAt: "2026-10-11T10:00:00.000Z",
} satisfies PipedriveConversionRuleDto;

export const baseConnection = {
  id: "pipedrive_connection_1",
  workspaceId: "workspace_1",
  displayName: "Pipedrive principal",
  status: "active",
  verifiedAccountId: "account_1",
  accountSubdomain: "suaempresa",
  accountOrigin: "https://suaempresa.pipedrive.com",
  allowedChannelRouteIds: ["route_1"],
  credentialHealthy: true,
  catalogState: "fresh",
  catalogRefreshedAt: "2026-10-11T09:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-10-11T08:00:00.000Z",
  updatedAt: "2026-10-11T09:00:00.000Z",
  pipelines,
  rules: [],
} satisfies PipedriveConnectionDetailDto;

export function connectionWith(
  overrides: Partial<PipedriveConnectionDetailDto> = {},
): PipedriveConnectionDetailDto {
  return { ...baseConnection, ...overrides } as PipedriveConnectionDetailDto;
}

export function snapshotOf(connection: PipedriveConnectionDetailDto) {
  const { rules: _rules, ...snapshot } = connection;
  return snapshot;
}

export function ruleWith(overrides: Partial<PipedriveConversionRuleDto> = {}) {
  return { ...baseRule, ...overrides } as PipedriveConversionRuleDto;
}

export const PRODUCTION_ACTIVATED_AT = "2026-10-11T12:00:00.000Z";

export function productionRuleWith(overrides: Partial<PipedriveConversionRuleDto> = {}) {
  return ruleWith({
    mode: "production",
    productionActivatedAt: PRODUCTION_ACTIVATED_AT,
    ...overrides,
  });
}

/** A connection shaped like the current backend: revision + secret-free webhook metadata. */
export function revisionedConnectionWith(
  overrides: Partial<PipedriveConnectionDetailDto> = {},
): PipedriveConnectionDetailDto {
  return connectionWith({
    mutationRevision: 5,
    webhook: {
      configured: true,
      version: 2,
      rotatedAt: "2026-10-11T09:30:00.000Z",
      lastReceivedAt: "2026-10-11T11:00:00.000Z",
    },
    revisionFenced: true,
    ...overrides,
  });
}

export const capabilitiesEnabled = {
  productionEnabled: true,
  activationRequirements: [
    "verified_account",
    "fresh_catalog",
    "configured_webhook",
    "authorized_certified_channel",
    "existing_lead_attribution",
  ],
  historicalReplay: false,
  unknownDeliveryRetry: false,
} satisfies PipedriveCapabilitiesDto;

export const capabilitiesDisabled = {
  ...capabilitiesEnabled,
  productionEnabled: false,
} satisfies PipedriveCapabilitiesDto;

export function resultWith(
  overrides: Partial<PipedriveEventResultDto> = {},
): PipedriveEventResultDto {
  return {
    ruleId: "rule_1",
    eventName: "Purchase",
    status: "observed",
    valueCents: null,
    currency: null,
    errorCode: null,
    conversionEventLogId: null,
    deliveryStatus: null,
    deliveryErrorCode: null,
    deliveryRetryable: false,
    ...overrides,
  };
}

export function eventWith(overrides: Partial<PipedriveEventDto> = {}): PipedriveEventDto {
  return {
    id: "event_1",
    status: "observed",
    errorCode: null,
    attempts: 1,
    occurredAt: "2026-10-11T11:00:00.000Z",
    createdAt: "2026-10-11T11:00:01.000Z",
    nextAttemptAt: null,
    results: [],
    ...overrides,
  };
}

export const SYNTHETIC_WEBHOOK_URL =
  "https://synthetic.invalid/webhooks/pipedrive/SYNTHETIC-SECRET-1";
