import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = (name: string) =>
  readFileSync(
    resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`),
    "utf8",
  );
const code = (sql: string) => sql.replace(/--.*$/gm, "");
const schema = readFileSync(
  resolve(__dirname, "../../prisma/schema.prisma"),
  "utf8",
);

describe("Fase 4.0 migrations (additive)", () => {
  it("builds the conversion composite key alone, atomically and without data changes", () => {
    const sql = code(
      migration("20261016090000_conversion_event_log_workspace_id_key"),
    ).trim();
    // Single statement: the only full-table work of this phase stays isolated.
    expect(sql.split(";").filter((part) => part.trim())).toHaveLength(1);
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "ConversionEventLog_workspace_id_key" ON "ConversionEventLog"("workspaceId", "id")',
    );
    expect(sql).not.toMatch(/CONCURRENTLY|\bUPDATE\b|\bDELETE\b|\bDROP\b/i);
    expect(schema).toMatch(
      /@@unique\(\[workspaceId, id\], map: "ConversionEventLog_workspace_id_key"\)/,
    );
  });

  it("enforces workspace identity and separate audit/production purchase claims", () => {
    const sql = migration("20261016090100_provider_purchase_claim");
    expect(sql).toContain('UNIQUE INDEX "ProviderPurchaseClaim_identity_key"');
    expect(sql).toContain('("workspaceId", "effectMode", "purchaseKey")');
    expect(sql).toContain("\"effectMode\" = 'observation'");
    expect(sql).toContain("\"effectMode\" = 'production'");
    expect(sql).toContain('"outboxPending" BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain('FOREIGN KEY ("workspaceId", "winnerExecutionId")');
    expect(sql).toContain(
      'FOREIGN KEY ("workspaceId", "conversionEventLogId")',
    );
    expect(sql).not.toMatch(
      /"(?:phone|accountRef|orderRef|rawPayload|integration_key|secret)"/,
    );
    expect(code(sql)).not.toMatch(/\b(?:DELETE FROM|INSERT INTO|UPDATE ")/);
  });

  it("adds the routing mode without touching existing numbers", () => {
    const sql = code(migration("20261016090200_inbound_webhook_meta_routing_mode"));
    expect(sql).toContain(
      "CREATE TYPE \"InboundWebhookMetaRoutingMode\" AS ENUM ('inherit_workspace', 'channel_override')",
    );
    // Nullable column added first (existing rows stay NULL = legacy), then
    // the default only for numbers created afterwards.
    expect(sql).toContain(
      'ALTER TABLE "InboundWebhookChannel" ADD COLUMN "metaRoutingMode" "InboundWebhookMetaRoutingMode";',
    );
    expect(sql).toContain(
      'ALTER TABLE "InboundWebhookChannel" ALTER COLUMN "metaRoutingMode" SET DEFAULT \'inherit_workspace\';',
    );
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|NOT NULL|CREATE TABLE)\b/i);
    expect(schema).toMatch(
      /metaRoutingMode\s+InboundWebhookMetaRoutingMode\?\s+@default\(inherit_workspace\)/,
    );
  });

  it("certifies only the validated v1 message parsers and never activates production", () => {
    const sql = code(migration("20261016090300_validated_parser_certification"));
    expect(sql).toMatch(/UPDATE "InboundWebhookParserRelease"/);
    expect(sql).toContain(
      "\"provider\" IN ('data_crazy', 'gupshup', 'umbler')",
    );
    expect(sql).toContain("\"version\" = 'v1'");
    expect(sql).toContain("\"status\" = 'observation_only'");
    expect(sql).not.toContain("retired'");
    // Meta Cloud keeps its built-in eligibility; automation releases untouched.
    expect(sql).not.toMatch(/meta_cloud|automation-v1/);
    // No connection, channel or rule is promoted: production stays per rule.
    expect(sql).not.toMatch(
      /InboundWebhookConnection|InboundWebhookChannel|ProviderConversionRuleConfig|productionActivatedAt|certifiedByUserId/,
    );
    expect(sql.match(/\bUPDATE\b/g)).toHaveLength(1);
  });

  it("does not port the SaaS WhatsApp destination binding", () => {
    expect(schema).not.toMatch(/whatsappBinding/);
  });
});
