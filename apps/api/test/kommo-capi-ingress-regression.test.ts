import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaCapiAdapter } from "../src/conversion-events/meta-capi.adapter";
import { ConversionEventsService } from "../src/conversion-events/conversion-events.service";
import { ConversionEventProcessor } from "../src/common/queue/conversion-event.processor";
import { MetaConnectionResolverService } from "../src/integrations/meta/meta-connection-resolver.service";
import { MetaTokenEncryptionService } from "../src/integrations/meta/meta-token-encryption.service";
import { InboundWebhookProductionService } from "../src/inbound-webhook-production/inbound-webhook-production.service";
import { InboundWebhookReplayService } from "../src/inbound-webhook-replay/inbound-webhook-replay.service";
import { InboundWebhookParserRegistry } from "../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import { InboundWebhookPayloadEncryptionService } from "../src/inbound-webhooks/inbound-webhook-payload-encryption.service";
import { LeadsService } from "../src/leads/leads.service";
import { DiagnosticsService } from "../src/diagnostics/diagnostics.service";
import { KommoService } from "../src/kommo/kommo.service";
import { applyInboundWebhookConnectionStatus } from "../src/inbound-webhooks/inbound-webhook-production-activation";
import {
  studentReplayContext,
  studentReplayEventHash,
} from "../src/inbound-webhook-replay/student-replay-context";
import { kommoHarness } from "./support/kommo-stateful-harness";

// Persistence/queues and remote Kommo enrichment are synthetic boundaries.
// Parser, AEAD, LeadsService, canonical events, resolver, worker and CAPI adapter
// are real imports. Only fetch decides the provider result; no module mocks.
function fixture(source: "oauth" | "manual" = "oauth") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T12:01:00Z"));
  const h = kommoHarness([
    "workspaceMember",
    "inboundWebhookConnection",
    "inboundWebhookChannel",
    "metaIntegration",
    "metaBusinessConnection",
    "metaConversionDestination",
    "metaReportingAccountDestination",
    "inboundWebhookProductionItem",
    "inboundWebhookReplayBatch",
    "inboundWebhookReplayItem",
  ]);
  h.state.lead.length = 0; // No artificial whatsappInstanceId on a prebuilt lead.
  const env = {
    API_PUBLIC_URL: "https://fixture.invalid",
    META_APP_SECRET: "synthetic-own-app-secret",
    INBOUND_WEBHOOKS_ENABLED: "true",
    INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
    INBOUND_WEBHOOK_REPLAY_ENABLED: "true",
    INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
  };
  const encryption = new MetaTokenEncryptionService({
    META_TOKEN_ENCRYPTION_KEY: "synthetic-fixture-key",
  });
  const payloadEncryption = new InboundWebhookPayloadEncryptionService(env);
  const registry = new InboundWebhookParserRegistry();
  const route = h.state.inboundWebhookChannelRoute[0];
  const credential = Object.assign(route.metaBusinessConnection.credential, {
    id: "credential-a",
    source,
    ...encryption.encrypt("graph-only-token"),
  });
  const business = Object.assign(route.metaBusinessConnection, {
    credentialId: credential.id,
    businessManagerId: "bm-a",
    defaultConversionDestinationId: "destination-a",
  });
  const destination = Object.assign(route.metaConversionDestination, {
    id: "destination-a",
  });
  const reporting = Object.assign(route.metaReportingAccount, {
    conversionDestinationId: "destination-a",
  });
  h.state.metaBusinessConnection.push(business);
  h.state.metaReportingAccount.push(reporting);
  h.state.metaConversionDestination.push(destination);
  const dedicated = encryption.encrypt("capi-dedicated-token");
  const legacy = {
    id: "legacy-a",
    workspaceId: "workspace-a",
    status: "connected",
    advancedRoutingEnabled: false,
    selectedBusinessId: "bm-a",
    selectedAdAccountId: "act_synthetic",
    selectedPixelId: "synthetic-pixel",
    primaryConversionDestinationId: "destination-a",
    ...encryption.encrypt("legacy-graph-token"),
    capiAccessTokenEncrypted: dedicated.encryptedAccessToken,
    capiTokenIv: dedicated.tokenIv,
    capiTokenTag: dedicated.tokenTag,
  };
  h.state.metaIntegration.push(legacy);
  h.state.metaAd.push({
    workspaceId: "workspace-a",
    adId: "ad-a",
    adAccountId: "act_synthetic",
    campaignId: "campaign-a",
    adSetId: "adset-a",
  });
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          events_received: 1,
          messages: [],
          fbtrace_id: "synthetic-trace",
        }),
        { status: 200 },
      ),
  );
  const resolver = new MetaConnectionResolverService(h.prisma, encryption);
  // Even a deployment token must not circumvent a rejected workspace credential.
  const adapter = new MetaCapiAdapter(
    { META_CAPI_ACCESS_TOKEN: "forbidden-global-fallback" },
    fetcher,
  );
  const conversions = new ConversionEventsService(
    h.prisma,
    adapter,
    encryption,
    resolver,
    h.license as any,
    env,
  );
  const processor = new ConversionEventProcessor(conversions, h.prisma);
  const leads = new LeadsService(h.prisma);
  const conversionQueue = {
    ...h.conversionQueue,
    enqueueSend: vi.fn(async () => undefined),
  };
  const production = new InboundWebhookProductionService(
    h.prisma,
    payloadEncryption,
    registry,
    leads,
    conversions,
    conversionQueue as any,
    env,
  );
  const replay = new InboundWebhookReplayService(
    h.prisma,
    payloadEncryption,
    registry,
    leads,
    conversions,
    conversionQueue as any,
    {} as any,
    env,
    h.license as any,
  );
  const kommo = new KommoService(
    h.prisma,
    h.adapter as any,
    h.queue as any,
    conversions,
    conversionQueue as any,
    h.license as any,
  );
  kommo.now = h.service.now;
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "synthetic-waba",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "551132630883",
                phone_number_id: "synthetic-number",
              },
              contacts: [
                {
                  profile: { name: "Synthetic Contact" },
                  wa_id: "5511999999999",
                },
              ],
              messages: [
                {
                  from: "5511999999999",
                  id: "synthetic-message",
                  timestamp: "1791201660",
                  type: "text",
                  text: { body: "Synthetic inquiry" },
                  referral: {
                    ctwa_clid: "trusted-click",
                    source_id: "ad-a",
                    source_type: "ad",
                  },
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
    .parse(payload, { organizationId: "workspace-a" });
  expect(parsed.error).toBeNull();
  expect(parsed.events).toHaveLength(1);
  const normalized = parsed.events[0];
  const connection = Object.assign(route.channel.connection, {
    id: "inbound-a",
    provider: "meta_cloud",
    updatedAt: new Date(),
    parserRelease: {
      id: "release-a",
      provider: "meta_cloud",
      status: "certified",
      version: "v1",
    },
  });
  const channel = Object.assign(route.channel, {
    connectionId: connection.id,
    organizationId: normalized.organizationId,
    providerChannelId: normalized.channel.providerChannelId,
    connectedPhone: normalized.channel.connectedPhone,
    whatsappInstance: {
      id: "instance-a",
      workspaceId: "workspace-a",
      status: "active",
    },
    routes: [
      {
        id: route.id,
        workspaceId: "workspace-a",
        active: true,
        validationStatus: "valid",
        metaBusinessConnectionId: business.id,
        metaReportingAccountId: reporting.id,
        metaConversionDestinationId: destination.id,
      },
    ],
  });
  const delivery = {
    id: "delivery-a",
    workspaceId: "workspace-a",
    connectionId: connection.id,
    provider: "meta_cloud",
    parserVersion: "v1",
    firstReceivedAt: normalized.occurredAt,
    payloadExpiresAt: new Date(Date.now() + 3600_000),
    ...payloadEncryption.encrypt(Buffer.from(JSON.stringify(payload)), {
      workspaceId: "workspace-a",
      connectionId: connection.id,
      deliveryId: "delivery-a",
    }),
  };
  const event = {
    id: "inbound-event-a",
    workspaceId: "workspace-a",
    connectionId: connection.id,
    channelId: channel.id,
    provider: "meta_cloud",
    classification: "eligible_route_resolved",
    hasCtwa: true,
    adId: "ad-a",
    dedupeKey: normalized.dedupeKey,
    externalMessageId: normalized.externalMessageId,
    occurredAt: normalized.occurredAt,
    deliveryId: delivery.id,
    resolvedBusinessConnectionId: business.id,
    resolvedReportingAccountId: reporting.id,
    resolvedConversionDestinationId: destination.id,
    connection,
    channel,
    delivery,
    resolvedBusinessConnection: business,
    resolvedReportingAccount: reporting,
    resolvedConversionDestination: destination,
  };
  const item = {
    id: "item-a",
    workspaceId: "workspace-a",
    status: "queued",
    attemptCount: 0,
    event,
  };
  h.state.inboundWebhookConnection.push(connection);
  h.state.inboundWebhookChannel.push(channel);
  h.state.inboundWebhookEvent.push(event);
  h.state.workspaceMember.push({
    id: "member-a",
    userId: "owner-a",
    workspaceId: "workspace-a",
    role: "owner",
    workspace: { operationalStatus: "active" },
  });
  h.state.inboundWebhookProductionItem.push(item);
  const materialize = async (mode: "production" | "replay" = "production") => {
    if (mode === "production")
      await production
        .processItem({
          productionItemId: item.id,
          workspaceId: item.workspaceId,
        })
        .catch((error) => {
          throw new Error((item as any).errorCode ?? error.message);
        });
    else {
      // Represents an already authorized isolated batch; exercise the public worker.
      connection.status = "observation";
      {
        const batch = await h.prisma.inboundWebhookReplayBatch.create({
          data: {
            workspaceId: item.workspaceId,
            connectionId: connection.id,
            channelId: channel.id,
            requestedByUserId: "owner-a",
            selection: "canary_1",
            requestedLimit: 1,
            status: "queued",
            totalItems: 1,
            materializedCount: 0,
            duplicateCount: 0,
            skippedCount: 0,
            failedCount: 0,
            retryableFailedCount: 0,
            retryCount: 0,
            startedAt: null,
            completedAt: null,
            lastRetriedAt: null,
          },
        });
        const replayItem = await h.prisma.inboundWebhookReplayItem.create({
          data: {
            workspaceId: item.workspaceId,
            event,
            eventId: event.id,
            batchId: batch.id,
            status: "queued",
            attemptCount: 0,
          },
        });
        // Isolated ingress fixture represents explicit owner approval with an
        // immutable context, not a shortcut in the public student API.
        await h.prisma.auditLog.create({
          data: {
            workspaceId: item.workspaceId,
            actorUserId: "owner-a",
            actorType: "owner",
            action: "inbound_webhook.replay.authorize",
            targetType: "InboundWebhookReplayBatch",
            targetId: batch.id,
            resultStatus: "queued",
            afterSummary: {
              studentContext: await studentReplayContext(
                h.prisma,
                item.workspaceId,
                connection.id,
                channel.id,
              ),
              studentEventHashes: {
                [event.id]: studentReplayEventHash(event as any),
              },
            },
          },
        });
        const result = await replay.processBatch({
          batchId: batch.id,
          workspaceId: item.workspaceId,
        });
        if (result.failedCount) {
          throw new Error(
            h.state.inboundWebhookReplayItem.find(
              (row) => row.id === replayItem.id,
            )?.errorCode,
          );
        }
      }
    }
    return h.state.conversionEventLog[0];
  };
  const send = (log: any) =>
    processor.process({
      id: `job-${log.id}`,
      name: "send-ready-event",
      attemptsMade: 0,
      data: { workspaceId: "workspace-a", conversionEventLogId: log.id },
    } as any);
  const stage = async () => {
    // Kommo requires the origin in production. Promote only after the replay
    // delivery is confirmed, through the same validated activation operation.
    if (connection.status === "observation")
      await applyInboundWebhookConnectionStatus(h.prisma, {
        workspaceId: "workspace-a",
        connectionId: connection.id,
        status: "production",
        actorUserId: "owner-a",
        requireValidMetaRoute: true,
        env,
        seats: {
          enforcementEnabled: () => false,
          activateSeat: async () => undefined,
        },
      });
    const webhook = await h.receive();
    expect(await kommo.process(webhook.id, "workspace-a")).toMatchObject({
      status: "queued",
    });
    return h.state.conversionEventLog.find(
      (row) => row.sourceTrigger === "kommo_stage",
    );
  };
  const retry = (log: any) =>
    new DiagnosticsService(
      h.prisma,
      undefined,
      conversionQueue as any,
    ).retryConversionEvent(
      log.id,
      { reason: "synthetic configuration repair" },
      {
        workspaceId: "workspace-a",
        actorUserId: "owner-a",
        actorType: "workspace_member",
        allowConfigurationBlocked: true,
        transientOnly: true,
      },
    );
  return {
    ...h,
    encryption,
    credential,
    business,
    destination,
    reporting,
    legacy,
    fetcher,
    resolver,
    conversions,
    kommo,
    event,
    item,
    materialize,
    send,
    stage,
    retry,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Inbound -> persisted lead -> LeadSubmitted -> same lead Kommo -> real CAPI", () => {
  it.each(["production", "replay"] as const)(
    "delivers both through %s with distinct IDs and dedicated OAuth CAPI token",
    async (mode) => {
      const h = fixture();
      const leadEvent = await h.materialize(mode);
      expect(h.state.lead).toHaveLength(1);
      const inboundDelegate =
        mode === "production"
          ? h.prisma.inboundWebhookProductionItem
          : h.prisma.inboundWebhookReplayItem;
      expect(
        inboundDelegate.findFirst.mock.calls[0][0].include.event.include.channel
          .include.whatsappInstance,
      ).toBe(true);
      expect(h.state.lead[0]).toMatchObject({
        whatsappInstanceId: "instance-a",
        adId: "ad-a",
        ctwaClid: "trusted-click",
      });
      expect(await h.send(leadEvent)).toMatchObject({ status: "sent" });
      const kommoEvent = await h.stage();
      expect(kommoEvent.leadId).toBe(leadEvent.leadId);
      expect(kommoEvent.eventId).not.toBe(leadEvent.eventId);
      expect(await h.send(kommoEvent)).toMatchObject({ status: "sent" });
      expect(await h.send(leadEvent)).toMatchObject({ status: "skipped" });
      expect(await h.send(kommoEvent)).toMatchObject({ status: "skipped" });
      await h.materialize(mode);
      const duplicate = await h.receive();
      await h.kommo.process(duplicate.id, "workspace-a");
      expect(h.state.conversionEventLog).toHaveLength(2);
      expect(h.fetcher).toHaveBeenCalledTimes(2);
      expect(h.metaAdapter.sendEvent).not.toHaveBeenCalled();
      h.fetcher.mock.calls.forEach(([url, request], index) => {
        expect(new URL(String(url)).pathname).toBe(
          "/v21.0/synthetic-pixel/events",
        );
        expect(new URL(String(url)).searchParams.get("access_token")).toBe(
          "capi-dedicated-token",
        );
        expect(request?.method).toBe("POST");
        const data = JSON.parse(String(request?.body)).data[0];
        expect(data).toMatchObject({
          event_id: [leadEvent, kommoEvent][index].eventId,
          event_name: ["LeadSubmitted", "Purchase"][index],
          user_data: { page_id: "synthetic-page", ctwa_clid: "trusted-click" },
          custom_data: { ad_id: "ad-a" },
        });
      });
      expect(
        h.state.jobAttempt.filter((row) => row.status === "sent"),
      ).toHaveLength(2);
      expect(h.state.kommoConversionDedupe[0]).toMatchObject({
        senderAttempts: 1,
        publicationStatus: "sent",
      });
    },
  );

  it("keeps legacy LeadSubmitted delivering beside a partial unrelated BM with advanced off", async () => {
    const h = fixture("manual");
    h.business.defaultConversionDestinationId = null;
    h.reporting.conversionDestinationId = null;
    h.state.metaAd.push({
      workspaceId: "workspace-a",
      adId: "legacy-ad",
      adAccountId: "act-legacy",
    });
    const result = await h.conversions.recordAutomaticLeadSubmitted({
      workspaceId: "workspace-a",
      phoneHash: "synthetic-hash",
      adId: "legacy-ad",
      ctwaClid: "legacy-click",
    });
    const log = h.state.conversionEventLog.find(
      (row) => row.id === result.created[0],
    );
    expect(await h.send(log)).toMatchObject({ status: "sent" });
    expect(
      new URL(String(h.fetcher.mock.calls[0][0])).searchParams.get(
        "access_token",
      ),
    ).toBe("capi-dedicated-token");
    h.legacy.advancedRoutingEnabled = true;
    log.status = "ready_to_send";
    expect(await h.send(log)).toMatchObject({ status: "not_configured" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it("sends matching manual events with the BM credential even when the legacy CAPI token is empty", async () => {
    const h = fixture("manual");
    Object.assign(h.legacy, {
      capiAccessTokenEncrypted: null,
      encryptedAccessToken: h.encryption.encrypt("").encryptedAccessToken,
    });
    const log = await h.materialize();
    expect(await h.send(log)).toMatchObject({ status: "sent" });
    expect(
      new URL(String(h.fetcher.mock.calls[0][0])).searchParams.get(
        "access_token",
      ),
    ).toBe("graph-only-token");
  });

  it.each([
    "revoked",
    "invalid",
    "unauthorized_destination",
    "ambiguous",
    "privacy",
    "intent",
  ])("blocks %s with no provider POST or fallback", async (kind) => {
    const h = fixture();
    const log = await h.materialize();
    if (kind === "revoked") h.credential.status = "revoked";
    if (kind === "invalid")
      h.credential.tokenTag = Buffer.alloc(16, 0).toString("base64");
    if (kind === "unauthorized_destination") {
      h.state.metaConversionDestination.push({
        ...h.destination,
        id: "unauthorized",
      });
      log.metaConversionDestinationId = "unauthorized";
    }
    if (kind === "ambiguous") {
      h.state.metaReportingAccount.push({
        ...h.reporting,
        id: "reporting-b",
        adAccountId: "act-b",
      });
      log.metaAccountId = null;
      log.adId = null;
      log.campaignId = null;
    }
    if (kind === "privacy") {
      h.item.status = "queued";
      h.item.event.classification = "ignored_private";
      await expect(h.materialize()).rejects.toThrow();
      expect(h.fetcher).not.toHaveBeenCalled();
      return;
    }
    if (kind === "intent") {
      const stage = await h.stage();
      h.connection.allowedChannelRouteIds = [];
      expect(await h.send(stage)).toMatchObject({ status: "skipped" });
    } else
      expect(await h.send(log)).toMatchObject({ status: "not_configured" });
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it.each(["token", "route"])(
    "does not consume dispatch on preflight %s rejection; repair + real diagnostic retry sends once",
    async (kind) => {
      const h = fixture("manual");
      await h.materialize();
      const log = await h.stage();
      if (kind === "token")
        Object.assign(h.credential, h.encryption.encrypt(""));
      if (kind === "route")
        h.state.metaAd[0].destinationAssignment = {
          reportingAccountId: h.reporting.id,
          conversionDestinationId: "missing-destination",
        };
      expect(await h.send(log)).toMatchObject({ status: "not_configured" });
      expect(h.fetcher).not.toHaveBeenCalled();
      expect(h.state.kommoConversionDedupe[0]).toMatchObject({
        senderAttempts: 0,
        senderLeaseToken: null,
      });
      Object.assign(h.credential, h.encryption.encrypt("repaired-capi-token"));
      delete h.state.metaAd[0].destinationAssignment;
      log.phoneHash = h.state.lead[0].phoneHash;
      await h.retry(log);
      expect(await h.send(log)).toMatchObject({ status: "sent" });
      expect(await h.send(log)).toMatchObject({ status: "skipped" });
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      expect(h.state.kommoConversionDedupe[0].senderAttempts).toBe(1);
    },
  );

  it("fences a timeout after fetch starts, including a legacy diagnostic retry that reopens the log", async () => {
    const h = fixture("manual");
    await h.materialize();
    const log = await h.stage();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    h.fetcher.mockImplementationOnce(async (_url, request) => {
      expect(request?.signal).toBe(controller.signal);
      queueMicrotask(() =>
        controller.abort(new Error("synthetic deadline after dispatch")),
      );
      return new Promise<Response>(() => undefined);
    });
    expect(await h.send(log)).toMatchObject({
      status: "error",
      errorCode: "MetaCapiDeliveryUnknown",
    });
    expect(h.state.kommoConversionDedupe[0]).toMatchObject({
      senderAttempts: 1,
      publicationStatus: "delivery_unknown",
    });
    expect(
      await h.conversions.prepareKommoSenderRetry(log.id, "workspace-a"),
    ).toBe("delivery_unknown");
    await expect(h.retry(log)).rejects.toThrow();
    log.status = "ready_to_send"; // Simulate an older operator/UI reopening state.
    expect(await h.send(log)).toMatchObject({ status: "skipped" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.state.kommoConversionDedupe[0].senderAttempts).toBe(1);
  });

  it.each(["production", "replay"] as const)(
    "validates origin binding in %s and preserves an earlier instance on an unbound update",
    async (mode) => {
      const h = fixture();
      await h.materialize(mode);
      const saved = h.state.lead[0];
      const id = saved.id;
      h.event.channel.whatsappInstanceId = null;
      h.item.status = "queued";
      await h.materialize(mode);
      expect(h.state.lead[0]).toMatchObject({
        id,
        whatsappInstanceId: "instance-a",
      });
      h.event.channel.whatsappInstanceId = "instance-a";
      h.event.channel.whatsappInstance.workspaceId = "workspace-b";
      h.item.status = "queued";
      await expect(h.materialize(mode)).rejects.toThrow();
      expect(h.state.lead[0]).toEqual(saved);
      expect(h.state.conversionEventLog).toHaveLength(1);
    },
  );
  it.each([
    "expired",
    "foreign",
    "inactive_account",
    "inactive_destination_binding",
    "invalid_dedicated",
  ])(
    "rejects %s credentials/assets without a global token fallback",
    async (kind) => {
      const h = fixture();
      const log = await h.materialize();
      if (kind === "expired") h.credential.expiresAt = new Date(0);
      if (kind === "foreign") h.credential.workspaceId = "workspace-b";
      if (kind === "inactive_account") h.reporting.active = false;
      if (kind === "inactive_destination_binding")
        h.state.metaReportingAccountDestination.push({
          workspaceId: "workspace-a",
          reportingAccountId: h.reporting.id,
          conversionDestinationId: h.destination.id,
          active: false,
        });
      if (kind === "invalid_dedicated")
        h.legacy.capiTokenTag = Buffer.alloc(16, 0).toString("base64");
      expect(await h.send(log)).toMatchObject({ status: "not_configured" });
      expect(h.fetcher).not.toHaveBeenCalled();
    },
  );

  it("uses the active OAuth credential when no dedicated CAPI token exists", async () => {
    const h = fixture();
    h.legacy.capiAccessTokenEncrypted = null as any;
    const log = await h.materialize();
    expect(await h.send(log)).toMatchObject({ status: "sent" });
    expect(
      new URL(String(h.fetcher.mock.calls[0][0])).searchParams.get(
        "access_token",
      ),
    ).toBe("graph-only-token");
  });

  it("keeps existing ambiguous consumed attempts behind the operator gate after configuration repair", async () => {
    const h = fixture("manual");
    await h.materialize();
    const log = await h.stage();
    Object.assign(h.state.kommoConversionDedupe[0], {
      senderAttempts: 1,
      senderLeaseToken: null,
    });
    Object.assign(log, {
      status: "not_configured",
      errorCode: "MissingMetaDestination",
    });
    await h.retry(log);
    expect(await h.send(log)).toMatchObject({ status: "skipped" });
    expect(
      await h.conversions.prepareKommoSenderRetry(log.id, "workspace-a"),
    ).toBe("delivery_unknown");
    expect(h.state.kommoConversionDedupe[0].senderAttempts).toBe(1);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it.each(["production", "replay"] as const)(
    "never invents an instance on an unbound %s origin",
    async (mode) => {
      const h = fixture();
      h.event.channel.whatsappInstanceId = null;
      h.event.channel.whatsappInstance = null;
      await h.materialize(mode);
      expect(h.state.lead[0].whatsappInstanceId).toBeNull();
      const webhook = await h.receive();
      // Same refusal code as the SaaS (Fase 4c): an ad lead whose destination
      // is known but with no bound route of its number is "route unauthorized".
      expect(await h.kommo.process(webhook.id, "workspace-a")).toMatchObject({
        status: "blocked",
        errorCode: "lead_channel_route_unauthorized",
      });
      expect(h.state.conversionEventLog).toHaveLength(1);
      expect(h.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(["production", "replay"] as const)(
    "rejects a changed origin in %s before any lead write",
    async (mode) => {
      const h = fixture();
      h.event.channel.connectionId = "another-origin";
      await expect(h.materialize(mode)).rejects.toThrow();
      expect(h.state.lead).toHaveLength(0);
      expect(h.state.conversionEventLog).toHaveLength(0);
      expect(h.fetcher).not.toHaveBeenCalled();
    },
  );
});
