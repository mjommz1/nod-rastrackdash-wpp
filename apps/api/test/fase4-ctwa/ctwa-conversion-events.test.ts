import { describe, expect, it, vi } from "vitest";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import { MetaCapiAdapter } from "../../src/conversion-events/meta-capi.adapter";
import { MetaTokenEncryptionService } from "../../src/integrations/meta/meta-token-encryption.service";
import { MetaConnectionResolverService } from "../../src/integrations/meta/meta-connection-resolver.service";
import { canRetryConversionEvent } from "../../src/conversion-events/conversion-event-retry";
import { ctwaWorld, past } from "./ctwa-fixture";

// The Unnichat provider value enters the database enum in Fase 4b. These
// tests exercise the dispatch foundation as it will run then.
vi.mock("../../src/inbound-webhooks/authorized-ctwa-destination", async (load) => ({
  ...(await load<typeof import("../../src/inbound-webhooks/authorized-ctwa-destination")>()),
  ctwaDestinationProviderValue: () => "unnichat",
}));

const env = {
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  API_PUBLIC_URL: "https://api.example.test",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  META_TOKEN_ENCRYPTION_KEY: "fixture-key",
};

/**
 * Stateful conversion store + the Meta setup of ctwaWorld. The Unnichat entry
 * that produced the lead is modelled as a stored inbound event with its
 * materialized production receipt (the SaaS proof shape).
 */
function harness(
  options: { ctwaClid?: string | null; locked?: boolean } = {},
) {
  const world = ctwaWorld();
  const encryption = new MetaTokenEncryptionService({
    META_TOKEN_ENCRYPTION_KEY: "fixture-key",
  });
  const sealed = encryption.encrypt("bm-token");
  Object.assign(world.credential, sealed);
  const logs = new Map<string, any>();
  let sequence = 0;
  const occurredAt = new Date(Date.now() - 60 * 60_000);
  const event = {
    id: "evt1",
    workspaceId: "ws1",
    channelId: "ch1",
    connectionId: "conn1",
    provider: "unnichat",
    hasCtwa: true,
    adId: null,
    classificationReason: "authorized_ctwa_destination",
    occurredAt,
    delivery: { parserVersion: "v1", firstReceivedAt: new Date() },
    connection: {
      removedAt: null,
      status: "production",
      productionActivatedAt: past,
      parserRelease: { status: "certified", version: "v1" },
    },
    channel: { status: "active", productionActivatedAt: past },
    productionItem: null as any,
    replayItem: null,
  };
  const prisma: any = {
    ...world.client,
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    conversionEventLog: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.dedupeKey
          ? [...logs.values()].find((log) => log.dedupeKey === where.dedupeKey) ?? null
          : logs.get(where.id) ?? null,
      ),
      findFirst: vi.fn(async ({ where }: any) => {
        const log = logs.get(where.id);
        return log && (!where.status || log.status === where.status) ? log : null;
      }),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: any) => {
        const log = { id: `cel${++sequence}`, externalConnectorId: null, ...data };
        logs.set(log.id, log);
        return log;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const log = logs.get(where.id);
        if (!log || (where.status && log.status !== where.status)) return { count: 0 };
        Object.assign(log, data);
        return { count: 1 };
      }),
    },
    inboundWebhookEvent: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === event.id &&
        where.provider === "unnichat" &&
        where.adId === null &&
        where.classificationReason === event.classificationReason
          ? event
          : null,
      ),
    },
    inboundWebhookChannel: {
      findFirst: vi.fn(async (args: any) => {
        const channel = await world.client.inboundWebhookChannel.findFirst(args);
        return channel
          ? {
              ...channel,
              connection: {
                ...channel.connection,
                parserRelease: { status: "certified" },
              },
            }
          : null;
      }),
    },
    integrationLog: { create: vi.fn(async () => ({ id: "il1" })) },
    diagnosticEvent: { create: vi.fn(async () => ({ id: "d1" })) },
    auditLog: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
  };
  const fetcher = vi.fn(async () =>
    new Response(
      JSON.stringify({ events_received: 1, messages: [], fbtrace_id: "t" }),
      { status: 200 },
    ),
  );
  const license = {
    getLockState: vi.fn(async () => ({
      inert: false,
      locked: options.locked === true,
    })),
  };
  const service = new ConversionEventsService(
    prisma,
    new MetaCapiAdapter({}, fetcher as unknown as typeof fetch),
    encryption,
    new MetaConnectionResolverService(prisma, encryption),
    license as never,
    env,
  );
  const record = () =>
    service.recordExternalConversion({
      workspaceId: "ws1",
      sourceEventId: "msg1",
      sourceTrigger: "inbound_webhook:unnichat",
      eventName: "LeadSubmitted",
      eventId: "lead_evt1",
      dedupeKey: "inbound-webhook:conn1:dk1",
      leadId: "lead1",
      phoneHash: "hash1",
      businessSource: "paid",
      ctwaDestination: world.intent,
      adId: null,
      ctwaClid: options.ctwaClid === undefined ? "clid-1" : options.ctwaClid,
      eventOccurredAt: occurredAt,
      sourcePayload: {
        processingMode: "live_production",
        inboundEventId: "evt1",
        channelId: "ch1",
        connectionId: "conn1",
      },
    });
  return { service, prisma, logs, fetcher, event, record, world };
}

describe("ConversionEvents CTWA page/pixel path", () => {
  it("records and sends a ctwa_clid lead without ad id to the authorized page/pixel", async () => {
    const h = harness();
    const recorded = await h.record();
    expect(recorded.deliveryStatus).toBe("ready_to_send");
    const log = h.logs.get(recorded.conversionEventLogId);
    expect(log).toMatchObject({
      attributionStatus: "ctwa_ad_unknown",
      metaBusinessConnectionId: "bm1",
      metaConversionDestinationId: "dest1",
      adId: null,
    });
    expect(log.sourcePayload.ctwaDestination).toEqual(h.world.intent);
    h.event.productionItem = {
      status: "materialized",
      leadId: "lead1",
      conversionEventLogId: log.id,
    };

    const result = await h.service.sendReadyEvent(log.id);
    expect(result.status).toBe("sent");
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = h.fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/pixel1/events");
    expect(url).toContain("access_token=bm-token");
    const body = JSON.parse(String(request.body));
    expect(body.data[0].user_data).toMatchObject({ ctwa_clid: "clid-1", page_id: "page1" });
    expect(body.data[0].custom_data).not.toHaveProperty("ad_id");
    expect(log).toMatchObject({ status: "sent", pixelId: "pixel1", pageId: "page1" });
  });

  it("refuses to record a CTWA destination for a lead without ctwa_clid", async () => {
    const h = harness({ ctwaClid: null });
    await expect(h.record()).rejects.toThrow("ctwa_destination_not_authorized");
    expect(h.logs.size).toBe(0);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("never dispatches a stored CTWA log that lost its ctwa_clid", async () => {
    const h = harness();
    const recorded = await h.record();
    const log = h.logs.get(recorded.conversionEventLogId);
    log.ctwaClid = null;
    h.event.productionItem = {
      status: "materialized",
      leadId: "lead1",
      conversionEventLogId: log.id,
    };
    const result = await h.service.sendReadyEvent(log.id);
    expect(result).toMatchObject({ status: "skipped", errorCode: "CtwaSendSkipped" });
    expect(log.errorMessage).toContain("ctwa_click_missing");
    expect(log.status).toBe("ready_to_send");
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(canRetryConversionEvent(log)).toBe(true);
  });

  it("skips (and records why) when the entry receipt or the license does not allow it", async () => {
    const h = harness();
    const recorded = await h.record();
    const log = h.logs.get(recorded.conversionEventLogId);
    const noReceipt = await h.service.sendReadyEvent(log.id);
    expect(noReceipt.errorMessage).toContain("ctwa_entry_receipt_invalid");
    const locked = harness({ locked: true });
    const lockedLog = locked.logs.get((await locked.record()).conversionEventLogId);
    locked.event.productionItem = {
      status: "materialized",
      leadId: "lead1",
      conversionEventLogId: lockedLog.id,
    };
    const lockedResult = await locked.service.sendReadyEvent(lockedLog.id);
    expect(lockedResult.errorMessage).toContain("ctwa_license_locked");
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(locked.fetcher).not.toHaveBeenCalled();
  });

  it("initial status follows the SaaS: ad id optional only with the authorized CTWA destination", async () => {
    const h = harness();
    const base = {
      workspaceId: "ws1",
      sourceEventId: "crm-1",
      eventName: "Purchase" as const,
      leadId: "lead3",
      phoneHash: "hash3",
      businessSource: "paid" as const,
      adId: null,
      valueCents: 1000,
      currency: "BRL",
      eventOccurredAt: new Date(Date.now() - 60_000),
    };
    // CRM stage (Kommo/Pipedrive style) with ctwa_clid, no ad id and no
    // authorized page/pixel: pending, exactly as the SaaS (nothing sent).
    const crm = await h.service.recordExternalConversion({
      ...base,
      sourceTrigger: "guimo_stage",
      eventId: "crm-evt-1",
      dedupeKey: "crm:1",
      ctwaClid: "clid-crm",
    });
    expect(crm.deliveryStatus).toBe("pending_meta_context");
    expect(h.logs.get(crm.conversionEventLogId).errorCode).toBe("MissingAdId");
    // Same lead with the authorized CTWA destination: ready to send, no ad id.
    const ctwa = await h.service.recordExternalConversion({
      ...base,
      sourceTrigger: "inbound_webhook:unnichat:provider_automation",
      eventId: "crm-evt-2",
      dedupeKey: "crm:2",
      ctwaClid: "clid-crm",
      ctwaDestination: h.world.intent,
    });
    expect(ctwa.deliveryStatus).toBe("ready_to_send");
    expect(h.logs.get(ctwa.conversionEventLogId)).toMatchObject({
      errorCode: null,
      adId: null,
      attributionStatus: "ctwa_ad_unknown",
    });
    // Destination without ctwa_clid: refused, nothing recorded or sent.
    await expect(
      h.service.recordExternalConversion({
        ...base,
        sourceTrigger: "inbound_webhook:unnichat:provider_automation",
        eventId: "crm-evt-3",
        dedupeKey: "crm:3",
        ctwaClid: null,
        ctwaDestination: h.world.intent,
      }),
    ).rejects.toThrow("ctwa_destination_not_authorized");
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("keeps non-CTWA conversions without ad id pending, never sent", async () => {
    const h = harness();
    const recorded = await h.service.recordExternalConversion({
      workspaceId: "ws1",
      sourceEventId: "m2",
      sourceTrigger: "inbound_webhook:umbler:provider_automation",
      eventName: "Purchase",
      eventId: "p2",
      dedupeKey: "provider-conversion:x",
      leadId: "lead2",
      phoneHash: "hash2",
      businessSource: "paid",
      adId: null,
      ctwaClid: null,
      valueCents: 1000,
      currency: "BRL",
      eventOccurredAt: new Date(),
    });
    expect(recorded.deliveryStatus).toBe("pending_meta_context");
    expect(h.logs.get(recorded.conversionEventLogId)).toMatchObject({
      errorCode: "MissingAdId",
      attributionStatus: "organic_or_unattributed",
    });
    expect(
      (await h.service.sendReadyEvent(recorded.conversionEventLogId)).status,
    ).toBe("skipped");
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});
