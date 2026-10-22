import {
  authorizedPipedriveRoute,
  pipedriveBoundChannelIds,
  type PipedriveRouteIntent,
} from "./pipedrive-channel-policy";
import type { Prisma } from "@prisma/client";

/**
 * Student edition: no environment opt-in (the SaaS
 * PIPEDRIVE_CONVERSION_PRODUCTION_ENABLED flag is intentionally absent).
 * Like the student Kommo, production is decided per rule (mode "production",
 * activated by the owner) and every background write still requires an
 * allowed license (checked by the callers). The CTWA page/pixel path keeps
 * the canonical CTWA sender gates (INBOUND_WEBHOOKS_ENABLED +
 * INBOUND_WEBHOOK_PRODUCTION_ENABLED), exactly as Kommo.
 */

/** sourcePayload.processingMode of a Pipedrive conversion delivered through
 * the CTWA page/pixel destination of the lead's proven entry channel. */
export const PIPEDRIVE_CTWA_PROCESSING_MODE = "pipedrive_crm";

/** Outbox intent of a CTWA destination conversion (no ad route involved). */
export type PipedriveCtwaPublicationIntent = {
  kind: "ctwa_destination";
  pipedriveConnectionId: string;
  channelId: string;
  connectionId: string;
  destinationId: string;
  eventId: string;
};

/**
 * Called by the canonical CTWA sender for a pipedrive_stage conversion. The
 * inbound CTWA gates (enabled/production) and the license are checked by the
 * caller; here: the immutable outbox row of this exact log and an active
 * connection still bound to the destination channel. Like Kommo, a rule or
 * credential edit does not revoke a committed sale.
 */
export async function pipedriveCtwaConversionAuthorized(
  client: Prisma.TransactionClient,
  log: {
    id: string;
    workspaceId: string | null;
    eventName: string;
    eventId?: string | null;
    sourceTrigger?: string | null;
    sourcePayload: Prisma.JsonValue | null;
  },
  destination: { channelId: string; connectionId: string; destinationId: string },
): Promise<boolean> {
  if (!log.workspaceId || log.sourceTrigger !== "pipedrive_stage") return false;
  const p = log.sourcePayload;
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    p.processingMode !== PIPEDRIVE_CTWA_PROCESSING_MODE ||
    p.channelId !== destination.channelId ||
    p.connectionId !== destination.connectionId ||
    typeof p.pipedriveConnectionId !== "string"
  )
    return false;
  const ledger = await client.pipedriveConversionDedupe.findFirst({
    where: {
      workspaceId: log.workspaceId,
      conversionEventLogId: log.id,
      eventName: log.eventName,
      mode: "production",
    },
  });
  const intent = ledger?.publicationIntent as
    | PipedriveCtwaPublicationIntent
    | null
    | undefined;
  if (
    !intent ||
    intent.kind !== "ctwa_destination" ||
    intent.pipedriveConnectionId !== p.pipedriveConnectionId ||
    intent.channelId !== destination.channelId ||
    intent.connectionId !== destination.connectionId ||
    intent.destinationId !== destination.destinationId ||
    (log.eventId != null && intent.eventId !== log.eventId)
  )
    return false;
  const connection = await client.pipedriveConnection.findFirst({
    where: {
      id: intent.pipedriveConnectionId,
      workspaceId: log.workspaceId,
      status: "active",
    },
  });
  if (!connection?.allowedChannelRouteIds.length) return false;
  // Bound through a route of the number or the number (channel) itself.
  const bound = await pipedriveBoundChannelIds(
    client,
    log.workspaceId,
    connection.allowedChannelRouteIds,
  );
  return bound.includes(destination.channelId);
}

/** Committed conversion authorization follows Kommo (any production number,
 * WhatsApp instance only for UAZAPI): a credential/rule edit does
 * not erase a sale; pause, unbinding, channel or asset revocation prevents send. */
export async function pipedrivePublicationAuthorized(
  client: Prisma.TransactionClient,
  workspaceId: string,
  intent: PipedriveRouteIntent,
): Promise<boolean> {
  if (!intent?.connectionId || !intent.routeId || "kind" in intent)
    return false;
  const connection = await client.pipedriveConnection.findFirst({
    where: { id: intent.connectionId, workspaceId, status: "active" },
  });
  if (!connection?.allowedChannelRouteIds.includes(intent.routeId))
    return false;
  return Boolean(
    await authorizedPipedriveRoute(client, workspaceId, intent.routeId, intent),
  );
}
