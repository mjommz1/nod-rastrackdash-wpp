import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  ProviderConversionCatalogDto,
  StructuredCatalogTestMessageInputDto,
  StructuredCatalogTestMessageResultDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import { matchStructuredCatalogMessage } from "./structured-catalog-message.parser";

const catalogRuleInclude = {
  conversionRule: {
    select: {
      active: true,
      triggerType: true,
    },
  },
  catalog: {
    include: {
      attributes: { orderBy: { position: "asc" } },
      variants: { orderBy: { createdAt: "asc" } },
    },
  },
} satisfies Prisma.ProviderConversionRuleConfigInclude;

type CatalogRule = Prisma.ProviderConversionRuleConfigGetPayload<{
  include: typeof catalogRuleInclude;
}>;

@Injectable()
export class ConversionCatalogService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv = process.env,
  ) {}

  async testMessage(
    workspaceId: string,
    providerRuleId: string,
    input: StructuredCatalogTestMessageInputDto,
  ): Promise<StructuredCatalogTestMessageResultDto> {
    this.requireRulesEnabled();
    return this.matchRuleMessage(
      workspaceId,
      providerRuleId,
      input.messageText,
    );
  }

  async matchRuleMessage(
    workspaceId: string,
    providerRuleId: string,
    messageText: string,
  ): Promise<StructuredCatalogTestMessageResultDto> {
    const rule = await this.prisma.providerConversionRuleConfig.findFirst({
      where: {
        id: providerRuleId,
        workspaceId,
        removedAt: null,
        // Unbound (workspace-scope) rules have no connection to lose.
        OR: [
          { connectionId: null },
          { connection: { is: { removedAt: null } } },
        ],
      },
      include: catalogRuleInclude,
    });

    if (!rule) {
      throw new NotFoundException(
        "Regra de conversao do provedor nao encontrada",
      );
    }
    if (
      rule.conversionRule.triggerType !== "structured_catalog" ||
      !rule.catalog
    ) {
      throw new BadRequestException(
        "O teste de mensagem exige uma regra de catalogo estruturado",
      );
    }

    const catalog = this.toCatalogDto(rule);
    if (!rule.conversionRule.active) {
      return {
        matched: false,
        reasonCode: "rule_inactive",
        classification: "review_required",
        matchedTriggerPhrase: null,
        parsedAttributes: [],
        items: [],
        parsedValueCents: null,
        calculatedValueCents: null,
        observedPaymentValueCents: null,
        catalogVariantId: null,
        contentName: null,
        currency: catalog.currency,
      };
    }

    return matchStructuredCatalogMessage(catalog, messageText, {
      triggerPhrases: rule.messageTriggerPhrases,
    });
  }

  private requireRulesEnabled(): void {
    const config = parseInboundWebhooksConfig(this.env);
    if (!config.conversionRulesEnabled) {
      throw new ServiceUnavailableException(
        "Regras de conversao de provedores estao desativadas",
      );
    }
  }

  private toCatalogDto(rule: CatalogRule): ProviderConversionCatalogDto {
    const catalog = rule.catalog;
    if (!catalog) {
      throw new BadRequestException("Catalogo estruturado nao configurado");
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
        attributeValues: this.toStringArray(variant.attributeValues),
        aliases: this.toNestedStringArray(variant.aliases),
        valueCents: variant.valueCents,
        contentName: variant.contentName,
        active: variant.active,
      })),
    };
  }

  private toStringArray(value: Prisma.JsonValue): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  }

  private toNestedStringArray(value: Prisma.JsonValue | null): string[][] {
    if (!Array.isArray(value)) return [];
    return value.map((items) => this.toStringArray(items));
  }
}
