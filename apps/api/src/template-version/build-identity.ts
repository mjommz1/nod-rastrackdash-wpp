import { readFileSync } from "node:fs";

const FULL_SHA = /^[0-9a-f]{40}$/;

type ReadFile = (path: string) => string;

/**
 * Returns the installed template commit recorded by the Docker build
 * (scripts/resolve-build-identity.mjs), or undefined when the build could not
 * establish it. A missing, malformed or unrecognized file is never trusted:
 * the version status must degrade to unknown rather than guess.
 */
export function readBuildIdentitySha(
  path: string,
  readFile: ReadFile = (filePath) => readFileSync(filePath, "utf8"),
): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(readFile(path));
  } catch {
    return undefined;
  }

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !("schemaVersion" in body) ||
    body.schemaVersion !== 1 ||
    !("sha" in body) ||
    typeof body.sha !== "string" ||
    !FULL_SHA.test(body.sha)
  ) {
    return undefined;
  }

  return body.sha;
}
