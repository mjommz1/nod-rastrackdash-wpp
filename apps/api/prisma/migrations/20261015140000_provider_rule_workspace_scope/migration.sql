-- Fase 3 (Conversoes): alcance da regra de conversao por provedor
-- ("Todos os numeros" / "Numeros especificos") e "Unificar".
--
-- Migracao somente aditiva, sem backfill:
--  * ProviderRuleCreateClaim: recibo duravel da criacao idempotente de regra
--    (Idempotency-Key). Sem TTL, sem payload, sem URL, sem segredo.
--  * Toda regra existente vira "specific_numbers" (o DEFAULT), mantendo os
--    mesmos canais em ProviderConversionRuleChannel -> comportamento identico.
--  * connectionId/parserReleaseId continuam preenchidos em todas as linhas
--    existentes; apenas passam a aceitar NULL para regras novas de
--    mensagem/catalogo/etiqueta que abrangem varias conexoes.
--  * unifiedIntoProviderRuleId aponta para a regra "Todos os numeros" criada
--    pelo "Unificar" (a regra original fica pausada, com o historico).
--  * Nenhuma coluna, linha ou constraint existente e removida.

-- 1) Recibo da criacao idempotente.
CREATE TABLE "ProviderRuleCreateClaim" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "requestKey" VARCHAR(128) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "connectionId" TEXT,
    "providerRuleId" TEXT NOT NULL,
    "endpointRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderRuleCreateClaim_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProviderRuleCreateClaim_key_check" CHECK ("requestKey" ~ '^[A-Za-z0-9_-]{16,128}$'),
    CONSTRAINT "ProviderRuleCreateClaim_hash_check" CHECK ("requestHash" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "ProviderRuleCreateClaim_workspaceId_requestKey_key" ON "ProviderRuleCreateClaim"("workspaceId", "requestKey");
CREATE INDEX "ProviderRuleCreateClaim_workspaceId_connectionId_idx" ON "ProviderRuleCreateClaim"("workspaceId", "connectionId");
CREATE INDEX "ProviderRuleCreateClaim_workspaceId_providerRuleId_idx" ON "ProviderRuleCreateClaim"("workspaceId", "providerRuleId");

ALTER TABLE "ProviderRuleCreateClaim" ADD CONSTRAINT "ProviderRuleCreateClaim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderRuleCreateClaim" ADD CONSTRAINT "ProviderRuleCreateClaim_connection_fkey" FOREIGN KEY ("workspaceId", "connectionId") REFERENCES "InboundWebhookConnection"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderRuleCreateClaim" ADD CONSTRAINT "ProviderRuleCreateClaim_rule_fkey" FOREIGN KEY ("workspaceId", "providerRuleId") REFERENCES "ProviderConversionRuleConfig"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2) Alcance da regra.
CREATE TYPE "ProviderConversionRuleScope" AS ENUM ('all_numbers', 'specific_numbers');

ALTER TABLE "ProviderConversionRuleConfig"
  ADD COLUMN "scope" "ProviderConversionRuleScope" NOT NULL DEFAULT 'specific_numbers',
  ADD COLUMN "unifiedIntoProviderRuleId" TEXT,
  ALTER COLUMN "connectionId" DROP NOT NULL,
  ALTER COLUMN "parserReleaseId" DROP NOT NULL;

CREATE INDEX "ProviderConversionRuleConfig_workspaceId_scope_removedAt_idx"
  ON "ProviderConversionRuleConfig"("workspaceId", "scope", "removedAt");
CREATE INDEX "ProviderConversionRuleConfig_workspaceId_unifiedInto_idx"
  ON "ProviderConversionRuleConfig"("workspaceId", "unifiedIntoProviderRuleId");

-- A regra unificada pertence ao mesmo workspace (FK composta; NULL nao e
-- verificado). Regras sao removidas logicamente (removedAt), nunca apagadas.
ALTER TABLE "ProviderConversionRuleConfig"
  ADD CONSTRAINT "ProviderConversionRuleConfig_unifiedIntoProviderRuleId_fkey"
  FOREIGN KEY ("workspaceId", "unifiedIntoProviderRuleId")
  REFERENCES "ProviderConversionRuleConfig"("workspaceId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3) Conferencia antes das CHECKs: se algum dado ja violar as regras abaixo,
-- a migracao para aqui com uma mensagem clara (nada e corrigido em silencio).
DO $$
DECLARE
  binding_violations bigint;
  self_unified bigint;
BEGIN
  SELECT count(*) INTO binding_violations
    FROM "ProviderConversionRuleConfig"
   WHERE ("connectionId" IS NULL) <> ("parserReleaseId" IS NULL);
  SELECT count(*) INTO self_unified
    FROM "ProviderConversionRuleConfig"
   WHERE "unifiedIntoProviderRuleId" IS NOT NULL
     AND "unifiedIntoProviderRuleId" = "id";
  IF binding_violations > 0 OR self_unified > 0 THEN
    RAISE EXCEPTION
      'provider_rule_workspace_scope: % regra(s) com conexao sem parser (ou o contrario) e % regra(s) unificada(s) nela mesma. Corrija esses registros de ProviderConversionRuleConfig antes de atualizar.',
      binding_violations, self_unified;
  END IF;
END
$$;

-- Uma regra esta ligada a uma conexao E ao parser dela, ou a nenhum dos dois
-- (alcance do workspace). Toda linha existente tem os dois.
ALTER TABLE "ProviderConversionRuleConfig"
  ADD CONSTRAINT "ProviderConversionRuleConfig_binding_check"
  CHECK (("connectionId" IS NULL) = ("parserReleaseId" IS NULL));

-- Uma regra nunca e unificada nela mesma.
ALTER TABLE "ProviderConversionRuleConfig"
  ADD CONSTRAINT "ProviderConversionRuleConfig_unified_not_self_check"
  CHECK ("unifiedIntoProviderRuleId" IS NULL OR "unifiedIntoProviderRuleId" <> "id");
