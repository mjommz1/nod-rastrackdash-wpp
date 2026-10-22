import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inboundParserProductionEligible } from "../../src/inbound-webhooks/inbound-webhook-parser-eligibility";

const migrationsDir = resolve(__dirname, "../../prisma/migrations");
const migration = (name: string) =>
  readFileSync(resolve(migrationsDir, `${name}/migration.sql`), "utf8");
const code = (sql: string) => sql.replace(/--.*$/gm, "");
const schema = readFileSync(
  resolve(__dirname, "../../prisma/schema.prisma"),
  "utf8",
);

const providerMigration = "20261016130000_unnichat_inbound_provider";
const releaseMigration = "20261016130100_unnichat_parser_releases";

describe("Fase 4b (Unnichat) migrations", () => {
  it("adds the enum values alone, without inserting unnichat rows in the same file", () => {
    const sql = code(migration(providerMigration));
    expect(sql).toContain(
      "ALTER TYPE \"InboundWebhookProvider\" ADD VALUE IF NOT EXISTS 'unnichat';",
    );
    expect(sql).toContain(
      "ALTER TYPE \"DiagnosticSource\" ADD VALUE IF NOT EXISTS 'unnichat';",
    );
    // PostgreSQL cannot use a new enum label in the transaction that added it.
    expect(sql).not.toContain("InboundWebhookParserRelease");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|CREATE)\b/i);
  });

  it("seeds Unnichat v1 and automation-v1 certified in a following migration, never activating anything", () => {
    const sql = code(migration(releaseMigration));
    expect(sql).toContain('INSERT INTO "InboundWebhookParserRelease"');
    expect(sql).toContain("'inbound_parser_unnichat_v1'");
    expect(sql).toContain("'inbound_parser_unnichat_automation_v1'");
    expect(sql.match(/'certified'/g)?.length).toBeGreaterThanOrEqual(2);
    // An existing release is only certified while still observation-only.
    expect(sql).toContain(
      "WHERE \"InboundWebhookParserRelease\".\"status\" = 'observation_only'",
    );
    // No connection, channel or rule is promoted: production stays per
    // connection/number/rule activation.
    expect(sql).not.toMatch(
      /InboundWebhookConnection|InboundWebhookChannel|ProviderConversionRuleConfig|productionActivatedAt|certifiedByUserId|DELETE|DROP/,
    );
  });

  it("orders the enum before the seed inside the timestamps reserved for 4b, after every earlier phase", () => {
    const all = readdirSync(migrationsDir).filter((name) => /^\d{14}_/.test(name));
    const names = all.filter((name) => name.includes("unnichat"));
    expect(names).toEqual([providerMigration, releaseMigration]);
    for (const name of names) {
      expect(name >= "20261016130000" && name < "20261016140000").toBe(true);
    }
    // Additive and after the 4c reservation (20261016120000).
    expect(providerMigration > "20261016120000").toBe(true);
  });

  it("declares unnichat in both Prisma enums", () => {
    expect(schema).toMatch(
      /enum InboundWebhookProvider \{[^}]*\bunnichat\b[^}]*\}/,
    );
    expect(schema).toMatch(/enum DiagnosticSource \{[^}]*\bunnichat\b[^}]*\}/);
  });

  it("makes the certified Unnichat releases eligible, never while observation-only or retired", () => {
    for (const version of ["v1", "automation-v1"]) {
      const release = { provider: "unnichat", version };
      expect(
        inboundParserProductionEligible({ ...release, status: "certified" }),
      ).toBe(true);
      expect(
        inboundParserProductionEligible({
          ...release,
          status: "observation_only",
        }),
      ).toBe(false);
      expect(
        inboundParserProductionEligible({ ...release, status: "retired" }),
      ).toBe(false);
    }
  });
});
