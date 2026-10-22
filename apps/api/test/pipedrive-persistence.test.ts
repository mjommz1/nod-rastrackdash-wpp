import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  pipedriveCatalogStates,
  pipedriveConnectionStatuses,
  pipedrivePipelineSchema,
} from "@wpptrack/shared";
import { parsePrismaModels } from "./support/prisma-schema-fk-graph";

const schema = readFileSync(
  resolve(__dirname, "../prisma/schema.prisma"),
  "utf8",
);
const models = parsePrismaModels(schema);
const names = [
  "PipedriveConnection",
  "PipedrivePipelineCatalog",
  "PipedriveStageCatalog",
] as const;
const migrationPath = resolve(
  __dirname,
  "../prisma/migrations/20261016120000_pipedrive_integration/migration.sql",
);
const sql = () => readFileSync(migrationPath, "utf8");
const body = (name: string) =>
  schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
const columns = (list: string) =>
  [...list.matchAll(/"(\w+)"/g)].map((m) => m[1]);
const prismaColumns = (list: string) => list.split(",").map((s) => s.trim());

// Interpret declared SQL key tuples over synthetic rows only. These assertions
// are structural counterexamples, NOT PostgreSQL execution or runtime FK proof.
function foreignKeys() {
  return [
    ...sql().matchAll(
      /ALTER TABLE "(\w+)" ADD CONSTRAINT "[^"]+" FOREIGN KEY \(([^)]+)\) REFERENCES "(\w+)"\(([^)]+)\) ON DELETE (\w+) ON UPDATE (\w+)/g,
    ),
  ].map((m) => ({
    child: m[1],
    fields: columns(m[2]),
    parent: m[3],
    references: columns(m[4]),
    onDelete: m[5],
    onUpdate: m[6],
  }));
}
type Row = Record<string, string | null>;
type Rows = Record<string, Row[]>;
function satisfiesForeignKeys(rows: Rows) {
  return foreignKeys().every((fk) =>
    (rows[fk.child] ?? []).every((row) =>
      (rows[fk.parent] ?? []).some((parent) =>
        fk.fields.every((field, i) => row[field] === parent[fk.references[i]]),
      ),
    ),
  );
}
function fixture(): Rows {
  return {
    Workspace: [{ id: "workspace-a" }, { id: "workspace-b" }],
    PipedriveConnection: [
      { id: "connection-a", workspaceId: "workspace-a" },
      { id: "connection-b", workspaceId: "workspace-b" },
    ],
    PipedrivePipelineCatalog: [
      {
        connectionId: "connection-a",
        workspaceId: "workspace-a",
        pipelineId: "1",
      },
      {
        connectionId: "connection-b",
        workspaceId: "workspace-b",
        pipelineId: "1",
      },
    ],
    PipedriveStageCatalog: [
      {
        connectionId: "connection-a",
        workspaceId: "workspace-a",
        pipelineId: "1",
        stageId: "2",
      },
    ],
  };
}

describe("Pipedrive persistence structural contracts (no database execution)", () => {
  it("adds only dedicated connection, pipeline and stage models with Workspace relations", () => {
    expect(
      [...models.keys()].filter((name) => name.startsWith("Pipedrive")),
    ).toEqual([
      ...names,
      "PipedriveConversionRule",
      "PipedriveWebhookEvent",
      "PipedriveConversionDedupe",
    ]);
    for (const name of names) {
      const model = models.get(name)!;
      expect(model).toBeDefined();
      expect(model.fields.find((f) => f.name === "workspace")?.attrs).toContain(
        "onDelete: Restrict",
      );
      expect(
        models
          .get("Workspace")!
          .fields.some((f) => f.type === name && f.isArray),
      ).toBe(true);
    }
    expect(body(names[0])).not.toMatch(
      /webhookSecretPlaintext|companyDomain|verifiedCompanyId/i,
    );
  });

  it("stores only the required encrypted token triple and credential fence metadata", () => {
    const fields = models.get(names[0])!.fields;
    expect(
      fields.filter((f) => /token/i.test(f.name)).map((f) => f.name),
    ).toEqual(["accessTokenEncrypted", "accessTokenIv", "accessTokenTag"]);
    for (const name of [
      "accessTokenEncrypted",
      "accessTokenIv",
      "accessTokenTag",
    ]) {
      expect(fields.find((f) => f.name === name)).toMatchObject({
        type: "String",
        optional: false,
      });
    }
    expect(body(names[0])).toMatch(
      /credentialGeneration\s+Int\s+@default\(1\)/,
    );
    expect(body(names[0])).toMatch(
      /credentialHealthy\s+Boolean\s+@default\(false\)/,
    );
    expect(body(names[0])).toMatch(
      /allowedChannelRouteIds\s+String\[\]\s+@default\(\[\]\)/,
    );
    expect(body(names[0])).toContain(
      "@@unique([workspaceId, verifiedAccountId])",
    );
    expect(body(names[0])).toContain("@@unique([id, workspaceId])");
    expect(sql()).toContain('CHECK ("credentialGeneration" > 0)');
    for (const status of pipedriveConnectionStatuses)
      expect(sql()).toContain(`'${status}'`);
    for (const state of pipedriveCatalogStates)
      expect(sql()).toContain(`'${state}'`);
  });

  it("preserves nullable sort fields and pipelines with zero stages without fake stage IDs", () => {
    expect(body(names[1])).toMatch(/pipelineSort\s+Int\?/);
    expect(body(names[2])).toMatch(/stageSort\s+Int\?/);
    expect(models.get(names[1])!.fields.some((f) => f.name === "stageId")).toBe(
      false,
    );
    const rows = fixture();
    rows.PipedriveStageCatalog = [];
    expect(satisfiesForeignKeys(rows)).toBe(true);
    expect(
      pipedrivePipelineSchema.parse({
        id: "1",
        name: "Empty pipeline",
        sort: null,
        stages: [],
      }),
    ).toEqual({
      id: "1",
      name: "Empty pipeline",
      sort: null,
      stages: [],
    });
    expect(body(names[2])).toContain(
      "@@unique([connectionId, pipelineId, stageId])",
    );
  });

  it("has exact scalar column/type/nullability/default parity with the additive SQL", () => {
    const migration = sql();
    expect(
      [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]).slice(0, 3),
    ).toEqual(names);
    expect(migration).not.toMatch(
      /\b(?:DROP|DELETE|TRUNCATE|INSERT|UPDATE|ALTER TYPE)\b(?!\s+RESTRICT)/i,
    );
    const types: Record<string, string> = {
      String: "TEXT",
      Int: "INTEGER",
      Boolean: "BOOLEAN",
      DateTime: "TIMESTAMP(3)",
    };
    for (const name of names) {
      const table = migration.match(
        new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`),
      )![1];
      const actual = [...table.matchAll(/^\s+"(\w+)"\s+([^\n,]+),?$/gm)].map(
        (m) => [m[1], m[2]],
      );
      const expected = models
        .get(name)!
        .fields.filter((f) => f.type in types)
        .map((f) => {
          let declaration =
            types[f.type] +
            (f.isArray ? "[]" : "") +
            (!f.optional && !f.isArray ? " NOT NULL" : "");
          const defaultValue = f.attrs.match(
            /@default\(("[^"]*"|\[\]|true|false|\d+|now\(\))\)/,
          )?.[1];
          if (defaultValue)
            declaration +=
              " DEFAULT " +
              (defaultValue === "now()"
                ? "CURRENT_TIMESTAMP"
                : defaultValue === "[]"
                  ? "ARRAY[]::TEXT[]"
                  : defaultValue.replace(/"/g, "'"));
          return [f.name, declaration];
        });
      expect(actual, name).toEqual(expected);
      expect(table).toContain(`PRIMARY KEY ("id")`);
    }
  });

  it("has exact unique/index and restrictive composite FK parity with schema", () => {
    const expectedIndexes: string[] = [];
    const expectedFks: ReturnType<typeof foreignKeys> = [];
    for (const name of names) {
      for (const m of body(name).matchAll(/@@(unique|index)\(\[([^\]]+)\]\)/g))
        expectedIndexes.push(
          `${name}:${m[1]}:${prismaColumns(m[2]).join(",")}`,
        );
      for (const field of models.get(name)!.fields) {
        const relation = field.attrs.match(
          /@relation\(fields: \[([^\]]+)\], references: \[([^\]]+)\], onDelete: (\w+), onUpdate: (\w+)\)/,
        );
        if (relation)
          expectedFks.push({
            child: name,
            fields: prismaColumns(relation[1]),
            parent: field.type,
            references: prismaColumns(relation[2]),
            onDelete: relation[3].toUpperCase(),
            onUpdate: relation[4].toUpperCase(),
          });
      }
    }
    const actualIndexes = [
      ...sql().matchAll(
        /CREATE (UNIQUE )?INDEX "[^"]+" ON "(\w+)"\(([^)]+)\)/g,
      ),
    ]
      .filter((m) => (names as readonly string[]).includes(m[2]))
      .map(
        (m) =>
          `${m[2]}:${m[1] ? "unique" : "index"}:${columns(m[3]).join(",")}`,
      )
      // Field-level @unique (webhook secret hash) is not an @@ declaration.
      .filter((v) => v !== "PipedriveConnection:unique:webhookSecretHash");
    expect(actualIndexes.sort()).toEqual(expectedIndexes.sort());
    expect(
      foreignKeys().filter((fk) =>
        (names as readonly string[]).includes(fk.child),
      ),
    ).toEqual(expectedFks);
    expect(expectedFks).toHaveLength(5);
    expect(
      expectedFks.every(
        (fk) => fk.onDelete === "RESTRICT" || fk.onDelete === "Restrict",
      ),
    ).toBe(true);
    expect(expectedFks.every((fk) => fk.onUpdate === "RESTRICT")).toBe(true);
    expect(body(names[1])).toContain("@@index([workspaceId, connectionId])");
    expect(body(names[1])).toContain("@@index([connectionId, available])");
    expect(body(names[2])).toContain("@@index([workspaceId, connectionId])");
    expect(body(names[2])).toContain(
      "@@index([connectionId, pipelineId, available])",
    );
    expect(body(names[0])).toContain("@@index([workspaceId, status])");
  });

  it("accepts matching relation tuples and rejects an orphan connection", () => {
    const rows = fixture();
    expect(satisfiesForeignKeys(rows)).toBe(true);
    rows.PipedrivePipelineCatalog[0].connectionId = "missing";
    expect(satisfiesForeignKeys(rows)).toBe(false);
  });

  it("allows pipeline/stage IDs to repeat across connections, but rejects duplicate catalog keys", () => {
    const indexes = [
      ...sql().matchAll(
        /CREATE UNIQUE INDEX "[^"]+" ON "(Pipedrive\w+Catalog)"\(([^)]+)\)/g,
      ),
    ].map((m) => ({ table: m[1], fields: columns(m[2]) }));
    const rows = fixture();
    rows.PipedriveStageCatalog.push({
      connectionId: "connection-b",
      workspaceId: "workspace-b",
      pipelineId: "1",
      stageId: "2",
    });
    const unique = () =>
      indexes.every(({ table, fields }) =>
        rows[table].every(
          (row, i) =>
            !rows[table]
              .slice(0, i)
              .some((previous) =>
                fields.every((field) => row[field] === previous[field]),
              ),
        ),
      );
    expect(unique()).toBe(true);
    rows.PipedriveStageCatalog.push({ ...rows.PipedriveStageCatalog[0] });
    expect(unique()).toBe(false);
    rows.PipedriveStageCatalog.pop();
    rows.PipedrivePipelineCatalog.push({ ...rows.PipedrivePipelineCatalog[0] });
    expect(unique()).toBe(false);
  });

  it.each([
    "pipeline-workspace",
    "stage-workspace",
    "stage-connection",
    "stage-pipeline",
  ])(
    "rejects %s mismatch even when both workspaces and connections exist",
    (mismatch) => {
      const rows = fixture();
      if (mismatch === "pipeline-workspace")
        rows.PipedrivePipelineCatalog[0].workspaceId = "workspace-b";
      if (mismatch === "stage-workspace")
        rows.PipedriveStageCatalog[0].workspaceId = "workspace-b";
      if (mismatch === "stage-connection")
        rows.PipedriveStageCatalog[0].connectionId = "connection-b";
      if (mismatch === "stage-pipeline")
        rows.PipedriveStageCatalog[0].pipelineId = "missing";
      expect(satisfiesForeignKeys(rows)).toBe(false);
    },
  );

  it("scopes verified account uniqueness to workspace while allowing unverified connections", () => {
    const match = [
      ...sql().matchAll(
        /CREATE UNIQUE INDEX "[^"]+" ON "PipedriveConnection"\(([^)]+)\)/g,
      ),
    ]
      .map((m) => columns(m[1]))
      .find((fields) => fields.includes("verifiedAccountId"))!;
    expect(match).toEqual(["workspaceId", "verifiedAccountId"]);
    const unique = (rows: Row[]) =>
      rows.every(
        (row, i) =>
          match.some((field) => row[field] === null) ||
          !rows
            .slice(0, i)
            .some((previous) =>
              match.every((field) => previous[field] === row[field]),
            ),
      );
    const rows = [
      { workspaceId: "workspace-a", verifiedAccountId: "1" },
      { workspaceId: "workspace-b", verifiedAccountId: "1" },
    ];
    expect(unique(rows)).toBe(true);
    expect(unique([...rows, rows[0]])).toBe(false);
    expect(
      unique([
        { workspaceId: "workspace-a", verifiedAccountId: null },
        { workspaceId: "workspace-a", verifiedAccountId: null },
      ]),
    ).toBe(true);
  });
});
