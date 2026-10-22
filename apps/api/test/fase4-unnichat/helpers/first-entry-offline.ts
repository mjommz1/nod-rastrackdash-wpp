import { MetaConnectionResolverService } from "../../../src/integrations/meta/meta-connection-resolver.service";
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ctwaHarness } from "./ctwa-harness";
import { InboundWebhookParserRegistry } from "../../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import { InboundWebhookProductionService } from "../../../src/inbound-webhook-production/inbound-webhook-production.service";
import { InboundWebhookProductionIntakeService } from "../../../src/inbound-webhooks/inbound-webhook-production-intake.service";
import { InboundWebhookChannelRoutesService } from "../../../src/inbound-webhooks/inbound-webhook-channel-routes.service";
import { InboundWebhookMetaRouteReaderService } from "../../../src/inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { LeadsService } from "../../../src/leads/leads.service";
import { ConversionEventsService } from "../../../src/conversion-events/conversion-events.service";
import { MetaCapiAdapter } from "../../../src/conversion-events/meta-capi.adapter";
import { ConversionEventsQueueService } from "../../../src/common/queue/conversion-events-queue.service";
import { ConversionEventProcessor } from "../../../src/common/queue/conversion-event.processor";
export function offline() {
  const h = ctwaHarness();
  const p = h.prisma;
  const payload = JSON.parse(
    readFileSync(
      __dirname + "/../fixtures/entry-with-ctwa.json",
      "utf8",
    ),
  );
  const registry = new InboundWebhookParserRegistry();
  const parsed = registry
    .resolve({
      provider: "unnichat",
      parserVersion: "v1",
      parserReleaseStatus: "certified",
    })
    .parse(payload, {
      organizationId: "w",
      connectedPhone: h.channel.providerChannelId,
    }).events[0]!;
  const now = new Date();
  const before = new Date(now.getTime() - 3600000);
  Object.assign(h.channel, { productionActivatedAt: before });
  Object.assign(h.channel.connection, {
    // This edition also checks the release provider and the delivery provider.
    parserRelease: { status: "certified", version: "v1", provider: "unnichat" },
    productionActivatedAt: before,
    removedAt: null,
  });
  const event: any = {
    id: "e",
    workspaceId: "w",
    connectionId: "c",
    channelId: "ch",
    provider: "unnichat",
    adId: null,
    hasCtwa: true,
    classification: "eligible_route_resolved",
    classificationReason: "authorized_ctwa_destination",
    dedupeKey: parsed.dedupeKey,
    externalMessageId: parsed.externalMessageId,
    normalizedSummary: parsed.normalizedSummary,
    occurredAt: new Date(now.getTime() - 60000),
    channel: h.channel,
    connection: h.channel.connection,
    resolvedBusinessConnectionId: "bm",
    resolvedReportingAccountId: null,
    resolvedConversionDestinationId: "dest",
    resolvedBusinessConnection: h.business,
    resolvedReportingAccount: null,
    resolvedConversionDestination: h.destination,
    delivery: {
      id: "d",
      workspaceId: "w",
      connectionId: "c",
      provider: "unnichat",
      parserVersion: "v1",
      firstReceivedAt: now,
      payloadExpiresAt: new Date(now.getTime() + 86400000),
      encryptedPayload: "synthetic",
      payloadIv: "synthetic",
      payloadTag: "synthetic",
      encryptionKeyVersion: 1,
    },
  };
  const item: any = { id: "item", workspaceId: "w", status: "queued", event };
  const leads: any[] = [];
  const logs: any[] = [];
  const jobs: any[] = [];
  const calls: any[] = [];
  p.$queryRaw = vi.fn(async () => []);
  p.$transaction = vi.fn(async (fn: any) => fn(p));
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]: any) =>
      k === "AND"
        ? v.every((clause: any) => matches(row, clause))
        : k === "sourcePayload" && v?.path
          ? v.path.reduce(
              (o: any, key: string) => o?.[key],
              row.sourcePayload,
            ) === v.equals
          : v && typeof v === "object"
            ? v.notIn
              ? !v.notIn.includes(row[k])
              : v.in
                ? v.in.includes(row[k])
                : true
            : row[k] === v,
    );
  p.inboundWebhookProductionItem = {
    findFirst: vi.fn(async ({ where }: any) =>
      matches(item, where) ? item : null,
    ),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (!matches(item, where)) return { count: 0 };
      Object.assign(item, data);
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }: any) => {
      Object.assign(item, data);
      return item;
    }),
  };
  p.inboundWebhookChannel = {
    findFirst: vi.fn(async ({ where }: any) =>
      matches(h.channel, where) ? h.channel : null,
    ),
  };
  p.inboundWebhookEvent = {
    findMany: vi.fn(async () => [event]),
    findFirst: vi.fn(async () => ({
      ...event,
      productionItem: item,
      replayItem: null,
    })),
  };
  p.metaCredential = {
    findFirst: vi.fn(async ({ where }: any) =>
      matches(h.credential, where) ? h.credential : null,
    ),
  };
  p.metaAd = { findFirst: vi.fn(async () => null) };
  p.lead = {
    upsert: vi.fn(async ({ create, update }: any) => {
      let l = leads.find(
        (l) =>
          l.workspaceId === create.workspaceId &&
          l.phoneHash === create.phoneHash,
      );
      if (l)
        Object.assign(
          l,
          Object.fromEntries(
            Object.entries(update).filter(([, v]) => v !== undefined),
          ),
        );
      else {
        l = { id: "lead", ...create };
        leads.push(l);
      }
      return l;
    }),
    updateMany: vi.fn(async () => ({ count: 1 })),
    findMany: vi.fn(async () => leads),
  };
  p.conversionEventLog = {
    count: vi.fn(
      async () => logs.filter((l) => l.eventName === "Purchase").length,
    ),
    findUnique: vi.fn(
      async ({ where }: any) => logs.find((l) => matches(l, where)) ?? null,
    ),
    findFirst: vi.fn(
      async ({ where }: any) => logs.find((l) => matches(l, where)) ?? null,
    ),
    findMany: vi.fn(async (query: any = {}) =>
      logs.filter((l) => matches(l, query.where ?? {})),
    ),
    create: vi.fn(async ({ data }: any) => {
      const row = { id: "log_" + logs.length, ...data };
      logs.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const l = logs.find((l) => l.id === where.id);
      Object.assign(l, data);
      return l;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const l = logs.find((l) => matches(l, where));
      if (!l) return { count: 0 };
      Object.assign(l, data);
      return { count: 1 };
    }),
  };
  p.integrationLog = { create: vi.fn(async () => ({ id: "integration" })) };
  p.jobAttempt = { create: vi.fn() };
  p.workspaceSubscription = { findFirst: vi.fn(async () => null) };
  // Adapted to this edition: no billing module; the license client is the
  // send gate (unlocked here).
  const billing = undefined;
  const license = {
    getLockState: vi.fn(async () => ({ inert: false, locked: false })),
  };
  const fetcher = vi.fn(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{"events_received":1,"messages":[],"fbtrace_id":"t"}', { status: 200 });
    },
  );
  const conversions = new ConversionEventsService(
    p,
    new MetaCapiAdapter({}, fetcher),
    { decrypt: () => "synthetic_token" } as any,
    new MetaConnectionResolverService(p, {
      decrypt: () => "synthetic_token",
    } as any),
    license as any,
    {
      NODE_ENV: "test",
      INBOUND_WEBHOOKS_ENABLED: "true",
      INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
      INBOUND_WEBHOOK_REPLAY_ENABLED: "true",
      INBOUND_CONVERSION_RULES_ENABLED: "true",
      INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
      API_PUBLIC_URL: "http://localhost:3333",
      INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
    },
  );
  const queue = new ConversionEventsQueueService({
    add: vi.fn(async (name, data, opts) => {
      const job = { id: opts.jobId, name, data };
      jobs.push(job);
      return job;
    }),
  } as any);
  const production = new InboundWebhookProductionService(
    p,
    { decrypt: () => Buffer.from(JSON.stringify(payload)) } as any,
    registry,
    new LeadsService(p),
    conversions,
    queue,
    {
      NODE_ENV: "test",
      INBOUND_WEBHOOKS_ENABLED: "true",
      INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
      API_PUBLIC_URL: "http://localhost:3333",
      INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
    },
  );
  const processor = new ConversionEventProcessor(conversions, p);
  return {
    ...h,
    payload,
    event,
    item,
    leads,
    logs,
    jobs,
    calls,
    fetcher,
    conversions,
    production,
    processor,
    queue,
    billing,
  };
}
