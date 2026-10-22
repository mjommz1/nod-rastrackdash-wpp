import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    __dirname,
    "../prisma/migrations/20261005120000_kommo_crm_stage_conversions/migration.sql",
  ),
  "utf8",
);
describe("Kommo additive migration", () => {
  it("covers every sender schema field with exact additive SQL and fail-closed constraints", () => {
    const schema = readFileSync(
      resolve(__dirname, "../prisma/schema.prisma"),
      "utf8",
    );
    const model = schema.match(
      /model KommoConversionDedupe \{([\s\S]*?)\n\}/,
    )![1];
    const senderFields = [
      ...model.matchAll(/^\s+(sender\w+)\s+(Int|Boolean|String\?)([^\n]*)/gm),
    ];
    expect(senderFields.map((match) => match[1]).sort()).toEqual([
      "senderAttempts",
      "senderLeaseToken",
      "senderRetryable",
    ]);
    const sql = readFileSync(
      resolve(
        __dirname,
        "../prisma/migrations/20261005160000_kommo_sender_fail_closed/migration.sql",
      ),
      "utf8",
    );
    const types: Record<string, string> = {
      Int: "INTEGER NOT NULL",
      Boolean: "BOOLEAN NOT NULL",
      "String?": "TEXT",
    };
    for (const [, field, type, suffix] of senderFields) {
      const defaultValue = suffix.match(/@default\((.*?)\)/)?.[1];
      expect(sql).toContain(
        `ADD COLUMN "${field}" ${types[type]}${defaultValue ? ` DEFAULT ${defaultValue}` : ""}`,
      );
    }
    expect(sql.match(/ADD COLUMN /g)).toHaveLength(senderFields.length);
    expect(sql).toContain(
      'CHECK ("senderAttempts" >= 0 AND "senderAttempts" <= 5)',
    );
    expect(sql).toContain('CHECK ("senderRetryable" = false)');
    expect(sql).toContain(
      'CHECK ("senderLeaseToken" IS NULL OR "senderAttempts" > 0)',
    );
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|UPDATE)\b/i);
  });
  it("adds durable account/deal fences without altering historical migrations", () => {
    for (const table of [
      "KommoConnection",
      "KommoPipelineCatalog",
      "KommoConversionRule",
      "KommoWebhookEvent",
      "KommoConversionDedupe",
    ])
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    expect(migration).toContain(
      '"KommoConversionDedupe_workspaceId_verifiedAccountId_dealId_eventName_key"',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("connectionId") REFERENCES "KommoConnection"',
    );
    expect(migration).toContain(
      "-- Additive only. Do not apply from this change set",
    );
  });
});
