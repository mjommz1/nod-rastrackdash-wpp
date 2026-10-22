import { buildInboundWebhookEventDedupeKey } from "../../src/inbound-webhooks/providers/inbound-webhook-parser";
import { describe, expect, it, vi } from "vitest";
import {
  effectiveUnnichatMetaRouting,
  canonicalRouteAuthorized,
} from "../../src/inbound-webhooks/inbound-webhook-effective-meta-routing";
import { InboundWebhookMetaRouteReaderService } from "../../src/inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";

function harness() {
  const accounts = Array.from({ length: 8 }, (_, i) => ({
    id: `account_${i}`,
    workspaceId: "w",
    adAccountId: `act_${i}`,
    businessConnectionId: `bm_${Math.floor(i / 2)}`,
    active: true,
    conversionDestinationId: "dest",
    allowedDestinations: [{ conversionDestinationId: "dest" }],
  }));
  const businesses = Array.from({ length: 4 }, (_, i) => ({
    id: `bm_${i}`,
    workspaceId: "w",
    status: "active",
    defaultConversionDestinationId: "dest",
    credential: { workspaceId: "w", status: "active" },
  }));
  const state = {
    enabled: true,
    destination: "configured",
    audit: [] as any[],
  };
  const prisma: any = {
    metaIntegration: {
      findUnique: vi.fn(async () => ({
        advancedRoutingEnabled: state.enabled,
      })),
    },
    metaBusinessConnection: {
      count: vi.fn(async () => 4),
      findFirst: vi.fn(
        async ({ where }: any) =>
          businesses.find(
            (b) => b.id === where.id && b.workspaceId === where.workspaceId,
          ) ?? null,
      ),
    },
    metaReportingAccount: {
      findMany: vi.fn(async ({ where }: any) =>
        accounts.filter((a) => a.workspaceId === where.workspaceId && a.active),
      ),
      findFirst: vi.fn(
        async ({ where }: any) =>
          accounts.find(
            (a) =>
              a.workspaceId === where.workspaceId &&
              a.adAccountId === where.adAccountId &&
              (!where.id || a.id === where.id),
          ) ?? null,
      ),
    },
    metaAd: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.workspaceId === "w" && /^ad_[0-7]$/.test(where.adId)
          ? {
              adAccountId: `act_${where.adId.slice(3)}`,
              destinationAssignment: null,
            }
          : null,
      ),
    },
    metaConversionDestination: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.workspaceId === "w" &&
        where.id === "dest" &&
        state.destination === "configured"
          ? { id: "dest", pixelId: "shared_pixel", pageId: "shared_page" }
          : null,
      ),
    },
    auditLog: { findMany: vi.fn(async () => state.audit) },
    inboundWebhookChannelRoute: {
      upsert: vi.fn(),
      findMany: vi.fn(async ({ where }: any) =>
        where.workspaceId === channel.workspaceId &&
        where.channelId === channel.id
          ? channel.routes.filter((route: any) => route.active !== false)
          : [],
      ),
    },
  };
  const reader = new InboundWebhookMetaRouteReaderService(prisma);
  const service = new InboundWebhookChannelRoutesService(prisma, reader);
  const channel: any = {
    id: "ch_1020",
    workspaceId: "w",
    status: "active",
    metaRoutingMode: null,
    routes: [],
    connectionId: "conn",
    organizationId: "w",
    providerChannelId: "bound",
    connection: {
      id: "conn",
      workspaceId: "w",
      provider: "unnichat",
      status: "observation",
    },
  };
  return { prisma, reader, service, channel, accounts, businesses, state };
}

describe("Unnichat global BM pool inheritance", () => {
  it("two channels, four BMs, eight accounts, zero local routes resolve exactly their own ad triple without copying routes", async () => {
    const h = harness();
    for (const id of ["ch_1020", "ch_5520"]) {
      for (let i = 0; i < 8; i++) {
        const decision = await (h.service as any).evaluateEventRoute(
          { ...h.channel, id },
          `ad_${i}`,
        );
        expect(decision.classification).toBe("eligible_route_resolved");
        expect(decision.preview).toMatchObject({
          businessConnectionId: `bm_${Math.floor(i / 2)}`,
          reportingAccountId: `account_${i}`,
          conversionDestinationId: "dest",
        });
      }
      expect(
        await (h.service as any).learnRoutesFromEvents({ ...h.channel, id }, [
          "ad_0",
        ]),
      ).toBe(false);
    }
    expect(h.prisma.inboundWebhookChannelRoute.upsert).not.toHaveBeenCalled();
  });
  it("flag OFF blocks inherit, and missing ad ID never calls the reader", async () => {
    const h = harness();
    h.state.enabled = false;
    expect(
      await (h.service as any).evaluateEventRoute(h.channel, "ad_0"),
    ).toMatchObject({ classification: "eligible_route_unresolved" });
    h.prisma.metaAd.findFirst.mockClear();
    expect(
      await (h.service as any).evaluateEventRoute(h.channel, null),
    ).toMatchObject({ reason: "ctwa_workspace_routing_disabled" });
    expect(h.prisma.metaAd.findFirst).not.toHaveBeenCalled();
  });
  it.each(["business", "credential", "account", "destination", "flag"])(
    "revalidates %s revocation before a canonical effect",
    async (kind) => {
      const h = harness();
      const preview = await h.reader.previewRoute({
        workspaceId: "w",
        adId: "ad_0",
      });
      const event: any = {
        workspaceId: "w",
        adId: "ad_0",
        channel: h.channel,
        resolvedBusinessConnectionId: preview.businessConnectionId,
        resolvedReportingAccountId: preview.reportingAccountId,
        resolvedConversionDestinationId: preview.conversionDestinationId,
      };
      expect(await canonicalRouteAuthorized(h.prisma, event)).toBe(true);
      if (kind === "business") h.businesses[0].status = "paused";
      if (kind === "credential") h.businesses[0].credential.status = "paused";
      if (kind === "account") h.accounts[0].active = false;
      if (kind === "destination") h.state.destination = "revoked";
      if (kind === "flag") h.state.enabled = false;
      expect(await canonicalRouteAuthorized(h.prisma, event)).toBe(false);
    },
  );
  it("explicit override restricts learning and ad ownership even with identical destinations", async () => {
    const h = harness();
    h.channel.metaRoutingMode = "channel_override";
    h.channel.routes = [
      {
        metaBusinessConnectionId: "bm_0",
        metaReportingAccountId: "account_0",
        metaConversionDestinationId: "dest",
        active: true,
        validationStatus: "valid",
      },
    ];
    expect(
      await (h.service as any).evaluateEventRoute(h.channel, "ad_2"),
    ).toMatchObject({ classification: "eligible_route_unresolved" });
    expect(
      await (h.service as any).learnRoutesFromEvents(h.channel, ["ad_2"]),
    ).toBe(false);
  });
  it("unknown legacy local routes remain conservative; learned-only audit is derived cache", async () => {
    const h = harness();
    h.channel.routes = [
      { id: "route", active: true, validationStatus: "valid" },
    ];
    expect(
      await effectiveUnnichatMetaRouting(h.prisma, h.channel),
    ).toMatchObject({ source: "legacy_unknown" });
    h.state.audit = [
      {
        action: "inbound_webhook.channel_routes_learned",
        actorType: "system",
        beforeSummary: { routes: [] },
        afterSummary: { routes: [{ routeId: "route" }] },
      },
    ];
    expect(
      await effectiveUnnichatMetaRouting(h.prisma, h.channel),
    ).toMatchObject({ source: "inherit_workspace", eligible: true });
  });
  it("foreign workspace, empty pool, ambiguous destination and unauthorized assignment fail closed", async () => {
    const h = harness();
    expect(
      (await h.reader.previewRoute({ workspaceId: "foreign", adId: "ad_0" }))
        .status,
    ).toBe("unresolved");
    h.accounts.forEach((a) => (a.active = false));
    expect(
      await effectiveUnnichatMetaRouting(h.prisma, h.channel),
    ).toMatchObject({ eligible: false });
    h.accounts[0].active = true;
    h.accounts[0].allowedDestinations.push({
      conversionDestinationId: "other",
    });
    expect(
      (await h.reader.previewRoute({ workspaceId: "w", adId: "ad_0" })).reason,
    ).toBe("ad_destination_unresolved");
  });
});

import { InboundWebhookProductionService } from "../../src/inbound-webhook-production/inbound-webhook-production.service";
import {
  applyInboundWebhookChannelStatus,
  applyInboundWebhookConnectionStatus,
} from "../../src/inbound-webhooks/inbound-webhook-production-activation";

function effectHarness(kind: "production" | "replay") {
  const h = harness();
  const time = new Date(Date.now() - 2000);
  const parsed = {
    provider: "unnichat",
    adId: "ad_0",
    ctwaClid: "synthetic_click",
    externalMessageId: "msg",
    dedupeKey: buildInboundWebhookEventDedupeKey({
      provider: "unnichat",
      organizationId: "w",
      providerChannelId: "bound",
      externalMessageId: "msg",
    }),
    organizationId: "w",
    channel: { providerChannelId: "bound" },
    contact: { phoneNumber: "5511999990000", name: null },
    ad: null,
  };
  const item: any = {
    id: "item",
    workspaceId: "w",
    status: "queued",
    event: {
      id: "event",
      workspaceId: "w",
      provider: "unnichat",
      channelId: h.channel.id,
      dedupeKey: parsed.dedupeKey,
      connectionId: "conn",
      normalizedSummary: {
        providerChannelId: "bound",
        organizationId: "w",
        externalMessageId: "msg",
      },
      externalMessageId: "msg",
      classification: "eligible_route_resolved",
      hasCtwa: true,
      adId: "ad_0",
      occurredAt: time,
      channel: { ...h.channel, productionActivatedAt: time },
      connection: {
        id: "conn",
        workspaceId: "w",
        provider: "unnichat",
        status: kind === "production" ? "production" : "observation",
        removedAt: null,
        productionActivatedAt: time,
        parserRelease: {
          status: "certified",
          version: "synthetic-ad-v1",
          provider: "unnichat",
        },
      },
      delivery: {
        id: "delivery",
        workspaceId: "w",
        connectionId: "conn",
        provider: "unnichat",
        parserVersion: "synthetic-ad-v1",
        firstReceivedAt: new Date(),
        payloadExpiresAt: new Date(Date.now() + 86400000),
        encryptedPayload: "fixture",
        payloadIv: "fixture",
        payloadTag: "fixture",
        encryptionKeyVersion: 1,
      },
      resolvedBusinessConnectionId: "bm_0",
      resolvedReportingAccountId: "account_0",
      resolvedConversionDestinationId: "dest",
      resolvedBusinessConnection: h.businesses[0],
      resolvedReportingAccount: h.accounts[0],
      // This edition also re-checks the destination workspace.
      resolvedConversionDestination: {
        id: "dest",
        workspaceId: "w",
        status: "configured",
      },
    },
  };
  const steps: string[] = [];
  let transactionNumber = 0;
  let revokeAt = 0;
  const tx: any = {
    ...h.prisma,
    $queryRaw: vi.fn(async () => {
      steps.push("lock");
      return [];
    }),
  };
  const itemDelegate = {
    findFirst: vi.fn(async () => item),
    update: vi.fn(async ({ data }: any) => {
      Object.assign(item, data);
      return item;
    }),
  };
  tx.inboundWebhookProductionItem = itemDelegate;
  tx.inboundWebhookReplayItem = itemDelegate;
  h.prisma.inboundWebhookProductionItem = itemDelegate;
  h.prisma.inboundWebhookReplayItem = itemDelegate;
  h.prisma.$transaction = vi.fn(async (fn: any) => {
    transactionNumber++;
    if (revokeAt === transactionNumber) h.state.enabled = false;
    steps.push("transaction");
    const result = await fn(tx);
    steps.push("commit");
    return result;
  });
  const leads = {
    upsertFromWhatsappWebhook: vi.fn(async (_input: any, client: any) => {
      expect(client).toBe(tx);
      expect(steps).toContain("lock");
      steps.push("lead");
      return { id: "lead" };
    }),
  };
  const conversions = {
    recordExternalConversion: vi.fn(async (_input: any, client: any) => {
      expect(client).toBe(tx);
      steps.push("conversion");
      return {
        status: "created",
        conversionEventLogId: "conversion",
        deliveryStatus: "ready_to_send",
      };
    }),
  };
  const queue = {
    enqueueSend: vi.fn(async () => {
      expect(steps.indexOf("commit")).toBeLessThan(steps.lastIndexOf("lock"));
      steps.push("queue");
      return {};
    }),
  };
  const encryption = { decrypt: vi.fn(() => Buffer.from("{}")) };
  // Synthetic canonical-ad regression only, with explicit original-bind context.
  // Real Unnichat no-ad acceptance lives in the first-entry offline suites.
  const registry = {
    resolve: vi.fn(() => ({
      parse: (_payload: unknown, context: any) =>
        context?.organizationId === "w" && context?.connectedPhone === "bound"
          ? { events: [parsed] }
          : { events: [], error: { code: "context_mismatch" } },
    })),
  };
  const billing = { assertProductionAccess: vi.fn(async () => undefined) };
  const env = {
    NODE_ENV: "test",
    API_PUBLIC_URL: "http://localhost:3333",
    INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
    INBOUND_WEBHOOKS_ENABLED: "true",
    INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  };
  // Adapted: this edition has no billing module and no Unnichat replay (the
  // student recovery flow stays Meta Cloud only), so only production runs.
  void kind;
  const service: any = new InboundWebhookProductionService(
    h.prisma,
    encryption as never,
    registry as never,
    leads as never,
    conversions as never,
    queue as never,
    env,
  );
  return {
    ...h,
    item,
    parsed,
    steps,
    tx,
    service,
    leads,
    conversions,
    queue,
    billing,
    setRevoke: (n: number) => {
      revokeAt = n;
    },
  };
}

describe.each(["production"] as const)(
  "Unnichat %s current policy",
  (kind) => {
    it("one occurrence has one canonical effect and queue handoff, using transaction clients and zero routes", async () => {
      const h = effectHarness(kind);
      expect(await h.service.materialize(h.item)).toMatchObject({
        duplicate: false,
      });
      expect(await h.service.materialize(h.item)).toMatchObject({
        duplicate: true,
      });
      expect(h.leads.upsertFromWhatsappWebhook).toHaveBeenCalledOnce();
      expect(h.conversions.recordExternalConversion).toHaveBeenCalledOnce();
      expect(h.queue.enqueueSend).toHaveBeenCalledOnce();
      expect(h.item.status).toBe("materialized");
    });
    it("revocation between decision and materialization blocks every effect", async () => {
      const h = effectHarness(kind);
      h.setRevoke(1);
      await expect(h.service.materialize(h.item)).rejects.toThrow();
      expect(h.leads.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
      expect(h.conversions.recordExternalConversion).not.toHaveBeenCalled();
      expect(h.queue.enqueueSend).not.toHaveBeenCalled();
    });
    it("revocation after committed effect suppresses handoff and keeps the materialized receipt truthful", async () => {
      const h = effectHarness(kind);
      h.setRevoke(2);
      await h.service.materialize(h.item);
      expect(h.item.status).toBe("materialized");
      expect(h.item.errorCode).toContain("handoff_route_revoked");
      expect(h.queue.enqueueSend).not.toHaveBeenCalled();
    });
    it.each(["missing_ad", "uncertified", "expired", "paused"])(
      "keeps the %s guard",
      async (guard) => {
        const h = effectHarness(kind);
        if (guard === "missing_ad") h.item.event.adId = null;
        if (guard === "uncertified")
          h.item.event.connection.parserRelease.status = "observation_only";
        if (guard === "expired")
          h.item.event.delivery.payloadExpiresAt = new Date(0);
        if (guard === "paused") h.item.event.channel.status = "paused";
        await expect(h.service.materialize(h.item)).rejects.toThrow();
        expect(h.leads.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
        expect(h.queue.enqueueSend).not.toHaveBeenCalled();
      },
    );
  },
);

it("production preserves post-activation timestamp guards", async () => {
  const h = effectHarness("production");
  h.item.event.delivery.firstReceivedAt = new Date(0);
  await expect(h.service.materialize(h.item)).rejects.toThrow();
  expect(h.leads.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
});

it("readiness reports virtual inheritance separately from 0/0 persisted routes and missing ad remains a blocker", async () => {
  const h = harness();
  const policy = await effectiveUnnichatMetaRouting(h.prisma, h.channel);
  const event: any = {
    classification: "eligible_route_unresolved",
    classificationReason: "route_ad_missing",
    replayItem: null,
    productionItem: null,
    deliveryId: "delivery",
    delivery: { payloadExpiresAt: new Date(Date.now() + 86400000 * 3) },
  };
  expect(
    (h.service as any).channelReadiness(
      h.channel,
      [event],
      new Date(),
      new Set(["delivery"]),
      0,
      policy,
    ),
  ).toMatchObject({
    routeCount: 0,
    validRouteCount: 0,
    routingSource: "inherit_workspace",
    effectiveRouteEligible: true,
    blockers: expect.arrayContaining([
      "ctwa_ad_unavailable",
      "ctwa_unresolved",
    ]),
  });
});

it("a historical manual removal with no replacement audit never silently inherits", async () => {
  const h = harness();
  h.state.audit = [
    {
      actorType: "user",
      action: "inbound_webhook.channel_route_removed",
      beforeSummary: { channelId: h.channel.id, routeId: "old" },
      afterSummary: { channelId: h.channel.id, routeId: "old", active: false },
    },
  ];
  expect(await effectiveUnnichatMetaRouting(h.prisma, h.channel)).toMatchObject(
    { source: "legacy_unknown", eligible: false },
  );
});


it("activates zero-route Unnichat channels using the current pool and still blocks uncertified connection promotion", async () => {
  const h = harness();
  const connection: any = {
    id: "conn",
    workspaceId: "w",
    provider: "unnichat",
    status: "observation",
    removedAt: null,
    updatedAt: new Date(),
    parserRelease: { status: "observation_only" },
  };
  Object.assign(h.channel, {
    connectionId: "conn",
    connectedPhone: "5511999990000",
    updatedAt: new Date(),
    connection: { ...connection },
  });
  h.prisma.inboundWebhookChannel = {
    findFirst: vi.fn(async () => h.channel),
    findMany: vi.fn(async () => [h.channel]),
    updateMany: vi.fn(async ({ data }: any) => {
      Object.assign(h.channel, data);
      return { count: 1 };
    }),
  };
  h.prisma.inboundWebhookConnection = {
    findFirst: vi.fn(async () => connection),
  };
  h.prisma.auditLog.create = vi.fn(async () => ({}));
  const seats = { enforcementEnabled: () => false, activateSeat: vi.fn() };
  await expect(
    applyInboundWebhookChannelStatus(h.prisma, {
      workspaceId: "w",
      channelId: h.channel.id,
      status: "active",
      actorUserId: "owner",
      requireValidMetaRoute: true,
      seats,
    }),
  ).resolves.toMatchObject({ status: "active", routes: [] });
  h.state.enabled = false;
  await expect(
    applyInboundWebhookChannelStatus(h.prisma, {
      workspaceId: "w",
      channelId: h.channel.id,
      status: "active",
      actorUserId: "owner",
      requireValidMetaRoute: true,
      seats,
    }),
  ).rejects.toThrow();
  await expect(
    applyInboundWebhookConnectionStatus(h.prisma, {
      workspaceId: "w",
      connectionId: "conn",
      status: "production",
      actorUserId: "owner",
      requireValidMetaRoute: true,
      seats,
    }),
  ).rejects.toThrow("Certifique o parser");
});

it("preserves manual normalized routing when no legacy OAuth integration exists", async () => {
  const h = harness();
  h.prisma.metaIntegration.findUnique.mockResolvedValue(null);
  expect(await effectiveUnnichatMetaRouting(h.prisma, h.channel)).toMatchObject(
    { source: "inherit_workspace", eligible: true },
  );
});

it("rejects a foreign channel policy and wrong-account ad assignment", async () => {
  const h = harness();
  expect(
    await canonicalRouteAuthorized(h.prisma, {
      workspaceId: "w",
      adId: "ad_0",
      channel: { ...h.channel, workspaceId: "foreign" },
      resolvedBusinessConnectionId: "bm_0",
      resolvedReportingAccountId: "account_0",
      resolvedConversionDestinationId: "dest",
    }),
  ).toBe(false);
});

it("legacy manual audit restricts a subsequently learned account while learned-only cache inherits", async () => {
  const h = harness();
  const manual: any = {
    id: "manual",
    active: true,
    validationStatus: "valid",
    metaBusinessConnectionId: "bm_0",
    metaReportingAccountId: "account_0",
    metaConversionDestinationId: "dest",
  };
  const learned = {
    ...manual,
    id: "learned",
    metaBusinessConnectionId: "bm_1",
    metaReportingAccountId: "account_2",
  };
  h.channel.routes = [manual, learned];
  h.state.audit = [
    {
      actorType: "user",
      action: "inbound_webhook.channel_routes_replaced",
      afterSummary: { routes: [{ ...manual, routeId: "manual" }] },
    },
    {
      actorType: "system",
      action: "inbound_webhook.channel_routes_learned",
      beforeSummary: { routes: [manual] },
      afterSummary: { routes: [manual, learned] },
    },
  ];
  expect(await effectiveUnnichatMetaRouting(h.prisma, h.channel)).toMatchObject(
    { source: "channel_override", routes: [manual] },
  );
  expect(
    await (h.service as any).evaluateEventRoute(h.channel, "ad_2"),
  ).toMatchObject({ classification: "eligible_route_unresolved" });
  expect(h.prisma.auditLog.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        workspaceId: "w",
        OR: expect.arrayContaining([
          expect.objectContaining({
            targetType: "InboundWebhookChannelRoute",
            beforeSummary: { path: ["channelId"], equals: h.channel.id },
          }),
        ]),
      }),
    }),
  );
});


it("disabled production never inspects or materializes an event", async () => {
  const h = effectHarness("production");
  h.service.env.INBOUND_WEBHOOK_PRODUCTION_ENABLED = "false";
  await expect(
    h.service.processItem({ productionItemId: "item", workspaceId: "w" }),
  ).rejects.toMatchObject({ code: "inbound_webhook_production_disabled" });
  expect(
    h.prisma.inboundWebhookProductionItem.findFirst,
  ).not.toHaveBeenCalled();
  expect(h.leads.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
});

it.each(["connection", "channel"] as const)(
  "suppresses handoff if %s reactivation makes the committed occurrence historical",
  async (scope) => {
    const h = effectHarness("production");
    const transaction = h.prisma.$transaction.getMockImplementation();
    let n = 0;
    h.prisma.$transaction.mockImplementation(async (fn: any) => {
      if (++n === 2)
        h.item.event[scope].productionActivatedAt = new Date(Date.now() + 1000);
      return transaction(fn);
    });
    await h.service.materialize(h.item);
    expect(h.item.status).toBe("materialized");
    expect(h.queue.enqueueSend).not.toHaveBeenCalled();
    expect(h.item.errorCode).toContain("handoff_route_revoked");
  },
);

it("an invalid active override scope cannot resolve an ad even if another scope is valid", async () => {
  const h = harness();
  h.channel.metaRoutingMode = "channel_override";
  h.channel.routes = [
    {
      id: "valid",
      active: true,
      validationStatus: "valid",
      metaBusinessConnectionId: "bm_0",
      metaReportingAccountId: "account_0",
      metaConversionDestinationId: "dest",
    },
    {
      id: "invalid",
      active: true,
      validationStatus: "invalid",
      metaBusinessConnectionId: "bm_1",
      metaReportingAccountId: "account_2",
      metaConversionDestinationId: "dest",
    },
  ];
  expect(
    await (h.service as any).evaluateEventRoute(h.channel, "ad_2"),
  ).toMatchObject({ classification: "eligible_route_unresolved" });
});
