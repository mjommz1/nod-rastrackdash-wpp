import { inboundParserProductionEligible } from "../inbound-webhooks/inbound-webhook-parser-eligibility";
import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  ProviderConversionCatalogDto,
  ProviderConversionDecisionCatalogSnapshotDto,
  ProviderConversionDecisionDto,
  ProviderConversionDecisionRuleSnapshotDto,
  PurchaseReviewDecisionInputDto,
} from "@wpptrack/shared";
import { readMessagePhraseConfig } from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import { PROVIDER_CONVERSION_DECISION_ENGINE_VERSION } from "./provider-conversion-decision.engine";
import {
  ProviderConversionDecisionRepository,
  type PersistedProviderConversionDecision,
} from "./provider-conversion-decision.repository";
import { ProviderConversionOrchestrator } from "./provider-conversion-orchestrator.service";
import { providerRuleCoversChannel } from "./provider-rule-scope";

const canonicalReviewInclude = {
  providerDecision: true,
  providerExecution: {
    select: {
      id: true,
      status: true,
      providerDecisionId: true,
      normalizedResult: true,
    },
  },
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
        select: {
          channelId: true,
        },
      },
      catalog: {
        include: {
          attributes: { orderBy: { position: "asc" } },
          variants: { orderBy: { createdAt: "asc" } },
        },
      },
    },
  },
  // The channel's connection gates rules that span connections (no binding).
  channel: { include: { connection: { include: { parserRelease: true } } } },
  items: { orderBy: { position: "asc" } },
} satisfies Prisma.PurchaseReviewInclude;

type CanonicalReview = Prisma.PurchaseReviewGetPayload<{
  include: typeof canonicalReviewInclude;
}>;

const approvableStatuses = new Set([
  "recognized",
  "awaiting_data",
  "review_required",
  "failed",
  "approved",
]);

@Injectable()
export class ProviderConversionReviewApprovalService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProviderConversionDecisionRepository)
    private readonly decisions: ProviderConversionDecisionRepository,
    @Inject(ProviderConversionOrchestrator)
    private readonly orchestrator: ProviderConversionOrchestrator,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv = process.env,
  ) {}

  async prepareApproval(input: {
    workspaceId: string;
    reviewId: string;
    decision: PurchaseReviewDecisionInputDto;
    actorUserId: string;
  }): Promise<{ providerConversionExecutionId: string } | null> {
    const review = await this.prisma.purchaseReview.findFirst({
      where: {
        id: input.reviewId,
        workspaceId: input.workspaceId,
      },
      include: canonicalReviewInclude,
    });
    if (!review?.providerDecisionId) return null;

    if (
      review.providerExecutionId &&
      (review.status === "approved" || review.conversionEventLogId)
    ) {
      return {
        providerConversionExecutionId: review.providerExecutionId,
      };
    }
    if (
      review.status === "failed" &&
      review.providerExecution?.status === "failed" &&
      review.providerExecution.providerDecisionId ===
        review.providerDecisionId &&
      this.retryableTechnicalFailure(
        review.providerExecution.normalizedResult,
      )
    ) {
      return {
        providerConversionExecutionId: review.providerExecution.id,
      };
    }

    this.assertReviewIsApprovable(review);
    this.assertProductionReady(review);

    const latest = await this.decisions.findLatestByOccurrence({
      workspaceId: input.workspaceId,
      providerRuleId: review.providerRuleId,
      occurrenceKey: review.externalOccurrenceKey,
    });
    if (!latest) {
      throw new ConflictException(
        "A decisao auditavel desta compra nao foi encontrada",
      );
    }

    const reevaluationRequestKey = [
      "purchase-review",
      review.id,
      "approval",
      review.version,
    ].join(":");
    const expectedEvaluationKey =
      this.decisions.reevaluationEvaluationKey(reevaluationRequestKey);
    const persisted =
      latest.evaluationKey === expectedEvaluationKey
        ? this.requireEligibleReevaluation(latest)
        : await this.decisions.appendReevaluation({
            decision: this.correctedDecision(review, latest),
            sourceDeliveryId: review.sourceDeliveryId,
            supersedesDecisionId: latest.id,
            reevaluationRequestKey,
          });
    const orchestration = await this.orchestrator.orchestrate({
      persistedDecision: persisted,
      disposition: {
        state: "eligible",
        reasonCode: "purchase_review_approved",
      },
    });
    if (!orchestration.executionId || !orchestration.eligibleExecutionId) {
      throw new ConflictException(
        "A compra corrigida nao ficou elegivel para envio",
      );
    }

    const updated = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.purchaseReview.updateMany({
        where: {
          id: review.id,
          workspaceId: review.workspaceId,
          version: review.version,
        },
        data: {
          providerDecisionWorkspaceId: review.workspaceId,
          providerDecisionId: persisted.id,
          providerExecutionWorkspaceId: review.workspaceId,
          providerExecutionId: orchestration.executionId,
          status: "approved",
          classificationCode: "recognized",
          reasonCode: null,
          decisionReason: input.decision.reason,
          decidedByUserId: input.actorUserId,
          decidedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) return false;

      await transaction.auditLog.create({
        data: {
          workspaceId: review.workspaceId,
          actorUserId: input.actorUserId,
          actorType: "user",
          action: "purchase_review.approved",
          targetType: "PurchaseReview",
          targetId: review.id,
          reason: input.decision.reason,
          resultStatus: "success",
          beforeSummary: {
            providerConversionDecisionId: review.providerDecisionId,
            effectiveValueCents: review.effectiveValueCents,
          },
          afterSummary: {
            providerConversionDecisionId: persisted.id,
            providerConversionDecisionVersion: persisted.decisionVersion,
            providerConversionExecutionId: orchestration.executionId,
            effectiveValueCents: review.effectiveValueCents,
          },
        },
      });
      return true;
    });

    if (!updated) {
      const current = await this.prisma.purchaseReview.findFirst({
        where: {
          id: review.id,
          workspaceId: review.workspaceId,
        },
        select: {
          status: true,
          providerDecisionId: true,
          providerExecutionId: true,
        },
      });
      if (
        current?.status !== "approved" ||
        current.providerDecisionId !== persisted.id ||
        current.providerExecutionId !== orchestration.executionId
      ) {
        throw new ConflictException(
          "A revisao mudou enquanto era aprovada. Atualize a pagina.",
        );
      }
    }

    return {
      providerConversionExecutionId: orchestration.executionId,
    };
  }

  private assertReviewIsApprovable(review: CanonicalReview): void {
    const catalogReview =
      review.providerRule.conversionRule.triggerType === "structured_catalog";
    if (
      review.conversionEventLogId ||
      !approvableStatuses.has(review.status) ||
      !review.effectiveValueCents ||
      (catalogReview &&
        (review.items.length === 0 ||
          review.items.some(
            (item) =>
              !item.catalogVariantId ||
              !item.unitValueCents ||
              !item.subtotalValueCents,
          )))
    ) {
      throw new BadRequestException(
        "Revise todos os itens e valores antes de aprovar",
      );
    }
  }

  private assertProductionReady(review: CanonicalReview): void {
    const config = parseInboundWebhooksConfig(this.env);
    const rule = review.providerRule;
    const channel = review.channel;
    if (
      !config.enabled ||
      !config.conversionRulesEnabled ||
      !config.conversionProductionEnabled ||
      rule.mode !== "production"
    ) {
      throw new ConflictException(
        "Ative o envio automatico desta regra antes de aprovar",
      );
    }
    const connection = rule.connection ?? channel?.connection ?? null;
    const ruleParserRelease =
      rule.parserRelease ?? connection?.parserRelease ?? null;
    if (
      !channel ||
      !connection ||
      !ruleParserRelease ||
      rule.removedAt !== null ||
      !rule.conversionRule.active ||
      !inboundParserProductionEligible(ruleParserRelease) ||
      !inboundParserProductionEligible(connection.parserRelease) ||
      (rule.parserReleaseId !== null &&
        rule.parserReleaseId !== connection.parserReleaseId) ||
      connection.status !== "production" ||
      connection.removedAt !== null ||
      channel.status !== "active" ||
      !rule.productionActivatedAt ||
      !channel.productionActivatedAt ||
      !providerRuleCoversChannel(rule, {
        id: channel.id,
        connectionId: channel.connectionId,
        provider: channel.connection?.provider ?? "",
      })
    ) {
      throw new ConflictException(
        "A conexao, o canal ou o parser nao esta pronto para envio",
      );
    }
  }

  private correctedDecision(
    review: CanonicalReview,
    latest: PersistedProviderConversionDecision,
  ): ProviderConversionDecisionDto {
    const previous = latest.decision;
    if (
      (previous.occurrence.eventName !== "Purchase" &&
        previous.occurrence.eventName !== "InitiateCheckout") ||
      previous.leadResolution.status !== "resolved"
    ) {
      throw new ConflictException(
        "A revisao nao possui uma decisao de compra com lead pago",
      );
    }

    const rule = this.ruleSnapshot(review);
    const catalog = this.catalogSnapshot(review);
    const items = this.correctedItems(review, catalog);
    const contentName =
      items.length === 1
        ? (items[0]?.contentName ?? previous.conversion.contentName)
        : (catalog?.catalog.productName ??
          rule.defaultContentName ??
          previous.conversion.contentName);

    return {
      engineVersion: PROVIDER_CONVERSION_DECISION_ENGINE_VERSION,
      parserVersion:
        (
          review.providerRule.parserRelease ??
          review.channel?.connection?.parserRelease
        )?.version ?? previous.parserVersion,
      decisionCode: "eligible",
      reasonCode: "purchase_review_approved",
      occurrence: previous.occurrence,
      rule,
      catalog,
      conversion: {
        matchedTriggerPhrase:
          review.matchedTriggerPhrase ??
          previous.conversion.matchedTriggerPhrase,
        items,
        valueCents: review.effectiveValueCents,
        observedPaymentValueCents: review.observedPaymentValueCents,
        currency: review.currency,
        contentName,
      },
      leadResolution: previous.leadResolution,
    };
  }

  private correctedItems(
    review: CanonicalReview,
    catalogSnapshot: ProviderConversionDecisionCatalogSnapshotDto | null,
  ): ProviderConversionDecisionDto["conversion"]["items"] {
    if (
      review.providerRule.conversionRule.triggerType !== "structured_catalog"
    ) {
      return [];
    }
    const catalog = catalogSnapshot?.catalog;
    if (!catalog?.active) {
      throw new ConflictException("O catalogo desta regra nao esta ativo");
    }
    const variants = new Map(
      catalog.variants.map((variant) => [variant.id, variant]),
    );

    return review.items.map((item, index) => {
      const variant = item.catalogVariantId
        ? variants.get(item.catalogVariantId)
        : null;
      const values = this.stringArray(item.attributeValues);
      if (
        !variant?.active ||
        !item.unitValueCents ||
        !item.subtotalValueCents ||
        values.length !== catalog.attributes.length ||
        variant.valueCents !== item.unitValueCents ||
        item.subtotalValueCents !== item.unitValueCents * item.quantity
      ) {
        throw new ConflictException(
          "O catalogo mudou. Revise os itens novamente antes de aprovar.",
        );
      }

      return {
        position: index + 1,
        quantity: item.quantity,
        parsedAttributes: catalog.attributes.map((attribute, position) => ({
          key: attribute.key,
          label: attribute.label,
          value: values[position]!,
        })),
        catalogVariantId: variant.id,
        unitValueCents: item.unitValueCents,
        subtotalValueCents: item.subtotalValueCents,
        contentName:
          item.contentName ??
          variant.contentName ??
          `${catalog.productName} | ${values.join(" | ")}`.slice(0, 180),
        reasonCode: "matched",
      };
    });
  }

  private ruleSnapshot(
    review: CanonicalReview,
  ): ProviderConversionDecisionRuleSnapshotDto {
    const rule = review.providerRule;
    const triggerType = rule.conversionRule.triggerType;
    if (
      triggerType !== "structured_catalog" &&
      triggerType !== "message_phrase" &&
      triggerType !== "provider_automation"
    ) {
      throw new ConflictException(
        "O tipo desta regra nao aceita revisao de compra",
      );
    }
    if (
      rule.conversionRule.eventName !== "Purchase" &&
      rule.conversionRule.eventName !== "InitiateCheckout"
    ) {
      throw new ConflictException("A regra revisada nao representa uma compra");
    }

    const messagePhrase =
      triggerType === "message_phrase"
        ? readMessagePhraseConfig(rule.conversionRule.defaultItems)
        : { valueMode: "fixed" as const, exampleMessage: null };
    const base = {
      providerRuleId: rule.id,
      conversionRuleId: rule.conversionRuleId,
      triggerType,
      eventName: rule.conversionRule.eventName as "Purchase",
      mode: rule.mode,
      active: rule.conversionRule.active && rule.removedAt === null,
      authorScope: rule.messageAuthorScope,
      triggerPhrases: [...rule.messageTriggerPhrases],
      defaultValueCents: rule.conversionRule.defaultValueCents,
      defaultCurrency: rule.conversionRule.defaultCurrency,
      defaultContentName: rule.conversionRule.defaultContentName,
      valueMode: messagePhrase.valueMode,
      exampleMessage: messagePhrase.exampleMessage,
    };

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
    review: CanonicalReview,
  ): ProviderConversionDecisionCatalogSnapshotDto | null {
    const catalog = review.providerRule.catalog;
    if (!catalog) return null;

    const dto: ProviderConversionCatalogDto = {
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

    return {
      version: this.snapshotVersion("catalog", dto),
      catalog: dto,
    };
  }

  private requireEligibleReevaluation(
    decision: PersistedProviderConversionDecision,
  ): PersistedProviderConversionDecision {
    if (decision.decisionCode !== "eligible") {
      throw new ConflictException(
        "A reavaliacao existente nao deixou a compra elegivel",
      );
    }
    return decision;
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

  private retryableTechnicalFailure(
    value: Prisma.JsonValue | null,
  ): boolean {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      return false;
    }
    const technicalDelivery = (
      value as Record<string, Prisma.JsonValue>
    ).technicalDelivery;
    if (
      !technicalDelivery ||
      Array.isArray(technicalDelivery) ||
      typeof technicalDelivery !== "object"
    ) {
      return false;
    }

    return (
      technicalDelivery.state === "failed_retryable" &&
      technicalDelivery.retryable === true
    );
  }

  private snapshotVersion(prefix: string, value: unknown): string {
    const digest = createHash("sha256")
      .update(JSON.stringify(value), "utf8")
      .digest("hex");

    return `${prefix}-v1:${digest}`;
  }
}
