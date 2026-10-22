import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  providerConversionDecisionOutcome,
  type ProviderConversionCanonicalDecision,
} from "./provider-conversion-decision.types";
import type { PersistedProviderConversionDecision } from "./provider-conversion-decision.repository";

const terminalExecutionStatuses = new Set([
  "materialized",
  "duplicate",
]);
const preservedReviewStatuses = new Set([
  "approved",
  "sent",
  "duplicate",
  "rejected",
  "corrected_after_send",
]);

export type ProviderConversionTechnicalDisposition =
  | {
      state: "observed";
      reasonCode: string;
    }
  | {
      state: "eligible";
      reasonCode: string;
    }
  | {
      state: "blocked";
      reasonCode: string;
    };

/**
 * Explicit operator approval to replay one callback in production. Only the
 * manager action "Reprocessar selecionados" (production mode) passes it; the
 * webhook ingestion, queue sweeps and automatic retries never do. The
 * production worker reads it back from `normalizedResult.manualReplayApproval`
 * (provider-manual-replay-approval) to accept callbacks received before the
 * rule/channel production activation.
 */
export type ProviderConversionManualReplayApproval = {
  actorUserId: string;
  reason: "operator_reprocess";
};

export type ProviderConversionOrchestrationResult = {
  executionId: string | null;
  eligibleExecutionId: string | null;
  reviewId: string | null;
  /** The sale (purchaseKey) already has an observation winner. */
  purchaseDuplicate?: boolean;
};

type ProviderConversionPersistenceClient = Pick<
  Prisma.TransactionClient,
  "providerConversionRuleExecution" | "purchaseReview" | "purchaseReviewItem"
>;

@Injectable()
export class ProviderConversionOrchestrator {
  private readonly logger = new Logger(ProviderConversionOrchestrator.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async orchestrate(input: {
    persistedDecision: PersistedProviderConversionDecision;
    disposition: ProviderConversionTechnicalDisposition;
    /**
     * A UAZAPI chat-label match in observation mode is useful evidence even
     * without paid attribution. Keep that one fail-closed outcome visible to
     * the operator, but never make it eligible for production processing.
     */
    recordIgnoredObservation?: boolean;
    manualReplayApproval?: ProviderConversionManualReplayApproval;
  }): Promise<ProviderConversionOrchestrationResult> {
    const { persistedDecision } = input;
    const outcome = providerConversionDecisionOutcome(
      persistedDecision.decision,
    );

    if (
      outcome === "ignored" &&
      input.recordIgnoredObservation &&
      persistedDecision.decision.decisionCode === "ignored_untracked_lead" &&
      persistedDecision.decision.rule.mode === "observation" &&
      input.disposition.state === "blocked"
    ) {
      const execution = await this.persistExecution({
        persistedDecision,
        disposition: input.disposition,
      });
      this.logResult(input, "execution_blocked", execution.id);
      return {
        executionId: execution.id,
        eligibleExecutionId: null,
        reviewId: null,
      };
    }

    if (outcome === "ignored" || outcome === "duplicate") {
      this.logResult(input, "audit_only");
      return this.emptyResult();
    }

    if (outcome === "review") {
      const reviewId = await this.prisma.$transaction((transaction) =>
        this.persistReview(transaction, persistedDecision),
      );
      this.logResult(input, "review_created");
      return {
        executionId: null,
        eligibleExecutionId: null,
        reviewId,
      };
    }

    const purchaseKey = persistedDecision.decision.occurrence.purchaseKey;
    if (
      persistedDecision.decision.occurrence.provider === "payt" &&
      purchaseKey &&
      input.disposition.state === "observed"
    ) {
      return this.persistObservedPurchase(input, purchaseKey);
    }

    const approval =
      input.manualReplayApproval && input.disposition.state === "eligible"
        ? input.manualReplayApproval
        : null;
    const execution = approval
      ? await this.prisma.$transaction((transaction) =>
          this.persistApprovedExecution(
            transaction,
            { persistedDecision, disposition: input.disposition },
            approval,
          ),
        )
      : await this.persistExecution({
          persistedDecision,
          disposition: input.disposition,
        });
    this.logResult(input, `execution_${execution.status}`, execution.id);

    return {
      executionId: execution.id,
      eligibleExecutionId:
        execution.status === "eligible" ? execution.id : null,
      reviewId: null,
    };
  }

  /**
   * One observation winner per sale (seller + order + event): the first
   * delivery of the sale owns the observed execution; any other delivery of the
   * same sale is reported as a duplicate. Serialized per purchase key.
   */
  private persistObservedPurchase(
    input: {
      persistedDecision: PersistedProviderConversionDecision;
      disposition: ProviderConversionTechnicalDisposition;
    },
    purchaseKey: string,
  ): Promise<ProviderConversionOrchestrationResult> {
    const { persistedDecision } = input;
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${purchaseKey}, 0))::text`;
      const existing = await transaction.providerPurchaseClaim.findUnique({
        where: {
          workspaceId_effectMode_purchaseKey: {
            workspaceId: persistedDecision.workspaceId,
            effectMode: "observation",
            purchaseKey,
          },
        },
      });
      if (existing) {
        // An explicit observation re-evaluation of the claim winner itself
        // (new decision for the same rule and sale) refreshes that observed
        // execution. Any other delivery of the sale stays a duplicate.
        const winner =
          await transaction.providerConversionRuleExecution.findUnique({
            where: {
              providerRuleId_externalExecutionKey: {
                providerRuleId: persistedDecision.providerRuleId,
                externalExecutionKey: persistedDecision.occurrenceKey,
              },
            },
            select: { id: true, status: true, providerDecisionId: true },
          });
        if (
          winner?.id === existing.winnerExecutionId &&
          winner.status === "observed" &&
          winner.providerDecisionId !== persistedDecision.id
        ) {
          const execution = await this.persistExecution(
            { persistedDecision, disposition: input.disposition },
            transaction,
          );
          return {
            executionId: execution.id,
            eligibleExecutionId: null,
            reviewId: null,
          };
        }
        return {
          executionId: existing.winnerExecutionId,
          eligibleExecutionId: null,
          reviewId: null,
          purchaseDuplicate: true,
        };
      }
      const execution = await this.persistExecution(
        { persistedDecision, disposition: input.disposition },
        transaction,
      );
      await transaction.providerPurchaseClaim.create({
        data: {
          workspaceId: persistedDecision.workspaceId,
          purchaseKey,
          effectMode: "observation",
          winnerExecutionId: execution.id,
        },
      });
      return {
        executionId: execution.id,
        eligibleExecutionId: null,
        reviewId: null,
      };
    });
  }

  /**
   * Writes the eligible execution and the operator approval atomically, with
   * the audit entry in the same transaction: the approval never exists without
   * its audit trail, and never on an execution that is not eligible.
   */
  private async persistApprovedExecution(
    transaction: Prisma.TransactionClient,
    input: {
      persistedDecision: PersistedProviderConversionDecision;
      disposition: ProviderConversionTechnicalDisposition;
    },
    approval: ProviderConversionManualReplayApproval,
  ): Promise<{ id: string; status: string }> {
    const persisted = input.persistedDecision;
    const manualReplayApproval = {
      approved: true,
      actorUserId: approval.actorUserId,
      approvedAt: new Date().toISOString(),
      reason: approval.reason,
      decisionId: persisted.id,
    };
    const execution = await this.persistExecution(
      input,
      transaction,
      manualReplayApproval,
    );
    if (execution.status !== "eligible") return execution;

    await transaction.auditLog.create({
      data: {
        workspaceId: persisted.workspaceId,
        actorUserId: approval.actorUserId,
        actorType: "user",
        action: "provider_conversion_automation.manual_replay_approved",
        targetType: "ProviderConversionRuleExecution",
        targetId: execution.id,
        reason: "Operator explicitly reprocessed this callback in production",
        sourceIp: null,
        resultStatus: "approved",
        afterSummary: {
          providerRuleId: persisted.providerRuleId,
          sourceDeliveryId: persisted.sourceDeliveryId,
          decisionId: persisted.id,
          occurrenceKey: persisted.occurrenceKey,
          manualReplayApproval,
        },
      },
    });

    return execution;
  }

  private async persistExecution(
    input: {
      persistedDecision: PersistedProviderConversionDecision;
      disposition: ProviderConversionTechnicalDisposition;
    },
    client: Pick<
      Prisma.TransactionClient,
      "providerConversionRuleExecution"
    > = this.prisma,
    manualReplayApproval: Prisma.InputJsonObject | null = null,
  ): Promise<{ id: string; status: string }> {
    const persisted = input.persistedDecision;
    const decision = persisted.decision;
    // The disposition state is the execution status one-to-one: only
    // `eligible` is ever picked up by the production pipeline, so `observed`
    // stays visible in the audit UI without any chance of reaching CAPI.
    const status = input.disposition.state;
    const existing =
      await client.providerConversionRuleExecution.findUnique({
        where: {
          providerRuleId_externalExecutionKey: {
            providerRuleId: persisted.providerRuleId,
            externalExecutionKey: persisted.occurrenceKey,
          },
        },
        select: {
          id: true,
          status: true,
          providerDecisionId: true,
          normalizedResult: true,
        },
      });

    if (existing && terminalExecutionStatuses.has(existing.status)) {
      return { id: existing.id, status: existing.status };
    }
    if (
      existing?.providerDecisionId === persisted.id &&
      existing.status === status
    ) {
      // Already eligible for this decision (queued but not yet processed):
      // attach the explicit approval without resetting anything else.
      if (manualReplayApproval) {
        const current =
          existing.normalizedResult &&
          typeof existing.normalizedResult === "object" &&
          !Array.isArray(existing.normalizedResult)
            ? (existing.normalizedResult as Prisma.InputJsonObject)
            : {};
        await client.providerConversionRuleExecution.update({
          where: { id: existing.id },
          data: {
            normalizedResult: { ...current, manualReplayApproval },
          },
        });
      }
      return { id: existing.id, status: existing.status };
    }

    const catalogVariantId = this.singleCatalogVariantId(decision);
    const normalizedResult: Prisma.InputJsonValue = manualReplayApproval
      ? {
          ...(this.normalizedResult(persisted) as Prisma.InputJsonObject),
          manualReplayApproval,
        }
      : this.normalizedResult(persisted);

    return client.providerConversionRuleExecution.upsert({
      where: {
        providerRuleId_externalExecutionKey: {
          providerRuleId: persisted.providerRuleId,
          externalExecutionKey: persisted.occurrenceKey,
        },
      },
      create: {
        workspaceId: persisted.workspaceId,
        providerRuleId: persisted.providerRuleId,
        sourceDeliveryId: persisted.sourceDeliveryId,
        channelWorkspaceId: persisted.channelId
          ? persisted.workspaceId
          : null,
        channelId: persisted.channelId,
        matchedCatalogVariantWorkspaceId: catalogVariantId
          ? persisted.workspaceId
          : null,
        matchedCatalogVariantId: catalogVariantId,
        providerDecisionWorkspaceId: persisted.workspaceId,
        providerDecisionId: persisted.id,
        externalExecutionKey: persisted.occurrenceKey,
        occurredAt: persisted.occurredAt,
        contactIdentityHash: decision.occurrence.contactIdentityHash,
        status,
        reasonCode: input.disposition.reasonCode,
        normalizedResult,
        valueCents: decision.conversion.valueCents,
        currency: decision.conversion.currency,
        leadId: persisted.leadId,
      },
      update: {
        sourceDeliveryId: persisted.sourceDeliveryId,
        channelWorkspaceId: persisted.channelId
          ? persisted.workspaceId
          : null,
        channelId: persisted.channelId,
        matchedCatalogVariantWorkspaceId: catalogVariantId
          ? persisted.workspaceId
          : null,
        matchedCatalogVariantId: catalogVariantId,
        providerDecisionWorkspaceId: persisted.workspaceId,
        providerDecisionId: persisted.id,
        occurredAt: persisted.occurredAt,
        contactIdentityHash: decision.occurrence.contactIdentityHash,
        status,
        reasonCode: input.disposition.reasonCode,
        normalizedResult,
        valueCents: decision.conversion.valueCents,
        currency: decision.conversion.currency,
        leadId: persisted.leadId,
        processedAt: null,
      },
      select: {
        id: true,
        status: true,
      },
    });
  }

  private async persistReview(
    client: ProviderConversionPersistenceClient,
    persisted: PersistedProviderConversionDecision,
  ): Promise<string> {
    const decision = persisted.decision;
    if (
      decision.decisionCode !== "review_required" ||
      decision.leadResolution.status !== "resolved"
    ) {
      throw new Error("Only a resolved review decision can create a review");
    }

    const existing = await client.purchaseReview.findUnique({
      where: {
        providerRuleId_externalOccurrenceKey: {
          providerRuleId: persisted.providerRuleId,
          externalOccurrenceKey: persisted.occurrenceKey,
        },
      },
      select: {
        id: true,
        status: true,
      },
    });
    if (existing && preservedReviewStatuses.has(existing.status)) {
      return existing.id;
    }

    const review = await client.purchaseReview.upsert({
      where: {
        providerRuleId_externalOccurrenceKey: {
          providerRuleId: persisted.providerRuleId,
          externalOccurrenceKey: persisted.occurrenceKey,
        },
      },
      create: {
        workspaceId: persisted.workspaceId,
        providerRuleId: persisted.providerRuleId,
        sourceDeliveryId: persisted.sourceDeliveryId,
        channelWorkspaceId: persisted.channelId
          ? persisted.workspaceId
          : null,
        channelId: persisted.channelId,
        providerDecisionWorkspaceId: persisted.workspaceId,
        providerDecisionId: persisted.id,
        externalOccurrenceKey: persisted.occurrenceKey,
        occurredAt: persisted.occurredAt,
        contactIdentityHash: decision.occurrence.contactIdentityHash,
        sourceType:
          decision.occurrence.source === "automation"
            ? "provider_automation"
            : "provider_message",
        messageAuthorType: decision.occurrence.authorType,
        matchedTriggerPhrase: decision.conversion.matchedTriggerPhrase,
        status: "review_required",
        classificationCode: "review_required",
        reasonCode: decision.reasonCode,
        observedPaymentValueCents:
          decision.conversion.observedPaymentValueCents,
        calculatedValueCents: decision.conversion.valueCents,
        effectiveValueCents: decision.conversion.valueCents,
        currency: decision.conversion.currency ?? "BRL",
        leadWorkspaceId: persisted.workspaceId,
        leadId: decision.leadResolution.lead.id,
      },
      update: {
        sourceDeliveryId: persisted.sourceDeliveryId,
        channelWorkspaceId: persisted.channelId
          ? persisted.workspaceId
          : null,
        channelId: persisted.channelId,
        providerDecisionWorkspaceId: persisted.workspaceId,
        providerDecisionId: persisted.id,
        occurredAt: persisted.occurredAt,
        contactIdentityHash: decision.occurrence.contactIdentityHash,
        sourceType:
          decision.occurrence.source === "automation"
            ? "provider_automation"
            : "provider_message",
        messageAuthorType: decision.occurrence.authorType,
        matchedTriggerPhrase: decision.conversion.matchedTriggerPhrase,
        status: "review_required",
        classificationCode: "review_required",
        reasonCode: decision.reasonCode,
        observedPaymentValueCents:
          decision.conversion.observedPaymentValueCents,
        calculatedValueCents: decision.conversion.valueCents,
        effectiveValueCents: decision.conversion.valueCents,
        currency: decision.conversion.currency ?? "BRL",
        leadWorkspaceId: persisted.workspaceId,
        leadId: decision.leadResolution.lead.id,
        version: { increment: 1 },
      },
      select: {
        id: true,
      },
    });

    await client.purchaseReviewItem.deleteMany({
      where: {
        workspaceId: persisted.workspaceId,
        purchaseReviewId: review.id,
      },
    });
    if (decision.conversion.items.length > 0) {
      await client.purchaseReviewItem.createMany({
        data: decision.conversion.items.map((item) => ({
          workspaceId: persisted.workspaceId,
          purchaseReviewId: review.id,
          position: item.position,
          catalogVariantWorkspaceId: item.catalogVariantId
            ? persisted.workspaceId
            : null,
          catalogVariantId: item.catalogVariantId,
          attributeValues: item.parsedAttributes.map(
            (attribute) => attribute.value,
          ),
          quantity: item.quantity,
          unitValueCents: item.unitValueCents,
          subtotalValueCents: item.subtotalValueCents,
          contentName: item.contentName,
        })),
      });
    }

    return review.id;
  }

  private normalizedResult(
    persisted: PersistedProviderConversionDecision,
  ): Prisma.InputJsonValue {
    const decision = persisted.decision;

    return {
      decisionId: persisted.id,
      decisionVersion: persisted.decisionVersion,
      engineVersion: decision.engineVersion,
      parserVersion: decision.parserVersion,
      matched: true,
      classification: "recognized",
      reasonCode: decision.reasonCode,
      matchedTriggerPhrase: decision.conversion.matchedTriggerPhrase,
      items: decision.conversion.items,
      calculatedValueCents: decision.conversion.valueCents,
      observedPaymentValueCents:
        decision.conversion.observedPaymentValueCents,
      contentName: decision.conversion.contentName,
      currency: decision.conversion.currency,
    } as Prisma.InputJsonValue;
  }

  private singleCatalogVariantId(
    decision: ProviderConversionCanonicalDecision,
  ): string | null {
    if (decision.conversion.items.length !== 1) return null;

    return decision.conversion.items[0]?.catalogVariantId ?? null;
  }

  private emptyResult(): ProviderConversionOrchestrationResult {
    return {
      executionId: null,
      eligibleExecutionId: null,
      reviewId: null,
    };
  }

  private logResult(
    input: {
      persistedDecision: PersistedProviderConversionDecision;
      disposition: ProviderConversionTechnicalDisposition;
    },
    effect: string,
    executionId: string | null = null,
  ): void {
    const persisted = input.persistedDecision;
    this.logger.log(
      JSON.stringify({
        event: "provider_conversion_orchestrated",
        workspaceId: persisted.workspaceId,
        sourceDeliveryId: persisted.sourceDeliveryId,
        decisionId: persisted.id,
        decisionVersion: persisted.decisionVersion,
        occurrenceKey: persisted.occurrenceKey,
        decisionCode: persisted.decisionCode,
        disposition: input.disposition.state,
        effect,
        executionId,
      }),
    );
  }
}
