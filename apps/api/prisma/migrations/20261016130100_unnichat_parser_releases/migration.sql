-- Fase 4b (Unnichat): seed the Unnichat parser releases already validated in
-- production in the SaaS (unnichat v1 = conversation entry webhook, unnichat
-- automation-v1 = sale automation), certified. Certification only makes a
-- connection or rule eligible: every Unnichat connection and rule starts in
-- observation and still requires its own explicit production activation. No
-- rule, connection or channel is activated here. A release that already exists
-- is only certified while still observation_only (retired stays retired).
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
    'inbound_parser_unnichat_v1',
    'unnichat',
    'v1',
    'certified',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'inbound_parser_unnichat_automation_v1',
    'unnichat',
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
