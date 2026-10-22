import { describe, it, expect, vi } from "vitest";
import { offline } from "./helpers/first-entry-offline";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";
import { InboundWebhookMetaRouteReaderService } from "../../src/inbound-webhooks/inbound-webhook-meta-route-reader.service";
describe("real Unnichat offline production through canonical outbox and processor", () => {
  it("materializes one no-ad first lead and sends one authorized dataset event across retries", async () => {
    const h = offline();
    const route = await (
      new InboundWebhookChannelRoutesService(
        h.prisma,
        new InboundWebhookMetaRouteReaderService(h.prisma),
      ) as any
    ).evaluateEventRoute(h.channel, null);
    expect(route.reason).toBe("authorized_ctwa_destination");
    expect(
      await h.production.processItem({
        workspaceId: "w",
        productionItemId: "item",
      }),
    ).toEqual({ status: "materialized" });
    expect(h.leads[0]).toMatchObject({
      adId: null,
      campaignId: null,
      adSetId: null,
      ctwaClid: h.payload.ctwa_clid,
    });
    expect(h.logs[0]).toMatchObject({
      eventName: "LeadSubmitted",
      status: "ready_to_send",
      adId: null,
      metaAccountId: null,
      attributionStatus: "ctwa_ad_unknown",
      eventOccurredAt: h.event.occurredAt,
    });
    expect(h.calls).toHaveLength(0);
    expect(h.jobs).toHaveLength(1);
    expect(await h.processor.process(h.jobs[0])).toMatchObject({
      status: "sent",
    });
    await h.processor.process(h.jobs[0]);
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    expect(h.calls).toHaveLength(1);
    expect(h.logs).toHaveLength(1);
    expect(h.calls[0].body.data[0].custom_data).not.toHaveProperty("ad_id");
    expect(h.prisma.metaAd.findFirst).not.toHaveBeenCalled();
  });
  it.each([
    "uncertified",
    "inactive",
    // "billing" (SaaS seat contract) does not exist in this edition.
    "expired_payload",
    "bind",
    "noctwa",
    "revoked",
  ])("blocks %s before any canonical effect", async (kind) => {
    const h = offline();
    if (kind === "uncertified")
      h.channel.connection.parserRelease.status = "draft";
    if (kind === "inactive") h.channel.status = "paused";
    if (kind === "expired_payload")
      h.event.delivery.payloadExpiresAt = new Date(0);
    if (kind === "bind") h.channel.providerChannelId = "changed";
    if (kind === "noctwa") h.event.hasCtwa = false;
    if (kind === "revoked") h.credential.status = "revoked";
    await expect(
      h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    ).rejects.toThrow();
    expect(h.leads).toHaveLength(0);
    expect(h.logs).toHaveLength(0);
    expect(h.jobs).toHaveLength(0);
  });
  it("blocks destination revoked after canonical receipt while preserving materialized truth", async () => {
    const h = offline();
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    h.credential.status = "revoked";
    expect(await h.processor.process(h.jobs[0])).toMatchObject({
      status: "skipped",
    });
    expect(h.calls).toHaveLength(0);
    expect(h.item.status).toBe("materialized");
  });
  it("does not automatically resend after response loss", async () => {
    const h = offline();
    h.fetcher.mockRejectedValue(new Error("synthetic ACK loss"));
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    expect(await h.processor.process(h.jobs[0])).toMatchObject({
      errorCode: "MetaCapiDeliveryUnknown",
    });
    expect(h.logs[0].status).toBe("delivery_unknown");
    await h.processor.process(h.jobs[0]);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves existing non-null ad hierarchy on lead upsert", async () => {
    const h = offline();
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    Object.assign(h.leads[0], {
      adId: "legitimate_existing_ad",
      campaignId: "existing_campaign",
      adSetId: "existing_adset",
    });
    h.item.status = "queued";
    h.logs.length = 0;
    await h.production.processItem({
      workspaceId: "w",
      productionItemId: "item",
    });
    expect(h.leads[0].adId).toBe("legitimate_existing_ad");
    expect(h.logs[0].adId).toBeNull();
  });
});
it("keeps original event time and local lead while historical Meta dispatch is ineligible", async () => {
  const h = offline();
  h.event.occurredAt = new Date(Date.now() - 8 * 86400000);
  await h.production.processItem({
    workspaceId: "w",
    productionItemId: "item",
  });
  expect(h.leads).toHaveLength(1);
  expect(h.logs[0]).toMatchObject({
    status: "not_eligible",
    errorCode: "MetaEventTimeExpired",
    eventOccurredAt: h.event.occurredAt,
  });
  expect(h.jobs).toHaveLength(0);
});
it("serializes duplicate production receipts and concurrent processor claims with a mock lock oracle", async () => {
  const h = offline();
  let serial = Promise.resolve();
  h.prisma.$transaction.mockImplementation((fn: any) => {
    const task = serial.then(() => fn(h.prisma));
    serial = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  });
  await Promise.all([
    h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
    h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
  ]);
  expect(h.logs).toHaveLength(1);
  expect(h.leads).toHaveLength(1);
  await Promise.all([
    h.processor.process(h.jobs[0]),
    h.processor.process(h.jobs[0]),
  ]);
  expect(h.fetcher).toHaveBeenCalledTimes(1);
});
it("rollback oracle restores lead and conversion if canonical recording fails", async () => {
  const h = offline();
  h.prisma.$transaction.mockImplementation(async (fn: any) => {
    const leads = h.leads.map((l) => ({ ...l }));
    const logs = h.logs.map((l) => ({ ...l }));
    try {
      return await fn(h.prisma);
    } catch (e) {
      h.leads.splice(0, h.leads.length, ...leads);
      h.logs.splice(0, h.logs.length, ...logs);
      throw e;
    }
  });
  h.prisma.conversionEventLog.create.mockRejectedValue(
    new Error("synthetic DB rollback"),
  );
  await expect(
    h.production.processItem({ workspaceId: "w", productionItemId: "item" }),
  ).rejects.toThrow();
  expect(h.leads).toHaveLength(0);
  expect(h.logs).toHaveLength(0);
  expect(h.jobs).toHaveLength(0);
});
it("rejects a foreign queue workspace before dispatch", async () => {
  const h = offline();
  await h.production.processItem({
    workspaceId: "w",
    productionItemId: "item",
  });
  await expect(
    h.processor.process({
      ...h.jobs[0],
      data: { ...h.jobs[0].data, workspaceId: "foreign" },
    }),
  ).rejects.toThrow();
  expect(h.calls).toHaveLength(0);
});
it("refuses delivery when production flags are off at the sender", async () => {
  const h = offline();
  await h.production.processItem({
    workspaceId: "w",
    productionItemId: "item",
  });
  (h.conversions as any).env.INBOUND_WEBHOOK_PRODUCTION_ENABLED = "false";
  expect(await h.processor.process(h.jobs[0])).toMatchObject({
    status: "skipped",
  });
  expect(h.calls).toHaveLength(0);
});
import { InboundWebhookProductionIntakeService } from "../../src/inbound-webhooks/inbound-webhook-production-intake.service";
it("actual intake accepts typed no-ad entry and retains certification and activation boundary gates", async () => {
  const h = offline();
  h.prisma.inboundWebhookProductionItem.createMany = vi.fn(async () => ({
    count: 1,
  }));
  h.prisma.inboundWebhookProductionItem.findMany = vi.fn(async () => [h.item]);
  const queue = { enqueueItem: vi.fn(async () => ({ status: "created" })) };
  const service = new InboundWebhookProductionIntakeService(
    h.prisma,
    queue as any,
    (h.production as any).env,
  );
  expect(
    await service.enqueueDelivery({
      workspaceId: "w",
      connectionId: "c",
      deliveryId: "d",
    }),
  ).toMatchObject({ eligible: 1, queued: 1 });
  expect(
    h.prisma.inboundWebhookEvent.findMany.mock.calls[0][0].where.OR,
  ).toContainEqual({
    provider: "unnichat",
    adId: null,
    classificationReason: "authorized_ctwa_destination",
  });
  h.channel.connection.parserRelease.status = "draft";
  expect(
    await service.enqueueDelivery({
      workspaceId: "w",
      connectionId: "c",
      deliveryId: "d",
    }),
  ).toMatchObject({ eligible: 0 });
});
it("readiness distinguishes verified CTWA destination from unknown analytics with zero local account routes", async () => {
  const h = offline();
  const service = new InboundWebhookChannelRoutesService(
    h.prisma,
    new InboundWebhookMetaRouteReaderService(h.prisma),
  );
  const r = await (service as any).effectiveEntryReadiness(h.channel);
  expect(r).toMatchObject({
    source: "inherit_workspace",
    eligible: true,
    ctwaDestinationReadiness: { status: "verified" },
  });
  // Page/pixel edition: a destination without page is not a CTWA destination.
  h.destination.pageId = null;
  expect(
    await (service as any).effectiveEntryReadiness(h.channel),
  ).toMatchObject({ ctwaDestinationReadiness: { status: "not_ready" } });
});
import { ReportingMetricsEngine } from "../../src/reporting/reporting-metrics.engine";
it("unknown ad analytics cannot increment an identified campaign/ad funnel", async () => {
  const h = offline();
  await h.production.processItem({
    workspaceId: "w",
    productionItemId: "item",
  });
  const e = new ReportingMetricsEngine();
  const metrics = e.calculate({
    scope: { campaignId: "legitimate_campaign" },
    leads: h.leads,
    events: h.logs,
    insight: { spendCents: 0, metaConversationsStarted: 0 },
  });
  expect(metrics.realConversations).toBe(0);
  expect(metrics.qualifiedLead).toBe(0);
  expect(metrics.purchases).toBe(0);
});
import { buildInboundWebhookEventDedupeKey } from "../../src/inbound-webhooks/providers/inbound-webhook-parser";
it("legacy and current parser identities for the same retained click share one canonical event ID", async () => {
  const h = offline();
  await h.production.processItem({
    workspaceId: "w",
    productionItemId: "item",
  });
  const firstLog = h.logs[0];
  const summary = { ...h.event.normalizedSummary };
  delete summary.ctwaEntryIdentityHash;
  const legacy = {
    ...h.item,
    id: "historical_legacy_item",
    status: "queued",
    event: {
      ...h.event,
      id: "historical_legacy_event",
      dedupeKey: buildInboundWebhookEventDedupeKey({
        provider: "unnichat",
        organizationId: "w",
        providerChannelId: h.channel.providerChannelId,
        externalMessageId: h.event.externalMessageId,
      }),
      normalizedSummary: summary,
    },
  };
  const result = await (h.production as any).materializeWithClient(
    legacy,
    h.prisma,
  );
  expect(result).toMatchObject({
    duplicate: true,
    conversionEventLogId: firstLog.id,
  });
  expect(h.logs).toHaveLength(1);
  expect(h.logs[0].eventId).toBe(firstLog.eventId);
  await h.processor.process(h.jobs[0]);
  await h.processor.process(h.jobs[0]);
  expect(h.calls).toHaveLength(1);
});
it("keeps distinct real parser click occurrences as distinct canonical events on the same lead", async () => {
  const h = offline();
  await h.production.processItem({
    workspaceId: "w",
    productionItemId: "item",
  });
  const original = { ...h.payload };
  const secondPayload = {
    ...h.payload,
    ctwa_clid: "second_synthetic_distinct_click",
  };
  const registry = (h.production as any).parserRegistry;
  const parsed = registry
    .resolve({
      provider: "unnichat",
      parserVersion: "v1",
      parserReleaseStatus: "certified",
    })
    .parse(secondPayload, {
      organizationId: "w",
      connectedPhone: h.channel.providerChannelId,
    }).events[0];
  vi.spyOn(
    (h.production as any).payloadEncryption,
    "decrypt",
  ).mockImplementation((_value: unknown, context: any) =>
    Buffer.from(
      JSON.stringify(context.deliveryId === "d2" ? secondPayload : original),
    ),
  );
  const item = {
    ...h.item,
    id: "second_item",
    status: "queued",
    event: {
      ...h.event,
      id: "second_event",
      dedupeKey: parsed.dedupeKey,
      normalizedSummary: parsed.normalizedSummary,
      delivery: { ...h.event.delivery, id: "d2" },
    },
  };
  const result = await (h.production as any).materializeWithClient(
    item,
    h.prisma,
  );
  expect(result.duplicate).toBe(false);
  expect(h.logs).toHaveLength(2);
  expect(h.logs[0].eventId).not.toBe(h.logs[1].eventId);
  expect(h.logs[0].ctwaClid).not.toBe(h.logs[1].ctwaClid);
  expect(h.leads).toHaveLength(1);
});
