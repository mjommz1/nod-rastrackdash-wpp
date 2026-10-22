/**
 * Decides whether a previously saved Meta creative preview URL can be reused
 * instead of asking Graph for it again.
 *
 * Meta CDN URLs are signed and carry an `oe` query parameter: the expiry as a
 * hex Unix timestamp. It is an undocumented hint, not a guarantee — Meta may
 * revoke or rotate a URL before `oe`, and a URL that passes this check can
 * still fail to load. The rules are deliberately conservative: anything that
 * is not an HTTPS fbcdn.net URL with exactly one well-formed `oe` comfortably
 * in the future (beyond the refresh margin) is refreshed. Refreshing too often
 * only costs Graph requests; reusing a bad URL costs a broken preview.
 *
 * Reasons are coarse categories so callers can count them without logging the
 * URL itself (it embeds signatures).
 */

export const META_PREVIEW_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

/** Hints further out than this are treated as implausible, not as "fresh". */
const MAX_PLAUSIBLE_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

const TRUSTED_HOST_SUFFIX = ".fbcdn.net";
const OE_PATTERN = /^[0-9a-f]{8}$/i;

export type MetaPreviewUrlRefreshReason =
  | "invalid_url"
  | "invalid_clock"
  | "not_https"
  | "untrusted_host"
  | "missing_expiry"
  | "malformed_expiry"
  | "implausible_expiry"
  | "expiring";

export type MetaPreviewUrlFreshness =
  | { reusable: true; expiresAt: Date }
  | { reusable: false; reason: MetaPreviewUrlRefreshReason };

export function evaluateMetaPreviewUrlFreshness(
  value: unknown,
  now: Date,
  options: { refreshMarginMs?: number } = {},
): MetaPreviewUrlFreshness {
  const nowMs = now.getTime();

  if (!Number.isFinite(nowMs)) {
    return { reusable: false, reason: "invalid_clock" };
  }

  if (typeof value !== "string" || !value) {
    return { reusable: false, reason: "invalid_url" };
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return { reusable: false, reason: "invalid_url" };
  }

  if (url.protocol !== "https:") {
    return { reusable: false, reason: "not_https" };
  }

  if (
    !url.hostname.endsWith(TRUSTED_HOST_SUFFIX) ||
    url.username ||
    url.password ||
    url.port
  ) {
    return { reusable: false, reason: "untrusted_host" };
  }

  const expiryHints = url.searchParams.getAll("oe");

  if (expiryHints.length === 0) {
    return { reusable: false, reason: "missing_expiry" };
  }

  const [expiryHint] = expiryHints;

  if (expiryHints.length !== 1 || !expiryHint || !OE_PATTERN.test(expiryHint)) {
    return { reusable: false, reason: "malformed_expiry" };
  }

  const expiresAtMs = Number.parseInt(expiryHint, 16) * 1000;
  const marginMs = options.refreshMarginMs ?? META_PREVIEW_REFRESH_MARGIN_MS;

  if (expiresAtMs - nowMs > MAX_PLAUSIBLE_EXPIRY_MS) {
    return { reusable: false, reason: "implausible_expiry" };
  }

  if (expiresAtMs <= nowMs + marginMs) {
    return { reusable: false, reason: "expiring" };
  }

  return { reusable: true, expiresAt: new Date(expiresAtMs) };
}
