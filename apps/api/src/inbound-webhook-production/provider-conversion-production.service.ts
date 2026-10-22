import { inboundParserProductionEligible } from "../inbound-webhooks/inbound-webhook-parser-eligibility";
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import {
  CTWA_DESTINATION_PROVIDER,
  ctwaIntentAuthorized,
  type AuthorizedCtwaDestination,
} from "../inbound-webhooks/authorized-ctwa-destination";
import {
  effectiveUnnichatMetaRouting,
  lockUnnichatMetaPolicy,
} from "../inbound-webhooks/inbound-webhook-effective-meta-routing";
import { resolveCtwaLeadProof } from "../conversion-rules/ctwa-lead-proof";
import { CTWA_SEND_SKIPPED_ERROR_CODE } from "../conversion-events/conversion-event-retry";
import { createHash } from "node:crypto";
import { resolvePurchaseChannels } from "../conversion-rules/provider-purchase-routing";
import { buildProviderPurchaseIdentity } from "../conversion-rules/provider-purchase-identity";
import {
  parsePaytSaleEventV1,
  PAYT_SALE_EVENT_NAMES,
  PAYT_VALUE_CORRECTION_REASON,
  paytLegacyTotalPriceCents,
  paytProductFilterMatches,
} from "../inbound-webhooks/providers/payt/payt-automation-v1.parser";
import { Prisma } from "@prisma/client";
import {
  conversionEventCarriesValue,
  conversionEventDedupeMode,
  conversionEventMetaEventIdPrefix,
  authorizedCtwaDestinationSchema,
  conversionEventNameSchema,
  conversionEventRequiresValue,
  normalizeCurrencyCode,
  providerConversionDecisionSchema,
  type ConversionEventNameDto,
  type ProviderConversionDecisionDto,
  type ProviderConversionTechnicalDeliveryStateDto,
  type StructuredCatalogTestMessageResultDto,
} from "@wpptrack/shared";
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
  hashPhoneIdentityVariants,
} from "../common/phone/phone-identity";
import { PrismaService } from "../common/prisma/prisma.service";
import { loadWorkspaceConversionCurrency } from "../currency/workspace-currency";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import type { ProviderConversionProductionJobPayload } from "../common/queue/queue.constants";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import { ConversionCatalogService } from "../conversion-rules/conversion-catalog.service";
import {
  matchProviderMessageTrigger,
  providerMessageAuthorAllowed,
} from "../conversion-rules/structured-catalog-message.parser";
import { ConversionEventsService } from "../conversion-events/conversion-events.service";
import { InboundWebhookMetaRouteReaderService } from "../inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { InboundWebhookPayloadEncryptionService } from "../inbound-webhooks/inbound-webhook-payload-encryption.service";
import {
  providerRuleCoversChannel,
  resolveProviderRuleScopeChannelIds,
} from "../conversion-rules/provider-rule-scope";
import { inboundWebhookParserContext } from "../inbound-webhooks/providers/inbound-webhook-parser";
import type { ParsedInboundWebhookEvent } from "../inbound-webhooks/providers/inbound-webhook-parser";
import { InboundWebhookParserRegistry } from "../inbound-webhooks/providers/inbound-webhook-parser.registry";
import {
  parseUmblerAutomationV1,
  type ParsedUmblerAutomationV1,
  UMBLER_AUTOMATION_V1_PARSER_VERSION,
} from "../inbound-webhooks/providers/umbler/umbler-automation-v1.parser";
import {
  parseUnnichatAutomationV1,
  type ParsedUnnichatAutomationV1,
  UNNICHAT_AUTOMATION_V1_PARSER_VERSION,
} from "../inbound-webhooks/providers/unnichat/unnichat-automation-v1.parser";

/** Automation callbacks re-parsed at production time (Umbler, Unnichat). */
type ParsedAutomationForProduction =
  | ParsedUmblerAutomationV1
  | (ParsedUnnichatAutomationV1 & {
      provider: "unnichat";
      automation: "crm_movement";
      eventName: ConversionEventNameDto;
    });

const PURCHASE_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const terminalStatuses = new Set(["materialized", "duplicate", "blocked"]);
const executionInclude = {
  providerRule: {
    include: {
      conversionRule: true,
      parserRelease: true,
      connection: {
        include: {
          parserRelease: true,
        },
      },
      channels: true,
      catalog: {
        include: {
          variants: true,
        },
      },
    },
  },
  sourceDelivery: true,
  channel: { include: { connection: { select: { provider: true } } } },
  purchaseReview: {
    include: {
      items: { orderBy: { position: "asc" } },
    },
  },
  providerDecision: true,
} satisfies Prisma.ProviderConversionRuleExecutionInclude;

type ExecutionRecord = Prisma.ProviderConversionRuleExecutionGetPayload<{
  include: typeof executionInclude;
}>;

/**
 * The execution's channel is inside the rule scope: one of its chosen channels
 * ("specific_numbers", exactly the historical check) or a channel whose
 * provider supports the rule origin ("all_numbers", evaluated live).
 */
/**
 * Fase 5.3 (SaaS 73a9a56): Meta identity of an Unnichat automation
 * conversion, derived from the business fact (not the execution), so the
 * same callback evaluated by two rules (old per-rule URL + per-event URL
 * routed to another rule) becomes ONE conversion. Lifetime events
 * (QualifiedLead...): once per lead and click. Others (Purchase...): once per
 * callback occurrence. Events already sent keep their historical ids.
 */
export type AutomationIdentityInput = {
  workspaceId: string;
  eventName: string;
  dedupeMode: "lifetime" | "rolling_window";
  leadId: string;
  ctwaClid: string;
  occurrenceKey: string;
};

/** Providers whose automation conversions carry a business identity. */
export const AUTOMATION_IDENTITY_PROVIDERS = ["unnichat", "umbler"] as const;
export type AutomationIdentityProvider =
  (typeof AUTOMATION_IDENTITY_PROVIDERS)[number];

/**
 * Same identity for Umbler (Fase 5.3 review): its occurrence key also comes
 * only from the callback body (conversation + automation), so the same
 * callback through the old per-rule URL and the per-event URL, evaluated by
 * two rules, is one conversion.
 */
export function automationConversionIdentity(
  provider: AutomationIdentityProvider,
  input: AutomationIdentityInput,
): string {
  const namespace = `${provider}-automation-v1`;
  return createHash("sha256")
    .update(
      JSON.stringify(
        input.dedupeMode === "lifetime"
          ? [
              namespace,
              input.workspaceId,
              input.eventName,
              input.leadId,
              input.ctwaClid,
            ]
          : [namespace, input.workspaceId, input.eventName, input.occurrenceKey],
      ),
    )
    .digest("hex");
}

export function unnichatAutomationConversionIdentity(
  input: AutomationIdentityInput,
): string {
  return automationConversionIdentity("unnichat", input);
}

function executionChannelInRuleScope(execution: ExecutionRecord): boolean {
  if (!execution.channelId) return false;
  return providerRuleCoversChannel(execution.providerRule, {
    id: execution.channelId,
    connectionId: execution.channel?.connectionId ?? "",
    provider: execution.channel?.connection?.provider ?? "",
  });
}
type EligibleProviderConversionDecision = Extract<
  ProviderConversionDecisionDto,
  { decisionCode: "eligible" }
>;

export class ProviderConversionProductionFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super("Provider conversion production failed");
    this.name = "ProviderConversionProductionFailure";
  }
}

@Injectable()
export class ProviderConversionProductionService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly billingAccess = new ExternalChannelBillingAccessStub();
  private outboxTimer?: NodeJS.Timeout;
  private recoveringOutbox = false;

  private readonly logger = new Logger(
    ProviderConversionProductionService.name,
  );

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InboundWebhookPayloadEncryptionService)
    private readonly payloadEncryption: InboundWebhookPayloadEncryptionService,
    @Inject(InboundWebhookParserRegistry)
    private readonly parserRegistry: InboundWebhookParserRegistry,
    @Inject(ConversionCatalogService)
    private readonly catalogs: ConversionCatalogService,
    @Inject(InboundWebhookMetaRouteReaderService)
    private readonly routes: InboundWebhookMetaRouteReaderService,
    @Inject(ConversionEventsService)
    private readonly conversions: ConversionEventsService,
    @Inject(ConversionEventsQueueService)
    private readonly conversionQueue: ConversionEventsQueueService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv = process.env,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.productionEnabled()) return;
    this.outboxTimer = setInterval(() => {
      void this.recoverPurchaseOutbox().catch(() =>
        this.logger.error("provider_purchase_outbox_recovery_failed"),
      );
    }, 60_000);
    this.outboxTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.outboxTimer) clearInterval(this.outboxTimer);
  }

  /**
   * A sale claim commits its conversion with outboxPending when the send must
   * be queued; a crash between commit and enqueue is recovered here. Rows
   * exist only for providers with a sale identity (Payt, Fase 4a).
   */
  async recoverPurchaseOutbox(): Promise<number> {
    if (!this.productionEnabled() || this.recoveringOutbox) return 0;
    this.recoveringOutbox = true;
    let enqueued = 0;
    try {
      const claims = await this.prisma.providerPurchaseClaim.findMany({
        where: {
          effectMode: "production",
          outboxPending: true,
          conversionEventLogId: { not: null },
          OR: [
            { outboxNextAttemptAt: null },
            { outboxNextAttemptAt: { lte: new Date() } },
          ],
        },
        orderBy: [
          { outboxNextAttemptAt: { sort: "asc", nulls: "first" } },
          { createdAt: "asc" },
          { id: "asc" },
        ],
        take: 100,
      });
      for (const claim of claims) {
        // Rotate pending rows durably before attempting a queue call, so an old failed batch cannot starve later claims.
        try {
          await this.prisma.providerPurchaseClaim.updateMany({
            where: {
              id: claim.id,
              workspaceId: claim.workspaceId,
              outboxPending: true,
            },
            data: { outboxNextAttemptAt: new Date(Date.now() + 60_000) },
          });
          const log = await this.prisma.conversionEventLog.findFirst({
            where: {
              id: claim.conversionEventLogId!,
              workspaceId: claim.workspaceId,
            },
            select: { status: true, errorCode: true },
          });
          if (!log) continue;
          // A send refused by the final CTWA check keeps its reason on the log
          // and waits for the owner's retry instead of looping every minute.
          if (
            log.status === "ready_to_send" &&
            log.errorCode !== CTWA_SEND_SKIPPED_ERROR_CODE
          ) {
            await this.conversionQueue.enqueueSend(
              claim.conversionEventLogId!,
              claim.workspaceId,
            );
            enqueued++;
            continue;
          }
          await this.prisma.providerPurchaseClaim.updateMany({
            where: {
              id: claim.id,
              workspaceId: claim.workspaceId,
              effectMode: "production",
              outboxPending: true,
            },
            data: { outboxPending: false },
          });
        } catch {
          this.logger.warn("provider_purchase_outbox_enqueue_failed");
        }
      }
      return enqueued;
    } finally {
      this.recoveringOutbox = false;
    }
  }

  async processExecution(
    input: Readonly<ProviderConversionProductionJobPayload>,
  ): Promise<{ status: "materialized" | "duplicate" | "unchanged" }> {
    this.assertInput(input);
    if (!this.productionEnabled()) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_production_disabled",
      );
    }

    const execution = await this.loadExecution(input);
    if (!execution) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_execution_not_found",
      );
    }
    if (execution.status === "materialized") {
      await this.enqueueMaterialized(execution);
      return { status: "unchanged" };
    }
    if (terminalStatuses.has(execution.status)) {
      return { status: "unchanged" };
    }
    if (!["eligible", "failed"].includes(execution.status)) {
      return { status: "unchanged" };
    }
    if (
      execution.status === "failed" &&
      execution.providerDecision &&
      !this.retryableTechnicalFailure(execution.normalizedResult)
    ) {
      return { status: "unchanged" };
    }

    await this.prisma.providerConversionRuleExecution.update({
      where: { id: execution.id },
      data: {
        attemptCount: { increment: 1 },
        lastAttemptedAt: new Date(),
        reasonCode: null,
        ...(execution.providerDecision
          ? {
              normalizedResult: this.withTechnicalDelivery(
                execution.normalizedResult,
                {
                  state: "queued",
                  retryable: false,
                  reasonCode: null,
                },
              ),
            }
          : {}),
      },
    });

    try {
      const materialized = await this.materialize(execution);
      if (materialized.status === "duplicate") {
        return materialized;
      }

      if (materialized.queueRequired && materialized.ctwaHandoff) {
        // CTWA page/pixel conversion: re-verified before it is queued.
        await this.enqueueMaterialized({
          ...execution,
          conversionEventLogId: materialized.conversionEventLogId,
        });
      } else if (materialized.queueRequired) {
        await this.conversionQueue.enqueueSend(
          materialized.conversionEventLogId,
          execution.workspaceId,
        );
      }
      return { status: "materialized" };
    } catch (error) {
      const code = this.errorCode(error);
      const failure = this.failureSummary(error, code);
      const disposition = this.failureDisposition(code);
      await this.prisma.providerConversionRuleExecution.updateMany({
        where: {
          id: execution.id,
          workspaceId: execution.workspaceId,
          status: { in: ["eligible", "failed"] },
        },
        data: {
          status: disposition.executionStatus,
          reasonCode: code,
          processedAt: new Date(),
          normalizedResult: this.withProductionFailure(
            execution.normalizedResult,
            failure,
            disposition,
          ),
        },
      });
      await this.prisma.purchaseReview.updateMany({
        where: {
          providerExecutionId: execution.id,
          workspaceId: execution.workspaceId,
          status: { in: ["recognized", "approved", "failed"] },
        },
        data: {
          status: "failed",
          reasonCode: code,
          version: { increment: 1 },
        },
      });
      if (code === "provider_conversion_production_unexpected") {
        this.logger.error(
          `Provider conversion ${execution.id} failed with ${code}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
      throw new ProviderConversionProductionFailure(
        code,
        disposition.retryable,
      );
    }
  }

  private async materialize(execution: ExecutionRecord): Promise<
    | { status: "duplicate" }
    | {
        status: "materialized";
        conversionEventLogId: string;
        queueRequired: boolean;
        ctwaHandoff?: boolean;
      }
  > {
    if (!execution.channelId) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_production_context_invalid",
      );
    }

    await this.billingAccess.assertProductionAccess(
      execution.workspaceId,
      execution.channelId,
    );

    if (execution.providerDecision) {
      return this.materializeFrozenDecision(
        execution,
        this.frozenDecision(execution),
      );
    }

    if (
      execution.providerRule.conversionRule.triggerType ===
      "provider_automation"
    ) {
      return this.materializeAutomation(execution);
    }

    this.assertProductionContext(execution);
    const parsedEvent = this.reparseEvent(execution);
    const match = await this.matchExecution(execution, parsedEvent);
    const manualOverride = execution.purchaseReview?.status === "approved";
    const purchase = manualOverride
      ? this.reviewPurchase(execution)
      : this.matchedPurchase(match);

    if (
      !purchase ||
      (!manualOverride && !this.matchConsistent(execution, match))
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_catalog_mismatch",
      );
    }
    if (!execution.contactIdentityHash) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_identity_missing",
      );
    }

    const lead = await this.prisma.lead.findFirst({
      where: {
        workspaceId: execution.workspaceId,
        phoneHash: execution.contactIdentityHash,
      },
      select: {
        id: true,
        phoneHash: true,
        campaignId: true,
        adSetId: true,
        adId: true,
        ctwaClid: true,
      },
    });
    if (!lead?.adId || !lead.ctwaClid) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_paid_lead_missing",
      );
    }

    const route = await this.routes.previewRoute({
      workspaceId: execution.workspaceId,
      adId: lead.adId,
    });
    if (
      route.status !== "resolved" ||
      !route.reportingAccountId ||
      !route.adAccountId ||
      !route.businessConnectionId ||
      !route.conversionDestinationId
    ) {
      throw new ProviderConversionProductionFailure(
        `provider_conversion_route_${route.reason}`,
      );
    }

    const lock = this.lockKeys(
      execution.workspaceId,
      lead.phoneHash,
      "Purchase",
    );
    const result = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ lockAcquired: string }>>`
        SELECT CAST(
          pg_advisory_xact_lock(
            CAST(${lock.first} AS integer),
            CAST(${lock.second} AS integer)
          ) AS text
        ) AS "lockAcquired"
      `;

      const current =
        await transaction.providerConversionRuleExecution.findFirst({
          where: {
            id: execution.id,
            workspaceId: execution.workspaceId,
          },
          select: { status: true },
        });
      if (current?.status === "materialized") {
        return {
          status: "materialized" as const,
          conversionEventLogId: execution.conversionEventLogId!,
          queueRequired: false,
        };
      }
      if (current?.status === "duplicate") {
        return { status: "duplicate" as const };
      }
      if (!current || !["eligible", "failed"].includes(current.status)) {
        throw new ProviderConversionProductionFailure(
          "provider_conversion_execution_state_changed",
        );
      }

      const duplicate =
        await transaction.providerConversionRuleExecution.findFirst({
          where: {
            id: { not: execution.id },
            workspaceId: execution.workspaceId,
            contactIdentityHash: lead.phoneHash,
            status: "materialized",
            occurredAt: {
              gt: new Date(
                execution.occurredAt.getTime() - PURCHASE_DEDUPE_WINDOW_MS,
              ),
              lt: new Date(
                execution.occurredAt.getTime() + PURCHASE_DEDUPE_WINDOW_MS,
              ),
            },
            providerRule: {
              conversionRule: { eventName: "Purchase" },
            },
          },
          select: { id: true },
        });

      if (duplicate) {
        await transaction.providerConversionRuleExecution.update({
          where: { id: execution.id },
          data: {
            status: "duplicate",
            reasonCode: "purchase_within_24h",
            leadId: lead.id,
            processedAt: new Date(),
          },
        });
        if (execution.purchaseReview) {
          await transaction.purchaseReview.update({
            where: { id: execution.purchaseReview.id },
            data: {
              status: "duplicate",
              reasonCode: "purchase_within_24h",
              leadWorkspaceId: execution.workspaceId,
              leadId: lead.id,
              decidedAt: new Date(),
              version: { increment: 1 },
            },
          });
        }
        return { status: "duplicate" as const };
      }

      const conversion = await this.conversions.recordExternalConversion(
        {
          workspaceId: execution.workspaceId,
          externalConnectorId: null,
          sourceEventId: parsedEvent.externalMessageId,
          sourceTrigger: `inbound_webhook:umbler:${execution.providerRule.conversionRule.triggerType}`,
          eventName: "Purchase",
          eventId: this.metaEventId(execution.id, "Purchase"),
          dedupeKey: `provider-conversion:${execution.id}`,
          leadId: lead.id,
          phoneHash: lead.phoneHash,
          businessSource: "paid",
          metaAccountId: route.adAccountId,
          metaBusinessConnectionId: route.businessConnectionId,
          metaConversionDestinationId: route.conversionDestinationId,
          campaignId: lead.campaignId,
          adSetId: lead.adSetId,
          adId: lead.adId,
          ctwaClid: lead.ctwaClid,
          valueCents: purchase.valueCents,
          valueSource: "actual",
          currency: purchase.currency,
          contentName: purchase.contentName,
          eventOccurredAt: execution.occurredAt,
          sourcePayload: {
            provider: "umbler",
            providerRuleId: execution.providerRuleId,
            providerConversionExecutionId: execution.id,
            sourceDeliveryId: execution.sourceDeliveryId,
            channelId: execution.channelId,
            catalogVariantId: match.catalogVariantId,
            purchaseReviewId: execution.purchaseReview?.id ?? null,
            items: purchase.items,
            manualReviewOverride: manualOverride,
            processingMode: "live_provider_conversion",
          },
        },
        transaction,
      );

      await transaction.providerConversionRuleExecution.update({
        where: { id: execution.id },
        data: {
          status: "materialized",
          reasonCode: null,
          leadId: lead.id,
          conversionEventLogId: conversion.conversionEventLogId,
          processedAt: new Date(),
        },
      });
      if (execution.purchaseReview) {
        await transaction.purchaseReview.update({
          where: { id: execution.purchaseReview.id },
          data: {
            status: "approved",
            leadWorkspaceId: execution.workspaceId,
            leadId: lead.id,
            conversionEventLogId: conversion.conversionEventLogId,
            effectiveValueCents: purchase.valueCents,
            currency: purchase.currency,
            reasonCode: null,
            version: { increment: 1 },
          },
        });
      }

      return {
        status: "materialized" as const,
        conversionEventLogId: conversion.conversionEventLogId,
        queueRequired: conversion.deliveryStatus === "ready_to_send",
      };
    });

    return result;
  }

  private async materializeFrozenDecision(
    execution: ExecutionRecord,
    decision: EligibleProviderConversionDecision,
  ): Promise<
    | { status: "duplicate" }
    | {
        status: "materialized";
        conversionEventLogId: string;
        queueRequired: boolean;
        ctwaHandoff?: boolean;
      }
  > {
    const lead = decision.leadResolution.lead;
    const occurrence = decision.occurrence;
    // Sale identity (seller + order + event). Only a provider that re-derives
    // it from the preserved callback may use it (Payt); otherwise the
    // decision fails closed instead of trusting a frozen key.
    const purchaseContext = await this.verifiedPurchaseContext(
      execution,
      decision,
    );
    const purchaseKey = purchaseContext?.purchaseKey ?? null;
    const eventName = this.supportedEventName(occurrence.eventName);
    // The catalog decides whether the event may travel with a value at all;
    // only "required" events are refused when the frozen decision has none.
    const requiresValue = conversionEventRequiresValue(eventName);
    const carriesValue = conversionEventCarriesValue(eventName);
    // A Payt decision frozen before the "value without installment interest"
    // fix carries total_price: it travels with the corrected value re-read
    // from the same preserved postback (identity and dedupe are unchanged).
    const valueCents = carriesValue
      ? (purchaseContext?.correctedValueCents ?? decision.conversion.valueCents)
      : null;
    const currency = carriesValue ? decision.conversion.currency : null;

    if (
      (requiresValue && (!valueCents || !currency)) ||
      !occurrence.businessDedupePolicy
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_frozen_decision_invalid",
      );
    }

    // CTWA lead with ctwa_clid and no known ad (authorized page/pixel proof),
    // exactly as in the SaaS: sale callbacks (Payt) may use the proof as the
    // fallback of an ad lead; Unnichat automations only for a no-ad lead.
    // Every other provider keeps requiring a known ad.
    let ctwaProof =
      occurrence.provider === "payt"
        ? (lead.ctwaDestination ?? purchaseContext?.ctwaProof)
        : occurrence.provider === CTWA_DESTINATION_PROVIDER && !lead.adId
          ? lead.ctwaDestination
          : undefined;
    // No ctwa_clid, nothing is sent: the resolved lead always carries it and a
    // lead without ad id is only accepted with its verified CTWA proof.
    if (!lead.ctwaClid?.trim() || (!lead.adId && !ctwaProof))
      throw new ProviderConversionProductionFailure(
        "provider_conversion_paid_lead_missing",
      );
    const ctwaRoute = (proof: NonNullable<typeof ctwaProof>) => ({
      status: "resolved",
      reason: "authorized_ctwa_destination",
      reportingAccountId: null,
      adAccountId: null,
      businessConnectionId: proof.businessConnectionId,
      conversionDestinationId: proof.destinationId,
    });
    let ctwaDestination =
      !lead.adId || purchaseContext?.ctwaOriginOnly ? ctwaProof : undefined;
    let route: {
      status: string;
      reason: string;
      reportingAccountId: string | null;
      adAccountId: string | null;
      businessConnectionId: string | null;
      conversionDestinationId: string | null;
    };
    if (ctwaDestination) {
      route = ctwaRoute(ctwaDestination);
    } else {
      // Ad lead: the saved per-ad Meta route wins. Only when it does not
      // resolve and the lead carries a verified CTWA entry proof, fall back to
      // that authorized pixel+page destination (same checks as no-ad below).
      let adRoute: typeof route;
      try {
        adRoute = purchaseKey
          ? await this.previewPurchaseRoute(execution, lead.adId!)
          : await this.routes.previewRoute({
              workspaceId: execution.workspaceId,
              adId: lead.adId!,
            });
      } catch (error) {
        if (
          !(error instanceof ProviderConversionProductionFailure) ||
          !error.code.startsWith("provider_conversion_route_")
        )
          throw error;
        // Decisions frozen before the CTWA fallback carry no proof: verify it
        // live for Payt (same rules as the paid-lead resolver).
        if (!ctwaProof && occurrence.provider === "payt")
          ctwaProof = await this.livePaytCtwaProof(execution, lead);
        if (!ctwaProof) throw error;
        adRoute = {
          status: "unresolved",
          reason: error.code.slice("provider_conversion_route_".length),
          reportingAccountId: null,
          adAccountId: null,
          businessConnectionId: null,
          conversionDestinationId: null,
        };
      }
      const adRouteResolved =
        adRoute.status === "resolved" &&
        Boolean(adRoute.reportingAccountId) &&
        Boolean(adRoute.adAccountId) &&
        Boolean(adRoute.businessConnectionId) &&
        Boolean(adRoute.conversionDestinationId);
      if (!adRouteResolved && !ctwaProof && occurrence.provider === "payt")
        ctwaProof = await this.livePaytCtwaProof(execution, lead);
      if (!adRouteResolved && ctwaProof) {
        ctwaDestination = ctwaProof;
        route = ctwaRoute(ctwaProof);
      } else {
        route = adRoute;
      }
    }
    if (
      route.status !== "resolved" ||
      (!ctwaDestination && (!route.reportingAccountId || !route.adAccountId)) ||
      !route.businessConnectionId ||
      !route.conversionDestinationId
    ) {
      throw new ProviderConversionProductionFailure(
        `provider_conversion_route_${route.reason}`,
      );
    }

    const dedupePolicy = occurrence.businessDedupePolicy;
    const lock = this.lockKeys(
      execution.workspaceId,
      purchaseKey ?? dedupePolicy.scopeKey,
      eventName,
    );
    return this.prisma.$transaction(async (transaction) => {
      if (ctwaDestination) {
        await lockUnnichatMetaPolicy(transaction, execution.workspaceId);
        const fresh =
          await transaction.providerConversionRuleExecution.findFirst({
            where: { id: execution.id, workspaceId: execution.workspaceId },
            include: executionInclude,
          });
        if (
          !fresh ||
          !fresh.channelId ||
          fresh.channel?.conversionEngineMode !== "canonical" ||
          fresh.channelId !== ctwaDestination.channelId ||
          !this.ctwaOriginConnectionMatches(fresh, ctwaDestination)
        )
          throw new ProviderConversionProductionFailure(
            "provider_conversion_ctwa_origin_mismatch",
          );
        this.assertAutomationProductionContext(fresh);
        if (purchaseKey) {
          // A sale callback carries no click: the buyer/order/value were
          // re-checked by the provider purchase context and the click comes
          // only from the lead's verified entry proof below.
          if (fresh.externalExecutionKey !== purchaseKey)
            throw new ProviderConversionProductionFailure(
              "provider_conversion_source_event_mismatch",
            );
        } else {
          this.assertCtwaClickMatches(fresh, occurrence, lead);
        }
        const proof = await resolveCtwaLeadProof(transaction, {
          workspaceId: execution.workspaceId,
          leadId: lead.id,
          phoneHash: lead.phoneHash,
          ctwaClid: lead.ctwaClid,
          channelId: ctwaDestination.channelId,
          connectionId: ctwaDestination.connectionId,
        });
        if (
          !proof ||
          JSON.stringify(proof) !== JSON.stringify(ctwaDestination) ||
          !(await ctwaIntentAuthorized(transaction, ctwaDestination))
        )
          throw new ProviderConversionProductionFailure(
            "provider_conversion_ctwa_origin_revoked",
          );
      }
      await transaction.$queryRaw<Array<{ lockAcquired: string }>>`
        SELECT CAST(
          pg_advisory_xact_lock(
            CAST(${lock.first} AS integer),
            CAST(${lock.second} AS integer)
          ) AS text
        ) AS "lockAcquired"
      `;

      if (purchaseKey) {
        // Keep the customer/event lock as well as the merchant/order lock:
        // distinct orders count independently while customer history remains serialized.
        const phoneLock = this.lockKeys(
          execution.workspaceId,
          lead.phoneHash,
          eventName,
        );
        await transaction.$queryRaw`SELECT pg_advisory_xact_lock(CAST(${phoneLock.first} AS integer), CAST(${phoneLock.second} AS integer))::text`;
      }

      const current =
        await transaction.providerConversionRuleExecution.findFirst({
          where: {
            id: execution.id,
            workspaceId: execution.workspaceId,
          },
          select: {
            status: true,
            conversionEventLogId: true,
          },
        });
      if (current?.status === "materialized") {
        if (!current.conversionEventLogId) {
          throw new ProviderConversionProductionFailure(
            "provider_conversion_materialized_event_missing",
          );
        }
        return {
          status: "materialized" as const,
          conversionEventLogId: current.conversionEventLogId,
          queueRequired: false,
        };
      }
      if (current?.status === "duplicate") {
        return { status: "duplicate" as const };
      }
      if (!current || !["eligible", "failed"].includes(current.status)) {
        throw new ProviderConversionProductionFailure(
          "provider_conversion_execution_state_changed",
        );
      }

      const occurredAt = new Date(occurrence.occurredAt);
      const duplicateWhere: Prisma.ProviderConversionRuleExecutionWhereInput =
        {
          id: { not: execution.id },
          workspaceId: execution.workspaceId,
          status: "materialized",
          OR: [
            {
              providerDecision: {
                is: {
                  businessDedupeScopeKey: dedupePolicy.scopeKey,
                },
              },
            },
            {
              providerDecisionId: null,
              contactIdentityHash: lead.phoneHash,
              providerRule: {
                conversionRule: { eventName },
              },
            },
          ],
          ...(dedupePolicy.mode === "rolling_window"
            ? {
                occurredAt: {
                  gt: new Date(
                    occurredAt.getTime() -
                      dedupePolicy.windowSeconds * 1_000,
                  ),
                  lt: new Date(
                    occurredAt.getTime() +
                      dedupePolicy.windowSeconds * 1_000,
                  ),
                },
              }
            : {}),
        };
      // A sale with a merchant order identity has exactly one durable winner.
      const purchaseClaim = purchaseKey
        ? await transaction.providerPurchaseClaim.findUnique({
            where: {
              workspaceId_effectMode_purchaseKey: {
                workspaceId: execution.workspaceId,
                effectMode: "production",
                purchaseKey,
              },
            },
          })
        : null;
      const duplicate = purchaseKey
        ? purchaseClaim
          ? { id: purchaseClaim.winnerExecutionId }
          : null
        : await transaction.providerConversionRuleExecution.findFirst({
            where: duplicateWhere,
            select: { id: true },
          });

      if (duplicate) {
        const reasonCode = purchaseKey
          ? "purchase_duplicate"
          : dedupePolicy.mode === "rolling_window"
            ? "purchase_within_24h"
            : "qualified_lead_already_materialized";
        await transaction.providerConversionRuleExecution.update({
          where: { id: execution.id },
          data: {
            status: "duplicate",
            reasonCode,
            leadId: lead.id,
            processedAt: new Date(),
            normalizedResult: this.withTechnicalDelivery(
              execution.normalizedResult,
              {
                state: "sent",
                retryable: false,
                reasonCode,
              },
            ),
          },
        });
        if (execution.purchaseReview) {
          await transaction.purchaseReview.update({
            where: { id: execution.purchaseReview.id },
            data: {
              status: "duplicate",
              reasonCode,
              leadWorkspaceId: execution.workspaceId,
              leadId: lead.id,
              decidedAt: new Date(),
              version: { increment: 1 },
            },
          });
        }
        return { status: "duplicate" as const };
      }

      const sourceEventId =
        occurrence.externalMessageId ??
        occurrence.externalEventId ??
        occurrence.occurrenceKey;
      // Fase 5.3: an Unnichat automation event may reach two rules (old
      // per-rule URL + per-event URL routed to another rule). Its Meta
      // identity comes from the business fact, so both resolve to ONE
      // conversion (the second one is a dedupe hit, never a second send).
      const automationIdentity =
        !purchaseKey &&
        (AUTOMATION_IDENTITY_PROVIDERS as readonly string[]).includes(
          occurrence.provider,
        ) &&
        decision.rule.triggerType === "provider_automation" &&
        lead.ctwaClid
          ? automationConversionIdentity(
              occurrence.provider as AutomationIdentityProvider,
              {
                workspaceId: execution.workspaceId,
                eventName,
                dedupeMode: dedupePolicy.mode,
                leadId: lead.id,
                ctwaClid: lead.ctwaClid,
                occurrenceKey: occurrence.occurrenceKey,
              },
            )
          : null;
      const conversion = await this.conversions.recordExternalConversion(
        {
          workspaceId: execution.workspaceId,
          externalConnectorId: null,
          sourceEventId,
          sourceTrigger: `inbound_webhook:${occurrence.provider}:${decision.rule.triggerType}`,
          eventName,
          // A sale keeps one Meta identity per seller+order+event.
          eventId: purchaseKey
            ? eventName === "Purchase"
              ? `conversion_purchase_${purchaseKey.slice(9)}`
              : `conversion_${conversionEventMetaEventIdPrefix(eventName)}_${purchaseKey.slice(9)}`
            : automationIdentity
              ? `${occurrence.provider}_${conversionEventMetaEventIdPrefix(eventName)}_${automationIdentity}`
              : this.metaEventId(execution.id, eventName),
          dedupeKey:
            purchaseKey ??
            (automationIdentity
              ? `provider-automation:${occurrence.provider}:${automationIdentity}`
              : `provider-conversion:${execution.id}`),
          leadId: lead.id,
          phoneHash: lead.phoneHash,
          businessSource: "paid",
          ...(ctwaDestination ? { ctwaDestination } : {}),
          metaAccountId: route.adAccountId,
          metaBusinessConnectionId: route.businessConnectionId,
          metaConversionDestinationId: route.conversionDestinationId,
          campaignId: lead.campaignId,
          adSetId: lead.adSetId,
          adId: lead.adId,
          ctwaClid: lead.ctwaClid,
          valueCents,
          valueSource: valueCents ? this.decisionValueSource(decision) : null,
          currency,
          contentName: carriesValue ? decision.conversion.contentName : null,
          eventOccurredAt: occurredAt,
          sourcePayload: {
            provider: occurrence.provider,
            providerRuleId: execution.providerRuleId,
            providerConversionExecutionId: execution.id,
            providerConversionDecisionId: execution.providerDecisionId,
            providerConversionDecisionVersion:
              execution.providerDecision?.decisionVersion ?? null,
            sourceDeliveryId: execution.sourceDeliveryId,
            channelId: execution.channelId,
            occurrenceKey: occurrence.occurrenceKey,
            parserVersion: decision.parserVersion,
            decisionEngineVersion: decision.engineVersion,
            triggerType: decision.rule.triggerType,
            purchaseReviewId: execution.purchaseReview?.id ?? null,
            items: decision.conversion.items,
            observedPaymentValueCents:
              decision.conversion.observedPaymentValueCents,
            ...(purchaseContext?.correctedValueCents
              ? {
                  valueCorrection: {
                    previousValueCents: decision.conversion.valueCents,
                    reason: PAYT_VALUE_CORRECTION_REASON,
                    correctedAt: new Date().toISOString(),
                  },
                }
              : {}),
            processingMode: "frozen_provider_conversion",
          },
        },
        transaction,
      );

      const queueRequired = conversion.deliveryStatus === "ready_to_send";
      if (purchaseKey) {
        await transaction.providerPurchaseClaim.create({
          data: {
            workspaceId: execution.workspaceId,
            purchaseKey,
            effectMode: "production",
            winnerExecutionId: execution.id,
            conversionEventLogId: conversion.conversionEventLogId,
            outboxPending: queueRequired,
          },
        });
      }
      await transaction.providerConversionRuleExecution.update({
        where: { id: execution.id },
        data: {
          status: "materialized",
          reasonCode: null,
          leadId: lead.id,
          conversionEventLogId: conversion.conversionEventLogId,
          // A legacy frozen Payt value travelled corrected: keep the execution
          // consistent with the conversion event.
          ...(purchaseContext?.correctedValueCents ? { valueCents } : {}),
          processedAt: new Date(),
          normalizedResult: this.withTechnicalDelivery(
            execution.normalizedResult,
            {
              state: queueRequired
                ? "queued"
                : // A CTWA page/pixel conversion that did not queue was refused
                  // by its own checks (e.g. outside Meta's 7-day window).
                  ctwaDestination && conversion.deliveryStatus !== "sent"
                  ? "blocked_configuration"
                  : "sent",
              retryable: false,
              reasonCode: null,
            },
          ),
        },
      });
      if (execution.purchaseReview) {
        await transaction.purchaseReview.update({
          where: { id: execution.purchaseReview.id },
          data: {
            status: "approved",
            leadWorkspaceId: execution.workspaceId,
            leadId: lead.id,
            conversionEventLogId: conversion.conversionEventLogId,
            effectiveValueCents: valueCents,
            currency: currency ?? "BRL",
            reasonCode: null,
            version: { increment: 1 },
          },
        });
      }

      return {
        status: "materialized" as const,
        conversionEventLogId: conversion.conversionEventLogId,
        queueRequired,
        ...(ctwaDestination ? { ctwaHandoff: true } : {}),
      };
    });
  }

  private async materializeAutomation(execution: ExecutionRecord): Promise<
    | { status: "duplicate" }
    | {
        status: "materialized";
        conversionEventLogId: string;
        queueRequired: boolean;
      }
  > {
    this.assertAutomationProductionContext(execution);
    const parsed = this.reparseAutomation(execution);
    const rule = execution.providerRule.conversionRule;
    const contactIdentityHash = hashPhoneIdentity(parsed.phone);

    if (
      parsed.externalExecutionKey !== execution.externalExecutionKey ||
      parsed.eventName !== rule.eventName ||
      !contactIdentityHash ||
      contactIdentityHash !== execution.contactIdentityHash
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_source_event_mismatch",
      );
    }

    const lead = await this.prisma.lead.findFirst({
      where: {
        workspaceId: execution.workspaceId,
        phoneHash: contactIdentityHash,
      },
      select: {
        id: true,
        phoneHash: true,
        campaignId: true,
        adSetId: true,
        adId: true,
        ctwaClid: true,
      },
    });
    if (!lead?.adId || !lead.ctwaClid) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_paid_lead_missing",
      );
    }

    const route = await this.routes.previewRoute({
      workspaceId: execution.workspaceId,
      adId: lead.adId,
    });
    if (
      route.status !== "resolved" ||
      !route.reportingAccountId ||
      !route.adAccountId ||
      !route.businessConnectionId ||
      !route.conversionDestinationId
    ) {
      throw new ProviderConversionProductionFailure(
        `provider_conversion_route_${route.reason}`,
      );
    }

    const eventName = this.supportedEventName(parsed.eventName);
    const carriesValue = conversionEventCarriesValue(eventName);
    const valueCents = carriesValue ? rule.defaultValueCents : null;
    // Regra -> workspace -> BRL: a rule without currency (null) inherits.
    const currency = carriesValue
      ? (normalizeCurrencyCode(rule.defaultCurrency) ??
        (valueCents
          ? await loadWorkspaceConversionCurrency(
              this.prisma,
              execution.workspaceId,
            )
          : null))
      : null;
    if (conversionEventRequiresValue(eventName) && (!valueCents || !currency)) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_value_missing",
      );
    }
    // Events that only make sense once per lead (QualifiedLead, LeadSubmitted)
    // dedupe for a lifetime; the rest keeps the 24h rolling window.
    const rollingWindow = conversionEventDedupeMode(eventName) !== "lifetime";

    const lock = this.lockKeys(
      execution.workspaceId,
      lead.phoneHash,
      parsed.eventName,
    );
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw<Array<{ lockAcquired: string }>>`
        SELECT CAST(
          pg_advisory_xact_lock(
            CAST(${lock.first} AS integer),
            CAST(${lock.second} AS integer)
          ) AS text
        ) AS "lockAcquired"
      `;

      const current =
        await transaction.providerConversionRuleExecution.findFirst({
          where: {
            id: execution.id,
            workspaceId: execution.workspaceId,
          },
          select: { status: true },
        });
      if (current?.status === "materialized") {
        return {
          status: "materialized" as const,
          conversionEventLogId: execution.conversionEventLogId!,
          queueRequired: false,
        };
      }
      if (current?.status === "duplicate") {
        return { status: "duplicate" as const };
      }
      if (!current || !["eligible", "failed"].includes(current.status)) {
        throw new ProviderConversionProductionFailure(
          "provider_conversion_execution_state_changed",
        );
      }

      const duplicate =
        await transaction.providerConversionRuleExecution.findFirst({
          where: {
            id: { not: execution.id },
            workspaceId: execution.workspaceId,
            contactIdentityHash: lead.phoneHash,
            status: "materialized",
            ...(rollingWindow
              ? {
                  occurredAt: {
                    gt: new Date(
                      execution.occurredAt.getTime() -
                        PURCHASE_DEDUPE_WINDOW_MS,
                    ),
                    lt: new Date(
                      execution.occurredAt.getTime() +
                        PURCHASE_DEDUPE_WINDOW_MS,
                    ),
                  },
                }
              : {}),
            providerRule: {
              conversionRule: { eventName: parsed.eventName },
            },
          },
          select: { id: true },
        });

      if (duplicate) {
        const reasonCode = rollingWindow
          ? "purchase_within_24h"
          : "qualified_lead_already_materialized";
        await transaction.providerConversionRuleExecution.update({
          where: { id: execution.id },
          data: {
            status: "duplicate",
            reasonCode,
            leadId: lead.id,
            processedAt: new Date(),
          },
        });
        if (execution.purchaseReview) {
          await transaction.purchaseReview.update({
            where: { id: execution.purchaseReview.id },
            data: {
              status: "duplicate",
              reasonCode,
              leadWorkspaceId: execution.workspaceId,
              leadId: lead.id,
              decidedAt: new Date(),
              version: { increment: 1 },
            },
          });
        }
        return { status: "duplicate" as const };
      }

      const conversion = await this.conversions.recordExternalConversion(
        {
          workspaceId: execution.workspaceId,
          externalConnectorId: null,
          sourceEventId: parsed.externalExecutionKey,
          sourceTrigger: "inbound_webhook:umbler:provider_automation",
          eventName: parsed.eventName,
          eventId: this.metaEventId(execution.id, parsed.eventName),
          dedupeKey: `provider-conversion:${execution.id}`,
          leadId: lead.id,
          phoneHash: lead.phoneHash,
          businessSource: "paid",
          metaAccountId: route.adAccountId,
          metaBusinessConnectionId: route.businessConnectionId,
          metaConversionDestinationId: route.conversionDestinationId,
          campaignId: lead.campaignId,
          adSetId: lead.adSetId,
          adId: lead.adId,
          ctwaClid: lead.ctwaClid,
          valueCents,
          valueSource: valueCents ? "configured_average" : null,
          currency,
          contentName: carriesValue ? rule.defaultContentName : null,
          eventOccurredAt: execution.occurredAt,
          sourcePayload: {
            provider: "umbler",
            providerRuleId: execution.providerRuleId,
            providerConversionExecutionId: execution.id,
            sourceDeliveryId: execution.sourceDeliveryId,
            channelId: execution.channelId,
            automation: parsed.automation,
            purchaseReviewId: execution.purchaseReview?.id ?? null,
            processingMode: "live_provider_automation",
          },
        },
        transaction,
      );

      await transaction.providerConversionRuleExecution.update({
        where: { id: execution.id },
        data: {
          status: "materialized",
          reasonCode: null,
          leadId: lead.id,
          conversionEventLogId: conversion.conversionEventLogId,
          processedAt: new Date(),
        },
      });
      if (execution.purchaseReview) {
        await transaction.purchaseReview.update({
          where: { id: execution.purchaseReview.id },
          data: {
            status: "approved",
            leadWorkspaceId: execution.workspaceId,
            leadId: lead.id,
            conversionEventLogId: conversion.conversionEventLogId,
            effectiveValueCents: valueCents,
            currency: currency ?? "BRL",
            reasonCode: null,
            version: { increment: 1 },
          },
        });
      }

      return {
        status: "materialized" as const,
        conversionEventLogId: conversion.conversionEventLogId,
        queueRequired: conversion.deliveryStatus === "ready_to_send",
      };
    });
  }

  private async matchExecution(
    execution: ExecutionRecord,
    event: ParsedInboundWebhookEvent,
  ): Promise<StructuredCatalogTestMessageResultDto> {
    if (
      execution.providerRule.conversionRule.triggerType === "structured_catalog"
    ) {
      return this.catalogs.matchRuleMessage(
        execution.workspaceId,
        execution.providerRuleId,
        event.message.text!,
      );
    }

    const rule = execution.providerRule;
    const matchedTriggerPhrase = matchProviderMessageTrigger(
      event.message.text!,
      rule.messageTriggerPhrases,
    );
    const valueCents = rule.conversionRule.defaultValueCents;
    // Regra -> workspace -> BRL: a rule without currency (null) inherits.
    const currency =
      normalizeCurrencyCode(rule.conversionRule.defaultCurrency) ??
      (matchedTriggerPhrase && valueCents
        ? await loadWorkspaceConversionCurrency(
            this.prisma,
            execution.workspaceId,
          )
        : null);
    const matched = Boolean(matchedTriggerPhrase && valueCents && currency);

    return {
      matched,
      reasonCode: matched ? "matched" : "trigger_missing",
      classification: matched ? "recognized" : "ignored",
      matchedTriggerPhrase,
      parsedAttributes: [],
      items: [],
      parsedValueCents: matched ? valueCents : null,
      calculatedValueCents: matched ? valueCents : null,
      observedPaymentValueCents: null,
      catalogVariantId: null,
      contentName: rule.conversionRule.defaultContentName,
      currency,
    };
  }

  private matchConsistent(
    execution: ExecutionRecord,
    match: StructuredCatalogTestMessageResultDto,
  ): boolean {
    if (
      !match.matched ||
      match.calculatedValueCents !== execution.valueCents ||
      match.currency !== execution.currency
    ) {
      return false;
    }

    const normalized = this.jsonObject(execution.normalizedResult);
    return this.jsonEquals(normalized?.items, match.items);
  }

  private matchedPurchase(match: StructuredCatalogTestMessageResultDto): {
    valueCents: number;
    currency: string;
    contentName: string | null;
    items: unknown[];
  } | null {
    if (!match.matched || !match.calculatedValueCents || !match.currency) {
      return null;
    }

    return {
      valueCents: match.calculatedValueCents,
      currency: match.currency,
      contentName: match.contentName,
      items: match.items,
    };
  }

  private reviewPurchase(execution: ExecutionRecord): {
    valueCents: number;
    currency: string;
    contentName: string | null;
    items: unknown[];
  } | null {
    const review = execution.purchaseReview;
    const catalogPurchase =
      execution.providerRule.conversionRule.triggerType ===
      "structured_catalog";
    if (
      !review?.effectiveValueCents ||
      (catalogPurchase && review.items.length === 0)
    ) {
      return null;
    }

    const items = review.items.map((item) => ({
      catalogVariantId: item.catalogVariantId,
      attributeValues: this.stringArray(item.attributeValues),
      quantity: item.quantity,
      unitValueCents: item.unitValueCents,
      subtotalValueCents: item.subtotalValueCents,
      contentName: item.contentName,
    }));
    if (
      catalogPurchase &&
      items.some(
        (item) =>
          !item.catalogVariantId ||
          !item.unitValueCents ||
          !item.subtotalValueCents,
      )
    ) {
      return null;
    }

    const names = [
      ...new Set(
        items
          .map((item) => item.contentName)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    return {
      valueCents: review.effectiveValueCents,
      currency: review.currency,
      contentName:
        names.length === 1
          ? names[0]
          : execution.providerRule.conversionRule.defaultContentName,
      items,
    };
  }

  private frozenDecision(
    execution: ExecutionRecord,
  ): EligibleProviderConversionDecision {
    const audit = execution.providerDecision;
    const parsed = providerConversionDecisionSchema.safeParse(
      audit?.decisionJson,
    );
    if (
      !audit ||
      !parsed.success ||
      parsed.data.decisionCode !== "eligible" ||
      audit.id !== execution.providerDecisionId ||
      audit.workspaceId !== execution.workspaceId ||
      audit.providerRuleId !== execution.providerRuleId ||
      audit.sourceDeliveryId !== execution.sourceDeliveryId ||
      audit.decisionCode !== "eligible" ||
      audit.occurrenceKey !== execution.externalExecutionKey ||
      audit.eventName !== parsed.data.occurrence.eventName ||
      audit.occurredAt.getTime() !==
        new Date(parsed.data.occurrence.occurredAt).getTime() ||
      parsed.data.occurrence.workspaceId !== execution.workspaceId ||
      parsed.data.occurrence.occurrenceKey !==
        execution.externalExecutionKey ||
      parsed.data.rule.providerRuleId !== execution.providerRuleId ||
      parsed.data.leadResolution.lead.id !== audit.leadId ||
      (execution.leadId !== null &&
        execution.leadId !== parsed.data.leadResolution.lead.id)
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_frozen_decision_mismatch",
      );
    }

    return parsed.data;
  }

  private jsonObject(
    value: Prisma.JsonValue | null,
  ): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private withTechnicalDelivery(
    value: Prisma.JsonValue | null,
    technicalDelivery: {
      state: ProviderConversionTechnicalDeliveryStateDto;
      retryable: boolean;
      reasonCode: string | null;
    },
  ): Prisma.InputJsonValue {
    return {
      ...(this.jsonObject(value) ?? {}),
      technicalDelivery: {
        ...technicalDelivery,
        updatedAt: new Date().toISOString(),
      },
    } as Prisma.InputJsonValue;
  }

  private withProductionFailure(
    value: Prisma.JsonValue | null,
    failure: Prisma.InputJsonValue,
    disposition: {
      executionStatus: "blocked" | "failed";
      state:
        | "blocked_configuration"
        | "failed_retryable"
        | "failed_permanent";
      retryable: boolean;
    },
  ): Prisma.InputJsonValue {
    const withTechnicalDelivery = this.withTechnicalDelivery(value, {
      state: disposition.state,
      retryable: disposition.retryable,
      reasonCode:
        this.jsonObject(failure as Prisma.JsonValue)?.code?.toString() ?? null,
    });

    return {
      ...(this.jsonObject(withTechnicalDelivery as Prisma.JsonValue) ?? {}),
      lastProductionFailure: failure,
    } as Prisma.InputJsonValue;
  }

  private retryableTechnicalFailure(
    value: Prisma.JsonValue | null,
  ): boolean {
    const normalized = this.jsonObject(value);
    const technicalDelivery = this.jsonObject(
      (normalized?.technicalDelivery ?? null) as Prisma.JsonValue | null,
    );

    return (
      technicalDelivery?.state === "failed_retryable" &&
      technicalDelivery.retryable === true
    );
  }

  private failureDisposition(code: string): {
    executionStatus: "blocked" | "failed";
    state:
      | "blocked_configuration"
      | "failed_retryable"
      | "failed_permanent";
    retryable: boolean;
  } {
    if (code.startsWith("external_channel_billing_")) {
      return {
        executionStatus: "failed",
        state: "failed_retryable",
        retryable: true,
      };
    }

    if (
      code === "provider_conversion_production_context_invalid" ||
      code.startsWith("provider_conversion_route_")
    ) {
      return {
        executionStatus: "blocked",
        state: "blocked_configuration",
        retryable: false,
      };
    }
    if (code === "provider_conversion_production_unexpected") {
      return {
        executionStatus: "failed",
        state: "failed_retryable",
        retryable: true,
      };
    }

    return {
      executionStatus: "failed",
      state: "failed_permanent",
      retryable: false,
    };
  }

  private jsonEquals(left: unknown, right: unknown): boolean {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  }

  private automationManualReplayApproved(execution: ExecutionRecord): boolean {
    const normalized = this.jsonObject(execution.normalizedResult);
    const approval = this.jsonObject(
      (normalized?.manualReplayApproval ?? null) as Prisma.JsonValue | null,
    );
    const approvedAt = approval?.approvedAt ?? approval?.attemptedAt;

    return (
      approval?.approved === true &&
      this.identifier(approval.actorUserId) &&
      typeof approvedAt === "string"
    );
  }

  private stringArray(value: Prisma.JsonValue): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  }

  private assertProductionContext(execution: ExecutionRecord): void {
    const rule = execution.providerRule;
    const delivery = execution.sourceDelivery;
    const channel = execution.channel;
    const manuallyApproved = execution.purchaseReview?.status === "approved";
    const channelScoped = executionChannelInRuleScope(execution);

    if (
      // Legacy (pre-decision) executions only exist for connection-bound
      // rules; an unbound rule here is never materialized.
      !rule.connection ||
      !rule.parserRelease ||
      rule.removedAt ||
      !rule.conversionRule.active ||
      !["structured_catalog", "message_phrase"].includes(
        rule.conversionRule.triggerType,
      ) ||
      // Legacy path only: executions without a frozen decision are reparsed
      // and always materialized as Purchase, so no other event may enter here.
      rule.conversionRule.eventName !== "Purchase" ||
      (!manuallyApproved && rule.mode !== "production") ||
      (!manuallyApproved && !rule.productionActivatedAt) ||
      !inboundParserProductionEligible(rule.parserRelease) ||
      rule.connection.removedAt ||
      rule.connection.status !== "production" ||
      !inboundParserProductionEligible(rule.connection.parserRelease) ||
      rule.connectionId !== delivery.connectionId ||
      rule.parserReleaseId !== rule.connection.parserReleaseId ||
      rule.connection.parserRelease.version !== delivery.parserVersion ||
      !channel ||
      channel.status !== "active" ||
      !channel.productionActivatedAt ||
      !channelScoped ||
      (!manuallyApproved &&
        rule.productionActivatedAt !== null &&
        delivery.firstReceivedAt < rule.productionActivatedAt) ||
      delivery.firstReceivedAt < channel.productionActivatedAt
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_production_context_invalid",
      );
    }
  }

  private assertAutomationProductionContext(execution: ExecutionRecord): void {
    const rule = execution.providerRule;
    const delivery = execution.sourceDelivery;
    const channel = execution.channel;
    const manuallyApproved = this.automationManualReplayApproved(execution);
    const channelScoped = executionChannelInRuleScope(execution);

    if (
      // The Umbler automation always keeps its connection binding.
      !rule.connection ||
      !rule.parserRelease ||
      rule.removedAt ||
      !rule.conversionRule.active ||
      rule.conversionRule.triggerType !== "provider_automation" ||
      rule.mode !== "production" ||
      !rule.productionActivatedAt ||
      !inboundParserProductionEligible(rule.parserRelease) ||
      rule.parserRelease.version !== UMBLER_AUTOMATION_V1_PARSER_VERSION ||
      rule.connection.removedAt ||
      rule.connection.status !== "production" ||
      !inboundParserProductionEligible(rule.connection.parserRelease) ||
      rule.connectionId !== delivery.connectionId ||
      delivery.parserVersion !== UMBLER_AUTOMATION_V1_PARSER_VERSION ||
      delivery.purpose !== "conversion_automation" ||
      delivery.providerRuleEndpointId === null ||
      !channel ||
      channel.status !== "active" ||
      !channel.productionActivatedAt ||
      !channelScoped ||
      (!manuallyApproved &&
        delivery.firstReceivedAt < rule.productionActivatedAt) ||
      (!manuallyApproved &&
        delivery.firstReceivedAt < channel.productionActivatedAt)
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_production_context_invalid",
      );
    }
  }

  /**
   * Sale identity of a frozen decision, re-derived from the preserved callback
   * by the provider that owns it (Payt). Any other provider claiming a sale
   * identity fails closed and nothing is sent.
   */
  private async verifiedPurchaseContext(
    execution: ExecutionRecord,
    decision: EligibleProviderConversionDecision,
  ): Promise<{
    purchaseKey: string;
    ctwaOriginOnly: boolean;
    ctwaProof: AuthorizedCtwaDestination | undefined;
    /** Set only for a decision frozen with the legacy Payt total_price. */
    correctedValueCents: number | null;
  } | null> {
    if (decision.occurrence.provider === "payt")
      return this.assertPaytPurchaseContext(execution, decision);
    if (!decision.occurrence.purchaseKey) return null;
    throw new ProviderConversionProductionFailure(
      "provider_purchase_identity_missing",
    );
  }

  /**
   * Re-derives a Payt sale from the preserved postback: event of the rule,
   * buyer phone of the lead, seller+order identity and value. The origin is
   * the single scoped channel of the paid lead's verified CTWA entry.
   */
  private async assertPaytPurchaseContext(
    execution: ExecutionRecord,
    decision: EligibleProviderConversionDecision,
  ): Promise<{
    purchaseKey: string;
    ctwaOriginOnly: boolean;
    ctwaProof: AuthorizedCtwaDestination | undefined;
    /** Set only for a decision frozen with the legacy Payt total_price. */
    correctedValueCents: number | null;
  }> {
    this.assertAutomationProductionContext(execution);
    if (
      execution.channel?.conversionEngineMode !== "canonical" ||
      !(PAYT_SALE_EVENT_NAMES as readonly string[]).includes(
        decision.occurrence.eventName,
      ) ||
      decision.occurrence.eventName !==
        execution.providerRule.conversionRule.eventName ||
      execution.providerRule.parserRelease?.provider !== "payt"
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_production_context_invalid",
      );
    }
    const captureChannel = await this.prisma.inboundWebhookChannel.findFirst({
      where: {
        id: execution.channelId!,
        workspaceId: execution.workspaceId,
        status: "active",
        connection: {
          is: {
            workspaceId: execution.workspaceId,
            removedAt: null,
            status: "production",
          },
        },
      },
      select: {
        id: true,
        connection: {
          select: {
            parserRelease: {
              select: { provider: true, version: true, status: true },
            },
          },
        },
      },
    });
    if (
      !captureChannel ||
      !inboundParserProductionEligible(captureChannel.connection.parserRelease)
    )
      throw new ProviderConversionProductionFailure(
        "provider_conversion_production_context_invalid",
      );
    const lead = decision.leadResolution.lead;
    const originChannels = await resolvePurchaseChannels(this.prisma, {
      workspaceId: execution.workspaceId,
      // Same candidate set as the observation: the chosen channels, or every
      // live workspace channel for an "all numbers" Payt rule.
      channelIds: await resolveProviderRuleScopeChannelIds(
        this.prisma,
        execution.workspaceId,
        execution.providerRule,
      ),
      phoneHashes: [lead.phoneHash],
      leadId: lead.id,
      adId: lead.adId,
      ctwaClid: lead.ctwaClid,
      receivedAt: execution.sourceDelivery.firstReceivedAt,
    });
    const ctwaOrigin = lead.adId ? undefined : lead.ctwaDestination;
    // Ad lead with no materialized ad entry on any scoped channel: its
    // verified CTWA entry proof is the origin (same as a no-ad lead) and the
    // purchase may only travel to that authorized page/pixel destination.
    // A decision frozen before this fallback has no proof: verify it live.
    const ctwaProof =
      lead.ctwaDestination ??
      (lead.adId && originChannels.length === 0
        ? await this.livePaytCtwaProof(execution, lead)
        : undefined);
    const ctwaOriginOnly = Boolean(
      lead.adId &&
      originChannels.length === 0 &&
      ctwaProof?.channelId === execution.channelId,
    );
    if (
      !ctwaOriginOnly &&
      (originChannels.length !== 1 ||
        originChannels[0]!.id !== execution.channelId ||
        (!lead.adId && ctwaOrigin?.channelId !== execution.channelId))
    )
      throw new ProviderConversionProductionFailure(
        "provider_purchase_channel_missing_or_ambiguous",
      );
    const payload = this.decryptedPayload(execution);
    const parsed = parsePaytSaleEventV1(payload);
    if (!parsed.ok)
      throw new ProviderConversionProductionFailure(
        "provider_purchase_identity_missing",
      );
    // Decision frozen before the Payt value fix: it holds the same postback's
    // total_price (with installment interest). Same sale, legacy value.
    const legacyPaytValue =
      parsed.value.valueCents !== null &&
      decision.conversion.valueCents !== null &&
      decision.conversion.valueCents !== parsed.value.valueCents &&
      decision.conversion.valueCents === paytLegacyTotalPriceCents(payload);
    const purchaseKey = buildProviderPurchaseIdentity({
      workspaceId: execution.workspaceId,
      provider: "payt",
      accountRef: parsed.value.accountRef,
      orderRef: parsed.value.orderRef,
      eventName: parsed.value.eventName,
    });
    if (
      // The preserved postback must still be the event of this rule and,
      // when the rule is limited to some products (Fase 5.3), one of them.
      parsed.value.eventName !== decision.occurrence.eventName ||
      !paytProductFilterMatches(
        execution.providerRule.productFilterCodes,
        parsed.value.productCodes ?? [],
      ) ||
      // The buyer phone may be an equivalent BR form of the lead identity
      // (with/without 55 or the mobile 9th digit).
      !hashPhoneIdentityVariants(parsed.value.phoneCandidates).includes(
        lead.phoneHash,
      ) ||
      decision.occurrence.purchaseKey !== purchaseKey ||
      purchaseKey !== execution.externalExecutionKey ||
      // A valueless abandoned cart may travel with the rule's average value.
      // Venda sem moeda declarada usou a moeda da regra/workspace.
      (parsed.value.valueCents !== null &&
        ((decision.conversion.valueCents !== parsed.value.valueCents &&
          !legacyPaytValue) ||
          (parsed.value.currency !== null &&
            decision.conversion.currency !== parsed.value.currency)))
    )
      throw new ProviderConversionProductionFailure(
        "provider_conversion_source_event_mismatch",
      );
    return {
      purchaseKey,
      ctwaOriginOnly,
      ctwaProof,
      correctedValueCents: legacyPaytValue ? parsed.value.valueCents : null,
    };
  }

  /**
   * Live CTWA entry proof of a Payt ad lead whose frozen decision predates the
   * authorized-destination fallback. Same parameters as the paid-lead
   * resolver for Payt (any verified channel); the caller still binds the
   * proof to the execution channel/connection and re-verifies it in the
   * materialization transaction.
   */
  private async livePaytCtwaProof(
    execution: ExecutionRecord,
    lead: EligibleProviderConversionDecision["leadResolution"]["lead"],
  ): Promise<AuthorizedCtwaDestination | undefined> {
    if (!lead.adId || !lead.ctwaClid?.trim()) return undefined;
    return (
      (await resolveCtwaLeadProof(this.prisma, {
        workspaceId: execution.workspaceId,
        leadId: lead.id,
        phoneHash: lead.phoneHash,
        ctwaClid: lead.ctwaClid,
      })) ?? undefined
    );
  }

  /**
   * Ad route of a sale: the scoped channel's own valid routes, or the
   * workspace route when the channel inherits it (Unnichat) or resolves its
   * own destination per ad (UAZAPI).
   */
  private async previewPurchaseRoute(execution: ExecutionRecord, adId: string) {
    const channel = await this.prisma.inboundWebhookChannel.findFirst({
      where: { workspaceId: execution.workspaceId, id: execution.channelId! },
      include: {
        routes: { where: { active: true, validationStatus: "valid" } },
        connection: true,
      },
    });
    if (
      !channel ||
      channel.workspaceId !== execution.workspaceId ||
      channel.connection.workspaceId !== execution.workspaceId
    )
      throw new ProviderConversionProductionFailure(
        "provider_conversion_route_not_authorized",
      );
    if (channel.connection.provider === "uazapi")
      return this.routes.previewRoute({
        workspaceId: execution.workspaceId,
        adId,
      });
    if (String(channel.connection.provider) === CTWA_DESTINATION_PROVIDER) {
      const policy = await effectiveUnnichatMetaRouting(this.prisma, channel);
      if (policy.eligible && policy.source === "inherit_workspace")
        return this.routes.previewRoute({
          workspaceId: execution.workspaceId,
          adId,
        });
    }
    const previews = [];
    for (const route of channel.routes) {
      const preview = await this.routes.previewRoute({
        workspaceId: execution.workspaceId,
        adId,
        businessConnectionId: route.metaBusinessConnectionId,
        reportingAccountId: route.metaReportingAccountId,
        conversionDestinationId: route.metaConversionDestinationId,
      });
      if (
        preview.status === "resolved" &&
        preview.businessConnectionId === route.metaBusinessConnectionId &&
        (!route.metaReportingAccountId ||
          preview.reportingAccountId === route.metaReportingAccountId) &&
        (!route.metaConversionDestinationId ||
          preview.conversionDestinationId === route.metaConversionDestinationId)
      )
        previews.push(preview);
    }
    if (previews.length !== 1)
      throw new ProviderConversionProductionFailure(
        "provider_conversion_route_missing_or_conflicting",
      );
    return previews[0]!;
  }

  /**
   * Automations arrive on the entry connection itself. A sale callback (Payt)
   * sits on its rule's endpoint, so its origin is the scoped channel, which
   * must belong to the connection of the verified CTWA entry.
   */
  private ctwaOriginConnectionMatches(
    execution: ExecutionRecord,
    intent: { channelId: string; connectionId: string },
  ): boolean {
    if (String(execution.providerRule.parserRelease?.provider) === "payt")
      return Boolean(
        execution.channel &&
        execution.channel.id === intent.channelId &&
        execution.channel.connectionId === intent.connectionId &&
        providerRuleCoversChannel(execution.providerRule, {
          id: intent.channelId,
          connectionId: execution.channel.connectionId,
          provider: execution.channel.connection?.provider ?? "",
        }),
      );
    return execution.sourceDelivery.connectionId === intent.connectionId;
  }

  /**
   * The preserved automation callback must still carry the lead's click
   * (ctwa_clid): a CTWA conversion without the click never reaches Meta.
   * Callbacks without a click field (Umbler automation) always fail closed.
   */
  private assertCtwaClickMatches(
    execution: ExecutionRecord,
    occurrence: EligibleProviderConversionDecision["occurrence"],
    lead: EligibleProviderConversionDecision["leadResolution"]["lead"],
  ): void {
    const parsed = this.reparseAutomation(execution) as ParsedAutomationForProduction & {
      ctwaClid?: string | null;
    };
    if (
      parsed.externalExecutionKey !== execution.externalExecutionKey ||
      parsed.eventName !== occurrence.eventName ||
      !hashPhoneIdentityVariants([parsed.phone]).includes(lead.phoneHash) ||
      !parsed.ctwaClid ||
      parsed.ctwaClid !== lead.ctwaClid
    )
      throw new ProviderConversionProductionFailure(
        "provider_conversion_ctwa_click_mismatch",
      );
  }

  private reparseAutomation(
    execution: ExecutionRecord,
  ): ParsedAutomationForProduction {
    const payload = this.decryptedPayload(execution);
    // Fase 4b: the Unnichat automation carries the click (ctwa_clid); the
    // event comes from the rule, never from the payload's event_name.
    if (
      execution.providerRule.parserRelease?.provider === "unnichat" &&
      execution.providerRule.parserRelease.version ===
        UNNICHAT_AUTOMATION_V1_PARSER_VERSION
    ) {
      const parsed = parseUnnichatAutomationV1(payload);
      if (!parsed.ok) {
        throw new ProviderConversionProductionFailure(
          "provider_conversion_payload_invalid",
        );
      }
      return {
        ...parsed.value,
        provider: "unnichat",
        automation: "crm_movement",
        eventName: this.supportedEventName(
          execution.providerRule.conversionRule.eventName,
        ),
      };
    }
    const parsed = parseUmblerAutomationV1(payload);
    if (!parsed.ok) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_payload_invalid",
      );
    }
    return parsed.value;
  }

  private reparseEvent(execution: ExecutionRecord): ParsedInboundWebhookEvent {
    const payload = this.decryptedPayload(execution);

    const connection = execution.providerRule.connection;
    if (!connection) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_production_context_invalid",
      );
    }
    const parser = this.parserRegistry.resolve({
      provider: connection.provider,
      parserVersion: connection.parserRelease.version,
      parserReleaseStatus: connection.parserRelease.status,
    });
    const result = parser.parse(
      payload,
      inboundWebhookParserContext(execution.workspaceId),
    );
    const parsedEvent = result.events.find(
      (event) => event.dedupeKey === execution.externalExecutionKey,
    );

    if (
      result.error ||
      !parsedEvent ||
      parsedEvent.provider !== "umbler" ||
      !providerMessageAuthorAllowed(
        execution.providerRule.messageAuthorScope ?? "team",
        parsedEvent.message.authorType,
      ) ||
      parsedEvent.message.isPrivate ||
      !parsedEvent.message.text
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_source_event_mismatch",
      );
    }

    return parsedEvent;
  }

  private decryptedPayload(execution: ExecutionRecord): unknown {
    const delivery = execution.sourceDelivery;
    if (
      delivery.payloadExpiresAt <= new Date() ||
      !delivery.encryptedPayload ||
      !delivery.payloadIv ||
      !delivery.payloadTag ||
      delivery.encryptionKeyVersion === null
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_payload_unavailable",
      );
    }

    const decrypted = this.payloadEncryption.decrypt(
      {
        encryptedPayload: delivery.encryptedPayload,
        payloadIv: delivery.payloadIv,
        payloadTag: delivery.payloadTag,
        encryptionKeyVersion: delivery.encryptionKeyVersion,
      },
      {
        workspaceId: delivery.workspaceId,
        connectionId: delivery.connectionId,
        deliveryId: delivery.id,
      },
    );
    try {
      return JSON.parse(decrypted.toString("utf8")) as unknown;
    } catch {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_payload_invalid",
      );
    }
  }

  private loadExecution(
    input: Readonly<ProviderConversionProductionJobPayload>,
  ): Promise<ExecutionRecord | null> {
    return this.prisma.providerConversionRuleExecution.findFirst({
      where: {
        id: input.providerConversionExecutionId,
        workspaceId: input.workspaceId,
      },
      include: executionInclude,
    });
  }

  private async enqueueMaterialized(execution: ExecutionRecord): Promise<void> {
    if (!execution.conversionEventLogId) return;
    const conversion = await this.prisma.conversionEventLog.findFirst({
      where: {
        id: execution.conversionEventLogId,
        workspaceId: execution.workspaceId,
      },
      select: { status: true, sourcePayload: true },
    });
    if (conversion?.status === "ready_to_send") {
      const payload = this.jsonObject(conversion.sourcePayload);
      if (payload?.ctwaDestination) {
        // CTWA page/pixel conversion: re-verify the destination and the
        // execution before queueing; a revoked handoff stays recorded.
        const parsed = authorizedCtwaDestinationSchema.safeParse(
          payload.ctwaDestination,
        );
        if (!parsed.success) return;
        const intent = parsed.data;
        await this.prisma.$transaction(async (tx) => {
          await lockUnnichatMetaPolicy(tx, execution.workspaceId);
          const fresh = await tx.providerConversionRuleExecution.findFirst({
            where: { id: execution.id, workspaceId: execution.workspaceId },
            include: executionInclude,
          });
          let contextValid = false;
          if (fresh) {
            try {
              this.assertAutomationProductionContext(fresh);
              contextValid = true;
            } catch {
              contextValid = false;
            }
          }
          if (
            !fresh ||
            !contextValid ||
            fresh.status !== "materialized" ||
            fresh.conversionEventLogId !== execution.conversionEventLogId ||
            fresh.channel?.conversionEngineMode !== "canonical" ||
            fresh.channelId !== intent.channelId ||
            !this.ctwaOriginConnectionMatches(fresh, intent) ||
            intent.workspaceId !== execution.workspaceId ||
            !(await ctwaIntentAuthorized(tx, intent))
          ) {
            if (fresh?.status === "materialized")
              await tx.providerConversionRuleExecution.update({
                where: { id: fresh.id },
                data: {
                  reasonCode: "provider_conversion_ctwa_handoff_revoked",
                },
              });
            return;
          }
          await this.conversionQueue.enqueueSend(
            execution.conversionEventLogId!,
            execution.workspaceId,
          );
        });
        return;
      }
      await this.conversionQueue.enqueueSend(
        execution.conversionEventLogId,
        execution.workspaceId,
      );
    }
  }

  private lockKeys(
    workspaceId: string,
    phoneHash: string,
    eventName: string,
  ): {
    first: number;
    second: number;
  } {
    const digest = createHash("sha256")
      .update(`${workspaceId}\0${phoneHash}\0${eventName}`, "utf8")
      .digest();

    return {
      first: digest.readInt32BE(0),
      second: digest.readInt32BE(4),
    };
  }

  /**
   * "actual" whenever the value came from the message itself: a catalog match,
   * or a message_phrase rule that extracted the amount. A configured average
   * (fixed mode, or the extracted-mode fallback) stays "configured_average".
   */
  private decisionValueSource(
    decision: ProviderConversionDecisionDto,
  ): "actual" | "configured_average" {
    if (
      decision.rule.triggerType === "structured_catalog" ||
      decision.occurrence.provider === "payt"
    )
      return "actual";

    return decision.rule.triggerType === "message_phrase" &&
      decision.conversion.observedPaymentValueCents !== null
      ? "actual"
      : "configured_average";
  }

  /**
   * Fail closed on an event the catalog does not know: an unsupported name
   * must never reach Meta.
   */
  private supportedEventName(eventName: string): ConversionEventNameDto {
    const parsed = conversionEventNameSchema.safeParse(eventName);
    if (!parsed.success) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_event_unsupported",
      );
    }
    return parsed.data;
  }

  /**
   * Purchase/QualifiedLead/InitiateCheckout carry legacy prefixes in the
   * catalog: changing them would break deduplication of events already sent
   * to Meta.
   */
  private metaEventId(
    executionId: string,
    eventName: ConversionEventNameDto,
  ): string {
    const digest = createHash("sha256").update(executionId).digest("hex");
    return `umbler_${conversionEventMetaEventIdPrefix(eventName)}_${digest}`;
  }

  private productionEnabled(): boolean {
    const config = parseInboundWebhooksConfig(this.env);
    return (
      config.enabled &&
      config.productionEnabled &&
      config.conversionRulesEnabled &&
      config.conversionProductionEnabled
    );
  }

  private assertInput(
    input: Readonly<ProviderConversionProductionJobPayload>,
  ): void {
    if (
      !input ||
      !this.identifier(input.providerConversionExecutionId) ||
      !this.identifier(input.workspaceId)
    ) {
      throw new ProviderConversionProductionFailure(
        "provider_conversion_production_context_invalid",
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

  private errorCode(error: unknown): string {
    if (
      (error instanceof ProviderConversionProductionFailure ||
        error instanceof ExternalChannelBillingAccessError) &&
      /^[a-z0-9_]{1,160}$/u.test(error.code)
    ) {
      return error.code;
    }

    return "provider_conversion_production_unexpected";
  }

  private failureSummary(error: unknown, code: string): Prisma.InputJsonValue {
    const prismaCode =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : null;

    return {
      code,
      prismaCode,
      failedAt: new Date().toISOString(),
    };
  }
}
