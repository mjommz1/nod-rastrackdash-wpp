import "reflect-metadata";
import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { inboundWebhookChannelRoutesUpdateInputSchema } from "@wpptrack/shared";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";

// Fase 4b: per-number Meta routing mode, Unnichat only (no shared BM pools).
// inherit_workspace = the workspace Meta configuration (unique page + pixel);
// channel_override = only the routes saved on this number.
function world(provider: string, metaRoutingMode: string | null) {
  const channel: any = {
    id: "ch",
    workspaceId: "w",
    connectionId: "c",
    organizationId: "w",
    providerChannelId: "5511999990000",
    connectedPhone: "5511999990000",
    status: "active",
    metaRoutingMode,
    routes: [],
    connection: {
      id: "c",
      workspaceId: "w",
      provider,
      status: "observation",
      removedAt: null,
    },
  };
  const channelUpdates: unknown[] = [];
  const prisma: any = {
    inboundWebhookChannel: {
      findFirst: vi.fn(async () => channel),
      updateMany: vi.fn(async ({ data }: any) => {
        channelUpdates.push(data);
        Object.assign(channel, data);
        return { count: 1 };
      }),
    },
    inboundWebhookChannelRoute: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(),
    },
    auditLog: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    metaBusinessConnection: {
      findFirst: vi.fn(async () => ({
        id: "bm",
        workspaceId: "w",
        status: "active",
        credential: { workspaceId: "w", status: "active" },
      })),
    },
  };
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  const service = new InboundWebhookChannelRoutesService(prisma, {} as never);
  (service as any).reevaluateOpenEvents = vi.fn(async () => ({}));
  // Route reference validation (BM/account/destination) is covered elsewhere.
  (service as any).validateRouteReferences = vi.fn(async () => undefined);
  return { service, channel, channelUpdates, prisma };
}

describe("Unnichat routing mode selector", () => {
  it("accepts only inherit_workspace and channel_override in the contract", () => {
    for (const routingMode of ["inherit_workspace", "channel_override"]) {
      expect(
        inboundWebhookChannelRoutesUpdateInputSchema.safeParse({
          routes: [],
          routingMode,
        }).success,
      ).toBe(true);
    }
    expect(
      inboundWebhookChannelRoutesUpdateInputSchema.safeParse({
        routes: [],
        routingMode: "shared_bm_pool",
      }).success,
    ).toBe(false);
  });

  it("switches an Unnichat number to inherit the workspace (no local routes)", async () => {
    const h = world("unnichat", "channel_override");
    await h.service.replaceRoutes(
      "w",
      "ch",
      { routes: [], routingMode: "inherit_workspace" },
      "user",
    );
    expect(h.channelUpdates).toEqual([{ metaRoutingMode: "inherit_workspace" }]);
    expect(h.prisma.inboundWebhookChannelRoute.upsert).not.toHaveBeenCalled();
  });

  it("switches an Unnichat number to its own routes (override)", async () => {
    const h = world("unnichat", "inherit_workspace");
    await h.service.replaceRoutes(
      "w",
      "ch",
      {
        routes: [{ metaBusinessConnectionId: "bm" }],
        routingMode: "channel_override",
      },
      "user",
    );
    expect(h.channelUpdates).toEqual([{ metaRoutingMode: "channel_override" }]);
    expect(h.prisma.inboundWebhookChannelRoute.upsert).toHaveBeenCalledTimes(1);
  });

  it("refuses local routes while inheriting", async () => {
    const h = world("unnichat", "inherit_workspace");
    await expect(
      h.service.replaceRoutes(
        "w",
        "ch",
        {
          routes: [{ metaBusinessConnectionId: "bm" }],
          routingMode: "inherit_workspace",
        },
        "user",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.channelUpdates).toEqual([]);
  });

  it.each(["umbler", "gupshup", "data_crazy", "meta_cloud", "uazapi"])(
    "refuses a routing mode on a %s number (Unnichat only)",
    async (provider) => {
      const h = world(provider, null);
      await expect(
        h.service.replaceRoutes(
          "w",
          "ch",
          { routes: [], routingMode: "inherit_workspace" },
          "user",
        ),
      ).rejects.toThrow("Modo de herança disponível apenas para Unnichat");
      expect(h.channelUpdates).toEqual([]);
    },
  );

  it("keeps other providers' saved routes exactly as before (no mode written)", async () => {
    const h = world("umbler", null);
    await h.service.replaceRoutes(
      "w",
      "ch",
      { routes: [{ metaBusinessConnectionId: "bm" }] },
      "user",
    );
    expect(h.channelUpdates).toEqual([]);
    expect(h.prisma.inboundWebhookChannelRoute.upsert).toHaveBeenCalledTimes(1);
  });
});
