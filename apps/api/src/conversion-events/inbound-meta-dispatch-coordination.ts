import { Prisma } from "@prisma/client";
import { LICENSE_STATE_ID } from "../licensing-client/license-client.constants";

export const INBOUND_DISPATCH_START_MS = 2000;
export const INBOUND_DISPATCH_TRANSACTION_MS = 5000;
export const INBOUND_NETWORK_MS = 15000;

/**
 * Ordinary row locks, also respected by canonical UPDATE/DELETE, not a sender-only
 * advisory lock. Workspace FOR UPDATE also conflicts with FK KEY SHARE on new
 * authority rows, preventing insert phantoms while the context is checked.
 * Metadata spans the workspace because studentReplayContext hashes its accounts,
 * businesses and destinations. Event/delivery locks are limited to this event.
 * Fixed table order, then id order. A deadlock/timeout denies dispatch;
 * the separately committed AuditLog PK claim is never undone here.
 */
export async function lockInboundMetaDispatch(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  logId: string,
  eventId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
  // Shared across workspaces: readers coexist, ordinary heartbeat/revocation
  // UPDATE/DELETE waits. A missing configured license is denied by its service.
  await tx.$queryRaw`SELECT "id" FROM "LicenseState" WHERE "id" = ${LICENSE_STATE_ID} FOR SHARE`;
  for (const table of [
    "WorkspaceMember",
    "MetaIntegration",
    "MetaCredential",
    "MetaBusinessConnection",
    "MetaConversionDestination",
    "MetaReportingAccount",
    "MetaReportingAccountDestination",
  ]) {
    // Identifiers come only from this fixed allowlist; all values stay bound.
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "workspaceId" = ${workspaceId} ORDER BY "id" FOR UPDATE`,
    );
  }
  await tx.$queryRaw`SELECT "id" FROM "ConversionEventLog" WHERE "workspaceId" = ${workspaceId} AND "id" = ${logId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "InboundWebhookEvent" WHERE "workspaceId" = ${workspaceId} AND "id" = ${eventId} FOR UPDATE`;
  // Lock the event before discovering parent IDs; subsequent reads cannot follow
  // a concurrently retargeted FK to an unlocked authority.
  const [event] = await tx.$queryRaw<
    Array<{
      connectionId: string;
      channelId: string;
      deliveryId: string;
      adId: string | null;
    }>
  >`SELECT "connectionId", "channelId", "deliveryId", "adId" FROM "InboundWebhookEvent" WHERE "workspaceId" = ${workspaceId} AND "id" = ${eventId}`;
  if (!event) return;
  // Both route readers trim adId; lock the exact key they actually consult.
  const adId = event.adId?.trim() ?? null;
  await tx.$queryRaw`SELECT "id" FROM "InboundWebhookConnection" WHERE "workspaceId" = ${workspaceId} AND "id" = ${event.connectionId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "InboundWebhookParserRelease" WHERE "id" IN (SELECT "parserReleaseId" FROM "InboundWebhookConnection" WHERE "id" = ${event.connectionId} AND "workspaceId" = ${workspaceId}) FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "InboundWebhookChannel" WHERE "workspaceId" = ${workspaceId} AND "id" = ${event.channelId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "InboundWebhookChannelRoute" WHERE "workspaceId" = ${workspaceId} AND "channelId" = ${event.channelId} ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "InboundWebhookDelivery" WHERE "workspaceId" = ${workspaceId} AND "id" = ${event.deliveryId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "MetaAd" WHERE "workspaceId" = ${workspaceId} AND "adId" = ${adId} ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "MetaAdDestinationAssignment" WHERE "workspaceId" = ${workspaceId} AND "adId" = ${adId} ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "InboundWebhookReplayItem" WHERE "workspaceId" = ${workspaceId} AND "eventId" = ${eventId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "InboundWebhookReplayBatch" WHERE "workspaceId" = ${workspaceId} AND "id" IN (SELECT "batchId" FROM "InboundWebhookReplayItem" WHERE "workspaceId" = ${workspaceId} AND "eventId" = ${eventId}) ORDER BY "id" FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "AuditLog" WHERE "workspaceId" = ${workspaceId} AND "action" = 'inbound_webhook.replay.authorize' AND "targetId" IN (SELECT "batchId" FROM "InboundWebhookReplayItem" WHERE "workspaceId" = ${workspaceId} AND "eventId" = ${eventId}) ORDER BY "id" FOR UPDATE`;
}
