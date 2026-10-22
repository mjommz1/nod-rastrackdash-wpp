import type { KommoConversionDedupe, Prisma } from "@prisma/client";

export const KOMMO_DELIVERY_UNKNOWN = "kommo_delivery_unknown";
export const KOMMO_DELIVERY_UNKNOWN_MESSAGE =
  "Resultado da entrega desconhecido. Reenvio bloqueado; investigacao requerida.";

/** A claim has no expiry: neither elapsed time nor a fetch error proves non-delivery. */
export function kommoDeliveryUnknown(
  intent: {
    senderLeaseToken?: string | null;
    senderAttempts?: number;
    publicationStatus?: string;
  },
  log: { status: string; errorCode?: string | null } | null | undefined,
): boolean {
  if (log?.status === "sent" || intent.publicationStatus === "sent")
    return false;
  return Boolean(
    intent.senderLeaseToken ||
    intent.publicationStatus === "delivery_unknown" ||
    ((intent.senderAttempts ?? 0) > 0 && log?.status === "ready_to_send") ||
    (log?.status === "error" &&
      ["MetaCapiNetworkError", "MetaCapiDeliveryUnknown"].includes(
        log.errorCode ?? "",
      )),
  );
}

/**
 * Unknown is a decision from a snapshot, not permission to overwrite a result.
 * Match the sender state exactly; completion changes it in the same transaction
 * as the log. At READ COMMITTED a losing UPDATE rereads the committed outcome.
 * Callers keep their connection lock for authorization/audit, never for network.
 */
export async function settleKommoSenderOutcome(
  tx: Prisma.TransactionClient,
  intent: KommoConversionDedupe,
  log: { status: string; errorCode?: string | null } | null,
): Promise<string> {
  for (;;) {
    if (log?.status === "sent") {
      await tx.kommoConversionDedupe.updateMany({
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
    const written = await tx.kommoConversionDedupe.updateMany({
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
        publicationErrorCode: KOMMO_DELIVERY_UNKNOWN,
        senderRetryable: false,
      },
    });
    if (written.count) return "delivery_unknown";
    const current = await tx.kommoConversionDedupe.findFirst({
      where: { id: intent.id, workspaceId: intent.workspaceId },
    });
    // Losing/deleted state cannot grant new dispatch permission.
    if (!current) return "delivery_unknown";
    intent = current;
    log = await tx.conversionEventLog.findFirst({
      where: {
        id: intent.conversionEventLogId ?? "",
        workspaceId: intent.workspaceId,
        sourceTrigger: "kommo_stage",
      },
    });
  }
}
