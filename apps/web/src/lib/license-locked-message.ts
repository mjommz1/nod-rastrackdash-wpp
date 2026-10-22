import { isLicenseLockedError } from "./server-api";

/**
 * pt-BR copy for a write the license guard refused with HTTP 423. Server
 * actions that swallow errors into a generic message use it so the student
 * sees the real reason (nothing was changed) instead of "tente novamente".
 */
export const licenseLockedActionMessage =
  "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.";

/** The lock message when `error` is the license guard's 423, else `null`. */
export function licenseLockedMessageFor(error: unknown): string | null {
  return isLicenseLockedError(error) ? licenseLockedActionMessage : null;
}
