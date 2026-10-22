import { describe, expect, it, vi } from "vitest";
import { resolvePurchaseChannels } from "../../src/conversion-rules/provider-purchase-routing";
const input = {
  workspaceId: "w",
  channelIds: ["a"],
  phoneHashes: ["hash"],
  leadId: "lead",
  adId: "same-ad",
  ctwaClid: "new-click",
  receivedAt: new Date(),
};
describe("immutable Payt origin evidence", () => {
  it("requires the exact captured click and provenance, not only mutable lead/ad identity", async () => {
    const log = {
      id: "old-log",
      ctwaClid: "old-click",
      sourcePayload: {
        inboundEventId: "old-event",
        channelId: "a",
        connectionId: "capture",
      },
    };
    const client = {
      conversionEventLog: {
        findMany: vi.fn(async ({ where }: any) =>
          where.ctwaClid === log.ctwaClid ? [log] : [],
        ),
      },
      inboundWebhookEvent: {
        findMany: vi.fn(async () => [{ channel: { id: "a" } }]),
      },
      inboundWebhookChannel: { findMany: vi.fn(async () => []) },
    };
    expect(await resolvePurchaseChannels(client as never, input)).toEqual([]);
    expect(client.inboundWebhookEvent.findMany).not.toHaveBeenCalled();
    await resolvePurchaseChannels(client as never, {
      ...input,
      ctwaClid: "old-click",
    });
    expect(client.inboundWebhookEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          adId: "same-ad",
          OR: [
            expect.objectContaining({
              id: "old-event",
              channelId: "a",
              connectionId: "capture",
              OR: expect.arrayContaining([
                expect.objectContaining({
                  productionItem: {
                    is: expect.objectContaining({
                      conversionEventLogId: "old-log",
                      leadId: "lead",
                      workspaceId: "w",
                    }),
                  },
                }),
              ]),
            }),
          ],
        }),
      }),
    );
  });
  it("rejects truncated evidence, missing provenance and cross-channel logs", async () => {
    const logs = [
      {
        id: "unscoped",
        sourcePayload: {
          inboundEventId: "e",
          channelId: "other",
          connectionId: "c",
        },
      },
      { id: "missing", sourcePayload: {} },
    ];
    const client = {
      conversionEventLog: { findMany: vi.fn(async () => logs) },
      inboundWebhookEvent: { findMany: vi.fn() },
      inboundWebhookChannel: { findMany: vi.fn(async () => []) },
    };
    expect(await resolvePurchaseChannels(client as never, input)).toEqual([]);
    client.conversionEventLog.findMany.mockResolvedValueOnce(
      Array(501).fill(logs[0]),
    );
    expect(await resolvePurchaseChannels(client as never, input)).toEqual([]);
    expect(client.inboundWebhookEvent.findMany).not.toHaveBeenCalled();
  });
});
