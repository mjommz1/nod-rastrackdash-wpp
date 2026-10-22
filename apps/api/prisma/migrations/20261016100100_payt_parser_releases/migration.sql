-- Fase 4a (Payt): seed the Payt parser releases already validated with real
-- sales in production in the SaaS (payt v1 and payt automation-v1), certified.
-- Certification only makes a rule eligible: every Payt conversion rule is
-- created in observation and still requires its own explicit production
-- activation. No rule, connection or channel is activated here. A release that
-- already exists is only certified while still observation_only (retired
-- stays retired).
INSERT INTO "InboundWebhookParserRelease" (
  "id",
  "provider",
  "version",
  "status",
  "certifiedAt",
  "createdAt",
  "updatedAt"
) VALUES
  (
    'inbound_parser_payt_v1',
    'payt',
    'v1',
    'certified',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'inbound_parser_payt_automation_v1',
    'payt',
    'automation-v1',
    'certified',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("provider", "version") DO UPDATE
SET
  "status" = 'certified',
  "certifiedAt" = COALESCE("InboundWebhookParserRelease"."certifiedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "InboundWebhookParserRelease"."status" = 'observation_only';
