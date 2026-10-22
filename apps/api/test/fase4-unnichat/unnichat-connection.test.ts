import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inboundWebhookConnectionCreateInputSchema } from "@wpptrack/shared";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";
import { InboundWebhookConnectionsService } from "../../src/inbound-webhooks/inbound-webhook-connections.service";
import { InboundWebhookObservationService } from "../../src/inbound-webhooks/inbound-webhook-observation.service";
import { UnnichatV1Parser } from "../../src/inbound-webhooks/providers/unnichat/unnichat-v1.parser";

// Fase 4b: an Unnichat connection is created already bound to the client's
// WhatsApp number (connectedPhone). The entry webhook carries no channel id,
// so the parser receives that number from the connection, never from the
// payload.
const now = new Date("2026-10-16T12:00:00.000Z");

function release(version = "v1") {
  return {
    id: `inbound_parser_unnichat_${version.replace("-", "_")}`,
    provider: "unnichat" as const,
    version,
    status: "certified" as const,
    createdAt: now,
    updatedAt: now,
    certifiedAt: now,
    certifiedByUserId: null,
  };
}

function fixture() {
  const v1 = release();
  const automation = release("automation-v1");
  const prisma = {
    inboundWebhookParserRelease: {
      findMany: vi.fn(async () => [v1]),
      findFirst: vi.fn(async ({ where }: any) =>
        where?.version === "automation-v1" ? automation : v1,
      ),
    },
    inboundWebhookConnection: {
      create: vi.fn(async ({ data }: any) => ({
        id: "connection_unnichat_1",
        workspaceId: data.workspaceId,
        provider: data.provider,
        displayName: data.displayName,
        parserReleaseId: data.parserReleaseId,
        secretHash: data.secretHash,
        status: "observation",
        productionActivatedAt: null,
        lastDeliveryAt: null,
        lastSuccessfulParseAt: null,
        removedAt: null,
        createdAt: now,
        updatedAt: now,
        createdByUserId: "user_1",
        parserRelease: v1,
      })),
    },
    inboundWebhookChannel: { create: vi.fn(async () => ({ id: "channel_1" })) },
    auditLog: { create: vi.fn(async () => undefined) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(prisma),
    ),
  };
  const service = new InboundWebhookConnectionsService(prisma as never, {
    INBOUND_WEBHOOKS_ENABLED: "true",
    API_PUBLIC_URL: "https://api.example.test",
    INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  });
  return { prisma, service };
}

describe("Unnichat connection (Fase 4b)", () => {
  it("requires the client's WhatsApp number in the create contract", () => {
    expect(
      inboundWebhookConnectionCreateInputSchema.safeParse({
        provider: "unnichat",
        displayName: "Unnichat Comercial",
      }).success,
    ).toBe(false);
    expect(
      inboundWebhookConnectionCreateInputSchema.safeParse({
        provider: "unnichat",
        displayName: "Unnichat Comercial",
        connectedPhone: "abc",
      }).success,
    ).toBe(false);
    // Same 10-15 digit range the API normalizes: 9 or 16 digits is a 400, not a 409.
    for (const connectedPhone of ["99999-0000", "+55 11 99999-0000 1234"]) {
      expect(
        inboundWebhookConnectionCreateInputSchema.safeParse({
          provider: "unnichat",
          displayName: "Unnichat Comercial",
          connectedPhone,
        }).success,
      ).toBe(false);
    }
    expect(
      inboundWebhookConnectionCreateInputSchema.parse({
        provider: "unnichat",
        displayName: "Unnichat Comercial",
        connectedPhone: "+55 (11) 99999-0000",
      }),
    ).toMatchObject({ connectedPhone: "+55 (11) 99999-0000" });
    // Other providers keep their webhook-discovered number.
    expect(
      inboundWebhookConnectionCreateInputSchema.safeParse({
        provider: "umbler",
        displayName: "Umbler",
        connectedPhone: "5511999990000",
      }).success,
    ).toBe(false);
    expect(
      inboundWebhookConnectionCreateInputSchema.safeParse({
        provider: "umbler",
        displayName: "Umbler",
      }).success,
    ).toBe(true);
  });

  it("creates the connection already bound to the normalized number, inheriting the workspace Meta routing", async () => {
    const { prisma, service } = fixture();
    const result = await service.createConnection(
      "workspace_1",
      {
        provider: "unnichat",
        displayName: "Unnichat Comercial",
        connectedPhone: "+55 (11) 99999-0000",
      },
      "user_1",
    );

    expect(result.connection.provider).toBe("unnichat");
    const url = new URL(result.webhookUrl);
    expect(url.pathname).toBe(`/webhooks/inbound/${result.connection.id}`);
    expect(url.searchParams.get("token")).toBe(result.secret);
    expect(prisma.inboundWebhookChannel.create).toHaveBeenCalledTimes(1);
    expect(prisma.inboundWebhookChannel.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_1",
        connectionId: "connection_unnichat_1",
        organizationId: "workspace_1",
        providerChannelId: "5511999990000",
        connectedPhone: "5511999990000",
        channelName: "Unnichat Comercial",
        status: "discovered",
        metaRoutingMode: "inherit_workspace",
      }),
    });
  });

  it("refuses a direct create without the number before touching the database", async () => {
    const { prisma, service } = fixture();
    await expect(
      service.createConnection(
        "workspace_1",
        { provider: "unnichat", displayName: "Sem número" } as never,
        "user_1",
      ),
    ).rejects.toThrow("Conexões Unnichat exigem o número de WhatsApp do cliente");
    expect(prisma.inboundWebhookConnection.create).not.toHaveBeenCalled();
    expect(prisma.inboundWebhookChannel.create).not.toHaveBeenCalled();
  });

  it("is listed as creatable once its certified v1 release exists", async () => {
    const { service } = fixture();
    const capabilities = await service.getCapabilities();
    expect(capabilities.providers).toContainEqual({
      provider: "unnichat",
      parserVersion: "v1",
      parserReleaseStatus: "certified",
      creationEnabled: true,
    });
    // Payt stays out: it has no connection of its own.
    expect(capabilities.providers.map((p) => p.provider)).not.toContain(
      "payt",
    );
  });

  it("rejects a provisional channel: the number is bound at creation", async () => {
    const prisma = {
      inboundWebhookConnection: {
        findFirst: vi.fn(async () => ({
          id: "connection_unnichat_1",
          provider: "unnichat",
        })),
      },
    };
    const service = new InboundWebhookChannelRoutesService(
      prisma as never,
      {} as never,
    );
    await expect(
      service.createProvisionalChannel(
        "workspace_1",
        "connection_unnichat_1",
        { connectedPhone: "5511999990000", channelName: null },
        "user_1",
      ),
    ).rejects.toThrow("Este provedor cadastra o canal automaticamente");
  });
});

describe("Unnichat entry webhook parsing with the bound number", () => {
  const payload = JSON.parse(
    readFileSync(resolve(__dirname, "fixtures/entry-with-ctwa.json"), "utf8"),
  );

  function observation(channel: { connectedPhone: string } | null) {
    const prisma = {
      inboundWebhookChannel: { findFirst: vi.fn(async () => channel) },
    };
    const subject = Object.assign(
      Object.create(InboundWebhookObservationService.prototype),
      {
        prisma,
        encryption: { decrypt: () => Buffer.from(JSON.stringify(payload)) },
      },
    ) as any;
    const delivery = {
      id: "delivery_1",
      workspaceId: "workspace_1",
      connectionId: "connection_unnichat_1",
      provider: "unnichat",
      encryptedPayload: "x",
      payloadIv: "x",
      payloadTag: "x",
      encryptionKeyVersion: 1,
      payloadExpiresAt: new Date(Date.now() + 86_400_000),
    };
    return { prisma, subject, delivery };
  }

  it("parses with the connection-bound number as the channel identity", async () => {
    const { prisma, subject, delivery } = observation({
      connectedPhone: "5511999990000",
    });
    const result = await subject.parseEncryptedPayload(
      delivery,
      new UnnichatV1Parser(),
    );
    expect(prisma.inboundWebhookChannel.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_1",
        connectionId: "connection_unnichat_1",
        organizationId: "workspace_1",
      },
      select: { connectedPhone: true },
    });
    expect(result.error).toBeNull();
    expect(result.events[0]).toMatchObject({
      organizationId: "workspace_1",
      channel: { providerChannelId: "5511999990000" },
      hasCtwa: true,
      classification: "eligible_route_unresolved",
    });
  });

  it("fails closed when the connection has no bound number", async () => {
    const { subject, delivery } = observation(null);
    await expect(
      subject.parseEncryptedPayload(delivery, new UnnichatV1Parser()),
    ).rejects.toMatchObject({
      code: "inbound_webhook_unnichat_channel_binding_missing",
    });
  });
});
