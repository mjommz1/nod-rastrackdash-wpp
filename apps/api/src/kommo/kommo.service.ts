import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import {
  KOMMO_CTWA_PROCESSING_MODE,
  kommoCtwaIntent,
  kommoPublicationAuthorized,
  type KommoCtwaPublicationIntent,
  type KommoPublicationIntent,
} from "./kommo-publication-policy";
import {
  crmCtwaChannelBound,
  crmLeadCtwaProof,
  crmLeadEntryChannelIds,
  crmLeadRoutes,
  inspectCrmBinding,
} from "../crm-channels/crm-channel-policy";
import type { AuthorizedCtwaDestination } from "../inbound-webhooks/authorized-ctwa-destination";
import { Prisma } from "@prisma/client";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  conversionEventCarriesValue,
  conversionEventRequiresValue,
  kommoChannelBindingMessages,
  kommoConversionRuleCreateInputSchema,
  type ConversionEventNameDto,
  type KommoConnectionCreateInputDto,
  type KommoConnectionCredentialReplaceInputDto,
  type KommoConversionRuleCreateInputDto,
  type KommoConversionRuleUpdateInputDto,
  RULE_CURRENCY_INVALID_MESSAGE,
  hasRuleCurrencyIssue,
  normalizeCurrencyCode,
  type CurrencyCode,
} from "@wpptrack/shared";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import { hashPhoneIdentity } from "../common/phone/phone-identity";
import { loadWorkspaceConversionCurrency } from "../currency/workspace-currency";
import { PrismaService } from "../common/prisma/prisma.service";
import { ConversionEventsService } from "../conversion-events/conversion-events.service";
import { KommoAdapter, KommoAdapterError } from "./kommo.adapter";
import { kommoDeliveryKey, type KommoStageEvent } from "./kommo-webhook.parser";
import {
  kommoDeliveryUnknown,
  settleKommoSenderOutcome,
  KOMMO_DELIVERY_UNKNOWN,
  KOMMO_DELIVERY_UNKNOWN_MESSAGE,
} from "./kommo-sender-policy";
import { KommoWebhookQueueService } from "./kommo-webhook-queue.service";
import { LicenseClientService } from "../licensing-client/license-client.service";

type Connection = any;
type AuditActorType = "user" | "platform_admin";
type ProvenKommoLead = {
  id: string;
  phoneHash: string;
  /** Uazapi lead: its WhatsApp instance; official-API number lead: null. */
  whatsappInstanceId: string | null;
  campaignId: string | null;
  adSetId: string | null;
  adId: string;
  ctwaClid: string;
};
type LeadDestination = {
  reportingAccountId: string;
  conversionDestinationId: string;
};

@Injectable()
export class KommoService implements OnModuleInit, OnModuleDestroy {
  private recoveryTimer?: NodeJS.Timeout;
  private eventRecoveryCursor?: string;
  private intentRecoveryCursor?: string;
  private catalogRecoveryCursor?: string;
  private reconciling = false;
  private stopping = false;
  // Replaceable clock for deterministic lease/freshness tests; no additional DI.
  now: () => Date = () => new Date();
  private readonly leaseMs = 90_000;
  private readonly catalogTtlMs = 15 * 60_000;
  private readonly maxAttempts = 5;
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapter: KommoAdapter,
    private readonly queue: KommoWebhookQueueService,
    private readonly conversions: ConversionEventsService,
    private readonly conversionQueue: ConversionEventsQueueService,
    private readonly licenseClient: LicenseClientService,
  ) {}

  /** Background workers have no HTTP request guard; unavailable is locked. */
  private async licenseAllows(): Promise<boolean> {
    try {
      const decision = await this.licenseClient.getLockState();
      return decision.inert || !decision.locked;
    } catch {
      return false;
    }
  }

  private async assertLicenseAllows(): Promise<void> {
    if (!(await this.licenseAllows()))
      throw new Error("kommo_license_locked");
  }

  async onModuleInit(): Promise<void> {
    this.recoveryTimer = setInterval(() => {
      void this.reconcileSafely();
    }, 30_000);
    this.recoveryTimer.unref();
    await this.reconcileSafely();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  private async reconcileSafely() {
    if (this.reconciling || this.stopping) return;
    if (!(await this.licenseAllows())) return;
    this.reconciling = true;
    try {
      await this.reconcileRecoverableEvents();
    } catch {
      // Per-row failures retain durable state and retry times. A failed sweep
      // is retried by the timer; it cannot acknowledge or erase any intent.
    } finally {
      this.reconciling = false;
    }
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.kommoConnection.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      include: {
        pipelines: {
          orderBy: [{ pipelineName: "asc" }, { statusName: "asc" }],
        },
        rules: { orderBy: { createdAt: "desc" } },
      },
    });
    return rows.map((row: any) => this.dto(row));
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    input: KommoConnectionCreateInputDto,
    actorType: AuditActorType = "user",
  ) {
    const id = randomUUID();
    const secret = this.newSecret();
    await this.validateBindings(
      this.prisma,
      workspaceId,
      input.allowedChannelRouteIds,
    );
    const initial = await this.prisma.$transaction(async (tx: any) => {
      const initial = await tx.kommoConnection.create({
        data: {
          id,
          workspaceId,
          displayName: input.displayName,
          accountOrigin: input.accountOrigin,
          webhookSecretHash: this.hash(secret),
          allowedChannelRouteIds: input.allowedChannelRouteIds,
          ...this.encrypt(id, input.accessToken),
        },
      });
      await this.audit(
        workspaceId,
        actorUserId,
        actorType,
        "kommo.connection_created",
        id,
        "pending_verification",
        tx,
      );
      return initial;
    });

    try {
      await this.verifyAndRefresh(initial, input.accessToken);
    } catch (error) {
      await this.audit(
        workspaceId,
        actorUserId,
        actorType,
        "kommo.connection_create_failed",
        id,
        this.code(error),
      );
      throw error;
    }

    const connection = await this.prisma.kommoConnection.findUniqueOrThrow({
      where: { id },
      include: { pipelines: true, rules: true },
    });

    return { ...this.dto(connection), webhookUrl: this.webhookUrl(id, secret) };
  }

  async replaceCredential(
    workspaceId: string,
    connectionId: string,
    actorUserId: string,
    input: KommoConnectionCredentialReplaceInputDto,
    actorType: AuditActorType = "user",
  ) {
    const current = await this.connection(workspaceId, connectionId);
    const origin = input.accountOrigin ?? current.accountOrigin;
    const account = await this.adapter.verify(origin, input.accessToken);
    let accountChanged = false;

    await this.prisma.$transaction(async (tx: any) => {
      const live = await this.lockConnection(tx, workspaceId, connectionId);
      // An omitted origin may never overwrite a concurrent origin change.
      if (!input.accountOrigin && current.accountOrigin !== live.accountOrigin)
        throw new ConflictException("Conexao alterada; tente novamente");
      accountChanged =
        live.verifiedAccountId !== null &&
        live.verifiedAccountId !== account.id;
      await tx.kommoConnection.update({
        where: { id: connectionId },
        data: {
          accountOrigin: origin,
          verifiedAccountId: account.id,
          accountSubdomain: account.subdomain,
          credentialHealthy: true,
          status: "active",
          lastErrorCode: null,
          credentialGeneration: { increment: 1 },
          catalogState: "stale",
          ...(accountChanged
            ? {
                catalogState: "empty",
                catalogRefreshedAt: null,
                allowedChannelRouteIds: [],
              }
            : {}),
          ...this.encrypt(connectionId, input.accessToken),
        },
      });
      if (accountChanged) {
        await tx.kommoPipelineCatalog.deleteMany({ where: { connectionId } });
        await tx.kommoConversionRule.updateMany({
          where: { connectionId },
          data: { active: false },
        });
      }
      await this.audit(
        workspaceId,
        actorUserId,
        actorType,
        "kommo.credential_replaced",
        connectionId,
        accountChanged ? "account_changed_rules_paused" : "success",
        tx,
      );
    });

    await this.refreshCatalog(workspaceId, connectionId);

    return this.get(workspaceId, connectionId);
  }

  async get(workspaceId: string, connectionId: string) {
    const row = await this.prisma.kommoConnection.findFirst({
      where: { id: connectionId, workspaceId },
      include: {
        pipelines: {
          orderBy: [{ pipelineName: "asc" }, { statusName: "asc" }],
        },
        rules: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!row) throw new NotFoundException("Conexao Kommo nao encontrada");
    return this.dto(row);
  }

  async listEvents(workspaceId: string, connectionId: string, cursor?: string) {
    await this.connection(workspaceId, connectionId);
    const events = await this.prisma.kommoWebhookEvent.findMany({
      where: {
        workspaceId,
        connectionId,
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: 100,
    });
    const ids = events.flatMap((event) =>
      (Array.isArray(event.results) ? (event.results as any[]) : [])
        .map((result) => result.conversionEventLogId)
        .filter(Boolean),
    );
    const logs = await this.prisma.conversionEventLog.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true, status: true, errorCode: true },
    });
    const intents = await this.prisma.kommoConversionDedupe.findMany({
      where: { workspaceId, conversionEventLogId: { in: ids } },
    });
    return {
      events: events.map((event) => {
        const unknown = intents.some(
          (intent) =>
            intent.sourceEventId === event.id &&
            kommoDeliveryUnknown(
              intent,
              logs.find((log) => log.id === intent.conversionEventLogId),
            ),
        );
        const confirmedUnknown =
          event.errorCode === KOMMO_DELIVERY_UNKNOWN &&
          Array.isArray(event.results) &&
          event.results.length > 0 &&
          (event.results as any[]).every((result) =>
            logs.some(
              (log) =>
                log.id === result.conversionEventLogId && log.status === "sent",
            ),
          );
        return {
          id: event.id,
          dealId: event.dealId,
          pipelineId: event.pipelineId,
          statusId: event.statusId,
          status: unknown
            ? "blocked"
            : confirmedUnknown
              ? "sent"
              : event.status,
          errorCode: unknown
            ? KOMMO_DELIVERY_UNKNOWN
            : confirmedUnknown
              ? null
              : event.errorCode,
          ...(unknown ? { errorMessage: KOMMO_DELIVERY_UNKNOWN_MESSAGE } : {}),
          attempts: event.attempts,
          results: (Array.isArray(event.results)
            ? (event.results as any[])
            : []
          ).map((result) => {
            const log = logs.find(
              (log) => log.id === result.conversionEventLogId,
            );
            const intent = intents.find(
              (intent) =>
                intent.conversionEventLogId === result.conversionEventLogId,
            );
            return {
              ...result,
              ...(log ? { senderStatus: log.status } : {}),
              ...(intent
                ? {
                    publicationStatus:
                      log?.status === "sent"
                        ? "sent"
                        : kommoDeliveryUnknown(intent, log)
                          ? "delivery_unknown"
                          : intent.publicationStatus,
                    publicationErrorCode:
                      log?.status === "sent"
                        ? null
                        : kommoDeliveryUnknown(intent, log)
                          ? KOMMO_DELIVERY_UNKNOWN
                          : intent.publicationErrorCode,
                    ...(kommoDeliveryUnknown(intent, log)
                      ? {
                          publicationErrorMessage:
                            KOMMO_DELIVERY_UNKNOWN_MESSAGE,
                        }
                      : {}),
                  }
                : {}),
            };
          }),
        };
      }),
      nextCursor: events.length === 100 ? events.at(-1)!.id : null,
    };
  }

  async setStatus(
    workspaceId: string,
    connectionId: string,
    actorUserId: string,
    status: "active" | "paused",
    actorType: AuditActorType = "user",
  ) {
    await this.prisma.$transaction(async (tx: any) => {
      const current = await this.lockConnection(tx, workspaceId, connectionId);
      if (
        status === "active" &&
        (!current.credentialHealthy || !current.verifiedAccountId)
      )
        throw new ConflictException("Credencial Kommo requer verificacao");
      await tx.kommoConnection.update({
        where: { id: connectionId },
        data: { status },
      });
      await this.audit(
        workspaceId,
        actorUserId,
        actorType,
        status === "active"
          ? "kommo.connection_resumed"
          : "kommo.connection_paused",
        connectionId,
        "success",
        tx,
      );
    });

    return this.get(workspaceId, connectionId);
  }

  async remove(
    workspaceId: string,
    connectionId: string,
    actorUserId: string,
    actorType: AuditActorType = "user",
  ) {
    await this.prisma.$transaction(async (tx: any) => {
      await this.lockConnection(tx, workspaceId, connectionId);
      const eventCount = await tx.kommoWebhookEvent.count({
        where: { connectionId, workspaceId },
      });
      if (eventCount)
        throw new ConflictException(
          "Conexao com eventos auditados nao pode ser removida; pause-a",
        );
      await tx.kommoConversionRule.deleteMany({
        where: { connectionId, workspaceId },
      });
      await tx.kommoPipelineCatalog.deleteMany({ where: { connectionId } });
      await tx.kommoConnection.delete({ where: { id: connectionId } });
      await this.audit(
        workspaceId,
        actorUserId,
        actorType,
        "kommo.connection_deleted",
        connectionId,
        "success",
        tx,
      );
    });
    return { status: "deleted" as const };
  }

  async rotateSecret(
    workspaceId: string,
    connectionId: string,
    actorUserId: string,
    actorType: AuditActorType = "user",
  ) {
    await this.connection(workspaceId, connectionId);
    const secret = this.newSecret();
    await this.prisma.$transaction(async (tx: any) => {
      await this.lockConnection(tx, workspaceId, connectionId);
      await tx.kommoConnection.update({
        where: { id: connectionId },
        data: {
          webhookSecretHash: this.hash(secret),
          webhookSecretVersion: { increment: 1 },
        },
      });
      await this.audit(
        workspaceId,
        actorUserId,
        actorType,
        "kommo.webhook_secret_rotated",
        connectionId,
        "success",
        tx,
      );
    });
    return {
      webhookUrl: this.webhookUrl(connectionId, secret),
      rotatedAt: new Date().toISOString(),
    };
  }

  async refreshCatalog(workspaceId: string, connectionId: string) {
    const connection = await this.connection(workspaceId, connectionId);
    try {
      const pipelines = await this.adapter.listPipelines(
        connection.accountOrigin,
        this.decrypt(connection),
      );
      const now = this.now();
      await this.prisma.$transaction(async (tx: any) => {
        const live = await this.lockConnection(tx, workspaceId, connectionId);
        if (!this.sameGeneration(connection, live)) return;
        await tx.kommoPipelineCatalog.updateMany({
          where: { connectionId },
          data: { available: false },
        });
        for (const pipeline of pipelines) {
          for (const status of pipeline.statuses) {
            await tx.kommoPipelineCatalog.upsert({
              where: {
                connectionId_pipelineId_statusId: {
                  connectionId,
                  pipelineId: pipeline.id,
                  statusId: status.id,
                },
              },
              create: {
                workspaceId,
                connectionId,
                pipelineId: pipeline.id,
                pipelineName: pipeline.name,
                pipelineSort: pipeline.sort,
                statusId: status.id,
                statusName: status.name,
                statusType: status.type,
                available: true,
                refreshedAt: now,
              },
              update: {
                pipelineName: pipeline.name,
                pipelineSort: pipeline.sort,
                statusName: status.name,
                statusType: status.type,
                available: true,
                refreshedAt: now,
              },
            });
          }
        }
        const unavailable = await tx.kommoPipelineCatalog.findMany({
          where: { connectionId, available: false },
          select: { pipelineId: true, statusId: true },
        });
        for (const stage of unavailable) {
          await tx.kommoConversionRule.updateMany({
            where: {
              connectionId,
              pipelineId: stage.pipelineId,
              statusId: stage.statusId,
            },
            data: { active: false },
          });
        }
        await tx.kommoConnection.update({
          where: { id: connectionId },
          data: {
            catalogState: "fresh",
            catalogRefreshedAt: now,
            credentialHealthy: true,
            lastErrorCode: null,
          },
        });
      });
    } catch (error) {
      const catalogState = connection.catalogRefreshedAt ? "stale" : "error";
      await this.prisma.kommoConnection.updateMany({
        where: this.generationWhere(connection),
        data: {
          catalogState,
          credentialHealthy: [
            "kommo_unauthorized",
            "credential_decrypt_failed",
          ].includes(this.code(error))
            ? false
            : connection.credentialHealthy,
          lastErrorCode: this.code(error),
        },
      });
      throw error;
    }
    return this.get(workspaceId, connectionId);
  }

  async checkHealth(workspaceId: string, connectionId: string) {
    const connection = await this.connection(workspaceId, connectionId);
    try {
      const account = await this.adapter.verify(
        connection.accountOrigin,
        this.decrypt(connection),
      );
      if (account.id !== connection.verifiedAccountId) {
        await this.prisma.kommoConnection.updateMany({
          where: this.generationWhere(connection),
          data: {
            status: "blocked",
            credentialHealthy: false,
            lastErrorCode: "account_mismatch",
          },
        });
        return { healthy: false, code: "account_mismatch" };
      }
      await this.prisma.kommoConnection.updateMany({
        where: this.generationWhere(connection),
        data: { credentialHealthy: true, lastErrorCode: null },
      });
      const live = await this.connection(workspaceId, connectionId);
      return this.sameGeneration(connection, live)
        ? { healthy: true, code: null }
        : { healthy: false, code: "credential_generation_mismatch" };
    } catch (error) {
      const code = this.code(error);
      await this.prisma.kommoConnection.updateMany({
        where: this.generationWhere(connection),
        data: {
          credentialHealthy: false,
          lastErrorCode: code,
          ...(code === "kommo_unauthorized" ? { status: "blocked" } : {}),
        },
      });
      return { healthy: false, code };
    }
  }

  async createRule(
    workspaceId: string,
    connectionId: string,
    actorUserId: string,
    input: KommoConversionRuleCreateInputDto,
    actorType: AuditActorType = "user",
  ) {
    const rule = await this.prisma.$transaction(async (tx: any) => {
      await this.lockConnection(tx, workspaceId, connectionId);
      await this.assertCatalogStage(
        connectionId,
        input.pipelineId,
        input.statusId,
        tx,
      );
      const rule = await tx.kommoConversionRule.create({
        data: { workspaceId, connectionId, ...this.ruleData(input) },
      });
      await this.audit(
        workspaceId,
        actorUserId,
        actorType,
        "kommo.rule_created",
        rule.id,
        "success",
        tx,
      );
      return rule;
    });

    return this.ruleDto(rule);
  }

  async updateRule(
    workspaceId: string,
    connectionId: string,
    ruleId: string,
    actorUserId: string,
    input: KommoConversionRuleUpdateInputDto,
    actorType: AuditActorType = "user",
  ) {
    const rule = await this.prisma.$transaction(async (tx: any) => {
      await this.lockConnection(tx, workspaceId, connectionId);
      const current = await tx.kommoConversionRule.findFirst({
        where: { id: ruleId, connectionId, workspaceId },
      });
      if (!current) throw new NotFoundException("Regra Kommo nao encontrada");
      // Never merge an ORM row into a strict request schema: it carries id,
      // workspace and timestamp columns that are not part of this contract.
      const candidate = {
        name: current.name,
        pipelineId: current.pipelineId,
        statusId: current.statusId,
        eventName: current.eventName,
        mode: current.mode,
        active: current.active,
        valueMode: current.valueMode,
        fixedValueCents: current.fixedValueCents,
        currency: current.currency ?? undefined,
        contentName: current.contentName,
        ...input,
      };
      if (input.eventName && !conversionEventCarriesValue(input.eventName)) {
        if (input.valueMode === undefined) candidate.valueMode = "lead_price";
        if (input.fixedValueCents === undefined)
          candidate.fixedValueCents = null;
        if (input.currency === undefined) candidate.currency = undefined;
        if (input.contentName === undefined) candidate.contentName = null;
      }
      const parsed = kommoConversionRuleCreateInputSchema.safeParse(candidate);
      if (!parsed.success) throw new BadRequestException(hasRuleCurrencyIssue(parsed.error) ? RULE_CURRENCY_INVALID_MESSAGE : "Payload invalido");
      if (input.pipelineId !== undefined || input.statusId !== undefined) {
        await this.assertCatalogStage(
          connectionId,
          parsed.data.pipelineId,
          parsed.data.statusId,
          tx,
        );
      }
      const rule = await tx.kommoConversionRule.update({
        where: { id: ruleId },
        data: this.ruleData(parsed.data),
      });
      await this.audit(
        workspaceId,
        actorUserId,
        actorType,
        "kommo.rule_updated",
        rule.id,
        "success",
        tx,
      );
      return rule;
    });

    return this.ruleDto(rule);
  }

  async deleteRule(
    workspaceId: string,
    connectionId: string,
    ruleId: string,
    actorUserId: string,
    actorType: AuditActorType = "user",
  ) {
    const result = await this.prisma.$transaction(async (tx: any) => {
      await this.lockConnection(tx, workspaceId, connectionId);
      const result = await tx.kommoConversionRule.deleteMany({
        where: { id: ruleId, connectionId, workspaceId },
      });
      if (!result.count)
        throw new NotFoundException("Regra Kommo nao encontrada");
      await this.audit(
        workspaceId,
        actorUserId,
        actorType,
        "kommo.rule_deleted",
        ruleId,
        "success",
        tx,
      );
      return result;
    });

    return { status: "deleted" as const };
  }

  async receive(
    connectionId: string,
    secret: unknown,
    events: KommoStageEvent[] | null,
  ) {
    const connection = await this.prisma.kommoConnection.findUnique({
      where: { id: connectionId },
    });
    if (
      !connection ||
      !this.matches(secret, connection.webhookSecretHash) ||
      !events ||
      !connection.verifiedAccountId ||
      connection.status !== "active"
    ) {
      throw new NotFoundException("Webhook nao encontrado");
    }
    if (
      events.some(
        (event) =>
          event.accountId !== connection.verifiedAccountId ||
          (connection.accountSubdomain &&
            event.accountSubdomain &&
            event.accountSubdomain !== connection.accountSubdomain),
      )
    ) {
      throw new NotFoundException("Webhook nao encontrado");
    }

    let accepted = 0;
    for (const stageEvent of events) {
      const deliveryKey = kommoDeliveryKey(connectionId, stageEvent);
      let record: any;
      try {
        record = await this.prisma.kommoWebhookEvent.create({
          data: {
            workspaceId: connection.workspaceId,
            connectionId,
            verifiedAccountId: connection.verifiedAccountId,
            credentialGeneration: connection.credentialGeneration ?? 1,
            deliveryKey,
            dealId: stageEvent.dealId,
            pipelineId: stageEvent.pipelineId,
            statusId: stageEvent.statusId,
            oldStatusId: stageEvent.oldStatusId,
            eventOccurredAt: stageEvent.occurredAt,
            eventPriceCents: stageEvent.priceCents,
            eventPricePresent: stageEvent.pricePresent,
          },
        });
      } catch (error) {
        if (!this.unique(error)) throw error;
        record = await this.prisma.kommoWebhookEvent.findUnique({
          where: { deliveryKey },
        });
        if (!record || !this.isRecoverable(record.status)) continue;
      }
      try {
        await this.enqueueRecord(record);
      } catch (error) {
        // Persistence succeeded but publication did not. Keep the event
        // recoverable; a repeated delivery first reaches this same record.
        await this.prisma.kommoWebhookEvent.updateMany({
          where: {
            id: record.id,
            revision: record.revision,
            status: record.status,
            leaseToken: null,
          },
          data: {
            status: "failed",
            errorCode: "enqueue_failed",
            jobId: null,
            revision: { increment: 1 },
            nextAttemptAt: this.now(),
          },
        });
        throw error;
      }
      accepted += 1;
    }
    return { status: "accepted" as const, accepted };
  }

  async reprocess(
    workspaceId: string,
    eventId: string,
    actorUserId?: string,
    actorType: AuditActorType = "user",
  ) {
    if (!actorUserId)
      throw new BadRequestException("Ator de auditoria requerido");
    const current = await this.prisma.$transaction(async (tx: any) => {
      const event = await tx.kommoWebhookEvent.findFirst({
        where: { id: eventId, workspaceId },
      });
      if (!event) throw new NotFoundException("Evento Kommo nao encontrado");
      if (
        event.status === "processing" &&
        event.leaseExpiresAt &&
        event.leaseExpiresAt > this.now()
      )
        throw new ConflictException("Evento em processamento");
      await this.lockConnection(tx, workspaceId, event.connectionId);
      const intents = await tx.kommoConversionDedupe.findMany({
        where: { workspaceId, sourceEventId: eventId },
      });
      let unknown = false;
      for (const intent of intents) {
        const log = await tx.conversionEventLog.findFirst({
          where: { id: intent.conversionEventLogId, workspaceId },
        });
        if (
          (await settleKommoSenderOutcome(tx, intent, log)) ===
          "delivery_unknown"
        )
          unknown = true;
      }
      if (unknown) {
        await this.audit(
          workspaceId,
          actorUserId,
          actorType,
          "kommo.event_reprocess_requested",
          eventId,
          "blocked",
          tx,
        );
        return null;
      }
      await tx.kommoConversionDedupe.updateMany({
        where: {
          workspaceId,
          sourceEventId: eventId,
          publicationStatus: { in: ["publication_failed", "revoked"] },
        },
        data: {
          publicationStatus: "publication_pending",
          publicationAttempts: 0,
          publicationNextAttemptAt: this.now(),
        },
      });
      // Identity/configuration blockers may be reconsidered manually. Committed
      // conversions retain their intent; generation mismatches still fail closed.
      const reset = await tx.kommoWebhookEvent.updateMany({
        where: {
          id: event.id,
          workspaceId,
          revision: event.revision,
          status: event.status,
        },
        data: {
          status: "accepted",
          attempts: 0,
          nextAttemptAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          revision: { increment: 1 },
        },
      });
      if (!reset.count)
        throw new ConflictException("Evento alterado; tente novamente");
      const current = await tx.kommoWebhookEvent.findFirst({
        where: { id: eventId, workspaceId },
      });

      await this.audit(
        workspaceId,
        actorUserId,
        actorType,
        "kommo.event_reprocess_requested",
        eventId,
        "success",
        tx,
      );
      return current;
    });
    if (!current)
      return {
        status: "blocked" as const,
        errorCode: KOMMO_DELIVERY_UNKNOWN,
        errorMessage: KOMMO_DELIVERY_UNKNOWN_MESSAGE,
      };
    await this.enqueueRecord(current);
    return { status: "queued" as const };
  }

  async recover(
    workspaceId: string,
    connectionId: string,
    actorUserId: string,
    actorType: AuditActorType = "user",
  ) {
    await this.prisma.$transaction(async (tx: any) => {
      await this.lockConnection(tx, workspaceId, connectionId);
      await this.audit(
        workspaceId,
        actorUserId,
        actorType,
        "kommo.recovery_requested",
        connectionId,
        "requested",
        tx,
      );
    });
    const queued = await this.reconcileRecoverableEvents({
      workspaceId,
      connectionId,
    });
    return { queued };
  }

  async process(eventId: string, workspaceId: string) {
    const stored = await this.prisma.kommoWebhookEvent.findFirst({
      where: { id: eventId, workspaceId },
      include: { connection: true },
    });
    if (!stored) throw new NotFoundException("Evento Kommo nao encontrado");
    if (
      ["observed", "duplicate", "blocked", "sent", "processed"].includes(
        stored.status,
      )
    )
      return { status: stored.status, errorCode: stored.errorCode };
    if (!(await this.licenseAllows()))
      return { status: stored.status, errorCode: "license_locked" };
    const now = this.now();
    const leaseToken = randomUUID();
    const claim = await this.prisma.kommoWebhookEvent.updateMany({
      where: {
        id: eventId,
        workspaceId,
        revision: stored.revision,
        OR: [
          {
            status: {
              in: [
                "accepted",
                "queued",
                "failed",
                "publication_pending",
                "materialized",
              ],
            },
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          },
          {
            status: "processing",
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
          },
        ],
      },
      data: {
        status: "processing",
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
        revision: { increment: 1 },
        attempts: { increment: 1 },
        errorCode: null,
      },
    });
    if (!claim.count) throw new Error("kommo_processing_lease_busy");
    const event = { ...stored, leaseToken, attempts: stored.attempts + 1 };
    try {
      if (!(await this.licenseAllows()))
        return this.releaseProcessingForLicense(event, stored.status);
      // Discover committed work before touching credentials/catalog/rules or
      // remote identity. Resume even after any of those inputs have changed.
      const committed = await this.prisma.kommoConversionDedupe.findMany({
        where: { workspaceId, sourceEventId: eventId },
      });
      let results: any[] = Array.isArray(stored.results)
        ? [...stored.results]
        : [];
      if (committed.length) {
        for (const intent of committed) await this.publishIntent(intent);
        return this.finishResults(event, results);
      }
      if (!this.eventMatchesConnection(event, event.connection))
        return this.complete(
          event,
          "blocked",
          "credential_generation_mismatch",
        );
      if (
        event.connection.status !== "active" ||
        !event.connection.credentialHealthy
      )
        return this.complete(event, "blocked", "connection_blocked");
      const catalog = await this.prisma.kommoPipelineCatalog.findUnique({
        where: {
          connectionId_pipelineId_statusId: {
            connectionId: event.connectionId,
            pipelineId: event.pipelineId,
            statusId: event.statusId,
          },
        },
      });
      if (!this.catalogFresh(event.connection) || !catalog?.available)
        return this.complete(
          event,
          "blocked",
          "stage_unavailable_or_catalog_stale",
        );
      const rules = await this.prisma.kommoConversionRule.findMany({
        where: {
          workspaceId,
          connectionId: event.connectionId,
          pipelineId: event.pipelineId,
          statusId: event.statusId,
          active: true,
        },
      });
      if (!rules.length)
        return this.complete(event, "observed", "stage_not_configured");
      // "Moeda das conversões": regra sem moeda (ou com código fora da
      // lista, gravado antes da Fase 5.1) herda a do workspace.
      const workspaceCurrency = await loadWorkspaceConversionCurrency(
        this.prisma,
        workspaceId,
      );
      const resolved = await this.resolveLead(
        event.connection,
        event.dealId,
        workspaceId,
      );
      // Remote enrichment can outlive an allowed decision. Never turn its
      // result into materialized state after a later lock.
      if (!(await this.licenseAllows()))
        return this.releaseProcessingForLicense(event, stored.status);
      if ("error" in resolved) {
        if (this.retryable(resolved.error))
          return this.retryEvent(event, resolved.error);
        return this.complete(
          event,
          "blocked",
          resolved.error,
          rules.map((rule: any) => ({
            ruleId: rule.id,
            eventName: rule.eventName,
            status: "blocked",
            errorCode: resolved.error,
          })),
        );
      }
      // Commit the whole matched rule set, its outcomes and immutable intents
      // atomically, so a crash cannot lose later canonical events in this batch.
      await this.prisma.$transaction(async (tx: any) => {
        await this.lockConnection(tx, workspaceId, event.connectionId);
        await tx.$queryRaw`SELECT "id" FROM "KommoWebhookEvent" WHERE "id" = ${event.id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
        results = [];
        for (const rule of rules) {
          const result: any = {
            ruleId: rule.id,
            eventName: rule.eventName,
            status: "observed",
            errorCode: null,
            evaluationComplete: true,
          };
          if (rule.mode === "production") {
            const value = this.valueFor(rule, event, workspaceCurrency);
            if ("error" in value) {
              result.status = "blocked";
              result.errorCode = value.error;
            } else {
              const conversion = resolved.ctwa
                ? await this.materializeCtwa(
                    tx,
                    event,
                    rule,
                    resolved.lead,
                    resolved.ctwa,
                    value,
                  )
                : await this.materialize(
                    event,
                    event.connection,
                    rule,
                    resolved.lead,
                    resolved.route,
                    resolved.destination,
                    value,
                    tx,
                  );
              if (conversion.status === "license_locked")
                throw new Error("kommo_license_locked");
              const recorded = conversion as {
                conversionEventLogId: string;
                status: string;
                deliveryStatus: string;
              };
              result.status =
                recorded.status === "created" ? "materialized" : "duplicate";
              result.conversionEventLogId = recorded.conversionEventLogId;
              result.publicationStatus =
                recorded.deliveryStatus === "ready_to_send"
                  ? "publication_pending"
                  : recorded.deliveryStatus;
            }
          }
          results.push(result);
        }
        const updated = await tx.kommoWebhookEvent.updateMany({
          where: this.leaseWhere(event),
          data: {
            results,
            matchedLeadId: resolved.lead.id,
            leaseExpiresAt: new Date(this.now().getTime() + this.leaseMs),
          },
        });
        if (!updated.count) throw new Error("kommo_processing_lease_lost");
      });
      for (const result of results) {
        if (!result.conversionEventLogId) continue;
        const intent = await this.prisma.kommoConversionDedupe.findFirst({
          where: {
            workspaceId,
            conversionEventLogId: result.conversionEventLogId,
          },
        });
        result.publicationStatus = await this.publishIntent(intent);
      }
      return this.finishResults(event, results);
    } catch (error) {
      const code = this.code(error);
      if (code === "kommo_license_locked")
        return this.releaseProcessingForLicense(event, stored.status);
      if (
        [
          "credential_generation_mismatch",
          "trigger_authorization_changed",
          "channel_authorization_changed",
          "lead_authorization_changed",
          "semantic_identity_conflict",
        ].includes(code)
      )
        return this.complete(event, "blocked", code);
      await this.retryEvent(event, code);
      throw error;
    }
  }

  private async releaseProcessingForLicense(event: any, priorStatus: string) {
    const status = priorStatus === "processing" ? "accepted" : priorStatus;
    await this.prisma.kommoWebhookEvent.updateMany({
      where: this.leaseWhere(event),
      data: { status, leaseToken: null, leaseExpiresAt: null },
    });
    return { status, errorCode: "license_locked" };
  }

  private async finishResults(event: any, results: any[]) {
    const intents = await this.prisma.kommoConversionDedupe.findMany({
      where: { workspaceId: event.workspaceId, sourceEventId: event.id },
    });
    for (const intent of intents) {
      const result = results.find(
        (item) => item.conversionEventLogId === intent.conversionEventLogId,
      );
      if (result) result.publicationStatus = intent.publicationStatus;
    }
    const blocked = results.find((result) => result.status === "blocked");
    const statuses = results
      .map((result) => result.publicationStatus)
      .filter(Boolean);
    let status = "observed";
    if (results.some((result) => result.status === "duplicate"))
      status = "duplicate";
    if (blocked) status = "blocked";
    if (results.some((result) => result.status === "materialized"))
      status = "materialized";
    if (statuses.includes("revoked") || statuses.includes("publication_failed"))
      status = "blocked";
    if (statuses.length && statuses.every((item) => item === "sent"))
      status = "sent";
    if (statuses.includes("queued")) status = "queued";
    if (statuses.includes("publication_pending"))
      status = "publication_pending";
    if (
      results.length &&
      results.every((result) => result.status === "duplicate")
    )
      status = "duplicate";
    if (statuses.includes("delivery_unknown")) status = "blocked";
    // Preserve mixed blocked reasons and durable publication failure reasons.
    return this.complete(
      event,
      status,
      (statuses.includes("delivery_unknown") ? KOMMO_DELIVERY_UNKNOWN : null) ??
        blocked?.errorCode ??
        intents.find((intent) => intent.publicationErrorCode)
          ?.publicationErrorCode ??
        null,
      results,
    );
  }

  private async materialize(
    event: any,
    connection: any,
    rule: any,
    lead: any,
    route: any,
    destination: {
      reportingAccountId: string;
      conversionDestinationId: string;
    },
    value: { cents: number | null; currency: string | null },
    transaction?: any,
  ) {
    if (!(await this.licenseAllows()))
      return { status: "license_locked" as const };
    const dedupeKey = `kommo:${event.workspaceId}:${event.verifiedAccountId}:${event.dealId}:${rule.eventName}`;
    try {
      const execute = async (tx: any) => {
        const live = await this.lockConnection(
          tx,
          event.workspaceId,
          connection.id,
        );
        await tx.$queryRaw`SELECT "id" FROM "KommoWebhookEvent" WHERE "id" = ${event.id} AND "workspaceId" = ${event.workspaceId} FOR UPDATE`;
        const active = await tx.kommoWebhookEvent.findFirst({
          where: this.leaseWhere(event),
        });
        if (!active) throw new Error("kommo_processing_lease_lost");
        if (
          !this.eventMatchesConnection(event, live) ||
          live.status !== "active" ||
          !live.credentialHealthy
        )
          throw new Error("credential_generation_mismatch");
        const stage = await tx.kommoPipelineCatalog.findUnique({
          where: {
            connectionId_pipelineId_statusId: {
              connectionId: live.id,
              pipelineId: event.pipelineId,
              statusId: event.statusId,
            },
          },
        });
        const liveRule = await tx.kommoConversionRule.findFirst({
          where: {
            id: rule.id,
            workspaceId: event.workspaceId,
            connectionId: live.id,
            active: true,
            mode: "production",
            updatedAt: rule.updatedAt,
          },
        });
        if (!this.catalogFresh(live) || !stage?.available || !liveRule)
          throw new Error("trigger_authorization_changed");
        const intent: KommoPublicationIntent = {
          connectionId: live.id,
          routeId: route.id,
          channelId: route.channel.id,
          // Uazapi: the lead's instance (matched by the channel policy);
          // official-API numbers have none.
          whatsappInstanceId: route.channel.whatsappInstanceId ?? null,
          destinationId: route.metaConversionDestinationId,
          pixelId: route.metaConversionDestination.pixelId,
          pageId: route.metaConversionDestination.pageId,
          businessConnectionId: route.metaBusinessConnectionId,
          reportingAccountId: route.metaReportingAccountId,
          eventId: dedupeKey,
        };
        const captured = await tx.lead.findFirst({
          where: {
            id: lead.id,
            workspaceId: event.workspaceId,
            phoneHash: lead.phoneHash,
            ...(intent.whatsappInstanceId
              ? { whatsappInstanceId: intent.whatsappInstanceId }
              : {}),
          },
        });
        const currentDestination = await this.resolveLeadDestination(
          tx,
          event.workspaceId,
          lead,
        );
        if (
          !captured ||
          captured.adId !== lead.adId ||
          captured.ctwaClid !== lead.ctwaClid ||
          currentDestination?.reportingAccountId !==
            destination.reportingAccountId ||
          currentDestination?.conversionDestinationId !==
            destination.conversionDestinationId ||
          destination.reportingAccountId !== intent.reportingAccountId ||
          destination.conversionDestinationId !== intent.destinationId
        )
          throw new Error("lead_authorization_changed");
        if (!(await kommoPublicationAuthorized(tx, event.workspaceId, intent)))
          throw new Error("channel_authorization_changed");
        const existing = await tx.kommoConversionDedupe.findUnique({
          where: {
            workspaceId_verifiedAccountId_dealId_eventName: {
              workspaceId: event.workspaceId,
              verifiedAccountId: event.verifiedAccountId,
              dealId: event.dealId,
              eventName: rule.eventName,
            },
          },
        });
        if (existing?.conversionEventLogId)
          return {
            conversionEventLogId: existing.conversionEventLogId,
            status: "duplicate",
            deliveryStatus: existing.publicationStatus,
          };
        // All transactional authorization reads have completed. A decision
        // here is immediately before the first Kommo materialization write.
        await this.assertLicenseAllows();
        const fence = await tx.kommoConversionDedupe.create({
          data: {
            workspaceId: event.workspaceId,
            verifiedAccountId: event.verifiedAccountId,
            dealId: event.dealId,
            eventName: rule.eventName,
            sourceEventId: event.id,
          },
        });
        const priorLog = await tx.conversionEventLog.findUnique({
          where: { dedupeKey },
        });
        if (
          priorLog &&
          (priorLog.sourceTrigger !== "kommo_stage" ||
            priorLog.workspaceId !== event.workspaceId ||
            priorLog.eventName !== rule.eventName ||
            priorLog.leadId !== lead.id)
        )
          throw new Error("semantic_identity_conflict");
        const recorded = await this.conversions.recordExternalConversion(
          {
            workspaceId: event.workspaceId,
            sourceEventId: event.id,
            sourceTrigger: "kommo_stage",
            eventName: rule.eventName as ConversionEventNameDto,
            eventId: dedupeKey,
            dedupeKey,
            leadId: lead.id,
            phoneHash: lead.phoneHash,
            businessSource: "paid",
            campaignId: lead.campaignId,
            adSetId: lead.adSetId,
            adId: lead.adId,
            ctwaClid: lead.ctwaClid,
            metaAccountId: route.metaReportingAccount.adAccountId,
            metaBusinessConnectionId: intent.businessConnectionId,
            metaConversionDestinationId: intent.destinationId,
            valueCents: value.cents,
            valueSource: value.cents === null ? null : "actual",
            currency: value.currency,
            contentName: rule.contentName,
            eventOccurredAt: event.eventOccurredAt,
            sourcePayload: {
              provider: "kommo",
              verifiedAccountId: event.verifiedAccountId,
              dealId: event.dealId,
              pipelineId: event.pipelineId,
              statusId: event.statusId,
              oldStatusId: event.oldStatusId,
              eventPriceCents: event.eventPriceCents,
              eventPricePresent: event.eventPricePresent,
            },
          },
          tx,
        );
        // recordExternalConversion has its own pre-log barrier. Recheck once
        // more before publishing the intent; a failure rolls this whole
        // transaction back, including its fence and canonical log.
        await this.assertLicenseAllows();
        await tx.kommoConversionDedupe.update({
          where: { id: fence.id },
          data: {
            conversionEventLogId: recorded.conversionEventLogId,
            publicationIntent: intent,
            publicationStatus:
              recorded.deliveryStatus === "ready_to_send"
                ? "publication_pending"
                : "materialized",
            publicationNextAttemptAt: this.now(),
          },
        });
        return recorded;
      };
      return transaction
        ? await execute(transaction)
        : await this.prisma.$transaction(execute);
    } catch (error) {
      if (transaction || !this.unique(error)) throw error;
      const existing = await this.prisma.kommoConversionDedupe.findUnique({
        where: {
          workspaceId_verifiedAccountId_dealId_eventName: {
            workspaceId: event.workspaceId,
            verifiedAccountId: event.verifiedAccountId,
            dealId: event.dealId,
            eventName: rule.eventName,
          },
        },
      });
      if (!existing?.conversionEventLogId)
        throw new Error("dedupe_recovery_failed");
      return {
        conversionEventLogId: existing.conversionEventLogId,
        status: "duplicate" as const,
        deliveryStatus: existing.publicationStatus,
      };
    }
  }

  /**
   * CTWA lead: canonical conversion carrying the proven page/pixel destination
   * of its number (Meta CAPI needs only pixel + page + ctwa_clid); the
   * canonical CTWA sender delivers it. Runs inside the process transaction,
   * under the same fences as the route path.
   */
  private async materializeCtwa(
    tx: any,
    event: any,
    rule: any,
    lead: any,
    proof: AuthorizedCtwaDestination,
    value: { cents: number | null; currency: string | null },
  ) {
    if (!(await this.licenseAllows()))
      return { status: "license_locked" as const };
    const dedupeKey = `kommo:${event.workspaceId}:${event.verifiedAccountId}:${event.dealId}:${rule.eventName}`;
    const live = await this.lockConnection(
      tx,
      event.workspaceId,
      event.connectionId,
    );
    await tx.$queryRaw`SELECT "id" FROM "KommoWebhookEvent" WHERE "id" = ${event.id} AND "workspaceId" = ${event.workspaceId} FOR UPDATE`;
    const active = await tx.kommoWebhookEvent.findFirst({
      where: this.leaseWhere(event),
    });
    if (!active) throw new Error("kommo_processing_lease_lost");
    if (
      !this.eventMatchesConnection(event, live) ||
      live.status !== "active" ||
      !live.credentialHealthy
    )
      throw new Error("credential_generation_mismatch");
    const stage = await tx.kommoPipelineCatalog.findUnique({
      where: {
        connectionId_pipelineId_statusId: {
          connectionId: live.id,
          pipelineId: event.pipelineId,
          statusId: event.statusId,
        },
      },
    });
    const liveRule = await tx.kommoConversionRule.findFirst({
      where: {
        id: rule.id,
        workspaceId: event.workspaceId,
        connectionId: live.id,
        active: true,
        mode: "production",
        updatedAt: rule.updatedAt,
      },
    });
    if (!this.catalogFresh(live) || !stage?.available || !liveRule)
      throw new Error("trigger_authorization_changed");
    const captured = await tx.lead.findFirst({
      where: {
        id: lead.id,
        workspaceId: event.workspaceId,
        phoneHash: lead.phoneHash,
      },
    });
    if (!captured || !lead.ctwaClid || captured.ctwaClid !== lead.ctwaClid)
      throw new Error("lead_authorization_changed");
    // Re-checked on the locked connection row: an unbind committed after the
    // lead was resolved must prevent the conversion, as on the route path.
    if (
      proof.workspaceId !== event.workspaceId ||
      !(await crmCtwaChannelBound(
        tx,
        event.workspaceId,
        live.allowedChannelRouteIds ?? [],
        proof.channelId,
      ))
    )
      throw new Error("channel_authorization_changed");
    const existing = await tx.kommoConversionDedupe.findUnique({
      where: {
        workspaceId_verifiedAccountId_dealId_eventName: {
          workspaceId: event.workspaceId,
          verifiedAccountId: event.verifiedAccountId,
          dealId: event.dealId,
          eventName: rule.eventName,
        },
      },
    });
    if (existing?.conversionEventLogId)
      return {
        conversionEventLogId: existing.conversionEventLogId,
        status: "duplicate",
        deliveryStatus: existing.publicationStatus,
      };
    // All transactional authorization reads have completed: last decision
    // before the first Kommo materialization write (same as the route path).
    await this.assertLicenseAllows();
    const fence = await tx.kommoConversionDedupe.create({
      data: {
        workspaceId: event.workspaceId,
        verifiedAccountId: event.verifiedAccountId,
        dealId: event.dealId,
        eventName: rule.eventName,
        sourceEventId: event.id,
      },
    });
    const priorLog = await tx.conversionEventLog.findUnique({
      where: { dedupeKey },
    });
    if (priorLog) throw new Error("semantic_identity_conflict");
    // recordExternalConversion re-verifies the destination (ctwaIntentAuthorized).
    const recorded = await this.conversions.recordExternalConversion(
      {
        ctwaDestination: proof,
        workspaceId: event.workspaceId,
        sourceEventId: event.id,
        sourceTrigger: "kommo_stage",
        eventName: rule.eventName as ConversionEventNameDto,
        eventId: dedupeKey,
        dedupeKey,
        leadId: lead.id,
        phoneHash: lead.phoneHash,
        businessSource: "paid",
        adId: null,
        ctwaClid: lead.ctwaClid,
        valueCents: value.cents,
        valueSource: value.cents === null ? null : "actual",
        currency: value.currency,
        contentName: rule.contentName,
        eventOccurredAt: event.eventOccurredAt,
        sourcePayload: {
          provider: "kommo",
          processingMode: KOMMO_CTWA_PROCESSING_MODE,
          channelId: proof.channelId,
          connectionId: proof.connectionId,
          kommoConnectionId: live.id,
          verifiedAccountId: event.verifiedAccountId,
          dealId: event.dealId,
          pipelineId: event.pipelineId,
          statusId: event.statusId,
          oldStatusId: event.oldStatusId,
          eventPriceCents: event.eventPriceCents,
          eventPricePresent: event.eventPricePresent,
        },
      },
      tx,
    );
    // recordExternalConversion has its own pre-log barrier. Recheck once more
    // before publishing the intent; a failure rolls the transaction back.
    await this.assertLicenseAllows();
    const intent: KommoCtwaPublicationIntent = {
      kind: "ctwa_destination",
      connectionId: live.id,
      channelId: proof.channelId,
      inboundConnectionId: proof.connectionId,
      destinationId: proof.destinationId,
      eventId: dedupeKey,
    };
    await tx.kommoConversionDedupe.update({
      where: { id: fence.id },
      data: {
        conversionEventLogId: recorded.conversionEventLogId,
        publicationIntent: intent,
        publicationStatus:
          recorded.deliveryStatus === "ready_to_send"
            ? "publication_pending"
            : "materialized",
        publicationNextAttemptAt: this.now(),
      },
    });
    return recorded;
  }

  /**
   * Page/pixel conversions are delivered by the canonical CTWA sender, whose
   * own ready_to_send -> dispatching claim is the single-send fence. The
   * outbox only enqueues and mirrors the conversion log state.
   */
  private async publishCtwaIntent(
    intent: any,
    leaseWhere: () => Record<string, unknown>,
    now: Date,
  ): Promise<string> {
    const settle = async (status: string, data: Record<string, unknown>) => {
      const written = await this.prisma.kommoConversionDedupe.updateMany({
        where: {
          ...leaseWhere(),
          publicationStatus: { in: ["publication_pending", "queued"] },
        },
        data: {
          publicationStatus: status,
          publicationLeaseToken: null,
          publicationLeaseExpiresAt: null,
          ...data,
        },
      });
      if (written.count) return status;
      const current = await this.prisma.kommoConversionDedupe.findFirst({
        where: { id: intent.id, workspaceId: intent.workspaceId },
      });
      return current?.publicationStatus ?? status;
    };
    try {
      const log = await this.prisma.conversionEventLog.findFirst({
        where: {
          id: intent.conversionEventLogId,
          workspaceId: intent.workspaceId,
          sourceTrigger: "kommo_stage",
        },
        select: { status: true },
      });
      let status: string;
      if (log?.status === "sent") status = "sent";
      else if (log?.status === "ready_to_send") {
        if (!(await this.licenseAllows())) {
          await this.releasePublicationLease(
            intent,
            String(leaseWhere().publicationLeaseToken),
          );
          return intent.publicationStatus;
        }
        await this.conversionQueue.retrySend(
          intent.conversionEventLogId,
          intent.workspaceId,
        );
        status = "queued";
      } else if (
        log?.status === "dispatching" ||
        log?.status === "delivery_unknown"
      )
        status = "delivery_unknown";
      else status = "publication_failed";
      return await settle(status, {
        publicationErrorCode:
          status === "delivery_unknown"
            ? KOMMO_DELIVERY_UNKNOWN
            : status === "publication_failed"
              ? "sender_not_ready"
              : null,
        publicationNextAttemptAt: new Date(now.getTime() + 30_000),
      });
    } catch {
      const attempts = intent.publicationAttempts + 1;
      return settle(
        attempts >= this.maxAttempts
          ? "publication_failed"
          : "publication_pending",
        {
          publicationAttempts: attempts,
          publicationErrorCode: "conversion_enqueue_failed",
          publicationNextAttemptAt: new Date(
            now.getTime() + Math.min(30_000 * 2 ** attempts, 900_000),
          ),
        },
      );
    }
  }

  private async publishIntent(intent: any): Promise<string> {
    if (!intent?.publicationIntent || !intent.conversionEventLogId)
      throw new Error("publication_intent_missing");
    if (!(await this.licenseAllows())) return intent.publicationStatus;
    if (
      kommoCtwaIntent(intent.publicationIntent) &&
      intent.publicationStatus === "delivery_unknown"
    ) {
      // Only the canonical CTWA sender's confirmed delivery lifts the fence.
      const log = await this.prisma.conversionEventLog.findFirst({
        where: {
          id: intent.conversionEventLogId,
          workspaceId: intent.workspaceId,
          sourceTrigger: "kommo_stage",
        },
        select: { status: true },
      });
      if (log?.status !== "sent") return "delivery_unknown";
      await this.prisma.kommoConversionDedupe.updateMany({
        where: {
          id: intent.id,
          workspaceId: intent.workspaceId,
          publicationStatus: "delivery_unknown",
        },
        data: { publicationStatus: "sent", publicationErrorCode: null },
      });
      return "sent";
    }
    if (intent.publicationStatus === "delivery_unknown") {
      const outcome = await this.conversions.prepareKommoSenderRetry(
        intent.conversionEventLogId,
        intent.workspaceId,
      );
      // Only confirmed delivery can lift an unknown fence; never enqueue here.
      return outcome === "sent" ? "sent" : "delivery_unknown";
    }
    const now = this.now();
    const token = randomUUID();
    if (
      ["sent", "materialized", "revoked", "publication_failed"].includes(
        intent.publicationStatus,
      )
    )
      return intent.publicationStatus;
    const claim = await this.prisma.kommoConversionDedupe.updateMany({
      where: {
        id: intent.id,
        publicationStatus: { in: ["publication_pending", "queued"] },
        AND: [
          {
            OR: [
              { publicationNextAttemptAt: null },
              { publicationNextAttemptAt: { lte: now } },
            ],
          },
          {
            OR: [
              { publicationLeaseToken: null },
              { publicationLeaseExpiresAt: { lte: now } },
            ],
          },
        ],
      },
      data: {
        publicationLeaseToken: token,
        publicationLeaseExpiresAt: new Date(now.getTime() + this.leaseMs),
      },
    });
    if (!claim.count) {
      const current = await this.prisma.kommoConversionDedupe.findFirst({
        where: { id: intent.id, workspaceId: intent.workspaceId },
      });
      return current?.publicationStatus ?? intent.publicationStatus;
    }
    // A sweep snapshot may be old by the time it reaches this row. Count
    // retries from the claimed version, never from an earlier publisher's read.
    const owned = await this.prisma.kommoConversionDedupe.findFirst({
      where: { id: intent.id, publicationLeaseToken: token },
    });
    if (!owned) return "publication_pending";
    intent = owned;
    const leaseWhere = () => ({
      id: intent.id,
      publicationLeaseToken: token,
      publicationLeaseExpiresAt: { gt: this.now() },
    });
    if (kommoCtwaIntent(intent.publicationIntent))
      return this.publishCtwaIntent(intent, leaseWhere, now);
    try {
      const senderStatus = await this.conversions.prepareKommoSenderRetry(
        intent.conversionEventLogId,
        intent.workspaceId,
      );
      if (senderStatus === "license_locked") {
        await this.releasePublicationLease(intent, token);
        return intent.publicationStatus;
      }
      let status: string;
      if (senderStatus === "sent") status = "sent";
      else if (senderStatus === "revoked") status = "revoked";
      else if (senderStatus === "delivery_unknown") status = "delivery_unknown";
      else if (senderStatus === "ready_to_send") {
        if (!(await this.licenseAllows())) {
          await this.releasePublicationLease(intent, token);
          return intent.publicationStatus;
        }
        await this.conversionQueue.retrySend(
          intent.conversionEventLogId,
          intent.workspaceId,
        );
        status = "queued";
      } else status = "publication_failed";
      const written = await this.prisma.kommoConversionDedupe.updateMany({
        where: {
          ...leaseWhere(),
          publicationStatus:
            status === "delivery_unknown"
              ? "delivery_unknown"
              : { in: ["publication_pending", "queued"] },
        },
        data: {
          publicationStatus: status,
          publicationErrorCode:
            status === "delivery_unknown"
              ? KOMMO_DELIVERY_UNKNOWN
              : status === "revoked"
                ? "publication_authorization_revoked"
                : status === "publication_failed"
                  ? "sender_not_ready"
                  : null,
          publicationLeaseToken: null,
          publicationLeaseExpiresAt: null,
          publicationNextAttemptAt: new Date(now.getTime() + 30_000),
        },
      });
      if (!written.count) {
        const current = await this.prisma.kommoConversionDedupe.findFirst({
          where: { id: intent.id, workspaceId: intent.workspaceId },
        });
        return current?.publicationStatus ?? status;
      }
      return status;
    } catch {
      const attempts = intent.publicationAttempts + 1;
      const status =
        attempts >= this.maxAttempts
          ? "publication_failed"
          : "publication_pending";
      const written = await this.prisma.kommoConversionDedupe.updateMany({
        where: {
          ...leaseWhere(),
          publicationStatus: { in: ["publication_pending", "queued"] },
        },
        data: {
          publicationStatus: status,
          publicationAttempts: attempts,
          publicationErrorCode: "conversion_enqueue_failed",
          publicationLeaseToken: null,
          publicationLeaseExpiresAt: null,
          publicationNextAttemptAt: new Date(
            now.getTime() + Math.min(30_000 * 2 ** attempts, 900_000),
          ),
        },
      });
      if (!written.count) {
        const current = await this.prisma.kommoConversionDedupe.findFirst({
          where: { id: intent.id, workspaceId: intent.workspaceId },
        });
        return current?.publicationStatus ?? status;
      }
      return status;
    }
  }

  private async releasePublicationLease(intent: any, token: string) {
    await this.prisma.kommoConversionDedupe.updateMany({
      where: {
        id: intent.id,
        publicationLeaseToken: token,
        publicationStatus: { in: ["publication_pending", "queued"] },
      },
      data: {
        publicationLeaseToken: null,
        publicationLeaseExpiresAt: null,
        publicationNextAttemptAt: this.now(),
      },
    });
  }

  private async verifyAndRefresh(connection: Connection, token: string) {
    const account = await this.adapter.verify(connection.accountOrigin, token);
    await this.prisma.kommoConnection.updateMany({
      where: this.generationWhere(connection),
      data: {
        verifiedAccountId: account.id,
        accountSubdomain: account.subdomain,
        credentialHealthy: true,
        status: "active",
        lastErrorCode: null,
      },
    });
    await this.refreshCatalog(connection.workspaceId, connection.id);
  }

  private async resolveLead(
    connection: Connection,
    dealId: string,
    workspaceId: string,
  ): Promise<
    | {
        lead: ProvenKommoLead;
        route: any;
        destination: LeadDestination;
        ctwa?: undefined;
      }
    | { lead: any; ctwa: AuthorizedCtwaDestination; route?: undefined }
    | { error: string }
  > {
    let token: string;
    try {
      token = this.decrypt(connection);
    } catch {
      return { error: "credential_decrypt_failed" };
    }
    let remote: any;
    try {
      remote = await this.adapter.getLead(
        connection.accountOrigin,
        token,
        dealId,
      );
    } catch (error) {
      return { error: this.code(error) };
    }
    if (
      remote.id !== dealId ||
      remote.accountId !== connection.verifiedAccountId
    )
      return { error: "remote_lead_account_mismatch" };
    if (remote.contactIds.length !== 1)
      return {
        error: remote.contactIds.length
          ? "contact_ambiguous"
          : "contact_missing",
      };
    const contactId = remote.contactIds[0]!;
    let contact: any;
    try {
      contact = await this.adapter.getContact(
        connection.accountOrigin,
        token,
        contactId,
      );
    } catch (error) {
      return { error: this.code(error) };
    }
    if (
      contact.id !== contactId ||
      contact.accountId !== connection.verifiedAccountId
    )
      return { error: "remote_contact_account_mismatch" };
    const hashes: string[] = [
      ...new Set<string>(
        contact.phones
          .map((phone: string) => hashPhoneIdentity(phone))
          .filter((value: string | null): value is string => Boolean(value)),
      ),
    ];
    if (hashes.length !== 1)
      return { error: hashes.length ? "phone_ambiguous" : "phone_missing" };
    const lead = await this.prisma.lead.findUnique({
      where: { workspaceId_phoneHash: { workspaceId, phoneHash: hashes[0] } },
      select: {
        id: true,
        phoneHash: true,
        whatsappInstanceId: true,
        campaignId: true,
        adSetId: true,
        adId: true,
        ctwaClid: true,
      },
    });
    if (!lead) return { error: "workspace_lead_not_found" };
    const bindingIds: string[] = connection.allowedChannelRouteIds ?? [];
    const crmLead = { ...lead, workspaceId };
    // Ad-attributed path (unchanged for Uazapi leads): a route binding of the
    // lead's number (Uazapi by its WhatsApp instance, official-API numbers by
    // the materialized entry receipt) whose Meta destination is the ad's.
    let adError = "lead_channel_or_attribution_unproven";
    if (lead.adId && lead.ctwaClid) {
      const provenLead: ProvenKommoLead = {
        ...lead,
        adId: lead.adId,
        ctwaClid: lead.ctwaClid,
      };
      const destination = await this.resolveLeadDestination(
        this.prisma,
        workspaceId,
        provenLead,
      );
      if (destination) {
        const routes = (
          await crmLeadRoutes(this.prisma, crmLead, bindingIds)
        ).filter(
          (route: any) =>
            route.metaReportingAccountId === destination.reportingAccountId &&
            route.metaConversionDestinationId ===
              destination.conversionDestinationId,
        );
        if (routes.length > 1) return { error: "lead_channel_route_ambiguous" };
        if (routes.length === 1)
          return { lead: provenLead, route: routes[0], destination };
      }
      // Same refusal codes as the SaaS for an ad lead without a matching
      // route (any provider: UAZAPI by instance, official API by receipt).
      adError = destination
        ? "lead_channel_route_unauthorized"
        : "lead_destination_unproven";
    }
    // CTWA path (as the SaaS): Meta CAPI needs only pixel + page + ctwa_clid.
    // Without ctwa_clid there is no proof and nothing is sent. A number bound
    // by its channel id proves the verified unique workspace page/pixel.
    const ctwa = await crmLeadCtwaProof(this.prisma, crmLead, bindingIds);
    if (ctwa) return { lead: crmLead, ctwa };
    return { error: adError };
  }

  private async resolveLeadDestination(
    client: any,
    workspaceId: string,
    lead: {
      id: string;
      phoneHash: string;
      whatsappInstanceId: string | null;
      adId: string;
      ctwaClid: string;
    },
  ): Promise<LeadDestination | null> {
    const assignment = await client.metaAdDestinationAssignment.findUnique({
      where: { workspaceId_adId: { workspaceId, adId: lead.adId } },
      select: { conversionDestinationId: true, reportingAccountId: true },
    });
    if (assignment) return assignment;

    // The inbound route must come from the number this lead arrived on:
    // Uazapi by its WhatsApp instance; an official-API lead (no instance) only
    // from the channels of its materialized entry receipt of the same click,
    // never from any other official number of the workspace.
    let channelScope: Record<string, unknown> | null = {
      channel: { whatsappInstanceId: lead.whatsappInstanceId },
    };
    if (!lead.whatsappInstanceId) {
      const entered = await crmLeadEntryChannelIds(client, {
        workspaceId,
        leadId: lead.id,
        phoneHash: lead.phoneHash,
        ctwaClid: lead.ctwaClid,
      });
      channelScope = entered.size
        ? {
            channelId: { in: [...entered] },
            channel: { whatsappInstanceId: null },
          }
        : null;
    }
    const inboundEvents = channelScope
      ? await client.inboundWebhookEvent.findMany({
          where: {
            workspaceId,
            contactIdentityHash: lead.phoneHash,
            adId: lead.adId,
            hasCtwa: true,
            classification: "eligible_route_resolved",
            ...channelScope,
          },
          select: {
            resolvedReportingAccountId: true,
            resolvedConversionDestinationId: true,
          },
        })
      : [];
    const inboundDestinations = new Map<
      string,
      {
        reportingAccountId: string;
        conversionDestinationId: string;
      }
    >();
    for (const event of inboundEvents) {
      if (
        !event.resolvedReportingAccountId ||
        !event.resolvedConversionDestinationId
      )
        continue;
      const destination = {
        reportingAccountId: event.resolvedReportingAccountId,
        conversionDestinationId: event.resolvedConversionDestinationId,
      };
      inboundDestinations.set(
        `${destination.reportingAccountId}:${destination.conversionDestinationId}`,
        destination,
      );
    }
    if (inboundDestinations.size === 1)
      return inboundDestinations.values().next().value!;

    const ad = await client.metaAd.findFirst({
      where: { workspaceId, adId: lead.adId },
      select: { adAccountId: true },
    });
    if (!ad?.adAccountId) return null;

    const account = await client.metaReportingAccount.findFirst({
      where: { workspaceId, adAccountId: ad.adAccountId, active: true },
      select: {
        id: true,
        conversionDestinationId: true,
        businessConnection: {
          select: { defaultConversionDestinationId: true },
        },
        allowedDestinations: {
          where: { active: true },
          select: {
            destination: {
              select: { id: true, status: true },
            },
          },
        },
      },
    });
    if (!account) return null;

    let destinations = account.allowedDestinations
      .map((record: any) => record.destination)
      .filter((destination: any) => destination.status === "configured");
    if (destinations.length === 0) {
      const legacyDestinationId =
        account.conversionDestinationId ??
        account.businessConnection?.defaultConversionDestinationId ??
        null;
      destinations = legacyDestinationId
        ? await client.metaConversionDestination.findMany({
            where: {
              id: legacyDestinationId,
              workspaceId,
              status: "configured",
            },
            select: { id: true, status: true },
          })
        : [];
    }
    if (destinations.length !== 1) return null;
    return {
      reportingAccountId: account.id,
      conversionDestinationId: destinations[0].id,
    };
  }

  private valueFor(
    rule: any,
    event: any,
    workspaceCurrency: CurrencyCode,
  ): { cents: number | null; currency: string | null } | { error: string } {
    const eventName = rule.eventName as ConversionEventNameDto;
    if (!conversionEventCarriesValue(eventName))
      return { cents: null, currency: null };
    // Só BRL/USD/EUR vão à Meta; sem moeda válida na regra, a do workspace.
    const ruleCurrency = normalizeCurrencyCode(rule.currency);
    if (rule.valueMode === "fixed")
      return rule.fixedValueCents
        ? {
            cents: rule.fixedValueCents,
            currency: ruleCurrency ?? workspaceCurrency,
          }
        : { error: "fixed_value_not_configured" };
    if (
      !event.eventPricePresent ||
      !event.eventPriceCents ||
      event.eventPriceCents <= 0
    )
      return conversionEventRequiresValue(eventName)
        ? { error: "event_price_missing_or_nonpositive" }
        : { cents: null, currency: ruleCurrency };
    return {
      cents: event.eventPriceCents,
      currency: ruleCurrency ?? workspaceCurrency,
    };
  }

  private async enqueueRecord(event: any) {
    if (!(await this.licenseAllows())) return false;
    if (!event || !this.isRecoverable(event.status)) return false;
    if (
      event.status === "processing" &&
      event.leaseExpiresAt &&
      event.leaseExpiresAt > this.now()
    )
      return false;
    const intents = await this.prisma.kommoConversionDedupe.findMany({
      where: { workspaceId: event.workspaceId, sourceEventId: event.id },
    });
    for (const intent of intents) {
      const log = intent.conversionEventLogId
        ? await this.prisma.conversionEventLog.findFirst({
            where: {
              id: intent.conversionEventLogId,
              workspaceId: event.workspaceId,
            },
          })
        : null;
      if (!kommoDeliveryUnknown(intent, log)) continue;
      await this.prisma.kommoWebhookEvent.updateMany({
        where: {
          id: event.id,
          workspaceId: event.workspaceId,
          revision: event.revision,
          status: event.status,
          leaseToken: null,
        },
        data: {
          status: "blocked",
          errorCode: KOMMO_DELIVERY_UNKNOWN,
          nextAttemptAt: null,
          revision: { increment: 1 },
        },
      });
      return false;
    }
    // Intent/log reads above may have taken arbitrarily long. Do not start a
    // synchronous queue side effect from a stale allowed decision.
    if (!(await this.licenseAllows())) return false;
    const jobId = await this.queue.enqueue(event.id, event.workspaceId);
    // A worker can finish while queue.add awaits Redis. Never reset its claim,
    // terminal state, or a newer receiver/recovery version.
    await this.prisma.kommoWebhookEvent.updateMany({
      where: {
        id: event.id,
        workspaceId: event.workspaceId,
        revision: event.revision,
        status: event.status,
        leaseToken: null,
      },
      data: {
        jobId,
        ...(event.status === "processing" ? {} : { status: "queued" }),
        revision: { increment: 1 },
      },
    });
    return true;
  }

  private async reconcileRecoverableEvents(
    scope: { workspaceId?: string; connectionId?: string } = {},
  ) {
    if (!(await this.licenseAllows())) return 0;
    let queued = 0;
    const scoped = Boolean(scope.workspaceId || scope.connectionId);
    let cursor: string | undefined = scoped
      ? undefined
      : this.eventRecoveryCursor;
    // Keyset pagination and a bounded page count keep a large backlog from
    // starving the process. Recurrence restarts at the beginning when needed.
    for (let page = 0; page < 100 && !this.stopping; page += 1) {
      const now = this.now();
      const events = await this.prisma.kommoWebhookEvent.findMany({
        where: {
          ...scope,
          ...(cursor ? { id: { gt: cursor } } : {}),
          OR: [
            {
              status: {
                in: [
                  "accepted",
                  "failed",
                  "publication_pending",
                  "materialized",
                  "queued",
                ],
              },
              AND: [
                {
                  OR: [
                    { nextAttemptAt: null },
                    { nextAttemptAt: { lte: now } },
                  ],
                },
              ],
            },
            {
              status: "processing",
              OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
            },
          ],
        },
        orderBy: { id: "asc" },
        take: 100,
      });
      if (!events.length) {
        cursor = undefined;
        break;
      }
      for (const event of events) {
        try {
          if (await this.enqueueRecord(event)) queued += 1;
        } catch {
          await this.prisma.kommoWebhookEvent.updateMany({
            where: {
              id: event.id,
              revision: event.revision,
              status: event.status,
              leaseToken: null,
            },
            data: {
              errorCode: "enqueue_failed",
              nextAttemptAt: new Date(now.getTime() + 30_000),
            },
          });
        }
      }
      cursor = events.at(-1)!.id;
      if (events.length < 100) {
        cursor = undefined;
        break;
      }
    }
    if (!scoped) this.eventRecoveryCursor = cursor;
    cursor = scoped ? undefined : this.intentRecoveryCursor;
    for (let page = 0; page < 100 && !this.stopping; page += 1) {
      const intents: any[] = await this.prisma.kommoConversionDedupe.findMany({
        where: {
          ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
          ...(scope.connectionId
            ? {
                publicationIntent: {
                  path: ["connectionId"],
                  equals: scope.connectionId,
                },
              }
            : {}),
          ...(cursor ? { id: { gt: cursor } } : {}),
          publicationStatus: {
            in: ["publication_pending", "queued", "delivery_unknown"],
          },
          OR: [
            { publicationNextAttemptAt: null },
            { publicationNextAttemptAt: { lte: this.now() } },
          ],
        },
        orderBy: { id: "asc" },
        take: 100,
      });
      if (!intents.length) {
        cursor = undefined;
        break;
      }
      for (const intent of intents) await this.publishIntent(intent);
      cursor = intents.at(-1)!.id;
      if (intents.length < 100) {
        cursor = undefined;
        break;
      }
    }
    if (!scoped) this.intentRecoveryCursor = cursor;
    // Refresh expired catalog snapshots through the same generation-fenced path.
    const catalogCursor = scoped ? undefined : this.catalogRecoveryCursor;
    const connections = await this.prisma.kommoConnection.findMany({
      where: {
        ...(catalogCursor ? { id: { gt: catalogCursor } } : {}),
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        ...(scope.connectionId ? { id: scope.connectionId } : {}),
        status: "active",
        credentialHealthy: true,
        OR: [
          { catalogRefreshedAt: null },
          {
            catalogRefreshedAt: {
              lte: new Date(this.now().getTime() - this.catalogTtlMs),
            },
          },
        ],
      },
      orderBy: { id: "asc" },
      take: 100,
    });
    if (!scoped)
      this.catalogRecoveryCursor =
        connections.length === 100 ? connections.at(-1)!.id : undefined;
    for (const connection of connections) {
      if (this.stopping) break;
      try {
        await this.refreshCatalog(connection.workspaceId, connection.id);
      } catch {
        /* refresh persists fenced stale/error status */
      }
    }
    return queued;
  }

  private async retryEvent(event: any, code: string) {
    const final = event.attempts >= this.maxAttempts;
    return this.complete(
      event,
      final ? "dead" : "failed",
      code,
      undefined,
      final
        ? null
        : new Date(
            this.now().getTime() +
              Math.min(30_000 * 2 ** event.attempts, 900_000),
          ),
    );
  }

  private retryable(code: string) {
    return [
      "kommo_transport",
      "kommo_rate_limited",
      "processing_failed",
    ].includes(code);
  }
  private leaseWhere(event: any) {
    return {
      id: event.id,
      workspaceId: event.workspaceId,
      status: "processing",
      leaseToken: event.leaseToken,
      leaseExpiresAt: { gt: this.now() },
    };
  }
  private generationWhere(connection: any) {
    return {
      id: connection.id,
      workspaceId: connection.workspaceId,
      credentialGeneration: connection.credentialGeneration,
      verifiedAccountId: connection.verifiedAccountId,
    };
  }
  private sameGeneration(a: any, b: any) {
    return (
      a.credentialGeneration === b.credentialGeneration &&
      a.verifiedAccountId === b.verifiedAccountId
    );
  }
  private catalogFresh(connection: any) {
    if (connection.catalogState !== "fresh" || !connection.catalogRefreshedAt)
      return false;
    const age = this.now().getTime() - connection.catalogRefreshedAt.getTime();
    return age >= 0 && age < this.catalogTtlMs;
  }
  private async lockConnection(
    tx: any,
    workspaceId: string,
    connectionId: string,
  ) {
    await tx.$queryRaw`SELECT "id" FROM "KommoConnection" WHERE "id" = ${connectionId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    const row = await tx.kommoConnection.findFirst({
      where: { id: connectionId, workspaceId },
    });
    if (!row) throw new NotFoundException("Conexao Kommo nao encontrada");
    return row;
  }
  private async validateBindings(
    client: any,
    workspaceId: string,
    routeIds: string[],
  ) {
    // Any production WhatsApp number of the workspace (any provider) with a
    // verified Meta destination (shared CRM channel policy, as the SaaS); the
    // first failing requirement is reported in plain language.
    for (const bindingId of routeIds) {
      const binding = await inspectCrmBinding(client, workspaceId, bindingId);
      if (!binding.ok)
        throw new BadRequestException({
          statusCode: 400,
          code: `kommo_channel_${binding.reason}`,
          message: kommoChannelBindingMessages[binding.reason],
        });
    }
  }
  async setChannelBindings(
    workspaceId: string,
    connectionId: string,
    actorUserId: string,
    routeIds: string[],
    actorType: AuditActorType = "user",
  ) {
    await this.prisma.$transaction(async (tx: any) => {
      await this.lockConnection(tx, workspaceId, connectionId);
      await this.validateBindings(tx, workspaceId, routeIds);
      await tx.kommoConnection.update({
        where: { id: connectionId },
        data: { allowedChannelRouteIds: routeIds },
      });
      await this.audit(
        workspaceId,
        actorUserId,
        actorType,
        "kommo.channel_bindings_updated",
        connectionId,
        "success",
        tx,
      );
    });

    return this.get(workspaceId, connectionId);
  }
  private isRecoverable(status: string) {
    return [
      "accepted",
      "failed",
      "publication_pending",
      "materialized",
      "queued",
      "processing",
    ].includes(status);
  }
  private eventMatchesConnection(event: any, connection: any) {
    return (
      connection &&
      event.verifiedAccountId === connection.verifiedAccountId &&
      event.credentialGeneration === (connection.credentialGeneration ?? 1)
    );
  }
  private async assertCatalogStage(
    connectionId: string,
    pipelineId: string,
    statusId: string,
    client: any = this.prisma,
  ) {
    const stage = await client.kommoPipelineCatalog.findUnique({
      where: {
        connectionId_pipelineId_statusId: {
          connectionId,
          pipelineId,
          statusId,
        },
      },
    });
    if (!stage?.available)
      throw new ConflictException("Estagio Kommo indisponivel no catalogo");
  }
  private ruleData(input: any) {
    const carries = conversionEventCarriesValue(input.eventName);
    return {
      name: input.name,
      pipelineId: input.pipelineId,
      statusId: input.statusId,
      eventName: input.eventName,
      mode: input.mode,
      active: input.active,
      valueMode: carries ? input.valueMode : "lead_price",
      fixedValueCents:
        carries && input.valueMode === "fixed"
          ? (input.fixedValueCents ?? null)
          : null,
      currency: carries ? (input.currency ?? null) : null,
      contentName: carries ? (input.contentName ?? null) : null,
    };
  }
  private async connection(workspaceId: string, id: string) {
    const row = await this.prisma.kommoConnection.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException("Conexao Kommo nao encontrada");
    return row;
  }
  private async complete(
    event: any,
    status: string,
    errorCode: string | null,
    results?: any[],
    nextAttemptAt: Date | null = null,
  ) {
    const changed = await this.prisma.kommoWebhookEvent.updateMany({
      where: this.leaseWhere(event),
      data: {
        status,
        errorCode,
        processedAt: this.now(),
        nextAttemptAt,
        leaseToken: null,
        leaseExpiresAt: null,
        revision: { increment: 1 },
        ...(results ? { results } : {}),
      },
    });
    return {
      status: changed.count ? status : "lease_lost",
      errorCode,
      ...(results ? { results } : {}),
    };
  }
  private dto(row: any) {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      displayName: row.displayName,
      status: row.status,
      verifiedAccountId: row.verifiedAccountId,
      accountSubdomain: row.accountSubdomain,
      accountOrigin: row.accountOrigin,
      allowedChannelRouteIds: row.allowedChannelRouteIds ?? [],
      credentialHealthy: row.credentialHealthy,
      catalogState:
        row.catalogState === "fresh" && !this.catalogFresh(row)
          ? "stale"
          : row.catalogState,
      catalogRefreshedAt: row.catalogRefreshedAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      pipelines: (row.pipelines ?? []).map((item: any) => ({
        id: item.pipelineId,
        name: item.pipelineName,
        sort: item.pipelineSort,
        status: {
          id: item.statusId,
          name: item.statusName,
          type: item.statusType,
        },
        available: item.available,
      })),
      rules: (row.rules ?? []).map((rule: any) => this.ruleDto(rule)),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  private ruleDto(rule: any) {
    return {
      id: rule.id,
      connectionId: rule.connectionId,
      name: rule.name,
      pipelineId: rule.pipelineId,
      statusId: rule.statusId,
      eventName: rule.eventName,
      mode: rule.mode,
      valueMode: rule.valueMode,
      fixedValueCents: rule.fixedValueCents,
      currency: rule.currency,
      contentName: rule.contentName,
      active: rule.active,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
    };
  }
  private webhookUrl(id: string, secret: string) {
    const path = `/webhooks/kommo/v1/${encodeURIComponent(id)}?token=${encodeURIComponent(secret)}`;
    const base = process.env.API_PUBLIC_URL?.trim();
    if (!base) return path;
    try {
      return new URL(path, base).toString();
    } catch {
      return path;
    }
  }
  private newSecret() {
    return randomBytes(32).toString("base64url");
  }
  private hash(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }
  private matches(value: unknown, digest: string) {
    if (typeof value !== "string" || !value) return false;
    const a = Buffer.from(this.hash(value));
    const b = Buffer.from(digest);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  private key() {
    const value = process.env.KOMMO_CRM_ENCRYPTION_KEY?.trim();
    if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value))
      throw new Error("Kommo encryption key is invalid");
    const key = Buffer.from(value, "base64");
    if (key.length !== 32 || key.toString("base64") !== value)
      throw new Error("Kommo encryption key is invalid");
    return key;
  }
  private encrypt(id: string, value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(this.aad(id));
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return {
      accessTokenEncrypted: encrypted.toString("base64"),
      accessTokenIv: iv.toString("base64"),
      accessTokenTag: cipher.getAuthTag().toString("base64"),
    };
  }
  private decrypt(row: Connection) {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key(),
        this.base64(row.accessTokenIv, 12),
      );
      decipher.setAAD(this.aad(row.id));
      decipher.setAuthTag(this.base64(row.accessTokenTag, 16));
      return Buffer.concat([
        decipher.update(this.base64(row.accessTokenEncrypted)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("credential_decrypt_failed");
    }
  }
  private base64(value: string, length?: number) {
    const decoded = Buffer.from(value, "base64");
    if (
      decoded.toString("base64") !== value ||
      (length !== undefined && decoded.length !== length)
    )
      throw new Error("invalid encrypted material");
    return decoded;
  }
  private aad(id: string) {
    return Buffer.from(`wpptrack:kommo-token:v1:${id}`, "utf8");
  }
  private code(error: unknown) {
    if (error instanceof KommoAdapterError) return error.code;
    const safeCodes = [
      "credential_decrypt_failed",
      "credential_generation_mismatch",
      "trigger_authorization_changed",
      "channel_authorization_changed",
      "lead_authorization_changed",
      "semantic_identity_conflict",
      "kommo_license_locked",
    ];
    return error instanceof Error && safeCodes.includes(error.message)
      ? error.message
      : "processing_failed";
  }
  private unique(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    );
  }
  private async audit(
    workspaceId: string,
    actorUserId: string,
    actorType: AuditActorType,
    action: string,
    targetId: string,
    resultStatus: string,
    client: any = this.prisma,
  ) {
    await client.auditLog.create({
      data: {
        workspaceId,
        actorUserId,
        actorType,
        action,
        targetType: "KommoConnection",
        targetId,
        resultStatus,
        afterSummary: { provider: "kommo", redacted: true },
      },
    });
  }
}
