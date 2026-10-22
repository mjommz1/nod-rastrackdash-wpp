import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBuildIdentitySha } from "../../src/template-version/build-identity";
import { TEMPLATE_VERSION_DEPLOYED_SHA } from "../../src/template-version/template-version.constants";
import { TemplateVersionModule } from "../../src/template-version/template-version.module";

const sha = "0123456789abcdef0123456789abcdef01234567";

function identityFile(contents: string) {
  return () => contents;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readBuildIdentitySha", () => {
  it("returns the full SHA recorded by the build", () => {
    expect(
      readBuildIdentitySha(
        "/app/build-identity.json",
        identityFile(
          JSON.stringify({ schemaVersion: 1, sha, source: "git", reason: null }),
        ),
      ),
    ).toBe(sha);
  });

  it("reads a real file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "build-identity-"));
    try {
      const path = join(dir, "build-identity.json");
      writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, sha, source: "build_arg", reason: null })}\n`);
      expect(readBuildIdentitySha(path)).toBe(sha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the file is missing (non-Docker run)", () => {
    expect(
      readBuildIdentitySha(join(tmpdir(), "does-not-exist", "build-identity.json")),
    ).toBeUndefined();
  });

  it.each([
    ["an unknown identity", { schemaVersion: 1, sha: null, source: "git", reason: "source_modified" }],
    ["an abbreviated SHA", { schemaVersion: 1, sha: sha.slice(0, 12), source: "git", reason: null }],
    ["an uppercase SHA", { schemaVersion: 1, sha: sha.toUpperCase(), source: "git", reason: null }],
    ["a SHA with whitespace", { schemaVersion: 1, sha: ` ${sha}`, source: "git", reason: null }],
    ["an unsupported schema version", { schemaVersion: 2, sha, source: "git", reason: null }],
    ["a missing schema version", { sha, source: "git", reason: null }],
    ["an array", [sha]],
    ["a bare string", sha],
    ["null", null],
  ])("returns undefined for %s", (_description, body) => {
    expect(
      readBuildIdentitySha("/app/build-identity.json", identityFile(JSON.stringify(body))),
    ).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    expect(
      readBuildIdentitySha("/app/build-identity.json", identityFile("{not json")),
    ).toBeUndefined();
  });
});

describe("TemplateVersionModule deployed SHA provider", () => {
  it("ignores a runtime GIT_SHA env (stale panel values cannot claim a version)", async () => {
    vi.stubEnv("GIT_SHA", sha);
    const module = await Test.createTestingModule({
      imports: [TemplateVersionModule],
    }).compile();

    // No /app/build-identity.json outside the Docker image -> unknown.
    expect(module.get(TEMPLATE_VERSION_DEPLOYED_SHA)).toBeUndefined();

    await module.close();
  });
});
