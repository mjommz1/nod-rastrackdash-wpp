-- Fase 5.1: moeda das conversões enviadas à Meta (BRL, USD ou EUR).
-- Só acrescenta: um tipo novo e duas colunas. Nenhuma linha existente é
-- reescrita; todo workspace que já existe fica em BRL pelo valor padrão da
-- coluna, e as contas de anúncio ficam sem correção manual (NULL).
DO $$
BEGIN
  CREATE TYPE "CurrencyCode" AS ENUM ('BRL', 'USD', 'EUR');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Padrão constante: no PostgreSQL 11+ só altera o catálogo (sem regravar a tabela).
ALTER TABLE "Workspace"
  ADD COLUMN IF NOT EXISTS "conversionCurrency" "CurrencyCode" NOT NULL DEFAULT 'BRL';

-- Correção opcional da moeda do investimento por conta de anúncio
-- (lida e gravada nesta fase; usada nos relatórios na Fase 5.2).
ALTER TABLE "MetaReportingAccount"
  ADD COLUMN IF NOT EXISTS "currencyOverride" "CurrencyCode";
