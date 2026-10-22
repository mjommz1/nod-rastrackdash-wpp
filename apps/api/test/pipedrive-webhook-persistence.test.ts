import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { conversionEventNameSchema } from "@wpptrack/shared";
import { parsePrismaModels } from "./support/prisma-schema-fk-graph";
const schema = readFileSync(
  resolve(__dirname, "../prisma/schema.prisma"),
  "utf8",
);
// One consolidated, additive migration (ordered after the last applied one).
const sql = readFileSync(
  resolve(
    __dirname,
    "../prisma/migrations/20261016120000_pipedrive_integration/migration.sql",
  ),
  "utf8",
);
const baseSql = sql;
const evolution = "";
const models = parsePrismaModels(schema);
const names = [
  "PipedriveConversionRule",
  "PipedriveWebhookEvent",
  "PipedriveConversionDedupe",
];
const tuple = (v: string) => [...v.matchAll(/"(\w+)"/g)].map((m) => m[1]);
describe("Pipedrive migration ordering (student edition)", () => {
  it("runs after the ConversionEventLog (workspaceId, id) key it references and before Unnichat (Fase 4b)", () => {
    const dir = resolve(__dirname, "../prisma/migrations");
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const own = "20261016120000_pipedrive_integration";
    const key = "20261016090000_conversion_event_log_workspace_id_key";
    expect(names).toContain(own);
    expect(names.indexOf(own)).toBeLessThan(
      names.indexOf("20261016130000_unnichat_inbound_provider"),
    );
    expect(names.indexOf(key)).toBeGreaterThan(-1);
    expect(names.indexOf(key)).toBeLessThan(names.indexOf(own));
    expect(readFileSync(resolve(dir, key, "migration.sql"), "utf8")).toContain(
      'ON "ConversionEventLog"("workspaceId", "id")',
    );
    expect(sql).toContain(
      'REFERENCES "ConversionEventLog"("workspaceId", "id") ON DELETE RESTRICT',
    );
    // Additive only: no statement touches an existing table.
    for (const match of sql.matchAll(/ALTER TABLE "(\w+)"/g))
      expect(match[1]).toMatch(/^Pipedrive/);
  });
});
describe("Pipedrive webhook SQL/schema structural invariants (no PostgreSQL)", () => {
  it("creates only the six dedicated tables and never alters existing ones", () => {
    expect(
      [...baseSql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]),
    ).toEqual([
      "PipedriveConnection",
      "PipedrivePipelineCatalog",
      "PipedriveStageCatalog",
      ...names,
    ]);
    expect(baseSql).not.toMatch(
      /\b(?:DROP|DELETE|TRUNCATE|INSERT|UPDATE|ALTER TYPE|ADD COLUMN|ALTER COLUMN)\b(?!\s+RESTRICT)/i,
    );
    for (const altered of baseSql.matchAll(/ALTER TABLE "(\w+)"/g))
      expect(altered[1]).toMatch(/^Pipedrive/);
  });
  it.each(names)("preserves exact scalar SQL parity for %s", (name) => {
    const table = sql.match(
      new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`),
    )![1];
    const columns = [...table.matchAll(/^\s+"(\w+)"\s+([^\n,]+),?$/gm)].map(
      (m) => [m[1], m[2]],
    );
    const types: Record<string, string> = {
      String: "TEXT",
      Int: "INTEGER",
      BigInt: "BIGINT",
      DateTime: "TIMESTAMP(3)",
      Boolean: "BOOLEAN",
      Json: "JSONB",
    };
    const expected = models
      .get(name)!
      .fields.filter((f) => f.type in types)
      .map((f) => {
        let definition = types[f.type] + (!f.optional ? " NOT NULL" : "");
        const d = f.attrs.match(
          /@default\(("[^"]*"|true|false|\d+|now\(\))\)/,
        )?.[1];
        if (d)
          definition +=
            " DEFAULT " +
            (d === "now()" ? "CURRENT_TIMESTAMP" : d.replace(/"/g, "'"));
        return [f.name, definition];
      });
    for (const alteration of evolution.matchAll(
      /ALTER TABLE "(\w+)" ([\s\S]*?);/g,
    )) {
      if (alteration[1] !== name) continue;
      for (const addition of alteration[2].matchAll(
        /ADD COLUMN\s+"(\w+)"\s+([^,;]+)/g,
      ))
        columns.push([addition[1], addition[2].trim()]);
    }
    expect(columns.sort()).toEqual(expected.sort());
  });
  it("enforces workspace/connection ownership, exact lead ownership and account/deal dedupe source", () => {
    const fks = [
      ...sql.matchAll(
        /ALTER TABLE "(\w+)" ADD CONSTRAINT "[^"]+" FOREIGN KEY \(([^)]+)\) REFERENCES "(\w+)"\(([^)]+)\) ON DELETE (\w+) ON UPDATE (\w+)/g,
      ),
    ]
      .map((m) => ({
        child: m[1],
        fields: tuple(m[2]),
        parent: m[3],
        references: tuple(m[4]),
        onDelete: m[5],
        onUpdate: m[6],
      }))
      .filter((fk) => names.includes(fk.child));
    const expected = names.flatMap((name) =>
      models.get(name)!.fields.flatMap((f) => {
        const r = f.attrs.match(
          /@relation\(fields: \[([^\]]+)\], references: \[([^\]]+)\], onDelete: (\w+), onUpdate: (\w+)\)/,
        );
        return r
          ? [
              {
                child: name,
                fields: r[1].split(",").map((v) => v.trim()),
                parent: f.type,
                references: r[2].split(",").map((v) => v.trim()),
                onDelete: r[3].toUpperCase(),
                onUpdate: r[4].toUpperCase(),
              },
            ]
          : [];
      }),
    );
    expect(fks).toEqual(expected);
    expect(fks).toHaveLength(8);
    const linked = fks.find((f) => f.parent === "PipedriveWebhookEvent")!;
    const source = {
      id: "event-a",
      workspaceId: "workspace-a",
      verifiedAccountId: "1",
      dealId: "1",
    };
    const row: Record<string, string> = {
      sourceEventId: "event-a",
      workspaceId: "workspace-a",
      verifiedAccountId: "1",
      dealId: "1",
    };
    const valid = () =>
      linked.fields.every(
        (field, i) =>
          row[field] === source[linked.references[i] as keyof typeof source],
      );
    expect(valid()).toBe(true);
    for (const field of ["workspaceId", "verifiedAccountId", "dealId"]) {
      const old = row[field];
      row[field] = "foreign";
      expect(valid()).toBe(false);
      row[field] = old;
    }
  });
  it("has exact dedupe/receipt/catalog index parity and hash uniqueness", () => {
    const expected = names.flatMap((name) =>
      [
        ...schema
          .match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))![1]
          .matchAll(/@@(unique|index)\(\[([^\]]+)\](?:, map: "[^"]+")?\)/g),
      ].map(
        (m) =>
          `${name}:${m[1]}:${m[2]
            .split(",")
            .map((v) => v.trim())
            .join(",")}`,
      ),
    );
    expected.push(
      // Partial unique index (WHERE trigger = 'deal_won'): SQL only.
      "PipedriveConversionRule:unique:connectionId,pipelineId,eventName",
    );
    const actual = [
      ...sql.matchAll(
        /CREATE (UNIQUE )?INDEX "([^"]+)" ON "(\w+)"\(([^)]+)\)/g,
      ),
    ]
      .filter(
        (m) =>
          !evolution.includes(`DROP INDEX "${m[2]}"`) &&
          m[3] !== "ConversionEventLog" &&
          ![
            "PipedriveConnection",
            "PipedrivePipelineCatalog",
            "PipedriveStageCatalog",
          ].includes(m[3]),
      )
      .map(
        (m) => `${m[3]}:${m[1] ? "unique" : "index"}:${tuple(m[4]).join(",")}`,
      );
    expect(actual.sort()).toEqual(expected.sort());
  });
  it("enforces modes, triggers, change kinds, the full catalog and coherent leases/retry/value facts", () => {
    expect(sql).toContain("\"mode\" IN ('observation', 'production')");
    expect(sql).toContain(
      '("trigger" = \'deal_won\' AND "stageId" IS NULL AND "eventName" = \'Purchase\')',
    );
    expect(sql).toContain(
      "\"changeKind\" IN ('stage_change', 'deal_won', 'deal_lost', 'ignored')",
    );
    expect(sql).toContain(
      "(\"changeKind\" NOT IN ('deal_lost', 'ignored') OR \"status\" = 'ignored')",
    );
    for (const eventName of conversionEventNameSchema.options)
      expect(sql).toContain(`'${eventName}'`);
    expect(sql).toContain(
      '"status" = \'processing\' AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL',
    );
    expect(sql).toContain(
      '"status" <> \'processing\' AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL',
    );
    expect(sql).toContain('"valuePresent" = ("valueCents" IS NOT NULL)');
    expect(sql).toContain(
      "\"status\" NOT IN ('received', 'retry') OR \"nextAttemptAt\" IS NOT NULL",
    );
  });
});
