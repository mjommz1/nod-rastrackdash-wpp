import { KOMMO_CTWA_PROCESSING_MODE } from "../kommo/kommo-publication-policy";
import { PIPEDRIVE_CTWA_PROCESSING_MODE } from "../pipedrive/pipedrive-production-policy";

/**
 * True only for a conversion created by a CRM page/pixel path (Kommo or
 * Pipedrive CTWA). Only this context may re-authorize a page/pixel intent of
 * a non-Unnichat number (resolveCtwaDestination CRM mode); entries, replays
 * and provider conversions never do.
 */
export function isCrmCtwaContext(sourcePayload: unknown): boolean {
  if (
    !sourcePayload ||
    typeof sourcePayload !== "object" ||
    Array.isArray(sourcePayload)
  )
    return false;
  const mode = (sourcePayload as Record<string, unknown>).processingMode;
  return (
    mode === KOMMO_CTWA_PROCESSING_MODE ||
    mode === PIPEDRIVE_CTWA_PROCESSING_MODE
  );
}
