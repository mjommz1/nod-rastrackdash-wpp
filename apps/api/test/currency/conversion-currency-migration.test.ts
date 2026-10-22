import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = resolve(__dirname, "../../prisma/migrations");
const name = "20261016140000_conversion_currency";
const migration = readFileSync(
  resolve(migrationsDir, name, "migration.sql"),
  "utf8",
);
const schema = readFileSync(
  resolve(__dirname, "../../prisma/schema.prisma"),
  "utf8",
);
const statements = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("Fase 5.1 migration: moeda das conversões (texto, sem PostgreSQL)", () => {
  it("runs after the migrations that were already in main (Fase 4b)", () => {
    const names = readdirSync(migrationsDir).filter((entry) =>
      /^\d{14}_/u.test(entry),
    );
    expect(names).toContain(name);
    expect(name > "20261016130100_unnichat_parser_releases").toBe(true);
  });

  it("is additive: a new enum, a defaulted column and a nullable column", () => {
    expect(statements).toContain(
      `CREATE TYPE "CurrencyCode" AS ENUM ('BRL', 'USD', 'EUR')`,
    );
    expect(statements).toMatch(
      /ALTER TABLE "Workspace"\s+ADD COLUMN IF NOT EXISTS "conversionCurrency" "CurrencyCode" NOT NULL DEFAULT 'BRL';/u,
    );
    expect(statements).toMatch(
      /ALTER TABLE "MetaReportingAccount"\s+ADD COLUMN IF NOT EXISTS "currencyOverride" "CurrencyCode";/u,
    );
  });

  it("never rewrites, deletes or backfills existing rows", () => {
    expect(statements).not.toMatch(/\bUPDATE\b/u);
    expect(statements).not.toMatch(/\bDELETE\b/u);
    expect(statements).not.toMatch(/\bDROP\b/u);
    expect(statements).not.toMatch(/INSERT INTO/iu);
    expect(statements).not.toMatch(/ALTER TYPE/u);
    expect(statements).not.toMatch(/ALTER COLUMN/u);
  });

  it("leaves PTAX (ExchangeRate) for its own Fase 5.2 migration", () => {
    expect(statements).not.toContain("ExchangeRate");
  });

  it("matches the Prisma schema", () => {
    expect(schema).toMatch(/enum CurrencyCode \{\s+BRL\s+USD\s+EUR\s+\}/u);
    expect(schema).toMatch(/conversionCurrency CurrencyCode\s+@default\(BRL\)/u);
    expect(schema).toMatch(/currencyOverride\s+CurrencyCode\?/u);
  });
});
