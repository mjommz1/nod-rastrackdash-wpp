import {
  fetchLicenseStatus,
  licenseLockCopy,
  licenseLockReason,
} from "../lib/license-status";

/**
 * Server component: shows a persistent amber banner during the license
 * grace period, or a red banner whenever the API is locking writes — a
 * revoked/expired license as before, and now also an instance that never
 * completed a license activation (hard-lock). Renders nothing when the
 * license is fine, when licensing is inert (no license server configured) or
 * if the status check itself fails — a status-fetch hiccup should never block
 * the app from rendering. See .claude-task-license-hard-lock.md #6.
 */
export async function LicenseStatusBanner() {
  const status = await fetchLicenseStatus();

  if (!status) {
    return null;
  }

  const lockReason = licenseLockReason(status);

  if (lockReason) {
    const copy = licenseLockCopy[lockReason];

    return (
      <div className="feedback-banner license-banner error" role="alert">
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
        <a href="/backoffice/license">Abrir página de licença</a>
      </div>
    );
  }

  if (status.status === "grace") {
    return (
      <div className="feedback-banner license-banner warn" role="status">
        <strong>Licença em período de tolerância</strong>
        <span>Licença em período de tolerância — renovar</span>
      </div>
    );
  }

  return null;
}
