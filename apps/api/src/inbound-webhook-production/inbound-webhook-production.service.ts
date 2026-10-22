import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
// rastrackdash sanitize (rewrite_rules.external-channel-billing-access-stub):
// billing/ is stripped in this edition; ExternalChannelBillingAccessService
// was a REQUIRED (non-@Optional) constructor dependency here, so removing
// just the import isn't enough — this local always-allow stand-in matches
// ExternalChannelBillingAccessService.isEnforced() === false once
// PackageBillingConfiguration is gone, and keeps
// ExternalChannelBillingAccessError as a real class so the existing
// instanceof error-code narrowing below still compiles (it is now
// unreachable, since assertProductionAccess() never throws).
class ExternalChannelBillingAccessError extends Error {
  constructor(readonly code: string) {
    super("External WhatsApp channel billing access denied");
    this.name = "ExternalChannelBillingAccessError";
  }
}
class ExternalChannelBillingAccessStub {
  async assertProductionAccess(
    _workspaceId: string,
    _channelId: string,
  ): Promise<void> {
    // no-op: external-channel billing enforcement is always disabled once
    // billing/ is removed.
  }
}
import {
  hashPhoneIdentity,
  normalizePhoneIdentity,
} from "../common/phone/phone-identity";
import { PrismaService } from "../common/prisma/prisma.service";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import type { InboundWebhookProductionJobPayload } from "../common/queue/queue.constants";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import { ConversionEventsService } from "../conversion-events/conversion-events.service";
import { InboundWebhookPayloadEncryptionService } from "../inbound-webhooks/inbound-webhook-payload-encryption.service";
import { inboundMetaRouteMatches } from "../inbound-webhooks/inbound-webhook-meta-route-eligibility";
import { InboundWebhookMetaRouteReaderService } from "../inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { inboundWebhookParserContext } from "../inbound-webhooks/providers/inbound-webhook-parser";
import type {
  InboundWebhookParserResult,
  ParsedInboundWebhookEvent,
} from "../inbound-webhooks/providers/inbound-webhook-parser";
import {
  ctwaMaterializationFailureSuffix,
  entryRouteAuthorized,
  materializeCtwaEntry,
} from "./ctwa-entry-materialization";
import {
  isCtwaDestinationEntry,
  isCtwaDestinationReason,
} from "../inbound-webhooks/authorized-ctwa-destination";
import { refreshStaleCtwaAdHint } from "../inbound-webhooks/inbound-webhook-channel-routes.service";
import {
  parseOriginalUnnichatOccurrence,
  UnnichatOriginalBindMismatchError,
} from "../inbound-webhooks/unnichat-original-bind";
import { lockUnnichatMetaPolicy } from "../inbound-webhooks/inbound-webhook-effective-meta-routing";
import { InboundWebhookParserRegistry } from "../inbound-webhooks/providers/inbound-webhook-parser.registry";
import { LeadsService } from "../leads/leads.service";
import { assertMetaCloudSigningConfigured, inboundParserProductionEligible } from "../inbound-webhooks/inbound-webhook-parser-eligibility";

const terminalStatuses = new Set(["materialized", "duplicate"]);
const productionItemInclude = {
  event: {
    include: {
      delivery: true,
      connection: {
        include: {
          parserRelease: true,
        },
      },
      channel: {
        include: {
          whatsappInstance: true,
          routes: {
            where: {
              active: true,
              validationStatus: "valid",
            },
          },
        },
      },
      resolvedBusinessConnection: {
        include: {
          credential: true,
        },
      },
      resolvedReportingAccount: true,
      resolvedConversionDestination: true,
    },
  },
} satisfies Prisma.InboundWebhookProductionItemInclude;

type ProductionItemRecord = Prisma.InboundWebhookProductionItemGetPayload<{
  include: typeof productionItemInclude;
}>;

class ProductionItemFailure extends Error {
  constructor(readonly code: string) {
    super("Inbound webhook production item failed");
    this.name = "ProductionItemFailure";
  }
}

@Injectable()
export class InboundWebhookProductionService {
  private readonly billingAccess = new ExternalChannelBillingAccessStub();

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(InboundWebhookPayloadEncryptionService)
    private readonly payloadEncryption: InboundWebhookPayloadEncryptionService,
    @Inject(InboundWebhookParserRegistry)
    private readonly parserRegistry: InboundWebhookParserRegistry,
    @Inject(LeadsService)
    private readonly leads: LeadsService,
    @Inject(ConversionEventsService)
    private readonly conversions: ConversionEventsService,
    @Inject(ConversionEventsQueueService)
    private readonly conversionQueue: ConversionEventsQueueService,
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
  ) {}

  async processItem(
    input: Readonly<InboundWebhookProductionJobPayload>,
  ): Promise<{ status: "materialized" | "duplicate" | "unchanged" }> {
    this.assertJobPayload(input);

    if (!this.productionEnabled()) {
      throw new ProductionItemFailure("inbound_webhook_production_disabled");
    }

    const item = await this.prisma.inboundWebhookProductionItem.findFirst({
      where: {
        id: input.productionItemId,
        workspaceId: input.workspaceId,
      },
      include: productionItemInclude,
    });

    if (!item) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_item_not_found",
      );
    }

    if (terminalStatuses.has(item.status)) {
      return { status: "unchanged" };
    }

    if (item.event.provider === "unnichat") {
      return this.processUnnichatItem(item);
    }

    await this.prisma.inboundWebhookProductionItem.update({
      where: { id: item.id },
      data: {
        status: "processing",
        errorCode: null,
        attemptCount: { increment: 1 },
        lastAttemptedAt: new Date(),
      },
    });

    try {
      const result = await this.materialize(item);
      const status = result.duplicate ? "duplicate" : "materialized";

      await this.prisma.inboundWebhookProductionItem.update({
        where: { id: item.id },
        data: {
          status,
          leadId: result.leadId,
          conversionEventLogId: result.conversionEventLogId,
          errorCode: null,
          processedAt: new Date(),
        },
      });

      return { status };
    } catch (error) {
      const code = this.productionErrorCode(error);

      await this.prisma.inboundWebhookProductionItem.update({
        where: { id: item.id },
        data: {
          status: "failed",
          errorCode: code,
          processedAt: new Date(),
        },
      });

      throw new ProductionItemFailure(code);
    }
  }

  /**
   * Fase 4b (Unnichat, as in the SaaS): the item is claimed with a guarded
   * update, materialized under the Meta policy locks in one transaction, and
   * handed to the send queue only after commit, re-checking the route under
   * fresh locks. A CTWA entry without ad id is materialized only through the
   * number's unique authorized page/pixel destination; ctwa_clid is always
   * required (no ctwa_clid, nothing is sent).
   */
  private async processUnnichatItem(
    item: ProductionItemRecord,
  ): Promise<{ status: "materialized" | "duplicate" | "unchanged" }> {
    const claimed = await this.prisma.inboundWebhookProductionItem.updateMany({
      where: {
        id: item.id,
        workspaceId: item.event.workspaceId,
        status: { notIn: ["materialized", "duplicate"] },
      },
      data: {
        status: "processing",
        errorCode: null,
        attemptCount: { increment: 1 },
        lastAttemptedAt: new Date(),
      },
    });
    if (claimed.count !== 1) return { status: "unchanged" };

    try {
      const result = await this.materializeUnnichat(item);
      return { status: result.duplicate ? "duplicate" : "materialized" };
    } catch (error) {
      const code = this.productionErrorCode(error);

      await this.prisma.inboundWebhookProductionItem.updateMany({
        where: {
          id: item.id,
          workspaceId: item.event.workspaceId,
          status: { notIn: ["materialized", "duplicate"] },
        },
        data: {
          status: "failed",
          errorCode: code,
          processedAt: new Date(),
        },
      });

      throw new ProductionItemFailure(code);
    }
  }

  private async materializeUnnichat(item: ProductionItemRecord): Promise<{
    leadId: string;
    conversionEventLogId: string;
    duplicate: boolean;
  }> {
    const result = await this.prisma.$transaction(async (tx) => {
      await lockUnnichatMetaPolicy(
        tx,
        item.event.workspaceId,
        item.event.adId ? [item.event.adId] : [],
      );
      await tx.$queryRaw`SELECT "id" FROM "InboundWebhookProductionItem" WHERE "id" = ${item.id} AND "workspaceId" = ${item.event.workspaceId} FOR UPDATE`;
      const load = () =>
        tx.inboundWebhookProductionItem.findFirst({
          where: { id: item.id, workspaceId: item.event.workspaceId },
          include: productionItemInclude,
        });
      let fresh = await load();
      if (!fresh)
        throw new ProductionItemFailure(
          "inbound_webhook_production_item_not_found",
        );
      // Ad became known after the ad-hint decision: same item (same Meta
      // event ID), canonical path, in this same attempt.
      if (
        !terminalStatuses.has(fresh.status) &&
        (await refreshStaleCtwaAdHint(tx, fresh.event))
      )
        fresh = await load();
      if (!fresh)
        throw new ProductionItemFailure(
          "inbound_webhook_production_item_not_found",
        );
      if (
        terminalStatuses.has(fresh.status) &&
        fresh.leadId &&
        fresh.conversionEventLogId
      ) {
        return {
          leadId: fresh.leadId,
          conversionEventLogId: fresh.conversionEventLogId,
          duplicate: true,
          queueReady: false,
        };
      }
      const effect = await this.materializeWithClient(fresh, tx);
      await tx.inboundWebhookProductionItem.update({
        where: { id: fresh.id },
        data: {
          status: effect.duplicate ? "duplicate" : "materialized",
          leadId: effect.leadId,
          conversionEventLogId: effect.conversionEventLogId,
          processedAt: new Date(),
          errorCode: null,
        },
      });
      return effect;
    });
    if (result.queueReady) {
      // Commit the canonical effect first. Reacquire the policy locks before
      // handing off to Redis; revocation cannot use the earlier decision.
      try {
        await this.prisma.$transaction(async (tx) => {
          await lockUnnichatMetaPolicy(
            tx,
            item.event.workspaceId,
            item.event.adId ? [item.event.adId] : [],
          );
          const fresh = await tx.inboundWebhookProductionItem.findFirst({
            where: { id: item.id, workspaceId: item.event.workspaceId },
            include: productionItemInclude,
          });
          if (
            !fresh ||
            fresh.event.connection.removedAt ||
            !inboundParserProductionEligible(
              fresh.event.connection.parserRelease,
              this.parserRegistry,
            ) ||
            fresh.event.connection.parserRelease.version !==
              fresh.event.delivery.parserVersion ||
            fresh.event.connection.status !== "production" ||
            fresh.event.channel.status !== "active" ||
            !fresh.event.connection.productionActivatedAt ||
            !fresh.event.channel.productionActivatedAt ||
            fresh.event.delivery.firstReceivedAt <
              fresh.event.connection.productionActivatedAt ||
            fresh.event.delivery.firstReceivedAt <
              fresh.event.channel.productionActivatedAt ||
            !(await entryRouteAuthorized(tx, fresh.event))
          ) {
            await tx.inboundWebhookProductionItem.update({
              where: { id: item.id },
              data: {
                errorCode: "inbound_webhook_production_handoff_route_revoked",
              },
            });
            return;
          }
          await this.billingAccess.assertProductionAccess(
            item.event.workspaceId,
            fresh.event.channelId,
          );
          await this.conversionQueue.enqueueSend(
            result.conversionEventLogId,
            item.event.workspaceId,
          );
        });
      } catch {
        // The committed receipt remains materialized. A queue failure must not
        // turn it into an apparently unprocessed historical event.
        await this.prisma.inboundWebhookProductionItem.update({
          where: { id: item.id },
          data: { errorCode: "inbound_webhook_production_handoff_failed" },
        });
      }
    }
    return result;
  }

  private async materializeWithClient(
    item: ProductionItemRecord,
    client: Prisma.TransactionClient,
  ): Promise<{
    leadId: string;
    conversionEventLogId: string;
    duplicate: boolean;
    queueReady: boolean;
  }> {
    const event = item.event;
    const connection = event.connection;
    const delivery = event.delivery;
    const channel = event.channel;
    const business = event.resolvedBusinessConnection;
    const reporting = event.resolvedReportingAccount;
    const destination = event.resolvedConversionDestination;
    if (
      item.workspaceId !== event.workspaceId ||
      connection.workspaceId !== event.workspaceId ||
      event.connectionId !== connection.id ||
      event.channelId !== channel.id ||
      connection.provider !== "unnichat" ||
      event.provider !== "unnichat" ||
      delivery.provider !== event.provider ||
      delivery.workspaceId !== event.workspaceId ||
      delivery.connectionId !== connection.id ||
      channel.workspaceId !== event.workspaceId ||
      channel.connectionId !== connection.id ||
      channel.whatsappInstanceId
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_context_changed",
      );
    }
    const routeStillActive = await entryRouteAuthorized(client, event);
    const ctwaEntry = isCtwaDestinationEntry(event);
    const now = new Date();

    if (
      event.classification !== "eligible_route_resolved" ||
      !event.hasCtwa ||
      (!ctwaEntry &&
        (!event.adId || isCtwaDestinationReason(event.classificationReason)))
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_event_ineligible",
      );
    }

    if (
      connection.removedAt ||
      connection.status !== "production" ||
      !connection.productionActivatedAt ||
      connection.parserRelease.provider !== connection.provider ||
      !inboundParserProductionEligible(
        connection.parserRelease,
        this.parserRegistry,
      ) ||
      connection.parserRelease.version !== delivery.parserVersion ||
      channel.status !== "active" ||
      !channel.productionActivatedAt ||
      delivery.firstReceivedAt < connection.productionActivatedAt ||
      delivery.firstReceivedAt < channel.productionActivatedAt
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_context_changed",
      );
    }

    if (ctwaEntry) {
      if (!routeStillActive)
        throw new ProductionItemFailure(
          "inbound_webhook_production_route_invalid",
        );
      if (!this.payloadAvailable(delivery, now))
        throw new ProductionItemFailure(
          "inbound_webhook_production_payload_unavailable",
        );
      await this.billingAccess.assertProductionAccess(
        event.workspaceId,
        event.channelId,
      );
      return materializeCtwaEntry(
        client,
        event,
        this.reparseEvent(item),
        this.leads,
        this.conversions,
        this.metaEventId(event.provider, connection.id, event.dedupeKey),
        "live_production",
      );
    }

    if (
      !business ||
      business.workspaceId !== event.workspaceId ||
      business.credential.workspaceId !== event.workspaceId ||
      business.status !== "active" ||
      business.credential.status !== "active" ||
      !reporting ||
      reporting.workspaceId !== event.workspaceId ||
      !reporting.active ||
      reporting.businessConnectionId !== business.id ||
      !destination ||
      destination.workspaceId !== event.workspaceId ||
      destination.status !== "configured" ||
      !routeStillActive
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_route_invalid",
      );
    }

    if (!this.payloadAvailable(delivery, now)) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_payload_unavailable",
      );
    }

    await this.billingAccess.assertProductionAccess(
      event.workspaceId,
      event.channelId,
    );

    const parsedEvent = this.reparseEvent(item);
    const phone = normalizePhoneIdentity(parsedEvent.contact.phoneNumber);
    const phoneHash = hashPhoneIdentity(parsedEvent.contact.phoneNumber);

    if (
      !phone ||
      !phoneHash ||
      !parsedEvent.ctwaClid ||
      !parsedEvent.adId ||
      !event.adId ||
      parsedEvent.adId !== event.adId
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_identity_invalid",
      );
    }

    const ad = await client.metaAd.findFirst({
      where: {
        workspaceId: event.workspaceId,
        adId: event.adId,
      },
      select: {
        campaignId: true,
        adSetId: true,
        adAccountId: true,
      },
    });

    if (!ad || ad.adAccountId !== reporting.adAccountId) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_route_invalid",
      );
    }

    const lead = await this.leads.upsertFromWhatsappWebhook(
      {
        workspaceId: event.workspaceId,
        name: parsedEvent.contact.name ?? undefined,
        // Provider-supplied name only fills an empty lead name.
        preserveExistingName: true,
        phone,
        source: event.provider,
        preserveExistingSource: true,
        preserveEarliestFirstMessageAt: true,
        campaignId: ad.campaignId ?? undefined,
        adSetId: ad.adSetId ?? undefined,
        adId: event.adId,
        ctwaClid: parsedEvent.ctwaClid,
        ctwaSourceUrl: parsedEvent.ad?.sourceUrl ?? undefined,
        ctwaThumbnailUrl: parsedEvent.ad?.thumbnailUrl ?? undefined,
        occurredAt: event.occurredAt,
        firstMessageAt: event.occurredAt,
        lastMessageAt: event.occurredAt,
      },
      client,
    );

    if (!lead) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_lead_invalid",
      );
    }

    const conversion = await this.conversions.recordExternalConversion(
      {
        workspaceId: event.workspaceId,
        externalConnectorId: null,
        sourceEventId: event.externalMessageId ?? event.id,
        sourceTrigger: `inbound_webhook:${event.provider}`,
        eventName: "LeadSubmitted",
        eventId: this.metaEventId(
          event.provider,
          connection.id,
          event.dedupeKey,
        ),
        dedupeKey: `inbound-webhook:${connection.id}:${event.dedupeKey}`,
        leadId: lead.id,
        phoneHash,
        businessSource: "paid",
        metaAccountId: reporting.adAccountId,
        metaBusinessConnectionId: business.id,
        metaConversionDestinationId: destination.id,
        campaignId: ad.campaignId ?? null,
        adSetId: ad.adSetId ?? null,
        adId: event.adId,
        ctwaClid: parsedEvent.ctwaClid,
        eventOccurredAt: event.occurredAt,
        sourcePayload: {
          provider: event.provider,
          connectionId: connection.id,
          inboundEventId: event.id,
          channelId: event.channelId,
          classification: event.classification,
          hasCtwa: true,
          adId: event.adId,
          processingMode: "live_production",
        },
      },
      client,
    );

    return {
      leadId: lead.id,
      conversionEventLogId: conversion.conversionEventLogId,
      duplicate: conversion.status === "duplicate",
      queueReady: conversion.deliveryStatus === "ready_to_send",
    };
  }

  private async materialize(item: ProductionItemRecord): Promise<{
    leadId: string;
    conversionEventLogId: string;
    duplicate: boolean;
  }> {
    if (item.event.provider === "unnichat") return this.materializeUnnichat(item);
    const event = item.event;
    const connection = event.connection;
    const delivery = event.delivery;
    const channel = event.channel;
    const business = event.resolvedBusinessConnection;
    const reporting = event.resolvedReportingAccount;
    const destination = event.resolvedConversionDestination;
    const resolved = {
      businessConnectionId: event.resolvedBusinessConnectionId,
      reportingAccountId: event.resolvedReportingAccountId,
      conversionDestinationId: event.resolvedConversionDestinationId,
    };
    const routeStillActive =
      channel.routes.filter(
        (route) =>
          route.workspaceId === event.workspaceId &&
          route.active &&
          route.validationStatus === "valid" &&
          inboundMetaRouteMatches(route, resolved),
      ).length === 1;
    // Only the instance bound to this tenant-owned inbound origin is trusted.
    const channelInstance = event.channel.whatsappInstance;
    if (
      item.workspaceId !== event.workspaceId ||
      connection.workspaceId !== event.workspaceId ||
      event.connectionId !== connection.id ||
      event.channelId !== event.channel.id ||
      connection.provider !== event.provider ||
      delivery.provider !== event.provider ||
      delivery.workspaceId !== event.workspaceId ||
      delivery.connectionId !== connection.id ||
      event.channel.workspaceId !== event.workspaceId ||
      event.channel.connectionId !== connection.id ||
      (event.channel.whatsappInstanceId &&
        (!channelInstance ||
          channelInstance.id !== event.channel.whatsappInstanceId ||
          channelInstance.workspaceId !== event.workspaceId ||
          channelInstance.status !== "active"))
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_context_changed",
      );
    }
    assertMetaCloudSigningConfigured(connection.provider, this.env);
    const now = new Date();

    if (
      event.classification !== "eligible_route_resolved" ||
      !event.hasCtwa ||
      !event.adId
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_event_ineligible",
      );
    }

    if (
      connection.removedAt ||
      connection.status !== "production" ||
      !connection.productionActivatedAt ||
      connection.parserRelease.provider !== connection.provider ||
      !inboundParserProductionEligible(connection.parserRelease, this.parserRegistry) ||
      connection.parserRelease.version !== delivery.parserVersion ||
      channel.status !== "active" ||
      !channel.productionActivatedAt ||
      delivery.firstReceivedAt < connection.productionActivatedAt ||
      delivery.firstReceivedAt < channel.productionActivatedAt
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_context_changed",
      );
    }

    if (
      !business ||
      business.workspaceId !== event.workspaceId ||
      business.credential.workspaceId !== event.workspaceId ||
      business.status !== "active" ||
      business.credential.status !== "active" ||
      !reporting ||
      reporting.workspaceId !== event.workspaceId ||
      !reporting.active ||
      reporting.businessConnectionId !== business.id ||
      !destination ||
      destination.workspaceId !== event.workspaceId ||
      destination.status !== "configured" ||
      !routeStillActive
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_route_invalid",
      );
    }

    if (!this.payloadAvailable(delivery, now)) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_payload_unavailable",
      );
    }

    await this.billingAccess.assertProductionAccess(
      event.workspaceId,
      event.channelId,
    );

    const parsedEvent = this.reparseEvent(item);
    const phone = normalizePhoneIdentity(parsedEvent.contact.phoneNumber);
    const phoneHash = hashPhoneIdentity(parsedEvent.contact.phoneNumber);

    if (!phone || !phoneHash || !parsedEvent.ctwaClid || !parsedEvent.adId) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_identity_invalid",
      );
    }

    const ad = await this.prisma.metaAd.findFirst({
      where: {
        workspaceId: event.workspaceId,
        adId: event.adId,
      },
      select: {
        campaignId: true,
        adSetId: true,
        adAccountId: true,
      },
    });

    if (!ad || ad.adAccountId !== reporting.adAccountId) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_route_invalid",
      );
    }

    const currentRoute = await new InboundWebhookMetaRouteReaderService(
      this.prisma,
    ).previewRoute({
      workspaceId: event.workspaceId,
      adId: event.adId,
      ...resolved,
    });
    if (
      currentRoute.status !== "resolved" ||
      currentRoute.reportingAccountId !== reporting.id ||
      currentRoute.businessConnectionId !== business.id ||
      currentRoute.conversionDestinationId !== destination.id
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_route_invalid",
      );
    }

    const lead = await this.leads.upsertFromWhatsappWebhook({
      workspaceId: event.workspaceId,
      whatsappInstanceId: event.channel.whatsappInstanceId ?? undefined,
      name: parsedEvent.contact.name ?? undefined,
      phone,
      source: event.provider,
      preserveExistingSource: true,
      preserveEarliestFirstMessageAt: true,
      campaignId: ad.campaignId ?? undefined,
      adSetId: ad.adSetId ?? undefined,
      adId: event.adId,
      ctwaClid: parsedEvent.ctwaClid,
      ctwaSourceUrl: parsedEvent.ad?.sourceUrl ?? undefined,
      ctwaThumbnailUrl: parsedEvent.ad?.thumbnailUrl ?? undefined,
      occurredAt: event.occurredAt,
      firstMessageAt: event.occurredAt,
      lastMessageAt: event.occurredAt,
    });

    if (!lead) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_lead_invalid",
      );
    }

    const conversion = await this.conversions.recordExternalConversion({
      workspaceId: event.workspaceId,
      externalConnectorId: null,
      sourceEventId: event.externalMessageId ?? event.id,
      sourceTrigger: `inbound_webhook:${event.provider}`,
      eventName: "LeadSubmitted",
      eventId: this.metaEventId(event.provider, connection.id, event.dedupeKey),
      dedupeKey: `inbound-webhook:${connection.id}:${event.dedupeKey}`,
      leadId: lead.id,
      phoneHash,
      businessSource: "paid",
      metaAccountId: reporting.adAccountId,
      metaBusinessConnectionId: business.id,
      metaConversionDestinationId: destination.id,
      campaignId: ad.campaignId ?? null,
      adSetId: ad.adSetId ?? null,
      adId: event.adId,
      ctwaClid: parsedEvent.ctwaClid,
      eventOccurredAt: event.occurredAt,
      sourcePayload: {
        provider: event.provider,
        connectionId: connection.id,
        inboundEventId: event.id,
        channelId: event.channelId,
        classification: event.classification,
        hasCtwa: true,
        adId: event.adId,
        processingMode: "live_production",
      },
    });

    if (conversion.deliveryStatus === "ready_to_send") {
      await this.conversionQueue.enqueueSend(
        conversion.conversionEventLogId,
        event.workspaceId,
      );
    }

    return {
      leadId: lead.id,
      conversionEventLogId: conversion.conversionEventLogId,
      duplicate: conversion.status === "duplicate",
    };
  }

  private reparseEvent(item: ProductionItemRecord): ParsedInboundWebhookEvent {
    const { delivery, connection } = item.event;
    let decrypted: Buffer;
    try {
      decrypted = this.payloadEncryption.decrypt(
        {
          encryptedPayload: delivery.encryptedPayload!,
          payloadIv: delivery.payloadIv!,
          payloadTag: delivery.payloadTag!,
          encryptionKeyVersion: delivery.encryptionKeyVersion!,
        },
        {
          workspaceId: delivery.workspaceId,
          connectionId: delivery.connectionId,
          deliveryId: delivery.id,
        },
      );
    } catch {
      // Typed code (as in the SaaS) instead of a generic _unexpected.
      throw new ProductionItemFailure(
        "inbound_webhook_production_payload_decrypt_failed",
      );
    }
    let payload: unknown;

    try {
      payload = JSON.parse(decrypted.toString("utf8"));
    } catch {
      throw new ProductionItemFailure(
        "inbound_webhook_production_payload_invalid",
      );
    }

    const parser = this.parserRegistry.resolve({
      provider: connection.provider,
      parserVersion: connection.parserRelease.version,
      parserReleaseStatus: connection.parserRelease.status,
    });
    if (connection.provider === "unnichat") {
      return this.reparseUnnichatEvent(item, (context) =>
        parser.parse(payload, context),
      );
    }
    const result = parser.parse(
      payload,
      inboundWebhookParserContext(delivery.workspaceId),
    );
    const parsedEvent = result.events.find(
      (candidate) => candidate.dedupeKey === item.event.dedupeKey,
    );

    if (
      result.error ||
      !parsedEvent ||
      parsedEvent.provider !== item.event.provider ||
      parsedEvent.externalMessageId !== item.event.externalMessageId ||
      parsedEvent.adId !== item.event.adId ||
      parsedEvent.organizationId !== item.event.channel.organizationId ||
      parsedEvent.channel.providerChannelId !==
        item.event.channel.providerChannelId
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_event_mismatch",
      );
    }

    return parsedEvent;
  }

  /** Unnichat: the immutable connection bind (org + bound number) and the
   * retained summary prove the occurrence; the stored dedupe key and the
   * occurrence time are kept (the provider sends no timestamp). An entry
   * decided without ad id is never re-routed by an ad id the payload
   * re-parses today. */
  private reparseUnnichatEvent(
    item: ProductionItemRecord,
    parse: Parameters<typeof parseOriginalUnnichatOccurrence>[1],
  ): ParsedInboundWebhookEvent {
    let result: InboundWebhookParserResult;
    let parsedEvent: ParsedInboundWebhookEvent | undefined;
    try {
      ({ result, occurrence: parsedEvent } = parseOriginalUnnichatOccurrence(
        item.event,
        parse,
      ));
    } catch (error) {
      if (error instanceof UnnichatOriginalBindMismatchError) {
        throw new ProductionItemFailure(
          "inbound_webhook_production_unnichat_bind_mismatch",
        );
      }
      throw error;
    }
    if (
      result.error ||
      !parsedEvent ||
      parsedEvent.provider !== item.event.provider ||
      parsedEvent.externalMessageId !== item.event.externalMessageId
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_event_mismatch",
      );
    }
    return {
      ...parsedEvent,
      dedupeKey: item.event.dedupeKey,
      occurredAt: item.event.occurredAt,
    };
  }

  private payloadAvailable(
    delivery: {
      payloadExpiresAt: Date;
      encryptedPayload: string | null;
      payloadIv: string | null;
      payloadTag: string | null;
      encryptionKeyVersion: number | null;
    },
    now: Date,
  ): boolean {
    return Boolean(
      delivery.payloadExpiresAt.getTime() > now.getTime() &&
      delivery.encryptedPayload &&
      delivery.payloadIv &&
      delivery.payloadTag &&
      delivery.encryptionKeyVersion,
    );
  }

  private productionEnabled(): boolean {
    const config = parseInboundWebhooksConfig(this.env);

    return config.enabled && config.productionEnabled;
  }

  private assertJobPayload(
    input: Readonly<InboundWebhookProductionJobPayload>,
  ): void {
    if (
      !input ||
      !this.identifier(input.productionItemId) ||
      !this.identifier(input.workspaceId)
    ) {
      throw new ProductionItemFailure(
        "inbound_webhook_production_context_invalid",
      );
    }
  }

  private identifier(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 255 &&
      !value.includes("\0")
    );
  }

  private productionErrorCode(error: unknown): string {
    if (
      (error instanceof ProductionItemFailure ||
        error instanceof ExternalChannelBillingAccessError) &&
      /^[a-z0-9_]{1,120}$/u.test(error.code)
    ) {
      return error.code;
    }
    if (error instanceof UnnichatOriginalBindMismatchError) {
      return "inbound_webhook_production_unnichat_bind_mismatch";
    }
    const suffix = ctwaMaterializationFailureSuffix(error);
    if (suffix) return `inbound_webhook_production_${suffix}`;

    return "inbound_webhook_production_unexpected";
  }

  private metaEventId(
    provider: string,
    connectionId: string,
    dedupeKey: string,
  ): string {
    const digest = createHash("sha256")
      .update(`${connectionId}\0${dedupeKey}`, "utf8")
      .digest("hex");

    return `${provider}_lead_${digest}`;
  }
}
