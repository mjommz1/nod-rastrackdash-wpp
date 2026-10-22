import "reflect-metadata";
import { vi } from "vitest";
import {
  applyInboundWebhookChannelStatus,
  applyInboundWebhookConnectionStatus,
} from "../../src/inbound-webhooks/inbound-webhook-production-activation";
import { InboundWebhookMetaRouteReaderService } from "../../src/inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { InboundWebhookChannelRoutesService } from "../../src/inbound-webhooks/inbound-webhook-channel-routes.service";
import { InboundWebhookPayloadEncryptionService } from "../../src/inbound-webhooks/inbound-webhook-payload-encryption.service";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import { InboundWebhookProductionService } from "../../src/inbound-webhook-production/inbound-webhook-production.service";
import { InboundWebhookReplayService } from "../../src/inbound-webhook-replay/inbound-webhook-replay.service";
import { InboundWebhookProductionIntakeService } from "../../src/inbound-webhooks/inbound-webhook-production-intake.service";

export function wildcardFixture() {
  const now = new Date();
  const business = {
    id: "bm",
    workspaceId: "ws",
    status: "active",
    defaultConversionDestinationId: "dest",
    credential: { workspaceId: "ws", status: "active" },
  };
  const destination = {
    id: "dest",
    workspaceId: "ws",
    status: "configured",
    pixelId: "pixel",
    pageId: "page",
  };
  const accounts = [1, 2, 3].map((i) => ({
    id: `account-${i}`,
    workspaceId: "ws",
    adAccountId: `act-${i}`,
    businessConnectionId: "bm",
    active: true,
    conversionDestinationId: null as string | null,
    allowedDestinations: [
      { workspaceId: "ws", active: true, conversionDestinationId: "dest" },
    ],
  }));
  const ads = accounts.map((a, i) => ({
    adId: `ad-${i + 1}`,
    workspaceId: "ws",
    adAccountId: a.adAccountId,
    destinationAssignment: null as any,
    campaignId: "campaign",
    adSetId: "adset",
  }));
  const route = {
    id: "route",
    workspaceId: "ws",
    channelId: "channel",
    active: true,
    validationStatus: "valid",
    metaBusinessConnectionId: "bm",
    metaReportingAccountId: null as string | null,
    metaConversionDestinationId: "dest" as string | null,
    createdAt: now,
    updatedAt: now,
  };
  const connection = {
    id: "connection",
    workspaceId: "ws",
    provider: "meta_cloud",
    displayName: "fixture",
    status: "observation",
    removedAt: null,
    productionActivatedAt: null,
    createdAt: now,
    updatedAt: now,
    lastDeliveryAt: null,
    lastSuccessfulParseAt: null,
    parserRelease: {
      id: "release",
      provider: "meta_cloud",
      version: "v1",
      status: "certified",
      certifiedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  };
  const channel = {
    id: "channel",
    workspaceId: "ws",
    connectionId: "connection",
    connection,
    routes: [route],
    status: "discovered",
    connectedPhone: "15550000001",
    organizationId: "synthetic-waba",
    providerChannelId: "synthetic-phone",
    productionActivatedAt: null,
    updatedAt: now,
    createdAt: now,
    firstSeenAt: now,
    lastSeenAt: now,
  };
  const matchRoute = (r: any, where: any) =>
    Object.entries(where).every(([key, value]) =>
      typeof value === "object" && value !== null && "not" in value
        ? r[key] !== value.not
        : r[key] === value,
    );
  const prisma: any = {
    metaBusinessConnection: {
      findFirst: vi.fn(async ({ where }) =>
        business.id === where.id &&
        business.workspaceId === where.workspaceId &&
        (!where.credential ||
          business.credential.workspaceId === where.credential.is.workspaceId)
          ? business
          : null,
      ),
    },
    metaReportingAccount: {
      findMany: vi.fn(async ({ where }) =>
        accounts
          .filter(
            (a) =>
              a.workspaceId === where.workspaceId &&
              (!where.id || a.id === where.id) &&
              (!where.businessConnectionId ||
                a.businessConnectionId === where.businessConnectionId) &&
              (where.active === undefined || a.active === where.active),
          )
          .map((a) => ({
            ...a,
            allowedDestinations: a.allowedDestinations.filter(
              (d) => d.workspaceId === where.workspaceId && d.active,
            ),
          })),
      ),
      findFirst: vi.fn(async ({ where }) => {
        const account = accounts.find(
          (a) =>
            a.workspaceId === where.workspaceId &&
            (!where.id || a.id === where.id) &&
            (!where.adAccountId || a.adAccountId === where.adAccountId),
        );
        return account
          ? {
              ...account,
              allowedDestinations: account.allowedDestinations.filter(
                (d) => d.workspaceId === where.workspaceId && d.active,
              ),
            }
          : null;
      }),
    },
    metaConversionDestination: {
      findFirst: vi.fn(async ({ where }) =>
        destination.workspaceId === where.workspaceId &&
        (typeof where.id === "string"
          ? destination.id === where.id
          : where.id.in.includes(destination.id)) &&
        (!where.status || destination.status === where.status)
          ? destination
          : null,
      ),
    },
    metaAd: {
      findFirst: vi.fn(
        async ({ where }) =>
          ads.find(
            (a) => a.adId === where.adId && a.workspaceId === where.workspaceId,
          ) ?? null,
      ),
      findMany: vi.fn(async () => ads),
    },
    inboundWebhookConnection: {
      findFirst: vi.fn(async () => connection),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(connection, data);
        return { count: 1 };
      }),
    },
    inboundWebhookChannel: {
      findFirst: vi.fn(async () => channel),
      findMany: vi.fn(async ({ where, select }) =>
        !where.status || channel.status === where.status
          ? [
              {
                ...channel,
                routes: select?.routes?.where
                  ? channel.routes.filter((r) =>
                      matchRoute(r, select.routes.where),
                    )
                  : channel.routes,
              },
            ]
          : [],
      ),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(channel, data);
        return { count: 1 };
      }),
    },
    inboundWebhookReplayBatch: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    },
    auditLog: { create: vi.fn(async () => undefined) },
  };
  const seats = { enforcementEnabled: () => false, activateSeat: vi.fn() };
  const activate = () =>
    applyInboundWebhookChannelStatus(prisma, {
      workspaceId: "ws",
      channelId: "channel",
      status: "active",
      actorUserId: "actor",
      requireValidMetaRoute: true,
      seats,
    });
  const promote = () =>
    applyInboundWebhookConnectionStatus(prisma, {
      workspaceId: "ws",
      connectionId: "connection",
      status: "production",
      actorUserId: "actor",
      requireValidMetaRoute: true,
      seats,
      env: { META_APP_SECRET: "synthetic-app-secret" },
    });
  const reader = new InboundWebhookMetaRouteReaderService(prisma);
  const routes = new InboundWebhookChannelRoutesService(prisma, reader);
  return {
    prisma,
    business,
    destination,
    accounts,
    ads,
    route,
    connection,
    channel,
    seats,
    activate,
    promote,
    reader,
    routes,
  };
}

// Local synthetic CTWA only: real parser and authenticated payload encryption,
// with every persistence/send dependency contained in the fixture.
export function wildcardDispatchFixture() {
  const h = wildcardFixture();
  const env = {
    NODE_ENV: "test",
    API_PUBLIC_URL: "http://localhost:3333",
    INBOUND_WEBHOOKS_ENABLED: "true",
    INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
    INBOUND_WEBHOOK_REPLAY_ENABLED: "true",
    META_APP_SECRET: "synthetic-app-secret",
    INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
  const encryption = new InboundWebhookPayloadEncryptionService(env);
  const registry = new InboundWebhookParserRegistry();
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "synthetic-waba",
        changes: [
          {
            field: "messages",
            value: {
              metadata: {
                phone_number_id: "synthetic-phone",
                display_phone_number: "15550000001",
              },
              messages: [
                {
                  id: "wamid.synthetic",
                  from: "15550000002",
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: "fixture" },
                  referral: { ctwa_clid: "synthetic-clid", source_id: "ad-1" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const parsed = registry
    .resolve({ provider: "meta_cloud", parserVersion: "v1" })
    .parse(payload).events[0];
  Object.assign(h.channel, {
    organizationId: parsed.organizationId,
    providerChannelId: parsed.channel.providerChannelId,
    whatsappInstanceId: null,
    whatsappInstance: null,
    channelName: "fixture",
  });
  const activatedAt = new Date(Date.now() - 60_000);
  Object.assign(h.connection, {
    status: "production",
    productionActivatedAt: activatedAt,
  });
  Object.assign(h.channel, {
    status: "active",
    productionActivatedAt: activatedAt,
  });
  const delivery = {
    id: "delivery",
    workspaceId: "ws",
    connectionId: "connection",
    provider: "meta_cloud",
    parserVersion: "v1",
    firstReceivedAt: new Date(),
    payloadExpiresAt: new Date(Date.now() + 86400_000),
    ...encryption.encrypt(Buffer.from(JSON.stringify(payload)), {
      workspaceId: "ws",
      connectionId: "connection",
      deliveryId: "delivery",
    }),
  };
  const event: any = {
    id: "event",
    workspaceId: "ws",
    connectionId: "connection",
    channelId: "channel",
    deliveryId: "delivery",
    provider: "meta_cloud",
    adId: "ad-1",
    hasCtwa: true,
    dedupeKey: parsed.dedupeKey,
    externalMessageId: parsed.externalMessageId,
    occurredAt: parsed.occurredAt,
    classification: "eligible_route_resolved",
    resolvedBusinessConnectionId: "bm",
    resolvedReportingAccountId: "account-1",
    resolvedConversionDestinationId: "dest",
    resolvedBusinessConnection: h.business,
    resolvedReportingAccount: h.accounts[0],
    resolvedConversionDestination: h.destination,
    delivery,
    connection: h.connection,
    channel: h.channel,
    replayItem: null,
    productionItem: null,
  };
  const item: any = {
    id: "item",
    workspaceId: "ws",
    event,
    status: "queued",
    attemptCount: 0,
  };
  const delegate = {
    findFirst: vi.fn(async () => item),
    findMany: vi.fn(async () => []),
    createMany: vi.fn(async () => ({ count: 1 })),
    update: vi.fn(async ({ data }) => {
      Object.assign(item, data);
      return item;
    }),
  };
  Object.assign(h.prisma, {
    inboundWebhookProductionItem: delegate,
    inboundWebhookReplayItem: delegate,
    inboundWebhookEvent: {
      findMany: vi.fn(async () => [event]),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(event, data);
        return { count: 1 };
      }),
    },
    inboundWebhookDelivery: { findMany: vi.fn(async () => [delivery]) },
    inboundWebhookChannelRoute: {
      findMany: vi.fn(async () => h.channel.routes.filter((r) => r.active)),
      updateMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async ({ create, update }) => {
        const existing = h.channel.routes.find(
          (r) =>
            r.metaBusinessConnectionId === create.metaBusinessConnectionId &&
            r.metaReportingAccountId === create.metaReportingAccountId &&
            r.metaConversionDestinationId ===
              create.metaConversionDestinationId,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const learned = { ...h.route, ...create, id: "learned-route" };
        h.channel.routes.push(learned);
        return learned;
      }),
    },
    $transaction: vi.fn(async (fn) => fn(h.prisma)),
  });
  const leads = {
    upsertFromWhatsappWebhook: vi.fn(async () => ({ id: "lead" })),
  };
  const conversions = {
    recordExternalConversion: vi.fn(async (_input: any) => ({
      status: "created",
      conversionEventLogId: "conversion",
      deliveryStatus: "ready_to_send",
    })),
  };
  const conversionQueue = { enqueueSend: vi.fn(async () => undefined) };
  const queue = { enqueueItem: vi.fn(async () => ({ status: "queued" })) };
  const production = new InboundWebhookProductionService(
    h.prisma,
    encryption,
    registry,
    leads as never,
    conversions as never,
    conversionQueue as never,
    env,
  );
  const replayQueue = { enqueueBatch: vi.fn(async () => undefined) };
  const replay = new InboundWebhookReplayService(
    h.prisma,
    encryption,
    registry,
    leads as never,
    conversions as never,
    conversionQueue as never,
    replayQueue as never,
    env,
    { getLockState: async () => ({ inert: true, locked: false }) } as never,
  );
  const intake = new InboundWebhookProductionIntakeService(
    h.prisma,
    queue as never,
    env,
  );
  return {
    ...h,
    env,
    delivery,
    event,
    item,
    leads,
    conversions,
    conversionQueue,
    queue,
    replayQueue,
    production,
    replay,
    intake,
    encryption,
    registry,
    payload,
  };
}

export function wildcardReplayAuthorizationFixture() {
  const h = wildcardDispatchFixture();
  h.delivery.firstReceivedAt = new Date(Date.now() - 120_000);
  const now = new Date();
  let batch: any = null;
  h.prisma.inboundWebhookChannel.count = vi.fn(async ({ where }) =>
    where.id === h.channel.id &&
    where.workspaceId === h.channel.workspaceId &&
    where.connectionId === h.channel.connectionId
      ? 1
      : 0,
  );
  Object.assign(h.prisma.inboundWebhookReplayBatch, {
    findFirst: vi.fn(async () => batch),
    create: vi.fn(async ({ data }) => {
      batch = {
        id: "batch",
        channelId: "channel",
        totalItems: 0,
        materializedCount: 0,
        duplicateCount: 0,
        skippedCount: 0,
        failedCount: 0,
        retryCount: 0,
        startedAt: null,
        completedAt: null,
        lastRetriedAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      return batch;
    }),
    update: vi.fn(async ({ data }) => {
      Object.assign(batch, data);
      return batch;
    }),
  });
  return h;
}
