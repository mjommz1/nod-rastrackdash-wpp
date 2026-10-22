-- Certify the message parsers already validated with real CTWA deliveries in
-- production in the SaaS: Data Crazy v1, Gupshup v1 and Umbler v1 (messages).
-- Certification only makes a connection eligible: the connection and each
-- conversion rule still require an explicit production activation. Only a
-- release still in observation_only changes (retired stays retired). Meta Cloud v1 needs no row change: its built-in
-- eligibility already treats the shipped parser as certified.
UPDATE "InboundWebhookParserRelease"
SET
  "status" = 'certified',
  "certifiedAt" = COALESCE("certifiedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "version" = 'v1'
  AND "provider" IN ('data_crazy', 'gupshup', 'umbler')
  AND "status" = 'observation_only';
