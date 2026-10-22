import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_INITIAL_LOOKBACK_DAYS,
  MetaInitialSyncPeriodService,
  resolveMetaInitialSyncPeriod,
} from "../src/reporting/meta-initial-sync-period";
import { ReportingController } from "../src/reporting/reporting.controller";

const now = new Date("2026-09-19T15:00:00.000Z");
const timeZone = "America/Sao_Paulo";

describe("resolveMetaInitialSyncPeriod", () => {
  it("uses today only when the workspace has no WhatsApp source", () => {
    expect(
      resolveMetaInitialSyncPeriod({ anchors: [], now, timeZone }),
    ).toEqual({
      since: "2026-09-19",
      until: "2026-09-19",
      anchorSource: null,
      lookbackDaysApplied: 1,
    });
  });

  it("starts on a WhatsApp anchor created three days ago", () => {
    expect(
      resolveMetaInitialSyncPeriod({
        anchors: [
          {
            createdAt: new Date("2026-09-16T12:00:00.000Z"),
            source: "whatsapp_instance",
          },
        ],
        now,
        timeZone,
      }),
    ).toMatchObject({
      since: "2026-09-16",
      until: "2026-09-19",
      anchorSource: "whatsapp_instance",
      lookbackDaysApplied: 4,
    });
  });

  it("clamps an old WhatsApp anchor to the inclusive seven-day window", () => {
    const period = resolveMetaInitialSyncPeriod({
      anchors: [
        {
          createdAt: new Date("2026-08-20T12:00:00.000Z"),
          source: "whatsapp_instance",
        },
      ],
      now,
      timeZone,
    });

    expect(period).toMatchObject({ since: "2026-09-13", until: "2026-09-19" });
    expect(period.lookbackDaysApplied).toBe(MAX_INITIAL_LOOKBACK_DAYS);
  });

  it("uses the earliest qualifying source across instance and inbound connections", () => {
    expect(
      resolveMetaInitialSyncPeriod({
        anchors: [
          {
            createdAt: new Date("2026-09-18T12:00:00.000Z"),
            source: "whatsapp_instance",
          },
          {
            createdAt: new Date("2026-09-14T12:00:00.000Z"),
            source: "inbound_webhook_connection",
          },
        ],
        now,
        timeZone,
      }),
    ).toMatchObject({
      since: "2026-09-14",
      anchorSource: "inbound_webhook_connection",
    });
  });
});

describe("MetaInitialSyncPeriodService", () => {
  it("ignores removed inbound connections and inactive or suspended instances in its queries", async () => {
    const calls: Array<{ model: string; args: Record<string, unknown> }> = [];
    const prisma = {
      whatsappInstance: {
        findMany: async (args: Record<string, unknown>) => {
          calls.push({ model: "whatsappInstance", args });
          return [{ createdAt: new Date("2026-09-16T12:00:00.000Z") }];
        },
      },
      inboundWebhookConnection: {
        findMany: async (args: Record<string, unknown>) => {
          calls.push({ model: "inboundWebhookConnection", args });
          return [];
        },
      },
    };
    const service = new MetaInitialSyncPeriodService(prisma as never);

    await expect(
      service.resolve({ workspaceId: "workspace-a", now }),
    ).resolves.toMatchObject({
      since: "2026-09-16",
      until: "2026-09-19",
    });
    expect(calls).toEqual([
      {
        model: "whatsappInstance",
        args: {
          where: {
            workspaceId: "workspace-a",
            provider: { in: ["uazapi_byo", "waha", "zapi", "nod_api"] },
            status: "active",
          },
          select: { createdAt: true },
        },
      },
      {
        model: "inboundWebhookConnection",
        args: {
          where: {
            workspaceId: "workspace-a",
            provider: {
              in: [
                "umbler",
                "gupshup",
                "uazapi",
                "meta_cloud",
                "data_crazy",
                "unnichat",
              ],
            },
            removedAt: null,
          },
          select: { createdAt: true },
        },
      },
    ]);
  });
});

describe("ReportingController initial Meta sync period", () => {
  it("resolves the backend-owned period for the authenticated workspace", async () => {
    const period = {
      since: "2026-09-13",
      until: "2026-09-19",
      anchorSource: "whatsapp_instance" as const,
      lookbackDaysApplied: 7,
    };
    const resolve = vi.fn().mockResolvedValue(period);
    const controller = new ReportingController(
      {} as never,
      {} as never,
      { resolve } as never,
      {
        getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      } as never,
      {
        getCurrentWorkspace: vi.fn().mockReturnValue({
          id: "workspace-1",
          permissions: { canManageIntegrations: true },
        }),
      } as never,
      {} as never,
    );

    await expect(
      controller.getMetaInitialSyncPeriod("refresh-token"),
    ).resolves.toEqual(period);
    expect(resolve).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
  });

  it("requires integration management permission", async () => {
    const resolve = vi.fn();
    const controller = new ReportingController(
      {} as never,
      {} as never,
      { resolve } as never,
      {
        getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
      } as never,
      {
        getCurrentWorkspace: vi.fn().mockReturnValue({
          id: "workspace-1",
          permissions: { canManageIntegrations: false },
        }),
      } as never,
      {} as never,
    );

    await expect(
      controller.getMetaInitialSyncPeriod("refresh-token"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(resolve).not.toHaveBeenCalled();
  });
});
