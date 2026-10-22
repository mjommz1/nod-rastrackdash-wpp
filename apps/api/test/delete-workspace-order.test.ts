import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Text only: the script is read as a file and never imported or executed, and
// no PrismaClient or database is involved. Ported from the SaaS (static check
// of scripts/delete-workspace.js against schema.prisma).
// CRLF checkouts (Windows, core.autocrlf) are normalized so the regexes match.
const schema = readFileSync(
  resolve(__dirname, "../prisma/schema.prisma"),
  "utf8",
).replace(/\r\n/g, "\n");
const script = readFileSync(
  resolve(__dirname, "../scripts/delete-workspace.js"),
  "utf8",
).replace(/\r\n/g, "\n");

type Edge = { child: string; parent: string; onDelete: string };

const models = new Map<string, string>();
for (const match of schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm))
  models.set(match[1]!, match[2]!);

const edges: Edge[] = [];
for (const [child, body] of models) {
  for (const line of body.split("\n")) {
    const field = line.match(/^\s+\w+\s+(\w+)(\?)?\s+@relation\((.*)\)/);
    if (!field || !/\bfields:/.test(field[3]!)) continue;
    const explicit = field[3]!.match(/onDelete:\s*(\w+)/)?.[1];
    // Prisma defaults: required relations Restrict, optional relations SetNull.
    const onDelete = explicit ?? (field[2] ? "SetNull" : "Restrict");
    edges.push({ child, parent: field[1]!, onDelete });
  }
}
const blocks = (edge: Edge) => ["Restrict", "NoAction"].includes(edge.onDelete);

const delegate = (model: string) => model[0]!.toLowerCase() + model.slice(1);
const order = [
  ...script.match(/const order = \[([\s\S]*?)\];/)![1]!.matchAll(/"(\w+)"/g),
].map((match) => match[1]!);
const position = (model: string) =>
  model === "Workspace" ? order.length : order.indexOf(delegate(model));

describe("delete-workspace FK-safe order (static; never executed)", () => {
  it("parses the Restrict edges of the new purchase claim", () => {
    for (const [child, parent] of [
      ["ProviderPurchaseClaim", "Workspace"],
      ["ProviderPurchaseClaim", "ProviderConversionRuleExecution"],
      ["ProviderPurchaseClaim", "ConversionEventLog"],
      ["ProviderRuleCreateClaim", "ProviderConversionRuleConfig"],
    ])
      expect(edges).toContainEqual({ child, parent, onDelete: "Restrict" });
  });

  it("deletes provider purchase and rule-create claims before their parents", () => {
    for (const [claim, parents] of [
      [
        "providerPurchaseClaim",
        ["providerConversionRuleExecution", "conversionEventLog"],
      ],
      [
        "providerRuleCreateClaim",
        ["providerConversionRuleConfig", "inboundWebhookConnection"],
      ],
    ] as const) {
      expect(order).toContain(claim);
      for (const parent of parents) {
        if (!order.includes(parent)) continue;
        expect(order.indexOf(claim)).toBeLessThan(order.indexOf(parent));
      }
    }
  });

  it("deletes every Restrict child before each listed parent", () => {
    const violations = edges
      .filter((edge) => blocks(edge) && edge.child !== edge.parent)
      .filter((edge) => position(edge.child) >= 0 && position(edge.parent) >= 0)
      .filter((edge) => position(edge.child) > position(edge.parent))
      .map((edge) => `${edge.child} -> ${edge.parent}`);
    expect(violations).toEqual([]);
  });
});

describe("delete-workspace script covers every Restrict child", () => {
  it("lists only real, distinct schema models", () => {
    const delegates = new Set([...models.keys()].map(delegate));
    // Billing delegates of the SaaS stay in the list: the script skips a
    // missing delegate ("skip <model>") instead of failing.
    const missing = order.filter((name) => !delegates.has(name));
    expect(new Set(order).size).toBe(order.length);
    expect(missing).not.toContain("providerPurchaseClaim");
  });

  it("leaves no unlisted Restrict child behind", () => {
    const unlisted = [...models.keys()].filter((model) => {
      if (model === "Workspace" || position(model) >= 0) return false;
      const own = edges.filter((edge) => edge.child === model);
      return own.some(
        (edge) =>
          blocks(edge) &&
          position(edge.parent) >= 0 &&
          // A Cascade from an earlier listed parent removes the row in time.
          !own.some(
            (cascade) =>
              cascade.onDelete === "Cascade" &&
              cascade.parent !== "Workspace" &&
              position(cascade.parent) >= 0 &&
              position(cascade.parent) < position(edge.parent),
          ),
      );
    });
    expect(unlisted).toEqual([]);
  });
});
