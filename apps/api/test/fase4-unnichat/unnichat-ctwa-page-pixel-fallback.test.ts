import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import { offline } from "./helpers/first-entry-offline";
import { pagePixelHarness } from "./helpers/ctwa-harness";
import { resolveCtwaDestination } from "../../src/inbound-webhooks/authorized-ctwa-destination";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";
import { InboundWebhookMetaRouteReaderService } from "../../src/inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { InboundWebhookObservationService } from "../../src/inbound-webhooks/inbound-webhook-observation.service";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import { resolveCtwaLeadProof } from "../../src/conversion-rules/ctwa-lead-proof";
import { LeadsService } from "../../src/leads/leads.service";

// Owner rule: Meta CAPI for CTWA (business_messaging / whatsapp) needs only the
// dataset/pixel + page_id + ctwa_clid (+ph). The ad id is optional enrichment:
// an unknown ad must not block a lead whose destination is unambiguous.
const SOURCE_ID = "120210000000000777";
const HINT = "authorized_ctwa_destination_ad_hint";

function harness() {
  const h0 = offline();
  const h = { ...h0, ...pagePixelHarness(h0) };
  h.payload.ctwa_id = SOURCE_ID;
  const parsed = new InboundWebhookParserRegistry()
    .resolve({
      provider: "unnichat",
      parserVersion: "v1",
      parserReleaseStatus: "certified",
    })
    .parse(h.payload, {
      organizationId: "w",
      connectedPhone: h.channel.providerChannelId,
    }).events[0]!;
  // Stored as it is today in production: an unknown ad left unresolved.
  Object.assign(h.event, {
    adId: parsed.adId,
    dedupeKey: parsed.dedupeKey,
    externalMessageId: parsed.externalMessageId,
    normalizedSummary: parsed.normalizedSummary,
    classification: "eligible_route_unresolved",
    classificationReason: "ad_not_found",
    resolvedBusinessConnectionId: null,
    resolvedReportingAccountId: null,
    resolvedConversionDestinationId: null,
  });
  const routes = new InboundWebhookChannelRoutesService(
    h.prisma,
    new InboundWebhookMetaRouteReaderService(h.prisma),
  ) as any;
  async function classify(adId: string | null = h.event.adId) {
    const route = await routes.evaluateEventRoute(h.channel, adId);
    Object.assign(h.event, {
      classification: route.classification,
      classificationReason: route.reason,
      resolvedBusinessConnectionId: route.preview?.businessConnectionId ?? null,
      resolvedReportingAccountId: route.preview?.reportingAccountId ?? null,
      resolvedConversionDestinationId:
        route.preview?.conversionDestinationId ?? null,
    });
    return route;
  }
  function twoPairs() {
    h.accounts[0].allowedDestinations = ["dest", "dest2"].map(
      (conversionDestinationId) => ({
        active: true,
        conversionDestinationId,
        workspaceId: "w",
        reportingAccountId: h.accounts[0].id,
      }),
    ) as any;
    h.prisma.metaConversionDestination.findMany.mockResolvedValue([
      h.destination,
      { ...h.destination, id: "dest2", pixelId: "p2", pageId: "page2" },
    ]);
  }
  function override(rows: Array<Record<string, unknown>>) {
    h.channel.metaRoutingMode = "channel_override";
    h.prisma.inboundWebhookChannelRoute.findMany.mockResolvedValue(
      rows.map((row, i) => ({
        id: `route_${i}`,
        active: true,
        validationStatus: "valid",
        metaReportingAccountId: null,
        metaConversionDestinationId: null,
        ...row,
      })),
    );
  }
  return { ...h, parsed, routes, classify, twoPairs, override };
}

afterEach(() => vi.useRealTimers());

describe("A. CTWA entry with an unknown ad falls back to the unique page/pixel pair", () => {
  it("classifies as ad hint, materializes live and sends page_id + ctwa_clid with ad_id only as custom_data", async () => {
    const h = harness();
    expect(await h.classify()).toMatchObject({
      classification: "eligible_route_resolved",
      reason: HINT,
      preview: {
        businessConnectionId: "bm",
        reportingAccountId: null,
        conversionDestinationId: "dest",
      },
    });
    expect(h.event.adId).toBe(SOURCE_ID);
    await expect(
      h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    ).resolves.toEqual({ status: "materialized" });
    // The ad id is never turned into lead attribution, account or hierarchy.
    expect(h.leads[0].adId ?? null).toBeNull();
    expect(h.leads[0].campaignId ?? null).toBeNull();
    expect(h.logs[0]).toMatchObject({
      adId: SOURCE_ID,
      campaignId: null,
      adSetId: null,
      metaAccountId: null,
      attributionStatus: "ctwa_ad_hint",
      metaBusinessConnectionId: "bm",
      metaConversionDestinationId: "dest",
      sourcePayload: {
        processingMode: "live_production",
        ctwaDestination: { deliveryKind: "page_pixel", destinationId: "dest" },
      },
    });
    expect(await h.processor.process(h.jobs[0])).toMatchObject({
      status: "sent",
    });
    // The send-time context gate looks up the stored ad-hint decision.
    expect(h.prisma.inboundWebhookEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          adId: SOURCE_ID,
          classificationReason: HINT,
        }),
      }),
    );
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toContain("/synthetic_pixel/events");
    expect(h.calls[0].body.data[0]).toMatchObject({
      action_source: "business_messaging",
      messaging_channel: "whatsapp",
      user_data: { page_id: "synthetic_page", ctwa_clid: h.payload.ctwa_clid },
      custom_data: { ad_id: SOURCE_ID },
    });
    expect(h.calls[0].body.data[0].user_data).not.toHaveProperty(
      "whatsapp_business_account_id",
    );
  });

  it("a non-numeric ad hint is stored but never sent as custom_data.ad_id", async () => {
    const h = harness();
    h.payload.ctwa_id = "opaque_source";
    h.event.adId = "opaque_source";
    expect(await h.classify()).toMatchObject({ reason: HINT });
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    expect(h.logs[0]).toMatchObject({ adId: "opaque_source" });
    expect(await h.processor.process(h.jobs[0])).toMatchObject({
      status: "sent",
    });
    expect(h.calls[0].body.data[0].custom_data).not.toHaveProperty("ad_id");
    expect(h.calls[0].body.data[0].user_data).toMatchObject({
      page_id: "synthetic_page",
    });
  });

  // Replay of Unnichat entries is not part of this edition (the student
  // recovery flow stays Meta Cloud only).

  it("reevaluateOpenEvents upgrades a stored ad_not_found event to the ad-hint route", async () => {
    const h = harness();
    h.prisma.inboundWebhookEvent.updateMany = vi.fn(async ({ data }: any) => {
      Object.assign(h.event, data);
      return { count: 1 };
    });
    expect(await h.routes.reevaluateOpenEvents("w", "ch")).toMatchObject({
      examinedCount: 1,
      updatedCount: 1,
      resolvedCount: 1,
      unresolvedCount: 0,
    });
    expect(h.event).toMatchObject({
      classification: "eligible_route_resolved",
      classificationReason: HINT,
      adId: SOURCE_ID,
      resolvedBusinessConnectionId: "bm",
      resolvedReportingAccountId: null,
      resolvedConversionDestinationId: "dest",
    });
    // Readiness counts it as a routed CTWA, not as unresolved.
    const readiness = h.routes.channelReadiness(
      h.channel,
      [{ ...h.event, deliveryId: "d", replayItem: null, productionItem: null }],
      new Date(),
      new Set(["d"]),
      0,
      await h.routes.effectiveEntryReadiness(h.channel),
    );
    expect(readiness).toMatchObject({
      routedCtwa: 1,
      unresolvedCtwa: 0,
      retainedRoutedCtwa: 1,
      ctwaDestinationReadiness: { status: "verified" },
    });
  });

  it("the materialized ad-hint entry proves later conversions for the same click and channel only", async () => {
    const h = harness();
    await h.classify();
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    const log = h.logs[0];
    const input = {
      workspaceId: "w",
      leadId: h.leads[0].id,
      phoneHash: log.phoneHash,
      ctwaClid: log.ctwaClid,
      channelId: "ch",
      connectionId: "c",
    };
    expect(await resolveCtwaLeadProof(h.prisma, input)).toEqual(
      log.sourcePayload.ctwaDestination,
    );
    expect(h.prisma.inboundWebhookEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          adId: SOURCE_ID,
          classificationReason: HINT,
        }),
      }),
    );
    expect(
      await resolveCtwaLeadProof(h.prisma, {
        ...input,
        ctwaClid: "another_click",
      }),
    ).toBeNull();
    expect(
      await resolveCtwaLeadProof(h.prisma, {
        ...input,
        channelId: "another_channel",
      }),
    ).toBeNull();
  });

  it("a retained payload re-parsing to a different ctwa_id fails identity with no effects", async () => {
    const h = harness();
    await h.classify();
    h.payload.ctwa_id = "120210000000000999";
    await expect(
      h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    ).rejects.toThrow();
    expect(h.item.errorCode).toBe(
      "inbound_webhook_production_identity_invalid",
    );
    expect(h.logs).toHaveLength(0);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("once the ad becomes known the stored hint is re-evaluated in place and takes the canonical reason", async () => {
    const h = harness();
    await h.classify();
    h.prisma.inboundWebhookEvent.updateMany = vi.fn(async ({ data }: any) => {
      Object.assign(h.event, data);
      return { count: 1 };
    });
    h.prisma.metaAd.findFirst.mockResolvedValue({
      adAccountId: "act_known",
      destinationAssignment: null,
    });
    h.prisma.metaReportingAccount.findFirst = vi.fn(async () => ({
      id: "account0_1",
      adAccountId: "act_known",
      businessConnectionId: "bm",
      conversionDestinationId: null,
      active: false,
      allowedDestinations: [],
    }));
    await expect(
      h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    ).rejects.toThrow();
    // Same attempt: the item no longer fails route_invalid on a stale hint.
    expect(h.event).toMatchObject({
      classification: "eligible_route_unresolved",
      classificationReason: "reporting_account_inactive",
      resolvedConversionDestinationId: null,
    });
    expect(h.item.errorCode).toBe(
      "inbound_webhook_production_event_ineligible",
    );
    expect(h.logs).toHaveLength(0);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(await h.classify()).toMatchObject({
      classification: "eligible_route_unresolved",
      reason: "reporting_account_inactive",
    });
  });

  it("E. two authorized (pixel, page) pairs stay unresolved as ambiguous; nothing is sent", async () => {
    const h = harness();
    h.twoPairs();
    expect(await h.classify()).toMatchObject({
      classification: "eligible_route_unresolved",
      reason: "ctwa_destination_ambiguous",
    });
    await expect(
      h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    ).rejects.toThrow();
    expect(h.logs).toHaveLength(0);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("E. no authorized pair keeps the canonical ad reason", async () => {
    const h = harness();
    h.destination.pageId = "";
    expect(await h.classify()).toMatchObject({
      classification: "eligible_route_unresolved",
      reason: "ad_not_found",
    });
  });
});

describe("B. channel override filters the page/pixel pair instead of requiring an ad", () => {
  it.each([
    ["BM-only route", { metaBusinessConnectionId: "bm" }],
    [
      "account route",
      { metaBusinessConnectionId: "bm", metaReportingAccountId: "account0_1" },
    ],
    [
      "destination route",
      { metaBusinessConnectionId: "bm2", metaConversionDestinationId: "dest" },
    ],
  ])(
    "%s authorizes the unique pair for no-ad and unknown-ad leads",
    async (_label, route) => {
      const h = harness();
      h.override([route]);
      expect(await resolveCtwaDestination(h.prisma, h.channel)).toMatchObject({
        kind: "authorized_ctwa_destination",
        deliveryKind: "page_pixel",
        destinationId: "dest",
        pixelId: "synthetic_pixel",
        pageId: "synthetic_page",
      });
      expect(await h.classify(null)).toMatchObject({
        classification: "eligible_route_resolved",
        reason: "authorized_ctwa_destination",
      });
      expect(await h.classify(SOURCE_ID)).toMatchObject({
        classification: "eligible_route_resolved",
        reason: HINT,
      });
    },
  );

  it("an override no-ad lead materializes live and is sent", async () => {
    const h = harness();
    h.override([{ metaBusinessConnectionId: "bm" }]);
    h.event.adId = null;
    await h.classify(null);
    await expect(
      h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    ).resolves.toEqual({ status: "materialized" });
    expect(await h.processor.process(h.jobs[0])).toMatchObject({
      status: "sent",
    });
    expect(h.calls[0].body.data[0].user_data).toMatchObject({
      page_id: "synthetic_page",
    });
  });

  it("an override route narrows a workspace ambiguity down to one pair", async () => {
    const h = harness();
    h.twoPairs();
    expect(await resolveCtwaDestination(h.prisma, h.channel)).toMatchObject({
      reason: "ctwa_destination_ambiguous",
    });
    // bm2 accounts only authorize the BM default destination.
    h.override([{ metaBusinessConnectionId: "bm2" }]);
    expect(await resolveCtwaDestination(h.prisma, h.channel)).toMatchObject({
      kind: "authorized_ctwa_destination",
      destinationId: "dest",
    });
  });

  it("an override covering two pairs stays ambiguous", async () => {
    const h = harness();
    h.twoPairs();
    h.override([{ metaBusinessConnectionId: "bm" }]);
    expect(await resolveCtwaDestination(h.prisma, h.channel)).toMatchObject({
      kind: "blocked_ctwa_destination",
      reason: "ctwa_destination_ambiguous",
    });
    expect(await h.classify(SOURCE_ID)).toMatchObject({
      classification: "eligible_route_unresolved",
      reason: "ctwa_destination_ambiguous",
    });
  });

  it.each([
    [
      "route pinning another destination",
      [
        {
          metaBusinessConnectionId: "bm",
          metaConversionDestinationId: "other",
        },
      ],
    ],
    [
      "route for another account",
      [
        {
          metaBusinessConnectionId: "bm",
          metaReportingAccountId: "foreign_account",
        },
      ],
    ],
    ["route for an unknown BM", [{ metaBusinessConnectionId: "foreign_bm" }]],
    [
      "invalid route",
      [{ metaBusinessConnectionId: "bm", validationStatus: "invalid" }],
    ],
    ["no route", []],
  ])("%s excludes the only pair and blocks", async (_label, rows) => {
    const h = harness();
    h.override(rows);
    expect(await resolveCtwaDestination(h.prisma, h.channel)).toMatchObject({
      kind: "blocked_ctwa_destination",
      reason:
        rows.length && rows.every((r: any) => !r.validationStatus)
          ? "ctwa_verified_binding_missing"
          : "ctwa_override_no_valid_routes",
    });
    expect(await h.classify(null)).toMatchObject({
      classification: "eligible_route_unresolved",
    });
    expect(await h.classify(SOURCE_ID)).toMatchObject({
      classification: "eligible_route_unresolved",
    });
    await expect(
      h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    ).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("legacy channels with unknown routing never inherit the workspace pair", async () => {
    const h = harness();
    h.channel.metaRoutingMode = null;
    h.prisma.inboundWebhookChannelRoute.findMany.mockResolvedValue([
      {
        id: "learned",
        active: true,
        validationStatus: "valid",
        metaBusinessConnectionId: "bm",
        metaReportingAccountId: null,
        metaConversionDestinationId: null,
      },
    ]);
    expect(await resolveCtwaDestination(h.prisma, h.channel)).toMatchObject({
      kind: "blocked_ctwa_destination",
      reason: "ctwa_channel_routing_mode_unset",
    });
  });
});

describe("C. channels discovered by observation", () => {
  async function discover(provider: string) {
    const tx: any = {
      inboundWebhookConnection: {
        findFirst: vi.fn(async () => ({ id: "c" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      // findUnique: this edition first looks for a provisional channel.
      inboundWebhookChannel: {
        upsert: vi.fn(async () => ({ id: "ch" })),
        findUnique: vi.fn(async () => null),
      },
      inboundWebhookDelivery: { updateMany: vi.fn(async () => ({ count: 1 })) },
      inboundWebhookEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
    };
    const subject = Object.assign(
      Object.create(InboundWebhookObservationService.prototype),
      { prisma: { $transaction: async (fn: any) => fn(tx) } },
    );
    const h = harness();
    await subject.persistResult(
      {
        id: "d",
        workspaceId: "w",
        connectionId: "c",
        provider,
        parserVersion: "v1",
        connection: {
          parserReleaseId: "release",
          parserRelease: { id: "release", status: "certified" },
        },
      },
      {
        ...new InboundWebhookParserRegistry()
          .resolve({
            provider: "unnichat",
            parserVersion: "v1",
            parserReleaseStatus: "certified",
          })
          .parse(h.payload, {
            organizationId: "w",
            connectedPhone: h.channel.providerChannelId,
          }),
      },
      new Date(),
    );
    return tx.inboundWebhookChannel.upsert.mock.calls[0][0];
  }

  it("creates Unnichat channels inheriting the workspace Meta configuration", async () => {
    const upsert = await discover("unnichat");
    expect(upsert.create.metaRoutingMode).toBe("inherit_workspace");
    expect(upsert.update).not.toHaveProperty("metaRoutingMode");
  });

  it("keeps other providers without a routing mode", async () => {
    const upsert = await discover("umbler");
    expect(upsert.create).not.toHaveProperty("metaRoutingMode");
  });
});

describe("D. PUT channel routes without routingMode keeps the current mode", () => {
  function service() {
    const h = harness();
    const channelUpdates: any[] = [];
    h.prisma.inboundWebhookChannel.updateMany = vi.fn(async ({ data }: any) => {
      channelUpdates.push(data);
      return { count: 1 };
    });
    h.prisma.inboundWebhookChannelRoute.updateMany = vi.fn(async () => ({
      count: 0,
    }));
    h.prisma.inboundWebhookChannelRoute.upsert = vi.fn();
    h.prisma.auditLog.create = vi.fn(async () => ({}));
    h.routes.reevaluateOpenEvents = vi.fn(async () => ({}));
    return { ...h, channelUpdates };
  }

  it.each([
    ["channel_override", undefined, "channel_override"],
    [null, undefined, "inherit_workspace"],
    ["inherit_workspace", undefined, "inherit_workspace"],
    ["channel_override", "inherit_workspace", "inherit_workspace"],
  ] as const)(
    "current %s + input %s => %s",
    async (current, routingMode, expected) => {
      const h = service();
      h.channel.metaRoutingMode = current;
      await h.routes.replaceRoutes(
        "w",
        "ch",
        { routes: [], ...(routingMode ? { routingMode } : {}) },
        "user",
      );
      expect(h.channelUpdates).toEqual([{ metaRoutingMode: expected }]);
    },
  );

  it("refuses manual routes on an inheriting channel without an explicit override", async () => {
    const h = service();
    h.channel.metaRoutingMode = null;
    await expect(
      h.routes.replaceRoutes(
        "w",
        "ch",
        { routes: [{ metaBusinessConnectionId: "bm" }] },
        "user",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.channelUpdates).toEqual([]);
    expect(h.prisma.inboundWebhookChannelRoute.upsert).not.toHaveBeenCalled();
  });

  it("a NULL legacy channel with unknown routing requires an explicit routingMode (never widened to inheritance)", async () => {
    const h = service();
    h.channel.metaRoutingMode = null;
    // Active route rows without any audit trail = legacy_unknown.
    h.prisma.inboundWebhookChannelRoute.findMany.mockResolvedValue([
      {
        id: "legacy",
        active: true,
        validationStatus: "valid",
        metaBusinessConnectionId: "bm",
        metaReportingAccountId: null,
        metaConversionDestinationId: null,
      },
    ]);
    await expect(
      h.routes.replaceRoutes("w", "ch", { routes: [] }, "user"),
    ).rejects.toMatchObject({
      response: { code: "channel_routing_mode_required" },
    });
    expect(h.channelUpdates).toEqual([]);
    expect(
      h.prisma.inboundWebhookChannelRoute.updateMany,
    ).not.toHaveBeenCalled();
    // The explicit choice is honoured (the legacy rows are then deactivated).
    h.prisma.inboundWebhookChannelRoute.findMany.mockResolvedValue([]);
    await h.routes.replaceRoutes(
      "w",
      "ch",
      { routes: [], routingMode: "inherit_workspace" },
      "user",
    );
    expect(h.channelUpdates).toEqual([
      { metaRoutingMode: "inherit_workspace" },
    ]);
  });

  it("a NULL channel whose effective source is a manual override keeps channel_override", async () => {
    const h = service();
    h.channel.metaRoutingMode = null;
    h.prisma.auditLog.findMany.mockResolvedValue([
      {
        actorType: "user",
        action: "inbound_webhook.channel_routes_replaced",
        afterSummary: { routes: [] },
      },
    ]);
    await h.routes.replaceRoutes("w", "ch", { routes: [] }, "user");
    expect(h.channelUpdates).toEqual([{ metaRoutingMode: "channel_override" }]);
  });
});
