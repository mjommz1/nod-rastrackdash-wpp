-- Implatec: tipo da campanha no painel (WhatsApp x formulario Lead Ads).
-- So acrescenta um tipo e duas colunas opcionais em MetaCampaign; nenhuma
-- linha existente e alterada (default 'other' ate a proxima sincronizacao
-- com a Meta reclassificar). Reexecutavel.

DO $$
BEGIN
  CREATE TYPE "MetaCampaignKind" AS ENUM ('whatsapp', 'lead_form', 'other');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "MetaCampaign"
  ADD COLUMN IF NOT EXISTS "campaignKind" "MetaCampaignKind" NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS "campaignKindSource" TEXT;

CREATE INDEX IF NOT EXISTS "MetaCampaign_workspaceId_campaignKind_idx"
  ON "MetaCampaign"("workspaceId", "campaignKind");
