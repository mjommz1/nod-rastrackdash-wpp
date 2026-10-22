import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRoutingRules } from "../../src/inbound-webhooks/integration-endpoint-routing";
import { InboundWebhookMaintenanceService } from "../../src/inbound-webhooks/inbound-webhook-maintenance.service";
import { InboundWebhookPayloadEncryptionService } from "../../src/inbound-webhooks/inbound-webhook-payload-encryption.service";
import { IntegrationEndpointsService } from "../../src/inbound-webhooks/integration-endpoints.service";
import { unnichatAutomationConversionIdentity } from "../../src/inbound-webhook-production/provider-conversion-production.service";

/**
 * Fase 5.3 on a real, disposable PostgreSQL 16 with the CURRENT schema
 * (all migrations applied). Parent-run only, same opt-in as the other .pg
 * suites: NOD_META_DISPATCH_PG_OPT_IN=disposable-local-only and a loopback
 * NOD_META_DISPATCH_TEST_PG_URL whose database is nod_meta_dispatch_test_*.
 * Never reads DATABASE_URL, never prints the URL, synthetic data only.
 *
 * Proves at the database level what the in-memory tests assume: one live
 * URL per workspace + platform + event, the idempotent receipt, the status
 * and kind checks, the delivery link that survives a removed URL, the unique
 * keys behind "one send" (purchase claim, conversion dedupe key), the real
 * Prisma shapes of the service/routing queries and the 60-day retention.
 */
const optedIn =
  process.env.NOD_META_DISPATCH_PG_OPT_IN === "disposable-local-only";
function disposableUrl(): string {
  const raw = process.env.NOD_META_DISPATCH_TEST_PG_URL;
  if (!raw) throw new Error("Dedicated disposable PG test URL required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid disposable PG test URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/nod_meta_dispatch_test_[a-z0-9_]+$/.test(url.pathname) ||
    [...url.searchParams.keys()].some(
      (k) => !["schema", "connection_limit", "pool_timeout"].includes(k),
    ) ||
    (url.searchParams.get("schema") ?? "public") !== "public"
  )
    throw new Error(
      "PG harness requires a loopback disposable nod_meta_dispatch_test_* database",
    );
  return raw;
}

const env = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "https://api.example.invalid",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "false",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_CONVERSION_PRODUCTION_ENABLED: "false",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 53).toString("base64"),
};
const day = 24 * 60 * 60 * 1_000;

function uniqueViolation(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002") ||
    /unique|duplicate key/iu.test(String(error))
  );
}

describe.skipIf(!optedIn)("Fase 5.3 URL única on disposable PostgreSQL", () => {
  let db: PrismaClient;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let userId: string;
  let paytRelease: { id: string };
  let service: IntegrationEndpointsService;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: disposableUrl() } } });
    try {
      await db.$connect();
      if ((await db.workspace.count()) || (await db.user.count()))
        throw new Error("nonempty");
    } catch {
      throw new Error(
        "Disposable DB unavailable, nonempty, or current Prisma schema missing; URL withheld",
      );
    }
    const id = randomUUID();
    userId = (
      await db.user.create({ data: { email: `synthetic-${id}@example.invalid` } })
    ).id;
    workspaceId = (
      await db.workspace.create({
        data: { name: "URL única", slug: `url-unica-${id}` },
      })
    ).id;
    otherWorkspaceId = (
      await db.workspace.create({
        data: { name: "Outro", slug: `outro-${id}` },
      })
    ).id;
    // Seeded by the Payt/Unnichat/Umbler migrations.
    paytRelease = await db.inboundWebhookParserRelease.findUniqueOrThrow({
      where: { provider_version: { provider: "payt", version: "automation-v1" } },
    });
    service = new IntegrationEndpointsService(
      db as never,
      env,
      new InboundWebhookPayloadEncryptionService(env),
      { resolve: async () => ({ status: "not_found" }) } as never,
      { ingestRouted: async () => null } as never,
    );
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("keeps ONE live URL per workspace + platform + event (concurrent 'Gerar URL')", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.ensure(workspaceId, { provider: "payt" }, userId),
      ),
    );
    expect(new Set(results.map((endpoint) => endpoint.id)).size).toBe(1);
    expect(
      await db.integrationEndpoint.count({
        where: { workspaceId, provider: "payt", removedAt: null },
      }),
    ).toBe(1);
    // The token is never stored in clear.
    const token = new URL(results[0]!.url!).searchParams.get("token")!;
    const row = await db.integrationEndpoint.findUniqueOrThrow({
      where: { id: results[0]!.id },
    });
    expect(JSON.stringify(row)).not.toContain(token);
    // Unnichat: one URL per event; two events are two URLs.
    const qualified = await service.ensure(
      workspaceId,
      { provider: "unnichat", eventName: "QualifiedLead" },
      userId,
    );
    const purchase = await service.ensure(
      workspaceId,
      { provider: "unnichat", eventName: "Purchase" },
      userId,
    );
    expect(qualified.id).not.toBe(purchase.id);
    // A removed URL leaves the history and frees the slot.
    await service.remove(workspaceId, results[0]!.id, userId);
    const fresh = await service.ensure(workspaceId, { provider: "payt" }, userId);
    expect(fresh.id).not.toBe(results[0]!.id);
    const listed = await service.list(workspaceId, true);
    expect(listed.endpoints.map((endpoint) => endpoint.url)).toEqual(
      listed.endpoints.map(() => null),
    );
    expect((await service.list(otherWorkspaceId, true)).endpoints).toEqual([]);
  });

  it("rejects a raw second live URL and a kind/event mismatch in the database itself", async () => {
    const base = {
      workspaceId: otherWorkspaceId,
      parserReleaseId: paytRelease.id,
      secretHash: "a".repeat(64),
      secretCiphertext: "c",
      secretIv: "i",
      secretTag: "t",
      secretKeyVersion: 1,
    };
    await db.integrationEndpoint.create({
      data: { ...base, provider: "payt", kind: "sales_platform" },
    });
    await expect(
      db.integrationEndpoint.create({
        data: { ...base, provider: "payt", kind: "sales_platform" },
      }),
    ).rejects.toSatisfy(uniqueViolation);
    await expect(
      db.integrationEndpoint.create({
        data: {
          ...base,
          provider: "payt",
          kind: "sales_platform",
          eventName: "Purchase",
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.integrationEndpoint.create({
        data: { ...base, provider: "umbler", kind: "automation_event" },
      }),
    ).rejects.toThrow();
  });

  it("stores the receipt once per (URL, ingress key) and checks its status", async () => {
    const endpoint = await service.ensure(workspaceId, { provider: "payt" }, userId);
    const receipt = {
      workspaceId,
      integrationEndpointId: endpoint.id,
      provider: "payt" as const,
      ingressKey: "ingress-1",
      status: "unattributed",
      reasonCode: "product_without_rule",
      productCode: "PRODB",
      productName: "Mentoria",
      payloadExpiresAt: new Date(Date.now() + 7 * day),
    };
    await db.integrationEndpointEvent.create({ data: receipt });
    await expect(
      db.integrationEndpointEvent.create({ data: receipt }),
    ).rejects.toSatisfy(uniqueViolation);
    await expect(
      db.integrationEndpointEvent.create({
        data: { ...receipt, ingressKey: "ingress-2", status: "sent" },
      }),
    ).rejects.toThrow();
    // Real query shapes of the screens.
    const unattributed = await service.listUnattributed(workspaceId, "payt");
    expect(unattributed.items[0]).toMatchObject({
      productCode: "PRODB",
      reasonLabel: "Produto sem regra",
      retryable: false,
    });
    const products = await service.listProducts(workspaceId, "payt");
    expect(products.products).toEqual([
      expect.objectContaining({ productCode: "PRODB", productName: "Mentoria" }),
    ]);
    const listed = await service.list(workspaceId, false);
    expect(
      listed.endpoints.find((item) => item.id === endpoint.id)?.stats,
    ).toMatchObject({ received: 1, unattributed: 1 });
  });

  it("routes over real rules: loads only live rules of the platform and event with their filter", async () => {
    const connection = await db.inboundWebhookConnection.create({
      data: {
        workspaceId,
        provider: "uazapi",
        displayName: "WhatsApp",
        parserReleaseId: (
          await db.inboundWebhookParserRelease.upsert({
            where: { provider_version: { provider: "uazapi", version: "v1" } },
            create: { provider: "uazapi", version: "v1", status: "certified" },
            update: {},
          })
        ).id,
        status: "observation",
      },
    });
    async function rule(name: string, eventName: string, codes: string[], disabled = false) {
      const conversionRule = await db.conversionRule.create({
        data: {
          workspaceId,
          name,
          triggerType: "provider_automation",
          triggerValue: "payt",
          eventName,
        },
      });
      const providerRule = await db.providerConversionRuleConfig.create({
        data: {
          workspaceId,
          conversionRuleId: conversionRule.id,
          connectionId: connection.id,
          parserReleaseId: paytRelease.id,
          scope: "all_numbers",
          productFilterCodes: codes,
        },
      });
      await db.providerConversionRuleEndpoint.create({
        data: {
          workspaceId,
          providerRuleId: providerRule.id,
          secretHash: "b".repeat(64),
          publicUrlDisabledAt: disabled ? new Date() : null,
        },
      });
      return providerRule;
    }
    const filtered = await rule("Compra A", "Purchase", ["PRODA"]);
    const closedOldUrl = await rule("Compra todos", "Purchase", [], true);
    await rule("Checkout", "InitiateCheckout", []);
    const loaded = await loadRoutingRules(db, {
      workspaceId,
      provider: "payt",
      eventName: "Purchase",
    });
    // A closed old URL does not remove the rule from the URL única.
    expect(loaded.map((item) => item.id).sort()).toEqual(
      [filtered.id, closedOldUrl.id].sort(),
    );
    expect(loaded.find((item) => item.id === filtered.id)?.productFilterCodes).toEqual([
      "PRODA",
    ]);
    // The legacy URL checklist lists the open old URL, hides the closed one
    // that never received anything.
    const { legacyUrls } = await service.list(workspaceId, true);
    expect(legacyUrls.map((url) => url.ruleName).sort()).toEqual([
      "Checkout",
      "Compra A",
    ]);
  });

  it("keeps a routed delivery when its URL is deleted (link set to NULL)", async () => {
    const endpoint = await db.integrationEndpoint.create({
      data: {
        workspaceId: otherWorkspaceId,
        provider: "umbler",
        kind: "automation_event",
        eventName: "QualifiedLead",
        parserReleaseId: (
          await db.inboundWebhookParserRelease.findUniqueOrThrow({
            where: {
              provider_version: { provider: "umbler", version: "automation-v1" },
            },
          })
        ).id,
        secretHash: "d".repeat(64),
        secretCiphertext: "c",
        secretIv: "i",
        secretTag: "t",
        secretKeyVersion: 1,
      },
    });
    const connection = await db.inboundWebhookConnection.create({
      data: {
        workspaceId: otherWorkspaceId,
        provider: "umbler",
        displayName: "Umbler",
        parserReleaseId: endpoint.parserReleaseId,
      },
    });
    const delivery = await db.inboundWebhookDelivery.create({
      data: {
        workspaceId: otherWorkspaceId,
        connectionId: connection.id,
        provider: "umbler",
        ingressKey: `routed-${randomUUID()}`,
        parserVersion: "automation-v1",
        purpose: "conversion_automation",
        integrationEndpointWorkspaceId: otherWorkspaceId,
        integrationEndpointId: endpoint.id,
        payloadExpiresAt: new Date(Date.now() + day),
      },
    });
    await db.integrationEndpoint.delete({ where: { id: endpoint.id } });
    const after = await db.inboundWebhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(after.integrationEndpointId).toBeNull();
  });

  it("has the unique keys behind ONE send between the two URLs", async () => {
    // Payt: one durable winner per sale (seller + order + event) and mode;
    // the Payt conversion dedupe key is the sale key itself.
    const indexes = await db.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE indexname IN ('ProviderPurchaseClaim_identity_key', 'ConversionEventLog_dedupeKey_key')`;
    const definitions = indexes.map((row) => row.indexdef).join("\n");
    expect(definitions).toMatch(
      /UNIQUE INDEX "ProviderPurchaseClaim_identity_key".*\("workspaceId", "effectMode", "purchaseKey"\)/u,
    );
    expect(definitions).toMatch(
      /UNIQUE INDEX "ConversionEventLog_dedupeKey_key".*\("dedupeKey"\)/u,
    );
    // Unnichat: the business identity is the conversion dedupe key.
    const identity = unnichatAutomationConversionIdentity({
      workspaceId,
      eventName: "QualifiedLead",
      dedupeMode: "lifetime",
      leadId: "lead_a",
      ctwaClid: "click-a",
      occurrenceKey: "occ-1",
    });
    const log = {
      workspaceId,
      sourceTrigger: "inbound_webhook:unnichat:provider_automation",
      eventName: "QualifiedLead",
      status: "shadow_observed",
      dedupeKey: `provider-automation:unnichat:${identity}`,
    };
    await db.conversionEventLog.create({ data: log });
    await expect(
      db.conversionEventLog.create({ data: log }),
    ).rejects.toSatisfy(uniqueViolation);
  });

  it("retention: deletes unrouted receipts after 60 days, keeps routed ones, drops expired bodies", async () => {
    const endpoint = await service.ensure(
      workspaceId,
      { provider: "unnichat", eventName: "ViewContent" },
      userId,
    );
    const now = new Date();
    const old = new Date(now.getTime() - 61 * day);
    const rows = [
      ["old_unattributed", "unattributed", old],
      ["old_routed", "routed", old],
      ["recent_pending", "pending", new Date(now.getTime() - 10 * day)],
    ] as const;
    for (const [key, status, lastReceivedAt] of rows) {
      await db.integrationEndpointEvent.create({
        data: {
          workspaceId,
          integrationEndpointId: endpoint.id,
          provider: "unnichat",
          ingressKey: key,
          status,
          firstReceivedAt: lastReceivedAt,
          lastReceivedAt,
          encryptedPayload: "ciphertext",
          payloadIv: "iv",
          payloadTag: "tag",
          encryptionKeyVersion: 1,
          payloadExpiresAt: new Date(lastReceivedAt.getTime() + 7 * day),
        },
      });
    }
    const maintenance = new InboundWebhookMaintenanceService(
      db as never,
      env,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ) as any;
    expect(await maintenance.clearExpiredIntegrationReceiptPayloads(now)).toBeGreaterThanOrEqual(3);
    expect(await maintenance.deleteOldIntegrationReceipts(now)).toBeGreaterThanOrEqual(1);
    const left = await db.integrationEndpointEvent.findMany({
      where: { integrationEndpointId: endpoint.id },
      orderBy: { ingressKey: "asc" },
    });
    expect(left.map((row) => row.ingressKey)).toEqual([
      "old_routed",
      "recent_pending",
    ]);
    expect(left.every((row) => row.encryptedPayload === null)).toBe(true);
  });
});
