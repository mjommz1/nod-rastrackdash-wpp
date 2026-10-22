import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheets = ["globals.css", "layout-system.css"];

// Strip comments and strings so braces inside them do not count.
function braceDepths(css: string): { final: number; min: number } {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"[^"\n]*"|'[^'\n]*'/g, "");
  let depth = 0;
  let min = 0;
  for (const char of code) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    min = Math.min(min, depth);
  }
  return { final: depth, min };
}

describe("stylesheets", () => {
  // A merge that drops a closing brace silently nests every later rule
  // inside the previous block (e.g. a max-width media query).
  for (const name of stylesheets) {
    it(`${name} has balanced braces`, () => {
      const css = readFileSync(resolve(__dirname, "../src/styles", name), "utf8");
      expect(braceDepths(css)).toEqual({ final: 0, min: 0 });
    });
  }

  it("keeps the Unnichat rules at the top level", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles/globals.css"), "utf8");
    const index = css.indexOf("/* Fase 4b: Unnichat");
    expect(index).toBeGreaterThan(0);
    expect(braceDepths(css.slice(0, index)).final).toBe(0);
  });
});
