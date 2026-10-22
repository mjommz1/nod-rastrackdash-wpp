-- Meta routing mode per WhatsApp number. Existing numbers keep NULL (legacy:
-- their saved routes keep deciding, nothing is inferred or widened); numbers
-- created from now on start as inherit_workspace. Only the Unnichat number
-- selector (Fase 4b) reads or changes it.
CREATE TYPE "InboundWebhookMetaRoutingMode" AS ENUM ('inherit_workspace', 'channel_override');
ALTER TABLE "InboundWebhookChannel" ADD COLUMN "metaRoutingMode" "InboundWebhookMetaRoutingMode";
ALTER TABLE "InboundWebhookChannel" ALTER COLUMN "metaRoutingMode" SET DEFAULT 'inherit_workspace';
