import { describe, expect, it, vi } from "vitest";
import { providerConversionPaidLeadSchema } from "@wpptrack/shared";
import {
  ctwaIntentAuthorized,
  isCtwaDestinationEntry,
  resolveCtwaDestination,
} from "../../src/inbound-webhooks/authorized-ctwa-destination";
import { MetaCapiAdapter } from "../../src/conversion-events/meta-capi.adapter";
import { buildMetaCapiPayload } from "../../src/conversion-events/meta-capi-payload.builder";
import { ctwaWorld } from "./ctwa-fixture";

const ack = () =>
  new Response(
    JSON.stringify({ events_received: 1, messages: [], fbtrace_id: "trace" }),
    { status: 200 },
  );

function adapter() {
  const fetcher = vi.fn(async () => ack());
  return {
    fetcher,
    adapter: new MetaCapiAdapter({}, fetcher as unknown as typeof fetch),
  };
}

const baseEvent = {
  accessToken: "token",
  eventName: "Purchase" as const,
  dedupeKey: "evt-1",
  phoneHash: "hash",
  valueCents: 1000,
  currency: "BRL",
  eventTime: new Date(Date.now() - 60_000),
};

describe("CTWA lead without ctwa_clid: nothing is sent to Meta", () => {
  it("never dispatches an event without ctwa_clid, with or without ad id or page/pixel", async () => {
    const { intent } = ctwaWorld();
    for (const input of [
      { ...baseEvent, pixelId: "pixel1", pageId: "page1", adId: "123", ctwaClid: null },
      { ...baseEvent, pixelId: "pixel1", pageId: "page1", adId: "123", ctwaClid: "  " },
      {
        ...baseEvent,
        pixelId: "pixel1",
        pageId: "page1",
        adId: null,
        ctwaClid: null,
        pagePixelDestination: intent,
      },
    ]) {
      const { adapter: capi, fetcher } = adapter();
      const result = await capi.sendEvent(input);
      expect(result).toMatchObject({
        status: "not_configured",
        errorCode: "MissingCtwaClid",
      });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it("rejects a paid lead without ctwa_clid at the decision contract", () => {
    const { intent } = ctwaWorld();
    for (const lead of [
      { id: "l", phoneHash: "h", campaignId: null, adSetId: null, adId: "123", ctwaClid: null },
      { id: "l", phoneHash: "h", campaignId: null, adSetId: null, adId: null, ctwaClid: "", ctwaDestination: intent },
    ])
      expect(providerConversionPaidLeadSchema.safeParse(lead).success).toBe(false);
  });

  it("keeps requiring an ad id when no authorized page/pixel proof exists", async () => {
    const { adapter: capi, fetcher } = adapter();
    const result = await capi.sendEvent({
      ...baseEvent,
      pixelId: "pixel1",
      pageId: "page1",
      adId: null,
      ctwaClid: "clid-1",
    });
    expect(result).toMatchObject({ status: "not_configured", errorCode: "MissingAdId" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      providerConversionPaidLeadSchema.safeParse({
        id: "l",
        phoneHash: "h",
        campaignId: null,
        adSetId: null,
        adId: null,
        ctwaClid: "clid-1",
      }).success,
    ).toBe(false);
  });
});

describe("CTWA lead with ctwa_clid and without ad id: sent to the authorized page/pixel (as the SaaS)", () => {
  it("dispatches with page_id + ctwa_clid and no ad_id", async () => {
    const { intent } = ctwaWorld();
    const { adapter: capi, fetcher } = adapter();
    const result = await capi.sendEvent({
      ...baseEvent,
      pixelId: "pixel1",
      pageId: "page1",
      adId: null,
      ctwaClid: "clid-1",
      pagePixelDestination: intent,
      customData: { ad_id: "leaked" } as never,
    });
    expect(result.status).toBe("sent");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/pixel1/events");
    const body = JSON.parse(String(request.body));
    expect(body.data[0].user_data).toEqual({
      ph: ["hash"],
      ctwa_clid: "clid-1",
      page_id: "page1",
    });
    expect(body.data[0].action_source).toBe("business_messaging");
    expect(body.data[0].custom_data).not.toHaveProperty("ad_id");
  });

  it("never uses the environment token nor a mismatched or stale destination", async () => {
    const { intent } = ctwaWorld();
    const fetcher = vi.fn(async () => ack());
    const capi = new MetaCapiAdapter(
      { META_CAPI_ACCESS_TOKEN: "env-token" },
      fetcher as unknown as typeof fetch,
    );
    const noToken = await capi.sendEvent({
      ...baseEvent,
      accessToken: undefined,
      pixelId: "pixel1",
      pageId: "page1",
      adId: null,
      ctwaClid: "clid-1",
      pagePixelDestination: intent,
    });
    expect(noToken.errorCode).toBe("MissingAccessToken");
    const mismatch = await capi.sendEvent({
      ...baseEvent,
      pixelId: "other",
      pageId: "page1",
      adId: null,
      ctwaClid: "clid-1",
      pagePixelDestination: intent,
    });
    expect(mismatch.errorCode).toBe("MissingMetaDestination");
    const stale = await capi.sendEvent({
      ...baseEvent,
      eventTime: new Date(Date.now() - 8 * 86_400_000),
      pixelId: "pixel1",
      pageId: "page1",
      adId: null,
      ctwaClid: "clid-1",
      pagePixelDestination: intent,
    });
    expect(stale.errorCode).toBe("MetaEventTimeExpired");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the ad-attributed payload unchanged", () => {
    const payload = buildMetaCapiPayload({
      eventName: "Purchase",
      eventTime: new Date(1_700_000_000_000),
      eventId: "e",
      phoneHash: "h",
      ctwaClid: "c",
      pageId: "p",
      adId: "123",
      valueCents: 500,
      currency: "BRL",
    });
    expect(payload.data[0]!.user_data).toEqual({ ph: ["h"], ctwa_clid: "c", page_id: "p" });
    expect(payload.data[0]!.custom_data).toMatchObject({ ad_id: "123", value: 5, currency: "BRL" });
  });
});

describe("CTWA page/pixel resolver (login scopes only, no WhatsApp Business permission)", () => {
  it("authorizes the unique page/pixel of an Unnichat number with the PalmUP login scopes", async () => {
    const { client, channel, intent } = ctwaWorld();
    const resolved = await resolveCtwaDestination(client as never, channel as never);
    expect(resolved).toEqual(intent);
    expect(await ctwaIntentAuthorized(client as never, intent)).toBe(true);
  });

  it("does not ask for whatsapp_business_management / whatsapp_business_manage_events", async () => {
    const { client, channel, credential } = ctwaWorld();
    expect(credential.scopes).not.toContain("whatsapp_business_management");
    expect(credential.scopes).not.toContain("whatsapp_business_manage_events");
    expect((await resolveCtwaDestination(client as never, channel as never)).kind).toBe(
      "authorized_ctwa_destination",
    );
  });

  it("fails closed on ambiguity, missing login scopes and legacy routing", async () => {
    const ambiguous = ctwaWorld({ secondDestination: true });
    expect(
      await resolveCtwaDestination(ambiguous.client as never, ambiguous.channel as never),
    ).toEqual({ kind: "blocked_ctwa_destination", reason: "ctwa_destination_ambiguous" });
    const noBm = ctwaWorld({ scopes: ["ads_read"] });
    expect(
      await resolveCtwaDestination(noBm.client as never, noBm.channel as never),
    ).toMatchObject({ kind: "blocked_ctwa_destination" });
    const legacy = ctwaWorld({ metaRoutingMode: null });
    // A legacy channel with no audit and no routes inherits (SaaS rule).
    expect(
      (await resolveCtwaDestination(legacy.client as never, legacy.channel as never)).kind,
    ).toBe("authorized_ctwa_destination");
    legacy.client.inboundWebhookChannelRoute.findMany.mockResolvedValue([
      { active: true, validationStatus: "valid", metaBusinessConnectionId: "bm1" },
    ] as never);
    expect(
      await resolveCtwaDestination(legacy.client as never, legacy.channel as never),
    ).toEqual({ kind: "blocked_ctwa_destination", reason: "ctwa_channel_routing_mode_unset" });
  });

  it("keeps existing providers (Umbler, Gupshup, Data Crazy, Cloud API, UAZAPI) on the ad route", async () => {
    for (const provider of ["umbler", "gupshup", "data_crazy", "meta_cloud", "uazapi"]) {
      const world = ctwaWorld({ provider });
      expect(
        await resolveCtwaDestination(world.client as never, world.channel as never),
      ).toEqual({ kind: "blocked_ctwa_destination", reason: "ctwa_channel_scope_invalid" });
      expect(
        isCtwaDestinationEntry({
          provider,
          classificationReason: "authorized_ctwa_destination",
          adId: null,
        }),
      ).toBe(false);
    }
  });
});
