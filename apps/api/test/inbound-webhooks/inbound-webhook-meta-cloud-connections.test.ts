import "reflect-metadata";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InboundWebhookConnectionsService } from "../../src/inbound-webhooks/inbound-webhook-connections.service";

const now = new Date("2026-09-15T12:00:00.000Z");

function metaConnection() {
  return {
    id: "connection_meta_1",
    workspaceId: "workspace_1",
    provider: "meta_cloud" as const,
    displayName: "WhatsApp Comercial",
    parserReleaseId: "inbound_parser_meta_cloud_v1",
    secretHash: "pending",
    status: "observation" as const,
    productionActivatedAt: null,
    lastDeliveryAt: null,
    lastSuccessfulParseAt: null,
    removedAt: null,
    createdAt: now,
    updatedAt: now,
    createdByUserId: "user_1",
    parserRelease: {
      id: "inbound_parser_meta_cloud_v1",
      provider: "meta_cloud" as const,
      version: "v1",
      status: "observation_only" as const,
      createdAt: now,
      updatedAt: now,
      certifiedAt: null,
      certifiedByUserId: null,
    },
  };
}

function fixture() {
  const connection = metaConnection();
  const release = connection.parserRelease;
  const prisma = {
    inboundWebhookParserRelease: {
      findMany: vi.fn(async () => [release]),
      findFirst: vi.fn(async () => release),
    },
    inboundWebhookConnection: {
      create: vi.fn(async ({ data }: { data: { secretHash: string } }) => ({
        ...connection,
        secretHash: data.secretHash,
      })),
    },
    auditLog: { create: vi.fn(async () => undefined) },
    $transaction: vi.fn(
      async (fn: (transaction: unknown) => Promise<unknown>) => fn(prisma),
    ),
  };
  const service = new InboundWebhookConnectionsService(prisma as never, {
    INBOUND_WEBHOOKS_ENABLED: "true",
    API_PUBLIC_URL: "https://api.example.test",
    INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  });

  return { service, prisma };
}

describe("Meta Cloud inbound webhook connections", () => {
  it("creates a Meta callback with a one-time verification token but no query token", async () => {
    const { service, prisma } = fixture();

    const result = await service.createConnection(
      "workspace_1",
      { provider: "meta_cloud", displayName: "WhatsApp Comercial" },
      "user_1",
    );

    expect(result.connection.provider).toBe("meta_cloud");
    expect(result.webhookUrl).toBe(
      "https://api.example.test/webhooks/inbound/connection_meta_1",
    );
    expect(result.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(prisma.inboundWebhookConnection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          secretHash: createHash("sha256")
            .update(result.secret, "utf8")
            .digest("hex"),
        }),
      }),
    );
  });

  it("exposes Meta Cloud as creatable when its v1 release is enabled", async () => {
    const { service } = fixture();

    const capabilities = await service.getCapabilities();

    expect(capabilities.providers).toContainEqual({
      provider: "meta_cloud",
      parserVersion: "v1",
      parserReleaseStatus: "certified",
      creationEnabled: true,
    });
  });
});
