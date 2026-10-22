import { describe, expect, it, vi } from "vitest";
import { KommoService } from "../src/kommo/kommo.service";

const connection = {
  id: "connection-a",
  workspaceId: "workspace-a",
  status: "active",
  verifiedAccountId: "account-a",
  accountSubdomain: "clinic",
  webhookSecretHash: "",
  accountOrigin: "https://clinic.kommo.com/",
  credentialHealthy: true,
};
const serviceFor = (prisma: any, queue: any = {}) =>
  new KommoService(
    prisma,
    {} as any,
    queue,
    {} as any,
    {} as any,
    { getLockState: vi.fn(async () => ({ inert: true, locked: false })) } as any,
  );

describe("Kommo ingress safety", () => {
  it("rejects account spoofing before it writes a webhook record", async () => {
    const prisma: any = {
      kommoConnection: { findUnique: vi.fn(async () => connection) },
    };
    const service: any = serviceFor(prisma);
    connection.webhookSecretHash = service.hash("capability");
    await expect(
      service.receive("connection-a", "capability", [
        {
          accountId: "other-account",
          accountSubdomain: "clinic",
          dealId: "deal",
          pipelineId: "p",
          statusId: "s",
          oldStatusId: null,
          occurredAt: new Date(),
          priceCents: null,
          pricePresent: false,
        },
      ]),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.kommoWebhookEvent).toBeUndefined();
  });
  it("marks a durably stored delivery failed and does not acknowledge it when publication fails", async () => {
    const event = {
      id: "event-a",
      workspaceId: "workspace-a",
      status: "accepted",
      revision: 0,
    };
    const prisma: any = {
      kommoConnection: { findUnique: vi.fn(async () => connection) },
      kommoConversionDedupe: { findMany: vi.fn(async () => []) },
      kommoWebhookEvent: {
        create: vi.fn(async () => event),
        updateMany: vi.fn(),
      },
    };
    const queue = {
      enqueue: vi.fn(async () => {
        throw new Error("redis unavailable");
      }),
    };
    const service: any = serviceFor(prisma, queue);
    connection.webhookSecretHash = service.hash("capability");
    await expect(
      service.receive("connection-a", "capability", [
        {
          accountId: "account-a",
          accountSubdomain: "clinic",
          dealId: "deal",
          pipelineId: "p",
          statusId: "s",
          oldStatusId: null,
          occurredAt: new Date(),
          priceCents: null,
          pricePresent: false,
        },
      ]),
    ).rejects.toThrow("redis unavailable");
    expect(prisma.kommoWebhookEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: "event-a",
        revision: 0,
        status: "accepted",
        leaseToken: null,
      },
      data: {
        status: "failed",
        errorCode: "enqueue_failed",
        jobId: null,
        revision: { increment: 1 },
        nextAttemptAt: expect.any(Date),
      },
    });
  });
});
