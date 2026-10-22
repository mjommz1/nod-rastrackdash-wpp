import "reflect-metadata";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InboundWebhookIngestionService } from "../../src/inbound-webhooks/inbound-webhook-ingestion.service";
import { InboundWebhookPublicController } from "../../src/inbound-webhooks/inbound-webhook-public.controller";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";

const appSecret = "meta-cloud-app-secret";

function body(): Buffer {
  return Buffer.from(
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: {
                  display_phone_number: "551132630883",
                  phone_number_id: "phone_number_1",
                },
                messages: [
                  {
                    id: "wamid.post-1",
                    from: "5511974108069",
                    timestamp: "1789493700",
                    type: "text",
                    text: { body: "Oi" },
                    referral: { ctwa_clid: "clid-post-1", source_id: "ad-1" },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
    "utf8",
  );
}

function fixture(metaAppSecret: string | undefined = appSecret) {
  const connection = {
    id: "connection_meta_1",
    workspaceId: "workspace_1",
    provider: "meta_cloud",
    secretHash: "unused-for-meta-post",
    status: "observation",
    removedAt: null,
    parserRelease: { version: "v1" },
  };
  const prisma = {
    inboundWebhookConnection: {
      findUnique: vi.fn(async () => connection),
      findFirst: vi.fn(async () => ({ id: connection.id })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    inboundWebhookDelivery: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(
      async (fn: (transaction: unknown) => Promise<unknown>) => fn(prisma),
    ),
  };
  const ingestion = new InboundWebhookIngestionService(
    prisma as never,
    {
      NODE_ENV: "test",
      API_PUBLIC_URL: "http://localhost:3333",
      INBOUND_WEBHOOKS_ENABLED: "true",
      INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
      META_APP_SECRET: metaAppSecret,
    },
    {
      encrypt: vi.fn(() => ({
        encryptedPayload: "ciphertext",
        payloadIv: "iv",
        payloadTag: "tag",
        encryptionKeyVersion: 1,
      })),
    } as never,
    { enqueueDelivery: vi.fn(async () => undefined) } as never,
  );
  const controller = new InboundWebhookPublicController(
    ingestion,
    {} as never,
    {} as never,
    {} as never,
  );

  return { controller, prisma };
}

describe("POST /webhooks/inbound/:connectionId Meta Cloud", () => {
  it("accepts a valid signed CTWA payload and resolves its configured parser", async () => {
    const rawBody = body();
    const signature = `sha256=${createHmac("sha256", appSecret)
      .update(rawBody)
      .digest("hex")}`;
    const { controller, prisma } = fixture();

    await expect(
      controller.receive(
        "connection_meta_1",
        undefined,
        "application/json",
        undefined,
        signature,
        rawBody,
      ),
    ).resolves.toMatchObject({ status: "accepted", duplicate: false });

    expect(prisma.inboundWebhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalDeliveryId: "wamid.post-1",
          ingressKey: "wamid:wamid.post-1",
        }),
      }),
    );
    expect(
      new InboundWebhookParserRegistry()
        .resolve({ provider: "meta_cloud", parserVersion: "v1" })
        .parse(JSON.parse(rawBody.toString("utf8"))).events[0].classification,
    ).toBe("eligible_route_unresolved");
  });

  it("rejects a Meta payload with an invalid signature when app secret is configured", async () => {
    const { controller } = fixture();

    await expect(
      controller.receive(
        "connection_meta_1",
        undefined,
        "application/json",
        undefined,
        "sha256=" + "0".repeat(64),
        body(),
      ),
    ).rejects.toMatchObject({ status: 404, message: "Webhook nao encontrado" });
  });

  it("accepts a path-scoped observation delivery without a signature when app secret is not configured", async () => {
    const { controller } = fixture("");

    await expect(
      controller.receive(
        "connection_meta_1",
        undefined,
        "application/json",
        undefined,
        undefined,
        body(),
      ),
    ).resolves.toMatchObject({ status: "accepted", duplicate: false });
  });
});
