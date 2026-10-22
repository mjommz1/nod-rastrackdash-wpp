import { templateVersionSchema } from "@wpptrack/shared";
import { isApiRequestError, serverApiFetch } from "./server-api";
import { isFullGitSha } from "./template-version-format";

/**
 * Why the version could not be verified:
 * - `missing_deployed_sha`: the API answered, but this build carries no valid
 *   commit SHA (the image build could not confirm a clean git checkout), so
 *   there is nothing to compare.
 * - `unavailable`: the check failed (network, API error, malformed answer) or
 *   the API itself could not reach the upstream repository.
 */
export type TemplateVersionUnknownReason =
  | "missing_deployed_sha"
  | "unavailable";

export type TemplateVersionState =
  | { status: "current"; deployedSha: string }
  | { status: "behind"; deployedSha: string; latestMainSha: string }
  | {
      status: "unknown";
      deployedSha: string | null;
      reason: TemplateVersionUnknownReason;
    };

type SessionUser = {
  id?: unknown;
  platformRole?: unknown;
};

/** Visible owner banner: the template version plus who is looking at it. */
export type TemplateVersionBannerData = {
  userId: string;
  version: TemplateVersionState;
};

const UNAVAILABLE: TemplateVersionState = {
  status: "unknown",
  deployedSha: null,
  reason: "unavailable",
};

/**
 * Maps the raw `/backoffice/template-version` body to what the banner may
 * claim. A status is only trusted when the SHAs backing it are real: a
 * "behind" or "current" answer without both valid SHAs degrades to unknown,
 * so the UI never asserts a version it cannot show.
 */
export function normalizeTemplateVersion(raw: unknown): TemplateVersionState {
  const parsed = templateVersionSchema.safeParse(raw);

  if (!parsed.success) {
    return UNAVAILABLE;
  }

  const deployedSha = isFullGitSha(parsed.data.deployedSha)
    ? parsed.data.deployedSha
    : null;
  const latestMainSha = isFullGitSha(parsed.data.latestMainSha)
    ? parsed.data.latestMainSha
    : null;

  if (!deployedSha) {
    return {
      status: "unknown",
      deployedSha: null,
      reason: "missing_deployed_sha",
    };
  }

  if (
    parsed.data.status === "current" &&
    latestMainSha &&
    latestMainSha === deployedSha
  ) {
    return { status: "current", deployedSha };
  }

  if (
    parsed.data.status === "behind" &&
    latestMainSha &&
    latestMainSha !== deployedSha
  ) {
    return { status: "behind", deployedSha, latestMainSha };
  }

  return { status: "unknown", deployedSha, reason: "unavailable" };
}

/**
 * Server-only read for the backoffice version banner. Returns null — render
 * nothing — unless the signed-in user is the platform owner, and the owner
 * check happens before the owner-only endpoint is ever called, so workspace
 * clients and platform operators never trigger it. An expired/forbidden
 * session also yields null and is left to the existing session handling; any
 * other failure becomes an "unknown" state without echoing backend messages.
 */
export async function getTemplateVersionBannerData(): Promise<TemplateVersionBannerData | null> {
  let user: SessionUser | undefined;

  try {
    const session = await serverApiFetch<{ user?: SessionUser }>("/auth/me");
    user = session?.user;
  } catch {
    return null;
  }

  if (
    user?.platformRole !== "platform_owner" ||
    typeof user.id !== "string" ||
    !user.id
  ) {
    return null;
  }

  try {
    const raw = await serverApiFetch<unknown>("/backoffice/template-version");

    return { userId: user.id, version: normalizeTemplateVersion(raw) };
  } catch (error) {
    if (
      isApiRequestError(error) &&
      (error.status === 401 || error.status === 403)
    ) {
      return null;
    }

    return { userId: user.id, version: UNAVAILABLE };
  }
}
