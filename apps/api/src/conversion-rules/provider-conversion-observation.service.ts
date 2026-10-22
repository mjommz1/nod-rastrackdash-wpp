import { inboundParserProductionEligible } from "../inbound-webhooks/inbound-webhook-parser-eligibility";
import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  CurrencyCode,
  ProviderConversionCatalogDto,
  ProviderConversionDecisionCatalogSnapshotDto,
  ProviderConversionDecisionDto,
  ProviderConversionDecisionRuleSnapshotDto,
  ProviderConversionPaidLeadResolutionDto,
} from "@wpptrack/shared";
import {
  conversionEventNameSchema,
  readMessagePhraseConfig,
  type ConversionEventNameDto,
} from "@wpptrack/shared";
import {
  hashPhoneIdentity,
  hashPhoneIdentityVariants,
} from "../common/phone/phone-identity";
import { PrismaService } from "../common/prisma/prisma.service";
import { loadWorkspaceConversionCurrency } from "../currency/workspace-currency";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import type { ParsedInboundWebhookEvent } from "../inbound-webhooks/providers/inbound-webhook-parser";
import type { ParsedUmblerAutomationV1 } from "../inbound-webhooks/providers/umbler/umbler-automation-v1.parser";
import {
  paytProductFilterMatches,
  type ParsedPaytAutomationV1,
} from "../inbound-webhooks/providers/payt/payt-automation-v1.parser";
import type { ParsedUnnichatAutomationV1 } from "../inbound-webhooks/providers/unnichat/unnichat-automation-v1.parser";
import {
  PAYT_LEAD_OTHER_CHANNEL_REASON,
  resolvePurchaseChannels,
} from "./provider-purchase-routing";
import { buildProviderPurchaseIdentity } from "./provider-purchase-identity";
import {
  ProviderConversionDecisionRepository,
  type PersistedProviderConversionDecision,
} from "./provider-conversion-decision.repository";
import type { ProviderConversionDecisionInput } from "./provider-conversion-decision.types";
import { ProviderConversionEngineRolloutService } from "./provider-conversion-engine-rollout.service";
import {
  ProviderConversionOrchestrator,
  type ProviderConversionManualReplayApproval,
  type ProviderConversionTechnicalDisposition,
} from "./provider-conversion-orchestrator.service";
import { ProviderConversionPaidLeadResolver } from "./provider-conversion-paid-lead-resolver.service";
import type { ProviderConversionEngineMode } from "./provider-conversion-shadow-comparison.service";
import {
  findOverridingSpecificRuleIds,
  PROVIDER_RULE_OVERRIDDEN_REASON,
  providerRuleCandidateWhere,
  providerRuleScope,
  resolveApplicableProviderRules,
  resolveProviderRuleScopeChannelIds,
} from "./provider-rule-scope";

/** Fase 5.3: sale of a product outside the rule product filter. */
export const PAYT_PRODUCT_NOT_IN_RULE_REASON = "payt_product_not_in_rule";

const observedRuleInclude = {
  conversionRule: true,
  connection: {
    include: {
      parserRelease: true,
    },
  },
  parserRelease: true,
  channels: {
    include: {
      channel: {
        select: {
          id: true,
          status: true,
          productionActivatedAt: true,
          conversionEngineMode: true,
        },
      },
    },
  },
  catalog: {
    include: {
      attributes: { orderBy: { position: "asc" } },
      variants: { orderBy: { createdAt: "asc" } },
    },
  },
} satisfies Prisma.ProviderConversionRuleConfigInclude;

type ObservedRule = Prisma.ProviderConversionRuleConfigGetPayload<{
  include: typeof observedRuleInclude;
}>;

/** The Umbler automation always keeps its connection and parser binding. */
type AutomationRule = ObservedRule & {
  connectionId: string;
  connection: NonNullable<ObservedRule["connection"]>;
  parserRelease: NonNullable<ObservedRule["parserRelease"]>;
};

/** Connection + parser whose live state gates production for a decision. */
type GateConnection = {
  id: string;
  status: string;
  removedAt: Date | null;
  parserReleaseId: string;
  parserRelease: {
    id: string;
    provider: string;
    version: string;
    status: string;
  };
};

type ObservedChannel = {
  id: string;
  organizationId: string;
  providerChannelId: string;
  status: string;
  productionActivatedAt: Date | null;
  conversionEngineMode: ProviderConversionEngineMode;
};

/** Endpoint automations of this edition (Umbler, Payt). */
type ParsedProviderAutomation =
  | ParsedUmblerAutomationV1
  | ParsedPaytAutomationV1
  | (ParsedUnnichatAutomationV1 & {
      provider: "unnichat";
      automation: "crm_movement";
      eventName: ConversionEventNameDto;
    });

export type ProviderConversionObservationResult = {
  executionIds: string[];
  eligibleExecutionIds: string[];
};

export type ProviderConversionAutomationObservationResult = {
  decisionId: string | null;
  decisionCode: ProviderConversionDecisionDto["decisionCode"] | null;
  reasonCode: string;
  disposition: ProviderConversionTechnicalDisposition["state"] | "ignored";
  executionId: string | null;
  eligibleExecutionId: string | null;
  reviewId: string | null;
  channelId: string | null;
  leadResolved: boolean;
};

export type ProviderConversionEvaluationMode =
  | {
      type: "reuse";
    }
  | {
      type: "reevaluate";
      requestKey: string;
      /** Automation only: a callback that never produced a decision (e.g.
       * stopped at lead matching) records its first decision instead. */
      recordInitialWhenMissing?: boolean;
    };

export type ProviderConversionReevaluationTarget = {
  providerRuleId: string;
  occurrenceKey: string;
};

@Injectable()
export class ProviderConversionObservationService {
  private readonly logger = new Logger(
    ProviderConversionObservationService.name,
  );

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderConversionEngineRolloutService)
    private readonly engineRollout: ProviderConversionEngineRolloutService,
    @Inject(ProviderConversionDecisionRepository)
    private readonly decisions: ProviderConversionDecisionRepository,
    @Inject(ProviderConversionPaidLeadResolver)
    private readonly paidLeads: ProviderConversionPaidLeadResolver,
    @Inject(ProviderConversionOrchestrator)
    private readonly orchestrator: ProviderConversionOrchestrator,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv = process.env,
  ) {}

  async observeDelivery(input: {
    workspaceId: string;
    connectionId: string;
    deliveryId: string;
    externalDeliveryId?: string | null;
    deliveryReceivedAt: Date;
    events: ParsedInboundWebhookEvent[];
    manualRecovery?: boolean;
  }): Promise<ProviderConversionObservationResult> {
    return this.evaluateMessageDelivery(input, { type: "reuse" });
  }

  async reevaluateDelivery(input: {
    workspaceId: string;
    connectionId: string;
    deliveryId: string;
    externalDeliveryId?: string | null;
    deliveryReceivedAt: Date;
    events: ParsedInboundWebhookEvent[];
    manualRecovery?: boolean;
    requestKey: string;
    target: ProviderConversionReevaluationTarget;
  }): Promise<ProviderConversionObservationResult> {
    return this.evaluateMessageDelivery(
      input,
      {
        type: "reevaluate",
        requestKey: input.requestKey,
      },
      input.target,
    );
  }

  async observeAutomation(input: {
    workspaceId: string;
    connectionId: string;
    deliveryId: string;
    externalDeliveryId?: string | null;
    deliveryReceivedAt: Date;
    providerRuleId: string;
    automation: ParsedProviderAutomation;
    manualRecovery?: boolean;
    evaluationMode?: ProviderConversionEvaluationMode;
    /** Only the explicit production "Reprocessar selecionados" action. */
    manualReplayApproval?: ProviderConversionManualReplayApproval;
    /**
     * Fase 5.3 (Umbler): number the URL por evento proved for this callback
     * (channel.phone or the single number of the contact). A hint, checked
     * against the rule scope: outside it, the rule does not own the callback.
     */
    routedChannelId?: string | null;
  }): Promise<ProviderConversionAutomationObservationResult> {
    if (input.automation.provider === "payt") {
      // One sale (seller + order + event) is one occurrence, whatever endpoint
      // or delivery carried it.
      input = {
        ...input,
        automation: {
          ...input.automation,
          externalExecutionKey: buildProviderPurchaseIdentity({
            workspaceId: input.workspaceId,
            provider: "payt",
            accountRef: input.automation.accountRef,
            orderRef: input.automation.orderRef,
            eventName: input.automation.eventName,
          }),
        },
      };
    }
    const config = parseInboundWebhooksConfig(this.env);
    if (!config.enabled || !config.conversionRulesEnabled) {
      return {
        decisionId: null,
        decisionCode: null,
        reasonCode: "conversion_rules_disabled",
        disposition: "ignored",
        executionId: null,
        eligibleExecutionId: null,
        reviewId: null,
        channelId: null,
        leadResolved: false,
      };
    }

    const loadedRule = await this.loadAutomationRule(input);
    if (
      !loadedRule ||
      !loadedRule.connectionId ||
      !loadedRule.connection ||
      !loadedRule.parserRelease
    ) {
      return {
        decisionId: null,
        decisionCode: null,
        reasonCode: "automation_rule_unavailable",
        disposition: "ignored",
        executionId: null,
        eligibleExecutionId: null,
        reviewId: null,
        channelId: null,
        leadResolved: false,
      };
    }
    const rule = loadedRule as AutomationRule;
    const phoneCandidates =
      "phoneCandidates" in input.automation
        ? input.automation.phoneCandidates
        : undefined;
    // Fase 5.3: a sales-platform rule may be limited to some products (by
    // code). A sale of another product is not this rule's: ignored, never an
    // error, never sent by it.
    if (
      input.automation.provider === "payt" &&
      !paytProductFilterMatches(
        rule.productFilterCodes,
        input.automation.productCodes ?? [],
      )
    ) {
      return {
        decisionId: null,
        decisionCode: null,
        reasonCode: PAYT_PRODUCT_NOT_IN_RULE_REASON,
        disposition: "ignored",
        executionId: null,
        eligibleExecutionId: null,
        reviewId: null,
        channelId: null,
        leadResolved: false,
      };
    }
    // Fase 4b (as in the SaaS): an Unnichat automation without ctwa_clid is
    // recorded as blocked (ctwa_missing) and nothing reaches Meta.
    if (this.isUnnichatWithoutCtwa(input.automation)) {
      return this.recordUnnichatCtwaMissing({ input, rule });
    }
    // A Payt sale is attributed only to a tracked CTWA lead: its verified
    // entry (on any channel of the workspace) is then bound to the rule scope.
    // An Unnichat automation resolves the lead on its own entry connection.
    const purchaseLead = ["payt", "unnichat"].includes(
      rule.parserRelease.provider,
    )
      ? await this.paidLeads.resolve({
          workspaceId: input.workspaceId,
          ...(rule.parserRelease.provider === "unnichat"
            ? { connectionId: input.connectionId }
            : { ctwaProofAnyChannel: true }),
          phone: input.automation.phone,
          phoneCandidates,
        })
      : null;
    const channel = await this.resolveAutomationChannel({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      phone: input.automation.phone,
      phoneCandidates,
      deliveryReceivedAt: input.deliveryReceivedAt,
      purchaseLead,
      rule,
      routedChannelId: input.routedChannelId ?? null,
    });
    // A workspace-wide ("all numbers") automation yields to the specific rule
    // of the same origin and event that owns the resolved number: that rule
    // receives the same callback on its own endpoint and sends it.
    if (channel && providerRuleScope(rule) === "all_numbers") {
      const overriddenBy = await this.productAwareOverrides(
        await findOverridingSpecificRuleIds(this.prisma, {
          workspaceId: input.workspaceId,
          rule,
          channelId: channel.id,
        }),
        input.workspaceId,
        input.automation,
      );
      if (overriddenBy.length > 0) {
        this.logger.log(
          JSON.stringify({
            event: "provider_conversion_rule_overridden",
            workspaceId: input.workspaceId,
            providerRuleId: rule.id,
            channelId: channel.id,
            overriddenByRuleIds: overriddenBy,
          }),
        );
        return {
          decisionId: null,
          decisionCode: null,
          reasonCode: PROVIDER_RULE_OVERRIDDEN_REASON,
          disposition: "ignored",
          executionId: null,
          eligibleExecutionId: null,
          reviewId: null,
          channelId: channel.id,
          leadResolved: purchaseLead?.status === "resolved",
        };
      }
    }
    if (rule.parserRelease.provider === "payt" && !channel) {
      // One Payt rule per WhatsApp number receives the same sale. When the
      // buyer is a tracked lead whose verified origin is another number, this
      // rule simply does not own the purchase: record it as such (the rule of
      // the origin number produces the event), never as ambiguous.
      if (
        purchaseLead?.status === "resolved" &&
        (await this.paytLeadFromAnotherChannel({
          workspaceId: input.workspaceId,
          rule,
          lead: purchaseLead.lead,
          phone: input.automation.phone,
          phoneCandidates,
          deliveryReceivedAt: input.deliveryReceivedAt,
        }))
      ) {
        return {
          decisionId: null,
          decisionCode: null,
          reasonCode: PAYT_LEAD_OTHER_CHANNEL_REASON,
          disposition: "ignored",
          executionId: null,
          eligibleExecutionId: null,
          reviewId: null,
          channelId: null,
          leadResolved: true,
        };
      }
      // No tracked CTWA lead (no ctwa_clid) or no single verified origin in
      // the rule scope: nothing is decided and nothing reaches Meta.
      return {
        decisionId: null,
        decisionCode: null,
        reasonCode: "payt_channel_missing_or_ambiguous",
        disposition: "blocked",
        executionId: null,
        eligibleExecutionId: null,
        reviewId: null,
        channelId: null,
        leadResolved: false,
      };
    }
    const leadResolution =
      rule.parserRelease.provider === "unnichat" && !channel
        ? {
            status: "not_found" as const,
            reasonCode: "paid_lead_not_found" as const,
            candidateLeadId: null,
          }
        : (purchaseLead ??
          (await this.paidLeads.resolve({
            workspaceId: input.workspaceId,
            phone: input.automation.phone,
            phoneCandidates,
          })));
    const persistedDecision = await this.resolveAutomationDecision({
      input,
      rule,
      channel,
      leadResolution,
      evaluationMode: input.evaluationMode ?? { type: "reuse" },
    });
    if (!persistedDecision) {
      return {
        decisionId: null,
        decisionCode: null,
        reasonCode: "automation_event_mismatch",
        disposition: "ignored",
        executionId: null,
        eligibleExecutionId: null,
        reviewId: null,
        channelId: channel?.id ?? null,
        leadResolved: leadResolution.status === "resolved",
      };
    }

    const disposition = this.disposition({
      config,
      decision: persistedDecision.decision,
      rule,
      gateConnection: rule.connection,
      channel,
      deliveryReceivedAt: input.deliveryReceivedAt,
      manualRecovery: input.manualRecovery === true,
    });
    const orchestration = await this.orchestrator.orchestrate({
      persistedDecision,
      disposition,
      // An approval is only meaningful for an explicit manual recovery; it
      // is never derived from ingestion, sweeps or automatic retries.
      ...(input.manualRecovery === true && input.manualReplayApproval
        ? { manualReplayApproval: input.manualReplayApproval }
        : {}),
    });

    return {
      decisionId: persistedDecision.id,
      decisionCode: persistedDecision.decisionCode,
      // The sale already has an observation winner (another delivery of the
      // same seller + order + event): reported once, never sent twice.
      reasonCode: orchestration.purchaseDuplicate
        ? "purchase_duplicate"
        : persistedDecision.reasonCode,
      disposition: orchestration.purchaseDuplicate
        ? "ignored"
        : persistedDecision.decisionCode === "ignored_empty_template" ||
            persistedDecision.decisionCode === "ignored_untracked_lead" ||
            persistedDecision.decisionCode === "duplicate"
          ? "ignored"
          : disposition.state,
      executionId: orchestration.executionId,
      eligibleExecutionId: orchestration.eligibleExecutionId,
      reviewId: orchestration.reviewId,
      channelId: channel?.id ?? null,
      leadResolved: leadResolution.status === "resolved",
    };
  }

  /**
   * Fase 5.3: a specific Payt rule only replaces the global one for the sales
   * it accepts. A specific rule limited to product A does not silence the
   * global rule for a sale of product B. Other origins keep the plain
   * precedence.
   */
  private async productAwareOverrides(
    ruleIds: string[],
    workspaceId: string,
    automation: ParsedProviderAutomation,
  ): Promise<string[]> {
    if (ruleIds.length === 0 || automation.provider !== "payt") return ruleIds;
    const filters = await this.prisma.providerConversionRuleConfig.findMany({
      where: { workspaceId, id: { in: ruleIds } },
      select: { id: true, productFilterCodes: true },
    });
    const byId = new Map(
      filters.map((rule) => [rule.id, rule.productFilterCodes ?? []]),
    );
    return ruleIds.filter((id) =>
      paytProductFilterMatches(
        byId.get(id) ?? [],
        automation.productCodes ?? [],
      ),
    );
  }

  private async evaluateMessageDelivery(
    input: {
      workspaceId: string;
      connectionId: string;
      deliveryId: string;
      externalDeliveryId?: string | null;
      deliveryReceivedAt: Date;
      events: ParsedInboundWebhookEvent[];
      manualRecovery?: boolean;
    },
    evaluationMode: ProviderConversionEvaluationMode,
    target?: ProviderConversionReevaluationTarget,
  ): Promise<ProviderConversionObservationResult> {
    const config = parseInboundWebhooksConfig(this.env);
    if (!config.enabled || !config.conversionRulesEnabled) {
      return this.emptyResult();
    }

    const candidates = input.events.filter((event) => {
      if (
        event.provider !== "umbler" ||
        event.message.isPrivate ||
        event.message.text === null
      ) {
        return false;
      }

      return !target || event.dedupeKey === target.occurrenceKey;
    });
    if (candidates.length === 0) {
      return this.emptyResult();
    }

    const channels = await this.loadChannels(input, candidates);
    if (channels.length === 0) {
      return this.emptyResult();
    }
    const loadedRules = await this.loadRules(input, channels);
    if (loadedRules.length === 0) {
      return this.emptyResult();
    }
    // Rules spanning connections carry no parser/connection of their own: the
    // delivery connection gates them. Loaded only when such a rule exists.
    const deliveryConnection = loadedRules.some((rule) => !rule.connection)
      ? await this.loadGateConnection(input)
      : null;

    const leadResolutionByPhone = new Map<
      string,
      Promise<ProviderConversionPaidLeadResolutionDto>
    >();
    const executionIds: string[] = [];
    const eligibleExecutionIds: string[] = [];

    for (const event of candidates) {
      const channel = this.channelForEvent(channels, event);
      if (!channel) continue;

      // Scope + precedence: a specific rule of the same origin/event replaces
      // every "all numbers" rule on this channel, and a global rule runs once
      // per phone. The target filter of a reevaluation runs after precedence,
      // so it can never revive a global rule that a specific rule overrides.
      const { applicable } = await resolveApplicableProviderRules(this.prisma, {
        workspaceId: input.workspaceId,
        rules: loadedRules,
        channel: {
          id: channel.id,
          connectionId: input.connectionId,
          provider: event.provider,
        },
      });
      const rules = target
        ? applicable.filter((rule) => rule.id === target.providerRuleId)
        : applicable;

      for (const rule of rules) {
        const gateConnection = rule.connection ?? deliveryConnection;
        if (!gateConnection) continue;

        const persistedDecision = await this.resolveDecision({
          input,
          event,
          channel,
          rule,
          parserVersion: (rule.parserRelease ?? gateConnection.parserRelease)
            .version,
          leadResolutionByPhone,
          evaluationMode,
        });
        if (!persistedDecision) continue;

        const disposition = this.disposition({
          config,
          decision: persistedDecision.decision,
          rule,
          gateConnection,
          channel,
          deliveryReceivedAt: input.deliveryReceivedAt,
          manualRecovery: input.manualRecovery === true,
        });
        const orchestration = await this.orchestrator.orchestrate({
          persistedDecision,
          disposition,
        });

        if (orchestration.executionId) {
          executionIds.push(orchestration.executionId);
        }
        if (orchestration.eligibleExecutionId) {
          eligibleExecutionIds.push(orchestration.eligibleExecutionId);
        }
      }
    }

    return {
      executionIds: [...new Set(executionIds)],
      eligibleExecutionIds: [...new Set(eligibleExecutionIds)],
    };
  }

  /**
   * Workspace "Moeda das conversoes" for the decision engines. BRL is the
   * engines' own default, so it is only spelled out for USD/EUR workspaces
   * (BRL workspaces keep byte-identical decision inputs).
   */
  private async fallbackCurrencyField(
    workspaceId: string,
  ): Promise<{ fallbackCurrency?: CurrencyCode }> {
    const currency = await loadWorkspaceConversionCurrency(
      this.prisma,
      workspaceId,
    );
    return currency === "BRL" ? {} : { fallbackCurrency: currency };
  }

  private async resolveDecision(input: {
    input: {
      workspaceId: string;
      connectionId: string;
      deliveryId: string;
      externalDeliveryId?: string | null;
    };
    event: ParsedInboundWebhookEvent;
    channel: ObservedChannel;
    rule: ObservedRule;
    parserVersion: string;
    leadResolutionByPhone: Map<
      string,
      Promise<ProviderConversionPaidLeadResolutionDto>
    >;
    evaluationMode: ProviderConversionEvaluationMode;
  }): Promise<PersistedProviderConversionDecision | null> {
    const existing = await this.decisions.findLatestByOccurrence({
      workspaceId: input.input.workspaceId,
      providerRuleId: input.rule.id,
      occurrenceKey: input.event.dedupeKey,
    });
    if (existing && input.evaluationMode.type === "reuse") {
      this.logDecision(existing, false);
      return existing;
    }

    const leadResolution = await this.resolvePaidLead(
      input.input.workspaceId,
      input.event.contact.phoneNumber,
      input.leadResolutionByPhone,
    );
    const ruleSnapshot = this.ruleSnapshot(input.rule);
    const decisionInput: ProviderConversionDecisionInput = {
      parserVersion: input.parserVersion,
      rule: ruleSnapshot,
      catalog: this.catalogSnapshot(input.rule),
      leadResolution,
      contactIdentityHash: hashPhoneIdentity(
        input.event.contact.phoneNumber,
      ) ?? null,
      occurrence: {
        source: "message",
        provider: input.event.provider,
        workspaceId: input.input.workspaceId,
        connectionId: input.input.connectionId,
        channelId: input.channel.id,
        externalDeliveryId:
          input.input.externalDeliveryId ?? input.event.externalEventId,
        externalEventId: input.event.externalEventId,
        externalMessageId: input.event.externalMessageId,
        occurrenceKey: input.event.dedupeKey,
        eventName: ruleSnapshot.eventName,
        occurredAt: input.event.occurredAt.toISOString(),
        authorType: input.event.message.authorType,
        messageText: input.event.message.text!,
        ...(await this.fallbackCurrencyField(input.input.workspaceId)),
      },
    };
    const decision = await this.engineRollout.evaluate({
      mode: input.channel.conversionEngineMode,
      decisionInput,
      sourceDeliveryId: input.input.deliveryId,
    });
    if (!decision) return null;

    const persisted =
      input.evaluationMode.type === "reevaluate"
        ? await this.decisions.appendReevaluation({
            decision,
            sourceDeliveryId: input.input.deliveryId,
            supersedesDecisionId: this.requiredExistingDecision(existing).id,
            reevaluationRequestKey: input.evaluationMode.requestKey,
          })
        : await this.decisions.recordInitial({
            decision,
            sourceDeliveryId: input.input.deliveryId,
          });
    this.logDecision(persisted, persisted.created);
    return persisted;
  }

  private async resolveAutomationDecision(input: {
    input: {
      workspaceId: string;
      connectionId: string;
      deliveryId: string;
      externalDeliveryId?: string | null;
      automation: ParsedProviderAutomation;
    };
    rule: AutomationRule;
    channel: ObservedChannel | null;
    leadResolution: ProviderConversionPaidLeadResolutionDto;
    evaluationMode: ProviderConversionEvaluationMode;
  }): Promise<PersistedProviderConversionDecision | null> {
    const occurrenceKey = input.input.automation.externalExecutionKey;
    const existing = await this.decisions.findLatestByOccurrence({
      workspaceId: input.input.workspaceId,
      providerRuleId: input.rule.id,
      occurrenceKey,
    });
    if (existing && input.evaluationMode.type === "reuse") {
      this.logDecision(existing, false);
      return existing;
    }

    const ruleSnapshot = this.ruleSnapshot(input.rule);
    const decisionInput: ProviderConversionDecisionInput = {
      parserVersion: input.rule.parserRelease.version,
      rule: ruleSnapshot,
      catalog: null,
      leadResolution: input.leadResolution,
      contactIdentityHash: hashPhoneIdentity(
        input.input.automation.phone,
      ) ?? null,
      occurrence: {
        source: "automation",
        provider: input.input.automation.provider ?? "umbler",
        workspaceId: input.input.workspaceId,
        connectionId: input.input.connectionId,
        channelId: input.channel?.id ?? null,
        externalDeliveryId:
          input.input.externalDeliveryId ??
          input.input.automation.externalExecutionKey,
        externalEventId: input.input.automation.externalExecutionKey,
        externalMessageId: null,
        occurrenceKey,
        ...(input.input.automation.provider === "payt"
          ? {
              purchaseKey: buildProviderPurchaseIdentity({
                workspaceId: input.input.workspaceId,
                provider: "payt",
                accountRef: input.input.automation.accountRef,
                orderRef: input.input.automation.orderRef,
                eventName: input.input.automation.eventName,
              }),
            }
          : {}),
        eventName: input.input.automation.eventName,
        occurredAt: input.input.automation.occurredAt.toISOString(),
        authorType: null,
        automation: input.input.automation.automation,
        observedValueCents:
          "valueCents" in input.input.automation
            ? (input.input.automation.valueCents ?? undefined)
            : undefined,
        observedCurrency:
          "currency" in input.input.automation
            ? (input.input.automation.currency ?? undefined)
            : undefined,
        ...(await this.fallbackCurrencyField(input.input.workspaceId)),
      },
    };
    const decision = await this.engineRollout.evaluate({
      mode: input.channel?.conversionEngineMode ?? "legacy",
      decisionInput,
      sourceDeliveryId: input.input.deliveryId,
    });
    if (!decision) return null;

    const persisted =
      input.evaluationMode.type === "reevaluate" &&
      (existing || !input.evaluationMode.recordInitialWhenMissing)
        ? await this.decisions.appendReevaluation({
            decision,
            sourceDeliveryId: input.input.deliveryId,
            supersedesDecisionId: this.requiredExistingDecision(existing).id,
            reevaluationRequestKey: input.evaluationMode.requestKey,
          })
        : await this.decisions.recordInitial({
            decision,
            sourceDeliveryId: input.input.deliveryId,
          });
    this.logDecision(persisted, persisted.created);
    return persisted;
  }

  private async loadAutomationRule(input: {
    workspaceId: string;
    connectionId: string;
    providerRuleId: string;
  }): Promise<ObservedRule | null> {
    return this.prisma.providerConversionRuleConfig.findFirst({
      where: {
        id: input.providerRuleId,
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        removedAt: null,
        conversionRule: {
          active: true,
          triggerType: "provider_automation",
        },
      },
      include: observedRuleInclude,
    });
  }

  private async resolveAutomationChannel(input: {
    workspaceId: string;
    connectionId: string;
    phone: string;
    phoneCandidates?: readonly string[];
    deliveryReceivedAt: Date;
    rule: AutomationRule;
    purchaseLead?: ProviderConversionPaidLeadResolutionDto | null;
    routedChannelId?: string | null;
  }): Promise<ObservedChannel | null> {
    const contactIdentityHashes = [
      ...new Set(
        [input.phone, ...(input.phoneCandidates ?? [])]
          .map((phone) => hashPhoneIdentity(phone))
          .filter((hash): hash is string => Boolean(hash)),
      ),
    ];
    // Specific rules: their chosen channels (no query). "All numbers": every
    // live channel of the workspace that the automation origin supports (the
    // Umbler automation: of its connection; Payt: any WhatsApp number).
    const channelIds = await resolveProviderRuleScopeChannelIds(
      this.prisma,
      input.workspaceId,
      input.rule,
    );
    if (contactIdentityHashes.length === 0 || channelIds.length === 0)
      return null;

    if (
      input.rule.parserRelease.provider === "unnichat" &&
      input.purchaseLead?.status === "resolved" &&
      // An ad lead keeps its own channel selection; its CTWA proof is only
      // the production-time fallback destination.
      !input.purchaseLead.lead.adId &&
      input.purchaseLead.lead.ctwaDestination
    ) {
      const proof = input.purchaseLead.lead.ctwaDestination;
      if (
        !channelIds.includes(proof.channelId) ||
        proof.connectionId !== input.connectionId
      )
        return null;
      return this.prisma.inboundWebhookChannel.findFirst({
        where: {
          id: proof.channelId,
          workspaceId: input.workspaceId,
          connectionId: input.connectionId,
        },
        select: {
          id: true,
          organizationId: true,
          providerChannelId: true,
          status: true,
          productionActivatedAt: true,
          conversionEngineMode: true,
        },
      });
    }
    if (input.rule.parserRelease.provider === "payt") {
      // A Payt sale belongs to the scoped channel where the paid lead's CTWA
      // entry was verified; a phone match alone is never enough.
      if (input.purchaseLead?.status !== "resolved") return null;
      const lead = input.purchaseLead.lead;
      const proof = lead.adId ? undefined : lead.ctwaDestination;
      // A no-ad CTWA lead (authorized_ctwa_destination) is owned only by the
      // rule scoped to the verified entry channel of that click.
      if (!lead.adId && (!proof || !channelIds.includes(proof.channelId)))
        return null;
      const candidates = await resolvePurchaseChannels(this.prisma, {
        workspaceId: input.workspaceId,
        channelIds,
        phoneHashes: this.paytPurchaseIdentityHashes(input, lead.phoneHash),
        leadId: lead.id,
        adId: lead.adId,
        ctwaClid: lead.ctwaClid,
        receivedAt: input.deliveryReceivedAt,
      });
      if (candidates.length === 0 && lead.adId && lead.ctwaDestination) {
        // Ad lead without a materialized ad entry on a scoped channel (e.g.
        // the per-ad routes were removed and the entry went through the
        // authorized page/pixel destination): its verified CTWA entry proof
        // selects the channel, exactly like a no-ad lead.
        const fallback = lead.ctwaDestination;
        if (!channelIds.includes(fallback.channelId)) return null;
        return this.prisma.inboundWebhookChannel.findFirst({
          where: {
            id: fallback.channelId,
            workspaceId: input.workspaceId,
            connectionId: fallback.connectionId,
          },
          select: {
            id: true,
            organizationId: true,
            providerChannelId: true,
            status: true,
            productionActivatedAt: true,
            conversionEngineMode: true,
          },
        });
      }
      if (candidates.length !== 1) return null;
      if (proof && candidates[0]!.id !== proof.channelId) return null;
      return candidates[0]!;
    }

    // Fase 5.3: an Umbler callback routed by the URL por evento already has
    // its number (channel.phone or the contact's single number). Recomputing
    // it by the last message could pick another number (two numbers within
    // 30 days) and silently drop or duplicate the conversion.
    if (input.rule.parserRelease.provider === "umbler" && input.routedChannelId) {
      if (!channelIds.includes(input.routedChannelId)) return null;
      return this.prisma.inboundWebhookChannel.findFirst({
        where: {
          id: input.routedChannelId,
          workspaceId: input.workspaceId,
          connectionId: input.connectionId,
        },
        select: {
          id: true,
          organizationId: true,
          providerChannelId: true,
          status: true,
          productionActivatedAt: true,
          conversionEngineMode: true,
        },
      });
    }

    const recentEvent = await this.prisma.inboundWebhookEvent.findFirst({
      where: {
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        ...(input.rule.parserRelease.provider === "unnichat"
          ? { hasCtwa: true }
          : {}),
        channelId: { in: channelIds },
        contactIdentityHash:
          contactIdentityHashes.length === 1
            ? contactIdentityHashes[0]!
            : { in: contactIdentityHashes },
        occurredAt: {
          lte: new Date(input.deliveryReceivedAt.getTime() + 5 * 60 * 1_000),
        },
      },
      orderBy: { occurredAt: "desc" },
      select: {
        channel: {
          select: {
            id: true,
            organizationId: true,
            providerChannelId: true,
            status: true,
            productionActivatedAt: true,
            conversionEngineMode: true,
          },
        },
      },
    });
    if (recentEvent?.channel) return recentEvent.channel;

    // An Unnichat CRM movement is only attributable when the same contact was
    // previously observed through CTWA on a scoped channel. Do not fall back
    // to the rule's single channel: that would turn a movement into a lead.
    if (input.rule.parserRelease.provider === "unnichat") return null;

    if (
      providerRuleScope(input.rule) !== "specific_numbers" ||
      input.rule.channels.length !== 1
    )
      return null;
    const fallback = input.rule.channels[0]!.channel;
    return {
      id: fallback.id,
      organizationId: "",
      providerChannelId: "",
      status: fallback.status,
      productionActivatedAt: fallback.productionActivatedAt,
      conversionEngineMode: fallback.conversionEngineMode,
    };
  }

  /** The lead may have been matched through an equivalent BR form (with or
   * without 55 / the mobile 9th digit); its entry evidence is stored under
   * the lead's own identity hash. */
  private paytPurchaseIdentityHashes(
    input: { phone: string; phoneCandidates?: readonly string[] },
    leadPhoneHash: string,
  ): string[] {
    const phones = [input.phone, ...(input.phoneCandidates ?? [])];
    return [
      ...new Set([
        leadPhoneHash,
        ...phones
          .map((phone) => hashPhoneIdentity(phone))
          .filter((hash): hash is string => Boolean(hash)),
        ...hashPhoneIdentityVariants(phones),
      ]),
    ];
  }

  /**
   * True only when the paid lead's verified CTWA origin is a channel OUTSIDE
   * this Payt rule's scope (the sale belongs to the rule of another number).
   * No-ad leads use their typed entry proof; ad leads use the same
   * materialized-origin evidence as the purchase routing.
   */
  private async paytLeadFromAnotherChannel(input: {
    workspaceId: string;
    rule: AutomationRule;
    lead: Extract<
      ProviderConversionPaidLeadResolutionDto,
      { status: "resolved" }
    >["lead"];
    phone: string;
    phoneCandidates?: readonly string[];
    deliveryReceivedAt: Date;
  }): Promise<boolean> {
    const scoped = new Set(
      await resolveProviderRuleScopeChannelIds(
        this.prisma,
        input.workspaceId,
        input.rule,
      ),
    );
    if (!input.lead.adId) {
      const proof = input.lead.ctwaDestination;
      return Boolean(proof && !scoped.has(proof.channelId));
    }
    const others = await this.prisma.inboundWebhookChannel.findMany({
      where: { workspaceId: input.workspaceId, id: { notIn: [...scoped] } },
      select: { id: true },
      take: 500,
    });
    if (others.length === 0) return false;
    const origins = await resolvePurchaseChannels(this.prisma, {
      workspaceId: input.workspaceId,
      channelIds: others.map((channel) => channel.id),
      phoneHashes: this.paytPurchaseIdentityHashes(input, input.lead.phoneHash),
      leadId: input.lead.id,
      adId: input.lead.adId,
      ctwaClid: input.lead.ctwaClid,
      receivedAt: input.deliveryReceivedAt,
    });
    return origins.length > 0;
  }

  private async loadChannels(
    input: {
      workspaceId: string;
      connectionId: string;
    },
    candidates: ParsedInboundWebhookEvent[],
  ): Promise<ObservedChannel[]> {
    return this.prisma.inboundWebhookChannel.findMany({
      where: {
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        OR: candidates.map((event) => ({
          organizationId: event.organizationId,
          providerChannelId: event.channel.providerChannelId,
        })),
      },
      select: {
        id: true,
        organizationId: true,
        providerChannelId: true,
        status: true,
        productionActivatedAt: true,
        conversionEngineMode: true,
      },
    });
  }

  /**
   * Candidate rules of the delivery: bound to its connection (every rule
   * created before the workspace scope, loaded exactly as before) or unbound,
   * and either scoped to one of its channels or "all numbers". Precedence and
   * provider capability are applied per channel by the caller.
   */
  private async loadRules(
    input: {
      workspaceId: string;
      connectionId: string;
    },
    channels: ObservedChannel[],
  ): Promise<ObservedRule[]> {
    return this.prisma.providerConversionRuleConfig.findMany({
      where: {
        workspaceId: input.workspaceId,
        removedAt: null,
        conversionRule: {
          active: true,
          triggerType: { in: ["structured_catalog", "message_phrase"] },
        },
        ...providerRuleCandidateWhere({
          connectionId: input.connectionId,
          channelIds: channels.map((channel) => channel.id),
        }),
      },
      include: observedRuleInclude,
      orderBy: { createdAt: "asc" },
    });
  }

  private async loadGateConnection(input: {
    workspaceId: string;
    connectionId: string;
  }): Promise<GateConnection | null> {
    return this.prisma.inboundWebhookConnection.findFirst({
      where: { id: input.connectionId, workspaceId: input.workspaceId },
      select: {
        id: true,
        status: true,
        removedAt: true,
        parserReleaseId: true,
        parserRelease: {
          select: { id: true, provider: true, version: true, status: true },
        },
      },
    });
  }

  private async resolvePaidLead(
    workspaceId: string,
    phone: string,
    cache: Map<
      string,
      Promise<ProviderConversionPaidLeadResolutionDto>
    >,
  ): Promise<ProviderConversionPaidLeadResolutionDto> {
    const cacheKey = phone.trim();
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const resolution = this.paidLeads.resolve({
      workspaceId,
      phone,
    });
    cache.set(cacheKey, resolution);
    return resolution;
  }

  private isUnnichatWithoutCtwa(
    automation: ParsedProviderAutomation,
  ): automation is Extract<ParsedProviderAutomation, { provider: "unnichat" }> {
    return automation.provider === "unnichat" && !automation.hasCtwa;
  }

  /** No ctwa_clid, nothing is sent: the callback is kept as a blocked
   * execution (ctwa_missing) for the audit, without lead or decision. */
  private async recordUnnichatCtwaMissing(input: {
    input: {
      workspaceId: string;
      connectionId: string;
      deliveryId: string;
      providerRuleId: string;
      automation: ParsedProviderAutomation;
    };
    rule: AutomationRule;
  }): Promise<ProviderConversionAutomationObservationResult> {
    const execution = await this.prisma.providerConversionRuleExecution.upsert({
      where: {
        providerRuleId_externalExecutionKey: {
          providerRuleId: input.rule.id,
          externalExecutionKey: input.input.automation.externalExecutionKey,
        },
      },
      create: {
        workspaceId: input.input.workspaceId,
        providerRuleId: input.rule.id,
        sourceDeliveryId: input.input.deliveryId,
        channelWorkspaceId: null,
        channelId: null,
        externalExecutionKey: input.input.automation.externalExecutionKey,
        occurredAt: input.input.automation.occurredAt,
        contactIdentityHash: hashPhoneIdentity(input.input.automation.phone),
        status: "blocked",
        reasonCode: "ctwa_missing",
        normalizedResult: Prisma.JsonNull,
        valueCents: null,
        currency: null,
        leadId: null,
      },
      update: {
        sourceDeliveryId: input.input.deliveryId,
        status: "blocked",
        reasonCode: "ctwa_missing",
        processedAt: null,
      },
      select: { id: true },
    });

    return {
      decisionId: null,
      decisionCode: null,
      reasonCode: "ctwa_missing",
      disposition: "blocked",
      executionId: execution.id,
      eligibleExecutionId: null,
      reviewId: null,
      channelId: null,
      leadResolved: false,
    };
  }

  private disposition(input: {
    config: ReturnType<typeof parseInboundWebhooksConfig>;
    decision: ProviderConversionDecisionDto;
    rule: ObservedRule;
    /** The rule's own connection, or the delivery's for an unbound rule. */
    gateConnection: GateConnection;
    channel: ObservedChannel | null;
    deliveryReceivedAt: Date;
    manualRecovery: boolean;
  }): ProviderConversionTechnicalDisposition {
    if (!input.channel) {
      return {
        state: "blocked",
        reasonCode: "automation_channel_unresolved",
      };
    }
    // Payt is only sent by the canonical engine; legacy/shadow channels keep
    // its sales audit-only. Canonical production still requires every live
    // certification, activation and feature gate below.
    if (
      input.rule.parserRelease?.provider === "payt" &&
      input.channel.conversionEngineMode !== "canonical"
    ) {
      return {
        state: "observed",
        reasonCode: `${input.decision.reasonCode}_payt_observation`,
      };
    }
    // Manual recovery reuses the frozen decision snapshot (including the mode
    // from when the callback first arrived). After the operator activates the
    // rule, production eligibility must follow the LIVE rule mode — otherwise
    // observed callbacks stay stuck as "1 ignorado" forever.
    const effectiveMode = input.manualRecovery
      ? input.rule.mode
      : input.decision.rule.mode;
    if (
      !input.config.conversionProductionEnabled ||
      effectiveMode !== "production"
    ) {
      return {
        state: "observed",
        reasonCode: `${input.decision.reasonCode}_observation`,
      };
    }
    // An unbound rule has no parser of its own: the occurrence connection's
    // parser is the one that produced the event.
    const ruleParserRelease =
      input.rule.parserRelease ?? input.gateConnection.parserRelease;
    if (
      !inboundParserProductionEligible(ruleParserRelease) ||
      !inboundParserProductionEligible(input.gateConnection.parserRelease) ||
      (input.decision.rule.triggerType !== "provider_automation" &&
        input.rule.parserReleaseId !== null &&
        input.rule.parserReleaseId !== input.gateConnection.parserReleaseId) ||
      input.gateConnection.status !== "production" ||
      input.gateConnection.removedAt !== null ||
      input.channel.status !== "active"
    ) {
      return {
        state: "blocked",
        reasonCode: "production_context_invalid",
      };
    }
    if (
      !input.rule.productionActivatedAt ||
      (!input.manualRecovery &&
        (!input.channel.productionActivatedAt ||
          input.deliveryReceivedAt < input.rule.productionActivatedAt ||
          input.deliveryReceivedAt < input.channel.productionActivatedAt))
    ) {
      return {
        state: "observed",
        reasonCode: "before_production_activation",
      };
    }

    return {
      state: "eligible",
      reasonCode: input.decision.reasonCode,
    };
  }

  private ruleSnapshot(
    rule: ObservedRule,
  ): ProviderConversionDecisionRuleSnapshotDto {
    const triggerType = this.providerTriggerType(rule);
    const eventName = this.providerEventName(rule);
    const messagePhrase = readMessagePhraseConfig(
      rule.conversionRule.defaultItems,
    );
    const base = {
      providerRuleId: rule.id,
      conversionRuleId: rule.conversionRuleId,
      triggerType,
      eventName,
      mode: rule.mode,
      active: rule.conversionRule.active && rule.removedAt === null,
      authorScope: rule.messageAuthorScope,
      triggerPhrases: [...rule.messageTriggerPhrases],
      defaultValueCents: rule.conversionRule.defaultValueCents,
      defaultCurrency: rule.conversionRule.defaultCurrency,
      defaultContentName: rule.conversionRule.defaultContentName,
      valueMode:
        triggerType === "message_phrase" ? messagePhrase.valueMode : "fixed",
      exampleMessage:
        triggerType === "message_phrase" ? messagePhrase.exampleMessage : null,
    } satisfies Omit<ProviderConversionDecisionRuleSnapshotDto, "version">;

    return {
      ...base,
      version: this.snapshotVersion("rule", {
        ...base,
        providerRuleUpdatedAt: rule.updatedAt.toISOString(),
        conversionRuleUpdatedAt: rule.conversionRule.updatedAt.toISOString(),
      }),
    };
  }

  private catalogSnapshot(
    rule: ObservedRule,
  ): ProviderConversionDecisionCatalogSnapshotDto | null {
    if (!rule.catalog) return null;

    const catalog = this.catalogDto(rule);
    return {
      version: this.snapshotVersion("catalog", catalog),
      catalog,
    };
  }

  private catalogDto(rule: ObservedRule): ProviderConversionCatalogDto {
    const catalog = rule.catalog;
    if (!catalog) {
      throw new Error("Structured catalog rule is missing its catalog");
    }

    return {
      id: catalog.id,
      name: catalog.name,
      productName: catalog.productName,
      currency: catalog.currency,
      active: catalog.active,
      attributes: catalog.attributes.map((attribute) => ({
        id: attribute.id,
        position: attribute.position,
        key: attribute.key,
        label: attribute.label,
      })),
      variants: catalog.variants.map((variant) => ({
        id: variant.id,
        normalizedKey: variant.normalizedKey,
        attributeValues: this.stringArray(variant.attributeValues),
        aliases: this.nestedStringArray(variant.aliases),
        valueCents: variant.valueCents,
        contentName: variant.contentName,
        active: variant.active,
      })),
    };
  }

  private providerTriggerType(
    rule: ObservedRule,
  ): "structured_catalog" | "message_phrase" | "provider_automation" {
    const triggerType = rule.conversionRule.triggerType;
    if (
      triggerType !== "structured_catalog" &&
      triggerType !== "message_phrase" &&
      triggerType !== "provider_automation"
    ) {
      throw new Error(`Unsupported provider message rule: ${triggerType}`);
    }

    return triggerType;
  }

  private providerEventName(rule: ObservedRule): ConversionEventNameDto {
    const eventName = conversionEventNameSchema.safeParse(
      rule.conversionRule.eventName,
    );
    // Fail closed on junk in the database, but accept every catalog event.
    if (!eventName.success) {
      throw new Error(
        `Unsupported provider conversion event: ${rule.conversionRule.eventName}`,
      );
    }

    return eventName.data;
  }

  private requiredExistingDecision(
    decision: PersistedProviderConversionDecision | null,
  ): PersistedProviderConversionDecision {
    if (decision) return decision;

    throw new Error(
      "Provider conversion reevaluation requires an existing decision",
    );
  }

  private channelForEvent(
    channels: ObservedChannel[],
    event: ParsedInboundWebhookEvent,
  ): ObservedChannel | null {
    return (
      channels.find(
        (candidate) =>
          candidate.organizationId === event.organizationId &&
          candidate.providerChannelId === event.channel.providerChannelId,
      ) ?? null
    );
  }

  private stringArray(value: Prisma.JsonValue): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  }

  private nestedStringArray(value: Prisma.JsonValue | null): string[][] {
    return Array.isArray(value)
      ? value.map((item) => this.stringArray(item))
      : [];
  }

  private snapshotVersion(prefix: string, value: unknown): string {
    const digest = createHash("sha256")
      .update(JSON.stringify(value), "utf8")
      .digest("hex");

    return `${prefix}-v1:${digest}`;
  }

  private logDecision(
    persisted: PersistedProviderConversionDecision,
    created: boolean,
  ): void {
    this.logger.log(
      JSON.stringify({
        event: "provider_conversion_decided",
        workspaceId: persisted.workspaceId,
        sourceDeliveryId: persisted.sourceDeliveryId,
        decisionId: persisted.id,
        decisionVersion: persisted.decisionVersion,
        occurrenceKey: persisted.occurrenceKey,
        decisionCode: persisted.decisionCode,
        reasonCode: persisted.reasonCode,
        created,
      }),
    );
  }

  private emptyResult(): ProviderConversionObservationResult {
    return {
      executionIds: [],
      eligibleExecutionIds: [],
    };
  }
}
