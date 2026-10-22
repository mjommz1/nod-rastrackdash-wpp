-- Fase 5.3: URL única por plataforma (Payt) e URL por evento (Unnichat e
-- Umbler). Só acrescenta:
--   * um tipo novo (IntegrationEndpointKind) e duas tabelas novas
--     (IntegrationEndpoint, IntegrationEndpointEvent) com índices e FKs;
--   * três colunas opcionais em tabelas existentes, todas sem regravar linhas:
--       ProviderConversionRuleConfig.productFilterCodes (vazio = qualquer
--         produto, que é o comportamento de hoje),
--       ProviderConversionRuleEndpoint.publicUrlDisabledAt (NULL = a URL
--         antiga da regra continua recebendo, como hoje),
--       InboundWebhookDelivery.integrationEndpointWorkspaceId/Id (NULL para
--         tudo o que chegou pela URL antiga).
-- Nenhuma coluna, índice, constraint ou linha existente é alterada ou
-- removida. As FKs novas para Workspace são RESTRICT: a exclusão de
-- workspace (backoffice e scripts/delete-workspace.js) apaga estas linhas
-- antes. Reexecutável: cada passo confere se já existe.

DO $$
BEGIN
  CREATE TYPE "IntegrationEndpointKind" AS ENUM ('sales_platform', 'automation_event');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Padrões constantes: no PostgreSQL 11+ só mudam o catálogo.
ALTER TABLE "ProviderConversionRuleConfig"
  ADD COLUMN IF NOT EXISTS "productFilterCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "ProviderConversionRuleEndpoint"
  ADD COLUMN IF NOT EXISTS "publicUrlDisabledAt" TIMESTAMP(3);

ALTER TABLE "InboundWebhookDelivery"
  ADD COLUMN IF NOT EXISTS "integrationEndpointWorkspaceId" TEXT,
  ADD COLUMN IF NOT EXISTS "integrationEndpointId" TEXT;

-- Uma linha por URL (viva ou removida). O token nunca fica em claro: hash
-- para comparar e cópia cifrada para "Mostrar URL" (auditado).
CREATE TABLE IF NOT EXISTS "IntegrationEndpoint" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "InboundWebhookProvider" NOT NULL,
    "kind" "IntegrationEndpointKind" NOT NULL,
    "eventName" TEXT,
    "parserReleaseId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "secretIv" TEXT NOT NULL,
    "secretTag" TEXT NOT NULL,
    "secretKeyVersion" INTEGER NOT NULL,
    "secretVersion" INTEGER NOT NULL DEFAULT 1,
    "lastDeliveryAt" TIMESTAMP(3),
    "lastRoutedAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IntegrationEndpoint_pkey" PRIMARY KEY ("id"),
    -- Plataforma de venda não tem evento fixo; URL de automação sempre tem.
    CONSTRAINT "IntegrationEndpoint_kind_event_check"
      CHECK (("kind" = 'sales_platform') = ("eventName" IS NULL))
);

-- Recibo de cada evento recebido por uma URL única: idempotente por
-- (URL, chave de entrada), com produto, destino ou motivo. O corpo cifrado
-- some no prazo dos payloads; recibos não roteados somem em 60 dias.
CREATE TABLE IF NOT EXISTS "IntegrationEndpointEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "integrationEndpointId" TEXT NOT NULL,
    "provider" "InboundWebhookProvider" NOT NULL,
    "ingressKey" TEXT NOT NULL,
    "externalKey" TEXT,
    "eventName" TEXT,
    "providerStatus" TEXT,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT,
    "productCode" TEXT,
    "productName" TEXT,
    "offerCode" TEXT,
    "offerName" TEXT,
    "valueCents" INTEGER,
    "currency" TEXT,
    "contactIdentityHash" TEXT,
    "occurredAt" TIMESTAMP(3),
    "firstReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "routedProviderRuleId" TEXT,
    "routedDeliveryId" TEXT,
    "routedChannelId" TEXT,
    "routingOutcome" TEXT,
    "encryptedPayload" TEXT,
    "payloadIv" TEXT,
    "payloadTag" TEXT,
    "encryptionKeyVersion" INTEGER,
    "payloadExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IntegrationEndpointEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IntegrationEndpointEvent_status_check"
      CHECK ("status" IN ('pending', 'routed', 'unattributed', 'ignored', 'invalid'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationEndpoint_workspaceId_id_key"
  ON "IntegrationEndpoint"("workspaceId", "id");
CREATE INDEX IF NOT EXISTS "IntegrationEndpoint_workspaceId_provider_removedAt_idx"
  ON "IntegrationEndpoint"("workspaceId", "provider", "removedAt");
CREATE INDEX IF NOT EXISTS "IntegrationEndpoint_parserReleaseId_idx"
  ON "IntegrationEndpoint"("parserReleaseId");
CREATE INDEX IF NOT EXISTS "IntegrationEndpoint_createdByUserId_idx"
  ON "IntegrationEndpoint"("createdByUserId");
-- Uma URL viva por workspace + plataforma + evento (evento vazio = a URL da
-- plataforma de venda). URLs removidas continuam no histórico.
CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationEndpoint_live_key"
  ON "IntegrationEndpoint"("workspaceId", "provider", COALESCE("eventName", ''))
  WHERE "removedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationEndpointEvent_workspaceId_id_key"
  ON "IntegrationEndpointEvent"("workspaceId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationEndpointEvent_endpoint_ingress_key"
  ON "IntegrationEndpointEvent"("integrationEndpointId", "ingressKey");
CREATE INDEX IF NOT EXISTS "IntegrationEndpointEvent_workspaceId_status_lastReceivedAt_idx"
  ON "IntegrationEndpointEvent"("workspaceId", "status", "lastReceivedAt");
CREATE INDEX IF NOT EXISTS "IntegrationEndpointEvent_workspaceId_provider_productCode_idx"
  ON "IntegrationEndpointEvent"("workspaceId", "provider", "productCode");
CREATE INDEX IF NOT EXISTS "IntegrationEndpointEvent_payloadExpiresAt_idx"
  ON "IntegrationEndpointEvent"("payloadExpiresAt");

CREATE INDEX IF NOT EXISTS "InboundWebhookDelivery_integrationEndpointId_idx"
  ON "InboundWebhookDelivery"("integrationEndpointId");

DO $$
BEGIN
  ALTER TABLE "IntegrationEndpoint"
    ADD CONSTRAINT "IntegrationEndpoint_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE "IntegrationEndpoint"
    ADD CONSTRAINT "IntegrationEndpoint_parserReleaseId_fkey"
    FOREIGN KEY ("parserReleaseId") REFERENCES "InboundWebhookParserRelease"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE "IntegrationEndpoint"
    ADD CONSTRAINT "IntegrationEndpoint_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE "IntegrationEndpointEvent"
    ADD CONSTRAINT "IntegrationEndpointEvent_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE "IntegrationEndpointEvent"
    ADD CONSTRAINT "IntegrationEndpointEvent_integrationEndpointId_fkey"
    FOREIGN KEY ("workspaceId", "integrationEndpointId")
    REFERENCES "IntegrationEndpoint"("workspaceId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Entregas antigas ficam com NULL; uma URL removida nunca apaga a entrega.
DO $$
BEGIN
  ALTER TABLE "InboundWebhookDelivery"
    ADD CONSTRAINT "InboundWebhookDelivery_integrationEndpointId_fkey"
    FOREIGN KEY ("integrationEndpointWorkspaceId", "integrationEndpointId")
    REFERENCES "IntegrationEndpoint"("workspaceId", "id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
