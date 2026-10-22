import { describe, it, expect, vi, afterEach } from "vitest";
import { pagePixelHarness } from "./helpers/ctwa-harness";
import { offline } from "./helpers/first-entry-offline";
import { resolveCtwaDestination } from "../../src/inbound-webhooks/authorized-ctwa-destination";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";
import { InboundWebhookMetaRouteReaderService } from "../../src/inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { InboundWebhookProductionIntakeService } from "../../src/inbound-webhooks/inbound-webhook-production-intake.service";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import { LeadsService } from "../../src/leads/leads.service";
import { MetaCapiAdapter } from "../../src/conversion-events/meta-capi.adapter";
import { authorizedCtwaDestinationSchema } from "@wpptrack/shared";
import { applyInboundWebhookChannelStatus } from "../../src/inbound-webhooks/inbound-webhook-production-activation";

function pageOffline() {
  const h = offline();
  return { ...h, ...pagePixelHarness(h) };
}
function reader(h: ReturnType<typeof pageOffline>) {
  return new InboundWebhookChannelRoutesService(
    h.prisma,
    new InboundWebhookMetaRouteReaderService(h.prisma),
  ) as any;
}
afterEach(() => vi.useRealTimers());
describe("Unnichat authorized unique workspace page/pixel without ad (synthetic fetch boundary)", () => {
  it("collapses four BM/eight account credential candidates to one explicit typed target", async () => {
    const h = pagePixelHarness();
    const intent = await resolveCtwaDestination(h.prisma, h.channel);
    expect(intent).toMatchObject({
      kind: "authorized_ctwa_destination",
      deliveryKind: "page_pixel",
      destinationId: "dest",
      businessConnectionId: "bm",
      pixelId: "synthetic_pixel",
      pageId: "synthetic_page",
    });
    expect(intent).not.toHaveProperty("wabaId");
    expect(intent).not.toHaveProperty("adAccountId");
    expect(authorizedCtwaDestinationSchema.safeParse(intent).success).toBe(
      true,
    );
  });
  it("actual route reader, intake, production recorder, canonical queue and processor send one no-ad page event across retries", async () => {
    const h = pageOffline();
    const route = await reader(h).evaluateEventRoute(h.channel, null);
    expect(route.reason).toBe("authorized_ctwa_destination");
    expect(await reader(h).effectiveEntryReadiness(h.channel)).toMatchObject({
      source: "inherit_workspace",
      eligible: true,
      ctwaDestinationReadiness: { status: "verified" },
    });
    h.prisma.inboundWebhookProductionItem.createMany = vi.fn(async () => ({
      count: 1,
    }));
    h.prisma.inboundWebhookProductionItem.findMany = vi.fn(async () => [
      h.item,
    ]);
    const intakeQueue = {
      enqueueItem: vi.fn(async () => ({ status: "queued" })),
    };
    const intake = new InboundWebhookProductionIntakeService(
      h.prisma,
      intakeQueue as any,
      (h.production as any).env,
    );
    expect(
      await intake.enqueueDelivery({
        workspaceId: "w",
        connectionId: "c",
        deliveryId: "d",
      }),
    ).toMatchObject({ eligible: 1, queued: 1 });
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    expect(h.logs[0]).toMatchObject({
      status: "ready_to_send",
      adId: null,
      metaAccountId: null,
      campaignId: null,
      attributionStatus: "ctwa_ad_unknown",
      ctwaClid: h.payload.ctwa_clid,
      eventOccurredAt: h.event.occurredAt,
    });
    const eventId = h.logs[0].eventId;
    expect(await h.processor.process(h.jobs[0])).toMatchObject({
      status: "sent",
    });
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    await h.processor.process(h.jobs[0]);
    expect(h.calls).toHaveLength(1);
    expect(h.logs).toHaveLength(1);
    expect(h.leads).toHaveLength(1);
    expect(h.calls[0].url).toContain("/synthetic_pixel/events");
    expect(h.calls[0].body.data[0]).toMatchObject({
      event_id: eventId,
      event_time: Math.floor(h.event.occurredAt.getTime() / 1000),
      user_data: {
        ph: [h.logs[0].phoneHash],
        page_id: "synthetic_page",
        ctwa_clid: h.payload.ctwa_clid,
      },
    });
    expect(h.calls[0].body.data[0].user_data).not.toHaveProperty(
      "whatsapp_business_account_id",
    );
    expect(h.calls[0].body.data[0].custom_data).not.toHaveProperty("ad_id");
    expect(h.prisma.metaAd.findFirst).not.toHaveBeenCalled();
  });
  it.each([
    "pixel",
    "page",
    "token",
    "foreign",
    "foreign_credential",
    "revoked",
    "scope",
    "ineligible",
    "ambiguous",
    "unvalidated",
    "override",
    "expired",
    "invalid_destination",
  ])("fails closed for %s with zero synthetic fetch", async (kind) => {
    const h = pageOffline();
    if (kind === "pixel") h.destination.pixelId = "";
    if (kind === "page") h.destination.pageId = "";
    if (kind === "token") h.credential.encryptedAccessToken = "";
    if (kind === "foreign") h.destination.workspaceId = "other";
    if (kind === "foreign_credential") h.credential.workspaceId = "other";
    if (kind === "revoked") h.credential.status = "revoked";
    if (kind === "scope") h.credential.scopes = ["business_management"];
    if (kind === "expired") h.credential.expiresAt = new Date(0);
    if (kind === "invalid_destination") h.destination.status = "error";
    if (kind === "ineligible")
      h.accounts.forEach(
        (a) =>
          (a.allowedDestinations = [
            { active: false, conversionDestinationId: "dest" },
          ] as any),
      );
    if (kind === "unvalidated")
      h.businesses.forEach((b) => (b.lastValidatedAt = null));
    if (kind === "override") h.channel.metaRoutingMode = "channel_override";
    if (kind === "ambiguous") {
      h.accounts[0].allowedDestinations = ["dest", "other"].map(
        (conversionDestinationId) => ({
          active: true,
          conversionDestinationId,
          workspaceId: "w",
          reportingAccountId: h.accounts[0].id,
        }),
      ) as any;
      h.prisma.metaConversionDestination.findMany.mockResolvedValue([
        h.destination,
        { ...h.destination, id: "other", pageId: "other_page" },
      ]);
    }
    expect(await resolveCtwaDestination(h.prisma, h.channel)).toMatchObject({
      kind: "blocked_ctwa_destination",
    });
    await expect(
      h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    ).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.logs).toHaveLength(0);
  });
  it("revalidates page eligibility after canonical materialization", async () => {
    const h = pageOffline();
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    h.accounts.forEach((a) => (a.active = false));
    expect(await h.processor.process(h.jobs[0])).toMatchObject({
      status: "skipped",
    });
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it.each(["pixel", "page", "fingerprint", "scope", "rotated_unvalidated"])(
    "blocks %s changed after the recorder before sender effects",
    async (kind) => {
      const h = pageOffline();
      await h.production.processItem({
        workspaceId: "w",
        productionItemId: "item",
      });
      if (kind === "pixel") h.destination.pixelId = "changed";
      if (kind === "page") h.destination.pageId = "changed";
      if (kind === "fingerprint") h.credential.fingerprint = "rotated";
      if (kind === "scope") h.credential.scopes = [];
      if (kind === "rotated_unvalidated") h.credential.rotatedAt = new Date();
      expect(await h.processor.process(h.jobs[0])).toMatchObject({
        status: "skipped",
      });
      expect(h.fetcher).not.toHaveBeenCalled();
    },
  );
  it("rechecks absolute credential expiry after the final resolver await and before fetch", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const h = pageOffline();
    h.credential.expiresAt = new Date(now + 10);
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    const resolver = (h.conversions as any).connectionResolver;
    const original = resolver.resolveAuthorizedCtwaDestination.bind(resolver);
    vi.spyOn(resolver, "resolveAuthorizedCtwaDestination").mockImplementation(
      async (...args: unknown[]) => {
        const result = await original(...args);
        vi.setSystemTime(now + 20);
        return result;
      },
    );
    expect(await h.processor.process(h.jobs[0])).toMatchObject({
      status: "not_configured",
      errorCode: "MissingMetaDestination",
    });
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("an expired historical occurrence remains a local lead with no restamp or fetch", async () => {
    const h = pageOffline();
    h.event.occurredAt = new Date(Date.now() - 8 * 86400000);
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    expect(h.logs[0]).toMatchObject({
      status: "not_eligible",
      errorCode: "MetaEventTimeExpired",
      eventOccurredAt: h.event.occurredAt,
    });
    expect(h.leads).toHaveLength(1);
    expect(h.jobs).toHaveLength(0);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("later legitimate ad context keeps canonical account and hierarchy instead of using the no-ad intent", async () => {
    const h = pageOffline();
    h.prisma.metaAd.findFirst.mockResolvedValue({
      adAccountId: "legitimate_account",
      destinationAssignment: null,
    });
    h.prisma.metaReportingAccount.findFirst = vi.fn(async () => ({
      ...h.accounts[0],
      adAccountId: "legitimate_account",
      // This edition's route reader never lets a BM default alone grant an
      // account a destination: the account carries its explicit binding.
      conversionDestinationId: "dest",
    }));
    h.prisma.providerConversionRuleExecution = {
      findFirst: vi.fn(async () => null),
    };
    h.prisma.purchaseReview = { updateMany: vi.fn(async () => ({ count: 0 })) };
    expect(
      await new InboundWebhookMetaRouteReaderService(h.prisma).previewRoute({
        workspaceId: "w",
        adId: "legitimate_ad",
      }),
    ).toMatchObject({
      status: "resolved",
      adAccountId: "legitimate_account",
      reportingAccountId: h.accounts[0].id,
    });
    await h.conversions.recordExternalConversion({
      workspaceId: "w",
      sourceEventId: "known_ad_event",
      sourceTrigger: "synthetic_known_ad",
      eventName: "LeadSubmitted",
      eventId: "known_ad_id",
      dedupeKey: "known_ad_dedupe",
      phoneHash: "hash",
      businessSource: "paid",
      adId: "legitimate_ad",
      adSetId: "legitimate_adset",
      campaignId: "legitimate_campaign",
      ctwaClid: "known_click",
      eventOccurredAt: new Date(),
    });
    expect(h.logs[0]).toMatchObject({
      status: "ready_to_send",
      attributionStatus: "attributed",
      adId: "legitimate_ad",
      adSetId: "legitimate_adset",
      campaignId: "legitimate_campaign",
    });
    // The canonical (known ad) send itself goes through this edition's own
    // route resolver and is covered by its existing sender tests.
  });
  it("activates a channel with inherited effective workspace eligibility and zero local routes", async () => {
    const h = pageOffline();
    h.channel.updatedAt = new Date();
    h.prisma.inboundWebhookChannel.updateMany = vi.fn(async ({ data }: any) => {
      Object.assign(h.channel, data);
      return { count: 1 };
    });
    h.prisma.auditLog.create = vi.fn(async () => ({}));
    await expect(
      applyInboundWebhookChannelStatus(h.prisma, {
        workspaceId: "w",
        channelId: "ch",
        status: "active",
        actorUserId: "synthetic_owner",
        requireValidMetaRoute: true,
        seats: { enforcementEnabled: () => false, activateSeat: vi.fn() },
      }),
    ).resolves.toMatchObject({ status: "active", routes: [] });
    h.prisma.metaIntegration.findUnique.mockResolvedValue({
      advancedRoutingEnabled: false,
    });
    await expect(
      applyInboundWebhookChannelStatus(h.prisma, {
        workspaceId: "w",
        channelId: "ch",
        status: "active",
        actorUserId: "synthetic_owner",
        requireValidMetaRoute: true,
        seats: { enforcementEnabled: () => false, activateSeat: vi.fn() },
      }),
    ).rejects.toThrow();
  });
  it("two inbound numbers share the workspace target without per-number account rows or duplicate events", async () => {
    const h = pageOffline();
    const firstChannel = { ...h.channel };
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    await h.processor.process(h.jobs[0]);
    Object.assign(h.channel, {
      id: "ch2",
      providerChannelId: "551100001021",
      connectedPhone: "551100001021",
    });
    const parsed = new InboundWebhookParserRegistry()
      .resolve({
        provider: "unnichat",
        parserVersion: "v1",
        parserReleaseStatus: "certified",
      })
      .parse(h.payload, {
        organizationId: "w",
        connectedPhone: h.channel.providerChannelId,
      }).events[0];
    const second = {
      ...h.item,
      id: "item2",
      status: "queued",
      event: {
        ...h.event,
        id: "e2",
        channelId: "ch2",
        dedupeKey: parsed.dedupeKey,
        normalizedSummary: parsed.normalizedSummary,
      },
    };
    Object.assign(h.event, second.event);
    h.prisma.inboundWebhookChannel.findFirst.mockImplementation(
      async ({ where }: any) => (where.id === "ch" ? firstChannel : h.channel),
    );
    Object.assign(h.item, second);
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item2",
    });
    expect(h.logs).toHaveLength(2);
    expect(h.logs[0].eventId).not.toBe(h.logs[1].eventId);
    expect(await h.conversions.sendReadyEvent(h.logs[1].id)).toMatchObject({
      status: "sent",
    });
    await h.conversions.sendReadyEvent(h.logs[1].id);
    expect(h.calls).toHaveLength(2);
    expect(new Set(h.calls.map((c) => new URL(c.url).pathname))).toEqual(
      new Set(["/v21.0/synthetic_pixel/events"]),
    );
    expect(h.channel.routes).toEqual([]);
    expect(h.accounts).toHaveLength(8);
  });
  it("uses deterministic credential ordering only after target uniqueness and tolerates a revoked equivalent candidate", async () => {
    const h = pagePixelHarness();
    h.accounts.reverse();
    expect(await resolveCtwaDestination(h.prisma, h.channel)).toMatchObject({
      businessConnectionId: "bm",
    });
    h.business.status = "paused";
    expect(await resolveCtwaDestination(h.prisma, h.channel)).toMatchObject({
      businessConnectionId: "bm2",
    });
  });
  it("reuses a selected account destination already validated with its token, without requiring a number mapping", async () => {
    const h = pagePixelHarness();
    h.businesses.forEach(
      (b) => (b.defaultConversionDestinationId = "unselected"),
    );
    h.accounts[0].allowedDestinations = [
      {
        workspaceId: "w",
        reportingAccountId: h.accounts[0].id,
        conversionDestinationId: "dest",
        active: true,
        updatedAt: new Date(Date.now() - 2000),
      },
    ] as any;
    expect(await resolveCtwaDestination(h.prisma, h.channel)).toMatchObject({
      deliveryKind: "page_pixel",
      destinationId: "dest",
    });
    // Rotation validates BM defaults; a separate selected destination needs a
    // selection validation performed under the newly rotated credential.
    h.credential.rotatedAt = new Date(Date.now() - 500);
    h.credential.lastValidatedAt = new Date();
    h.businesses.forEach((b) => (b.lastValidatedAt = new Date()));
    expect(await resolveCtwaDestination(h.prisma, h.channel)).toMatchObject({
      kind: "blocked_ctwa_destination",
    });
    (h.accounts[0].allowedDestinations[0] as any).updatedAt = new Date();
    expect(await resolveCtwaDestination(h.prisma, h.channel)).toMatchObject({
      deliveryKind: "page_pixel",
      destinationId: "dest",
    });
  });
  it("unknown delivery remains permanently fenced on page/pixel retries", async () => {
    const h = pageOffline();
    h.fetcher.mockRejectedValue(new Error("synthetic lost ACK"));
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    expect(await h.processor.process(h.jobs[0])).toMatchObject({
      errorCode: "MetaCapiDeliveryUnknown",
    });
    await h.processor.process(h.jobs[0]);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.logs[0].status).toBe("delivery_unknown");
  });
  it("missing real ctwa_clid cannot be replaced by an unconfirmed alias or fabricated ad", async () => {
    const h = pageOffline();
    h.payload.CTWA_ID = h.payload.ctwa_clid;
    h.payload.adId = "synthetic_ad";
    delete h.payload.ctwa_clid;
    await expect(
      h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    ).rejects.toThrow();
    expect(h.logs).toHaveLength(0);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("adapter scoped page intent bypasses only its own ad guard and keeps real ad_id when later known", async () => {
    const h = pagePixelHarness();
    const intent = await resolveCtwaDestination(h.prisma, h.channel);
    const fetcher = vi.fn(
      async () => new Response('{"events_received":1,"messages":[],"fbtrace_id":"t"}', { status: 200 }),
    );
    const adapter = new MetaCapiAdapter({}, fetcher);
    const input: any = {
      accessToken: "synthetic",
      pixelId: "synthetic_pixel",
      pageId: "synthetic_page",
      adId: null,
      ctwaClid: "real_current_field",
      phoneHash: "hash",
      eventName: "LeadSubmitted",
      dedupeKey: "id",
      eventTime: new Date(),
      pagePixelDestination: intent,
    };
    expect((await adapter.sendEvent(input)).status).toBe("sent");
    input.adId = "legitimate_ad";
    expect(
      (await adapter.sendEvent(input)).requestPayload?.data[0].custom_data
        .ad_id,
    ).toBe("legitimate_ad");
    delete input.pagePixelDestination;
    input.adId = null;
    expect((await adapter.sendEvent(input)).errorCode).toBe("MissingAdId");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
