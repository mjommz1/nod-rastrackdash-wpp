import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  ConversionRuleCreateInputDto,
  ConversionRuleDto,
  ConversionRuleUpdateInputDto,
  ConversionTriggerEvaluationInputDto,
  LegacyConversionRuleDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";

type PersistedConversionRule = {
  id: string;
  workspaceId: string;
  name: string;
  triggerType: ConversionRuleDto["triggerType"];
  triggerValue: string;
  matchMode: "contains" | "exact";
  eventName: string;
  pixelId: string | null;
  defaultValueCents: number | null;
  defaultCurrency: string | null;
  defaultContentName: string | null;
  defaultItems:
    Prisma.JsonValue | typeof Prisma.DbNull | typeof Prisma.JsonNull | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class ConversionRulesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listRules(workspaceId: string): Promise<ConversionRuleDto[]> {
    const rules = await this.prisma.conversionRule.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });

    return rules.map((rule) => this.toDto(rule));
  }

  /**
   * "Regras antigas" for the Conversions screen: keyword / WhatsApp label
   * rules without a provider configuration. Pausing and editing the value
   * keep using PATCH /conversion-rules/:id; "conectar a numeros" uses the
   * existing adapt endpoint, which only accepts keyword Purchase rules with a
   * value (adaptable = true).
   */
  async listLegacyRules(workspaceId: string): Promise<LegacyConversionRuleDto[]> {
    const rules = await this.prisma.conversionRule.findMany({
      where: {
        workspaceId,
        providerConfig: { is: null },
        triggerType: { in: ["keyword", "whatsapp_label"] },
      },
      orderBy: { createdAt: "desc" },
    });

    return rules.map((rule) => {
      const adaptBlockedReason =
        rule.triggerType !== "keyword" || rule.eventName !== "Purchase"
          ? ("not_keyword_purchase" as const)
          : // Moeda nula = herdar a "Moeda das conversões" do workspace.
            !rule.defaultValueCents || rule.defaultValueCents <= 0
            ? ("missing_value" as const)
            : null;
      return {
        ...this.toDto(rule),
        kind: "legacy" as const,
        adaptable: adaptBlockedReason === null,
        adaptBlockedReason,
      };
    });
  }

  async createRule(
    workspaceId: string,
    input: ConversionRuleCreateInputDto,
    actorUserId?: string | null,
  ): Promise<ConversionRuleDto> {
    const rule = await this.prisma.conversionRule.create({
      data: {
        workspaceId,
        name: input.name,
        triggerType: input.triggerType,
        triggerValue: input.triggerValue,
        matchMode: input.matchMode,
        eventName: input.eventName,
        pixelId: input.pixelId ?? null,
        defaultValueCents: input.defaultValueCents ?? null,
        defaultCurrency: input.defaultCurrency ?? null,
        defaultContentName: input.defaultContentName ?? null,
        defaultItems: this.toDefaultItemsInput(input.defaultItems, {
          useDbNullForUndefined: true,
        }),
        active: input.active,
      },
    });
    await this.recordRuleAudit({
      workspaceId,
      actorUserId: actorUserId ?? null,
      action: "conversion_rule.created",
      targetId: rule.id,
      resultStatus: rule.active ? "active" : "inactive",
      afterSummary: this.ruleAuditSummary(rule),
    });

    return this.toDto(rule);
  }

  async updateRule(
    workspaceId: string,
    ruleId: string,
    input: ConversionRuleUpdateInputDto,
    actorUserId?: string | null,
  ): Promise<ConversionRuleDto> {
    // Rules with a provider configuration (Conversoes) keep their own
    // invariants (scope, "Unificar" link, production gates): they are edited
    // only through /conversion-rules/providers/:id.
    const providerBacked = await this.prisma.conversionRule.findFirst({
      where: { id: ruleId, workspaceId, providerConfig: { isNot: null } },
      select: { id: true },
    });
    if (providerBacked) {
      throw new ConflictException(
        "Esta regra e gerenciada em Conversoes; edite-a pela regra do provedor",
      );
    }
    const rule = await this.prisma.conversionRule.update({
      where: {
        id: ruleId,
        workspaceId,
      },
      data: {
        ...input,
        pixelId: input.pixelId === undefined ? undefined : input.pixelId,
        defaultItems: this.toDefaultItemsInput(input.defaultItems),
      },
    });
    await this.recordRuleAudit({
      workspaceId,
      actorUserId: actorUserId ?? null,
      action: "conversion_rule.updated",
      targetId: rule.id,
      resultStatus: rule.active ? "active" : "inactive",
      afterSummary: this.ruleAuditSummary(rule),
    });

    return this.toDto(rule);
  }

  private async recordRuleAudit(input: {
    workspaceId: string;
    actorUserId: string | null;
    action: string;
    targetId: string;
    resultStatus: string;
    afterSummary: Prisma.InputJsonValue;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          actorType: input.actorUserId ? "user" : "system",
          action: input.action,
          targetType: "ConversionRule",
          targetId: input.targetId,
          reason: null,
          sourceIp: null,
          resultStatus: input.resultStatus,
          beforeSummary: undefined,
          afterSummary: input.afterSummary,
        },
      });
    } catch {
      return;
    }
  }

  private ruleAuditSummary(
    rule: PersistedConversionRule,
  ): Prisma.InputJsonValue {
    return {
      name: rule.name,
      triggerType: rule.triggerType,
      matchMode: rule.matchMode,
      eventName: rule.eventName,
      pixelConfigured: Boolean(rule.pixelId),
      valueConfigured: rule.defaultValueCents !== null,
      currency: rule.defaultCurrency,
      active: rule.active,
    } as Prisma.InputJsonValue;
  }

  async evaluateTriggers(
    workspaceId: string,
    input: ConversionTriggerEvaluationInputDto,
  ): Promise<ConversionRuleDto[]> {
    const rules = await this.prisma.conversionRule.findMany({
      where: {
        workspaceId,
        active: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });
    const messageText = (input.messageText ?? "").toLocaleLowerCase("pt-BR");
    const labels = new Set(
      input.labels.map((label) => label.toLocaleLowerCase("pt-BR")),
    );

    return rules
      .filter((rule) => this.matchesRule(rule, messageText, labels))
      .map((rule) => this.toDto(rule));
  }

  private matchesRule(
    rule: PersistedConversionRule,
    messageText: string,
    labels: Set<string>,
  ): boolean {
    const trigger = rule.triggerValue.toLocaleLowerCase("pt-BR");

    if (rule.triggerType === "whatsapp_label") {
      return labels.has(trigger);
    }

    if (rule.triggerType !== "keyword") {
      return false;
    }

    if (rule.matchMode === "exact") {
      return messageText === trigger;
    }

    return messageText.includes(trigger);
  }

  private toDto(rule: PersistedConversionRule): ConversionRuleDto {
    return {
      id: rule.id,
      workspaceId: rule.workspaceId,
      name: rule.name,
      triggerType: rule.triggerType,
      triggerValue: rule.triggerValue,
      matchMode: rule.matchMode,
      eventName: rule.eventName as ConversionRuleDto["eventName"],
      pixelId: rule.pixelId,
      defaultValueCents: rule.defaultValueCents,
      defaultCurrency: rule.defaultCurrency,
      defaultContentName: rule.defaultContentName,
      defaultItems: this.toDefaultItemsDto(rule.defaultItems),
      active: rule.active,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
    };
  }

  private toDefaultItemsInput(
    value:
      | ConversionRuleCreateInputDto["defaultItems"]
      | ConversionRuleUpdateInputDto["defaultItems"],
    options?: { useDbNullForUndefined?: boolean },
  ): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
    if (value === undefined) {
      return options?.useDbNullForUndefined ? Prisma.DbNull : undefined;
    }

    if (value === null) {
      return Prisma.DbNull;
    }

    return value as Prisma.InputJsonValue;
  }

  private toDefaultItemsDto(
    value:
      Prisma.JsonValue | typeof Prisma.DbNull | typeof Prisma.JsonNull | null,
  ): ConversionRuleDto["defaultItems"] {
    if (!Array.isArray(value)) {
      return null;
    }

    return value as ConversionRuleDto["defaultItems"];
  }
}
