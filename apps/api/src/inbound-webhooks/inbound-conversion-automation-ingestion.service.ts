import { inboundParserProductionEligible } from "./inbound-webhook-parser-eligibility";
import { createHash, randomUUID } from "node:crypto";
import { buildProviderPurchaseIdentity } from "../conversion-rules/provider-purchase-identity";
import { PAYT_LEAD_OTHER_CHANNEL_REASON } from "../conversion-rules/provider-purchase-routing";
import { PROVIDER_RULE_OVERRIDDEN_REASON } from "../conversion-rules/provider-rule-scope";
import type { ProviderConversionManualReplayApproval } from "../conversion-rules/provider-conversion-orchestrator.service";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  ProviderConversionAutomationAuditDto,
  ProviderConversionAutomationAuditItemDto,
  ProviderConversionAutomationPayloadDto,
  ProviderConversionAutomationReprocessBatchItemDto,
  ProviderConversionAutomationReprocessBatchResultDto,
  ProviderConversionAutomationReprocessResultDto,
} from "@wpptrack/shared";
import {
  conversionEventNameSchema,
  type ConversionEventNameDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import {
  PAYT_PRODUCT_NOT_IN_RULE_REASON,
  ProviderConversionObservationService,
  type ProviderConversionAutomationObservationResult,
  type ProviderConversionEvaluationMode,
} from "../conversion-rules/provider-conversion-observation.service";
import {
  INBOUND_WEBHOOK_RAW_RETENTION_DAYS,
  parseInboundWebhooksConfig,
} from "../config/deployment-config";
import {
  MAX_INBOUND_WEBHOOK_PAYLOAD_BYTES,
  matchesInboundWebhookSecret,
  parseInboundWebhookProviderAttempt,
} from "./inbound-webhook-ingestion.service";
import { InboundWebhookPayloadEncryptionService } from "./inbound-webhook-payload-encryption.service";
import { InboundWebhookProductionQueueService } from "./inbound-webhook-production-queue.service";
import {
  parseUmblerAutomationV1,
  type ParsedUmblerAutomationV1,
  UMBLER_AUTOMATION_V1_PARSER_VERSION,
} from "./providers/umbler/umbler-automation-v1.parser";
import {
  parsePaytAutomationV1,
  parsePaytSaleEventV1,
  paytSaleEventNameOf,
  type ParsedPaytAutomationV1,
  PAYT_AUTOMATION_V1_PARSER_VERSION,
} from "./providers/payt/payt-automation-v1.parser";
import {
  parseUnnichatAutomationV1,
  type ParsedUnnichatAutomationV1,
  UNNICHAT_AUTOMATION_V1_PARSER_VERSION,
} from "./providers/unnichat/unnichat-automation-v1.parser";

const publicEndpointNotFoundMessage = "Webhook nao encontrado";
const publicPersistenceFailureMessage = "Webhook temporariamente indisponivel";
const fallbackDedupeWindowMs = 5 * 60 * 1_000;
const ignoredUntrackedLeadReason = "ignored_untracked_lead";
/** Parsed-but-not-for-this-rule callbacks: recorded as ignored, never invalid. */
const ignoredParseErrors = new Set<string>([
  "payt_automation_v1_not_purchase",
  "payt_automation_v1_event_not_in_rule",
]);
const ignoredEmptyTemplateReason = "ignored_empty_template";
const paytLeadOtherChannelMessage =
  "Venda de um lead que chegou por outro número; a regra desse número envia o evento";
const overriddenBySpecificRuleMessage =
  "Este número tem uma regra específica para o mesmo evento; ela substitui a regra de todos os números";
/** Callbacks owned by another rule: never an error, never sent by this rule. */
const ownedByAnotherRuleReasons = new Set<string>([
  PAYT_LEAD_OTHER_CHANNEL_REASON,
  PROVIDER_RULE_OVERRIDDEN_REASON,
  PAYT_PRODUCT_NOT_IN_RULE_REASON,
]);
function ownedByAnotherRuleMessage(reasonCode: string | null | undefined) {
  if (reasonCode === PAYT_PRODUCT_NOT_IN_RULE_REASON)
    return "Venda de um produto fora do filtro desta regra";
  return reasonCode === PROVIDER_RULE_OVERRIDDEN_REASON
    ? overriddenBySpecificRuleMessage
    : paytLeadOtherChannelMessage;
}
/**
 * Parsed callbacks that stopped before any decision because the buyer could
 * not be matched to exactly one tracked lead/channel. They carry no frozen
 * decision, so a manual reprocess re-evaluates them from scratch with the
 * current phone matching while every other validation still applies.
 */
const leadMatchingRecoverableReasons = new Set<string>([
  "payt_channel_missing_or_ambiguous",
]);
const visibleAutomationDeliveryWhere = {
  OR: [
    { classification: null },
    {
      classification: {
        notIn: [ignoredUntrackedLeadReason, ignoredEmptyTemplateReason],
      },
    },
  ],
} satisfies Prisma.InboundWebhookDeliveryWhereInput;
const visibleAutomationExecutionWhere = {
  OR: [
    { reasonCode: null },
    {
      reasonCode: {
        notIn: [ignoredUntrackedLeadReason, ignoredEmptyTemplateReason],
      },
    },
  ],
} satisfies Prisma.ProviderConversionRuleExecutionWhereInput;

const publicEndpointInclude = {
  providerRule: {
    include: {
      conversionRule: true,
      connection: {
        include: {
          parserRelease: true,
        },
      },
      parserRelease: true,
      channels: {
        include: {
          channel: true,
        },
      },
    },
  },
} satisfies Prisma.ProviderConversionRuleEndpointInclude;

type LoadedConversionEndpoint =
  Prisma.ProviderConversionRuleEndpointGetPayload<{
    include: typeof publicEndpointInclude;
  }>;

/**
 * An endpoint automation (Umbler/Payt) always keeps its connection binding:
 * the callback is stored on that connection. Only workspace-scoped message/catalog/label rules
 * may be unbound, and those never own an endpoint; one that somehow does is
 * treated as missing (fail closed).
 */
type PublicConversionEndpoint = Omit<LoadedConversionEndpoint, "providerRule"> & {
  providerRule: LoadedConversionEndpoint["providerRule"] & {
    connectionId: string;
    connection: NonNullable<LoadedConversionEndpoint["providerRule"]["connection"]>;
    parserRelease: NonNullable<
      LoadedConversionEndpoint["providerRule"]["parserRelease"]
    >;
  };
};

function asBoundEndpoint(
  endpoint: LoadedConversionEndpoint | null,
): PublicConversionEndpoint | null {
  const rule = endpoint?.providerRule;
  if (!endpoint || !rule?.connectionId || !rule.connection || !rule.parserRelease)
    return null;
  return endpoint as PublicConversionEndpoint;
}

const automationAuditDeliveryInclude = {
  providerConversionExecutions: {
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
    take: 1,
    include: {
      channel: {
        select: {
          id: true,
          channelName: true,
          connectedPhone: true,
        },
      },
    },
  },
  providerConversionDecisions: {
    orderBy: [
      { decisionVersion: "desc" as const },
      { createdAt: "desc" as const },
      { id: "desc" as const },
    ],
    take: 1,
    include: {
      channel: {
        select: {
          id: true,
          channelName: true,
          connectedPhone: true,
        },
      },
    },
  },
} satisfies Prisma.InboundWebhookDeliveryInclude;

type AutomationAuditDelivery = Prisma.InboundWebhookDeliveryGetPayload<{
  include: typeof automationAuditDeliveryInclude;
}>;

/**
 * Production failure of an execution whose frozen decision does not match
 * the stored callback. Recoverable by an explicit reprocess (fresh decision).
 */
const sourceEventMismatchReason = "provider_conversion_source_event_mismatch";

type AutomationObservationStatus =
  | "observed"
  | "eligible"
  | "blocked"
  | "ignored"
  | "invalid_payload"
  | "duplicate";

type AutomationReprocessOutcome =
  ProviderConversionAutomationReprocessBatchItemDto;

/** Fase 4b: the Unnichat automation (a CRM movement in an Unnichat flow). */
type ParsedUnnichatAutomation = ParsedUnnichatAutomationV1 & {
  provider: "unnichat";
  automation: "crm_movement";
  // Deliberately injected from the configured rule. The payload has
  // event_name=Lead for every conversion type and must not decide it.
  eventName: ConversionEventNameDto;
};
type ParsedAutomation =
  | ParsedUmblerAutomationV1
  | ParsedPaytAutomationV1
  | ParsedUnnichatAutomation;
type AutomationParseResult =
  | { ok: true; value: ParsedAutomation }
  | { ok: false; errorCode: string };

export type InboundConversionAutomationIngestionInput = {
  endpointId: string;
  token: unknown;
  contentType: string | undefined;
  providerAttempt: unknown;
  rawBody: Buffer | undefined;
};

export type InboundConversionAutomationIngestionResult = {
  status: "accepted";
  deliveryId: string;
  duplicate: boolean;
  observationStatus: AutomationObservationStatus;
};

/**
 * Fase 5.3: what the rule itself decided for a routed callback (also when
 * the delivery already existed), so the URL única never shows "routed" for
 * a callback the rule ignored, gave to another rule, filtered or blocked.
 * Internal only: never part of a public response.
 */
export type RoutedIngestionResult = InboundConversionAutomationIngestionResult & {
  ruleOutcome: {
    status: AutomationObservationStatus;
    reasonCode: string | null;
  } | null;
};

@Injectable()
export class InboundConversionAutomationIngestionService {
  private readonly logger = new Logger(
    InboundConversionAutomationIngestionService.name,
  );

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv,
    @Inject(InboundWebhookPayloadEncryptionService)
    private readonly encryption: InboundWebhookPayloadEncryptionService,
    @Inject(InboundWebhookProductionQueueService)
    private readonly productionQueue: InboundWebhookProductionQueueService,
    @Inject(ProviderConversionObservationService)
    private readonly conversionObservation: ProviderConversionObservationService,
  ) {}

  async ingest(
    input: InboundConversionAutomationIngestionInput,
  ): Promise<InboundConversionAutomationIngestionResult> {
    this.assertFeatureEnabled();
    const endpoint = await this.authenticateEndpoint(
      input.endpointId,
      input.token,
    );
    const rawBody = this.requireJsonBody(input.contentType, input.rawBody);
    const { ruleOutcome: _internal, ...result } = await this.ingestForEndpoint({
      endpoint,
      rawBody,
      providerAttempt: parseInboundWebhookProviderAttempt(
        input.providerAttempt,
      ),
      integrationEndpointId: null,
    });
    return result;
  }

  /**
   * Fase 5.3: a callback received by a workspace URL (URL única da Payt, URL
   * por evento do Unnichat/Umbler) and routed to this rule. It takes EXACTLY
   * the path of the rule's own URL (same ingress key, delivery, decision,
   * gates, dedupe and manual replay), so the same callback arriving through
   * both URLs is one delivery and at most one send. The rule's own URL may be
   * disabled (publicUrlDisabledAt): it stays the internal anchor. Null when
   * the rule can no longer receive callbacks.
   */
  async ingestRouted(input: {
    workspaceId: string;
    providerRuleId: string;
    rawBody: Buffer;
    providerAttempt: number | null;
    integrationEndpointId: string;
    /** Number the router proved (Umbler: channel.phone or single number). */
    routedChannelId?: string | null;
    /**
     * "Tentar de novo": when the occurrence was first received. A sale from
     * before the rule went to production stays observed, exactly as when it
     * arrived (only the rule's explicit reprocess may send it).
     */
    occurrenceReceivedAt?: Date;
  }): Promise<RoutedIngestionResult | null> {
    this.assertFeatureEnabled();
    const endpoint = await this.loadRoutableEndpoint(
      input.workspaceId,
      input.providerRuleId,
    );
    if (!endpoint) return null;
    return this.ingestForEndpoint({
      endpoint,
      rawBody: input.rawBody,
      providerAttempt: input.providerAttempt,
      integrationEndpointId: input.integrationEndpointId,
      routedChannelId: input.routedChannelId ?? null,
      occurrenceReceivedAt: input.occurrenceReceivedAt,
    });
  }

  private async ingestForEndpoint(input: {
    endpoint: PublicConversionEndpoint;
    rawBody: Buffer;
    providerAttempt: number | null;
    /** Set when the callback came through a workspace URL (Fase 5.3). */
    integrationEndpointId: string | null;
    /** Router-proven number; undefined keeps the one stored on the delivery. */
    routedChannelId?: string | null;
    occurrenceReceivedAt?: Date;
  }): Promise<RoutedIngestionResult> {
    const routedChannelId = input.routedChannelId ?? undefined;
    const { endpoint, rawBody, providerAttempt } = input;
    // The per-rule URL's lastDeliveryAt tells the operator whether the OLD URL
    // still receives ("Desativar URL antiga"); routed callbacks do not move it.
    const touchRuleEndpoint = input.integrationEndpointId === null;
    const payload = JSON.parse(rawBody.toString("utf8")) as unknown;
    const parsed = this.parseAutomation(endpoint, payload);
    const receivedAt = new Date();
    // When the occurrence happened for the production gate (a retry keeps
    // the original receipt time); bookkeeping stays at "now".
    const occurrenceReceivedAt = input.occurrenceReceivedAt ?? receivedAt;
    const ingressKey = parsed.ok
      ? this.parsedIngressKey(endpoint, parsed.value.externalExecutionKey)
      : this.fallbackIngressKey(endpoint, rawBody, receivedAt);
    const existing = await this.findExistingDelivery(
      endpoint.providerRule.connectionId,
      ingressKey,
    );

    if (existing) {
      await this.recordDuplicate(
        endpoint,
        existing.id,
        providerAttempt,
        receivedAt,
        touchRuleEndpoint,
      );
      if (parsed.ok) {
        // The decision and the production check must read the SAME body:
        // production re-parses the stored payload, so the resend is observed
        // from what is stored (replaced by this resend only while no decision
        // has been frozen for the occurrence).
        const effective = await this.reconcileResentPayload({
          endpoint,
          deliveryId: existing.id,
          rawBody,
          receivedAt,
          parsed: parsed.value,
        });
        const observed = await this.observeAutomation({
          endpoint,
          deliveryId: existing.id,
          deliveryReceivedAt: existing.firstReceivedAt,
          parsed: effective.parsed,
          ...(effective.evaluationMode
            ? { evaluationMode: effective.evaluationMode }
            : {}),
          routedChannelId,
        });
        await this.enqueueEligibleObservation(endpoint.workspaceId, observed);
        return {
          status: "accepted",
          deliveryId: existing.id,
          duplicate: true,
          observationStatus: "duplicate",
          ruleOutcome: {
            status: this.automationObservationStatus(observed),
            reasonCode: observed.reasonCode,
          },
        };
      }
      return {
        status: "accepted",
        deliveryId: existing.id,
        duplicate: true,
        observationStatus: "duplicate",
        ruleOutcome: {
          status: ignoredParseErrors.has(parsed.errorCode)
            ? "ignored"
            : "invalid_payload",
          reasonCode: parsed.errorCode,
        },
      };
    }

    const deliveryId = randomUUID();
    const encrypted = this.encryption.encrypt(rawBody, {
      workspaceId: endpoint.workspaceId,
      connectionId: endpoint.providerRule.connectionId,
      deliveryId,
    });
    try {
      await this.persistDelivery({
        endpoint,
        deliveryId,
        ingressKey,
        providerAttempt,
        integrationEndpointId: input.integrationEndpointId,
        rawBodyLength: rawBody.length,
        receivedAt,
        firstReceivedAt: occurrenceReceivedAt,
        encrypted,
        parsed: parsed.ok ? parsed.value : null,
        parseErrorCode: parsed.ok ? null : parsed.errorCode,
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        const duplicate = await this.findExistingDelivery(
          endpoint.providerRule.connectionId,
          ingressKey,
        );
        if (duplicate) {
          await this.recordDuplicate(
            endpoint,
            duplicate.id,
            providerAttempt,
            receivedAt,
            touchRuleEndpoint,
          );
          return {
            status: "accepted",
            deliveryId: duplicate.id,
            duplicate: true,
            observationStatus: "duplicate",
            ruleOutcome: null,
          };
        }
      }
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException(publicPersistenceFailureMessage);
    }

    if (!parsed.ok) {
      const observationStatus = ignoredParseErrors.has(parsed.errorCode)
        ? ("ignored" as const)
        : ("invalid_payload" as const);
      return {
        status: "accepted",
        deliveryId,
        duplicate: false,
        observationStatus,
        ruleOutcome: { status: observationStatus, reasonCode: parsed.errorCode },
      };
    }

    const observed = await this.observeAutomation({
      endpoint,
      deliveryId,
      deliveryReceivedAt: occurrenceReceivedAt,
      parsed: parsed.value,
      routedChannelId,
    });
    await this.enqueueEligibleObservation(endpoint.workspaceId, observed);

    const observationStatus = this.automationObservationStatus(observed);
    return {
      status: "accepted",
      deliveryId,
      duplicate: observed.reasonCode === "purchase_duplicate",
      observationStatus,
      ruleOutcome: { status: observationStatus, reasonCode: observed.reasonCode },
    };
  }

  async reprocessLatestObserved(
    workspaceId: string,
    providerRuleId: string,
    actorUserId: string,
  ): Promise<ProviderConversionAutomationReprocessResultDto> {
    const endpoint = await this.requireProductionAutomationEndpoint(
      workspaceId,
      providerRuleId,
    );
    const rule = endpoint.providerRule;

    const deliveryScope = {
      workspaceId,
      connectionId: rule.connectionId,
      providerRuleEndpointId: endpoint.id,
      purpose: "conversion_automation" as const,
      AND: [visibleAutomationDeliveryWhere],
      payloadExpiresAt: { gt: new Date() },
    };
    const deliveryOrder = [
      { lastReceivedAt: "desc" as const },
      { id: "desc" as const },
    ];
    const observedDecision =
      await this.prisma.providerConversionDecisionAudit.findFirst({
        where: {
          workspaceId,
          providerRuleId: rule.id,
          decisionCode: "eligible",
          supersededBy: { none: {} },
          providerExecution: { is: null },
          sourceDelivery: deliveryScope,
        },
        orderBy: [
          { occurredAt: "desc" },
          { createdAt: "desc" },
          { id: "desc" },
        ],
        select: { sourceDeliveryId: true },
      });
    const observedDelivery = observedDecision
      ? await this.prisma.inboundWebhookDelivery.findFirst({
          where: {
            ...deliveryScope,
            id: observedDecision.sourceDeliveryId,
          },
          orderBy: deliveryOrder,
        })
      : await this.prisma.inboundWebhookDelivery.findFirst({
          where: {
            ...deliveryScope,
            providerConversionExecutions: {
              some: {
                providerRuleId: rule.id,
                status: "observed",
              },
            },
          },
          orderBy: deliveryOrder,
        });
    const delivery =
      observedDelivery ??
      (await this.prisma.inboundWebhookDelivery.findFirst({
        where: {
          ...deliveryScope,
          providerConversionExecutions: {
            none: { providerRuleId: rule.id },
          },
        },
        orderBy: deliveryOrder,
      }));
    if (!delivery) {
      throw new ConflictException("Nenhum callback observado foi encontrado");
    }
    const outcome = await this.reprocessDelivery(
      endpoint,
      delivery.id,
      actorUserId,
    );
    if (outcome.status === "blocked" || outcome.status === "skipped") {
      throw new ConflictException(outcome.message);
    }
    if (!outcome.executionId) {
      throw new ConflictException("O callback ainda não pode ser reprocessado");
    }

    return {
      executionId: outcome.executionId,
      sourceDeliveryId: outcome.deliveryId,
      queueStatus: outcome.status === "existing" ? "existing" : "queued",
    };
  }

  async reevaluateProviderConversionDecision(input: {
    workspaceId: string;
    providerRuleId: string;
    deliveryId: string;
    occurrenceKey: string;
    requestKey: string;
  }): Promise<ProviderConversionAutomationObservationResult> {
    const endpoint = await this.requireAutomationEndpoint(
      input.workspaceId,
      input.providerRuleId,
    );
    const delivery = await this.findAutomationDelivery(
      endpoint,
      input.deliveryId,
    );
    if (delivery.status !== "processed") {
      throw new ConflictException(
        "O callback ainda não pode ser reavaliado",
      );
    }

    const payload = this.decryptAutomationPayload(delivery);
    const parsed = this.parseAutomation(endpoint, payload);
    if (!parsed.ok) {
      throw new ConflictException(
        "O payload não corresponde ao contrato de automação atual",
      );
    }
    if (parsed.value.externalExecutionKey !== input.occurrenceKey) {
      throw new ConflictException(
        "A ocorrência não pertence ao callback informado",
      );
    }

    const observed = await this.observeAutomation({
      endpoint,
      deliveryId: delivery.id,
      deliveryReceivedAt: delivery.firstReceivedAt,
      parsed: parsed.value,
      manualRecovery: true,
      evaluationMode: {
        type: "reevaluate",
        requestKey: input.requestKey,
      },
    });
    await this.enqueueEligibleObservation(input.workspaceId, observed);

    return observed;
  }

  async listAutomationCallbacks(
    workspaceId: string,
    providerRuleId: string,
  ): Promise<ProviderConversionAutomationAuditDto> {
    const endpoint = await this.requireAutomationEndpoint(
      workspaceId,
      providerRuleId,
    );
    const now = new Date();
    const scope = {
      workspaceId,
      connectionId: endpoint.providerRule.connectionId,
      providerRuleEndpointId: endpoint.id,
      purpose: "conversion_automation" as const,
      AND: [visibleAutomationDeliveryWhere],
    };
    const currentDecisionWithoutExecutionScope = {
      workspaceId,
      providerRuleId,
      supersededBy: { none: {} },
      providerExecution: { is: null },
      sourceDelivery: scope,
    } satisfies Prisma.ProviderConversionDecisionAuditWhereInput;
    const retainedPayloadWhere = {
      payloadExpiresAt: { gt: now },
      encryptedPayload: { not: null },
      payloadIv: { not: null },
      payloadTag: { not: null },
      encryptionKeyVersion: { not: null },
    } satisfies Prisma.InboundWebhookDeliveryWhereInput;
    const [
      deliveries,
      total,
      executionGroups,
      decisionGroups,
      recoverableExecutions,
      recoverableDecisions,
    ] = await Promise.all([
      this.prisma.inboundWebhookDelivery.findMany({
        where: scope,
        include: automationAuditDeliveryInclude,
        orderBy: [{ lastReceivedAt: "desc" }, { id: "desc" }],
        take: 100,
      }),
      this.prisma.inboundWebhookDelivery.count({ where: scope }),
      this.prisma.providerConversionRuleExecution.groupBy({
        by: ["status"],
        where: {
          workspaceId,
          providerRuleId,
          AND: [visibleAutomationExecutionWhere],
          sourceDelivery: scope,
        },
        _count: { _all: true },
      }),
      this.prisma.providerConversionDecisionAudit.groupBy({
        by: ["decisionCode"],
        where: currentDecisionWithoutExecutionScope,
        _count: { _all: true },
      }),
      this.prisma.providerConversionRuleExecution.count({
        where: {
          workspaceId,
          providerRuleId,
          AND: [visibleAutomationExecutionWhere],
          OR: [
            { status: { in: ["observed", "eligible", "blocked"] } },
            {
              status: "failed",
              normalizedResult: {
                path: ["technicalDelivery", "retryable"],
                equals: true,
              },
            },
            { status: "failed", reasonCode: sourceEventMismatchReason },
          ],
          sourceDelivery: {
            AND: [visibleAutomationDeliveryWhere],
            ...retainedPayloadWhere,
          },
        },
      }),
      this.prisma.providerConversionDecisionAudit.count({
        where: {
          ...currentDecisionWithoutExecutionScope,
          decisionCode: "eligible",
          sourceDelivery: {
            ...scope,
            ...retainedPayloadWhere,
          },
        },
      }),
    ]);
    const executionCounts = new Map(
      executionGroups.map((group) => [group.status, group._count._all]),
    );
    const decisionCounts = new Map(
      decisionGroups.map((group) => [group.decisionCode, group._count._all]),
    );
    const executionCount = executionGroups.reduce(
      (sum, group) => sum + group._count._all,
      0,
    );
    const decisionCount = decisionGroups.reduce(
      (sum, group) => sum + group._count._all,
      0,
    );

    const items = deliveries.map((delivery) =>
      this.automationAuditItem(delivery, now),
    );
    // Lead-matching blocks have no execution/decision row; they are counted
    // from the listed callbacks instead of as invalid payloads.
    const leadMatchingBlocked = items.filter(
      (item) =>
        !item.executionId &&
        item.status === "blocked" &&
        leadMatchingRecoverableReasons.has(item.reasonCode ?? ""),
    );
    const leadMatchingRecoverable = leadMatchingBlocked.filter(
      (item) => item.reprocessable,
    ).length;
    // A sale owned by the rule of another number is not an invalid payload.
    const otherChannelIgnored = items.filter(
      (item) =>
        !item.executionId &&
        item.status === "ignored" &&
        ownedByAnotherRuleReasons.has(item.reasonCode ?? ""),
    ).length;
    // Postbacks of another status/event this rule does not take are ignored.
    const ignoredParseCount = items.filter(
      (item) =>
        !item.executionId &&
        item.status === "ignored" &&
        ignoredParseErrors.has(item.reasonCode ?? ""),
    ).length;

    return {
      providerRuleId,
      summary: {
        total,
        observed:
          (executionCounts.get("observed") ?? 0) +
          (decisionCounts.get("eligible") ?? 0),
        blocked:
          (executionCounts.get("blocked") ?? 0) +
          (decisionCounts.get("review_required") ?? 0) +
          leadMatchingBlocked.length,
        queued: executionCounts.get("eligible") ?? 0,
        materialized: executionCounts.get("materialized") ?? 0,
        failed: executionCounts.get("failed") ?? 0,
        invalid: Math.max(
          total -
            executionCount -
            decisionCount -
            leadMatchingBlocked.length -
            otherChannelIgnored -
            ignoredParseCount,
          0,
        ),
        recoverable:
          recoverableExecutions +
          recoverableDecisions +
          leadMatchingRecoverable,
      },
      items,
    };
  }

  async readAutomationPayload(
    workspaceId: string,
    providerRuleId: string,
    deliveryId: string,
    actorUserId: string,
  ): Promise<ProviderConversionAutomationPayloadDto> {
    const endpoint = await this.requireAutomationEndpoint(
      workspaceId,
      providerRuleId,
    );
    const delivery = await this.findAutomationDelivery(endpoint, deliveryId);
    const payload = this.decryptAutomationPayload(delivery);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ConflictException("O payload preservado não é um objeto JSON");
    }

    await this.prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId,
        actorType: "user",
        action: "provider_conversion_automation.payload.read",
        targetType: "InboundWebhookDelivery",
        targetId: delivery.id,
        reason: "Explicit workspace callback audit",
        sourceIp: null,
        resultStatus: "success",
        afterSummary: this.toJson({ providerRuleId }),
      },
    });

    return {
      providerRuleId,
      deliveryId: delivery.id,
      receivedAt: delivery.firstReceivedAt.toISOString(),
      payloadExpiresAt: delivery.payloadExpiresAt.toISOString(),
      payload: payload as Record<string, unknown>,
    };
  }

  async reprocessSelectedCallbacks(
    workspaceId: string,
    providerRuleId: string,
    deliveryIds: string[],
    actorUserId: string,
  ): Promise<ProviderConversionAutomationReprocessBatchResultDto> {
    const { endpoint, observationOnly } =
      await this.requireReprocessableAutomationEndpoint(
        workspaceId,
        providerRuleId,
      );
    const selected = [...new Set(deliveryIds)].slice(0, 50);
    const items: ProviderConversionAutomationReprocessBatchItemDto[] = [];

    for (const deliveryId of selected) {
      try {
        items.push(
          await this.reprocessDelivery(endpoint, deliveryId, actorUserId, {
            observationOnly,
          }),
        );
      } catch (error) {
        items.push({
          deliveryId,
          executionId: null,
          status: "skipped",
          reasonCode: "reprocess_failed",
          message:
            error instanceof Error
              ? error.message
              : "Não foi possível reprocessar este callback",
        });
      }
    }

    return {
      providerRuleId,
      requested: selected.length,
      queued: items.filter((item) =>
        ["queued", "existing", "eligible"].includes(item.status),
      ).length,
      blocked: items.filter((item) => item.status === "blocked").length,
      skipped: items.filter((item) => item.status === "skipped").length,
      observed: items.filter((item) => item.status === "observed").length,
      items,
    };
  }

  /**
   * Production rules keep the strict production gate. A rule still in
   * observation may be reprocessed too, but only to RE-EVALUATE and record the
   * decision (observed): nothing is ever queued for Meta from this mode.
   */
  private async requireReprocessableAutomationEndpoint(
    workspaceId: string,
    providerRuleId: string,
  ): Promise<{ endpoint: PublicConversionEndpoint; observationOnly: boolean }> {
    const endpoint = await this.requireAutomationEndpoint(
      workspaceId,
      providerRuleId,
    );
    const rule = endpoint.providerRule;
    if (rule.mode === "observation") {
      if (rule.parserRelease.version !== UMBLER_AUTOMATION_V1_PARSER_VERSION) {
        throw new ConflictException(
          "Ative o envio automático da regra antes de reprocessar callbacks",
        );
      }
      return { endpoint, observationOnly: true };
    }

    return {
      endpoint: await this.requireProductionAutomationEndpoint(
        workspaceId,
        providerRuleId,
      ),
      observationOnly: false,
    };
  }

  private async requireAutomationEndpoint(
    workspaceId: string,
    providerRuleId: string,
  ): Promise<PublicConversionEndpoint> {
    this.assertFeatureEnabled();
    const endpoint = asBoundEndpoint(
      await this.prisma.providerConversionRuleEndpoint.findFirst({
        where: {
          workspaceId,
          providerRuleId,
          removedAt: null,
        },
        include: publicEndpointInclude,
      }),
    );
    const rule = endpoint?.providerRule;
    if (
      !endpoint ||
      !rule ||
      rule.removedAt ||
      !rule.conversionRule.active ||
      rule.conversionRule.triggerType !== "provider_automation" ||
      rule.connection.removedAt
    ) {
      throw new NotFoundException("Regra de automacao Umbler nao encontrada");
    }

    return endpoint;
  }

  private async requireProductionAutomationEndpoint(
    workspaceId: string,
    providerRuleId: string,
  ): Promise<PublicConversionEndpoint> {
    const config = parseInboundWebhooksConfig(this.env);
    if (
      !config.enabled ||
      !config.productionEnabled ||
      !config.conversionRulesEnabled ||
      !config.conversionProductionEnabled
    ) {
      throw new ServiceUnavailableException(
        "O processamento de conversoes da Umbler esta desativado",
      );
    }
    const endpoint = await this.requireAutomationEndpoint(
      workspaceId,
      providerRuleId,
    );
    const rule = endpoint.providerRule;
    if (
      rule.mode !== "production" ||
      !rule.productionActivatedAt ||
      !inboundParserProductionEligible(rule.parserRelease) ||
      rule.parserRelease.version !== UMBLER_AUTOMATION_V1_PARSER_VERSION ||
      rule.connection.status !== "production" ||
      !inboundParserProductionEligible(rule.connection.parserRelease)
    ) {
      throw new ConflictException(
        "Ative o envio automático da regra antes de reprocessar callbacks",
      );
    }

    return endpoint;
  }

  private async findAutomationDelivery(
    endpoint: PublicConversionEndpoint,
    deliveryId: string,
  ): Promise<AutomationAuditDelivery> {
    const delivery = await this.prisma.inboundWebhookDelivery.findFirst({
      where: {
        id: deliveryId,
        workspaceId: endpoint.workspaceId,
        connectionId: endpoint.providerRule.connectionId,
        providerRuleEndpointId: endpoint.id,
        purpose: "conversion_automation",
      },
      include: automationAuditDeliveryInclude,
    });
    if (!delivery) {
      throw new NotFoundException("Callback nao encontrado nesta regra");
    }

    return delivery;
  }

  private decryptAutomationPayload(delivery: AutomationAuditDelivery): unknown {
    if (
      delivery.payloadExpiresAt <= new Date() ||
      !delivery.encryptedPayload ||
      !delivery.payloadIv ||
      !delivery.payloadTag ||
      !delivery.encryptionKeyVersion
    ) {
      throw new ConflictException(
        "O payload deste callback não está mais disponível",
      );
    }

    try {
      const rawBody = this.encryption.decrypt(
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
      return JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch {
      throw new ConflictException(
        "O payload preservado não pode ser descriptografado",
      );
    }
  }

  private automationAuditItem(
    delivery: AutomationAuditDelivery,
    now: Date,
  ): ProviderConversionAutomationAuditItemDto {
    const execution = delivery.providerConversionExecutions[0] ?? null;
    const decision = delivery.providerConversionDecisions[0] ?? null;
    const executionNormalized = this.jsonRecord(execution?.normalizedResult);
    const deliveryNormalized = this.jsonRecord(delivery.normalizedSummary);
    const payloadAvailable = Boolean(
      delivery.payloadExpiresAt > now &&
      delivery.encryptedPayload &&
      delivery.payloadIv &&
      delivery.payloadTag &&
      delivery.encryptionKeyVersion,
    );
    const leadMatchingBlock =
      !execution &&
      !decision &&
      deliveryNormalized?.parserStatus === "parsed" &&
      deliveryNormalized?.executionStatus === "blocked" &&
      typeof deliveryNormalized.reasonCode === "string" &&
      leadMatchingRecoverableReasons.has(deliveryNormalized.reasonCode);
    const otherChannel =
      !execution &&
      !decision &&
      deliveryNormalized?.parserStatus === "parsed" &&
      typeof deliveryNormalized?.reasonCode === "string" &&
      ownedByAnotherRuleReasons.has(deliveryNormalized.reasonCode);
    // A postback of another status/event (canceled, refunded, an event this
    // rule does not take) was parsed and deliberately ignored: audit-only
    // classification, never an invalid payload.
    const ignoredParse =
      !execution &&
      !decision &&
      (ignoredParseErrors.has(delivery.parseErrorCode ?? "") ||
        deliveryNormalized?.parserStatus === "not_purchase");
    const status = leadMatchingBlock
      ? "blocked"
      : otherChannel || ignoredParse
        ? "ignored"
        : (execution?.status ??
          this.automationDecisionAuditStatus(decision?.decisionCode ?? null));
    const channel = execution?.channel ?? decision?.channel ?? null;

    return {
      deliveryId: delivery.id,
      executionId: execution?.id ?? null,
      receivedAt: delivery.firstReceivedAt.toISOString(),
      lastReceivedAt: delivery.lastReceivedAt.toISOString(),
      providerEventType: delivery.providerEventType,
      eventName: this.conversionEventName(
        executionNormalized?.eventName ??
          decision?.eventName ??
          deliveryNormalized?.eventName,
      ),
      automation:
        typeof executionNormalized?.automation === "string"
          ? executionNormalized.automation
          : typeof deliveryNormalized?.automation === "string"
            ? deliveryNormalized.automation
            : delivery.providerEventType,
      status,
      reasonCode:
        execution?.reasonCode ??
        decision?.reasonCode ??
        (typeof deliveryNormalized?.reasonCode === "string"
          ? deliveryNormalized.reasonCode
          : null) ??
        delivery.routingErrorCode ??
        delivery.parseErrorCode,
      attemptCount: delivery.attemptCount,
      executionAttemptCount: execution?.attemptCount ?? 0,
      channel: channel
        ? {
            id: channel.id,
            name: channel.channelName,
            connectedPhone: channel.connectedPhone,
          }
        : null,
      leadResolved:
        Boolean(execution?.leadId ?? decision?.leadId) ||
        deliveryNormalized?.paidLeadResolved === true,
      payloadAvailable,
      payloadExpiresAt: delivery.payloadExpiresAt.toISOString(),
      reprocessable:
        payloadAvailable &&
        (execution
          ? ["observed", "eligible", "blocked"].includes(execution.status) ||
            (execution.status === "failed" &&
              (this.retryableTechnicalFailure(execution.normalizedResult) ||
                this.sourceEventMismatchFailure(execution)))
          : decision?.decisionCode === "eligible" || leadMatchingBlock),
    };
  }

  private automationDecisionAuditStatus(
    decisionCode: string | null,
  ): ProviderConversionAutomationAuditItemDto["status"] {
    if (decisionCode === "review_required") return "blocked";
    if (decisionCode === "duplicate") return "duplicate";
    return decisionCode === "eligible" ? "observed" : "invalid_payload";
  }

  private async reprocessDelivery(
    endpoint: PublicConversionEndpoint,
    deliveryId: string,
    actorUserId: string,
    options: { observationOnly?: boolean } = {},
  ): Promise<AutomationReprocessOutcome> {
    const workspaceId = endpoint.workspaceId;
    const delivery = await this.findAutomationDelivery(endpoint, deliveryId);
    const currentExecution = delivery.providerConversionExecutions[0] ?? null;
    if (options.observationOnly) {
      return this.reevaluateDeliveryInObservation({
        endpoint,
        delivery,
        currentExecution,
        actorUserId,
      });
    }

    if (currentExecution?.status === "materialized") {
      return {
        deliveryId,
        executionId: currentExecution.id,
        status: "skipped",
        reasonCode: "already_materialized",
        message:
          "Este callback já criou um evento; acompanhe a entrega em Eventos Meta",
      };
    }
    if (currentExecution?.status === "duplicate") {
      return {
        deliveryId,
        executionId: currentExecution?.id ?? null,
        status: "skipped",
        reasonCode: "execution_duplicate",
        message: "Este callback foi identificado como duplicado",
      };
    }
    if (currentExecution?.status === "eligible") {
      return this.enqueueManualExecution({
        workspaceId,
        deliveryId,
        executionId: currentExecution.id,
        reasonCode: currentExecution.reasonCode,
        retryingFailure: false,
      });
    }
    // A decision frozen from a body that is not the stored one (a provider
    // resend before the payload reconciliation existed) fails production
    // forever; reusing it would repeat the failure. Only for this reason the
    // reprocess re-evaluates the stored body into a fresh decision. Every
    // other failure keeps its frozen decision.
    const sourceMismatch = this.sourceEventMismatchFailure(currentExecution);
    if (
      currentExecution?.status === "failed" &&
      currentExecution.providerDecisionId &&
      !sourceMismatch
    ) {
      if (!this.retryableTechnicalFailure(currentExecution.normalizedResult)) {
        return {
          deliveryId,
          executionId: currentExecution.id,
          status: "skipped",
          reasonCode: currentExecution.reasonCode ?? "failed_permanent",
          message:
            "A falha é permanente; use uma reavaliação explícita depois de corrigir os dados",
        };
      }

      return this.enqueueManualExecution({
        workspaceId,
        deliveryId,
        executionId: currentExecution.id,
        reasonCode: currentExecution.reasonCode,
        retryingFailure: true,
      });
    }

    const payload = this.decryptAutomationPayload(delivery);
    const parsed = this.parseAutomation(endpoint, payload);
    if (!parsed.ok) {
      return {
        deliveryId,
        executionId: currentExecution?.id ?? null,
        status: "skipped",
        reasonCode: parsed.errorCode,
        message: "O payload não corresponde ao contrato de automação atual",
      };
    }
    const observed = await this.observeAutomation({
      endpoint,
      deliveryId,
      deliveryReceivedAt: delivery.firstReceivedAt,
      parsed: parsed.value,
      manualRecovery: true,
      ...(sourceMismatch && currentExecution
        ? {
            evaluationMode: {
              type: "reevaluate" as const,
              requestKey: `source-mismatch-reprocess:${currentExecution.id}:${randomUUID()}`,
              recordInitialWhenMissing: true,
            },
          }
        : {}),
      // Production-mode explicit replay by an authorized manager: the
      // resulting eligible execution carries the approval (audited in the
      // same transaction) that lets the worker accept a callback received
      // before the rule/channel production activation. Every other gate
      // (connection, parser, certification, scope, canonical, dedupe) stays.
      manualReplayApproval: {
        actorUserId,
        reason: "operator_reprocess",
      },
    });
    await this.recordManualReprocessAudit({
      endpoint,
      deliveryId,
      actorUserId,
      observed,
    });

    if (observed.eligibleExecutionId) {
      return this.enqueueManualExecution({
        workspaceId,
        deliveryId,
        executionId: observed.eligibleExecutionId,
        reasonCode: observed.reasonCode,
        retryingFailure: false,
      });
    }
    if (observed.decisionCode === "review_required") {
      return {
        deliveryId,
        executionId: observed.executionId,
        status: "blocked",
        reasonCode: observed.reasonCode,
        message: "O callback exige revisão operacional antes do envio",
      };
    }
    if (observed.disposition === "blocked") {
      return {
        deliveryId,
        executionId: observed.executionId,
        status: "blocked",
        reasonCode: observed.reasonCode,
        message: sourceMismatch
          ? "Os dados salvos deste callback não identificam a compra neste número; reenvie o postback na plataforma para atualizar"
          : this.manualReprocessBlockMessage(observed.reasonCode),
      };
    }
    if (observed.disposition === "observed") {
      return {
        deliveryId,
        executionId: observed.executionId,
        status: "skipped",
        reasonCode: observed.reasonCode,
        message: "A regra ainda permanece em observação",
      };
    }

    return {
      deliveryId,
      executionId: observed.executionId,
      status: "skipped",
      reasonCode: observed.reasonCode,
      message:
        observed.reasonCode === ignoredUntrackedLeadReason
          ? "Callback ignorado porque o contato não pertence aos leads pagos rastreados"
          : ownedByAnotherRuleReasons.has(observed.reasonCode)
            ? ownedByAnotherRuleMessage(observed.reasonCode)
            : observed.reasonCode === "purchase_duplicate"
              ? "Venda já reconhecida em outro callback; nada novo será enviado"
              : "O callback não exige envio para a Meta",
    };
  }

  /**
   * Observation-mode reprocess: re-evaluate the preserved payload with the
   * current matching and record the decision as observed. Never enqueues a
   * production job, so nothing reaches Meta.
   */
  private async reevaluateDeliveryInObservation(input: {
    endpoint: PublicConversionEndpoint;
    delivery: AutomationAuditDelivery;
    currentExecution:
      | AutomationAuditDelivery["providerConversionExecutions"][number]
      | null;
    actorUserId: string;
  }): Promise<AutomationReprocessOutcome> {
    const { endpoint, delivery, currentExecution } = input;
    const deliveryId = delivery.id;
    if (
      currentExecution &&
      ["materialized", "duplicate", "eligible", "failed"].includes(
        currentExecution.status,
      )
    ) {
      return {
        deliveryId,
        executionId: currentExecution.id,
        status: "skipped",
        reasonCode: "rule_in_observation",
        message:
          currentExecution.status === "materialized"
            ? "Este callback já criou um evento; acompanhe a entrega em Eventos Meta"
            : "A regra está em observação; ative o envio automático para encaminhar este callback",
      };
    }
    const payload = this.decryptAutomationPayload(delivery);
    const parsed = this.parseAutomation(endpoint, payload);
    if (!parsed.ok) {
      return {
        deliveryId,
        executionId: currentExecution?.id ?? null,
        status: "skipped",
        reasonCode: parsed.errorCode,
        message: "O payload não corresponde ao contrato de automação atual",
      };
    }
    const observed = await this.observeAutomation({
      endpoint,
      deliveryId,
      deliveryReceivedAt: delivery.firstReceivedAt,
      parsed: parsed.value,
      manualRecovery: true,
      evaluationMode: {
        type: "reevaluate",
        requestKey: `observation-reprocess:${deliveryId}:${randomUUID()}`,
        recordInitialWhenMissing: true,
      },
    });
    await this.recordManualReprocessAudit({
      endpoint,
      deliveryId,
      actorUserId: input.actorUserId,
      observed,
    });

    if (observed.reasonCode === "purchase_duplicate") {
      return {
        deliveryId,
        executionId: observed.executionId,
        status: "skipped",
        reasonCode: observed.reasonCode,
        message:
          "Venda já reconhecida em outro callback; nada novo será enviado",
      };
    }
    if (
      observed.decisionCode === "eligible" &&
      observed.executionId &&
      observed.disposition === "observed"
    ) {
      return {
        deliveryId,
        executionId: observed.executionId,
        status: "observed",
        reasonCode: observed.reasonCode,
        message:
          "Reavaliado em observação: conversão reconhecida, nada enviado à Meta",
      };
    }
    if (
      observed.decisionCode === "review_required" ||
      observed.disposition === "blocked"
    ) {
      return {
        deliveryId,
        executionId: observed.executionId,
        status: "blocked",
        reasonCode: observed.reasonCode,
        message:
          observed.decisionCode === "review_required"
            ? "O callback exige revisão operacional antes do envio"
            : this.manualReprocessBlockMessage(observed.reasonCode),
      };
    }

    return {
      deliveryId,
      executionId: observed.executionId,
      status: "skipped",
      reasonCode: observed.reasonCode,
      message: ownedByAnotherRuleReasons.has(observed.reasonCode)
        ? ownedByAnotherRuleMessage(observed.reasonCode)
        : observed.reasonCode === ignoredUntrackedLeadReason
          ? "Callback ignorado porque o contato não pertence aos leads pagos rastreados"
          : "O callback não exige envio para a Meta",
    };
  }

  private async enqueueManualExecution(input: {
    workspaceId: string;
    deliveryId: string;
    executionId: string;
    reasonCode: string | null;
    retryingFailure: boolean;
  }): Promise<AutomationReprocessOutcome> {
    const attemptedAt = new Date();
    const queued = await this.productionQueue.enqueueProviderConversion(
      {
        providerConversionExecutionId: input.executionId,
        workspaceId: input.workspaceId,
      },
      {
        attemptKey: `manual-${attemptedAt.getTime()}`,
      },
    );

    return {
      deliveryId: input.deliveryId,
      executionId: input.executionId,
      status: queued.status,
      reasonCode: input.reasonCode,
      message:
        queued.status === "queued"
          ? input.retryingFailure
            ? "Falha transitória encaminhada para uma nova tentativa"
            : "Callback encaminhado para a fila da Meta"
          : "Callback já estava na fila da Meta",
    };
  }

  private sourceEventMismatchFailure(
    execution: { status: string; reasonCode: string | null } | null,
  ): boolean {
    return (
      execution?.status === "failed" &&
      execution.reasonCode === sourceEventMismatchReason
    );
  }

  private retryableTechnicalFailure(
    normalizedResult: Prisma.JsonValue | null,
  ): boolean {
    const normalized = this.jsonRecord(normalizedResult);
    const technicalDelivery = this.jsonRecord(
      normalized?.technicalDelivery as Prisma.JsonValue | undefined,
    );

    return (
      technicalDelivery?.state === "failed_retryable" &&
      technicalDelivery.retryable === true
    );
  }

  private async recordManualReprocessAudit(input: {
    endpoint: PublicConversionEndpoint;
    deliveryId: string;
    actorUserId: string;
    observed: ProviderConversionAutomationObservationResult;
  }): Promise<void> {
    const targetType = input.observed.executionId
      ? "ProviderConversionRuleExecution"
      : input.observed.decisionId
        ? "ProviderConversionDecisionAudit"
        : "InboundWebhookDelivery";
    const targetId =
      input.observed.executionId ??
      input.observed.decisionId ??
      input.deliveryId;

    await this.prisma.auditLog.create({
      data: {
        workspaceId: input.endpoint.workspaceId,
        actorUserId: input.actorUserId,
        actorType: "user",
        action: "provider_conversion_automation.manual_reprocess",
        targetType,
        targetId,
        reason: "Explicit callback replay using the frozen decision",
        sourceIp: null,
        resultStatus: input.observed.disposition,
        afterSummary: this.toJson({
          providerRuleId: input.endpoint.providerRule.id,
          sourceDeliveryId: input.deliveryId,
          decisionId: input.observed.decisionId,
          decisionCode: input.observed.decisionCode,
          reasonCode: input.observed.reasonCode,
          disposition: input.observed.disposition,
        }),
      },
    });
  }

  private jsonRecord(
    value: Prisma.JsonValue | null | undefined,
  ): Record<string, Prisma.JsonValue> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, Prisma.JsonValue>)
      : null;
  }

  private conversionEventName(
    value: Prisma.JsonValue | undefined,
  ): ProviderConversionAutomationAuditItemDto["eventName"] {
    // Any catalog event may reach the audit screens now that tag rules are
    // not limited to QualifiedLead/Purchase.
    const parsed = conversionEventNameSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  private assertFeatureEnabled(): void {
    const config = parseInboundWebhooksConfig(this.env);
    if (!config.enabled || !config.conversionRulesEnabled) {
      throw new NotFoundException(publicEndpointNotFoundMessage);
    }
  }

  private async authenticateEndpoint(
    endpointId: string,
    token: unknown,
  ): Promise<PublicConversionEndpoint> {
    let endpoint: PublicConversionEndpoint | null;
    try {
      endpoint = asBoundEndpoint(
        await this.prisma.providerConversionRuleEndpoint.findUnique({
          where: { id: endpointId },
          include: publicEndpointInclude,
        }),
      );
    } catch {
      throw new ServiceUnavailableException(publicPersistenceFailureMessage);
    }

    const tokenMatches = matchesInboundWebhookSecret(
      endpoint?.secretHash,
      token,
    );
    const rule = endpoint?.providerRule;
    // Payt rules intentionally sit on the WhatsApp connection of their
    // numbers. The persisted parser release, not that connection's provider,
    // identifies the callback contract.
    const isPaytAutomation =
      rule?.parserRelease.provider === "payt" &&
      rule?.parserRelease.version === PAYT_AUTOMATION_V1_PARSER_VERSION;

    if (
      !endpoint ||
      !rule ||
      !tokenMatches ||
      endpoint.removedAt !== null ||
      // Fase 5.3, "Desativar URL antiga": only this public address is closed
      // (same generic 404); the rule keeps receiving through the workspace URL.
      endpoint.publicUrlDisabledAt != null ||
      rule.removedAt !== null ||
      !rule.conversionRule.active ||
      rule.conversionRule.triggerType !== "provider_automation" ||
      (!isPaytAutomation &&
        rule.connection.provider !== "umbler" &&
        rule.connection.provider !== "unnichat") ||
      rule.connection.removedAt !== null ||
      !["observation", "production"].includes(rule.connection.status) ||
      rule.parserRelease.status === "retired"
    ) {
      throw new NotFoundException(publicEndpointNotFoundMessage);
    }

    return endpoint;
  }

  /**
   * Fase 5.3: internal lookup for a routed callback. The same validity checks
   * as the public URL (rule live and active, automation trigger, supported
   * contract, connection live, parser not retired) except the token and the
   * per-rule URL switch.
   */
  private async loadRoutableEndpoint(
    workspaceId: string,
    providerRuleId: string,
  ): Promise<PublicConversionEndpoint | null> {
    let endpoint: PublicConversionEndpoint | null;
    try {
      endpoint = asBoundEndpoint(
        await this.prisma.providerConversionRuleEndpoint.findFirst({
          where: { workspaceId, providerRuleId, removedAt: null },
          include: publicEndpointInclude,
        }),
      );
    } catch {
      throw new ServiceUnavailableException(publicPersistenceFailureMessage);
    }
    const rule = endpoint?.providerRule;
    const isPaytAutomation =
      rule?.parserRelease.provider === "payt" &&
      rule?.parserRelease.version === PAYT_AUTOMATION_V1_PARSER_VERSION;
    if (
      !endpoint ||
      !rule ||
      rule.removedAt !== null ||
      !rule.conversionRule.active ||
      rule.conversionRule.triggerType !== "provider_automation" ||
      (!isPaytAutomation &&
        rule.connection.provider !== "umbler" &&
        rule.connection.provider !== "unnichat") ||
      rule.connection.removedAt !== null ||
      !["observation", "production"].includes(rule.connection.status) ||
      rule.parserRelease.status === "retired"
    ) {
      return null;
    }
    return endpoint;
  }

  private requireJsonBody(
    contentType: string | undefined,
    rawBody: Buffer | undefined,
  ): Buffer {
    const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      throw new UnsupportedMediaTypeException(
        "Webhook requer Content-Type application/json",
      );
    }
    if (!rawBody || rawBody.length === 0) {
      throw new BadRequestException("Payload JSON obrigatorio");
    }
    if (rawBody.length > MAX_INBOUND_WEBHOOK_PAYLOAD_BYTES) {
      throw new PayloadTooLargeException("Payload do webhook excede o limite");
    }
    try {
      JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new BadRequestException("Payload JSON invalido");
    }
    return rawBody;
  }

  private parseAutomation(
    endpoint: PublicConversionEndpoint,
    payload: unknown,
  ): AutomationParseResult {
    const rule = endpoint.providerRule;
    if (
      rule.parserRelease.provider === "payt" &&
      rule.parserRelease.version === PAYT_AUTOMATION_V1_PARSER_VERSION
    ) {
      // A Payt postback may be Purchase, InitiateCheckout or CartAbandoned. A
      // rule only takes its own event; any other one is ignored (never an
      // error), exactly like a non-purchase on a Purchase rule.
      const notThisRule =
        rule.conversionRule.eventName === "Purchase"
          ? "payt_automation_v1_not_purchase"
          : "payt_automation_v1_event_not_in_rule";
      // Classify the event FIRST: a postback of another event (or of an
      // unsupported status) is ignored before identity/phone/value are
      // judged.
      if (paytSaleEventNameOf(payload) !== rule.conversionRule.eventName) {
        return { ok: false, errorCode: notThisRule };
      }
      // Purchase rules keep the validated Purchase-only contract.
      const parsed =
        rule.conversionRule.eventName === "Purchase"
          ? parsePaytAutomationV1(payload)
          : parsePaytSaleEventV1(payload);
      if (!parsed.ok) {
        return parsed.errorCode === "payt_sale_v1_status_not_supported"
          ? { ok: false, errorCode: notThisRule }
          : { ok: false, errorCode: parsed.errorCode };
      }
      if (parsed.value.eventName !== rule.conversionRule.eventName) {
        return { ok: false, errorCode: notThisRule };
      }
      return {
        ok: true,
        value: {
          ...parsed.value,
          externalExecutionKey: buildProviderPurchaseIdentity({
            workspaceId: endpoint.workspaceId,
            provider: "payt",
            accountRef: parsed.value.accountRef,
            orderRef: parsed.value.orderRef,
            eventName: parsed.value.eventName,
          }),
        },
      };
    }
    if (
      rule.parserRelease.provider === "umbler" &&
      rule.parserRelease.version === UMBLER_AUTOMATION_V1_PARSER_VERSION
    ) {
      return parseUmblerAutomationV1(payload);
    }
    if (
      rule.parserRelease.provider === "unnichat" &&
      rule.parserRelease.version === UNNICHAT_AUTOMATION_V1_PARSER_VERSION
    ) {
      const parsed = parseUnnichatAutomationV1(payload);
      if (!parsed.ok) return parsed;

      return {
        ok: true,
        value: {
          ...parsed.value,
          provider: "unnichat",
          automation: "crm_movement",
          eventName: conversionEventNameSchema.parse(
            rule.conversionRule.eventName,
          ),
        },
      };
    }
    return { ok: false, errorCode: "automation_parser_unavailable" };
  }

  private automationParserVersion(endpoint: PublicConversionEndpoint): string {
    return endpoint.providerRule.parserRelease.version;
  }

  private automationIngressNamespace(
    endpoint: PublicConversionEndpoint,
  ): string {
    switch (endpoint.providerRule.parserRelease.provider) {
      case "payt":
        return "payt-automation-v1";
      case "unnichat":
        return "unnichat-automation-v1";
      default:
        return "umbler-automation-v1";
    }
  }

  private parsedIngressKey(
    endpoint: PublicConversionEndpoint,
    externalExecutionKey: string,
  ): string {
    return createHash("sha256")
      .update(`${this.automationIngressNamespace(endpoint)}\0`, "utf8")
      .update(endpoint.id, "utf8")
      .update("\0", "utf8")
      .update(externalExecutionKey, "utf8")
      .digest("hex");
  }

  private fallbackIngressKey(
    endpoint: PublicConversionEndpoint,
    rawBody: Buffer,
    receivedAt: Date,
  ): string {
    const bucket = Math.floor(receivedAt.getTime() / fallbackDedupeWindowMs);
    return createHash("sha256")
      .update(
        `${this.automationIngressNamespace(endpoint)}-fallback-v1\0`,
        "utf8",
      )
      .update(endpoint.id, "utf8")
      .update("\0", "utf8")
      .update(String(bucket), "utf8")
      .update("\0", "utf8")
      .update(rawBody)
      .digest("hex");
  }

  private async observeAutomation(input: {
    endpoint: PublicConversionEndpoint;
    deliveryId: string;
    deliveryReceivedAt: Date;
    parsed: ParsedAutomation;
    manualRecovery?: boolean;
    evaluationMode?: ProviderConversionEvaluationMode;
    manualReplayApproval?: ProviderConversionManualReplayApproval;
    /**
     * Fase 5.3: number proven by the URL por evento (Umbler). Undefined =
     * the one stored on the delivery by a previous routed evaluation, so a
     * reprocess or a resend by the old URL decides the same number.
     */
    routedChannelId?: string;
  }): Promise<ProviderConversionAutomationObservationResult> {
    const routedChannelId =
      input.routedChannelId ??
      (await this.storedRoutedChannelId(input.endpoint, input.deliveryId));
    const observed = await this.conversionObservation.observeAutomation({
      workspaceId: input.endpoint.workspaceId,
      connectionId: input.endpoint.providerRule.connectionId,
      deliveryId: input.deliveryId,
      externalDeliveryId: input.parsed.externalExecutionKey,
      deliveryReceivedAt: input.deliveryReceivedAt,
      providerRuleId: input.endpoint.providerRule.id,
      automation: input.parsed,
      manualRecovery: input.manualRecovery,
      evaluationMode: input.evaluationMode,
      ...(input.manualRecovery === true && input.manualReplayApproval
        ? { manualReplayApproval: input.manualReplayApproval }
        : {}),
      ...(routedChannelId ? { routedChannelId } : {}),
    });
    const processedAt = new Date();

    await this.prisma.inboundWebhookDelivery.updateMany({
      where: {
        id: input.deliveryId,
        workspaceId: input.endpoint.workspaceId,
        connectionId: input.endpoint.providerRule.connectionId,
        providerRuleEndpointId: input.endpoint.id,
        purpose: "conversion_automation",
      },
      data: {
        parserVersion: this.automationParserVersion(input.endpoint),
        status: "processed",
        classification: this.automationDeliveryClassification(observed),
        normalizedSummary: this.toJson({
          purpose: "conversion_automation",
          parserStatus: "parsed",
          parserVersion: this.automationParserVersion(input.endpoint),
          automation: input.parsed.automation,
          eventName: input.parsed.eventName,
          valueCents:
            "valueCents" in input.parsed ? input.parsed.valueCents : undefined,
          currency:
            "currency" in input.parsed ? input.parsed.currency : undefined,
          testCallback: "test" in input.parsed ? input.parsed.test : undefined,
          decisionId: observed.decisionId,
          decisionCode: observed.decisionCode,
          executionStatus: this.automationObservationStatus(observed),
          reasonCode: observed.reasonCode,
          channelResolved: Boolean(observed.channelId),
          paidLeadResolved: observed.leadResolved,
          manuallyReprocessed: input.manualRecovery === true,
          evaluatedAt: processedAt.toISOString(),
          ...(routedChannelId ? { routedChannelId } : {}),
        }),
        parseErrorCode: null,
        routingErrorCode:
          observed.disposition === "blocked" ? observed.reasonCode : null,
        processedAt,
      },
    });

    return observed;
  }

  /** Umbler only: the routed number kept in the delivery summary. */
  private async storedRoutedChannelId(
    endpoint: PublicConversionEndpoint,
    deliveryId: string,
  ): Promise<string | undefined> {
    if (endpoint.providerRule.parserRelease.provider !== "umbler")
      return undefined;
    const delivery = await this.prisma.inboundWebhookDelivery.findFirst({
      where: {
        id: deliveryId,
        workspaceId: endpoint.workspaceId,
        providerRuleEndpointId: endpoint.id,
        purpose: "conversion_automation",
      },
      select: { normalizedSummary: true },
    });
    const stored = this.jsonRecord(delivery?.normalizedSummary)?.routedChannelId;
    return typeof stored === "string" && stored ? stored : undefined;
  }

  private async enqueueEligibleObservation(
    workspaceId: string,
    observed: ProviderConversionAutomationObservationResult,
  ): Promise<void> {
    if (!observed.eligibleExecutionId) return;

    try {
      await this.productionQueue.enqueueProviderConversion({
        providerConversionExecutionId: observed.eligibleExecutionId,
        workspaceId,
      });
    } catch {
      this.logger.warn(
        `Automation execution ${observed.eligibleExecutionId} remains eligible for queue recovery`,
      );
    }
  }

  private automationObservationStatus(
    observed: ProviderConversionAutomationObservationResult,
  ): AutomationObservationStatus {
    if (observed.reasonCode === "purchase_duplicate") return "duplicate";
    if (
      observed.decisionCode === "ignored_empty_template" ||
      observed.decisionCode === "ignored_untracked_lead" ||
      observed.decisionCode === "duplicate" ||
      observed.disposition === "ignored"
    ) {
      return "ignored";
    }
    if (observed.decisionCode === "review_required") return "blocked";

    return observed.disposition;
  }

  private automationDeliveryClassification(
    observed: ProviderConversionAutomationObservationResult,
  ):
    | "eligible_route_resolved"
    | "eligible_route_unresolved"
    | "ignored_empty_template"
    | "ignored_untracked_lead"
    | "unsupported_event" {
    switch (observed.decisionCode) {
      case "ignored_empty_template":
        return ignoredEmptyTemplateReason;
      case "ignored_untracked_lead":
        return ignoredUntrackedLeadReason;
      case "duplicate":
        return "eligible_route_resolved";
      case "review_required":
        return "eligible_route_resolved";
      case "eligible":
        return observed.disposition === "eligible"
          ? "eligible_route_resolved"
          : observed.disposition === "blocked"
            ? "eligible_route_unresolved"
            : "eligible_route_resolved";
      default:
        return "unsupported_event";
    }
  }

  private async findExistingDelivery(
    connectionId: string,
    ingressKey: string,
  ): Promise<{ id: string; firstReceivedAt: Date } | null> {
    try {
      return await this.prisma.inboundWebhookDelivery.findUnique({
        where: {
          connectionId_ingressKey: { connectionId, ingressKey },
        },
        select: { id: true, firstReceivedAt: true },
      });
    } catch {
      throw new ServiceUnavailableException(publicPersistenceFailureMessage);
    }
  }

  /**
   * A provider may deliver the same occurrence more than once with a
   * different body (Payt resends the transaction with a new updated_at,
   * value, phone...). Only one delivery exists per occurrence, and production
   * re-reads ITS stored payload to verify the frozen decision, so a decision
   * built from a body that is not the stored one fails forever with
   * provider_conversion_source_event_mismatch.
   *
   * - identical body: nothing changes;
   * - different body, no decision frozen for the occurrence (e.g. the first
   *   callback stopped at channel selection) and no observation in flight:
   *   the latest body replaces the stored one (compare-and-swap on the
   *   ciphertext) and is the one observed;
   * - different body whose occurrence already FAILED production with
   *   provider_conversion_source_event_mismatch (its frozen decision is
   *   proven inconsistent with the stored body and nothing was sent): the
   *   resend body replaces the stored one and is re-evaluated into a fresh
   *   decision, so the resend heals the failure;
   * - otherwise the stored body is observed, never the resend's.
   *
   * Dedupe is untouched: same delivery, same occurrence key, same purchase
   * key, so a resend can never produce a second send.
   */
  private async reconcileResentPayload(input: {
    endpoint: PublicConversionEndpoint;
    deliveryId: string;
    rawBody: Buffer;
    receivedAt: Date;
    parsed: ParsedAutomation;
  }): Promise<{
    parsed: ParsedAutomation;
    evaluationMode?: ProviderConversionEvaluationMode;
  }> {
    const stored = await this.readStoredAutomation(
      input.endpoint,
      input.deliveryId,
    );
    // Payload expired/unavailable: production cannot run anyway.
    if (!stored) return { parsed: input.parsed };
    if (this.sameJsonBody(stored.rawBody, input.rawBody)) {
      return { parsed: input.parsed };
    }
    if (stored.decisionPending) {
      return { parsed: stored.parsed ?? input.parsed };
    }

    // Only Payt resends may cure a source mismatch; other providers keep the
    // stored body once a decision exists.
    const mismatchExecutionId =
      input.endpoint.providerRule.parserRelease?.provider === "payt"
        ? await this.sourceMismatchExecutionId(
            input.endpoint,
            input.parsed.externalExecutionKey,
          )
        : null;
    const replaceable =
      mismatchExecutionId !== null ||
      !(await this.occurrenceHasDecision(
        input.endpoint,
        input.parsed.externalExecutionKey,
      ));
    if (replaceable) {
      const replaced = await this.replaceStoredPayload({
        endpoint: input.endpoint,
        deliveryId: input.deliveryId,
        expectedEncryptedPayload: stored.encryptedPayload,
        rawBody: input.rawBody,
        receivedAt: input.receivedAt,
        parsed: input.parsed,
      });
      if (replaced) {
        return mismatchExecutionId
          ? {
              parsed: input.parsed,
              evaluationMode: {
                type: "reevaluate",
                requestKey: `source-mismatch-resend:${mismatchExecutionId}:${randomUUID()}`,
                recordInitialWhenMissing: true,
              },
            }
          : { parsed: input.parsed };
      }
      // A concurrent resend swapped it first: observe what it stored.
      const latest = await this.readStoredAutomation(
        input.endpoint,
        input.deliveryId,
      );
      return { parsed: latest?.parsed ?? stored.parsed ?? input.parsed };
    }

    return { parsed: stored.parsed ?? input.parsed };
  }

  /** The occurrence's execution failed production because its frozen
   * decision does not match the stored callback (nothing was sent). */
  private async sourceMismatchExecutionId(
    endpoint: PublicConversionEndpoint,
    occurrenceKey: string,
  ): Promise<string | null> {
    const execution =
      await this.prisma.providerConversionRuleExecution.findUnique({
        where: {
          providerRuleId_externalExecutionKey: {
            providerRuleId: endpoint.providerRule.id,
            externalExecutionKey: occurrenceKey,
          },
        },
        select: { id: true, status: true, reasonCode: true },
      });
    return execution && this.sourceEventMismatchFailure(execution)
      ? execution.id
      : null;
  }

  private async readStoredAutomation(
    endpoint: PublicConversionEndpoint,
    deliveryId: string,
  ): Promise<{
    rawBody: Buffer;
    encryptedPayload: string;
    parsed: ParsedAutomation | null;
    decisionPending: boolean;
  } | null> {
    const delivery = await this.prisma.inboundWebhookDelivery.findFirst({
      where: {
        id: deliveryId,
        workspaceId: endpoint.workspaceId,
        connectionId: endpoint.providerRule.connectionId,
        providerRuleEndpointId: endpoint.id,
        purpose: "conversion_automation",
      },
      select: {
        id: true,
        workspaceId: true,
        connectionId: true,
        encryptedPayload: true,
        payloadIv: true,
        payloadTag: true,
        encryptionKeyVersion: true,
        payloadExpiresAt: true,
        normalizedSummary: true,
      },
    });
    if (
      !delivery ||
      delivery.payloadExpiresAt <= new Date() ||
      !delivery.encryptedPayload ||
      !delivery.payloadIv ||
      !delivery.payloadTag ||
      !delivery.encryptionKeyVersion
    ) {
      return null;
    }

    try {
      const rawBody = this.encryption.decrypt(
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
      const parsed = this.parseAutomation(
        endpoint,
        JSON.parse(rawBody.toString("utf8")) as unknown,
      );
      return {
        rawBody,
        encryptedPayload: delivery.encryptedPayload,
        parsed: parsed.ok ? parsed.value : null,
        // The first observation of this delivery has not finished yet: it
        // may be freezing a decision from the stored body right now.
        decisionPending:
          this.jsonRecord(delivery.normalizedSummary)?.executionStatus ===
          "decision_pending",
      };
    } catch {
      return null;
    }
  }

  private sameJsonBody(left: Buffer, right: Buffer): boolean {
    if (left.equals(right)) return true;
    try {
      return (
        JSON.stringify(JSON.parse(left.toString("utf8"))) ===
        JSON.stringify(JSON.parse(right.toString("utf8")))
      );
    } catch {
      return false;
    }
  }

  private async occurrenceHasDecision(
    endpoint: PublicConversionEndpoint,
    occurrenceKey: string,
  ): Promise<boolean> {
    const decision =
      await this.prisma.providerConversionDecisionAudit.findFirst({
        where: {
          workspaceId: endpoint.workspaceId,
          providerRuleId: endpoint.providerRule.id,
          occurrenceKey,
        },
        select: { id: true },
      });
    return Boolean(decision);
  }

  private async replaceStoredPayload(input: {
    endpoint: PublicConversionEndpoint;
    deliveryId: string;
    expectedEncryptedPayload: string;
    rawBody: Buffer;
    receivedAt: Date;
    parsed: ParsedAutomation;
  }): Promise<boolean> {
    const { endpoint } = input;
    const encrypted = this.encryption.encrypt(input.rawBody, {
      workspaceId: endpoint.workspaceId,
      connectionId: endpoint.providerRule.connectionId,
      deliveryId: input.deliveryId,
    });
    let replaced: boolean;
    try {
      const updated = await this.prisma.inboundWebhookDelivery.updateMany({
        where: {
          id: input.deliveryId,
          workspaceId: endpoint.workspaceId,
          connectionId: endpoint.providerRule.connectionId,
          providerRuleEndpointId: endpoint.id,
          purpose: "conversion_automation",
          encryptedPayload: input.expectedEncryptedPayload,
        },
        data: {
          ...encrypted,
          payloadExpiresAt: new Date(
            input.receivedAt.getTime() +
              INBOUND_WEBHOOK_RAW_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
          ),
          // Marks the observation of the new body as in flight, so another
          // concurrent resend observes this body instead of swapping again.
          normalizedSummary: this.toJson({
            purpose: "conversion_automation",
            parserStatus: "parsed",
            automation: input.parsed.automation,
            eventName: input.parsed.eventName,
            executionStatus: "decision_pending",
            reasonCode: "decision_pending",
            channelResolved: false,
            paidLeadResolved: false,
            rawBodyLength: input.rawBody.length,
            payloadReplacedByResendAt: input.receivedAt.toISOString(),
          }),
        },
      });
      replaced = updated.count === 1;
    } catch {
      throw new ServiceUnavailableException(publicPersistenceFailureMessage);
    }
    if (replaced) {
      this.logger.log(
        JSON.stringify({
          event: "provider_conversion_automation_payload_replaced",
          workspaceId: endpoint.workspaceId,
          providerRuleId: endpoint.providerRule.id,
          deliveryId: input.deliveryId,
        }),
      );
    }
    return replaced;
  }

  private async persistDelivery(input: {
    endpoint: PublicConversionEndpoint;
    deliveryId: string;
    ingressKey: string;
    providerAttempt: number | null;
    integrationEndpointId: string | null;
    rawBodyLength: number;
    receivedAt: Date;
    /** Original receipt of the occurrence ("Tentar de novo"); else receivedAt. */
    firstReceivedAt?: Date;
    encrypted: {
      encryptedPayload: string;
      payloadIv: string;
      payloadTag: string;
      encryptionKeyVersion: number;
    };
    parsed: ParsedAutomation | null;
    parseErrorCode: string | null;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.revalidateEndpoint(transaction, input.endpoint);
      const parsed = input.parsed;
      await transaction.inboundWebhookDelivery.create({
        data: {
          id: input.deliveryId,
          workspaceId: input.endpoint.workspaceId,
          connectionId: input.endpoint.providerRule.connectionId,
          provider: input.endpoint.providerRule.connection.provider,
          ingressKey: input.ingressKey,
          externalDeliveryId: parsed?.externalExecutionKey ?? null,
          providerEventType: parsed?.automation ?? "automation_callback",
          parserVersion: this.automationParserVersion(input.endpoint),
          purpose: "conversion_automation",
          providerRuleEndpointWorkspaceId: input.endpoint.workspaceId,
          providerRuleEndpointId: input.endpoint.id,
          ...(input.integrationEndpointId
            ? {
                integrationEndpointWorkspaceId: input.endpoint.workspaceId,
                integrationEndpointId: input.integrationEndpointId,
              }
            : {}),
          status:
            parsed || ignoredParseErrors.has(input.parseErrorCode ?? "")
              ? "processed"
              : "failed",
          classification: parsed
            ? "eligible_route_unresolved"
            : ignoredParseErrors.has(input.parseErrorCode ?? "")
              ? "unsupported_event"
              : "invalid_payload",
          firstReceivedAt: input.firstReceivedAt ?? input.receivedAt,
          lastReceivedAt: input.receivedAt,
          providerAttempt: input.providerAttempt,
          ...input.encrypted,
          payloadExpiresAt: new Date(
            input.receivedAt.getTime() +
              INBOUND_WEBHOOK_RAW_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
          ),
          normalizedSummary: this.toJson(
            parsed
              ? {
                  purpose: "conversion_automation",
                  parserStatus: "parsed",
                  automation: parsed.automation,
                  eventName: parsed.eventName,
                  executionStatus: "decision_pending",
                  reasonCode: "decision_pending",
                  channelResolved: false,
                  paidLeadResolved: false,
                  rawBodyLength: input.rawBodyLength,
                }
              : {
                  purpose: "conversion_automation",
                  parserStatus: ignoredParseErrors.has(
                    input.parseErrorCode ?? "",
                  )
                    ? "not_purchase"
                    : "invalid_payload",
                  rawBodyLength: input.rawBodyLength,
                },
          ),
          parseErrorCode: input.parseErrorCode,
          routingErrorCode: null,
          processedAt: input.receivedAt,
        },
      });

      await this.touchEndpointAndConnection(
        transaction,
        input.endpoint,
        input.receivedAt,
        Boolean(parsed),
        input.integrationEndpointId === null,
      );
    });
  }

  private async recordDuplicate(
    endpoint: PublicConversionEndpoint,
    deliveryId: string,
    providerAttempt: number | null,
    receivedAt: Date,
    /** False for a routed callback: the per-rule URL itself got nothing. */
    touchRuleEndpoint = true,
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (transaction) => {
        await this.revalidateEndpoint(transaction, endpoint);
        const updated = await transaction.inboundWebhookDelivery.updateMany({
          where: {
            id: deliveryId,
            workspaceId: endpoint.workspaceId,
            connectionId: endpoint.providerRule.connectionId,
            purpose: "conversion_automation",
            providerRuleEndpointId: endpoint.id,
          },
          data: {
            attemptCount: { increment: 1 },
            lastReceivedAt: receivedAt,
            providerAttempt: providerAttempt ?? undefined,
          },
        });
        if (updated.count !== 1) {
          throw new NotFoundException(publicEndpointNotFoundMessage);
        }
        await this.touchEndpointAndConnection(
          transaction,
          endpoint,
          receivedAt,
          false,
          touchRuleEndpoint,
        );
      });
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException(publicPersistenceFailureMessage);
    }
  }

  private async revalidateEndpoint(
    transaction: Prisma.TransactionClient,
    endpoint: PublicConversionEndpoint,
  ): Promise<void> {
    const current = await transaction.providerConversionRuleEndpoint.findFirst({
      where: {
        id: endpoint.id,
        workspaceId: endpoint.workspaceId,
        secretHash: endpoint.secretHash,
        removedAt: null,
        providerRule: {
          removedAt: null,
          parserRelease: { status: { not: "retired" } },
          conversionRule: {
            active: true,
            triggerType: "provider_automation",
          },
          connection: {
            removedAt: null,
            status: { in: ["observation", "production"] },
          },
        },
      },
      select: { id: true },
    });
    if (!current) {
      throw new NotFoundException(publicEndpointNotFoundMessage);
    }
  }

  private async touchEndpointAndConnection(
    transaction: Prisma.TransactionClient,
    endpoint: PublicConversionEndpoint,
    receivedAt: Date,
    parsedSuccessfully: boolean,
    /**
     * Fase 5.3: the per-rule endpoint's lastDeliveryAt tells the operator
     * whether the OLD URL still receives; routed callbacks do not move it
     * (revalidateEndpoint already checked the endpoint in this transaction).
     */
    touchRuleEndpoint = true,
  ): Promise<void> {
    const data = {
      lastDeliveryAt: receivedAt,
      ...(parsedSuccessfully ? { lastSuccessfulParseAt: receivedAt } : {}),
    };
    const [endpointUpdate, connectionUpdate] = await Promise.all([
      touchRuleEndpoint
        ? transaction.providerConversionRuleEndpoint.updateMany({
            where: {
              id: endpoint.id,
              workspaceId: endpoint.workspaceId,
              secretHash: endpoint.secretHash,
              removedAt: null,
            },
            data,
          })
        : Promise.resolve({ count: 1 }),
      transaction.inboundWebhookConnection.updateMany({
        where: {
          id: endpoint.providerRule.connectionId,
          workspaceId: endpoint.workspaceId,
          removedAt: null,
          status: { in: ["observation", "production"] },
        },
        data,
      }),
    ]);

    if (endpointUpdate.count !== 1 || connectionUpdate.count !== 1) {
      throw new NotFoundException(publicEndpointNotFoundMessage);
    }
  }

  private manualReprocessBlockMessage(reasonCode: string): string {
    const messages: Record<string, string> = {
      automation_event_mismatch:
        "O callback não corresponde ao evento configurado nesta regra",
      automation_channel_unresolved:
        "O canal do callback ainda não foi localizado",
      automation_paid_lead_missing:
        "O callback ainda não possui um lead pago com CTWA",
      automation_value_missing:
        "Configure o valor médio antes de reprocessar a compra",
      payt_channel_missing_or_ambiguous:
        "O comprador ainda não corresponde a um único lead pago com CTWA nos números desta regra",
      production_context_invalid:
        "A conexão ou o canal ainda não está pronto para produção",
    };

    return messages[reasonCode] ?? "O callback ainda não pode ser reprocessado";
  }

  private toJson(value: object): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    );
  }
}
