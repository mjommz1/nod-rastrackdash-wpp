import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const apiRoot = resolve(__dirname, "..");

describe("body-parser runtime dependency", () => {
  it("is declared directly and loads from an isolated compiled API module", () => {
    const manifest = JSON.parse(
      readFileSync(join(apiRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies?.["body-parser"]).toBe("1.20.4");

    const installedDependency = join(apiRoot, "node_modules", "body-parser");
    const isolatedRoot = mkdtempSync(
      join(process.env.TMPDIR ?? tmpdir(), "api-body-parser-runtime-"),
    );

    try {
      const isolatedModuleDir = join(isolatedRoot, "dist/src/inbound-webhooks");
      mkdirSync(isolatedModuleDir, { recursive: true });
      for (const sourceName of [
        "inbound-webhook-body-parser.ts",
        "inbound-webhook-limits.ts",
      ]) {
        const sourcePath = join(apiRoot, "src/inbound-webhooks", sourceName);
        const outputName = sourceName.replace(/\.ts$/, ".js");
        const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        });
        writeFileSync(join(isolatedModuleDir, outputName), compiled.outputText);
      }
      const isolatedNodeModules = join(isolatedRoot, "node_modules");
      mkdirSync(isolatedNodeModules);
      const compiledParser = join(
        isolatedModuleDir,
        "inbound-webhook-body-parser.js",
      );
      const childEnv = { ...process.env };
      delete childEnv.NODE_PATH;
      delete childEnv.NODE_OPTIONS;
      const loadCompiledParser = () =>
        spawnSync(
          process.execPath,
          ["-e", "require(process.argv[1])", compiledParser],
          {
            cwd: isolatedRoot,
            env: childEnv,
            encoding: "utf8",
          },
        );

      const withoutDependency = loadCompiledParser();
      expect(withoutDependency.status).not.toBe(0);
      expect(withoutDependency.stderr).toContain("MODULE_NOT_FOUND");
      expect(withoutDependency.stderr).toContain("body-parser");

      symlinkSync(
        realpathSync(installedDependency),
        join(isolatedNodeModules, "body-parser"),
        // Junctions need no symlink privilege on Windows; ignored elsewhere.
        process.platform === "win32" ? "junction" : "dir",
      );
      const withDependency = loadCompiledParser();
      expect(withDependency.status).toBe(0);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });
});
