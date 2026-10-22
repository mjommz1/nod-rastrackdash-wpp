import { describe, expect, it, vi } from "vitest";
import { authorizedCtwaDestinationSchema } from "@wpptrack/shared";
import { ctwaHarness, pagePixelHarness } from "./helpers/ctwa-harness";
import {
  CTWA_DESTINATION_REASON,
  ctwaIntentAuthorized,
  isCtwaDestinationEntry,
  resolveCtwaDestination,
} from "../src/inbound-webhooks/authorized-ctwa-destination";
import { crmChannelDestination } from "../src/crm-channels/crm-channel-policy";
import { isCrmCtwaContext } from "../src/crm-channels/crm-ctwa-context";
import { KOMMO_CTWA_PROCESSING_MODE } from "../src/kommo/kommo-publication-policy";
import { PIPEDRIVE_CTWA_PROCESSING_MODE } from "../src/pipedrive/pipedrive-production-policy";
import { InboundWebhookChannelRoutesService } from "../src/inbound-webhooks/inbound-webhook-channel-routes.service";
import { InboundWebhookMetaRouteReaderService } from "../src/inbound-webhooks/inbound-webhook-meta-route-reader.service";

/** A Gupshup (official API) number of the workspace: no WhatsApp instance. */
function gupshup<T extends { channel: any }>(h: T, provider = "gupshup"): T {
  h.channel.connection.provider = provider;
  h.channel.whatsappInstanceId = null;
  return h;
}

function ambiguous(h: ReturnType<typeof pagePixelHarness>) {
  h.accounts[0]!.allowedDestinations = ["dest", "other"].map(
    (conversionDestinationId) => ({
      active: true,
      conversionDestinationId,
      workspaceId: "w",
      reportingAccountId: h.accounts[0]!.id,
    }),
  ) as any;
  h.prisma.metaConversionDestination.findMany.mockResolvedValue([
    h.destination,
    {
      ...h.destination,
      id: "other",
      pixelId: "other_pixel",
      pageId: "other_page",
    },
  ]);
}

function routesService(prisma: any) {
  return new InboundWebhookChannelRoutesService(
    prisma,
    new InboundWebhookMetaRouteReaderService(prisma),
  ) as any;
}

describe("CRM page/pixel destination for numbers of any provider", () => {
  it.each(["gupshup", "umbler", "datacrazy", "gohighlevel"])(
    "a %s number inheriting the workspace resolves the verified unique page/pixel in CRM mode",
    async (provider) => {
      const h = gupshup(pagePixelHarness(), provider);
      const intent = await crmChannelDestination(h.prisma, h.channel);
      expect(intent).toMatchObject({
        kind: "authorized_ctwa_destination",
        deliveryKind: "page_pixel",
        channelId: "ch",
        connectionId: "c",
        destinationId: "dest",
        pixelId: "synthetic_pixel",
        pageId: "synthetic_page",
      });
      expect(authorizedCtwaDestinationSchema.safeParse(intent).success).toBe(
        true,
      );
    },
  );

  it("rejects ambiguous (pixel, page) pairs", async () => {
    const h = gupshup(pagePixelHarness());
    ambiguous(h);
    expect(await crmChannelDestination(h.prisma, h.channel)).toEqual({
      kind: "blocked_ctwa_destination",
      reason: "ctwa_destination_ambiguous",
    });
  });

  it("requires inherit_workspace for non-Unnichat numbers", async () => {
    const override = gupshup(pagePixelHarness());
    override.channel.metaRoutingMode = "channel_override";
    override.prisma.inboundWebhookChannelRoute.findMany.mockResolvedValue([
      {
        id: "route",
        active: true,
        validationStatus: "valid",
        metaBusinessConnectionId: "bm",
        metaReportingAccountId: null,
        metaConversionDestinationId: null,
      },
    ]);
    expect(
      await crmChannelDestination(override.prisma, override.channel),
    ).toEqual({
      kind: "blocked_ctwa_destination",
      reason: "ctwa_channel_routing_not_inherited",
    });
    // Unset mode with routes and no audit trail stays legacy_unknown.
    const legacy = gupshup(pagePixelHarness());
    legacy.channel.metaRoutingMode = null;
    legacy.prisma.inboundWebhookChannelRoute.findMany.mockResolvedValue([
      { id: "route", active: true, validationStatus: "valid" },
    ]);
    expect(await crmChannelDestination(legacy.prisma, legacy.channel)).toEqual(
      {
        kind: "blocked_ctwa_destination",
        reason: "ctwa_channel_routing_mode_unset",
      },
    );
  });

  it("never applies to a UAZAPI number or a number bridged to a WhatsApp instance", async () => {
    const uazapi = gupshup(pagePixelHarness(), "uazapi");
    expect(await crmChannelDestination(uazapi.prisma, uazapi.channel)).toEqual(
      { kind: "blocked_ctwa_destination", reason: "ctwa_channel_scope_invalid" },
    );
    const bridged = gupshup(pagePixelHarness());
    bridged.channel.whatsappInstanceId = "instance-a";
    expect(
      await crmChannelDestination(bridged.prisma, bridged.channel),
    ).toEqual({
      kind: "blocked_ctwa_destination",
      reason: "ctwa_channel_scope_invalid",
    });
  });

  it("never uses the WABA binding path for non-Unnichat numbers", async () => {
    // Destination verified only through a WABA binding listing the number.
    const h = gupshup(ctwaHarness());
    expect(await crmChannelDestination(h.prisma, h.channel)).toEqual({
      kind: "blocked_ctwa_destination",
      reason: "ctwa_verified_binding_missing",
    });
  });

  it("keeps Unnichat resolution identical with or without CRM mode", async () => {
    // The student edition resolves only the verified page/pixel pair; a
    // destination verified solely through a WABA binding stays blocked, the
    // same with or without CRM mode.
    for (const [make, kind] of [
      [() => pagePixelHarness(), "authorized_ctwa_destination"],
      [() => ctwaHarness(), "blocked_ctwa_destination"],
    ] as const) {
      const h = make();
      const canonical = await resolveCtwaDestination(h.prisma, h.channel);
      expect(canonical.kind).toBe(kind);
      expect(await crmChannelDestination(h.prisma, h.channel)).toEqual(
        canonical,
      );
    }
    const blocked = pagePixelHarness();
    ambiguous(blocked);
    expect(await crmChannelDestination(blocked.prisma, blocked.channel)).toEqual(
      await resolveCtwaDestination(blocked.prisma, blocked.channel),
    );
  });

  it("re-authorizes a CRM page/pixel intent only in a CRM context and revokes it on pause", async () => {
    const h = gupshup(pagePixelHarness());
    const intent = await crmChannelDestination(h.prisma, h.channel);
    if (intent.kind !== "authorized_ctwa_destination") throw new Error();
    h.prisma.inboundWebhookChannel = {
      findFirst: vi.fn(async () => structuredClone(h.channel)),
    };
    const crm = { crmContext: true };
    expect(await ctwaIntentAuthorized(h.prisma, intent, crm)).toBe(true);
    // Entries, replay and provider conversions (no CRM context) stay
    // Unnichat-only, whatever the intent shape.
    expect(await ctwaIntentAuthorized(h.prisma, intent)).toBe(false);
    expect(
      await ctwaIntentAuthorized(h.prisma, { ...intent, pageId: "changed" }, crm),
    ).toBe(false);
    h.channel.status = "paused";
    expect(await ctwaIntentAuthorized(h.prisma, intent, crm)).toBe(false);
  });

  it("enables the CRM context only for Kommo/Pipedrive page/pixel conversions", () => {
    expect(isCrmCtwaContext({ processingMode: KOMMO_CTWA_PROCESSING_MODE })).toBe(
      true,
    );
    expect(
      isCrmCtwaContext({ processingMode: PIPEDRIVE_CTWA_PROCESSING_MODE }),
    ).toBe(true);
    for (const payload of [
      { processingMode: "live_production" },
      { processingMode: "authorized_replay" },
      { processingMode: "frozen_provider_conversion" },
      null,
      [],
    ])
      expect(isCrmCtwaContext(payload)).toBe(false);
  });
});

describe("Inbound entry routing of non-Unnichat providers is unchanged (regression)", () => {
  it("the canonical entry resolver still refuses a Gupshup number with a unique page/pixel", async () => {
    const h = gupshup(pagePixelHarness());
    expect(await resolveCtwaDestination(h.prisma, h.channel)).toEqual({
      kind: "blocked_ctwa_destination",
      reason: "ctwa_channel_scope_invalid",
    });
  });

  it("a Gupshup entry without ad stays unresolved (route_ad_missing), never page/pixel routed", async () => {
    const h = gupshup(pagePixelHarness());
    const decision = await routesService(h.prisma).evaluateEventRoute(
      h.channel,
      null,
    );
    expect(decision).toMatchObject({
      classification: "eligible_route_unresolved",
      reason: "route_ad_missing",
    });
    // An unknown ad on a Gupshup number never borrows the page/pixel fallback.
    const withAd = await routesService(h.prisma).evaluateEventRoute(
      h.channel,
      "unknown-ad",
    );
    expect(withAd).toMatchObject({
      classification: "eligible_route_unresolved",
      reason: "route_not_configured",
    });
    expect(
      isCtwaDestinationEntry({
        provider: "gupshup",
        classificationReason: CTWA_DESTINATION_REASON,
        adId: null,
      }),
    ).toBe(false);
  });

  it("reports the CRM readiness of a Gupshup number without an entry routing policy", async () => {
    const h = gupshup(pagePixelHarness());
    expect(
      await routesService(h.prisma).crmDestinationReadiness(h.channel),
    ).toEqual({ status: "verified", reason: "authorized_ctwa_destination" });
    ambiguous(h);
    expect(
      await routesService(h.prisma).crmDestinationReadiness(h.channel),
    ).toEqual({ status: "not_ready", reason: "ctwa_destination_ambiguous" });
  });
});
