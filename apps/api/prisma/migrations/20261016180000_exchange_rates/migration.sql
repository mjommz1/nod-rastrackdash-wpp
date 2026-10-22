-- Fase 5.2: cotações PTAX do Banco Central para os relatórios por moeda.
-- Só acrescenta uma tabela nova (e seus índices). Nenhuma tabela ou linha
-- existente muda. A tabela fica vazia até alguém ligar PTAX_SYNC_ENABLED.
-- Depende do tipo "CurrencyCode" criado em 20261016140000_conversion_currency.
CREATE TABLE IF NOT EXISTS "ExchangeRate" (
  "id" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "baseCurrency" "CurrencyCode" NOT NULL,
  "quoteCurrency" "CurrencyCode" NOT NULL,
  "rate" DECIMAL(18, 8) NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'bcb_ptax',
  "bulletinAt" TIMESTAMP(3),
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- Uma cotação por dia e par de moedas: a gravação repetida é ignorada.
CREATE UNIQUE INDEX IF NOT EXISTS "ExchangeRate_date_baseCurrency_quoteCurrency_key"
  ON "ExchangeRate" ("date", "baseCurrency", "quoteCurrency");

-- Leitura do relatório: par de moedas e intervalo de datas.
CREATE INDEX IF NOT EXISTS "ExchangeRate_baseCurrency_quoteCurrency_date_idx"
  ON "ExchangeRate" ("baseCurrency", "quoteCurrency", "date");
