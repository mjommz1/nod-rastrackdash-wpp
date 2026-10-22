import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = resolve(__dirname, "../../prisma/migrations");
const name = "20261016180000_exchange_rates";
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

describe("Fase 5.2 migration: cotações PTAX (texto, sem PostgreSQL)", () => {
  it("runs after the Fase 5.1 migration", () => {
    const names = readdirSync(migrationsDir).filter((entry) =>
      /^\d{14}_/u.test(entry),
    );
    expect(names).toContain(name);
    expect(name > "20261016140000_conversion_currency").toBe(true);
  });

  it("only creates the new ExchangeRate table and its indexes", () => {
    expect(statements).toMatch(/CREATE TABLE IF NOT EXISTS "ExchangeRate"/u);
    expect(statements).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "ExchangeRate_date_baseCurrency_quoteCurrency_key"/u,
    );
    expect(statements).toMatch(
      /CREATE INDEX IF NOT EXISTS "ExchangeRate_baseCurrency_quoteCurrency_date_idx"/u,
    );
    expect(statements).not.toMatch(/\bALTER\b/u);
    expect(statements).not.toMatch(/\bUPDATE\b/u);
    expect(statements).not.toMatch(/\bDELETE\b/u);
    expect(statements).not.toMatch(/\bDROP\b/u);
    expect(statements).not.toMatch(/INSERT INTO/iu);
    expect(statements).not.toMatch(/CREATE TYPE/u);
  });

  it("matches the Prisma schema", () => {
    expect(schema).toMatch(/model ExchangeRate \{/u);
    expect(schema).toMatch(/date\s+DateTime\s+@db\.Date/u);
    expect(schema).toMatch(/rate\s+Decimal\s+@db\.Decimal\(18, 8\)/u);
    expect(schema).toMatch(
      /@@unique\(\[date, baseCurrency, quoteCurrency\]\)/u,
    );
  });
});
