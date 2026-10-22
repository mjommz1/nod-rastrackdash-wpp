import {
  authorizedCrmRoute,
  crmCtwaChannelBound,
  type CrmRouteIntent,
} from "../crm-channels/crm-channel-policy";
import type { AuthorizedCtwaDestination } from "../inbound-webhooks/authorized-ctwa-destination";

/** Current authorization for an immutable publication intent. Credentials and
 * trigger rules are deliberately excluded: neither revokes a committed sale.
 * Pause/removal of a connection binding, channel, route or Meta asset does.
 *
 * Kommo is only a CRM: its authorized channels are the workspace's production
 * WhatsApp numbers of any provider (shared CRM channel policy). A UAZAPI
 * number keeps its WhatsApp instance pinned in the intent; an official-API
 * number has none (null).
 */
export type KommoPublicationIntent = CrmRouteIntent;

/** sourcePayload.processingMode of a Kommo conversion delivered through the
 * verified page/pixel destination of its number (CTWA lead). */
export const KOMMO_CTWA_PROCESSING_MODE = "kommo_ctwa_destination";

/** Ledger intent of a Kommo page/pixel conversion. `connectionId` is the Kommo
 * connection (same key as route intents); `inboundConnectionId` is the
 * provider connection of the WhatsApp number. */
export type KommoCtwaPublicationIntent = {
  kind: "ctwa_destination";
  connectionId: string;
  channelId: string;
  inboundConnectionId: string;
  destinationId: string;
  eventId: string;
};

export function kommoCtwaIntent(
  value: unknown,
): KommoCtwaPublicationIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const intent = value as Record<string, unknown>;
  return intent.kind === "ctwa_destination" &&
    typeof intent.connectionId === "string" &&
    typeof intent.channelId === "string" &&
    typeof intent.inboundConnectionId === "string" &&
    typeof intent.destinationId === "string" &&
    typeof intent.eventId === "string"
    ? (intent as unknown as KommoCtwaPublicationIntent)
    : null;
}

export async function authorizedKommoRoute(
  client: any,
  workspaceId: string,
  routeId: string,
  intent?: KommoPublicationIntent,
) {
  return authorizedCrmRoute(client, workspaceId, routeId, intent);
}

export async function kommoPublicationAuthorized(
  client: any,
  workspaceId: string,
  intent: KommoPublicationIntent,
): Promise<boolean> {
  if (!intent?.connectionId || !intent.routeId || "kind" in intent)
    return false;
  const connection = await client.kommoConnection.findFirst({
    where: { id: intent.connectionId, workspaceId, status: "active" },
  });
  if (!connection?.allowedChannelRouteIds.includes(intent.routeId))
    return false;
  return Boolean(
    await authorizedKommoRoute(client, workspaceId, intent.routeId, intent),
  );
}

/**
 * Send-time context of a Kommo page/pixel conversion (the canonical CTWA
 * sender re-resolves the destination itself): the immutable ledger intent
 * matches the log and destination, and the active Kommo connection still binds
 * that number.
 */
export async function kommoCtwaConversionAuthorized(
  client: any,
  log: {
    id: string;
    workspaceId: string | null;
    sourceTrigger?: string | null;
    eventName: string;
    eventId?: string | null;
    sourcePayload: unknown;
  },
  destination: AuthorizedCtwaDestination,
): Promise<boolean> {
  if (!log.workspaceId || log.sourceTrigger !== "kommo_stage") return false;
  const p = log.sourcePayload as Record<string, unknown> | null;
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    p.processingMode !== KOMMO_CTWA_PROCESSING_MODE ||
    p.channelId !== destination.channelId ||
    p.connectionId !== destination.connectionId ||
    typeof p.kommoConnectionId !== "string"
  )
    return false;
  const ledger = await client.kommoConversionDedupe.findFirst({
    where: {
      workspaceId: log.workspaceId,
      conversionEventLogId: log.id,
      eventName: log.eventName,
    },
  });
  const intent = kommoCtwaIntent(ledger?.publicationIntent);
  if (
    !intent ||
    intent.connectionId !== p.kommoConnectionId ||
    intent.channelId !== destination.channelId ||
    intent.inboundConnectionId !== destination.connectionId ||
    intent.destinationId !== destination.destinationId ||
    (log.eventId != null && intent.eventId !== log.eventId)
  )
    return false;
  const connection = await client.kommoConnection.findFirst({
    where: {
      id: intent.connectionId,
      workspaceId: log.workspaceId,
      status: "active",
    },
  });
  if (!connection?.allowedChannelRouteIds?.length) return false;
  return crmCtwaChannelBound(
    client,
    log.workspaceId,
    connection.allowedChannelRouteIds,
    destination.channelId,
  );
}
