export const GITHUB_MAIN_COMMIT_URL =
  "https://api.github.com/repos/samoskito/nod-rastrackdash-wpp/commits/main";

const GITHUB_REPOSITORY_API_URL =
  "https://api.github.com/repos/samoskito/nod-rastrackdash-wpp";

export function githubCompareUrl(deployedSha: string, latestMainSha: string) {
  return `${GITHUB_REPOSITORY_API_URL}/compare/${deployedSha}...${latestMainSha}`;
}

export const TEMPLATE_UPDATE_GUIDE_URL =
  "https://github.com/samoskito/nod-rastrackdash-wpp/blob/main/docs/setup/update.md";

export const GITHUB_MAIN_TIMEOUT_MS = 3_000;
export const GITHUB_MAIN_CACHE_TTL_MS = 15 * 60 * 1_000;

/** Written by the Dockerfile `source` stage; absent outside the Docker image. */
export const BUILD_IDENTITY_FILE = "/app/build-identity.json";

export const TEMPLATE_VERSION_GITHUB_FETCH = Symbol("TEMPLATE_VERSION_GITHUB_FETCH");
export const TEMPLATE_VERSION_DEPLOYED_SHA = Symbol("TEMPLATE_VERSION_DEPLOYED_SHA");
