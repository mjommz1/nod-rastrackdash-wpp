import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  decideBuildIdentity,
  normalizeBuildArgSha,
  probeGit,
  resolveBuildIdentity,
} from "./resolve-build-identity.mjs";

const SCRIPT = fileURLToPath(new URL("./resolve-build-identity.mjs", import.meta.url));
const OTHER_SHA = "f".repeat(40);
const root = mkdtempSync(join(tmpdir(), "resolve-build-identity-"));
after(() => rmSync(root, { recursive: true, force: true }));

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
}

let counter = 0;
function freshDir(name) {
  counter += 1;
  const dir = join(root, `${counter}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Upstream repo with two commits on main. */
function upstreamRepo() {
  const dir = freshDir("upstream");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(join(dir, "app.txt"), "v1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  writeFileSync(join(dir, "app.txt"), "v2\n");
  git(dir, "commit", "-q", "-am", "second");
  return { dir, head: git(dir, "rev-parse", "HEAD") };
}

/**
 * Mimics Dokploy (`git clone --branch main --depth 1`) followed by the
 * .dockerignore filter: only HEAD, shallow, packed-refs, refs, objects and
 * index survive; config (remote with token), hooks, logs and info are gone.
 */
function dokployLikeContext(upstream) {
  const dir = freshDir("context");
  execFileSync(
    "git",
    ["clone", "-q", "--branch", "main", "--depth", "1", `file://${upstream}`, dir],
    { env: gitEnv },
  );
  git(dir, "remote", "set-url", "origin", "https://oauth2:FAKE_TOKEN@example.invalid/x/y.git");
  const keep = new Set(["HEAD", "shallow", "packed-refs", "refs", "objects", "index"]);
  for (const entry of readdirSync(join(dir, ".git"))) {
    if (!keep.has(entry)) rmSync(join(dir, ".git", entry), { recursive: true, force: true });
  }
  return dir;
}

test("normalizeBuildArgSha accepts only full SHAs", () => {
  assert.equal(normalizeBuildArgSha(` ${"A".repeat(40)} `), "a".repeat(40));
  assert.equal(normalizeBuildArgSha("abc1234"), null);
  assert.equal(normalizeBuildArgSha(""), null);
  assert.equal(normalizeBuildArgSha(undefined), null);
  assert.equal(normalizeBuildArgSha("g".repeat(40)), null);
});

test("clean shallow clone without .git/config resolves the exact HEAD SHA", () => {
  const upstream = upstreamRepo();
  const context = dokployLikeContext(upstream.dir);

  assert.deepEqual(resolveBuildIdentity({ sourceDir: context, buildArgSha: "" }), {
    schemaVersion: 1,
    sha: upstream.head,
    source: "git",
    reason: null,
  });
});

test("an explicit GIT_SHA build arg never overrides a clean git checkout", () => {
  const upstream = upstreamRepo();
  const context = dokployLikeContext(upstream.dir);

  const result = resolveBuildIdentity({ sourceDir: context, buildArgSha: OTHER_SHA });
  assert.equal(result.sha, upstream.head);
  assert.equal(result.source, "git");
});

test("modified tracked file -> unknown, even with a GIT_SHA build arg", () => {
  const upstream = upstreamRepo();
  const context = dokployLikeContext(upstream.dir);
  writeFileSync(join(context, "app.txt"), "local edit\n");

  assert.deepEqual(resolveBuildIdentity({ sourceDir: context, buildArgSha: upstream.head }), {
    schemaVersion: 1,
    sha: null,
    source: "git",
    reason: "source_modified",
  });
});

test("untracked source file -> unknown; gitignored files do not count", () => {
  const upstream = upstreamRepo();
  const ignoredOnly = dokployLikeContext(upstream.dir);
  writeFileSync(join(ignoredOnly, ".env"), "SECRET=x\n");
  assert.equal(resolveBuildIdentity({ sourceDir: ignoredOnly }).sha, upstream.head);

  const untracked = dokployLikeContext(upstream.dir);
  writeFileSync(join(untracked, "extra.ts"), "export {};\n");
  assert.equal(resolveBuildIdentity({ sourceDir: untracked }).reason, "source_modified");
});

test("deleted tracked file -> unknown", () => {
  const upstream = upstreamRepo();
  const context = dokployLikeContext(upstream.dir);
  rmSync(join(context, "app.txt"));

  assert.equal(resolveBuildIdentity({ sourceDir: context }).sha, null);
});

test("missing index (incomplete metadata) is treated as modified, not clean", () => {
  const upstream = upstreamRepo();
  const context = dokployLikeContext(upstream.dir);
  rmSync(join(context, ".git", "index"));

  assert.equal(resolveBuildIdentity({ sourceDir: context }).sha, null);
});

test("custom branch / fork commit: reports the commit actually built", () => {
  const upstream = upstreamRepo();
  const fork = freshDir("fork");
  execFileSync("git", ["clone", "-q", upstream.dir, fork], { env: gitEnv });
  git(fork, "checkout", "-q", "-b", "custom");
  writeFileSync(join(fork, "app.txt"), "fork change\n");
  git(fork, "commit", "-q", "-am", "fork change");
  const forkHead = git(fork, "rev-parse", "HEAD");

  const result = resolveBuildIdentity({ sourceDir: fork, buildArgSha: upstream.head });
  // The API's GitHub ancestry check (not this script) decides behind/unknown.
  assert.equal(result.sha, forkHead);
  assert.notEqual(result.sha, upstream.head);
});

test("no .git metadata (archive build) -> unknown without a build arg", () => {
  const dir = freshDir("archive");
  writeFileSync(join(dir, "app.txt"), "v2\n");

  assert.deepEqual(resolveBuildIdentity({ sourceDir: dir, buildArgSha: "" }), {
    schemaVersion: 1,
    sha: null,
    source: "none",
    reason: "no_git_metadata",
  });
});

test("no .git metadata -> explicit full GIT_SHA build arg is used", () => {
  const dir = freshDir("archive-arg");

  assert.deepEqual(resolveBuildIdentity({ sourceDir: dir, buildArgSha: OTHER_SHA.toUpperCase() }), {
    schemaVersion: 1,
    sha: OTHER_SHA,
    source: "build_arg",
    reason: null,
  });
});

test("no .git metadata -> malformed build arg stays unknown", () => {
  const dir = freshDir("archive-bad-arg");

  for (const buildArgSha of ["abc1234", "latest", "$COMMIT", "a".repeat(39)]) {
    assert.deepEqual(resolveBuildIdentity({ sourceDir: dir, buildArgSha }), {
      schemaVersion: 1,
      sha: null,
      source: "none",
      reason: "invalid_build_arg",
    });
  }
});

test("worktree-style .git pointer file -> unreadable, build arg not used", () => {
  const dir = freshDir("worktree");
  writeFileSync(join(dir, ".git"), "gitdir: /somewhere/outside/.git/worktrees/x\n");

  assert.deepEqual(resolveBuildIdentity({ sourceDir: dir, buildArgSha: OTHER_SHA }), {
    schemaVersion: 1,
    sha: null,
    source: "git",
    reason: "git_metadata_unreadable",
  });
});

test("corrupted HEAD -> unreadable", () => {
  const upstream = upstreamRepo();
  const context = dokployLikeContext(upstream.dir);
  writeFileSync(join(context, ".git", "HEAD"), "ref: refs/heads/missing\n");

  assert.equal(resolveBuildIdentity({ sourceDir: context }).reason, "git_metadata_unreadable");
});

test("git binary unavailable -> unreadable", () => {
  const upstream = upstreamRepo();
  const context = dokployLikeContext(upstream.dir);
  const runGit = () => {
    throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  };

  assert.deepEqual(probeGit(context, runGit), { metadata: "unreadable" });
});

test("decideBuildIdentity rejects a non-SHA HEAD value", () => {
  assert.deepEqual(
    decideBuildIdentity({ git: { metadata: "present", sha: "abc", dirty: false }, buildArgSha: OTHER_SHA }),
    { schemaVersion: 1, sha: null, source: "git", reason: "git_head_unreadable" },
  );
});

test("CLI writes only the identity fields and never the remote URL", () => {
  const upstream = upstreamRepo();
  const context = dokployLikeContext(upstream.dir);
  const out = join(freshDir("out"), "nested", "build-identity.json");

  const stdout = execFileSync("node", [SCRIPT, context, out], {
    env: { ...process.env, GIT_SHA: "" },
    encoding: "utf8",
  });

  const raw = readFileSync(out, "utf8");
  assert.deepEqual(JSON.parse(raw), {
    schemaVersion: 1,
    sha: upstream.head,
    source: "git",
    reason: null,
  });
  assert.ok(!raw.includes("FAKE_TOKEN") && !stdout.includes("FAKE_TOKEN"));
  assert.match(stdout, new RegExp(`build identity: ${upstream.head} \\(source: git\\)`));
});
