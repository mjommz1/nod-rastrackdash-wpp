-- Fase 4b (Unnichat): register the enum values in their own committed migration.
-- PostgreSQL cannot use a newly added enum label before the transaction that
-- added it commits, so the parser release seed lives in the next migration.
-- Additive only: no existing connection, rule, channel, event or replay changes.
ALTER TYPE "InboundWebhookProvider" ADD VALUE IF NOT EXISTS 'unnichat';
ALTER TYPE "DiagnosticSource" ADD VALUE IF NOT EXISTS 'unnichat';
