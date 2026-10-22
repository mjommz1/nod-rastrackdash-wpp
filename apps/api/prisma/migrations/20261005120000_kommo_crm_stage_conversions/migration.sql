-- Additive only. Do not apply from this change set; deployment owns migration execution.
-- Compatibility gate: the new RESTRICT Kommo records can prevent an existing
-- client/workspace wipe. Do not extend destructive client-swap behavior here;
-- retention and dedupe-wipe semantics require separate human authorization.
ALTER TYPE "DiagnosticSource" ADD VALUE IF NOT EXISTS 'kommo';

CREATE TABLE "KommoConnection" (
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
  "catalogState" TEXT NOT NULL DEFAULT 'empty',
  "catalogRefreshedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "webhookSecretHash" TEXT NOT NULL,
  "webhookSecretVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KommoConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KommoConnection_webhookSecretHash_key" ON "KommoConnection"("webhookSecretHash");
CREATE UNIQUE INDEX "KommoConnection_workspaceId_verifiedAccountId_key" ON "KommoConnection"("workspaceId", "verifiedAccountId");
CREATE INDEX "KommoConnection_workspaceId_status_idx" ON "KommoConnection"("workspaceId", "status");

CREATE TABLE "KommoPipelineCatalog" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "pipelineId" TEXT NOT NULL,
  "pipelineName" TEXT NOT NULL,
  "pipelineSort" INTEGER,
  "statusId" TEXT NOT NULL,
  "statusName" TEXT NOT NULL,
  "statusType" TEXT,
  "available" BOOLEAN NOT NULL DEFAULT true,
  "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KommoPipelineCatalog_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KommoPipelineCatalog_connectionId_pipelineId_statusId_key" ON "KommoPipelineCatalog"("connectionId", "pipelineId", "statusId");
CREATE INDEX "KommoPipelineCatalog_connectionId_available_idx" ON "KommoPipelineCatalog"("connectionId", "available");
CREATE INDEX "KommoPipelineCatalog_workspaceId_connectionId_idx" ON "KommoPipelineCatalog"("workspaceId", "connectionId");

CREATE TABLE "KommoConversionRule" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "pipelineId" TEXT NOT NULL,
  "statusId" TEXT NOT NULL,
  "eventName" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'observation',
  "valueMode" TEXT NOT NULL DEFAULT 'lead_price',
  "fixedValueCents" INTEGER,
  "currency" TEXT,
  "contentName" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KommoConversionRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KommoConversionRule_connectionId_pipelineId_statusId_eventName_key" ON "KommoConversionRule"("connectionId", "pipelineId", "statusId", "eventName");
CREATE INDEX "KommoConversionRule_workspaceId_connectionId_active_idx" ON "KommoConversionRule"("workspaceId", "connectionId", "active");

CREATE TABLE "KommoWebhookEvent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "verifiedAccountId" TEXT NOT NULL,
  "credentialGeneration" INTEGER NOT NULL DEFAULT 1,
  "deliveryKey" TEXT NOT NULL,
  "dealId" TEXT NOT NULL,
  "pipelineId" TEXT NOT NULL,
  "statusId" TEXT NOT NULL,
  "oldStatusId" TEXT,
  "eventOccurredAt" TIMESTAMP(3) NOT NULL,
  "eventPriceCents" INTEGER,
  "eventPricePresent" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'accepted',
  "errorCode" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "jobId" TEXT,
  "matchedLeadId" TEXT,
  "conversionEventLogId" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KommoWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KommoWebhookEvent_deliveryKey_key" ON "KommoWebhookEvent"("deliveryKey");
CREATE INDEX "KommoWebhookEvent_workspaceId_status_createdAt_idx" ON "KommoWebhookEvent"("workspaceId", "status", "createdAt");
CREATE INDEX "KommoWebhookEvent_connectionId_dealId_idx" ON "KommoWebhookEvent"("connectionId", "dealId");

CREATE TABLE "KommoConversionDedupe" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "verifiedAccountId" TEXT NOT NULL,
  "dealId" TEXT NOT NULL,
  "eventName" TEXT NOT NULL,
  "sourceEventId" TEXT NOT NULL,
  "conversionEventLogId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KommoConversionDedupe_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KommoConversionDedupe_workspaceId_verifiedAccountId_dealId_eventName_key" ON "KommoConversionDedupe"("workspaceId", "verifiedAccountId", "dealId", "eventName");
CREATE INDEX "KommoConversionDedupe_workspaceId_sourceEventId_idx" ON "KommoConversionDedupe"("workspaceId", "sourceEventId");

ALTER TABLE "KommoConnection" ADD CONSTRAINT "KommoConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KommoPipelineCatalog" ADD CONSTRAINT "KommoPipelineCatalog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KommoPipelineCatalog" ADD CONSTRAINT "KommoPipelineCatalog_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "KommoConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KommoConversionRule" ADD CONSTRAINT "KommoConversionRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KommoConversionRule" ADD CONSTRAINT "KommoConversionRule_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "KommoConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KommoWebhookEvent" ADD CONSTRAINT "KommoWebhookEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KommoWebhookEvent" ADD CONSTRAINT "KommoWebhookEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "KommoConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KommoConversionDedupe" ADD CONSTRAINT "KommoConversionDedupe_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
