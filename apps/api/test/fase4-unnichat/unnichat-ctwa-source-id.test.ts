import { afterEach, describe, expect, it, vi } from "vitest";
import { UnnichatV1Parser } from "../../src/inbound-webhooks/providers/unnichat/unnichat-v1.parser";
import { parseUnnichatAutomationV1 } from "../../src/inbound-webhooks/providers/unnichat/unnichat-automation-v1.parser";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";
import { InboundWebhookMetaRouteReaderService } from "../../src/inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { InboundWebhookObservationService } from "../../src/inbound-webhooks/inbound-webhook-observation.service";
import { offline } from "./helpers/first-entry-offline";
import { pagePixelHarness } from "./helpers/ctwa-harness";

// Literal user JSON, substituting only the phone and identifier placeholders.
const exactInput = {
  event: "Lead",
  event_name: "Lead",
  phone: "5500000000000",
  external_id: "5500000000000",
  ctwa_clid: "synthetic_click_token",
  ctwa_id: "001234567890123456",
  source_type: "ctwa",
  lead_source: "meta_ads",
  source: "unnichat",
  channel: "whatsapp",
  origin: "ctwa",
};
const parser = new UnnichatV1Parser();
const context = { organizationId: "w", connectedPhone: "551100001020" };
const oldInput = () => {
  const { ctwa_id, ...old } = exactInput;
  return old;
};
afterEach(() => vi.useRealTimers());

describe("confirmed lowercase Unnichat SourceID contract", () => {
  it.each(["direct", "single_body"])(
    "%s accepts different click and source tokens without inventing context",
    (wrapper) => {
      const result = parser.parse(
        wrapper === "direct" ? exactInput : [{ body: exactInput }],
        context,
      );
      expect(result).toMatchObject({
        classification: "eligible_route_unresolved",
        events: [
          {
            providerEventType: "Lead",
            hasCtwa: true,
            ctwaClid: exactInput.ctwa_clid,
            adId: exactInput.ctwa_id,
            ad: null,
            normalizedSummary: { adId: exactInput.ctwa_id },
          },
        ],
      });
      expect(result.events[0]).not.toHaveProperty("campaignId");
      expect(result.events[0]).not.toHaveProperty("adAccountId");
      expect(JSON.stringify(result.events[0].normalizedSummary)).not.toContain(
        exactInput.ctwa_clid,
      );
    },
  );

  it.each([undefined, null, "", "   "])(
    "keeps missing/blank/null SourceID compatible (%s)",
    (ctwa_id) => {
      vi.useFakeTimers();
      expect(parser.parse({ ...oldInput(), ctwa_id }, context)).toEqual(
        parser.parse(oldInput(), context),
      );
    },
  );

  it.each([
    123,
    false,
    {},
    [],
    "x".repeat(256),
    "bad\u0000id",
    "bad\nid",
    " source",
    "source ",
    "source id",
    "\tsource",
  ])("fails closed for invalid raw SourceID %j", (ctwa_id) => {
    expect(parser.parse({ ...exactInput, ctwa_id }, context)).toMatchObject({
      classification: "invalid_payload",
      classificationReason: "payload_validation_failed",
      events: [],
    });
    expect(parseUnnichatAutomationV1({ ...exactInput, ctwa_id })).toMatchObject(
      { ok: false },
    );
  });

  it("preserves an opaque identifier exactly within the existing 255-character bound", () => {
    const ctwa_id = "synthetic_source_" + "x".repeat(238);
    expect(ctwa_id).toHaveLength(255);
    expect(
      parser.parse({ ...exactInput, ctwa_id }, context).events[0]?.adId,
    ).toBe(ctwa_id);
  });

  it.each([undefined, null, "", "   "])(
    "SourceID alone cannot supply missing click (%s)",
    (ctwa_clid) => {
      expect(parser.parse({ ...exactInput, ctwa_clid }, context)).toMatchObject(
        {
          classification: "ignored_no_ctwa",
          events: [
            { hasCtwa: false, ctwaClid: null, adId: exactInput.ctwa_id },
          ],
        },
      );
    },
  );

  it("ignores unconfirmed uppercase/ad aliases, including when they disagree with the real click", () => {
    const fields = {
      CTWA_ID: "different",
      CTWA_CLID: "different",
      SourceID: "different",
      adId: "different",
      ad_id: "different",
    };
    expect(
      parser.parse({ ...oldInput(), ...fields }, context).events[0],
    ).toMatchObject({ ctwaClid: exactInput.ctwa_clid, adId: null });
    expect(
      parser.parse({ ...oldInput(), ...fields, ctwa_clid: null }, context)
        .classification,
    ).toBe("ignored_no_ctwa");
  });

  it.each([123, {}, "x".repeat(2049), "bad\u0000click"])(
    "a valid SourceID cannot bypass invalid click validation (%j)",
    (ctwa_clid) => {
      expect(parser.parse({ ...exactInput, ctwa_clid }, context)).toMatchObject(
        {
          classification: "invalid_payload",
          events: [],
        },
      );
    },
  );

  it("source enrichment leaves event dedupe and automation execution identity unchanged", () => {
    vi.useFakeTimers();
    const old = parser.parse(oldInput(), context).events[0];
    const enriched = parser.parse(exactInput, context).events[0];
    expect(enriched.dedupeKey).toBe(old.dedupeKey);
    expect(enriched.normalizedSummary.ctwaEntryIdentityHash).toBe(
      old.normalizedSummary.ctwaEntryIdentityHash,
    );
    expect(parseUnnichatAutomationV1(exactInput)).toEqual(
      parseUnnichatAutomationV1(oldInput()),
    );
    expect(parseUnnichatAutomationV1([{ body: exactInput }])).toEqual(
      parseUnnichatAutomationV1(oldInput()),
    );
    expect(
      parser.parse({ ...exactInput, ctwa_clid: "second_click" }, context)
        .events[0].dedupeKey,
    ).not.toBe(old.dedupeKey);
  });
});

function composition() {
  const h = offline();
  const page = pagePixelHarness(h);
  Object.assign(h.payload, exactInput);
  const account: any = {
    ...page.accounts[2],
    adAccountId: "canonical_account",
  };
  Object.assign(page.accounts[2], account);
  const destination = {
    ...h.destination,
    id: "canonical_dest",
    pixelId: "canonical_pixel",
    pageId: "canonical_page",
  };
  account.allowedDestinations = [
    { active: true, conversionDestinationId: destination.id },
  ] as any;
  Object.assign(page.accounts[2], account);
  const ad: any = {
    workspaceId: "w",
    adId: exactInput.ctwa_id,
    adAccountId: account.adAccountId,
    campaignId: "canonical_campaign",
    adSetId: "canonical_adset",
    destinationAssignment: {
      reportingAccountId: account.id,
      conversionDestinationId: destination.id,
    },
  };
  h.prisma.metaAd.findFirst.mockImplementation(async ({ where }: any) =>
    where.workspaceId === ad.workspaceId &&
    where.adId === ad.adId &&
    (!where.adAccountId || where.adAccountId === ad.adAccountId)
      ? ad
      : null,
  );
  h.prisma.metaReportingAccount.findFirst = vi.fn(async ({ where }: any) =>
    where.workspaceId === account.workspaceId &&
    where.adAccountId === account.adAccountId &&
    (!where.id || where.id === account.id) &&
    (!where.active || account.active)
      ? account
      : null,
  );
  h.prisma.metaConversionDestination.findFirst.mockImplementation(
    async ({ where }: any) =>
      [h.destination, destination].find(
        (d) =>
          d.id === where.id &&
          d.workspaceId === where.workspaceId &&
          d.status === where.status,
      ) ?? null,
  );
  h.prisma.providerConversionRuleExecution = {
    findFirst: vi.fn(async () => null),
  };
  h.prisma.purchaseReview = { updateMany: vi.fn(async () => ({ count: 0 })) };
  // This edition's sender re-reads the account allowlist rows.
  h.prisma.metaReportingAccountDestination = {
    findMany: vi.fn(async ({ where }: any) =>
      where.reportingAccountId === account.id
        ? account.allowedDestinations
        : [],
    ),
  };
  const routes = new InboundWebhookChannelRoutesService(
    h.prisma,
    new InboundWebhookMetaRouteReaderService(h.prisma),
  ) as any;
  async function routeInput(input: object = h.payload) {
    const parsed = parser.parse(input, context).events[0];
    const route = await routes.evaluateEventRoute(h.channel, parsed.adId);
    Object.assign(h.event, {
      adId: parsed.adId,
      hasCtwa: parsed.hasCtwa,
      dedupeKey: parsed.dedupeKey,
      externalMessageId: parsed.externalMessageId,
      normalizedSummary: parsed.normalizedSummary,
      classification: route.classification,
      classificationReason: route.reason,
      resolvedBusinessConnectionId: route.preview?.businessConnectionId ?? null,
      resolvedReportingAccountId: route.preview?.reportingAccountId ?? null,
      resolvedConversionDestinationId:
        route.preview?.conversionDestinationId ?? null,
      resolvedBusinessConnection:
        page.businesses.find(
          (b) => b.id === route.preview?.businessConnectionId,
        ) ?? null,
      resolvedReportingAccount:
        route.preview?.reportingAccountId === account.id ? account : null,
      resolvedConversionDestination:
        route.preview?.conversionDestinationId === destination.id
          ? destination
          : h.destination,
    });
    return { parsed, route };
  }
  return { ...h, ...page, account, destination, ad, routes, routeInput };
}

describe("SourceID through current scoped resolver and canonical recorder", () => {
  it("resolves the stored workspace ad, account, hierarchy and actual selected destination; sends once", async () => {
    const h = composition();
    expect((await h.routeInput()).route).toMatchObject({
      classification: "eligible_route_resolved",
      reason: "route_resolved",
      preview: {
        reportingAccountId: h.account.id,
        businessConnectionId: "bm2",
        conversionDestinationId: "canonical_dest",
      },
    });
    expect(h.channel.routes).toEqual([]);
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    expect(h.leads[0]).toMatchObject({
      adId: exactInput.ctwa_id,
      campaignId: "canonical_campaign",
      adSetId: "canonical_adset",
      ctwaClid: exactInput.ctwa_clid,
    });
    expect(h.logs[0]).toMatchObject({
      attributionStatus: "attributed",
      metaAccountId: "canonical_account",
      metaBusinessConnectionId: "bm2",
      metaConversionDestinationId: "canonical_dest",
      adId: exactInput.ctwa_id,
      campaignId: "canonical_campaign",
      adSetId: "canonical_adset",
      eventOccurredAt: h.event.occurredAt,
    });
    expect(await h.processor.process(h.jobs[0])).toMatchObject({
      status: "sent",
    });
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    await h.processor.process(h.jobs[0]);
    expect(h.logs).toHaveLength(1);
    expect(h.leads).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toContain("/canonical_pixel/events");
    expect(h.calls[0].body.data[0]).toMatchObject({
      event_id: h.logs[0].eventId,
      event_time: Math.floor(h.event.occurredAt.getTime() / 1000),
      user_data: { page_id: "canonical_page", ctwa_clid: exactInput.ctwa_clid },
      custom_data: { ad_id: exactInput.ctwa_id },
    });
    for (const [query] of h.prisma.metaAd.findFirst.mock.calls)
      expect(query.where).toMatchObject({
        workspaceId: "w",
        adId: exactInput.ctwa_id,
      });
  });

  it("a retained canonical ad cannot be replaced by a different SourceID during materialization", async () => {
    const h = composition();
    await h.routeInput();
    h.payload.ctwa_id = "different_source";
    await expect(
      h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    ).rejects.toThrow();
    expect(h.leads).toHaveLength(0);
    expect(h.logs).toHaveLength(0);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  // Owner rule: CTWA CAPI needs only pixel + page_id + ctwa_clid. An ad the
  // workspace does not know falls back to the unique page/pixel destination
  // and is kept only as an attribution hint (never account/campaign/ad set).
  it.each(["foreign", "unknown"])(
    "supplied %s (unknown) origin routes by the unique page/pixel pair keeping the ad only as hint",
    async (kind) => {
      const h = composition();
      if (kind === "foreign") h.ad.workspaceId = "foreign_workspace";
      if (kind === "unknown") h.ad.adId = "other_source";
      const { route } = await h.routeInput();
      expect(route).toMatchObject({
        classification: "eligible_route_resolved",
        reason: "authorized_ctwa_destination_ad_hint",
        preview: {
          reportingAccountId: null,
          conversionDestinationId: "dest",
        },
      });
      expect(h.event.adId).toBe(exactInput.ctwa_id);
      await h.production.processItem({
        workspaceId: "w",
        productionItemId: "item",
      });
      expect(h.leads[0]).toMatchObject({ ctwaClid: exactInput.ctwa_clid });
      expect(h.leads[0].adId ?? null).toBeNull();
      expect(h.leads[0].campaignId ?? null).toBeNull();
      expect(h.logs[0]).toMatchObject({
        adId: exactInput.ctwa_id,
        campaignId: null,
        adSetId: null,
        metaAccountId: null,
        attributionStatus: "ctwa_ad_hint",
        metaConversionDestinationId: "dest",
      });
      expect(await h.processor.process(h.jobs[0])).toMatchObject({
        status: "sent",
      });
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0].url).toContain("/synthetic_pixel/events");
      expect(h.calls[0].body.data[0]).toMatchObject({
        action_source: "business_messaging",
        messaging_channel: "whatsapp",
        user_data: {
          page_id: "synthetic_page",
          ctwa_clid: exactInput.ctwa_clid,
        },
        custom_data: { ad_id: exactInput.ctwa_id },
      });
      expect(h.calls[0].body.data[0].user_data).not.toHaveProperty(
        "whatsapp_business_account_id",
      );
    },
  );

  // The ad becomes known between the ad-hint classification and the item's
  // materialization: the SAME item re-evaluates in place and takes the
  // canonical path (same Meta event ID), instead of failing forever.
  function staleHint() {
    const h = composition();
    h.ad.adId = "other_source";
    return h;
  }
  async function classifyAsHintThenLearnAd(h: ReturnType<typeof staleHint>) {
    expect((await h.routeInput()).route).toMatchObject({
      reason: "authorized_ctwa_destination_ad_hint",
    });
    h.ad.adId = exactInput.ctwa_id;
    h.prisma.inboundWebhookEvent.updateMany = vi.fn(
      async ({ where, data }: any) => {
        if (where.classificationReason !== h.event.classificationReason)
          return { count: 0 };
        Object.assign(h.event, data, {
          resolvedBusinessConnection:
            h.businesses.find(
              (b: any) => b.id === data.resolvedBusinessConnectionId,
            ) ?? null,
          resolvedReportingAccount:
            data.resolvedReportingAccountId === h.account.id ? h.account : null,
          resolvedConversionDestination:
            data.resolvedConversionDestinationId === h.destination.id
              ? h.destination
              : null,
        });
        return { count: 1 };
      },
    );
  }

  it("a stale ad hint is re-evaluated in the same attempt and sent once through the canonical route with the same event ID", async () => {
    const hint = staleHint();
    await hint.routeInput();
    await hint.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    const hintEventId = hint.logs[0].eventId;

    const h = staleHint();
    await classifyAsHintThenLearnAd(h);
    await expect(
      h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    ).resolves.toEqual({ status: "materialized" });
    expect(h.event).toMatchObject({
      classification: "eligible_route_resolved",
      classificationReason: "route_resolved",
      resolvedReportingAccountId: h.account.id,
      resolvedConversionDestinationId: "canonical_dest",
    });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      eventId: hintEventId,
      adId: exactInput.ctwa_id,
      campaignId: "canonical_campaign",
      metaAccountId: "canonical_account",
      attributionStatus: "attributed",
    });
    expect(await h.processor.process(h.jobs[0])).toMatchObject({
      status: "sent",
    });
    // Retry of the same item never sends again.
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    await h.processor.process(h.jobs[0]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toContain("/canonical_pixel/events");
    expect(h.calls[0].body.data[0].event_id).toBe(hintEventId);
  });

  it("a stale ad hint whose known ad is misconfigured takes the canonical reason, not the page/pixel pair", async () => {
    const h = staleHint();
    await classifyAsHintThenLearnAd(h);
    h.account.active = false;
    await expect(
      h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    ).rejects.toThrow();
    expect(h.event).toMatchObject({
      classification: "eligible_route_unresolved",
      classificationReason: "reporting_account_inactive",
    });
    expect(h.logs).toHaveLength(0);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("an unknown origin with two authorized page/pixel pairs stays unresolved as ambiguous", async () => {
    const h = composition();
    h.ad.adId = "other_source";
    h.accounts[0].allowedDestinations = ["dest", "dest2"].map(
      (conversionDestinationId) => ({
        active: true,
        conversionDestinationId,
        workspaceId: "w",
        reportingAccountId: h.accounts[0].id,
      }),
    ) as any;
    // composition() exposes the canonical destination as h.destination.
    const synthetic = {
      ...h.destination,
      id: "dest",
      pixelId: "synthetic_pixel",
      pageId: "synthetic_page",
    };
    h.prisma.metaConversionDestination.findMany.mockResolvedValue([
      synthetic,
      { ...synthetic, id: "dest2", pixelId: "p2", pageId: "page2" },
    ]);
    const { route } = await h.routeInput();
    expect(route).toMatchObject({
      classification: "eligible_route_unresolved",
      reason: "ctwa_destination_ambiguous",
    });
    await expect(
      h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    ).rejects.toThrow();
    expect(h.logs).toHaveLength(0);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  // "assignment" and "disabled_destination" are left out: in this edition the
  // route reader ignores another account's assignment and its query filters
  // inactive allowlist rows (pre-existing reader semantics, not Fase 4b).
  it.each([
    "account",
    "unattributed",
    "inactive_account",
  ])(
    "supplied known %s origin remains unresolved with no page/pixel fallback or effects",
    async (kind) => {
      const h = composition();
      // Known ad with inconsistent data: account not configured / missing.
      if (kind === "account") h.ad.adAccountId = "other_account";
      if (kind === "unattributed") h.ad.adAccountId = null;
      if (kind === "assignment")
        h.ad.destinationAssignment.reportingAccountId = "other_account";
      if (kind === "disabled_destination")
        h.account.allowedDestinations[0].active = false;
      if (kind === "inactive_account") h.account.active = false;
      const { route } = await h.routeInput();
      const reasons: Record<string, string> = {
        account: "reporting_account_not_found",
        unattributed: "ad_account_not_attributed",
        assignment: "ad_destination_mismatch",
        disabled_destination: "conversion_destination_not_authorized",
        inactive_account: "reporting_account_inactive",
      };
      expect(route).toMatchObject({
        classification: "eligible_route_unresolved",
        reason: reasons[kind],
      });
      await expect(
        h.production.processItem({
          workspaceId: "w",
          productionItemId: "item",
        }),
      ).rejects.toThrow();
      expect(h.leads).toHaveLength(0);
      expect(h.logs).toHaveLength(0);
      expect(h.fetcher).not.toHaveBeenCalled();
    },
  );

  it("no-source history stays unknown and enrichment reuses its sent receipt without backfill", async () => {
    const h = composition();
    delete h.payload.ctwa_id;
    // Keep the original unique page target for the first historical event.
    h.accounts[2].allowedDestinations = [];
    const { parsed } = await h.routeInput();
    const originalTime = h.event.occurredAt;
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    await h.processor.process(h.jobs[0]);
    const receipt = { ...h.logs[0] };
    expect(receipt).toMatchObject({
      adId: null,
      campaignId: null,
      metaAccountId: null,
      attributionStatus: "ctwa_ad_unknown",
      eventOccurredAt: originalTime,
    });
    expect(h.calls[0].body.data[0].custom_data).not.toHaveProperty("ad_id");
    h.payload.ctwa_id = exactInput.ctwa_id;
    expect(parser.parse(h.payload, context).events[0].dedupeKey).toBe(
      parsed.dedupeKey,
    );
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    await h.processor.process(h.jobs[0]);
    expect(h.logs).toEqual([receipt]);
    expect(h.leads).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    expect(h.prisma.metaAd.findFirst).not.toHaveBeenCalled();
  });

  it("observation skips an enriched delivery for the existing event instead of replacing original time/origin", async () => {
    const rows: any[] = [];
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
      inboundWebhookEvent: {
        createMany: vi.fn(async ({ data, skipDuplicates }: any) => {
          expect(skipDuplicates).toBe(true);
          let count = 0;
          for (const row of data)
            if (
              !rows.some(
                (r) =>
                  r.connectionId === row.connectionId &&
                  r.dedupeKey === row.dedupeKey,
              )
            ) {
              rows.push(row);
              count++;
            }
          return { count };
        }),
      },
    };
    const subject = Object.assign(
      Object.create(InboundWebhookObservationService.prototype),
      { prisma: { $transaction: async (fn: any) => fn(tx) } },
    );
    const delivery = {
      id: "old_delivery",
      workspaceId: "w",
      connectionId: "c",
      provider: "unnichat",
      parserVersion: "v1",
      connection: {
        parserReleaseId: "release",
        parserRelease: { id: "release", status: "certified" },
      },
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
    const old = parser.parse(oldInput(), context);
    expect(
      await subject.persistResult(delivery, old, new Date()),
    ).toMatchObject({ createdEventCount: 1 });
    const originalRow = { ...rows[0] };
    vi.setSystemTime(new Date("2026-10-12T13:00:00Z"));
    expect(
      await subject.persistResult(
        { ...delivery, id: "enriched_delivery" },
        parser.parse(exactInput, context),
        new Date(),
      ),
    ).toMatchObject({ createdEventCount: 0 });
    expect(rows).toEqual([originalRow]);
    expect(rows[0]).toMatchObject({
      adId: null,
      deliveryId: "old_delivery",
      occurredAt: new Date("2026-10-12T12:00:00Z"),
    });
  });
});
