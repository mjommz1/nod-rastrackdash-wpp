import "reflect-metadata";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InboundWebhookMetaCloudVerificationService } from "../../src/inbound-webhooks/inbound-webhook-meta-cloud-verification.service";
import { InboundWebhookPublicController } from "../../src/inbound-webhooks/inbound-webhook-public.controller";

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function fixture(secretHash: string | null) {
  const prisma = {
    inboundWebhookConnection: {
      findFirst: vi.fn(async () =>
        secretHash === null ? null : { secretHash },
      ),
    },
  };
  const verification = new InboundWebhookMetaCloudVerificationService(
    prisma as never,
  );
  const controller = new InboundWebhookPublicController(
    {} as never,
    {} as never,
    verification,
    {} as never,
  );

  return { controller, prisma };
}

describe("GET /webhooks/inbound/:connectionId Meta Cloud handshake", () => {
  it("returns Meta's challenge when the subscription token matches", async () => {
    const { controller, prisma } = fixture(hash("verify-token"));

    await expect(
      controller.verifyMetaCloudWebhook(
        "connection_meta_1",
        "subscribe",
        "verify-token",
        "meta-challenge",
      ),
    ).resolves.toBe("meta-challenge");
    expect(prisma.inboundWebhookConnection.findFirst).toHaveBeenCalledWith({
      where: {
        id: "connection_meta_1",
        provider: "meta_cloud",
        removedAt: null,
        secretHash: { not: null },
      },
      select: { secretHash: true },
    });
  });

  it.each([
    ["missing connection", null, "subscribe", "verify-token", "challenge"],
    [
      "wrong mode",
      hash("verify-token"),
      "unsubscribe",
      "verify-token",
      "challenge",
    ],
    [
      "wrong token",
      hash("verify-token"),
      "subscribe",
      "wrong-token",
      "challenge",
    ],
    [
      "missing challenge",
      hash("verify-token"),
      "subscribe",
      "verify-token",
      undefined,
    ],
  ])(
    "rejects %s with a generic 401",
    async (_, secretHash, mode, token, challenge) => {
      const { controller } = fixture(secretHash);

      await expect(
        controller.verifyMetaCloudWebhook(
          "connection_meta_1",
          mode,
          token,
          challenge,
        ),
      ).rejects.toMatchObject({ status: 401, message: "Nao autorizado" });
    },
  );
});
