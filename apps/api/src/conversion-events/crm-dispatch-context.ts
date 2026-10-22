import type { PipedriveConversionDedupe, Prisma } from "@prisma/client";
import { kommoDeliveryUnknown } from "../kommo/kommo-sender-policy";
import type { PipedriveRouteIntent } from "../pipedrive/pipedrive-channel-policy";
import { pipedrivePublicationAuthorized } from "../pipedrive/pipedrive-production-policy";

/**
 * Pipedrive CRM dispatch context for the canonical sender. Kommo keeps its own
 * flow in ConversionEventsService untouched; Pipedrive reuses the same
 * immutable publication/sender contract (one dispatch, no expiring claim,
 * unknown outcome fences resend) against its own ledger table.
 */
export const PIPEDRIVE_STAGE_TRIGGER = "pipedrive_stage";
export const PIPEDRIVE_DELIVERY_UNKNOWN = "pipedrive_delivery_unknown";

/** Ad-attributed route intent (same shape as Kommo's). A CTWA destination
 * intent (kind "ctwa_destination") is not a route intent and returns null. */
export function pipedriveRouteIntent(
  value: Prisma.JsonValue | null | undefined,
): PipedriveRouteIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if ("kind" in value || typeof value.routeId !== "string") return null;
  return value as unknown as PipedriveRouteIntent;
}

export async function lockPipedriveConnection(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  connectionId: string,
) {
  await tx.$queryRaw`SELECT "id" FROM "PipedriveConnection" WHERE "id" = ${connectionId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
}

export function pipedriveDispatchAuthorized(
  client: Prisma.TransactionClient,
  workspaceId: string,
  intent: PipedriveRouteIntent | null,
) {
  return intent
    ? pipedrivePublicationAuthorized(client, workspaceId, intent)
    : Promise.resolve(false);
}

/** Mirrors settleKommoSenderOutcome on the Pipedrive ledger. */
export async function settlePipedriveSenderOutcome(
  tx: Prisma.TransactionClient,
  intent: PipedriveConversionDedupe,
  log: { status: string; errorCode?: string | null } | null,
): Promise<string> {
  for (;;) {
    if (log?.status === "sent") {
      await tx.pipedriveConversionDedupe.updateMany({
        where: { id: intent.id, workspaceId: intent.workspaceId },
        data: {
          publicationStatus: "sent",
          publicationErrorCode: null,
          senderRetryable: false,
        },
      });
      return "sent";
    }
    if (intent.publicationStatus === "sent") return "sent";
    if (!kommoDeliveryUnknown(intent, log)) return log?.status ?? "error";
    const written = await tx.pipedriveConversionDedupe.updateMany({
      where: {
        id: intent.id,
        workspaceId: intent.workspaceId,
        conversionEventLogId: intent.conversionEventLogId,
        publicationStatus: intent.publicationStatus,
        senderLeaseToken: intent.senderLeaseToken,
        senderAttempts: intent.senderAttempts,
        senderRetryable: intent.senderRetryable,
      },
      data: {
        publicationStatus: "delivery_unknown",
        publicationErrorCode: PIPEDRIVE_DELIVERY_UNKNOWN,
        senderRetryable: false,
      },
    });
    if (written.count) return "delivery_unknown";
    const current = await tx.pipedriveConversionDedupe.findFirst({
      where: { id: intent.id, workspaceId: intent.workspaceId },
    });
    if (!current) return "delivery_unknown";
    intent = current;
    log = await tx.conversionEventLog.findFirst({
      where: {
        id: intent.conversionEventLogId ?? "",
        workspaceId: intent.workspaceId,
        sourceTrigger: PIPEDRIVE_STAGE_TRIGGER,
      },
    });
  }
}
