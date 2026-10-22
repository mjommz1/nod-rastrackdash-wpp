-- One durable winner per sale (seller + order + event) and effect mode.
-- Additive: new table only; existing rows are untouched.
CREATE TABLE "ProviderPurchaseClaim" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "purchaseKey" TEXT NOT NULL,
    "effectMode" TEXT NOT NULL,
    "winnerExecutionId" TEXT NOT NULL,
    "conversionEventLogId" TEXT,
    "outboxPending" BOOLEAN NOT NULL DEFAULT false,
    "outboxNextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderPurchaseClaim_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProviderPurchaseClaim_outbox_recovery_idx" ON "ProviderPurchaseClaim"("outboxPending", "outboxNextAttemptAt", "createdAt");

CREATE UNIQUE INDEX "ProviderPurchaseClaim_identity_key" ON "ProviderPurchaseClaim"("workspaceId", "effectMode", "purchaseKey");

ALTER TABLE "ProviderPurchaseClaim" ADD CONSTRAINT "ProviderPurchaseClaim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProviderPurchaseClaim" ADD CONSTRAINT "ProviderPurchaseClaim_workspaceId_winnerExecutionId_fkey" FOREIGN KEY ("workspaceId", "winnerExecutionId") REFERENCES "ProviderConversionRuleExecution"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProviderPurchaseClaim" ADD CONSTRAINT "ProviderPurchaseClaim_workspaceId_conversionEventLogId_fkey" FOREIGN KEY ("workspaceId", "conversionEventLogId") REFERENCES "ConversionEventLog"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Separate audit/send namespaces; only production claims own a durable send handoff.
ALTER TABLE "ProviderPurchaseClaim" ADD CONSTRAINT "ProviderPurchaseClaim_effect_check"
CHECK (("effectMode" = 'observation' AND "conversionEventLogId" IS NULL AND NOT "outboxPending")
    OR ("effectMode" = 'production' AND "conversionEventLogId" IS NOT NULL));
ALTER TABLE "ProviderPurchaseClaim" ADD CONSTRAINT "ProviderPurchaseClaim_key_check"
CHECK ("purchaseKey" ~ '^purchase:[a-f0-9]{64}$');
