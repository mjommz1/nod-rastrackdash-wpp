import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = resolve(__dirname, "../../prisma/migrations");
const name = "20261019120000_integration_single_urls";
const migration = readFileSync(
  resolve(migrationsDir, name, "migration.sql"),
  "utf8",
).replace(/\r\n/g, "\n");
const schema = readFileSync(
  resolve(__dirname, "../../prisma/schema.prisma"),
  "utf8",
).replace(/\r\n/g, "\n");
const statements = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("Fase 5.3 migration: URL única (texto, sem PostgreSQL)", () => {
  it("runs after every migration of the Fases 5.0 to 5.2", () => {
    const names = readdirSync(migrationsDir).filter((entry) =>
      /^\d{14}_/u.test(entry),
    );
    expect(names).toContain(name);
    expect(names.sort().at(-1)).toBe(name);
    expect(name > "20261016180000_exchange_rates").toBe(true);
  });

  it("is purely additive and re-runnable", () => {
    expect(statements).not.toMatch(
      /\b(?:UPDATE\s+"|DELETE FROM|INSERT INTO|DROP TABLE|DROP COLUMN|DROP CONSTRAINT|DROP INDEX|DROP TYPE|TRUNCATE|ALTER COLUMN|RENAME)\b/iu,
    );
    for (const match of statements.matchAll(/CREATE (?:UNIQUE )?INDEX (\S+)/gu))
      expect(match[1]).toBe("IF");
    for (const match of statements.matchAll(/CREATE TABLE (\S+)/gu))
      expect(match[1]).toBe("IF");
    for (const match of statements.matchAll(/ADD COLUMN (\S+)/gu))
      expect(match[1]).toBe("IF");
    // Every ADD CONSTRAINT and the enum sit in a DO block that tolerates a rerun.
    const guarded = statements.match(/WHEN duplicate_object THEN NULL/gu) ?? [];
    expect(guarded).toHaveLength(7);
  });

  it("adds only nullable or defaulted columns to existing tables", () => {
    expect(statements).toMatch(
      /ALTER TABLE "ProviderConversionRuleConfig"\n\s+ADD COLUMN IF NOT EXISTS "productFilterCodes" TEXT\[\] DEFAULT ARRAY\[\]::TEXT\[\];/u,
    );
    expect(statements).toMatch(
      /ALTER TABLE "ProviderConversionRuleEndpoint"\n\s+ADD COLUMN IF NOT EXISTS "publicUrlDisabledAt" TIMESTAMP\(3\);/u,
    );
    expect(statements).toMatch(
      /ADD COLUMN IF NOT EXISTS "integrationEndpointWorkspaceId" TEXT,\n\s+ADD COLUMN IF NOT EXISTS "integrationEndpointId" TEXT;/u,
    );
  });

  it("keeps one live URL per workspace + platform + event, and the receipt idempotent", () => {
    expect(statements).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationEndpoint_live_key"\n\s+ON "IntegrationEndpoint"\("workspaceId", "provider", COALESCE\("eventName", ''\)\)\n\s+WHERE "removedAt" IS NULL;/u,
    );
    expect(statements).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationEndpointEvent_endpoint_ingress_key"\n\s+ON "IntegrationEndpointEvent"\("integrationEndpointId", "ingressKey"\);/u,
    );
    expect(statements).toContain(
      `CHECK (("kind" = 'sales_platform') = ("eventName" IS NULL))`,
    );
    expect(statements).toContain(
      `CHECK ("status" IN ('pending', 'routed', 'unattributed', 'ignored', 'invalid'))`,
    );
  });

  it("matches the Prisma schema", () => {
    expect(schema).toMatch(
      /enum IntegrationEndpointKind \{\n\s+sales_platform\n\s+automation_event\n\}/u,
    );
    expect(schema).toMatch(/model IntegrationEndpoint \{/u);
    expect(schema).toMatch(/model IntegrationEndpointEvent \{/u);
    expect(schema).toMatch(
      /productFilterCodes\s+String\[\]\s+@default\(\[\]\)/u,
    );
    expect(schema).toMatch(/publicUrlDisabledAt\s+DateTime\?/u);
    expect(schema).toMatch(
      /@@unique\(\[integrationEndpointId, ingressKey\], map: "IntegrationEndpointEvent_endpoint_ingress_key"\)/u,
    );
    expect(schema).toMatch(
      /integrationEndpoint\s+IntegrationEndpoint\?\s+@relation\(fields: \[integrationEndpointWorkspaceId, integrationEndpointId\], references: \[workspaceId, id\], onDelete: SetNull/u,
    );
  });

  it("deletes the new tables in the workspace removal script before their parents", () => {
    const script = readFileSync(
      resolve(__dirname, "../../scripts/delete-workspace.js"),
      "utf8",
    );
    const order = [
      ...script.match(/const order = \[([\s\S]*?)\];/u)![1]!.matchAll(/"(\w+)"/gu),
    ].map((match) => match[1]!);
    expect(order.indexOf("inboundWebhookDelivery")).toBeLessThan(
      order.indexOf("integrationEndpoint"),
    );
    expect(order.indexOf("integrationEndpointEvent")).toBeLessThan(
      order.indexOf("integrationEndpoint"),
    );
    expect(order).toContain("integrationEndpoint");
  });
});
