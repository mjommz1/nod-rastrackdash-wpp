#!/usr/bin/env node
// Resolves which template commit an image is built from, at Docker build time.
//
// Usage (see the Dockerfile `source-identity` stage):
//   node scripts/resolve-build-identity.mjs <source-dir> <output-file>
//
// The output is a small JSON file read by the API (template-version module).
// It only ever contains the commit SHA, where it came from and why it is
// missing — never remotes, refs, history or environment values.
//
// Rules (fail-closed: anything uncertain becomes `sha: null`):
// - `.git` metadata present and the checkout is clean -> that HEAD commit.
//   An explicit GIT_SHA build arg never overrides it.
// - `.git` metadata present but the checkout has local changes -> null; the
//   built code does not match any published commit.
// - `.git` metadata present but unreadable -> null.
// - No `.git` metadata (archive/tarball build) -> the GIT_SHA build arg, when it
//   is a full 40-character SHA; otherwise null.

import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_IDENTITY_SCHEMA_VERSION = 1;

const FULL_SHA = /^[0-9a-f]{40}$/;

export function normalizeBuildArgSha(value) {
  if (typeof value !== "string") return null;
  const sha = value.trim().toLowerCase();
  return FULL_SHA.test(sha) ? sha : null;
}

/**
 * Pure decision step. `git` describes what the git probe observed:
 *   { metadata: "absent" }
 *   { metadata: "unreadable" }
 *   { metadata: "present", sha, dirty }
 */
export function decideBuildIdentity({ git, buildArgSha }) {
  const argSha = normalizeBuildArgSha(buildArgSha);
  const argProvided = typeof buildArgSha === "string" && buildArgSha.trim() !== "";

  if (git.metadata === "present") {
    if (!FULL_SHA.test(git.sha ?? "")) {
      return identity(null, "git", "git_head_unreadable");
    }
    if (git.dirty) return identity(null, "git", "source_modified");
    return identity(git.sha, "git", null);
  }

  if (git.metadata === "unreadable") {
    return identity(null, "git", "git_metadata_unreadable");
  }

  if (argSha) return identity(argSha, "build_arg", null);
  return identity(
    null,
    "none",
    argProvided ? "invalid_build_arg" : "no_git_metadata",
  );
}

function identity(sha, source, reason) {
  return { schemaVersion: BUILD_IDENTITY_SCHEMA_VERSION, sha, source, reason };
}

/**
 * Reads git metadata from `sourceDir` without trusting any repository config:
 * system/global config are disabled and the git dir is passed explicitly so
 * git never walks up into a parent repository.
 */
export function probeGit(sourceDir, runGit = defaultRunGit) {
  const gitDir = join(sourceDir, ".git");
  let gitDirStat;
  try {
    gitDirStat = statSync(gitDir);
  } catch {
    return { metadata: "absent" };
  }
  // A `.git` file is a worktree/submodule pointer to a path outside the build
  // context; it cannot be resolved here.
  if (!gitDirStat.isDirectory()) return { metadata: "unreadable" };

  const base = [
    "-c",
    "safe.directory=*",
    "-c",
    "core.hooksPath=/dev/null",
    `--git-dir=${gitDir}`,
    `--work-tree=${sourceDir}`,
  ];

  let sha;
  try {
    sha = runGit([...base, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
      .trim()
      .toLowerCase();
  } catch {
    return { metadata: "unreadable" };
  }

  let status;
  try {
    status = runGit([
      ...base,
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ]);
  } catch {
    return { metadata: "unreadable" };
  }

  return { metadata: "present", sha, dirty: status.trim() !== "" };
}

function defaultRunGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: "/nonexistent",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function resolveBuildIdentity({ sourceDir, buildArgSha, runGit }) {
  return decideBuildIdentity({ git: probeGit(sourceDir, runGit), buildArgSha });
}

function main(argv) {
  const [sourceDir, outputFile] = argv;
  if (!sourceDir || !outputFile) {
    console.error("usage: resolve-build-identity.mjs <source-dir> <output-file>");
    process.exit(2);
  }

  const result = resolveBuildIdentity({
    sourceDir,
    buildArgSha: process.env.GIT_SHA,
  });

  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, `${JSON.stringify(result)}\n`);
  console.log(
    result.sha
      ? `build identity: ${result.sha} (source: ${result.source})`
      : `build identity: unknown (${result.reason})`,
  );
  if (result.source === "git" && normalizeBuildArgSha(process.env.GIT_SHA)) {
    console.log("build identity: GIT_SHA build arg ignored; git metadata is authoritative");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
