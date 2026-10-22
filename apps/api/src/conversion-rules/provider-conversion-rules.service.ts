import { effectiveInboundParserStatus } from "../inbound-webhooks/inbound-webhook-parser-eligibility";
import { createHash, randomBytes } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  conversionEventCarriesValue,
  conversionEventNameSchema,
  messagePhraseConfigKind,
  paytSaleEventNames,
  providerConversionRuleIdempotentCreateInputSchema,
  providerConversionTechnicalDeliveryStateSchema,
  providerRuleCreateRequestKeySchema,
  readMessagePhraseConfig,
} from "@wpptrack/shared";
import type {
  MessagePhraseConfigDto,
  MessagePhraseValueModeDto,
  ProviderConversionCatalogDto,
  ProviderConversionCatalogInputDto,
  ProviderConversionEndpointDto,
  ProviderConversionEndpointSecretResultDto,
  ProviderConversionRuleAdaptInputDto,
  ProviderConversionRuleCreateInputDto,
  ProviderConversionRuleCreateResultDto,
  ProviderConversionRuleExecutionAuditDto,
  ProviderConversionRuleExecutionAuditItemDto,
  ProviderConversionRuleExecutionAuditQueryDto,
  ProviderConversionRuleCapabilitiesDto,
  ProviderConversionRuleDto,
  ProviderConversionRuleIdempotentCreateResultDto,
  ProviderConversionRuleScopeDto,
  ProviderConversionRuleUnifyCandidatesDto,
  ProviderConversionRuleUnifyInputDto,
  ProviderConversionRuleUnifyResultDto,
  ProviderConversionRuleUpdateInputDto,
  ProviderRuleCreateReceiptDto,
  ProviderRuleCreateReceiptLookupResultDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import {
  applyInboundWebhookChannelStatus,
  applyInboundWebhookConnectionStatus,
  type ExternalChannelSeatHook,
  metaRouteRequiredForProvider,
  requireInboundWebhookChannel,
  requireInboundWebhookConnection,
} from "../inbound-webhooks/inbound-webhook-production-activation";
import {
  providerRuleCreateIntentHash,
  providerRuleCreateLockId,
} from "./provider-rule-create-intent";
import {
  listWorkspaceScopeChannels,
  PROVIDER_RULE_GLOBAL_PRECEDENCE,
  providerRuleCapabilities,
  providerRuleChannelProviders,
  scanWorkspaceScopeChannels,
  providerRuleCoversChannel,
  providerRuleOrigin,
  providerRuleOriginRequiresConnection,
  providerRuleOriginUnifiable,
  providerRuleScope,
  samePhoneChannels,
  selectApplicableProviderRules,
  type ProviderRuleOrigin,
  type ScopedChannel,
  type ScopedProviderRule,
} from "./provider-rule-scope";

const ruleNotFoundMessage = "Regra de conversao do provedor nao encontrada";
const connectionNotFoundMessage = "Conexao nao encontrada";
const endpointNotFoundMessage = "Endpoint de automacao nao encontrado";

const providerRuleInclude = {
  conversionRule: true,
  connection: true,
  parserRelease: true,
  channels: {
    orderBy: { createdAt: "asc" },
  },
  endpoint: true,
  catalog: {
    include: {
      attributes: {
        orderBy: { position: "asc" },
      },
      variants: {
        orderBy: { createdAt: "asc" },
      },
    },
  },
  executions: {
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: 1,
  },
} satisfies Prisma.ProviderConversionRuleConfigInclude;

type PersistedProviderRule = Prisma.ProviderConversionRuleConfigGetPayload<{
  include: typeof providerRuleInclude;
}>;

type ScopeInfo = {
  effectiveChannelIds: string[];
  overriddenChannelIds: string[];
  overriddenBy: Array<{ channelId: string; providerRuleIds: string[] }>;
  duplicatePhoneChannelIds: string[];
  observationCanonicalChannels: Array<{ canonicalChannelId: string; productionChannelIds: string[] }>;
};

@Injectable()
export class ProviderConversionRulesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv = process.env,
  ) {}

  async listRules(workspaceId: string): Promise<ProviderConversionRuleDto[]> {
    this.requireRulesEnabled();
    const rules = await this.prisma.providerConversionRuleConfig.findMany({
      where: {
        workspaceId,
        removedAt: null,
      },
      include: providerRuleInclude,
      orderBy: { createdAt: "desc" },
    });

    return this.toDtos(this.prisma, workspaceId, rules, rules);
  }

  async listRuleExecutions(
    workspaceId: string,
    providerRuleId: string,
    query: ProviderConversionRuleExecutionAuditQueryDto,
  ): Promise<ProviderConversionRuleExecutionAuditDto> {
    this.requireRulesEnabled();
    const rule = await this.requireRule(
      this.prisma,
      workspaceId,
      providerRuleId,
    );
    const where: Prisma.ProviderConversionRuleExecutionWhereInput = {
      workspaceId,
      providerRuleId,
      ...(query.status ? { status: query.status } : {}),
    };

    const [executions, totalItems, statusCounts] = await Promise.all([
      this.prisma.providerConversionRuleExecution.findMany({
        where,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          channel: true,
          purchaseReview: { select: { id: true } },
        },
      }),
      this.prisma.providerConversionRuleExecution.count({ where }),
      this.prisma.providerConversionRuleExecution.groupBy({
        by: ["status"],
        where: { workspaceId, providerRuleId },
        _count: { _all: true },
      }),
    ]);
    const leadIds = [
      ...new Set(
        executions
          .map((execution) => execution.leadId)
          .filter((leadId): leadId is string => Boolean(leadId)),
      ),
    ];
    const leads = leadIds.length
      ? await this.prisma.lead.findMany({
          where: { workspaceId, id: { in: leadIds } },
          select: { id: true, name: true, phoneDisplay: true },
        })
      : [];
    const leadsById = new Map(leads.map((lead) => [lead.id, lead]));
    const summary = {
      total: 0,
      observed: 0,
      eligible: 0,
      materialized: 0,
      duplicate: 0,
      blocked: 0,
      failed: 0,
    };
    for (const statusCount of statusCounts) {
      summary[statusCount.status] = statusCount._count._all;
      summary.total += statusCount._count._all;
    }

    return {
      providerRuleId,
      eventName: conversionEventNameSchema.parse(rule.conversionRule.eventName),
      summary,
      items: executions.map((execution) => {
        const lead = execution.leadId
          ? (leadsById.get(execution.leadId) ?? null)
          : null;
        const normalized = execution.normalizedResult;
        const matchedTriggerPhrase =
          typeof normalized === "object" &&
          normalized !== null &&
          "matchedTriggerPhrase" in normalized
            ? String(normalized.matchedTriggerPhrase || "") || null
            : null;

        return {
          executionId: execution.id,
          sourceDeliveryId: execution.sourceDeliveryId,
          occurredAt: execution.occurredAt.toISOString(),
          status: execution.status,
          reasonCode: execution.reasonCode,
          matchedTriggerPhrase,
          channel: execution.channel
            ? {
                id: execution.channel.id,
                name: execution.channel.channelName,
                connectedPhone: execution.channel.connectedPhone,
              }
            : null,
          leadId: execution.leadId,
          leadName: lead?.name ?? null,
          phoneDisplay: lead?.phoneDisplay ?? null,
          valueCents: execution.valueCents,
          currency: execution.currency,
          conversionEventLogId: execution.conversionEventLogId,
          purchaseReviewId: execution.purchaseReview?.id ?? null,
          attemptCount: execution.attemptCount,
          processedAt: execution.processedAt?.toISOString() ?? null,
          technicalDelivery: this.auditTechnicalDelivery(normalized),
          lastProductionFailure: this.auditProductionFailure(normalized),
        };
      }),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / query.pageSize)),
      },
    };
  }

  private auditJsonObject(
    value: Prisma.JsonValue | null | undefined,
  ): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private auditIsoDate(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  private auditReasonCode(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0
      ? value.trim().slice(0, 160)
      : null;
  }

  private auditTechnicalDelivery(
    normalizedResult: Prisma.JsonValue | null,
  ): ProviderConversionRuleExecutionAuditItemDto["technicalDelivery"] {
    const technical = this.auditJsonObject(
      this.auditJsonObject(normalizedResult)?.technicalDelivery as
        | Prisma.JsonValue
        | undefined,
    );
    const state = providerConversionTechnicalDeliveryStateSchema.safeParse(
      technical?.state,
    );
    if (!state.success) {
      return null;
    }

    return {
      state: state.data,
      retryable: technical?.retryable === true,
      reasonCode: this.auditReasonCode(technical?.reasonCode),
      updatedAt: this.auditIsoDate(technical?.updatedAt),
    };
  }

  private auditProductionFailure(
    normalizedResult: Prisma.JsonValue | null,
  ): ProviderConversionRuleExecutionAuditItemDto["lastProductionFailure"] {
    const failure = this.auditJsonObject(
      this.auditJsonObject(normalizedResult)?.lastProductionFailure as
        | Prisma.JsonValue
        | undefined,
    );
    const code = this.auditReasonCode(failure?.code);

    return code
      ? { code, failedAt: this.auditIsoDate(failure?.failedAt) }
      : null;
  }

  createRule(
    workspaceId: string,
    input: ProviderConversionRuleCreateInputDto,
    actorUserId: string,
  ): Promise<ProviderConversionRuleCreateResultDto>;
  createRule(
    workspaceId: string,
    input: ProviderConversionRuleCreateInputDto,
    actorUserId: string,
    requestKey: string,
  ): Promise<ProviderConversionRuleIdempotentCreateResultDto>;
  async createRule(
    workspaceId: string,
    input: ProviderConversionRuleCreateInputDto,
    actorUserId: string,
    requestKey?: string,
  ): Promise<
    | ProviderConversionRuleCreateResultDto
    | ProviderConversionRuleIdempotentCreateResultDto
  > {
    const config = this.requireRulesEnabled();
    if (requestKey !== undefined) {
      this.requireCreateRequestKey(requestKey);
      const parsed =
        providerConversionRuleIdempotentCreateInputSchema.safeParse(input);
      if (!parsed.success) throw new BadRequestException("Payload invalido");
      input = parsed.data;
    }
    const requestHash =
      requestKey === undefined
        ? null
        : providerRuleCreateIntentHash(workspaceId, input);
    this.assertUniqueCatalogVariants(input);
    let secret: string | null = null;
    // Fase 5.3: a rule created for the workspace URL (perRuleUrl: false) keeps
    // its endpoint only as the internal anchor of the routed callbacks.
    let perRuleUrlDisabled = false;

    const result = await this.prisma
      .$transaction(
        async (transaction) => {
          if (requestKey !== undefined) {
            // READ COMMITTED: the read AFTER this transaction-scoped lock sees
            // the previous winner's committed claim, even across API instances.
            const lockId = providerRuleCreateLockId(workspaceId, requestKey);
            await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${lockId}::bigint)::text`;
          }
          // Message/catalog/label rules may span connections and then carry no
          // connection; the Umbler automation always names its connection.
          const connection = input.connectionId
            ? await transaction.inboundWebhookConnection.findFirst({
                where: {
                  id: input.connectionId,
                  workspaceId,
                  removedAt: null,
                },
                include: { parserRelease: true },
              })
            : null;

          if (input.connectionId && !connection) {
            throw new NotFoundException(connectionNotFoundMessage);
          }

          if (requestKey !== undefined) {
            const claim = await transaction.providerRuleCreateClaim.findUnique({
              where: { workspaceId_requestKey: { workspaceId, requestKey } },
            });
            if (claim) {
              if (
                claim.requestHash !== requestHash ||
                (claim.connectionId !== null &&
                  claim.connectionId !== (input.connectionId ?? null))
              ) {
                throw this.createReceiptConflict(
                  "provider_rule_create_key_conflict",
                  "Chave de tentativa ja usada com outra solicitacao",
                );
              }
              return {
                outcome: "replayed" as const,
                receipt: await this.safeCreateReceipt(transaction, claim),
              };
            }
          }

          // Fase 4a: a Payt rule sits on a WhatsApp connection (the one of its
          // numbers) only as the anchor of its signed URL; the parser release
          // stored with the rule identifies the Payt contract.
          const isPaytAutomation =
            input.triggerType === "provider_automation" &&
            input.automationSource === "payt";
          if (
            isPaytAutomation &&
            !(paytSaleEventNames as readonly string[]).includes(
              input.eventName,
            )
          ) {
            // The HTTP schema enforces this too. Keep the invariant at the
            // service boundary for internal callers and future entry points.
            throw new BadRequestException(
              "A Payt envia compra aprovada, Pix/boleto gerado ou carrinho abandonado",
            );
          }

          const productFilterCodes =
            input.triggerType === "provider_automation"
              ? (input.productFilterCodes ?? [])
              : [];
          if (productFilterCodes.length > 0 && !isPaytAutomation) {
            throw new BadRequestException(
              "Filtro de produto só existe para plataformas de venda",
            );
          }
          perRuleUrlDisabled =
            input.triggerType === "provider_automation" &&
            input.perRuleUrl === false;

          if (
            input.triggerType === "provider_automation" &&
            !isPaytAutomation &&
            connection &&
            !["umbler", "uazapi", "unnichat"].includes(connection.provider)
          ) {
            throw new BadRequestException(
              "Automacao por tag ainda so esta disponivel para este provedor",
            );
          }
          if (isPaytAutomation && connection?.provider === "payt") {
            // A Payt connection has no WhatsApp number to activate: the rule
            // is bound to the connection of its numbers (as in the SaaS).
            throw new BadRequestException(
              "Escolha a conexão de WhatsApp dos números desta regra",
            );
          }

          const scope: ProviderConversionRuleScopeDto =
            input.scope ?? "specific_numbers";
          const origin = this.createOrigin(input, connection, isPaytAutomation);
          if (!connection && providerRuleOriginRequiresConnection(origin)) {
            throw new BadRequestException(
              "Informe a conexao que recebe o webhook desta automacao",
            );
          }
          // Bound (historical shape) when the origin needs its connection, or
          // when every chosen number is on the informed connection. A rule
          // for all numbers, or for numbers of several connections, is
          // unbound: parser and production gates come from each occurrence.
          const bound =
            connection !== null &&
            (providerRuleOriginRequiresConnection(origin) ||
              (scope === "specific_numbers" &&
                (await this.channelsOnConnection(
                  transaction,
                  workspaceId,
                  connection.id,
                  input.channelIds,
                ))));

          // Endpoint automations (signed URL of the rule): Umbler, Payt and,
          // since Fase 4b, Unnichat.
          const endpointAutomationProvider =
            input.triggerType !== "provider_automation"
              ? null
              : isPaytAutomation
                ? "payt"
                : connection?.provider === "umbler" ||
                    connection?.provider === "unnichat"
                  ? connection.provider
                  : null;
          if (endpointAutomationProvider) {
            secret = this.generateSecret();
          }

          if (bound && connection) {
            await this.assertChannelsForProvider(
              transaction,
              workspaceId,
              connection.id,
              isPaytAutomation ? "payt" : connection.provider,
              input.channelIds,
            );
          } else {
            await this.assertChannelsForOrigin(
              transaction,
              workspaceId,
              {
                origin,
                messageAuthorScope:
                  input.triggerType === "provider_automation"
                    ? null
                    : input.messageAuthorScope,
              },
              input.channelIds,
            );
          }

          const parserRelease = !bound
            ? null
            : endpointAutomationProvider
              ? await transaction.inboundWebhookParserRelease.findFirst({
                  where: {
                    provider: endpointAutomationProvider,
                    version: "automation-v1",
                    status: { not: "retired" },
                  },
                })
              : (connection?.parserRelease ?? null);

          if (bound && !parserRelease) {
            throw new ConflictException(
              "Parser da conexao ainda nao esta disponivel",
            );
          }

          const automationTriggerPhrases =
            input.triggerType === "provider_automation" &&
            origin === "whatsapp_label"
              ? (
                  input.triggerLabels?.map((label) => label.name) ??
                  input.triggerPhrases ??
                  []
                )
                  .map((phrase) => phrase.trim())
                  .filter(Boolean)
              : [];
          if (
            input.triggerType === "provider_automation" &&
            origin === "whatsapp_label" &&
            automationTriggerPhrases.length === 0
          ) {
            throw new BadRequestException(
              "Informe ao menos uma etiqueta para automacao por tag UAZAPI",
            );
          }

          this.assertModeAllowed(
            input.mode,
            parserRelease ? effectiveInboundParserStatus(parserRelease) : null,
          );
          let defaultValueCents: number | null = null;
          let defaultCurrency: string | null = null;
          let defaultContentName: string | null = null;
          let defaultItems: Prisma.InputJsonValue | typeof Prisma.DbNull =
            Prisma.DbNull;

          // Eventos sem valor chegam do schema sem nenhum campo monetario, entao
          // ler os tres campos direto e o suficiente para nao gravar valor
          // fantasma em QualifiedLead, OrderShipped e afins.
          if (input.triggerType === "message_phrase") {
            defaultValueCents = input.defaultValueCents ?? null;
            defaultCurrency = input.defaultCurrency ?? null;
            defaultContentName = input.defaultContentName ?? null;
            defaultItems = this.messagePhraseConfig({
              valueMode: input.valueMode,
              exampleMessage: input.exampleMessage ?? null,
            });
          } else if (input.triggerType === "provider_automation") {
            defaultValueCents = input.defaultValueCents ?? null;
            defaultCurrency = input.defaultCurrency ?? null;
            defaultContentName = input.defaultContentName ?? null;
            if (origin === "whatsapp_label") {
              defaultItems = this.uazapiLabelsConfig(input.triggerLabels ?? [], {
                // Label ids only identify a label inside one instance.
                nameOnly: !bound,
              });
            }
          } else if (input.triggerType === "structured_catalog") {
            defaultCurrency = input.catalog.currency;
            defaultContentName = input.catalog.productName;
          }

          const conversionRule = await transaction.conversionRule.create({
            data: {
              workspaceId,
              name: input.name,
              triggerType: input.triggerType,
              triggerValue:
                input.triggerType === "provider_automation"
                  ? (automationTriggerPhrases[0] ?? input.triggerType)
                  : input.triggerPhrases[0],
              matchMode: "exact",
              eventName: input.eventName,
              pixelId: null,
              defaultValueCents,
              defaultCurrency,
              defaultContentName,
              defaultItems,
              active: true,
            },
          });

          const providerRule =
            await transaction.providerConversionRuleConfig.create({
              data: {
                workspaceId,
                conversionRuleId: conversionRule.id,
                connectionId: bound ? connection!.id : null,
                parserReleaseId: bound ? parserRelease!.id : null,
                scope,
                mode: input.mode,
                messageTriggerPhrases:
                  input.triggerType === "provider_automation"
                    ? automationTriggerPhrases
                    : input.triggerPhrases,
                messageAuthorScope:
                  input.triggerType === "provider_automation"
                    ? null
                    : input.messageAuthorScope,
                productFilterCodes,
                productionActivatedAt:
                  input.mode === "production" ? new Date() : null,
                createdByUserId: actorUserId,
              },
            });

          if (input.channelIds.length > 0) {
            await transaction.providerConversionRuleChannel.createMany({
              data: input.channelIds.map((channelId) => ({
                workspaceId,
                providerRuleId: providerRule.id,
                channelId,
              })),
            });
          }

          if (secret) {
            await transaction.providerConversionRuleEndpoint.create({
              data: {
                workspaceId,
                providerRuleId: providerRule.id,
                secretHash: this.hashSecret(secret),
                ...(perRuleUrlDisabled
                  ? { publicUrlDisabledAt: new Date() }
                  : {}),
              },
            });
          }

          if (input.triggerType === "structured_catalog") {
            await this.createCatalog(
              transaction,
              workspaceId,
              providerRule.id,
              input.catalog,
            );
          }

          if (input.mode === "production") {
            await this.activateScopedProduction(transaction, {
              workspaceId,
              boundConnectionId: bound ? connection!.id : null,
              scope,
              channelIds: input.channelIds,
              actorUserId,
            });
          }

          await this.createAudit(transaction, {
            workspaceId,
            actorUserId,
            action: "provider_conversion_rule.created",
            targetId: providerRule.id,
            resultStatus: input.mode,
            afterSummary: {
              eventName: input.eventName,
              triggerType: input.triggerType,
              connectionId: bound ? connection!.id : null,
              scope,
              origin,
              channelCount: input.channelIds.length,
              mode: input.mode,
              endpointCreated: Boolean(secret),
              ...(productFilterCodes.length > 0
                ? { productFilterCodes }
                : {}),
              ...(perRuleUrlDisabled ? { perRuleUrl: false } : {}),
            },
          });

          const created = await this.requireRule(
            transaction,
            workspaceId,
            providerRule.id,
          );
          const claim =
            requestKey === undefined
              ? null
              : await transaction.providerRuleCreateClaim.create({
                  data: {
                    workspaceId,
                    requestKey,
                    requestHash: requestHash!,
                    connectionId: bound ? connection!.id : null,
                    providerRuleId: providerRule.id,
                    endpointRequired: Boolean(secret),
                  },
                });
          return { outcome: "created" as const, created, claim };
        },
        requestKey === undefined
          ? undefined
          : { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      )
      .catch((error: unknown) => {
        if (requestKey === undefined || error instanceof HttpException)
          throw error;
        // No database details or request values in the public error. Commit
        // uncertainty is reconciled by the SAME key/body, never a fresh key.
        throw new ServiceUnavailableException({
          statusCode: 503,
          error: "Service Unavailable",
          code: "provider_rule_create_unknown",
          message:
            "Resultado da criacao desconhecido; reconcilie a mesma tentativa",
        });
      });

    if (result.outcome === "replayed") return result;
    const created = result.created;
    const response = {
      rule: await this.toScopedDto(workspaceId, created),
      webhookUrl:
        secret && created.endpoint && !perRuleUrlDisabled
          ? this.buildWebhookUrl(
              config.apiPublicUrl,
              created.endpoint.id,
              secret,
            )
          : null,
    };
    return result.claim
      ? {
          outcome: "created",
          receipt: this.createReceiptDto(result.claim),
          ...response,
        }
      : response;
  }

  private requireCreateRequestKey(
    requestKey: unknown,
  ): asserts requestKey is string {
    if (!providerRuleCreateRequestKeySchema.safeParse(requestKey).success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        code: "provider_rule_create_key_invalid",
        message: "Chave de tentativa invalida",
      });
    }
  }

  private createReceiptConflict(
    code:
      | "provider_rule_create_key_conflict"
      | "provider_rule_create_resource_gone",
    message: string,
  ): ConflictException {
    return new ConflictException({
      statusCode: 409,
      error: "Conflict",
      code,
      message,
    });
  }

  private createReceiptDto(claim: {
    providerRuleId: string;
    connectionId: string | null;
    createdAt: Date;
  }): ProviderRuleCreateReceiptDto {
    return {
      ruleId: claim.providerRuleId,
      connectionId: claim.connectionId,
      createdAt: claim.createdAt.toISOString(),
    };
  }

  private async safeCreateReceipt(
    client: Pick<Prisma.TransactionClient, "providerConversionRuleConfig">,
    claim: {
      workspaceId: string;
      providerRuleId: string;
      connectionId: string | null;
      createdAt: Date;
      endpointRequired: boolean;
    },
  ): Promise<ProviderRuleCreateReceiptDto> {
    // Never use the full rule include here: even hashes of old secrets are
    // unnecessary for reconciliation. Removed/missing resources are
    // tombstones. The rule may have been unbound later (scope change), so the
    // claim is matched by rule id only.
    const rule = await client.providerConversionRuleConfig.findFirst({
      where: { id: claim.providerRuleId, workspaceId: claim.workspaceId },
      select: {
        id: true,
        removedAt: true,
        endpoint: { select: { removedAt: true } },
      },
    });
    if (
      !rule ||
      rule.removedAt ||
      (claim.endpointRequired && (!rule.endpoint || rule.endpoint.removedAt))
    ) {
      throw this.createReceiptConflict(
        "provider_rule_create_resource_gone",
        "Recurso da tentativa removido; a chave permanece reservada",
      );
    }
    return this.createReceiptDto(claim);
  }

  /**
   * Reconciles an unconfirmed create (timeout, 5xx) by its Idempotency-Key.
   * connectionId null: the UI created the rule without a connection. A claim
   * of a rule without connection binding is found whatever connection the
   * caller informs (the key itself is the identity).
   */
  async lookupCreateReceipt(
    workspaceId: string,
    connectionId: string | null,
    requestKey: string,
  ): Promise<ProviderRuleCreateReceiptLookupResultDto> {
    this.requireRulesEnabled();
    this.requireCreateRequestKey(requestKey);
    try {
      if (connectionId !== null) {
        const connection = await this.prisma.inboundWebhookConnection.findFirst(
          {
            where: { id: connectionId, workspaceId, removedAt: null },
            select: { id: true },
          },
        );
        if (!connection) throw new NotFoundException(connectionNotFoundMessage);
      }
      const claim = await this.prisma.providerRuleCreateClaim.findUnique({
        where: { workspaceId_requestKey: { workspaceId, requestKey } },
      });
      // Absent means no visible COMMITTED claim. It does not rule out a
      // concurrent transaction waiting to commit.
      if (
        !claim ||
        (claim.connectionId !== null && claim.connectionId !== connectionId)
      ) {
        return {
          outcome: "absent",
          code: "provider_rule_create_receipt_absent",
        };
      }
      return {
        outcome: "found",
        receipt: await this.safeCreateReceipt(this.prisma, claim),
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: "Service Unavailable",
        code: "provider_rule_create_receipt_unknown",
        message: "Nao foi possivel confirmar a tentativa",
      });
    }
  }

  async adaptLegacyMessageRule(
    workspaceId: string,
    legacyRuleId: string,
    input: ProviderConversionRuleAdaptInputDto,
    actorUserId: string,
  ): Promise<ProviderConversionRuleDto> {
    this.requireRulesEnabled();

    const adapted = await this.prisma.$transaction(async (transaction) => {
      const legacyRule = await transaction.conversionRule.findFirst({
        where: {
          id: legacyRuleId,
          workspaceId,
        },
        include: {
          providerConfig: true,
        },
      });

      if (!legacyRule) {
        throw new NotFoundException("Regra de conversao nao encontrada");
      }
      if (legacyRule.providerConfig) {
        throw new ConflictException(
          "Esta regra ja esta vinculada a um provedor",
        );
      }
      if (
        legacyRule.triggerType !== "keyword" ||
        legacyRule.eventName !== "Purchase"
      ) {
        throw new ConflictException(
          "Somente regras antigas de compra por palavra-chave podem ser adaptadas",
        );
      }
      // Moeda é opcional: nula = herdar a "Moeda das conversões" do workspace.
      if (!legacyRule.defaultValueCents || legacyRule.defaultValueCents <= 0) {
        throw new ConflictException(
          "Configure produto e valor antes de adaptar esta regra",
        );
      }

      const connection = await transaction.inboundWebhookConnection.findFirst({
        where: {
          id: input.connectionId,
          workspaceId,
          removedAt: null,
        },
        include: { parserRelease: true },
      });

      if (!connection) {
        throw new NotFoundException(connectionNotFoundMessage);
      }

      await this.assertChannelsBelongToConnection(
        transaction,
        workspaceId,
        connection.id,
        input.channelIds,
      );

      if (!connection.parserRelease) {
        throw new ConflictException(
          "Parser da conexao ainda nao esta disponivel",
        );
      }
      this.assertModeAllowed("observation", connection.parserRelease.status);

      await transaction.conversionRule.update({
        where: { id: legacyRule.id },
        data: {
          triggerType: "message_phrase",
          triggerValue: input.triggerPhrases[0],
          matchMode: "contains",
          active: true,
        },
      });

      const providerRule =
        await transaction.providerConversionRuleConfig.create({
          data: {
            workspaceId,
            conversionRuleId: legacyRule.id,
            connectionId: connection.id,
            parserReleaseId: connection.parserRelease.id,
            mode: "observation",
            messageTriggerPhrases: input.triggerPhrases,
            messageAuthorScope: input.messageAuthorScope,
            productionActivatedAt: null,
            createdByUserId: actorUserId,
          },
        });

      await transaction.providerConversionRuleChannel.createMany({
        data: input.channelIds.map((channelId) => ({
          workspaceId,
          providerRuleId: providerRule.id,
          channelId,
        })),
      });

      await this.createAudit(transaction, {
        workspaceId,
        actorUserId,
        action: "provider_conversion_rule.adapted",
        targetId: providerRule.id,
        resultStatus: "observation",
        afterSummary: {
          conversionRuleId: legacyRule.id,
          previousTriggerType: legacyRule.triggerType,
          previousMatchMode: legacyRule.matchMode,
          eventName: legacyRule.eventName,
          connectionId: connection.id,
          channelCount: input.channelIds.length,
          mode: "observation",
        },
      });

      return this.requireRule(transaction, workspaceId, providerRule.id);
    });

    return this.toDto(adapted);
  }

  async updateRule(
    workspaceId: string,
    providerRuleId: string,
    input: ProviderConversionRuleUpdateInputDto,
    actorUserId: string,
  ): Promise<ProviderConversionRuleDto> {
    this.requireRulesEnabled();
    if (input.catalog) {
      this.assertUniqueCatalogVariants({
        triggerType: "structured_catalog",
        catalog: input.catalog,
      });
    }

    const updated = await this.prisma.$transaction(async (transaction) => {
      const current = await this.requireRule(
        transaction,
        workspaceId,
        providerRuleId,
      );

      this.assertUpdateMatchesRule(current, input);

      const origin = providerRuleOrigin(current);
      if (!origin) {
        throw new ConflictException("Origem da regra nao suportada");
      }
      const currentScope = providerRuleScope(current);
      const nextScope = input.scope ?? currentScope;
      const scopeChanged = nextScope !== currentScope;
      if (
        nextScope === "specific_numbers" &&
        scopeChanged &&
        !input.channelIds
      ) {
        throw new BadRequestException("Selecione ao menos um numero");
      }
      if (nextScope === "all_numbers" && input.channelIds) {
        // Never silently drop the chosen numbers of a global rule.
        throw new BadRequestException(
          'Regra para todos os numeros nao recebe canais; envie scope "specific_numbers" para escolher numeros',
        );
      }
      // undefined = keep the chosen channels; [] = "all numbers" (no rows).
      const nextChannelIds: string[] | undefined =
        nextScope === "all_numbers"
          ? scopeChanged
            ? []
            : undefined
          : input.channelIds;
      // A bound message/catalog/label rule stays bound only while every
      // chosen number is on its connection; going global or spanning
      // connections unbinds it. The Umbler automation never unbinds.
      const unbind =
        current.connectionId !== null &&
        !providerRuleOriginRequiresConnection(origin) &&
        (nextScope === "all_numbers" ||
          (nextChannelIds !== undefined &&
            !(await this.channelsOnConnection(
              transaction,
              workspaceId,
              current.connectionId,
              nextChannelIds,
            ))));
      const nextConnectionId = unbind ? null : current.connectionId;

      if (nextChannelIds && nextChannelIds.length > 0) {
        if (nextConnectionId !== null) {
          await this.assertChannelsForProvider(
            transaction,
            workspaceId,
            nextConnectionId,
            this.isPaytAutomationRule(current)
              ? "payt"
              : (current.connection?.provider ?? ""),
            nextChannelIds,
          );
        } else {
          await this.assertChannelsForOrigin(
            transaction,
            workspaceId,
            {
              origin,
              messageAuthorScope:
                input.messageAuthorScope ?? current.messageAuthorScope,
            },
            nextChannelIds,
          );
        }
      }

      const nextMode = input.active === false ? "observation" : input.mode;
      if (nextMode === "production") {
        this.assertModeAllowed(
          "production",
          unbind || !current.parserRelease
            ? null
            : effectiveInboundParserStatus(current.parserRelease),
        );
      }

      const conversionRuleData: Prisma.ConversionRuleUpdateInput = {};
      if (input.name !== undefined) conversionRuleData.name = input.name;
      if (input.active !== undefined) conversionRuleData.active = input.active;
      if (input.defaultValueCents !== undefined) {
        conversionRuleData.defaultValueCents = input.defaultValueCents;
      }
      if (input.defaultCurrency !== undefined) {
        conversionRuleData.defaultCurrency = input.defaultCurrency;
      }
      if (input.defaultContentName !== undefined) {
        conversionRuleData.defaultContentName = input.defaultContentName;
      }
      if (input.triggerPhrases !== undefined) {
        conversionRuleData.triggerValue = input.triggerPhrases[0];
      }
      if (input.triggerLabels !== undefined) {
        conversionRuleData.triggerValue = input.triggerLabels[0]?.name;
        conversionRuleData.defaultItems = this.uazapiLabelsConfig(
          input.triggerLabels,
          { nameOnly: nextConnectionId === null },
        );
      } else if (unbind && origin === "whatsapp_label") {
        // Instance-local label ids stop meaning anything across numbers.
        conversionRuleData.defaultItems = this.uazapiLabelsConfig(
          this.storedLabelNames(current.conversionRule.defaultItems),
          { nameOnly: true },
        );
      }
      if (input.valueMode !== undefined || input.exampleMessage !== undefined) {
        const messagePhrase = readMessagePhraseConfig(
          current.conversionRule.defaultItems,
        );
        conversionRuleData.defaultItems = this.messagePhraseConfig({
          valueMode: input.valueMode ?? messagePhrase.valueMode,
          exampleMessage:
            input.exampleMessage !== undefined
              ? input.exampleMessage
              : messagePhrase.exampleMessage,
        });
      }

      if (Object.keys(conversionRuleData).length > 0) {
        await transaction.conversionRule.update({
          where: { id: current.conversionRuleId },
          data: conversionRuleData,
        });
      }

      if (
        input.mode !== undefined ||
        input.active === false ||
        input.triggerPhrases !== undefined ||
        input.triggerLabels !== undefined ||
        input.messageAuthorScope !== undefined ||
        input.productFilterCodes !== undefined
      ) {
        const mode = nextMode ?? current.mode;
        await transaction.providerConversionRuleConfig.update({
          where: { id: current.id },
          data: {
            mode,
            ...(input.productFilterCodes !== undefined
              ? { productFilterCodes: input.productFilterCodes }
              : {}),
            ...(input.triggerPhrases !== undefined
              ? { messageTriggerPhrases: input.triggerPhrases }
              : {}),
            ...(input.triggerLabels !== undefined
              ? {
                  messageTriggerPhrases: input.triggerLabels.map(
                    (label) => label.name,
                  ),
                }
              : {}),
            ...(input.messageAuthorScope !== undefined
              ? { messageAuthorScope: input.messageAuthorScope }
              : {}),
            productionActivatedAt:
              mode === "production"
                ? (current.productionActivatedAt ?? new Date())
                : null,
          },
        });
      }

      // Fase 5.3, "Desativar URL antiga" (confirmed by the HTTP contract):
      // closes or reopens only the rule's own public URL. The rule keeps
      // receiving through the workspace URL; the endpoint row stays as the
      // internal anchor. Reversible; an unchanged state is a no-op.
      let publicUrlChange: "disabled" | "enabled" | null = null;
      if (input.publicUrlDisabled !== undefined) {
        if (!current.endpoint || current.endpoint.removedAt) {
          throw new NotFoundException(endpointNotFoundMessage);
        }
        const isDisabled = current.endpoint.publicUrlDisabledAt != null;
        if (input.publicUrlDisabled && !isDisabled) {
          // Never close the only way in: the workspace URL of this platform
          // (and event, for Unnichat/Umbler) must exist first.
          const provider = current.parserRelease?.provider;
          const workspaceUrl =
            provider && ["payt", "unnichat", "umbler"].includes(provider)
              ? await transaction.integrationEndpoint.findFirst({
                  where: {
                    workspaceId,
                    provider,
                    removedAt: null,
                    eventName:
                      provider === "payt"
                        ? null
                        : current.conversionRule.eventName,
                  },
                  select: { id: true },
                })
              : null;
          if (!workspaceUrl) {
            throw new ConflictException(
              "Gere antes a URL única desta plataforma (ou a URL deste evento) e cole na plataforma; sem ela, desativar a URL antiga faria a regra parar de receber",
            );
          }
        }
        if (input.publicUrlDisabled !== isDisabled) {
          await transaction.providerConversionRuleEndpoint.update({
            where: { id: current.endpoint.id },
            data: {
              publicUrlDisabledAt: input.publicUrlDisabled ? new Date() : null,
            },
          });
          publicUrlChange = input.publicUrlDisabled ? "disabled" : "enabled";
        }
      }

      // Reactivating a rule that "Unificar" paused makes it a specific rule
      // again (it then overrides the global rule on its numbers).
      const reactivatesUnified =
        input.active === true && current.unifiedIntoProviderRuleId !== null;
      if (scopeChanged || unbind || reactivatesUnified) {
        await transaction.providerConversionRuleConfig.update({
          where: { id: current.id },
          data: {
            scope: nextScope,
            ...(unbind ? { connectionId: null, parserReleaseId: null } : {}),
            ...(reactivatesUnified ? { unifiedIntoProviderRuleId: null } : {}),
          },
        });
      }

      if (nextChannelIds !== undefined) {
        await transaction.providerConversionRuleChannel.deleteMany({
          where: { workspaceId, providerRuleId },
        });
        if (nextChannelIds.length > 0) {
          await transaction.providerConversionRuleChannel.createMany({
            data: nextChannelIds.map((channelId) => ({
              workspaceId,
              providerRuleId,
              channelId,
            })),
          });
        }
      }

      if (input.catalog) {
        const currentCatalog = current.catalog;
        const aliasUpdates = currentCatalog
          ? this.catalogAliasUpdates(currentCatalog, input.catalog)
          : null;

        if (aliasUpdates && currentCatalog) {
          for (const update of aliasUpdates) {
            const result =
              await transaction.conversionCatalogVariant.updateMany({
                where: {
                  id: update.id,
                  workspaceId,
                  catalogId: currentCatalog.id,
                },
                data: {
                  aliases: update.aliases as Prisma.InputJsonValue,
                },
              });
            if (result.count !== 1) {
              throw new ConflictException(
                "Uma variante do catalogo mudou durante a atualizacao",
              );
            }
          }
        } else {
          const executions =
            await transaction.providerConversionRuleExecution.count({
              where: { workspaceId, providerRuleId },
            });
          if (executions > 0) {
            throw new ConflictException(
              "O catalogo com historico aceita apenas alteracoes de aliases",
            );
          }
          await this.replaceCatalog(
            transaction,
            workspaceId,
            providerRuleId,
            input.catalog,
          );
        }
      }

      // A rename must not touch the inbound connection, but every edit that
      // turns "Envio ativo" on, re-enables the rule, or re-scopes its channels
      // has to promote the connection and those channels with it.
      const effectiveMode = nextMode ?? current.mode;
      const staysActive = input.active ?? current.conversionRule.active;
      if (
        effectiveMode === "production" &&
        staysActive &&
        (input.mode !== undefined ||
          input.active === true ||
          input.channelIds !== undefined ||
          scopeChanged)
      ) {
        await this.activateScopedProduction(transaction, {
          workspaceId,
          boundConnectionId: nextConnectionId,
          scope: nextScope,
          channelIds:
            nextChannelIds ??
            current.channels.map((channel) => channel.channelId),
          actorUserId,
        });
      }

      const result = await this.requireRule(
        transaction,
        workspaceId,
        providerRuleId,
      );
      await this.createAudit(transaction, {
        workspaceId,
        actorUserId,
        action:
          input.active === false
            ? "provider_conversion_rule.paused"
            : input.mode === "production"
              ? "provider_conversion_rule.activated"
              : "provider_conversion_rule.updated",
        targetId: result.id,
        resultStatus: result.conversionRule.active ? result.mode : "paused",
        afterSummary: this.auditSummary(result),
      });
      if (publicUrlChange && result.endpoint) {
        await this.createAudit(transaction, {
          workspaceId,
          actorUserId,
          action: `provider_conversion_rule.public_url_${publicUrlChange}`,
          targetId: result.id,
          resultStatus: publicUrlChange,
          afterSummary: { endpointId: result.endpoint.id },
        });
      }

      return result;
    });

    return this.toScopedDto(workspaceId, updated);
  }

  async rotateEndpoint(
    workspaceId: string,
    providerRuleId: string,
    actorUserId: string,
  ): Promise<ProviderConversionEndpointSecretResultDto> {
    const config = this.requireRulesEnabled();
    const secret = this.generateSecret();

    const endpoint = await this.prisma.$transaction(async (transaction) => {
      const rule = await this.requireRule(
        transaction,
        workspaceId,
        providerRuleId,
      );

      if (
        rule.conversionRule.triggerType !== "provider_automation" ||
        !rule.endpoint
      ) {
        throw new NotFoundException(endpointNotFoundMessage);
      }

      const rotatedAt = new Date();
      const updated = await transaction.providerConversionRuleEndpoint.update({
        where: { id: rule.endpoint.id },
        data: {
          secretHash: this.hashSecret(secret),
          secretVersion: { increment: 1 },
          rotatedAt,
          removedAt: null,
        },
      });

      await this.createAudit(transaction, {
        workspaceId,
        actorUserId,
        action: "provider_conversion_rule.endpoint_rotated",
        targetId: rule.id,
        resultStatus: rule.mode,
        afterSummary: {
          ...this.auditSummary(rule),
          endpointSecretVersion: updated.secretVersion,
        },
      });

      return updated;
    });

    return {
      endpoint: this.endpointToDto(endpoint),
      webhookUrl: this.buildWebhookUrl(
        config.apiPublicUrl,
        endpoint.id,
        secret,
      ),
    };
  }

  async removeRule(
    workspaceId: string,
    providerRuleId: string,
    actorUserId: string,
  ): Promise<void> {
    this.requireRulesEnabled();

    await this.prisma.$transaction(async (transaction) => {
      const current = await this.requireRule(
        transaction,
        workspaceId,
        providerRuleId,
      );
      const removedAt = new Date();

      await transaction.conversionRule.update({
        where: { id: current.conversionRuleId },
        data: { active: false },
      });
      await transaction.providerConversionRuleConfig.update({
        where: { id: current.id },
        data: {
          mode: "observation",
          productionActivatedAt: null,
          removedAt,
        },
      });
      await transaction.providerConversionRuleEndpoint.updateMany({
        where: { workspaceId, providerRuleId },
        data: { removedAt },
      });

      await this.createAudit(transaction, {
        workspaceId,
        actorUserId,
        action: "provider_conversion_rule.removed",
        targetId: current.id,
        resultStatus: "removed",
        afterSummary: {
          ...this.auditSummary(current),
          removed: true,
        },
      });
    });
  }

  /** Scope options and capability matrix read by the Conversions screen. */
  getCapabilities(): ProviderConversionRuleCapabilitiesDto {
    this.requireRulesEnabled();
    return providerRuleCapabilities();
  }

  /**
   * "Unificar": groups of active specific rules that are identical in origin,
   * event, trigger (phrases/labels/catalog), value and mode. The Umbler
   * automation is never a candidate: unifying it would retire the webhook URL
   * configured in Umbler.
   */
  async listUnifyCandidates(
    workspaceId: string,
  ): Promise<ProviderConversionRuleUnifyCandidatesDto> {
    this.requireRulesEnabled();
    const rules = await this.prisma.providerConversionRuleConfig.findMany({
      where: { workspaceId, removedAt: null },
      include: providerRuleInclude,
      orderBy: { createdAt: "asc" },
    });
    const groups = new Map<string, PersistedProviderRule[]>();
    const globalsByKey = new Map<string, PersistedProviderRule>();
    for (const rule of rules) {
      const signature = this.unifySignature(rule);
      if (!signature || !rule.conversionRule.active) continue;
      if (providerRuleScope(rule) === "all_numbers") {
        if (!globalsByKey.has(signature.key))
          globalsByKey.set(signature.key, rule);
        continue;
      }
      if (rule.unifiedIntoProviderRuleId) continue;
      groups.set(signature.key, [...(groups.get(signature.key) ?? []), rule]);
    }
    const candidates = [...groups.entries()].filter(
      ([, members]) => members.length >= 2,
    );
    if (candidates.length === 0) return { groups: [] };

    const channels = await listWorkspaceScopeChannels(this.prisma, workspaceId);
    return {
      groups: candidates.map(([key, members]) => {
        const first = members[0]!;
        const coverage = this.unifyCoverage(members, rules, channels);
        return {
          key,
          origin: providerRuleOrigin(first)!,
          eventName: conversionEventNameSchema.parse(
            first.conversionRule.eventName,
          ),
          mode: first.mode,
          name: first.conversionRule.name,
          triggerPhrases: [...first.messageTriggerPhrases],
          ruleIds: members.map((rule) => rule.id),
          channelIds: coverage.channelIds,
          newlyCoveredChannelIds: coverage.newlyCoveredChannelIds,
          overriddenChannelIds: coverage.overriddenChannelIds,
          duplicatePhoneChannelIds: coverage.duplicatePhoneChannelIds,
          observationCanonicalChannels: coverage.observationCanonicalChannels,
          existingGlobalRuleId: globalsByKey.get(key)?.id ?? null,
        };
      }),
    };
  }

  /**
   * Replaces identical specific rules by ONE "all numbers" rule. One
   * transaction under a workspace advisory lock: the global rule is created
   * (or an identical active one is reused) and the originals are paused and
   * linked to it, so a message is evaluated either by the originals or by the
   * global rule, never by both. History (executions, decisions, audits) stays
   * on the original rules. Idempotent: repeating the same request after it
   * committed returns the same global rule ("replayed"). Reactivating an
   * original later clears its link (see updateRule).
   */
  async unifyRules(
    workspaceId: string,
    input: ProviderConversionRuleUnifyInputDto,
    actorUserId: string,
  ): Promise<ProviderConversionRuleUnifyResultDto> {
    this.requireRulesEnabled();
    const ruleIds = [...new Set(input.ruleIds)].sort();
    if (ruleIds.length < 2) {
      throw new BadRequestException("Selecione ao menos duas regras");
    }

    const result = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${this.unifyLockId(workspaceId)}::bigint)::text`;
      const rules = await transaction.providerConversionRuleConfig.findMany({
        where: { workspaceId, id: { in: ruleIds }, removedAt: null },
        include: providerRuleInclude,
      });
      if (rules.length !== ruleIds.length) {
        throw new NotFoundException(ruleNotFoundMessage);
      }

      const unifiedInto = new Set(
        rules.map((rule) => rule.unifiedIntoProviderRuleId ?? null),
      );
      if (!unifiedInto.has(null)) {
        if (unifiedInto.size !== 1) {
          throw new ConflictException(
            "Estas regras foram unificadas em regras diferentes",
          );
        }
        const target = await this.requireRule(
          transaction,
          workspaceId,
          [...unifiedInto][0]!,
        );
        return {
          outcome: "replayed" as const,
          target,
          deactivatedRuleIds: ruleIds,
          newlyCoveredChannelIds: [] as string[],
        };
      }
      if (unifiedInto.size > 1) {
        throw new ConflictException(
          "Algumas destas regras ja foram unificadas; atualize a lista",
        );
      }

      const signatures = rules.map((rule) => this.unifySignature(rule));
      const key = signatures[0]?.key;
      if (
        !key ||
        signatures.some((signature) => signature?.key !== key) ||
        rules.some(
          (rule) =>
            !rule.conversionRule.active ||
            providerRuleScope(rule) !== "specific_numbers",
        )
      ) {
        throw new ConflictException(
          "Somente regras ativas, especificas e identicas podem ser unificadas",
        );
      }

      const first = [...rules].sort(
        (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
      )[0]!;
      const origin = providerRuleOrigin(first)!;
      if (first.mode === "production") {
        this.assertModeAllowed("production", null);
      }

      const peers = await transaction.providerConversionRuleConfig.findMany({
        where: {
          workspaceId,
          removedAt: null,
          conversionRule: {
            active: true,
            triggerType: first.conversionRule.triggerType,
            eventName: first.conversionRule.eventName,
          },
        },
        include: providerRuleInclude,
      });
      const existing = peers.find(
        (peer) =>
          providerRuleScope(peer) === "all_numbers" &&
          this.unifySignature(peer)?.key === key,
      );
      // Unificar cria uma regra global: com mais canais do que o limite de
      // avaliação a cobertura não é confiável, então recusa em vez de criar.
      const scan = await scanWorkspaceScopeChannels(transaction, workspaceId);
      if (scan.limitExceeded) {
        throw new ConflictException(
          "Este workspace tem canais demais para unificar regras com segurança; mantenha as regras por número",
        );
      }
      const coverage = this.unifyCoverage(rules, peers, scan.channels);

      const targetId =
        existing?.id ??
        (await this.createUnifiedRule(transaction, {
          workspaceId,
          template: first,
          origin,
          name: input.name ?? first.conversionRule.name,
          actorUserId,
        }));

      await transaction.conversionRule.updateMany({
        where: {
          workspaceId,
          id: { in: rules.map((rule) => rule.conversionRuleId) },
        },
        data: { active: false },
      });
      await transaction.providerConversionRuleConfig.updateMany({
        where: { workspaceId, id: { in: ruleIds } },
        data: {
          mode: "observation",
          productionActivatedAt: null,
          unifiedIntoProviderRuleId: targetId,
        },
      });

      await this.createAudit(transaction, {
        workspaceId,
        actorUserId,
        action: "provider_conversion_rule.unified",
        targetId,
        resultStatus: existing ? "reused_existing" : "created",
        afterSummary: {
          origin,
          eventName: first.conversionRule.eventName,
          mode: first.mode,
          sourceRuleIds: ruleIds,
          sourceChannelIds: coverage.channelIds,
          newlyCoveredChannelIds: coverage.newlyCoveredChannelIds,
          overriddenChannelIds: coverage.overriddenChannelIds,
          duplicatePhoneChannelIds: coverage.duplicatePhoneChannelIds,
        },
      });
      for (const rule of rules) {
        await this.createAudit(transaction, {
          workspaceId,
          actorUserId,
          action: "provider_conversion_rule.unified_source",
          targetId: rule.id,
          resultStatus: "paused",
          afterSummary: {
            ...this.auditSummary(rule),
            active: false,
            unifiedIntoProviderRuleId: targetId,
            previousMode: rule.mode,
          },
        });
      }

      return {
        outcome: existing ? ("reused_existing" as const) : ("created" as const),
        target: await this.requireRule(transaction, workspaceId, targetId),
        deactivatedRuleIds: ruleIds,
        newlyCoveredChannelIds: coverage.newlyCoveredChannelIds,
      };
    });

    return {
      outcome: result.outcome,
      rule: await this.toScopedDto(workspaceId, result.target),
      deactivatedRuleIds: result.deactivatedRuleIds,
      newlyCoveredChannelIds: result.newlyCoveredChannelIds,
    };
  }

  private async createUnifiedRule(
    transaction: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      template: PersistedProviderRule;
      origin: ProviderRuleOrigin;
      name: string;
      actorUserId: string;
    },
  ): Promise<string> {
    const { template, workspaceId } = input;
    const source = template.conversionRule;
    const conversionRule = await transaction.conversionRule.create({
      data: {
        workspaceId,
        name: input.name,
        triggerType: source.triggerType,
        triggerValue: source.triggerValue,
        matchMode: source.matchMode,
        eventName: source.eventName,
        pixelId: null,
        defaultValueCents: source.defaultValueCents,
        defaultCurrency: source.defaultCurrency,
        defaultContentName: source.defaultContentName,
        defaultItems:
          input.origin === "whatsapp_label"
            ? this.uazapiLabelsConfig(
                this.storedLabelNames(source.defaultItems),
                { nameOnly: true },
              )
            : source.defaultItems === null
              ? Prisma.DbNull
              : (source.defaultItems as Prisma.InputJsonValue),
        active: true,
      },
    });
    const providerRule = await transaction.providerConversionRuleConfig.create({
      data: {
        workspaceId,
        conversionRuleId: conversionRule.id,
        connectionId: null,
        parserReleaseId: null,
        scope: "all_numbers",
        mode: template.mode,
        messageTriggerPhrases: [...template.messageTriggerPhrases],
        messageAuthorScope: template.messageAuthorScope,
        productionActivatedAt:
          template.mode === "production" ? new Date() : null,
        createdByUserId: input.actorUserId,
      },
    });
    if (template.catalog) {
      await this.createCatalog(
        transaction,
        workspaceId,
        providerRule.id,
        this.catalogInputFromDto(this.catalogToDto(template.catalog)),
      );
    }
    return providerRule.id;
  }

  private catalogInputFromDto(
    catalog: ProviderConversionCatalogDto,
  ): ProviderConversionCatalogInputDto {
    return {
      name: catalog.name,
      productName: catalog.productName,
      currency: catalog.currency,
      attributes: catalog.attributes.map((attribute) => ({
        key: attribute.key,
        label: attribute.label,
      })),
      variants: catalog.variants
        .filter((variant) => variant.active)
        .map((variant) => ({
          attributeValues: variant.attributeValues,
          aliases: variant.aliases,
          valueCents: variant.valueCents,
          contentName: variant.contentName,
        })),
    } as ProviderConversionCatalogInputDto;
  }

  /**
   * Stable identity of a rule for "Unificar" (scope excluded). Null for
   * origins that cannot be unified.
   */
  private unifySignature(
    rule: PersistedProviderRule,
  ): { key: string; origin: ProviderRuleOrigin } | null {
    const origin = providerRuleOrigin(rule);
    if (!origin || !providerRuleOriginUnifiable(origin) || rule.removedAt) {
      return null;
    }
    const normalize = (value: string) =>
      value.normalize("NFKC").trim().toLocaleLowerCase("pt-BR");
    const source = rule.conversionRule;
    const messagePhrase =
      origin === "message_phrase"
        ? readMessagePhraseConfig(source.defaultItems).valueMode
        : null;
    const catalog = rule.catalog
      ? (() => {
          const dto = this.catalogToDto(rule.catalog);
          return {
            name: dto.name,
            productName: dto.productName,
            currency: dto.currency,
            attributes: dto.attributes.map((attribute) => [
              attribute.key,
              attribute.label,
            ]),
            variants: dto.variants
              .filter((variant) => variant.active)
              .map((variant) => [
                variant.normalizedKey,
                variant.valueCents,
                variant.contentName ?? null,
                variant.aliases,
              ])
              .sort((left, right) =>
                String(left[0]).localeCompare(String(right[0])),
              ),
          };
        })()
      : null;
    const payload = {
      origin,
      eventName: source.eventName,
      mode: rule.mode,
      phrases: [...new Set(rule.messageTriggerPhrases.map(normalize))].sort(),
      authorScope: rule.messageAuthorScope ?? null,
      value: [
        source.defaultValueCents ?? null,
        source.defaultCurrency ?? null,
        source.defaultContentName ?? null,
      ],
      valueMode: messagePhrase,
      labels:
        origin === "whatsapp_label"
          ? [
              ...new Set(
                this.storedLabelNames(source.defaultItems).map((label) =>
                  normalize(label.name),
                ),
              ),
            ].sort()
          : null,
      catalog,
    };
    const key = createHash("sha256")
      .update(JSON.stringify(payload), "utf8")
      .digest("hex")
      .slice(0, 32);
    return { key, origin };
  }

  /**
   * What a global rule built from `members` would cover: the members'
   * chosen channels, the compatible channels it would newly cover, the
   * channels where another specific rule (outside the group) keeps winning
   * and the channels whose phone already runs it on another channel.
   */
  private unifyCoverage(
    members: PersistedProviderRule[],
    peers: PersistedProviderRule[],
    channels: ScopedChannel[],
  ): {
    channelIds: string[];
    newlyCoveredChannelIds: string[];
    overriddenChannelIds: string[];
    duplicatePhoneChannelIds: string[];
    observationCanonicalChannels: Array<{ canonicalChannelId: string; productionChannelIds: string[] }>;
  } {
    const first = members[0]!;
    const memberIds = new Set(members.map((rule) => rule.id));
    const memberChannels = new Set(
      members.flatMap((rule) => rule.channels.map((scope) => scope.channelId)),
    );
    // The members are paused by "Unificar": only the other rules compete.
    const placement = this.globalPlacement(
      {
        ...first,
        scope: "all_numbers",
        connectionId: null,
        parserRelease: null,
        connection: null,
        channels: [],
      },
      peers.filter((peer) => !memberIds.has(peer.id)),
      channels,
    );
    return {
      channelIds: [...memberChannels],
      newlyCoveredChannelIds: placement.effectiveChannelIds.filter(
        (channelId) => !memberChannels.has(channelId),
      ),
      overriddenChannelIds: placement.overriddenChannelIds,
      duplicatePhoneChannelIds: placement.duplicatePhoneChannelIds,
      observationCanonicalChannels: placement.observationCanonicalChannels,
    };
  }

  /**
   * Where a global rule really runs, number by number, with the same
   * precedence as the evaluators: replaced on every channel of a phone that
   * has a specific rule of the same origin/event, and run on one canonical
   * channel per phone.
   */
  private globalPlacement(
    rule: ScopedProviderRule,
    peers: readonly ScopedProviderRule[],
    channels: ScopedChannel[],
  ): {
    effectiveChannelIds: string[];
    overriddenChannelIds: string[];
    overriddenBy: Array<{ channelId: string; providerRuleIds: string[] }>;
    duplicatePhoneChannelIds: string[];
    observationCanonicalChannels: Array<{ canonicalChannelId: string; productionChannelIds: string[] }>;
  } {
    const effectiveChannelIds: string[] = [];
    const overriddenChannelIds: string[] = [];
    const overriddenBy: Array<{ channelId: string; providerRuleIds: string[] }> =
      [];
    const duplicatePhoneChannelIds: string[] = [];
    const others = peers.filter((peer) => peer.id !== rule.id);
    for (const channel of channels) {
      if (!providerRuleCoversChannel(rule, channel)) continue;
      const result = selectApplicableProviderRules([rule], channel, {
        phoneChannels: samePhoneChannels(channels, channel.id),
        peerRules: others,
      });
      if (result.overridden.length) {
        overriddenChannelIds.push(channel.id);
        overriddenBy.push({
          channelId: channel.id,
          providerRuleIds: result.overridden[0]!.bySpecificRuleIds,
        });
      } else if (result.duplicatePhone.length)
        duplicatePhoneChannelIds.push(channel.id);
      else if (result.applicable.length) effectiveChannelIds.push(channel.id);
    }
    // The canonical channel of a phone is chosen like the SaaS (active
    // first, then the oldest). When it is not ready to send (its connection
    // is in observation) while another channel of the same phone is, the
    // global rule only observes that phone: report it for the UI to warn.
    const duplicates = new Set(duplicatePhoneChannelIds);
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    const observationCanonicalChannels: Array<{ canonicalChannelId: string; productionChannelIds: string[] }> = [];
    for (const channelId of effectiveChannelIds) {
      const canonical = byId.get(channelId);
      if (!canonical || canonical.productionReady !== false) continue;
      const productionChannelIds = samePhoneChannels(channels, channelId)
        .filter(
          (sibling) =>
            sibling.id !== channelId &&
            duplicates.has(sibling.id) &&
            sibling.productionReady === true,
        )
        .map((sibling) => sibling.id);
      if (productionChannelIds.length > 0) {
        observationCanonicalChannels.push({
          canonicalChannelId: channelId,
          productionChannelIds,
        });
      }
    }
    return {
      effectiveChannelIds,
      overriddenChannelIds,
      overriddenBy,
      duplicatePhoneChannelIds,
      observationCanonicalChannels,
    };
  }

  private unifyLockId(workspaceId: string): bigint {
    const digest = createHash("sha256")
      .update(JSON.stringify(["provider-rule-unify-lock-v1", workspaceId]))
      .digest("hex");
    return BigInt.asIntN(64, BigInt(`0x${digest.slice(0, 16)}`));
  }

  /** Normalized origin of a rule being created. */
  private createOrigin(
    input: ProviderConversionRuleCreateInputDto,
    connection: { provider: string } | null,
    isPaytAutomation: boolean,
  ): ProviderRuleOrigin {
    if (input.triggerType === "message_phrase") return "message_phrase";
    if (input.triggerType === "structured_catalog") return "structured_catalog";
    if (isPaytAutomation) return "automation_payt";
    // Without a connection, a provider automation can only be a WhatsApp
    // label rule (the Umbler automation always names its connection).
    const origin = providerRuleOrigin({
      conversionRule: { triggerType: "provider_automation", eventName: "" },
      parserRelease: null,
      connection,
    });
    if (!origin) {
      throw new BadRequestException(
        "Automacao por tag ainda so esta disponivel para este provedor",
      );
    }
    return origin;
  }

  /** True when every channel id belongs to the connection (and workspace). */
  private async channelsOnConnection(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    connectionId: string,
    channelIds: string[],
  ): Promise<boolean> {
    const uniqueIds = [...new Set(channelIds)];
    if (uniqueIds.length === 0) return true;
    const count = await transaction.inboundWebhookChannel.count({
      where: { workspaceId, connectionId, id: { in: uniqueIds } },
    });
    return count === uniqueIds.length;
  }

  /**
   * Channels of a rule spanning connections: any live channel of the
   * workspace whose provider supports the rule (labels only on numbers with
   * WhatsApp labels, message rules only where those messages are read).
   */
  private async assertChannelsForOrigin(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    rule: { origin: ProviderRuleOrigin; messageAuthorScope: string | null },
    channelIds: string[],
  ): Promise<void> {
    const uniqueIds = [...new Set(channelIds)];
    if (uniqueIds.length !== channelIds.length) {
      throw new BadRequestException(
        "Um ou mais canais não pertencem a este workspace",
      );
    }
    if (uniqueIds.length === 0) return;
    const channels = await transaction.inboundWebhookChannel.findMany({
      where: {
        workspaceId,
        id: { in: uniqueIds },
        connection: { is: { workspaceId, removedAt: null } },
      },
      select: { id: true, connection: { select: { provider: true } } },
    });
    if (channels.length !== uniqueIds.length) {
      throw new BadRequestException(
        "Um ou mais canais não pertencem a este workspace",
      );
    }
    const providers = providerRuleChannelProviders({
      conversionRule: {
        triggerType:
          rule.origin === "whatsapp_label" ||
          rule.origin === "automation_umbler" ||
          rule.origin === "automation_payt" ||
          rule.origin === "automation_unnichat"
            ? "provider_automation"
            : rule.origin,
        eventName: "",
      },
      parserRelease:
        rule.origin === "automation_umbler"
          ? { provider: "umbler" }
          : rule.origin === "automation_payt"
            ? { provider: "payt" }
            : rule.origin === "automation_unnichat"
              ? { provider: "unnichat" }
              : null,
      connection: null,
      messageAuthorScope: rule.messageAuthorScope,
    });
    if (
      channels.some(
        (channel) => !providers.includes(channel.connection.provider),
      )
    ) {
      throw new BadRequestException(
        rule.origin === "whatsapp_label"
          ? "Etiquetas so estao disponiveis em numeros com etiquetas do WhatsApp"
          : "Um ou mais numeros nao suportam esta origem de regra",
      );
    }
  }

  /**
   * "Envio ativo" for any scope:
   *  - bound + specific: the historical cascade (connection and channels);
   *  - unbound + specific: the same cascade for each connection of the
   *    chosen numbers;
   *  - all numbers: only the rule switches. A global rule never promotes
   *    every number of the workspace; each occurrence is gated by the live
   *    production state of its own number (and of the Umbler connection for
   *    the automation).
   */
  private async activateScopedProduction(
    transaction: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      boundConnectionId: string | null;
      scope: ProviderConversionRuleScopeDto;
      channelIds: string[];
      actorUserId: string;
    },
  ): Promise<void> {
    if (input.scope === "all_numbers") {
      this.requireProductionEnabledConfig();
      return;
    }
    if (input.boundConnectionId !== null) {
      await this.cascadeProductionActivation(transaction, {
        workspaceId: input.workspaceId,
        connectionId: input.boundConnectionId,
        channelIds: input.channelIds,
        actorUserId: input.actorUserId,
      });
      return;
    }
    const channels = await transaction.inboundWebhookChannel.findMany({
      where: { workspaceId: input.workspaceId, id: { in: input.channelIds } },
      select: { id: true, connectionId: true },
    });
    const byConnection = new Map<string, string[]>();
    for (const channel of channels) {
      byConnection.set(channel.connectionId, [
        ...(byConnection.get(channel.connectionId) ?? []),
        channel.id,
      ]);
    }
    if (byConnection.size === 0) {
      throw new ConflictException(
        "Nenhum numero valido na regra; reconecte o WhatsApp ou selecione outro numero",
      );
    }
    for (const [connectionId, channelIds] of byConnection) {
      await this.cascadeProductionActivation(transaction, {
        workspaceId: input.workspaceId,
        connectionId,
        channelIds,
        actorUserId: input.actorUserId,
      });
    }
  }

  /** DTO of one rule with its live effective scope. */
  private async toScopedDto(
    workspaceId: string,
    rule: PersistedProviderRule,
  ): Promise<ProviderConversionRuleDto> {
    if (providerRuleScope(rule) === "specific_numbers") {
      return this.toDto(rule);
    }
    const peers = await this.prisma.providerConversionRuleConfig.findMany({
      where: {
        workspaceId,
        removedAt: null,
        scope: "specific_numbers",
        conversionRule: {
          active: true,
          triggerType: rule.conversionRule.triggerType,
          eventName: rule.conversionRule.eventName,
        },
      },
      include: providerRuleInclude,
    });
    const [dto] = await this.toDtos(this.prisma, workspaceId, [rule], peers);
    return dto!;
  }

  /**
   * DTOs with scope information. `peers` are the rules competing for
   * precedence (usually the full list). Channels are loaded only when a
   * global rule is present, so specific-only lists cost nothing extra.
   */
  private async toDtos(
    client: Pick<Prisma.TransactionClient, "inboundWebhookChannel">,
    workspaceId: string,
    rules: PersistedProviderRule[],
    peers: PersistedProviderRule[],
  ): Promise<ProviderConversionRuleDto[]> {
    const channels = rules.some(
      (rule) => providerRuleScope(rule) === "all_numbers",
    )
      ? await listWorkspaceScopeChannels(client, workspaceId)
      : [];
    return rules.map((rule) =>
      this.toDto(rule, this.effectiveScope(rule, peers, channels)),
    );
  }

  private effectiveScope(
    rule: PersistedProviderRule,
    peers: PersistedProviderRule[],
    channels: ScopedChannel[],
  ): ScopeInfo {
    if (providerRuleScope(rule) === "specific_numbers") {
      return {
        effectiveChannelIds: rule.conversionRule.active
          ? rule.channels.map((channel) => channel.channelId)
          : [],
        overriddenChannelIds: [],
        overriddenBy: [],
        duplicatePhoneChannelIds: [],
        observationCanonicalChannels: [],
      };
    }
    if (!rule.conversionRule.active) {
      return {
        effectiveChannelIds: [],
        overriddenChannelIds: [],
        overriddenBy: [],
        duplicatePhoneChannelIds: [],
        observationCanonicalChannels: [],
      };
    }
    return this.globalPlacement(rule, peers, channels);
  }

  private requireRulesEnabled() {
    const config = parseInboundWebhooksConfig(this.env);

    if (!config.enabled || !config.conversionRulesEnabled) {
      throw new ServiceUnavailableException(
        "Eventos de conversao por provedor ainda nao estao habilitados",
      );
    }

    return config;
  }

  private assertModeAllowed(
    mode: "observation" | "production",
    /**
     * null: the rule spans connections and has no parser of its own; each
     * occurrence is gated by its connection's certified parser.
     */
    parserStatus: "observation_only" | "certified" | "retired" | null,
  ): void {
    if (mode !== "production") return;
    const config = this.requireRulesEnabled();

    if (!config.conversionProductionEnabled) {
      throw new ServiceUnavailableException(
        "Materializacao de conversoes por provedor ainda nao esta habilitada",
      );
    }
    if (parserStatus !== null && parserStatus !== "certified") {
      throw new ConflictException(
        "Certifique o parser antes de ativar esta regra em producao",
      );
    }
  }

  /**
   * The operator only sees one switch: "Envio ativo" on the conversion rule.
   * Before this cascade existed, flipping it stamped the rule alone, so the
   * inbound connection stayed in `observation` and its channels in
   * `discovered`, and every decision was later blocked with
   * `connection_not_production` / `channel_not_active`. Turning the rule on now
   * runs exactly the same activation the Integrations panel buttons run, so the
   * three switches can never drift apart again.
   *
   * Fail-closed on purpose: when the connection cannot be promoted (parser not
   * certified, replay in flight, missing Meta route) the whole rule update
   * rolls back with that reason instead of leaving a green "Envio ativo" that
   * sends nothing.
   */
  private async cascadeProductionActivation(
    transaction: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      connectionId: string;
      channelIds: string[];
      actorUserId: string;
    },
  ): Promise<void> {
    this.requireProductionEnabledConfig();

    const { workspaceId, connectionId, actorUserId } = input;
    const connection = await requireInboundWebhookConnection(
      transaction,
      workspaceId,
      connectionId,
    );
    const requireValidMetaRoute = metaRouteRequiredForProvider(
      connection.provider,
    );
    const seats = this.seatHook();

    // Channels first: promoting the connection refuses to run without at least
    // one active channel, and it stamps productionActivatedAt on every channel
    // that is already active by then.
    for (const channelId of [...new Set(input.channelIds)]) {
      const channel = await requireInboundWebhookChannel(
        transaction,
        workspaceId,
        channelId,
      );

      if (channel.connectionId !== connectionId) {
        throw new BadRequestException(
          "Um ou mais canais não pertencem a esta conexão e workspace",
        );
      }

      // An already-active channel only needs a rewrite when the connection is
      // production and its stamp was lost; otherwise the connection promote
      // below stamps it.
      if (
        channel.status === "active" &&
        (connection.status !== "production" ||
          channel.productionActivatedAt !== null)
      ) {
        continue;
      }

      await applyInboundWebhookChannelStatus(transaction, {
        workspaceId,
        channelId,
        status: "active",
        actorUserId,
        requireValidMetaRoute,
        seats,
      });
    }

    if (connection.status === "production") {
      return;
    }

    await applyInboundWebhookConnectionStatus(transaction, {
      workspaceId,
      connectionId,
      status: "production",
      actorUserId,
      requireValidMetaRoute,
      seats,
      env: this.env,
    });
  }

  private requireProductionEnabledConfig() {
    const config = this.requireRulesEnabled();

    if (!config.productionEnabled) {
      throw new ServiceUnavailableException(
        "Envio automatico de webhooks ainda nao esta habilitado",
      );
    }

    return config;
  }

  /**
   * Mirrors InboundWebhookConnectionsService: enforcement is resolved lazily
   * because it throws when billing is on without a seat service wired, and the
   * cascade must only reach that point when it actually bills a seat.
   */
  private seatHook(): ExternalChannelSeatHook {
    return {
      enforcementEnabled: () => this.externalChannelEnforcementEnabled(),
      activateSeat: () => {
        throw new Error(
          "External channel seat activation is unavailable once billing/ is removed.",
        );
      },
    };
  }

  private externalChannelEnforcementEnabled(): boolean {
    // rastrackdash sanitize (rewrite_rules.external-channel-seat-gate-noop):
    // billing/ is stripped in this edition, so external-channel seat
    // enforcement can never be enabled — hardcode the noop outcome instead
    // of inferring it from now-absent optional billing deps.
    return false;
  }

  private async assertChannelsBelongToConnection(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    connectionId: string,
    channelIds: string[],
  ): Promise<void> {
    const uniqueIds = [...new Set(channelIds)];
    const count = await transaction.inboundWebhookChannel.count({
      where: {
        workspaceId,
        connectionId,
        id: { in: uniqueIds },
      },
    });

    if (count !== uniqueIds.length || uniqueIds.length !== channelIds.length) {
      throw new BadRequestException(
        "Um ou mais canais não pertencem a esta conexão e workspace",
      );
    }
  }

  /**
   * A Payt callback is not itself a WhatsApp channel. Its automation rule may
   * scope any channel of the workspace; the selected channels still scope
   * lookup and observation. Other providers keep the stricter connection
   * ownership check.
   */
  private async assertChannelsForProvider(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    connectionId: string,
    provider: string,
    channelIds: string[],
  ): Promise<void> {
    if (provider !== "payt") {
      return this.assertChannelsBelongToConnection(
        transaction,
        workspaceId,
        connectionId,
        channelIds,
      );
    }

    const uniqueIds = [...new Set(channelIds)];
    const count = await transaction.inboundWebhookChannel.count({
      where: { workspaceId, id: { in: uniqueIds } },
    });
    if (count !== uniqueIds.length || uniqueIds.length !== channelIds.length) {
      throw new BadRequestException(
        "Um ou mais canais não pertencem a este workspace",
      );
    }
  }

  private isPaytAutomationRule(rule: PersistedProviderRule): boolean {
    return (
      rule.conversionRule.triggerType === "provider_automation" &&
      rule.parserRelease?.provider === "payt"
    );
  }

  private messagePhraseConfig(input: {
    valueMode: MessagePhraseValueModeDto;
    exampleMessage: string | null;
  }): Prisma.InputJsonValue {
    return {
      kind: messagePhraseConfigKind,
      valueMode: input.valueMode,
      exampleMessage: input.exampleMessage,
    } satisfies MessagePhraseConfigDto;
  }

  private assertUpdateMatchesRule(
    current: PersistedProviderRule,
    input: ProviderConversionRuleUpdateInputDto,
  ): void {
    // The event catalog decides whether this rule may carry a value at all:
    // QualifiedLead, OrderShipped and friends never do.
    const eventName = conversionEventNameSchema.safeParse(
      current.conversionRule.eventName,
    );
    const isValuedRule =
      ["provider_automation", "message_phrase"].includes(
        current.conversionRule.triggerType,
      ) &&
      eventName.success &&
      conversionEventCarriesValue(eventName.data);
    const isMessagePhraseRule =
      current.conversionRule.triggerType === "message_phrase";
    // The message template is meaningful for every message rule, but the value
    // mode only exists where the event can carry a value.
    const isValuedMessageRule = isMessagePhraseRule && isValuedRule;
    const hasValueUpdate =
      input.defaultValueCents !== undefined ||
      input.defaultCurrency !== undefined ||
      input.defaultContentName !== undefined;

    if (hasValueUpdate && !isValuedRule) {
      throw new BadRequestException(
        "Valores padrao pertencem apenas a regras de compra/checkout com valor",
      );
    }
    if (input.exampleMessage !== undefined && !isMessagePhraseRule) {
      throw new BadRequestException(
        "O exemplo de mensagem pertence apenas a regras por mensagem",
      );
    }
    if (input.valueMode !== undefined && !isValuedMessageRule) {
      throw new BadRequestException(
        "O modo de valor pertence apenas a regras por mensagem com valor",
      );
    }
    if (
      input.productFilterCodes !== undefined &&
      !this.isPaytAutomationRule(current)
    ) {
      throw new BadRequestException(
        "Filtro de produto só existe para plataformas de venda",
      );
    }
    if (
      input.publicUrlDisabled !== undefined &&
      current.conversionRule.triggerType !== "provider_automation"
    ) {
      throw new BadRequestException(
        "Só regras com URL própria têm URL antiga para desativar",
      );
    }
    // Only extracted-value message rules may drop the average value: the value
    // then comes from the message itself.
    const nextValueMode = isValuedMessageRule
      ? (input.valueMode ??
        readMessagePhraseConfig(current.conversionRule.defaultItems).valueMode)
      : "fixed";
    if (
      isValuedRule &&
      input.defaultValueCents === null &&
      nextValueMode !== "message_extracted"
    ) {
      throw new BadRequestException(
        "Regras com valor fixo precisam manter um valor positivo",
      );
    }
    if (
      isValuedMessageRule &&
      input.valueMode === "fixed" &&
      !(input.defaultValueCents ?? current.conversionRule.defaultValueCents)
    ) {
      throw new BadRequestException(
        "Informe o valor medio antes de voltar para o modo de valor fixo",
      );
    }
    if (
      input.catalog &&
      current.conversionRule.triggerType !== "structured_catalog"
    ) {
      throw new BadRequestException(
        "Catalogos pertencem apenas a regras de compra estruturada",
      );
    }
    const isMessageRule = ["message_phrase", "structured_catalog"].includes(
      current.conversionRule.triggerType,
    );
    if (
      (input.triggerPhrases !== undefined ||
        input.messageAuthorScope !== undefined) &&
      !isMessageRule
    ) {
      throw new BadRequestException(
        "Frases gatilho pertencem apenas a regras baseadas em mensagem",
      );
    }
    if (
      input.triggerLabels !== undefined &&
      providerRuleOrigin(current) !== "whatsapp_label"
    ) {
      throw new BadRequestException(
        "Etiquetas pertencem apenas a automacao UAZAPI",
      );
    }
    if (
      input.mode === "production" &&
      (input.active === false || !current.conversionRule.active)
    ) {
      throw new ConflictException(
        "Ative a regra antes de promover para producao",
      );
    }
  }

  private assertUniqueCatalogVariants(input: {
    triggerType: string;
    catalog?: ProviderConversionCatalogInputDto;
  }): void {
    if (input.triggerType !== "structured_catalog" || !input.catalog) return;
    const keys = input.catalog.variants.map((variant) =>
      this.catalogVariantKey(variant.attributeValues),
    );

    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException(
        "Cada combinacao de atributos do catalogo deve ser unica",
      );
    }
  }

  private async createCatalog(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    providerRuleId: string,
    catalog: ProviderConversionCatalogInputDto,
  ): Promise<void> {
    const created = await transaction.conversionCatalog.create({
      data: {
        workspaceId,
        providerRuleId,
        name: catalog.name,
        productName: catalog.productName,
        currency: catalog.currency,
      },
    });

    await transaction.conversionCatalogAttribute.createMany({
      data: catalog.attributes.map((attribute, index) => ({
        workspaceId,
        catalogId: created.id,
        position: index + 1,
        key: attribute.key,
        label: attribute.label,
      })),
    });
    await transaction.conversionCatalogVariant.createMany({
      data: catalog.variants.map((variant) => ({
        workspaceId,
        catalogId: created.id,
        normalizedKey: this.catalogVariantKey(variant.attributeValues),
        attributeValues: variant.attributeValues as Prisma.InputJsonValue,
        aliases: variant.aliases as Prisma.InputJsonValue,
        valueCents: variant.valueCents,
        contentName: variant.contentName ?? null,
      })),
    });
  }

  private async replaceCatalog(
    transaction: Prisma.TransactionClient,
    workspaceId: string,
    providerRuleId: string,
    catalog: ProviderConversionCatalogInputDto,
  ): Promise<void> {
    const current = await transaction.conversionCatalog.findFirst({
      where: { workspaceId, providerRuleId },
      select: { id: true },
    });

    if (!current) {
      await this.createCatalog(
        transaction,
        workspaceId,
        providerRuleId,
        catalog,
      );
      return;
    }

    await transaction.conversionCatalogVariant.deleteMany({
      where: { workspaceId, catalogId: current.id },
    });
    await transaction.conversionCatalogAttribute.deleteMany({
      where: { workspaceId, catalogId: current.id },
    });
    await transaction.conversionCatalog.update({
      where: { id: current.id },
      data: {
        name: catalog.name,
        productName: catalog.productName,
        currency: catalog.currency,
        active: true,
      },
    });
    await transaction.conversionCatalogAttribute.createMany({
      data: catalog.attributes.map((attribute, index) => ({
        workspaceId,
        catalogId: current.id,
        position: index + 1,
        key: attribute.key,
        label: attribute.label,
      })),
    });
    await transaction.conversionCatalogVariant.createMany({
      data: catalog.variants.map((variant) => ({
        workspaceId,
        catalogId: current.id,
        normalizedKey: this.catalogVariantKey(variant.attributeValues),
        attributeValues: variant.attributeValues as Prisma.InputJsonValue,
        aliases: variant.aliases as Prisma.InputJsonValue,
        valueCents: variant.valueCents,
        contentName: variant.contentName ?? null,
      })),
    });
  }

  private catalogAliasUpdates(
    current: NonNullable<PersistedProviderRule["catalog"]>,
    next: ProviderConversionCatalogInputDto,
  ): Array<{ id: string; aliases: string[][] }> | null {
    const currentDto = this.catalogToDto(current);
    if (
      currentDto.name !== next.name ||
      currentDto.productName !== next.productName ||
      currentDto.currency !== next.currency ||
      currentDto.attributes.length !== next.attributes.length ||
      currentDto.variants.length !== next.variants.length
    ) {
      return null;
    }

    const attributesUnchanged = currentDto.attributes.every(
      (attribute, index) =>
        attribute.key === next.attributes[index]?.key &&
        attribute.label === next.attributes[index]?.label,
    );
    if (!attributesUnchanged) return null;

    const currentByKey = new Map(
      currentDto.variants.map((variant) => [variant.normalizedKey, variant]),
    );
    const updates: Array<{ id: string; aliases: string[][] }> = [];

    for (const variant of next.variants) {
      const currentVariant = currentByKey.get(
        this.catalogVariantKey(variant.attributeValues),
      );
      if (
        !currentVariant ||
        currentVariant.valueCents !== variant.valueCents ||
        (currentVariant.contentName ?? null) !==
          (variant.contentName ?? null) ||
        !this.sameStrings(
          currentVariant.attributeValues,
          variant.attributeValues,
        )
      ) {
        return null;
      }

      if (!this.sameNestedStrings(currentVariant.aliases, variant.aliases)) {
        updates.push({ id: currentVariant.id, aliases: variant.aliases });
      }
    }

    return updates;
  }

  private sameStrings(current: string[], next: string[]): boolean {
    return (
      current.length === next.length &&
      current.every((value, index) => value === next[index])
    );
  }

  private sameNestedStrings(current: string[][], next: string[][]): boolean {
    return (
      current.length === next.length &&
      current.every((values, index) =>
        this.sameStrings(values, next[index] ?? []),
      )
    );
  }

  private catalogVariantKey(values: string[]): string {
    return values
      .map((value) => this.normalizeCatalogValue(value))
      .join("\u001f");
  }

  private normalizeCatalogValue(value: string): string {
    return value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLocaleLowerCase("pt-BR")
      .replace(/\s+/g, " ");
  }

  private async requireRule(
    client: Pick<Prisma.TransactionClient, "providerConversionRuleConfig">,
    workspaceId: string,
    providerRuleId: string,
  ): Promise<PersistedProviderRule> {
    const rule = await client.providerConversionRuleConfig.findFirst({
      where: {
        id: providerRuleId,
        workspaceId,
        removedAt: null,
        // Bound rules disappear with their connection; unbound rules belong
        // to the workspace.
        OR: [
          { connectionId: null },
          { connection: { is: { removedAt: null } } },
        ],
      },
      include: providerRuleInclude,
    });

    if (!rule) {
      throw new NotFoundException(ruleNotFoundMessage);
    }

    return rule;
  }

  private toDto(
    rule: PersistedProviderRule,
    scopeInfo?: ScopeInfo,
  ): ProviderConversionRuleDto {
    const scope = providerRuleScope(rule);
    const effective: ScopeInfo = scopeInfo ?? {
      effectiveChannelIds:
        scope === "specific_numbers" && rule.conversionRule.active
          ? rule.channels.map((channel) => channel.channelId)
          : [],
      overriddenChannelIds: [],
      overriddenBy: [],
      duplicatePhoneChannelIds: [],
      observationCanonicalChannels: [],
    };
    const messagePhrase =
      rule.conversionRule.triggerType === "message_phrase"
        ? readMessagePhraseConfig(rule.conversionRule.defaultItems)
        : { valueMode: "fixed" as const, exampleMessage: null };

    return {
      id: rule.id,
      workspaceId: rule.workspaceId,
      conversionRule: {
        id: rule.conversionRule.id,
        workspaceId: rule.conversionRule.workspaceId,
        name: rule.conversionRule.name,
        triggerType: rule.conversionRule.triggerType,
        triggerValue: rule.conversionRule.triggerValue,
        matchMode: rule.conversionRule.matchMode,
        eventName: rule.conversionRule
          .eventName as ProviderConversionRuleDto["conversionRule"]["eventName"],
        pixelId: rule.conversionRule.pixelId,
        defaultValueCents: rule.conversionRule.defaultValueCents,
        defaultCurrency: rule.conversionRule.defaultCurrency,
        defaultContentName: rule.conversionRule.defaultContentName,
        defaultItems: Array.isArray(rule.conversionRule.defaultItems)
          ? (rule.conversionRule
              .defaultItems as ProviderConversionRuleDto["conversionRule"]["defaultItems"])
          : null,
        active: rule.conversionRule.active,
        createdAt: rule.conversionRule.createdAt.toISOString(),
        updatedAt: rule.conversionRule.updatedAt.toISOString(),
      },
      connectionId: rule.connectionId,
      mode: rule.mode,
      parserReleaseId: rule.parserReleaseId,
      productionActivatedAt: rule.productionActivatedAt?.toISOString() ?? null,
      scope,
      origin: providerRuleOrigin(rule),
      channelIds: rule.channels.map((channel) => channel.channelId),
      effectiveChannelIds: effective.effectiveChannelIds,
      overriddenChannelIds: effective.overriddenChannelIds,
      overriddenBy: effective.overriddenBy,
      duplicatePhoneChannelIds: effective.duplicatePhoneChannelIds,
      observationCanonicalChannels: effective.observationCanonicalChannels,
      globalPrecedence: PROVIDER_RULE_GLOBAL_PRECEDENCE,
      unifiedIntoRuleId: rule.unifiedIntoProviderRuleId ?? null,
      triggerPhrases: rule.messageTriggerPhrases,
      messageAuthorScope: rule.messageAuthorScope,
      valueMode: messagePhrase.valueMode,
      exampleMessage: messagePhrase.exampleMessage,
      // The parser release is stored with the rule, so this remains available
      // after a connection changes and does not require a new database column.
      automationSource: this.isPaytAutomationRule(rule) ? "payt" : null,
      productFilterCodes: rule.productFilterCodes ?? [],
      endpoint: rule.endpoint ? this.endpointToDto(rule.endpoint) : null,
      catalog: rule.catalog ? this.catalogToDto(rule.catalog) : null,
      lastExecution: rule.executions[0]
        ? {
            id: rule.executions[0].id,
            workspaceId: rule.executions[0].workspaceId,
            providerRuleId: rule.executions[0].providerRuleId,
            sourceDeliveryId: rule.executions[0].sourceDeliveryId,
            channelId: rule.executions[0].channelId,
            externalExecutionKey: rule.executions[0].externalExecutionKey,
            occurredAt: rule.executions[0].occurredAt.toISOString(),
            status: rule.executions[0].status,
            reasonCode: rule.executions[0].reasonCode,
            matchedCatalogVariantId: rule.executions[0].matchedCatalogVariantId,
            valueCents: rule.executions[0].valueCents,
            currency: rule.executions[0].currency,
            leadId: rule.executions[0].leadId,
            conversionEventLogId: rule.executions[0].conversionEventLogId,
            attemptCount: rule.executions[0].attemptCount,
            createdAt: rule.executions[0].createdAt.toISOString(),
            updatedAt: rule.executions[0].updatedAt.toISOString(),
          }
        : null,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
    };
  }

  /**
   * nameOnly: the rule spans WhatsApp instances, where a label id only means
   * something inside its own instance. Matching then uses the label name.
   */
  private uazapiLabelsConfig(
    labels: Array<{ id: string; name: string }>,
    options: { nameOnly?: boolean } = {},
  ): Prisma.InputJsonValue {
    return {
      uazapiLabels: labels.map((label) => {
        const id = label.id.trim();
        const localId = id.includes(":") ? id.split(":").pop()! : id;
        return options.nameOnly
          ? { id, labelId: localId, matchKeys: [], name: label.name.trim() }
          : {
              id,
              labelId: localId,
              matchKeys: [...new Set([id, localId])],
              name: label.name.trim(),
            };
      }),
    } as Prisma.InputJsonValue;
  }

  private storedLabelNames(
    value: Prisma.JsonValue | null,
  ): Array<{ id: string; name: string }> {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).uazapiLabels
        : null;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const label = item as Record<string, unknown>;
      const name = typeof label.name === "string" ? label.name.trim() : "";
      const id = typeof label.id === "string" ? label.id.trim() : name;
      return name ? [{ id: id || name, name }] : [];
    });
  }

  private endpointToDto(
    endpoint: PersistedProviderRule["endpoint"] extends infer T
      ? NonNullable<T>
      : never,
  ): ProviderConversionEndpointDto {
    return {
      id: endpoint.id,
      workspaceId: endpoint.workspaceId,
      providerRuleId: endpoint.providerRuleId,
      secretVersion: endpoint.secretVersion,
      lastDeliveryAt: endpoint.lastDeliveryAt?.toISOString() ?? null,
      lastSuccessfulParseAt:
        endpoint.lastSuccessfulParseAt?.toISOString() ?? null,
      rotatedAt: endpoint.rotatedAt?.toISOString() ?? null,
      removedAt: endpoint.removedAt?.toISOString() ?? null,
      publicUrlDisabledAt: endpoint.publicUrlDisabledAt?.toISOString() ?? null,
      createdAt: endpoint.createdAt.toISOString(),
      updatedAt: endpoint.updatedAt.toISOString(),
    };
  }

  private catalogToDto(
    catalog: NonNullable<PersistedProviderRule["catalog"]>,
  ): ProviderConversionCatalogDto {
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

  private generateSecret(): string {
    return randomBytes(32).toString("base64url");
  }

  private hashSecret(secret: string): string {
    return createHash("sha256").update(secret, "utf8").digest("hex");
  }

  private buildWebhookUrl(
    apiPublicUrl: string,
    endpointId: string,
    secret: string,
  ): string {
    const url = new URL(
      `/webhooks/inbound/conversions/${encodeURIComponent(endpointId)}`,
      apiPublicUrl,
    );
    url.searchParams.set("token", secret);
    return url.toString();
  }

  private auditSummary(rule: PersistedProviderRule): Prisma.InputJsonObject {
    return {
      eventName: rule.conversionRule.eventName,
      triggerType: rule.conversionRule.triggerType,
      connectionId: rule.connectionId,
      scope: providerRuleScope(rule),
      channelCount: rule.channels.length,
      mode: rule.mode,
      active: rule.conversionRule.active,
      endpointSecretVersion: rule.endpoint?.secretVersion ?? null,
      catalogVariantCount: rule.catalog?.variants.length ?? 0,
    };
  }

  private async createAudit(
    transaction: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      actorUserId: string;
      action: string;
      targetId: string;
      resultStatus: string;
      afterSummary: Prisma.InputJsonObject;
    },
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        actorType: "user",
        action: input.action,
        targetType: "ProviderConversionRuleConfig",
        targetId: input.targetId,
        reason: null,
        sourceIp: null,
        resultStatus: input.resultStatus,
        beforeSummary: undefined,
        afterSummary: input.afterSummary,
      },
    });
  }
}
