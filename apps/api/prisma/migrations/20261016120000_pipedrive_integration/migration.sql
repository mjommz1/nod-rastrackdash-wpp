-- Pipedrive CRM integration (Fase 4c, consolidated, additive only).
-- Creates six new tables (PipedriveConnection, PipedrivePipelineCatalog,
-- PipedriveStageCatalog, PipedriveConversionRule, PipedriveWebhookEvent,
-- PipedriveConversionDedupe) with their indexes and constraints. No existing
-- table, column, index, constraint or enum is altered or dropped, and no row
-- is written. New FKs are RESTRICT to Workspace/Lead/ConversionEventLog; the
-- backoffice workspace removal and the FK-safe workspace removal script in apps/api/scripts
-- remove these rows first. Uses the ConversionEventLog (workspaceId, id) key
-- created by 20261016090000_conversion_event_log_workspace_id_key.

-- CreateTable
CREATE TABLE "PipedriveConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'blocked',
    "accountOrigin" TEXT NOT NULL,
    "verifiedAccountId" TEXT,
    "accountSubdomain" TEXT,
    "accessTokenEncrypted" TEXT NOT NULL,
    "accessTokenIv" TEXT NOT NULL,
    "accessTokenTag" TEXT NOT NULL,
    "credentialHealthy" BOOLEAN NOT NULL DEFAULT false,
    "credentialGeneration" INTEGER NOT NULL DEFAULT 1,
    "allowedChannelRouteIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "credentialActivatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "webhookSecretHash" TEXT,
    "webhookSecretVersion" INTEGER NOT NULL DEFAULT 0,
    "webhookIssuedAt" TIMESTAMP(3),
    "webhookRateWindowAt" TIMESTAMP(3),
    "webhookRateCount" INTEGER NOT NULL DEFAULT 0,
    "webhookLastReceivedAt" TIMESTAMP(3),
    "mutationRevision" INTEGER NOT NULL DEFAULT 0,
    "catalogState" TEXT NOT NULL DEFAULT 'empty',
    "catalogRefreshedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipedriveConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipedrivePipelineCatalog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "pipelineName" TEXT NOT NULL,
    "pipelineSort" INTEGER,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipedrivePipelineCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipedriveStageCatalog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "stageName" TEXT NOT NULL,
    "stageSort" INTEGER,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipedriveStageCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipedriveConversionRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'stage_change',
    "pipelineId" TEXT NOT NULL,
    "stageId" TEXT,
    "eventName" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'observation',
    "productionActivatedAt" TIMESTAMP(3),
    "valueMode" TEXT NOT NULL DEFAULT 'deal',
    "fixedValueCents" INTEGER,
    "currency" TEXT,
    "contentName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipedriveConversionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipedriveWebhookEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "deliveryKey" TEXT NOT NULL,
    "verifiedAccountId" TEXT NOT NULL,
    "accountSubdomain" TEXT NOT NULL,
    "credentialGeneration" INTEGER NOT NULL,
    "webhookSecretVersion" INTEGER NOT NULL,
    "changeKind" TEXT NOT NULL DEFAULT 'ignored',
    "dealId" TEXT,
    "pipelineId" TEXT,
    "stageId" TEXT,
    "oldStageId" TEXT,
    "dealStatus" TEXT,
    "previousDealStatus" TEXT,
    "personId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "valueCents" BIGINT,
    "valuePresent" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "errorCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "matchedLeadId" TEXT,
    "matchedRouteId" TEXT,
    "results" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipedriveWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipedriveConversionDedupe" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "verifiedAccountId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'observation',
    "sourceEventId" TEXT NOT NULL,
    "conversionEventLogId" TEXT,
    "publicationIntent" JSONB,
    "publicationStatus" TEXT NOT NULL DEFAULT 'observed',
    "publicationAttempts" INTEGER NOT NULL DEFAULT 0,
    "publicationNextAttemptAt" TIMESTAMP(3),
    "publicationLeaseToken" TEXT,
    "publicationLeaseExpiresAt" TIMESTAMP(3),
    "publicationErrorCode" TEXT,
    "senderAttempts" INTEGER NOT NULL DEFAULT 0,
    "senderRetryable" BOOLEAN NOT NULL DEFAULT false,
    "senderLeaseToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipedriveConversionDedupe_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PipedriveConnection_webhookSecretHash_key" ON "PipedriveConnection"("webhookSecretHash");

-- CreateIndex
CREATE INDEX "PipedriveConnection_workspaceId_status_idx" ON "PipedriveConnection"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PipedriveConnection_id_workspaceId_key" ON "PipedriveConnection"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PipedriveConnection_workspaceId_verifiedAccountId_key" ON "PipedriveConnection"("workspaceId", "verifiedAccountId");

-- CreateIndex
CREATE INDEX "PipedrivePipelineCatalog_workspaceId_connectionId_idx" ON "PipedrivePipelineCatalog"("workspaceId", "connectionId");

-- CreateIndex
CREATE INDEX "PipedrivePipelineCatalog_connectionId_available_idx" ON "PipedrivePipelineCatalog"("connectionId", "available");

-- CreateIndex
CREATE UNIQUE INDEX "PipedrivePipelineCatalog_connectionId_pipelineId_key" ON "PipedrivePipelineCatalog"("connectionId", "pipelineId");

-- CreateIndex
CREATE UNIQUE INDEX "PipedrivePipelineCatalog_connectionId_workspaceId_pipelineI_key" ON "PipedrivePipelineCatalog"("connectionId", "workspaceId", "pipelineId");

-- CreateIndex
CREATE INDEX "PipedriveStageCatalog_workspaceId_connectionId_idx" ON "PipedriveStageCatalog"("workspaceId", "connectionId");

-- CreateIndex
CREATE INDEX "PipedriveStageCatalog_connectionId_pipelineId_available_idx" ON "PipedriveStageCatalog"("connectionId", "pipelineId", "available");

-- CreateIndex
CREATE UNIQUE INDEX "PipedriveStageCatalog_connectionId_pipelineId_stageId_key" ON "PipedriveStageCatalog"("connectionId", "pipelineId", "stageId");

-- CreateIndex
CREATE INDEX "PipedriveConversionRule_workspaceId_connectionId_active_idx" ON "PipedriveConversionRule"("workspaceId", "connectionId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "PipedriveConversionRule_connectionId_pipelineId_stageId_eve_key" ON "PipedriveConversionRule"("connectionId", "pipelineId", "stageId", "eventName");

-- CreateIndex
CREATE INDEX "PipedriveWebhookEvent_status_nextAttemptAt_leaseExpiresAt_idx" ON "PipedriveWebhookEvent"("status", "nextAttemptAt", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "PipedriveWebhookEvent_workspaceId_connectionId_createdAt_idx" ON "PipedriveWebhookEvent"("workspaceId", "connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "PipedriveWebhookEvent_workspaceId_verifiedAccountId_dealId__idx" ON "PipedriveWebhookEvent"("workspaceId", "verifiedAccountId", "dealId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "PipedriveWebhookEvent_connectionId_deliveryKey_key" ON "PipedriveWebhookEvent"("connectionId", "deliveryKey");

-- CreateIndex
CREATE UNIQUE INDEX "PipedriveWebhookEvent_id_workspaceId_verifiedAccountId_deal_key" ON "PipedriveWebhookEvent"("id", "workspaceId", "verifiedAccountId", "dealId");

-- CreateIndex
CREATE INDEX "PipedriveConversionDedupe_workspaceId_sourceEventId_idx" ON "PipedriveConversionDedupe"("workspaceId", "sourceEventId");

-- CreateIndex
CREATE INDEX "PipedriveConversionDedupe_publication_idx" ON "PipedriveConversionDedupe"("publicationStatus", "publicationNextAttemptAt");

-- CreateIndex
CREATE INDEX "PipedriveConversionDedupe_conversion_idx" ON "PipedriveConversionDedupe"("workspaceId", "conversionEventLogId");

-- CreateIndex
CREATE UNIQUE INDEX "PipedriveConversionDedupe_semantic_mode_key" ON "PipedriveConversionDedupe"("workspaceId", "verifiedAccountId", "dealId", "eventName", "mode");

-- AddForeignKey
ALTER TABLE "PipedriveConnection" ADD CONSTRAINT "PipedriveConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PipedrivePipelineCatalog" ADD CONSTRAINT "PipedrivePipelineCatalog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PipedrivePipelineCatalog" ADD CONSTRAINT "PipedrivePipelineCatalog_connectionId_workspaceId_fkey" FOREIGN KEY ("connectionId", "workspaceId") REFERENCES "PipedriveConnection"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PipedriveStageCatalog" ADD CONSTRAINT "PipedriveStageCatalog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PipedriveStageCatalog" ADD CONSTRAINT "PipedriveStageCatalog_connectionId_workspaceId_pipelineId_fkey" FOREIGN KEY ("connectionId", "workspaceId", "pipelineId") REFERENCES "PipedrivePipelineCatalog"("connectionId", "workspaceId", "pipelineId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PipedriveConversionRule" ADD CONSTRAINT "PipedriveConversionRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PipedriveConversionRule" ADD CONSTRAINT "PipedriveConversionRule_connectionId_workspaceId_fkey" FOREIGN KEY ("connectionId", "workspaceId") REFERENCES "PipedriveConnection"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PipedriveWebhookEvent" ADD CONSTRAINT "PipedriveWebhookEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PipedriveWebhookEvent" ADD CONSTRAINT "PipedriveWebhookEvent_connectionId_workspaceId_fkey" FOREIGN KEY ("connectionId", "workspaceId") REFERENCES "PipedriveConnection"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PipedriveWebhookEvent" ADD CONSTRAINT "PipedriveWebhookEvent_workspaceId_matchedLeadId_fkey" FOREIGN KEY ("workspaceId", "matchedLeadId") REFERENCES "Lead"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PipedriveConversionDedupe" ADD CONSTRAINT "PipedriveConversionDedupe_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PipedriveConversionDedupe" ADD CONSTRAINT "PipedriveConversionDedupe_sourceEventId_workspaceId_verifi_fkey" FOREIGN KEY ("sourceEventId", "workspaceId", "verifiedAccountId", "dealId") REFERENCES "PipedriveWebhookEvent"("id", "workspaceId", "verifiedAccountId", "dealId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PipedriveConversionDedupe" ADD CONSTRAINT "PipedriveConversionDedupe_workspaceId_conversionEventLogId_fkey" FOREIGN KEY ("workspaceId", "conversionEventLogId") REFERENCES "ConversionEventLog"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Partial unique index: one won-deal rule per connection + pipeline + event
-- (stage rules are already unique by the composite key above).
CREATE UNIQUE INDEX "PipedriveConversionRule_deal_won_key" ON "PipedriveConversionRule"("connectionId", "pipelineId", "eventName") WHERE "trigger" = 'deal_won';

-- SQL-only CHECK constraints complement the Prisma scalar types.
ALTER TABLE "PipedriveConnection" ADD CONSTRAINT "PipedriveConnection_credentialGeneration_check" CHECK ("credentialGeneration" > 0);
ALTER TABLE "PipedriveConnection" ADD CONSTRAINT "PipedriveConnection_status_check" CHECK ("status" IN ('active', 'paused', 'blocked'));
ALTER TABLE "PipedriveConnection" ADD CONSTRAINT "PipedriveConnection_catalogState_check" CHECK ("catalogState" IN ('empty', 'fresh', 'stale', 'error'));
ALTER TABLE "PipedriveConnection" ADD CONSTRAINT "PipedriveConnection_revision_check" CHECK ("mutationRevision" >= 0);
ALTER TABLE "PipedriveConnection" ADD CONSTRAINT "PipedriveConnection_webhook_check" CHECK (
  "webhookSecretVersion" >= 0 AND "webhookRateCount" >= 0 AND
  (("webhookSecretHash" IS NULL AND "webhookIssuedAt" IS NULL) OR
   ("webhookSecretHash" ~ '^[a-f0-9]{64}$' AND "webhookIssuedAt" IS NOT NULL))
);
ALTER TABLE "PipedriveConversionRule" ADD CONSTRAINT "PipedriveConversionRule_trigger_check" CHECK (
  ("trigger" = 'stage_change' AND "stageId" IS NOT NULL) OR
  ("trigger" = 'deal_won' AND "stageId" IS NULL AND "eventName" = 'Purchase')
);
ALTER TABLE "PipedriveConversionRule" ADD CONSTRAINT "PipedriveConversionRule_mode_check" CHECK (
  "mode" IN ('observation', 'production') AND
  ("mode" <> 'observation' OR "productionActivatedAt" IS NULL) AND
  ("mode" <> 'production' OR NOT "active" OR "productionActivatedAt" IS NOT NULL)
);
ALTER TABLE "PipedriveConversionRule" ADD CONSTRAINT "PipedriveConversionRule_value_check" CHECK (
  "valueMode" IN ('deal', 'fixed') AND ("fixedValueCents" IS NULL OR "fixedValueCents" > 0) AND
  ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$') AND
  ("valueMode" <> 'fixed' OR ("fixedValueCents" IS NOT NULL AND "currency" IS NOT NULL))
);
ALTER TABLE "PipedriveConversionRule" ADD CONSTRAINT "PipedriveConversionRule_event_check" CHECK ("eventName" IN ('LeadSubmitted', 'QualifiedLead', 'OrderShipped', 'OrderDelivered', 'OrderCanceled', 'OrderReturned', 'RatingProvided', 'ReviewProvided', 'ViewContent', 'AddToCart', 'CartAbandoned', 'InitiateCheckout', 'Purchase', 'OrderCreated'));
ALTER TABLE "PipedriveWebhookEvent" ADD CONSTRAINT "PipedriveWebhookEvent_state_check" CHECK (
  "status" IN ('received', 'processing', 'retry', 'observed', 'materialized', 'duplicate', 'ignored', 'failed') AND
  "changeKind" IN ('stage_change', 'deal_won', 'deal_lost', 'ignored') AND
  "attempts" >= 0 AND "credentialGeneration" > 0 AND "webhookSecretVersion" > 0 AND
  (("status" = 'processing' AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL) OR
   ("status" <> 'processing' AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)) AND
  ("status" NOT IN ('received', 'retry') OR "nextAttemptAt" IS NOT NULL) AND
  ("changeKind" NOT IN ('deal_lost', 'ignored') OR "status" = 'ignored') AND
  ("valuePresent" = ("valueCents" IS NOT NULL))
);
ALTER TABLE "PipedriveConversionDedupe" ADD CONSTRAINT "PipedriveConversionDedupe_event_check" CHECK ("eventName" IN ('LeadSubmitted', 'QualifiedLead', 'OrderShipped', 'OrderDelivered', 'OrderCanceled', 'OrderReturned', 'RatingProvided', 'ReviewProvided', 'ViewContent', 'AddToCart', 'CartAbandoned', 'InitiateCheckout', 'Purchase', 'OrderCreated'));
ALTER TABLE "PipedriveConversionDedupe" ADD CONSTRAINT "PipedriveConversionDedupe_publication_check" CHECK (
  "mode" IN ('observation', 'production') AND "publicationAttempts" >= 0 AND
  "senderAttempts" IN (0, 1) AND NOT "senderRetryable" AND
  (("publicationLeaseToken" IS NULL) = ("publicationLeaseExpiresAt" IS NULL)) AND
  ("senderLeaseToken" IS NULL OR "senderAttempts" = 1) AND
  (("mode" = 'observation' AND "conversionEventLogId" IS NULL AND "publicationIntent" IS NULL AND "publicationStatus" = 'observed' AND "senderAttempts" = 0) OR
   ("mode" = 'production' AND "conversionEventLogId" IS NOT NULL AND "publicationIntent" IS NOT NULL AND jsonb_typeof("publicationIntent") = 'object' AND
    "publicationStatus" IN ('materialized', 'publication_pending', 'queued', 'sent', 'revoked', 'publication_failed', 'delivery_unknown')))
);
