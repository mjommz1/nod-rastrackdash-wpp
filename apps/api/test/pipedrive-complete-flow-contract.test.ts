import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  observationHarness,
  payload,
  ruleInput,
} from "./support/pipedrive-observation-harness";
import { actor } from "./support/pipedrive-harness";

beforeEach(() => {
  vi.stubEnv(
    "PIPEDRIVE_CRM_ENCRYPTION_KEY",
    Buffer.alloc(32, 7).toString("base64"),
  );
  vi.stubEnv("API_PUBLIC_URL", "https://api.synthetic.example.invalid");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Pipedrive additive read model and authored SQL contract", () => {
  it("returns secret-free webhook lifecycle/receipt state and aggregate list counts", async () => {
    const h = observationHarness();
    const c = await h.seed();
    expect((await h.service.list("workspace-a"))[0]).toMatchObject({
      counts: { pipelines: 2, rules: 0 },
      webhook: {
        configured: false,
        version: 0,
        rotatedAt: null,
        lastReceivedAt: null,
      },
    });
    const secret = await h.webhooks.rotateSecret("workspace-a", c.id, actor);
    const token = new URL(secret.webhookUrl).searchParams.get("token")!;
    await h.webhooks.createRule("workspace-a", c.id, actor, ruleInput);
    await h.webhooks.receive(c.id, token, payload(h.now), "application/json");
    const publicView = (await h.service.list("workspace-a"))[0]!;
    expect(publicView).toMatchObject({
      counts: { pipelines: 2, rules: 1 },
      webhook: {
        configured: true,
        version: 1,
        rotatedAt: h.now.toISOString(),
        lastReceivedAt: h.now.toISOString(),
      },
    });
    expect(JSON.stringify(publicView)).not.toContain(token);
    expect(JSON.stringify(publicView)).not.toMatch(
      /webhookSecretHash|webhookUrl|accessToken/,
    );
    await h.webhooks.revokeSecret("workspace-a", c.id, actor);
    expect((await h.service.get("workspace-a", c.id)).webhook).toMatchObject({
      configured: false,
      version: 2,
      rotatedAt: null,
      lastReceivedAt: h.now.toISOString(),
    });
  });
  it("increments aggregate revision and monotonic snapshot time for every rule write", async () => {
    const h = observationHarness();
    const c = await h.seed();
    const before = await h.service.get("workspace-a", c.id);
    const rule = await h.webhooks.createRule(
      "workspace-a",
      c.id,
      actor,
      ruleInput,
    );
    const created = await h.service.get("workspace-a", c.id);
    await h.webhooks.updateRule("workspace-a", c.id, rule.id, actor, {
      name: "Renamed rule",
    });
    const changed = await h.service.get("workspace-a", c.id);
    await h.webhooks.removeRule("workspace-a", c.id, rule.id, actor);
    const deleted = await h.service.get("workspace-a", c.id);
    expect(
      [before, created, changed, deleted].map((r) => r.mutationRevision),
    ).toEqual([
      before.mutationRevision!,
      before.mutationRevision! + 1,
      before.mutationRevision! + 2,
      before.mutationRevision! + 3,
    ]);
    expect(new Date(created.updatedAt).getTime()).toBeGreaterThan(
      +new Date(before.updatedAt),
    );
    expect(new Date(changed.updatedAt).getTime()).toBeGreaterThan(
      +new Date(created.updatedAt),
    );
    expect(new Date(deleted.updatedAt).getTime()).toBeGreaterThan(
      +new Date(changed.updatedAt),
    );
  });
  it("distinguishes unavailable persistence from an absent scoped connection without DB text", async () => {
    const h = observationHarness();
    await expect(h.service.get("workspace-a", "missing")).rejects.toMatchObject(
      { status: 404, response: { code: "pipedrive_connection_not_found" } },
    );
    h.client.pipedriveConnection.findFirst.mockRejectedValueOnce(
      new Error("synthetic-private-Prisma-text"),
    );
    await expect(h.service.get("workspace-a", "missing")).rejects.toMatchObject(
      { status: 503, message: "pipedrive_persistence_failed" },
    );
  });
  it("declares production mode/state checks, separate semantic fences, outbox and immutable sender claims in the consolidated additive migration", () => {
    const sql = readFileSync(
      resolve(
        __dirname,
        "../prisma/migrations/20261016120000_pipedrive_integration/migration.sql",
      ),
      "utf8",
    );
    expect(sql).not.toMatch(
      /\b(?:DROP|DELETE FROM|TRUNCATE|INSERT INTO|UPDATE "|ALTER TYPE)\b/i,
    );
    expect(sql).toContain('ADD CONSTRAINT "PipedriveConversionRule_mode_check"');
    expect(sql).toContain('ADD CONSTRAINT "PipedriveWebhookEvent_state_check"');
    expect(sql).toContain("\"mode\" IN ('observation', 'production')");
    expect(sql).toContain("'materialized'");
    expect(sql).toContain(
      '"workspaceId", "verifiedAccountId", "dealId", "eventName", "mode"',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("workspaceId", "conversionEventLogId") REFERENCES "ConversionEventLog"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT',
    );
    expect(sql).toContain(
      '"senderAttempts" IN (0, 1) AND NOT "senderRetryable"',
    );
    expect(sql).toContain(
      '("publicationLeaseToken" IS NULL) = ("publicationLeaseExpiresAt" IS NULL)',
    );
    expect(sql).not.toMatch(/senderLeaseExpiresAt|senderNextAttemptAt/);
    expect(sql).toContain('"productionActivatedAt" IS NOT NULL');
  });
});
