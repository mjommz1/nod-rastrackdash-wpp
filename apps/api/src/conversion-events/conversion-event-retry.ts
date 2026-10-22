import type { Prisma } from "@prisma/client";

type ConversionEventRetryState = {
  status: string;
  errorCode: string | null;
};

/**
 * errorCode kept on a ready_to_send log whose CTWA send was refused before the
 * dispatch claim (errorMessage carries "<reason>: <texto>"). Retryable: the
 * sender's ready_to_send -> dispatching claim remains the single-send fence.
 */
export const CTWA_SEND_SKIPPED_ERROR_CODE = "CtwaSendSkipped";

export const BLOCKED_CONVERSION_RETRY_LIMIT = 500;

const configurationErrorCodes = [
  "MissingAccessToken",
  "MissingMetaDestination",
];

export const configurationBlockedConversionEventWhere = {
  status: "not_configured",
  OR: [{ errorCode: { in: configurationErrorCodes } }, { errorCode: null }],
} satisfies Prisma.ConversionEventLogWhereInput;

export function isConfigurationBlockedConversionEvent(
  event: ConversionEventRetryState,
): boolean {
  return (
    event.status === "not_configured" &&
    (event.errorCode === null ||
      configurationErrorCodes.includes(event.errorCode))
  );
}

export function canRetryConversionEvent(
  event: ConversionEventRetryState,
): boolean {
  return (
    (event.status === "error" && event.errorCode === "MetaCapiNetworkError") ||
    isConfigurationBlockedConversionEvent(event) ||
    (event.status === "ready_to_send" &&
      event.errorCode === CTWA_SEND_SKIPPED_ERROR_CODE)
  );
}
