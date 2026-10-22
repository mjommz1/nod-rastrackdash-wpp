import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  KOMMO_CTWA_PROCESSING_MODE,
  kommoCtwaConversionAuthorized,
  kommoPublicationAuthorized,
  type KommoPublicationIntent,
} from "../kommo/kommo-publication-policy";
import {
  PIPEDRIVE_DELIVERY_UNKNOWN,
  PIPEDRIVE_STAGE_TRIGGER,
  lockPipedriveConnection,
  pipedriveDispatchAuthorized,
  pipedriveRouteIntent,
  settlePipedriveSenderOutcome,
} from "./crm-dispatch-context";
import {
  PIPEDRIVE_CTWA_PROCESSING_MODE,
  pipedriveCtwaConversionAuthorized,
} from "../pipedrive/pipedrive-production-policy";
import { isCrmCtwaContext } from "../crm-channels/crm-ctwa-context";
import {
  settleKommoSenderOutcome,
  KOMMO_DELIVERY_UNKNOWN,
  KOMMO_DELIVERY_UNKNOWN_MESSAGE,
} from "../kommo/kommo-sender-policy";
import {
  authorizedCtwaDestinationSchema,
  normalizeCurrencyCode,
  resolveConversionCurrency,
} from "@wpptrack/shared";
import {
  CTWA_DESTINATION_PROVIDER,
  CTWA_DESTINATION_REASON,
  CTWA_DESTINATION_AD_HINT_REASON,
  ctwaDestinationProviderValue,
  ctwaIntentAuthorized,
  type AuthorizedCtwaDestination,
} from "../inbound-webhooks/authorized-ctwa-destination";
import { lockUnnichatMetaPolicy } from "../inbound-webhooks/inbound-webhook-effective-meta-routing";
import { ConversionRecordError } from "./conversion-record.error";
import { CTWA_SEND_SKIPPED_ERROR_CODE } from "./conversion-event-retry";
import { providerAutomationManualReplayApproved } from "../conversion-rules/provider-manual-replay-approval";
import { providerRuleCoversChannel } from "../conversion-rules/provider-rule-scope";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Prisma } from "@prisma/client";
import {
  lockKommoDispatch,
  KOMMO_DISPATCH_START_MS,
  KOMMO_DISPATCH_TRANSACTION_MS,
  KOMMO_NETWORK_MS,
} from "./kommo-dispatch-coordination";
import {
  lockInboundMetaDispatch,
  INBOUND_DISPATCH_START_MS,
  INBOUND_DISPATCH_TRANSACTION_MS,
  INBOUND_NETWORK_MS,
} from "./inbound-meta-dispatch-coordination";
import type {
  ConversionValueSourceDto,
  ConversionEventCustomDataDto,
  ConversionEventNameDto,
  ConversionEventTestInputDto,
  ConversionRuleDto,
} from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { loadWorkspaceConversionCurrency } from "../currency/workspace-currency";
import { MetaTokenEncryptionService } from "../integrations/meta/meta-token-encryption.service";
import {
  MetaConnectionResolverService,
  type ResolvedMetaCapiRoute,
} from "../integrations/meta/meta-connection-resolver.service";
import {
  MetaCapiAdapter,
  preflightMetaCapiEvent,
  type MetaCapiSendEventErrorCode,
} from "./meta-capi.adapter";
import { LicenseClientService } from "../licensing-client/license-client.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import {
  assertMetaCloudSigningConfigured,
  inboundParserProductionEligible,
} from "../inbound-webhooks/inbound-webhook-parser-eligibility";
import { InboundWebhookMetaRouteReaderService } from "../inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { inboundMetaRouteMatches } from "../inbound-webhooks/inbound-webhook-meta-route-eligibility";
import {
  replayContextHash,
  studentBatchAuthorizationValid,
} from "../inbound-webhook-replay/student-replay-context";
import {
  isConversionEventRequiringValue,
  isSupportedConversionEventName,
} from "./conversion-event-registry";

export type RecordRuleMatchesInput = {
  workspaceId: string;
  rules: ConversionRuleDto[];
  leadId?: string;
  phoneHash?: string;
  campaignId?: string;
  adSetId?: string;
  adId?: string;
  ctwaClid?: string;
  valueCents?: number | null;
  currency?: string | null;
  contentName?: string | null;
  customData?: ConversionEventCustomDataDto;
  eventOccurredAt?: Date | string | null;
};

export type RecordRuleMatchesResult = {
  created: string[];
  duplicates: string[];
};

type ConversionEventLogRecord = {
  sourceTrigger?: string;
  id: string;
  workspaceId: string | null;
  externalConnectorId: string | null;
  leadId: string | null;
  pixelId: string | null;
  pageId: string | null;
  eventId: string | null;
  metaAccountId: string | null;
  metaBusinessConnectionId?: string | null;
  metaConversionDestinationId?: string | null;
  eventName: ConversionEventNameDto;
  status: string;
  phoneHash: string | null;
  eventOccurredAt: Date;
  customerIdentityKey: string | null;
  businessSource: string;
  purchaseKind: string | null;
  valueSource: string | null;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  ctwaClid: string | null;
  attributionStatus: string | null;
  dedupeKey: string | null;
  sourcePayload: Prisma.JsonValue | null;
  customData: Prisma.JsonValue | null;
  valueCents: number | null;
  currency: string | null;
  contentName: string | null;
  errorCode: string | null;
};

type ConversionEventPrismaClient = Pick<
  Prisma.TransactionClient,
  "conversionEventLog"
>;

export type RecordExternalConversionInput = {
  /** CTWA lead with ctwa_clid and no known ad: the authorized page/pixel. */
  ctwaDestination?: AuthorizedCtwaDestination;
  workspaceId: string;
  externalConnectorId?: string | null;
  sourceEventId: string;
  sourceTrigger: string;
  // Any catalog event: provider rules can now be built for all of them, and
  // resolveInitialStatus already gates delivery per event.
  eventName: ConversionEventNameDto;
  eventId: string;
  dedupeKey: string;
  leadId?: string | null;
  phoneHash: string;
  businessSource: "paid" | "organic";
  metaAccountId?: string | null;
  metaBusinessConnectionId?: string | null;
  metaConversionDestinationId?: string | null;
  campaignId?: string | null;
  adSetId?: string | null;
  adId?: string | null;
  ctwaClid?: string | null;
  valueCents?: number | null;
  valueSource?: ConversionValueSourceDto | null;
  currency?: string | null;
  contentName?: string | null;
  eventOccurredAt: Date;
  sourcePayload?: Record<string, unknown> | null;
  deliveryStatus?: "imported" | "not_eligible" | "shadow_observed";
};

export type RecordExternalConversionResult = {
  conversionEventLogId: string;
  status: "created" | "duplicate";
  deliveryStatus: string;
};

type InitialStatus = {
  status:
    | "pending_meta_context"
    | "pending_value"
    | "ready_to_send"
    | "imported"
    | "not_eligible"
    | "shadow_observed"
    | "skipped";
  errorCode:
    | "MissingAdId"
    | "MissingCtwaClid"
    | "EventValueMissing"
    | "UnsupportedConversionEventName"
    | "MetaEventTimeExpired"
    | null;
  errorMessage: string | null;
};

type RecordAutomaticLeadSubmittedInput = {
  workspaceId: string;
  leadId?: string;
  phoneHash?: string;
  campaignId?: string;
  adSetId?: string;
  adId?: string;
  ctwaClid?: string;
  eventOccurredAt?: Date | string | null;
};

export type SendManualTestEventInput = ConversionEventTestInputDto;

type MetaIntegrationCapiTokenRecord = {
  encryptedAccessToken: string | null;
  tokenIv: string | null;
  tokenTag: string | null;
  capiAccessTokenEncrypted: string | null;
  capiTokenIv: string | null;
  capiTokenTag: string | null;
  selectedAdAccountId: string | null;
};

type MetaConversionDestinationRecord = {
  pixelId: string;
  pageId: string;
};

type FunnelEventDefaults = {
  eventName: string;
  defaultValueCents: number | null;
  defaultCurrency: string | null;
  defaultContentName: string | null;
};

type ResolvedConversionDestination = {
  source: "legacy_oauth" | "manual";
  accessToken: string | null;
  pixelId: string | null;
  pageId: string | null;
  reportingAccountId: string | null;
  adAccountId: string | null;
  businessConnectionId: string | null;
  conversionDestinationId: string | null;
  routeError: string | null;
  legacyShadowParity: LegacyRouteShadowParity | null;
};

type LegacyRouteShadowParity = {
  comparisonStatus: "matched" | "mismatch" | "unavailable";
  credentialFingerprintMatch: boolean | null;
  adAccountMatch: boolean | null;
  pixelMatch: boolean | null;
  pageMatch: boolean | null;
  parity: boolean;
};

export { CTWA_SEND_SKIPPED_ERROR_CODE };

const CTWA_SEND_SKIP_REASONS: Record<string, string> = {
  ctwa_destination_malformed: "destino CTWA gravado no evento é inválido",
  ctwa_workspace_mismatch: "workspace do destino CTWA difere do evento",
  ctwa_sender_unavailable: "serviço de envio CTWA indisponível no worker",
  ctwa_license_locked: "licença bloqueada",
  ctwa_click_missing: "evento sem ctwa_clid",
  ctwa_destination_not_authorized:
    "página/pixel CTWA não está mais autorizado para o número",
  inbound_production_disabled: "produção de webhooks desativada",
  ctwa_meta_hierarchy_present: "evento CTWA com conta/campanha/conjunto Meta",
  ctwa_channel_mismatch: "número do evento difere do destino CTWA",
  ctwa_entry_context_invalid: "entrada CTWA de origem inválida ou revogada",
  ctwa_entry_receipt_invalid: "recibo da entrada CTWA inválido",
  ctwa_replay_not_authorized: "reprocessamento CTWA não autorizado",
  ctwa_entry_not_in_production: "entrada CTWA anterior à ativação",
  pipedrive_ctwa_context_invalid: "contexto Pipedrive CTWA inválido",
  kommo_ctwa_context_invalid: "contexto Kommo CTWA inválido",
  ctwa_processing_mode_unsupported: "modo de processamento não suportado",
  ctwa_provider_conversion_with_ad: "conversão de provedor CTWA com anúncio",
  provider_conversion_production_disabled:
    "produção de regras de conversão desativada",
  provider_conversion_execution_missing: "execução da regra ausente",
  provider_conversion_execution_not_materialized:
    "execução da regra não materializada para este evento",
  provider_conversion_origin_mismatch:
    "número/conexão da regra difere da entrada CTWA",
  provider_purchase_claim_missing: "venda não é a vencedora do claim de produção",
  provider_rule_not_in_production: "regra inativa ou fora de produção",
  provider_connection_not_certified: "conexão/parser da regra não certificado",
  provider_channel_not_canonical: "número inativo ou não canônico",
  provider_channel_out_of_scope: "número fora do alcance da regra",
  provider_delivery_before_activation:
    "callback anterior à ativação sem aprovação do operador",
};

export type SendReadyEventResult = {
  conversionEventLogId: string;
  workspaceId: string | null;
  status: "not_configured" | "sent" | "error" | "skipped";
  errorCode?: MetaCapiSendEventErrorCode | typeof CTWA_SEND_SKIPPED_ERROR_CODE;
  errorMessage?: string | null;
};

type SendReadyEventOptions = {
  workspaceId?: string;
  testEventCode?: string;
};

@Injectable()
export class ConversionEventsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MetaCapiAdapter) private readonly metaCapiAdapter: MetaCapiAdapter,
    private readonly metaTokenEncryption: MetaTokenEncryptionService,
    // The union emits Object metadata; Nest must bind the exported class token.
    @Inject(MetaConnectionResolverService)
    private readonly connectionResolver:
      MetaConnectionResolverService | undefined,
    @Inject(LicenseClientService)
    private readonly licenseClient: LicenseClientService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv = process.env,
  ) {}

  private async inboundMetaDispatchAuthorized(
    client: Prisma.TransactionClient,
    log: ConversionEventLogRecord,
  ): Promise<boolean> {
    if (!log.workspaceId || !(await this.kommoLicenseAllows(client)))
      return false;
    const config = parseInboundWebhooksConfig(this.env);
    if (!config.enabled) return false;
    try {
      assertMetaCloudSigningConfigured("meta_cloud", this.env);
    } catch {
      return false;
    }
    const source = log.sourcePayload as { inboundEventId?: string } | null;
    if (!source?.inboundEventId) return false;
    const event = await client.inboundWebhookEvent.findFirst({
      where: { id: source.inboundEventId, workspaceId: log.workspaceId },
      include: {
        delivery: true,
        connection: { include: { parserRelease: true } },
        channel: {
          include: {
            routes: { where: { active: true, validationStatus: "valid" } },
          },
        },
        replayItem: true,
      },
    });
    if (
      !event ||
      event.provider !== "meta_cloud" ||
      event.connection.provider !== "meta_cloud" ||
      event.connection.workspaceId !== log.workspaceId ||
      event.channel.workspaceId !== log.workspaceId ||
      event.channel.connectionId !== event.connectionId ||
      event.delivery.provider !== event.provider ||
      event.delivery.workspaceId !== log.workspaceId ||
      event.delivery.connectionId !== event.connectionId ||
      event.delivery.parserVersion !== event.connection.parserRelease.version ||
      event.connection.parserRelease.provider !== "meta_cloud" ||
      !inboundParserProductionEligible(event.connection.parserRelease) ||
      event.connection.removedAt ||
      event.channel.status !== "active" ||
      !event.hasCtwa ||
      event.classification !== "eligible_route_resolved" ||
      event.adId !== log.adId ||
      event.occurredAt.getTime() !== log.eventOccurredAt.getTime() ||
      event.resolvedBusinessConnectionId !== log.metaBusinessConnectionId ||
      event.resolvedConversionDestinationId !==
        log.metaConversionDestinationId ||
      log.dedupeKey !==
        `inbound-webhook:${event.connectionId}:${event.dedupeKey}` ||
      event.occurredAt.getTime() < Date.now() - 7 * 86400_000 ||
      event.occurredAt.getTime() > Date.now()
    )
      return false;
    if (event.replayItem) {
      if (
        !config.replayEnabled ||
        event.delivery.payloadExpiresAt <= new Date() ||
        !event.delivery.encryptedPayload ||
        !(await studentBatchAuthorizationValid(
          client,
          log.workspaceId,
          event.replayItem.batchId,
          event.id,
        ))
      )
        return false;
    } else if (
      !config.productionEnabled ||
      event.connection.status !== "production" ||
      !event.connection.productionActivatedAt ||
      !event.channel.productionActivatedAt ||
      event.delivery.firstReceivedAt < event.connection.productionActivatedAt ||
      event.delivery.firstReceivedAt < event.channel.productionActivatedAt
    )
      return false;
    const resolved = {
      businessConnectionId: event.resolvedBusinessConnectionId,
      reportingAccountId: event.resolvedReportingAccountId,
      conversionDestinationId: event.resolvedConversionDestinationId,
    };
    if (
      event.channel.routes.filter(
        (r) =>
          r.workspaceId === log.workspaceId &&
          r.active &&
          r.validationStatus === "valid" &&
          inboundMetaRouteMatches(r, resolved),
      ).length !== 1
    )
      return false;
    const route = await new InboundWebhookMetaRouteReaderService(
      client,
    ).previewRoute({
      workspaceId: log.workspaceId,
      adId: log.adId!,
      ...resolved,
    });
    return (
      route.status === "resolved" &&
      route.businessConnectionId === log.metaBusinessConnectionId &&
      route.conversionDestinationId === log.metaConversionDestinationId &&
      route.adAccountId === log.metaAccountId
    );
  }

  private inboundDispatchIdentity(log: ConversionEventLogRecord): string {
    return replayContextHash({
      workspaceId: log.workspaceId,
      eventId: log.eventId,
      dedupeKey: log.dedupeKey,
      sourceTrigger: log.sourceTrigger,
      sourcePayload: log.sourcePayload,
      adId: log.adId,
      ctwaClid: log.ctwaClid,
      phoneHash: log.phoneHash,
      eventOccurredAt: log.eventOccurredAt,
      metaAccountId: log.metaAccountId,
      businessId: log.metaBusinessConnectionId,
      destinationId: log.metaConversionDestinationId,
    });
  }

  private async claimInboundMetaDispatch(
    log: ConversionEventLogRecord,
  ): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Match final dispatch order. The claim insert itself needs the workspace
        // FK lock; taking it after the log can deadlock with a concurrent sender.
        await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${log.workspaceId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "ConversionEventLog" WHERE "id" = ${log.id} AND "workspaceId" = ${log.workspaceId} FOR UPDATE`;
        const current = await tx.conversionEventLog.findFirst({
          where: {
            id: log.id,
            workspaceId: log.workspaceId,
            status: "ready_to_send",
          },
        });
        if (
          !current ||
          this.inboundDispatchIdentity(current as ConversionEventLogRecord) !==
            this.inboundDispatchIdentity(log) ||
          !(await this.inboundMetaDispatchAuthorized(tx, log))
        )
          return false;
        // Existing AuditLog primary key supplies a permanent one-dispatch fence.
        // Crashes/timeouts never clear this claim or consume another attempt.
        await tx.auditLog.create({
          data: {
            id: `inbound-meta-dispatch:${log.id}`,
            workspaceId: log.workspaceId,
            actorType: "system",
            action: "inbound_webhook.dispatch.claim",
            targetType: "ConversionEventLog",
            targetId: log.id,
            resultStatus: "dispatch_started",
          },
        });
        return true;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        return false;
      throw error;
    }
  }

  /**
   * Kommo's background path has no HTTP guard. Use the canonical decision on
   * every side-effect boundary and deliberately fail closed if it cannot be
   * read. Inert is allowed only when the license service itself says so.
   */
  private async kommoLicenseAllows(
    client?: Prisma.TransactionClient,
  ): Promise<boolean> {
    try {
      const decision = client
        ? await this.licenseClient.getLockState(client)
        : await this.licenseClient.getLockState();
      return decision.inert || !decision.locked;
    } catch {
      return false;
    }
  }

  /** Only the Kommo consumer needs this background-write barrier. */
  private async assertKommoLicenseAllows(): Promise<void> {
    if (!(await this.kommoLicenseAllows()))
      throw new Error("kommo_license_locked");
  }

  async recordRuleMatches(
    input: RecordRuleMatchesInput,
  ): Promise<RecordRuleMatchesResult> {
    const created: string[] = [];
    const duplicates: string[] = [];
    const configuredDefaults =
      (await this.prisma.funnelStageConfiguration.findMany({
        where: {
          workspaceId: input.workspaceId,
          eventName: {
            in: Array.from(new Set(input.rules.map((rule) => rule.eventName))),
          },
        },
        select: {
          eventName: true,
          defaultValueCents: true,
          defaultCurrency: true,
          defaultContentName: true,
        },
      })) as FunnelEventDefaults[];
    const defaultsByEvent = new Map(
      configuredDefaults.map((defaults) => [defaults.eventName, defaults]),
    );

    let workspaceCurrency: string | null = null;

    for (const rule of input.rules) {
      const eventDefaults = defaultsByEvent.get(rule.eventName);
      const dedupeKey = this.buildDedupeKey(input, rule);
      const existing = (await this.prisma.conversionEventLog.findUnique({
        where: { dedupeKey },
      })) as ConversionEventLogRecord | null;

      if (existing) {
        duplicates.push(existing.id);
        continue;
      }

      const valueCents =
        input.valueCents ??
        rule.defaultValueCents ??
        eventDefaults?.defaultValueCents ??
        null;
      const initialStatus = this.resolveInitialStatus({
        eventName: rule.eventName,
        adId: input.adId,
        ctwaClid: input.ctwaClid,
        valueCents,
      });
      const customData =
        input.customData !== undefined
          ? (input.customData as Prisma.InputJsonValue)
          : rule.defaultItems
            ? ({ contents: rule.defaultItems } as Prisma.InputJsonValue)
            : Prisma.JsonNull;
      const eventOccurredAt = this.resolveEventOccurredAt(
        input.eventOccurredAt,
      );
      const customerIdentityKey = this.resolveCustomerIdentityKey(
        input.phoneHash,
      );
      const purchaseKind = await this.resolvePurchaseKind({
        workspaceId: input.workspaceId,
        eventName: rule.eventName,
        customerIdentityKey,
      });
      // Só BRL/USD/EUR contam: código fora da lista (regra gravada antes da
      // Fase 5.1) é tratado como sem moeda e herda a do workspace.
      const explicitCurrency =
        normalizeCurrencyCode(input.currency) ??
        normalizeCurrencyCode(rule.defaultCurrency) ??
        normalizeCurrencyCode(eventDefaults?.defaultCurrency) ??
        null;
      // A value always travels with a currency: venda -> regra -> workspace
      // -> BRL. Valueless events keep the historical (possibly null) currency.
      if (valueCents != null && !explicitCurrency && workspaceCurrency === null) {
        workspaceCurrency = await loadWorkspaceConversionCurrency(
          this.prisma,
          input.workspaceId,
        );
      }
      const currency =
        valueCents != null
          ? resolveConversionCurrency({
              payload: input.currency,
              rule: rule.defaultCurrency ?? eventDefaults?.defaultCurrency,
              workspace: workspaceCurrency,
            })
          : explicitCurrency;
      const log = await this.prisma.conversionEventLog.create({
        data: {
          workspaceId: input.workspaceId,
          leadId: input.leadId ?? null,
          phoneHash: input.phoneHash ?? null,
          eventOccurredAt,
          customerIdentityKey,
          businessSource: "paid",
          purchaseKind,
          sourceTrigger: rule.triggerType,
          eventName: rule.eventName,
          status: initialStatus.status,
          pixelId: rule.pixelId,
          eventId: dedupeKey,
          campaignId: input.campaignId ?? null,
          adSetId: input.adSetId ?? null,
          adId: input.adId ?? null,
          ctwaClid: input.ctwaClid ?? null,
          attributionStatus: input.adId ? "attributed" : "missing_ad_id",
          dedupeKey,
          valueCents,
          valueSource:
            input.valueCents != null
              ? "actual"
              : valueCents == null
                ? null
                : "configured_average",
          currency,
          contentName:
            input.contentName ??
            rule.defaultContentName ??
            eventDefaults?.defaultContentName ??
            null,
          customData,
          errorCode: initialStatus.errorCode,
          errorMessage: initialStatus.errorMessage,
        },
      });

      created.push(log.id);
    }

    return { created, duplicates };
  }

  async recordAutomaticLeadSubmitted(
    input: RecordAutomaticLeadSubmittedInput,
  ): Promise<RecordRuleMatchesResult> {
    const subject = input.leadId ?? input.phoneHash ?? "unknown";
    const dedupeKey = [
      input.workspaceId,
      subject,
      "auto_lead",
      "LeadSubmitted",
      input.adId ?? "missing_ad",
    ].join(":");
    const existing = (await this.prisma.conversionEventLog.findUnique({
      where: { dedupeKey },
    })) as ConversionEventLogRecord | null;

    if (existing) {
      return { created: [], duplicates: [existing.id] };
    }

    const initialStatus = this.resolveInitialStatus({
      eventName: "LeadSubmitted",
      adId: input.adId,
      ctwaClid: input.ctwaClid,
      valueCents: null,
    });
    const eventOccurredAt = this.resolveEventOccurredAt(input.eventOccurredAt);
    const customerIdentityKey = this.resolveCustomerIdentityKey(
      input.phoneHash,
    );
    const log = await this.prisma.conversionEventLog.create({
      data: {
        workspaceId: input.workspaceId,
        leadId: input.leadId ?? null,
        phoneHash: input.phoneHash ?? null,
        eventOccurredAt,
        customerIdentityKey,
        businessSource: "paid",
        purchaseKind: null,
        sourceTrigger: "auto_lead",
        eventName: "LeadSubmitted",
        status: initialStatus.status,
        pixelId: null,
        eventId: dedupeKey,
        campaignId: input.campaignId ?? null,
        adSetId: input.adSetId ?? null,
        adId: input.adId ?? null,
        ctwaClid: input.ctwaClid ?? null,
        attributionStatus: input.adId ? "attributed" : "missing_ad_id",
        dedupeKey,
        valueCents: null,
        currency: null,
        contentName: null,
        customData: Prisma.JsonNull,
        errorCode: initialStatus.errorCode,
        errorMessage: initialStatus.errorMessage,
      },
    });

    return { created: [log.id], duplicates: [] };
  }

  async recordExternalConversion(
    input: RecordExternalConversionInput,
    client: ConversionEventPrismaClient = this.prisma,
  ): Promise<RecordExternalConversionResult> {
    const existing = (await client.conversionEventLog.findUnique({
      where: { dedupeKey: input.dedupeKey },
    })) as ConversionEventLogRecord | null;

    if (
      !existing &&
      input.ctwaDestination &&
      input.eventName === "LeadSubmitted"
    ) {
      // A retained legacy parser identity and the current per-click identity
      // must share the original canonical receipt, event ID and occurrence time.
      // Both entry materializers call this under the workspace policy lock.
      const receipts = await client.conversionEventLog.findMany({
        where: {
          workspaceId: input.workspaceId,
          leadId: input.leadId,
          phoneHash: input.phoneHash,
          ctwaClid: input.ctwaClid,
          eventName: "LeadSubmitted",
          sourceTrigger: `inbound_webhook:${CTWA_DESTINATION_PROVIDER}`,
          AND: [
            {
              sourcePayload: {
                path: ["connectionId"],
                equals: input.ctwaDestination.connectionId,
              },
            },
            {
              sourcePayload: {
                path: ["channelId"],
                equals: input.ctwaDestination.channelId,
              },
            },
          ],
        },
        take: 2,
      });
      if (receipts.length > 1)
        throw new ConversionRecordError("ctwa_original_receipt_ambiguous");
      if (receipts[0])
        return {
          conversionEventLogId: receipts[0].id,
          status: "duplicate",
          deliveryStatus: receipts[0].status,
        };
    }

    if (existing) {
      if (existing.workspaceId !== input.workspaceId)
        throw new ConversionRecordError("conversion_workspace_mismatch");
      if (
        input.sourceTrigger === "kommo_stage" ||
        input.sourceTrigger === PIPEDRIVE_STAGE_TRIGGER
      )
        await this.assertKommoLicenseAllows();
      return this.reconcileExistingExternalConversion(existing, input, client);
    }

    // No ctwa_clid, no CTWA path: the page/pixel destination exists only for a
    // lead that carries the click id (the messaging pixel requires it).
    if (
      input.ctwaDestination &&
      (!input.ctwaClid?.trim() ||
        input.ctwaDestination.workspaceId !== input.workspaceId ||
        !(await ctwaIntentAuthorized(
          client as Prisma.TransactionClient,
          input.ctwaDestination,
          // Only a Kommo/Pipedrive page/pixel conversion may authorize a
          // non-Unnichat number (CRM mode); every other source is unchanged.
          { crmContext: isCrmCtwaContext(input.sourcePayload) },
        )))
    )
      throw new ConversionRecordError("ctwa_destination_not_authorized");

    const initialStatus = this.resolveExternalInitialStatus(input);
    const purchaseKind = await this.resolvePurchaseKind(
      {
        workspaceId: input.workspaceId,
        eventName: input.eventName,
        customerIdentityKey: input.phoneHash,
      },
      client,
    );

    const currency = await this.valueCurrency({
      workspaceId: input.workspaceId,
      valueCents: input.valueCents,
      currency: input.currency,
      client,
    });

    // The Purchase-kind lookup is the final awaited read before the canonical
    // log write. Restrict this barrier to the CRM consumers (Kommo,
    // Pipedrive) so other providers retain their existing behavior.
    if (
      input.sourceTrigger === "kommo_stage" ||
      input.sourceTrigger === PIPEDRIVE_STAGE_TRIGGER
    )
      await this.assertKommoLicenseAllows();

    try {
      const log = await client.conversionEventLog.create({
        data: {
          workspaceId: input.workspaceId,
          externalConnectorId: input.externalConnectorId ?? null,
          sourceEventId: input.sourceEventId,
          leadId: input.leadId ?? null,
          phoneHash: input.phoneHash,
          eventOccurredAt: input.eventOccurredAt,
          customerIdentityKey: input.phoneHash,
          businessSource: input.businessSource,
          purchaseKind,
          valueSource: input.valueSource ?? null,
          sourceTrigger: input.sourceTrigger,
          eventName: input.eventName,
          status: initialStatus.status,
          pixelId: null,
          eventId: input.eventId,
          metaAccountId: input.metaAccountId ?? null,
          metaBusinessConnectionId:
            input.ctwaDestination?.businessConnectionId ??
            input.metaBusinessConnectionId ??
            null,
          metaConversionDestinationId:
            input.ctwaDestination?.destinationId ??
            input.metaConversionDestinationId ??
            null,
          campaignId: input.campaignId ?? null,
          adSetId: input.adSetId ?? null,
          adId: input.adId ?? null,
          ctwaClid: input.ctwaClid ?? null,
          // A CTWA destination decision never resolves the ad hierarchy: an ad
          // id carried with it is an unverified hint, not an attribution.
          attributionStatus: input.ctwaDestination
            ? input.adId
              ? "ctwa_ad_hint"
              : "ctwa_ad_unknown"
            : input.adId
              ? "attributed"
              : "organic_or_unattributed",
          dedupeKey: input.dedupeKey,
          valueCents: input.valueCents ?? null,
          currency,
          contentName: input.contentName ?? null,
          sourcePayload: input.ctwaDestination
            ? ({
                ...input.sourcePayload,
                ctwaDestination: input.ctwaDestination,
              } as Prisma.InputJsonValue)
            : input.sourcePayload
              ? (input.sourcePayload as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          customData: Prisma.JsonNull,
          errorCode: initialStatus.errorCode,
          errorMessage: initialStatus.errorMessage,
        },
      });

      return {
        conversionEventLogId: log.id,
        status: "created",
        deliveryStatus: log.status,
      };
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) {
        throw error;
      }

      const duplicate = (await client.conversionEventLog.findUnique({
        where: { dedupeKey: input.dedupeKey },
      })) as ConversionEventLogRecord | null;

      if (!duplicate) {
        throw error;
      }

      return {
        conversionEventLogId: duplicate.id,
        status: "duplicate",
        deliveryStatus: duplicate.status,
      };
    }
  }

  private async reconcileExistingExternalConversion(
    existing: ConversionEventLogRecord,
    input: RecordExternalConversionInput,
    client: ConversionEventPrismaClient,
  ): Promise<RecordExternalConversionResult> {
    const promotesHistoricalEvent =
      existing.status === "imported" && input.deliveryStatus !== "imported";
    const promotedStatus: InitialStatus | null = promotesHistoricalEvent
      ? this.resolveExternalInitialStatus(input)
      : null;
    const businessSource =
      existing.businessSource === "paid" || input.businessSource !== "paid"
        ? existing.businessSource
        : "paid";
    const adId = existing.adId ?? input.adId ?? null;
    // Um valor que chega agora num evento sem valor leva a moeda da venda ou,
    // sem ela, a "Moeda das conversões" do workspace. Evento que já tinha
    // valor guarda a moeda que tinha (eventos antigos não mudam).
    const currency =
      existing.valueCents != null
        ? existing.currency
        : await this.valueCurrency({
            workspaceId: input.workspaceId,
            valueCents: input.valueCents,
            currency: input.currency,
            client,
          });
    const updated = (await client.conversionEventLog.update({
      where: { id: existing.id },
      data: {
        leadId: existing.leadId ?? input.leadId ?? null,
        phoneHash: existing.phoneHash ?? input.phoneHash,
        customerIdentityKey: existing.customerIdentityKey ?? input.phoneHash,
        businessSource,
        campaignId: existing.campaignId ?? input.campaignId ?? null,
        adSetId: existing.adSetId ?? input.adSetId ?? null,
        adId,
        metaAccountId: existing.metaAccountId ?? input.metaAccountId ?? null,
        metaBusinessConnectionId:
          existing.metaBusinessConnectionId ??
          input.metaBusinessConnectionId ??
          null,
        metaConversionDestinationId:
          existing.metaConversionDestinationId ??
          input.metaConversionDestinationId ??
          null,
        ctwaClid: existing.ctwaClid ?? input.ctwaClid ?? null,
        // A CTWA ad hint stays a hint until the ad hierarchy is attributed.
        attributionStatus:
          existing.attributionStatus === "ctwa_ad_hint" &&
          !(
            (existing.metaAccountId ?? input.metaAccountId) &&
            (existing.campaignId ?? input.campaignId)
          )
            ? "ctwa_ad_hint"
            : adId
              ? "attributed"
              : existing.attributionStatus,
        valueCents: existing.valueCents ?? input.valueCents ?? null,
        valueSource: existing.valueSource ?? input.valueSource ?? null,
        currency,
        ...(existing.sourcePayload == null && input.sourcePayload
          ? { sourcePayload: input.sourcePayload as Prisma.InputJsonValue }
          : {}),
        ...(promotesHistoricalEvent
          ? {
              sourceEventId: input.sourceEventId,
              sourceTrigger: input.sourceTrigger,
              eventId: input.eventId,
              eventOccurredAt: input.eventOccurredAt,
              status: promotedStatus?.status,
              errorCode: promotedStatus?.errorCode,
              errorMessage: promotedStatus?.errorMessage,
            }
          : {}),
      },
    })) as ConversionEventLogRecord;

    return {
      conversionEventLogId: existing.id,
      status: promotesHistoricalEvent ? "created" : "duplicate",
      deliveryStatus: updated.status,
    };
  }

  /**
   * Currency stored with a conversion value: the caller's (sale/deal or rule)
   * currency when given, else the workspace "Moeda das conversoes" (BRL by
   * default). Valueless events keep whatever the caller sent (usually null).
   */
  private async valueCurrency(input: {
    workspaceId: string;
    valueCents?: number | null;
    currency?: string | null;
    client?: unknown;
  }): Promise<string | null> {
    // Nunca grava código fora de BRL/USD/EUR: sem moeda válida, a do workspace.
    const explicit = normalizeCurrencyCode(input.currency);
    if (input.valueCents == null || explicit) return explicit;
    const client = input.client as { workspace?: unknown } | undefined;

    return loadWorkspaceConversionCurrency(
      client?.workspace ? client : this.prisma,
      input.workspaceId,
    );
  }

  async listReadyLogIds(logIds: string[]): Promise<string[]> {
    if (logIds.length === 0) {
      return [];
    }

    const logs = (await this.prisma.conversionEventLog.findMany({
      where: {
        id: { in: logIds },
        status: "ready_to_send",
      },
      select: { id: true },
    })) as Array<{ id: string }>;

    return logs.map((log) => log.id);
  }

  async sendManualTestEvent(
    input: SendManualTestEventInput,
  ): Promise<SendReadyEventResult> {
    const subject = input.leadId ?? input.phoneHash ?? "unknown";
    const dedupeKey = [
      input.workspaceId,
      subject,
      "manual_test",
      input.eventName,
      input.adId ?? "missing_ad",
      Date.now(),
      randomUUID(),
    ].join(":");
    const initialStatus = this.resolveInitialStatus({
      eventName: input.eventName,
      adId: input.adId,
      ctwaClid: input.ctwaClid,
      valueCents: input.valueCents ?? null,
    });
    const eventOccurredAt = this.resolveEventOccurredAt();
    const customerIdentityKey = this.resolveCustomerIdentityKey(
      input.phoneHash,
    );
    const currency = await this.valueCurrency({
      workspaceId: input.workspaceId,
      valueCents: input.valueCents,
      currency: input.currency,
    });
    const log = await this.prisma.conversionEventLog.create({
      data: {
        workspaceId: input.workspaceId,
        leadId: input.leadId ?? null,
        phoneHash: input.phoneHash,
        eventOccurredAt,
        customerIdentityKey,
        businessSource: "paid",
        purchaseKind: null,
        sourceTrigger: "manual_test",
        eventName: input.eventName,
        status: initialStatus.status,
        pixelId: null,
        eventId: dedupeKey,
        campaignId: null,
        adSetId: null,
        adId: input.adId ?? null,
        ctwaClid: input.ctwaClid ?? null,
        attributionStatus: "manual_test",
        dedupeKey,
        valueCents: input.valueCents ?? null,
        currency,
        contentName: input.contentName ?? null,
        customData: Prisma.JsonNull,
        errorCode: initialStatus.errorCode,
        errorMessage: initialStatus.errorMessage,
      },
    });

    if (initialStatus.status !== "ready_to_send") {
      return {
        conversionEventLogId: log.id,
        workspaceId: input.workspaceId,
        status: "not_configured",
      };
    }

    return this.sendReadyEvent(log.id, {
      workspaceId: input.workspaceId,
      testEventCode: input.testEventCode,
    });
  }

  /** Only an undispatched, ready event can be published. Fetch supplies no retry proof. */
  async prepareKommoSenderRetry(
    logId: string,
    workspaceId: string,
  ): Promise<string> {
    if (!(await this.kommoLicenseAllows())) return "license_locked";
    return this.prisma.$transaction(async (tx) => {
      const snapshot = await tx.kommoConversionDedupe.findFirst({
        where: { workspaceId, conversionEventLogId: logId },
      });
      const target =
        snapshot?.publicationIntent as KommoPublicationIntent | null;
      if (!snapshot || !target) return "error";
      await tx.$queryRaw`SELECT "id" FROM "KommoConnection" WHERE "id" = ${target.connectionId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
      const intent = await tx.kommoConversionDedupe.findFirst({
        where: { id: snapshot.id, workspaceId },
      });
      const log = await tx.conversionEventLog.findFirst({
        where: { id: logId, workspaceId, sourceTrigger: "kommo_stage" },
      });
      if (!intent || !log || log.eventId !== target.eventId) return "error";
      const outcome = await settleKommoSenderOutcome(tx, intent, log);
      if (outcome === "sent" || outcome === "delivery_unknown") return outcome;
      if (!(await kommoPublicationAuthorized(tx, workspaceId, target)))
        return "revoked";
      if (intent.senderAttempts >= 5) return "error";
      return outcome;
    });
  }

  private async claimKommoSender(
    log: ConversionEventLogRecord,
    target: KommoPublicationIntent,
  ): Promise<string | null> {
    if (!log.workspaceId) return null;
    if (!(await this.kommoLicenseAllows())) return null;
    const workspaceId = log.workspaceId;
    const token = randomUUID();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "KommoConnection" WHERE "id" = ${target.connectionId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
      if (!(await kommoPublicationAuthorized(tx, workspaceId, target)))
        return null;
      const current = await tx.conversionEventLog.findFirst({
        where: {
          id: log.id,
          workspaceId,
          sourceTrigger: "kommo_stage",
          status: "ready_to_send",
          eventId: target.eventId,
        },
      });
      if (!current) return null;
      const claim = await tx.kommoConversionDedupe.updateMany({
        where: {
          workspaceId,
          conversionEventLogId: log.id,
          senderLeaseToken: null,
          // No transport-supported proof of non-delivery exists. One dispatch only.
          senderAttempts: 0,
          publicationStatus: { not: "delivery_unknown" },
        },
        data: {
          senderLeaseToken: token,
          senderRetryable: false,
          senderAttempts: { increment: 1 },
        },
      });
      return claim.count ? token : null;
    });
  }

  /** Pipedrive counterpart of prepareKommoSenderRetry (own ledger table). */
  async preparePipedriveSenderRetry(
    logId: string,
    workspaceId: string,
  ): Promise<string> {
    if (!(await this.kommoLicenseAllows())) return "license_locked";
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockKommoDispatch(tx, workspaceId);
        const snapshot = await tx.pipedriveConversionDedupe.findFirst({
          where: { workspaceId, conversionEventLogId: logId },
        });
        const target = pipedriveRouteIntent(snapshot?.publicationIntent);
        if (!snapshot || !target) return "error";
        await lockPipedriveConnection(tx, workspaceId, target.connectionId);
        const intent = await tx.pipedriveConversionDedupe.findFirst({
          where: { id: snapshot.id, workspaceId },
        });
        const log = await tx.conversionEventLog.findFirst({
          where: {
            id: logId,
            workspaceId,
            sourceTrigger: PIPEDRIVE_STAGE_TRIGGER,
          },
        });
        if (!intent || !log || log.eventId !== target.eventId) return "error";
        const outcome = await settlePipedriveSenderOutcome(tx, intent, log);
        if (outcome === "sent" || outcome === "delivery_unknown")
          return outcome;
        if (!(await pipedriveDispatchAuthorized(tx, workspaceId, target)))
          return "revoked";
        // senderAttempts is 0 or 1 (SQL CHECK): one dispatch only, no counter.
        return outcome;
      });
    } catch {
      throw new ServiceUnavailableException("pipedrive_sender_failed");
    }
  }

  /**
   * Ad-attributed Pipedrive conversion: same single-dispatch contract as the
   * Kommo branch of sendReadyEvent, on the Pipedrive ledger. (A CTWA destination
   * Pipedrive conversion never gets here: it follows sendCtwaEvent.)
   */
  private async sendPipedriveStageEvent(
    log: ConversionEventLogRecord,
    eventId: string,
    options: SendReadyEventOptions,
  ): Promise<SendReadyEventResult> {
    const skipped = {
      conversionEventLogId: log.id,
      workspaceId: log.workspaceId,
      status: "skipped" as const,
    };
    const workspaceId = log.workspaceId;
    if (!workspaceId) return { ...skipped, workspaceId: null };
    // No HTTP guard in the background sender: a locked license sends nothing.
    if (!(await this.kommoLicenseAllows())) return skipped;
    const ledger = await this.prisma.pipedriveConversionDedupe.findFirst({
      where: { workspaceId, conversionEventLogId: log.id },
    });
    const target = pipedriveRouteIntent(ledger?.publicationIntent);
    if (!(await pipedriveDispatchAuthorized(this.prisma, workspaceId, target))) {
      await this.prisma.conversionEventLog.updateMany({
        where: { id: log.id, status: "ready_to_send" },
        data: {
          errorCode: "pipedrive_publication_revoked",
          errorMessage: "Autorização de publicação indisponível",
        },
      });
      return skipped;
    }
    const intent = target!;
    const startedAt = new Date();
    const resolvedDestination = await this.resolveDeliveryRoute(log);
    if (
      resolvedDestination.pixelId !== intent.pixelId ||
      resolvedDestination.pageId !== intent.pageId ||
      resolvedDestination.businessConnectionId !==
        intent.businessConnectionId ||
      resolvedDestination.conversionDestinationId !== intent.destinationId ||
      !resolvedDestination.accessToken?.trim() ||
      !(await pipedriveDispatchAuthorized(this.prisma, workspaceId, intent))
    )
      resolvedDestination.routeError = "Rota Pipedrive autorizada indisponivel";
    const senderToken = randomUUID();
    const claimed = await this.prisma.$transaction(async (tx) => {
      if (!(await this.kommoLicenseAllows(tx))) return null;
      await lockPipedriveConnection(tx, workspaceId, intent.connectionId);
      if (!(await pipedriveDispatchAuthorized(tx, workspaceId, intent)))
        return null;
      const current = await tx.conversionEventLog.findFirst({
        where: {
          id: log.id,
          workspaceId,
          sourceTrigger: PIPEDRIVE_STAGE_TRIGGER,
          status: "ready_to_send",
          eventId: intent.eventId,
        },
      });
      if (!current) return null;
      const claim = await tx.pipedriveConversionDedupe.updateMany({
        where: {
          workspaceId,
          conversionEventLogId: log.id,
          senderLeaseToken: null,
          senderAttempts: 0,
          publicationStatus: { not: "delivery_unknown" },
        },
        data: {
          senderLeaseToken: senderToken,
          senderRetryable: false,
          senderAttempts: { increment: 1 },
        },
      });
      return claim.count === 1 ? senderToken : null;
    });
    if (!claimed) return skipped;
    const adapterInput = {
      accessToken: resolvedDestination.accessToken,
      pixelId: resolvedDestination.pixelId,
      pageId: resolvedDestination.pageId,
      eventName: log.eventName,
      dedupeKey: eventId,
      phoneHash: log.phoneHash,
      adId: log.adId,
      ctwaClid: log.ctwaClid,
      valueCents: log.valueCents,
      currency: log.currency,
      contentName: log.contentName,
      customData: log.customData as ConversionEventCustomDataDto | null,
      eventTime: log.eventOccurredAt,
      testEventCode: options.testEventCode ?? null,
    };
    const dispatch = async () => {
      const deadline = performance.now() + KOMMO_DISPATCH_START_MS;
      const started = await this.prisma.$transaction(
        async (tx) => {
          await lockKommoDispatch(tx, workspaceId);
          await lockPipedriveConnection(tx, workspaceId, intent.connectionId);
          const owned = await tx.pipedriveConversionDedupe.findFirst({
            where: {
              workspaceId,
              conversionEventLogId: log.id,
              senderLeaseToken: senderToken,
              senderAttempts: 1,
              senderRetryable: false,
              publicationStatus: { not: "delivery_unknown" },
            },
          });
          const current = await tx.conversionEventLog.findFirst({
            where: {
              id: log.id,
              workspaceId,
              sourceTrigger: PIPEDRIVE_STAGE_TRIGGER,
              status: "ready_to_send",
              eventId,
            },
          });
          if (
            !owned ||
            !current ||
            !Object.entries(intent).every(
              ([key, value]) =>
                (owned.publicationIntent as Record<string, unknown> | null)?.[
                  key
                ] === value,
            ) ||
            !(await pipedriveDispatchAuthorized(tx, workspaceId, intent))
          )
            throw new Error("pipedrive_dispatch_revoked");
          // Final authorization point before the synchronous provider start.
          if (!(await this.kommoLicenseAllows(tx)))
            throw new Error("pipedrive_license_locked");
          const delivery = this.metaCapiAdapter.sendEvent(adapterInput, {
            beforeDispatch: () => {
              if (performance.now() >= deadline)
                throw new Error("pipedrive_dispatch_deadline");
            },
            signal: AbortSignal.timeout(KOMMO_NETWORK_MS),
          });
          void delivery.catch(() => undefined);
          return { delivery };
        },
        {
          maxWait: KOMMO_DISPATCH_START_MS,
          timeout: KOMMO_DISPATCH_TRANSACTION_MS,
        },
      );
      return started.delivery;
    };
    let adapterResult;
    try {
      adapterResult = resolvedDestination.routeError
        ? {
            status: "not_configured" as const,
            requestPayload: null,
            responseSummary: { routeResolution: "blocked" },
            errorMessage: resolvedDestination.routeError,
            errorCode: "MissingMetaDestination" as const,
          }
        : await dispatch();
    } catch (error) {
      // A pre-dispatch license lock proves no provider request occurred:
      // release only this claim so the conversion can go out once unlocked.
      if (error instanceof Error && error.message === "pipedrive_license_locked") {
        await this.prisma.pipedriveConversionDedupe.updateMany({
          where: {
            workspaceId,
            conversionEventLogId: log.id,
            senderLeaseToken: senderToken,
            senderAttempts: 1,
          },
          data: {
            senderLeaseToken: null,
            senderRetryable: false,
            senderAttempts: 0,
          },
        });
        return skipped;
      }
      throw error;
    }
    const unknownOutcome =
      adapterResult.errorCode === "MetaCapiNetworkError" ||
      adapterResult.errorCode === "MetaCapiDeliveryUnknown";
    const result = unknownOutcome
      ? {
          ...adapterResult,
          errorCode: "MetaCapiDeliveryUnknown" as const,
          errorMessage: KOMMO_DELIVERY_UNKNOWN_MESSAGE,
        }
      : adapterResult;
    const integrationLogId = await this.recordMetaCapiIntegrationLog(
      log,
      startedAt,
      result,
      resolvedDestination,
    );
    await this.prisma.$transaction(async (tx) => {
      await lockKommoDispatch(tx, workspaceId);
      const owned = await tx.pipedriveConversionDedupe.findFirst({
        where: {
          workspaceId,
          conversionEventLogId: log.id,
          senderLeaseToken: senderToken,
        },
      });
      if (!owned) throw new Error("pipedrive_sender_lease_lost");
      const written = await tx.conversionEventLog.updateMany({
        where: { id: log.id, workspaceId, status: "ready_to_send", eventId },
        data: {
          status: result.status,
          sentAt: result.status === "sent" ? new Date() : null,
          pixelId: resolvedDestination.pixelId,
          pageId: resolvedDestination.pageId,
          ...(resolvedDestination.source === "manual"
            ? {
                metaAccountId: resolvedDestination.adAccountId,
                metaBusinessConnectionId:
                  resolvedDestination.businessConnectionId,
                metaConversionDestinationId:
                  resolvedDestination.conversionDestinationId,
              }
            : {}),
          providerRequestPayload: result.requestPayload
            ? (result.requestPayload as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          providerResponseSummary: result.responseSummary
            ? (result.responseSummary as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        },
      });
      if (!written.count) throw new Error("pipedrive_sender_state_changed");
      await tx.pipedriveConversionDedupe.updateMany({
        where: { id: owned.id, senderLeaseToken: senderToken },
        data: {
          senderLeaseToken: unknownOutcome ? senderToken : null,
          senderRetryable: false,
          ...(unknownOutcome
            ? {
                publicationStatus: "delivery_unknown",
                publicationErrorCode: PIPEDRIVE_DELIVERY_UNKNOWN,
              }
            : {
                publicationStatus:
                  result.status === "sent" ? "sent" : "publication_failed",
                publicationErrorCode:
                  result.status === "sent" ? null : "sender_not_ready",
              }),
        },
      });
    });
    await this.syncProviderConversionDelivery(log, result);
    await this.recordMetaCapiDiagnosticEvent(
      log,
      result,
      integrationLogId,
      resolvedDestination,
    );
    return {
      conversionEventLogId: log.id,
      workspaceId,
      status: result.status,
      ...(unknownOutcome
        ? { errorCode: result.errorCode, errorMessage: result.errorMessage }
        : {}),
    };
  }

  async sendReadyEvent(
    logId: string,
    options: SendReadyEventOptions = {},
  ): Promise<SendReadyEventResult> {
    let log = (await this.prisma.conversionEventLog.findUnique({
      where: {
        id: logId,
        ...(options.workspaceId === undefined
          ? {}
          : { workspaceId: options.workspaceId }),
      },
    })) as ConversionEventLogRecord | null;

    if (!log && options.workspaceId !== undefined) {
      throw new NotFoundException("Evento de conversao nao encontrado");
    }

    if (
      (log?.sourceTrigger === "kommo_stage" ||
        log?.sourceTrigger === PIPEDRIVE_STAGE_TRIGGER) &&
      !(await this.kommoLicenseAllows())
    ) {
      return {
        conversionEventLogId: log.id,
        workspaceId: log.workspaceId,
        status: "skipped",
      };
    }

    if (
      log?.sourceTrigger === "kommo_stage" &&
      log.workspaceId &&
      log.status === "error" &&
      // A Kommo page/pixel (CTWA) conversion has no route sender ledger.
      !this.ctwaIntent(log)
    ) {
      await this.prepareKommoSenderRetry(logId, log.workspaceId);
      log = (await this.prisma.conversionEventLog.findUnique({
        where: { id: logId, workspaceId: log.workspaceId },
      })) as ConversionEventLogRecord | null;
    }
    if (
      log?.sourceTrigger === PIPEDRIVE_STAGE_TRIGGER &&
      log.workspaceId &&
      log.status === "error" &&
      !this.ctwaIntent(log)
    ) {
      await this.preparePipedriveSenderRetry(logId, log.workspaceId);
      log = (await this.prisma.conversionEventLog.findUnique({
        where: { id: logId, workspaceId: log.workspaceId },
      })) as ConversionEventLogRecord | null;
    }

    const eventId = log?.eventId ?? log?.dedupeKey ?? null;
    if (!log || log.status !== "ready_to_send" || !eventId) {
      return {
        conversionEventLogId: logId,
        workspaceId: null,
        status: "skipped",
      };
    }

    if (!(await this.externalCapiDeliveryOwnedByWppTrack(log))) {
      await this.prisma.conversionEventLog.updateMany({
        where: { id: log.id, status: "ready_to_send" },
        data: {
          status: "shadow_observed",
          errorCode: null,
          errorMessage: null,
        },
      });

      return {
        conversionEventLogId: log.id,
        workspaceId: log.workspaceId,
        status: "skipped",
      };
    }

    // CTWA lead with ctwa_clid and no known ad: dispatched only to the
    // authorized page/pixel of its WhatsApp number, re-verified at send time.
    const ctwaIntent = this.ctwaIntent(log);
    if (ctwaIntent) return this.sendCtwaEvent(log, ctwaIntent);
    // A malformed destination marker cannot fall back to canonical or legacy tokens.
    if (
      log.sourcePayload &&
      typeof log.sourcePayload === "object" &&
      !Array.isArray(log.sourcePayload) &&
      "ctwaDestination" in log.sourcePayload
    )
      return this.recordCtwaSendSkip(log, "ctwa_destination_malformed");
    if (log.sourceTrigger === PIPEDRIVE_STAGE_TRIGGER)
      // Constant public error: never leak provider/database text upward.
      return this.sendPipedriveStageEvent(log, eventId, options).catch(() => {
        throw new ServiceUnavailableException("pipedrive_sender_failed");
      });

    if (
      log.sourceTrigger === "inbound_webhook:meta_cloud" &&
      (await this.prisma.auditLog.findFirst({
        where: { id: `inbound-meta-dispatch:${log.id}` },
        select: { id: true },
      }))
    ) {
      return {
        conversionEventLogId: log.id,
        workspaceId: log.workspaceId,
        status: "skipped",
      };
    }

    let kommoIntent: KommoPublicationIntent | null = null;
    if (log.sourceTrigger === "kommo_stage") {
      if (!log.workspaceId) {
        return {
          conversionEventLogId: log.id,
          workspaceId: null,
          status: "skipped",
        };
      }
      const intent = await this.prisma.kommoConversionDedupe.findFirst({
        where: { workspaceId: log.workspaceId, conversionEventLogId: log.id },
      });
      kommoIntent = intent?.publicationIntent as KommoPublicationIntent;
      if (
        !(await kommoPublicationAuthorized(
          this.prisma,
          log.workspaceId,
          kommoIntent,
        ))
      ) {
        await this.prisma.conversionEventLog.updateMany({
          where: { id: log.id, status: "ready_to_send" },
          data: {
            errorCode: "kommo_publication_revoked",
            errorMessage: "Autorizacao de publicacao indisponivel",
          },
        });
        return {
          conversionEventLogId: log.id,
          workspaceId: log.workspaceId,
          status: "skipped",
        };
      }
    }

    const startedAt = new Date();
    const resolvedDestination = await this.resolveDeliveryRoute(log);
    if (
      kommoIntent &&
      (resolvedDestination.pixelId !== kommoIntent.pixelId ||
        resolvedDestination.pageId !== kommoIntent.pageId ||
        resolvedDestination.businessConnectionId !==
          kommoIntent.businessConnectionId ||
        resolvedDestination.conversionDestinationId !==
          kommoIntent.destinationId ||
        !log.workspaceId ||
        !(await kommoPublicationAuthorized(
          this.prisma,
          log.workspaceId,
          kommoIntent,
        )))
    )
      resolvedDestination.routeError = "Rota Kommo autorizada indisponivel";
    const adapterInput = {
      accessToken: resolvedDestination.accessToken,
      pixelId: resolvedDestination.pixelId,
      pageId: resolvedDestination.pageId,
      eventName: log.eventName,
      dedupeKey: eventId,
      phoneHash: log.phoneHash,
      adId: log.adId,
      ctwaClid: log.ctwaClid,
      valueCents: log.valueCents,
      currency: log.currency,
      contentName: log.contentName,
      customData: log.customData as ConversionEventCustomDataDto | null,
      eventTime: log.eventOccurredAt,
      testEventCode: options.testEventCode ?? null,
    };
    const preflight = resolvedDestination.routeError
      ? {
          status: "not_configured" as const,
          requestPayload: null,
          responseSummary: { routeResolution: "blocked" },
          errorMessage: resolvedDestination.routeError,
          errorCode: "MissingMetaDestination" as const,
        }
      : kommoIntent || log.sourceTrigger === "inbound_webhook:meta_cloud"
        ? preflightMetaCapiEvent(adapterInput)
        : null;
    // Rejected configuration does not consume the one durable dispatch attempt.
    const senderToken =
      kommoIntent && !preflight
        ? await this.claimKommoSender(log, kommoIntent)
        : null;
    if (kommoIntent && !preflight && !senderToken)
      return {
        conversionEventLogId: log.id,
        workspaceId: log.workspaceId,
        status: "skipped",
      };
    const inboundClaim =
      log.sourceTrigger === "inbound_webhook:meta_cloud" && !preflight;
    if (inboundClaim && !(await this.claimInboundMetaDispatch(log)))
      return {
        conversionEventLogId: log.id,
        workspaceId: log.workspaceId,
        status: "skipped",
      };
    // The durable claim is separate and never expires, including on failure
    // here. An ordinary post-claim read would still leave a TOCTOU window.
    const dispatchKommo = async () => {
      const deadline = performance.now() + KOMMO_DISPATCH_START_MS;
      const started = await this.prisma.$transaction(
        async (tx) => {
          await lockKommoDispatch(tx, log.workspaceId!);
          await tx.$queryRaw`SELECT "id" FROM "KommoConnection" WHERE "id" = ${kommoIntent!.connectionId} AND "workspaceId" = ${log.workspaceId!} FOR UPDATE`;
          const owned = await tx.kommoConversionDedupe.findFirst({
            where: {
              workspaceId: log.workspaceId!,
              conversionEventLogId: log.id,
              senderLeaseToken: senderToken,
              senderAttempts: 1,
              senderRetryable: false,
              publicationStatus: { not: "delivery_unknown" },
            },
          });
          const current = await tx.conversionEventLog.findFirst({
            where: {
              id: log.id,
              workspaceId: log.workspaceId!,
              sourceTrigger: "kommo_stage",
              status: "ready_to_send",
              eventId,
            },
          });
          if (
            !owned ||
            !current ||
            !Object.entries(kommoIntent!).every(
              ([key, value]) =>
                (owned.publicationIntent as Record<string, unknown> | null)?.[
                  key
                ] === value,
            ) ||
            !(await kommoPublicationAuthorized(
              tx,
              log.workspaceId!,
              kommoIntent!,
            ))
          )
            throw new Error("kommo_dispatch_revoked");
          // This is the final authorization point before synchronous provider
          // dispatch. It catches a lock acquired after the durable sender claim.
          if (!(await this.kommoLicenseAllows()))
            throw new Error("kommo_license_locked");
          // sendEvent invokes fetch synchronously before its first await. Return
          // a holder rather than the promise: commit/release without awaiting
          // network I/O. The provider start is the dispatch linearization point.
          const delivery = this.metaCapiAdapter.sendEvent(adapterInput, {
            beforeDispatch: () => {
              if (performance.now() >= deadline)
                throw new Error("kommo_dispatch_deadline");
            },
            signal: AbortSignal.timeout(KOMMO_NETWORK_MS),
          });
          // Observe rejection even if commit fails after dispatch. The original
          // promise is still awaited on success; the durable claim stays fenced.
          void delivery.catch(() => undefined);
          return { delivery };
        },
        {
          maxWait: KOMMO_DISPATCH_START_MS,
          timeout: KOMMO_DISPATCH_TRANSACTION_MS,
        },
      );
      return started.delivery;
    };
    const dispatchInbound = async () => {
      const source = log.sourcePayload as { inboundEventId?: string } | null;
      if (!source?.inboundEventId || !log.workspaceId) return null;
      const deadline = performance.now() + INBOUND_DISPATCH_START_MS;
      const started = await this.prisma.$transaction(
        async (tx) => {
          await lockInboundMetaDispatch(
            tx,
            log.workspaceId!,
            log.id,
            source.inboundEventId!,
          );
          const current = await tx.conversionEventLog.findFirst({
            where: {
              id: log.id,
              workspaceId: log.workspaceId,
              status: "ready_to_send",
            },
          });
          if (
            !current ||
            this.inboundDispatchIdentity(
              current as ConversionEventLogRecord,
            ) !== this.inboundDispatchIdentity(log)
          )
            return null;
          const freshRoute = await this.resolveDeliveryRoute(log, tx);
          if (
            freshRoute.routeError ||
            freshRoute.accessToken !== resolvedDestination.accessToken ||
            freshRoute.pixelId !== resolvedDestination.pixelId ||
            freshRoute.pageId !== resolvedDestination.pageId ||
            freshRoute.businessConnectionId !==
              resolvedDestination.businessConnectionId ||
            freshRoute.conversionDestinationId !==
              resolvedDestination.conversionDestinationId ||
            freshRoute.reportingAccountId !==
              resolvedDestination.reportingAccountId ||
            !(await this.inboundMetaDispatchAuthorized(tx, log))
          )
            return null;
          // All PG authorities stay locked across the last license read. Nothing
          // asynchronous follows this final decision before synchronous fetch start.
          if (!(await this.kommoLicenseAllows(tx))) return null;
          const delivery = this.metaCapiAdapter.sendEvent(adapterInput, {
            beforeDispatch: () => {
              if (performance.now() >= deadline)
                throw new Error("inbound_dispatch_deadline");
            },
            signal: AbortSignal.timeout(INBOUND_NETWORK_MS),
          });
          void delivery.catch(() => undefined);
          return { delivery };
        },
        {
          maxWait: INBOUND_DISPATCH_START_MS,
          timeout: INBOUND_DISPATCH_TRANSACTION_MS,
        },
      );
      return started ? started.delivery : null;
    };
    let adapterResult;
    try {
      adapterResult =
        preflight ??
        (kommoIntent
          ? await dispatchKommo()
          : inboundClaim
            ? await dispatchInbound()
            : await this.metaCapiAdapter.sendEvent(adapterInput));
      if (!adapterResult)
        return {
          conversionEventLogId: log.id,
          workspaceId: log.workspaceId,
          status: "skipped",
        };
    } catch (error) {
      if (
        senderToken &&
        log.workspaceId &&
        error instanceof Error &&
        error.message === "kommo_license_locked"
      ) {
        await this.releaseKommoSenderClaim(log, senderToken);
        return {
          conversionEventLogId: log.id,
          workspaceId: log.workspaceId,
          status: "skipped",
        };
      }
      throw error;
    }
    const unknownOutcome = Boolean(
      (kommoIntent || inboundClaim) &&
      (adapterResult.errorCode === "MetaCapiNetworkError" ||
        adapterResult.errorCode === "MetaCapiDeliveryUnknown"),
    );
    const result = unknownOutcome
      ? {
          ...adapterResult,
          errorCode: "MetaCapiDeliveryUnknown" as const,
          errorMessage: KOMMO_DELIVERY_UNKNOWN_MESSAGE,
        }
      : adapterResult;
    const integrationLogId = await this.recordMetaCapiIntegrationLog(
      log,
      startedAt,
      result,
      resolvedDestination,
    );

    const deliveryData = {
      status: result.status,
      sentAt: result.status === "sent" ? new Date() : null,
      pixelId: resolvedDestination.pixelId,
      pageId: resolvedDestination.pageId,
      ...(resolvedDestination.source === "manual"
        ? {
            metaAccountId: resolvedDestination.adAccountId,
            metaBusinessConnectionId: resolvedDestination.businessConnectionId,
            metaConversionDestinationId:
              resolvedDestination.conversionDestinationId,
          }
        : {}),
      providerRequestPayload: result.requestPayload
        ? (result.requestPayload as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      providerResponseSummary: result.responseSummary
        ? (result.responseSummary as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    };
    if (senderToken && log.workspaceId) {
      await this.prisma.$transaction(async (tx) => {
        await lockKommoDispatch(tx, log.workspaceId!);
        const owned = await tx.kommoConversionDedupe.findFirst({
          where: {
            workspaceId: log.workspaceId!,
            conversionEventLogId: log.id,
            senderLeaseToken: senderToken,
          },
        });
        if (!owned) throw new Error("kommo_sender_lease_lost");
        const written = await tx.conversionEventLog.updateMany({
          where: {
            id: log.id,
            workspaceId: log.workspaceId,
            status: "ready_to_send",
            eventId,
          },
          data: deliveryData,
        });
        if (!written.count) throw new Error("kommo_sender_state_changed");
        await tx.kommoConversionDedupe.updateMany({
          where: { id: owned.id, senderLeaseToken: senderToken },
          data: {
            senderLeaseToken: unknownOutcome ? senderToken : null,
            senderRetryable: false,
            ...(unknownOutcome
              ? {
                  publicationStatus: "delivery_unknown",
                  publicationErrorCode: KOMMO_DELIVERY_UNKNOWN,
                }
              : {
                  publicationStatus:
                    result.status === "sent" ? "sent" : "publication_failed",
                  publicationErrorCode:
                    result.status === "sent" ? null : "sender_not_ready",
                }),
          },
        });
      });
    } else if (kommoIntent && log.workspaceId) {
      const written = await this.prisma.$transaction(async (tx) => {
        await lockKommoDispatch(tx, log.workspaceId!);
        const pending = await tx.kommoConversionDedupe.findFirst({
          where: {
            workspaceId: log.workspaceId!,
            conversionEventLogId: log.id,
            senderAttempts: 0,
            senderLeaseToken: null,
            publicationStatus: { not: "delivery_unknown" },
          },
        });
        if (
          !pending ||
          kommoIntent!.eventId !== eventId ||
          !Object.entries(kommoIntent!).every(
            ([key, value]) =>
              (pending.publicationIntent as Record<string, unknown> | null)?.[
                key
              ] === value,
          ) ||
          !(await kommoPublicationAuthorized(
            tx,
            log.workspaceId!,
            kommoIntent!,
          ))
        )
          return false;
        const updated = await tx.conversionEventLog.updateMany({
          where: {
            id: log.id,
            workspaceId: log.workspaceId!,
            status: "ready_to_send",
            eventId,
          },
          data: deliveryData,
        });
        return Boolean(updated.count);
      });
      if (!written)
        return {
          conversionEventLogId: log.id,
          workspaceId: log.workspaceId,
          status: "skipped",
        };
    } else if (
      log.sourceTrigger === "inbound_webhook:meta_cloud" &&
      preflight
    ) {
      // Serialize preflight failures with claims: stale failed configuration
      // must never overwrite a claimed/sent event from a concurrent sender.
      const written = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${log.workspaceId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "ConversionEventLog" WHERE "id" = ${log.id} AND "workspaceId" = ${log.workspaceId} FOR UPDATE`;
        if (
          await tx.auditLog.findFirst({
            where: { id: `inbound-meta-dispatch:${log.id}` },
            select: { id: true },
          })
        )
          return false;
        const updated = await tx.conversionEventLog.updateMany({
          where: {
            id: log.id,
            workspaceId: log.workspaceId,
            status: "ready_to_send",
          },
          data: deliveryData,
        });
        return Boolean(updated.count);
      });
      if (!written)
        return {
          conversionEventLogId: log.id,
          workspaceId: log.workspaceId,
          status: "skipped",
        };
    } else {
      await this.prisma.conversionEventLog.update({
        where: { id: log.id },
        data: deliveryData,
      });
    }
    await this.syncProviderConversionDelivery(log, result);
    if (inboundClaim)
      await this.prisma.auditLog.update({
        where: { id: `inbound-meta-dispatch:${log.id}` },
        data: {
          resultStatus:
            result.status === "sent"
              ? "sent"
              : unknownOutcome
                ? "delivery_unknown"
                : "failed",
        },
      });
    if (log.workspaceId) {
      await this.prisma.purchaseReview.updateMany({
        where: {
          workspaceId: log.workspaceId,
          conversionEventLogId: log.id,
          status: {
            in: ["approved", "failed"],
          },
        },
        data: {
          status: result.status === "sent" ? "sent" : "failed",
          reasonCode:
            result.status === "sent"
              ? null
              : (result.errorCode ?? "meta_delivery_failed"),
          version: { increment: 1 },
        },
      });
    }
    await this.recordMetaCapiDiagnosticEvent(
      log,
      result,
      integrationLogId,
      resolvedDestination,
    );

    return {
      conversionEventLogId: log.id,
      workspaceId: log.workspaceId,
      status: result.status,
      ...(["MetaCapiNetworkError", "MetaCapiDeliveryUnknown"].includes(
        result.errorCode ?? "",
      )
        ? {
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
          }
        : {}),
    };
  }

  /** A pre-dispatch lock proves no provider request occurred, so release only this claim. */
  private async releaseKommoSenderClaim(
    log: ConversionEventLogRecord,
    senderToken: string,
  ): Promise<void> {
    if (!log.workspaceId) return;
    await this.prisma.kommoConversionDedupe.updateMany({
      where: {
        workspaceId: log.workspaceId,
        conversionEventLogId: log.id,
        senderLeaseToken: senderToken,
        senderAttempts: 1,
      },
      data: {
        senderLeaseToken: null,
        senderRetryable: false,
        senderAttempts: 0,
      },
    });
  }

  /**
   * A execucao da regra guarda o estado tecnico de entrega em
   * normalizedResult.technicalDelivery. Sem este espelhamento ela ficava
   * "queued" para sempre: a auditoria da regra mostrava o evento como criado e
   * a caminho da Meta mesmo depois de a Meta ter recusado o envio.
   */
  private async syncProviderConversionDelivery(
    log: ConversionEventLogRecord,
    result: {
      status: SendReadyEventResult["status"];
      errorCode: MetaCapiSendEventErrorCode;
    },
  ): Promise<void> {
    if (!log.workspaceId) {
      return;
    }

    const execution =
      await this.prisma.providerConversionRuleExecution.findFirst({
        where: {
          workspaceId: log.workspaceId,
          conversionEventLogId: log.id,
        },
        select: { id: true, normalizedResult: true },
      });
    if (!execution) {
      return;
    }

    const delivery = this.providerConversionTechnicalDelivery(result);
    const normalized =
      execution.normalizedResult &&
      typeof execution.normalizedResult === "object" &&
      !Array.isArray(execution.normalizedResult)
        ? (execution.normalizedResult as Record<string, unknown>)
        : {};

    await this.prisma.providerConversionRuleExecution.update({
      where: { id: execution.id },
      data: {
        normalizedResult: {
          ...normalized,
          technicalDelivery: {
            ...delivery,
            updatedAt: new Date().toISOString(),
          },
        } as Prisma.InputJsonValue,
      },
    });
  }

  private providerConversionTechnicalDelivery(result: {
    status: SendReadyEventResult["status"];
    errorCode: MetaCapiSendEventErrorCode;
  }): {
    state:
      | "sent"
      | "blocked_configuration"
      | "failed_retryable"
      | "failed_permanent";
    retryable: boolean;
    reasonCode: string | null;
  } {
    if (result.status === "sent") {
      return { state: "sent", retryable: false, reasonCode: null };
    }

    if (result.status === "not_configured") {
      return {
        state: "blocked_configuration",
        retryable: false,
        reasonCode: result.errorCode ?? "MetaCapiNotConfigured",
      };
    }

    if (result.errorCode === "MetaCapiNetworkError") {
      return {
        state: "failed_retryable",
        retryable: true,
        reasonCode: result.errorCode,
      };
    }

    return {
      state: "failed_permanent",
      retryable: false,
      reasonCode: result.errorCode ?? "MetaCapiSendError",
    };
  }

  private async externalCapiDeliveryOwnedByWppTrack(
    log: ConversionEventLogRecord,
  ): Promise<boolean> {
    if (!log.externalConnectorId) {
      return true;
    }

    const eventTypes: Record<string, string> = {
      LeadSubmitted: "conversation_started",
      QualifiedLead: "qualified_lead",
      Purchase: "purchase",
    };
    const eventType = eventTypes[log.eventName];
    if (!eventType) {
      return false;
    }

    const cutover = await this.prisma.externalCapiCutover.findFirst({
      where: {
        connectorId: log.externalConnectorId,
        eventType,
        status: "active",
        activatedAt: { lte: log.eventOccurredAt },
      },
      select: { id: true },
    });

    return Boolean(cutover);
  }

  private ctwaIntent(
    log: ConversionEventLogRecord,
  ): AuthorizedCtwaDestination | null {
    const source = log.sourcePayload;
    if (!source || typeof source !== "object" || Array.isArray(source))
      return null;
    const parsed = authorizedCtwaDestinationSchema.safeParse(
      source.ctwaDestination,
    );
    return parsed.success ? parsed.data : null;
  }

  /**
   * Returns null when the CTWA conversion context is authorized, otherwise a
   * stable denial reason (persisted on the log when the sender skips it).
   */
  private async ctwaConversionContextDenial(
    tx: Prisma.TransactionClient,
    log: ConversionEventLogRecord,
    intent: AuthorizedCtwaDestination,
  ): Promise<string | null> {
    const config = parseInboundWebhooksConfig(this.env);
    // The messaging pixel requires the click id: no ctwa_clid, nothing sent.
    if (!log.ctwaClid?.trim()) return "ctwa_click_missing";
    // The CTWA destination path never carries account/campaign/ad set. An ad
    // id is accepted only as the hint of a materialized ad-hint entry below.
    if (!config.enabled || !config.productionEnabled)
      return "inbound_production_disabled";
    if (log.metaAccountId || log.campaignId || log.adSetId)
      return "ctwa_meta_hierarchy_present";
    const p = log.sourcePayload;
    if (
      !p ||
      typeof p !== "object" ||
      Array.isArray(p) ||
      p.channelId !== intent.channelId
    )
      return "ctwa_channel_mismatch";
    if (
      p.processingMode === "live_production" ||
      p.processingMode === "authorized_replay"
    ) {
      const provider = ctwaDestinationProviderValue();
      if (
        !provider ||
        typeof p.inboundEventId !== "string" ||
        p.connectionId !== intent.connectionId
      )
        return "ctwa_entry_context_invalid";
      const e = await tx.inboundWebhookEvent.findFirst({
        where: {
          id: p.inboundEventId,
          workspaceId: intent.workspaceId,
          channelId: intent.channelId,
          connectionId: intent.connectionId,
          provider,
          hasCtwa: true,
          // No-ad entry, or ad-hint entry whose stored ad id is the log's.
          ...(log.adId
            ? {
                adId: log.adId,
                classificationReason: CTWA_DESTINATION_AD_HINT_REASON,
              }
            : { adId: null, classificationReason: CTWA_DESTINATION_REASON }),
        },
        include: {
          delivery: true,
          connection: { include: { parserRelease: true } },
          channel: true,
          productionItem: true,
          replayItem: true,
        },
      });
      if (
        !e ||
        e.connection.removedAt ||
        e.channel.status !== "active" ||
        e.connection.parserRelease.status !== "certified" ||
        e.connection.parserRelease.version !== e.delivery.parserVersion ||
        e.occurredAt.getTime() !== log.eventOccurredAt.getTime()
      )
        return "ctwa_entry_context_invalid";
      const receipt =
        p.processingMode === "live_production"
          ? e.productionItem
          : e.replayItem;
      if (
        !receipt ||
        !["materialized", "duplicate"].includes(receipt.status) ||
        receipt.leadId !== log.leadId ||
        receipt.conversionEventLogId !== log.id
      )
        return "ctwa_entry_receipt_invalid";
      if (p.processingMode === "authorized_replay")
        return config.replayEnabled &&
          e.replayItem &&
          ["observation", "production"].includes(e.connection.status) &&
          (await studentBatchAuthorizationValid(
            tx,
            intent.workspaceId,
            e.replayItem.batchId,
            e.id,
          ))
          ? null
          : "ctwa_replay_not_authorized";
      return e.connection.status === "production" &&
        e.connection.productionActivatedAt &&
        e.channel.productionActivatedAt &&
        e.delivery.firstReceivedAt >= e.connection.productionActivatedAt &&
        e.delivery.firstReceivedAt >= e.channel.productionActivatedAt
        ? null
        : "ctwa_entry_not_in_production";
    }
    // CRM page/pixel conversions (Kommo, Pipedrive): the immutable ledger
    // intent of this exact log and an active connection still bound to the
    // number. The destination itself was re-verified above in CRM mode.
    if (p.processingMode === PIPEDRIVE_CTWA_PROCESSING_MODE)
      return (await pipedriveCtwaConversionAuthorized(tx, log, intent))
        ? null
        : "pipedrive_ctwa_context_invalid";
    if (p.processingMode === KOMMO_CTWA_PROCESSING_MODE)
      return (await kommoCtwaConversionAuthorized(tx, log, intent))
        ? null
        : "kommo_ctwa_context_invalid";
    if (p.processingMode !== "frozen_provider_conversion")
      return "ctwa_processing_mode_unsupported";
    if (log.adId) return "ctwa_provider_conversion_with_ad";
    if (!config.conversionRulesEnabled || !config.conversionProductionEnabled)
      return "provider_conversion_production_disabled";
    if (typeof p.providerConversionExecutionId !== "string")
      return "provider_conversion_execution_missing";
    const e = await tx.providerConversionRuleExecution.findFirst({
      where: {
        id: p.providerConversionExecutionId,
        workspaceId: intent.workspaceId,
        channelId: intent.channelId,
        status: "materialized",
        conversionEventLogId: log.id,
      },
      include: {
        sourceDelivery: true,
        channel: { include: { connection: { select: { provider: true } } } },
        providerRule: {
          include: {
            conversionRule: true,
            parserRelease: true,
            connection: { include: { parserRelease: true } },
            channels: true,
          },
        },
      },
    });
    if (!e || !e.channel) return "provider_conversion_execution_not_materialized";
    // CTWA (no-ad) dispatch exists only for endpoint automations, which always
    // keep their connection binding.
    if (!e.providerRule.connection || !e.providerRule.parserRelease)
      return "provider_conversion_origin_mismatch";
    // A sale callback (Payt, Fase 4a) sits on its rule's endpoint (any
    // WhatsApp connection of the workspace); its origin is the scoped channel,
    // which must belong to the connection of the verified CTWA entry, and the
    // event must be the durable winner of that sale.
    const paytPurchase =
      String(e.providerRule.parserRelease.provider) === "payt" &&
      e.providerRule.parserRelease.version === "automation-v1" &&
      ["Purchase", "InitiateCheckout", "CartAbandoned"].includes(
        log.eventName,
      );
    if (paytPurchase) {
      if (e.channel.connectionId !== intent.connectionId)
        return "provider_conversion_origin_mismatch";
      if (
        !log.dedupeKey ||
        !(await tx.providerPurchaseClaim.findFirst({
          where: {
            workspaceId: intent.workspaceId,
            effectMode: "production",
            purchaseKey: log.dedupeKey,
            winnerExecutionId: e.id,
            conversionEventLogId: log.id,
          },
          select: { id: true },
        }))
      )
        return "provider_purchase_claim_missing";
    } else if (
      e.providerRule.connectionId !== intent.connectionId ||
      e.sourceDelivery.connectionId !== intent.connectionId
    )
      return "provider_conversion_origin_mismatch";
    if (
      e.providerRule.removedAt ||
      !e.providerRule.conversionRule.active ||
      e.providerRule.conversionRule.eventName !== log.eventName ||
      e.providerRule.mode !== "production" ||
      !e.providerRule.productionActivatedAt
    )
      return "provider_rule_not_in_production";
    if (
      e.providerRule.parserRelease.status !== "certified" ||
      e.providerRule.connection.removedAt ||
      e.providerRule.connection.status !== "production" ||
      e.providerRule.connection.parserRelease.status !== "certified"
    )
      return "provider_connection_not_certified";
    if (
      e.channel.status !== "active" ||
      e.channel.conversionEngineMode !== "canonical" ||
      !e.channel.productionActivatedAt
    )
      return "provider_channel_not_canonical";
    if (
      !providerRuleCoversChannel(e.providerRule, {
        id: intent.channelId,
        connectionId: e.channel.connectionId,
        provider: e.channel.connection?.provider ?? "",
      })
    )
      return "provider_channel_out_of_scope";
    // A callback received before the rule/channel activation is sent only when
    // an operator explicitly approved its manual reprocess.
    const manuallyApproved =
      e.providerRule.conversionRule.triggerType === "provider_automation" &&
      providerAutomationManualReplayApproved(e.normalizedResult);
    if (
      !manuallyApproved &&
      (e.sourceDelivery.firstReceivedAt < e.providerRule.productionActivatedAt ||
        e.sourceDelivery.firstReceivedAt < e.channel.productionActivatedAt)
    )
      return "provider_delivery_before_activation";
    return null;
  }

  /**
   * A CTWA send that is refused before the dispatch claim keeps the log in
   * ready_to_send (nothing reached Meta) but never silently: the reason is
   * persisted so the audit shows it and the owner can requeue the event.
   */
  private async recordCtwaSendSkip(
    log: ConversionEventLogRecord,
    reason: string,
  ): Promise<SendReadyEventResult> {
    const errorMessage = `${reason}: ${
      CTWA_SEND_SKIP_REASONS[reason] ?? "envio CTWA bloqueado"
    }`;
    try {
      await this.prisma.conversionEventLog.updateMany({
        where: { id: log.id, status: "ready_to_send", eventId: log.eventId },
        data: { errorCode: CTWA_SEND_SKIPPED_ERROR_CODE, errorMessage },
      });
    } catch {
      // Observability only: the outcome stays "skipped" without a Meta effect.
    }
    return {
      conversionEventLogId: log.id,
      workspaceId: log.workspaceId,
      status: "skipped",
      errorCode: CTWA_SEND_SKIPPED_ERROR_CODE,
      errorMessage,
    };
  }

  private async sendCtwaEvent(
    log: ConversionEventLogRecord,
    intent: AuthorizedCtwaDestination,
  ): Promise<SendReadyEventResult> {
    const skipped = {
      conversionEventLogId: log.id,
      workspaceId: log.workspaceId,
      status: "skipped" as const,
    };
    if (!log.workspaceId || log.workspaceId !== intent.workspaceId)
      return this.recordCtwaSendSkip(log, "ctwa_workspace_mismatch");
    if (!log.ctwaClid?.trim())
      return this.recordCtwaSendSkip(log, "ctwa_click_missing");
    if (!this.connectionResolver)
      return this.recordCtwaSendSkip(log, "ctwa_sender_unavailable");
    // Only a Kommo/Pipedrive page/pixel conversion may re-authorize a
    // non-Unnichat number (CRM mode); every other source stays unchanged.
    const crmAuthorization = {
      crmContext: isCrmCtwaContext(log.sourcePayload),
    };
    // Claim commits BEFORE any provider effect. dispatching is a permanent fence:
    // an unknown outcome, a crash, and queue retry cannot automatically resend.
    const claim = await this.prisma.$transaction(async (tx) => {
      if (!(await this.kommoLicenseAllows(tx)))
        return { claimed: false, denial: "ctwa_license_locked" };
      await lockUnnichatMetaPolicy(tx, intent.workspaceId);
      if (!(await ctwaIntentAuthorized(tx, intent, crmAuthorization)))
        return { claimed: false, denial: "ctwa_destination_not_authorized" };
      const denial = await this.ctwaConversionContextDenial(tx, log, intent);
      if (denial) return { claimed: false, denial };
      const receipt = await tx.conversionEventLog.updateMany({
        where: {
          id: log.id,
          workspaceId: intent.workspaceId,
          status: "ready_to_send",
          eventId: log.eventId,
        },
        data: { status: "dispatching", errorCode: "MetaCapiDeliveryUnknown" },
      });
      // count 0: another sender already moved it out of ready_to_send.
      return { claimed: receipt.count === 1, denial: null };
    });
    if (claim.denial) return this.recordCtwaSendSkip(log, claim.denial);
    if (!claim.claimed) return skipped;
    const startedAt = new Date();
    const started = await this.prisma.$transaction(async (tx) => {
      await lockUnnichatMetaPolicy(tx, intent.workspaceId);
      const current = await tx.conversionEventLog.findFirst({
        where: {
          id: log.id,
          workspaceId: intent.workspaceId,
          status: "dispatching",
        },
      });
      const channel = await tx.inboundWebhookChannel.findFirst({
        where: { id: intent.channelId, workspaceId: intent.workspaceId },
        include: { connection: { include: { parserRelease: true } } },
      });
      if (
        !current ||
        !channel ||
        channel.status !== "active" ||
        channel.connection.removedAt ||
        channel.connection.parserRelease.status !== "certified" ||
        !(await this.kommoLicenseAllows(tx)) ||
        !(await ctwaIntentAuthorized(tx, intent, crmAuthorization)) ||
        (await this.ctwaConversionContextDenial(tx, log, intent))
      )
        return null;
      const { accessToken, validUntil } =
        await this.connectionResolver!.resolveAuthorizedCtwaDestination(
          intent,
          tx,
          crmAuthorization,
        );
      const deadline = performance.now() + KOMMO_DISPATCH_START_MS;
      const delivery = this.metaCapiAdapter.sendEvent(
        {
          accessToken,
          pixelId: intent.pixelId,
          pageId: intent.pageId,
          pagePixelDestination: intent,
          eventName: log.eventName,
          dedupeKey: log.eventId!,
          phoneHash: log.phoneHash,
          // Optional enrichment only: a non-numeric ad hint is never sent.
          adId: log.adId && /^\d{1,32}$/u.test(log.adId) ? log.adId : null,
          ctwaClid: log.ctwaClid,
          eventTime: log.eventOccurredAt,
          valueCents: log.valueCents,
          currency: log.currency,
          contentName: log.contentName,
          customData: log.customData as ConversionEventCustomDataDto | null,
        },
        {
          beforeDispatch: () => {
            if (Date.now() >= validUntil || performance.now() >= deadline)
              throw new Error("ctwa_dispatch_deadline");
          },
          signal: AbortSignal.timeout(KOMMO_NETWORK_MS),
        },
      );
      void delivery.catch(() => undefined);
      return { delivery };
    });
    if (!started) {
      await this.prisma.conversionEventLog.updateMany({
        where: {
          id: log.id,
          workspaceId: intent.workspaceId,
          status: "dispatching",
        },
        data: {
          status: "not_configured",
          errorCode: "MissingMetaDestination",
          errorMessage: "CTWA destination or context revoked before dispatch",
        },
      });
      return {
        ...skipped,
        status: "not_configured",
        errorCode: "MissingMetaDestination",
      };
    }
    const result = await started.delivery;
    const unknown = result.deliveryOutcome === "unknown";
    await this.prisma.conversionEventLog.updateMany({
      where: {
        id: log.id,
        workspaceId: intent.workspaceId,
        status: "dispatching",
      },
      data: {
        status: unknown ? "delivery_unknown" : result.status,
        errorCode: unknown ? "MetaCapiDeliveryUnknown" : result.errorCode,
        errorMessage: result.errorMessage,
        sentAt: result.status === "sent" ? new Date() : null,
        pixelId: intent.pixelId,
        pageId: intent.pageId,
        providerRequestPayload:
          (result.requestPayload as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        providerResponseSummary:
          (result.responseSummary as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });
    await this.recordMetaCapiIntegrationLog(log, startedAt, result, {
      source: "manual",
      accessToken: null,
      pixelId: intent.pixelId,
      pageId: intent.pageId,
      reportingAccountId: null,
      adAccountId: null,
      businessConnectionId: intent.businessConnectionId,
      conversionDestinationId: intent.destinationId,
      routeError: null,
      legacyShadowParity: null,
    });
    return {
      conversionEventLogId: log.id,
      workspaceId: log.workspaceId,
      status: result.status,
      errorCode: unknown ? "MetaCapiDeliveryUnknown" : result.errorCode,
      errorMessage: result.errorMessage,
    };
  }

  private async resolveDeliveryRoute(
    log: ConversionEventLogRecord,
    client?: Prisma.TransactionClient,
  ): Promise<ResolvedConversionDestination> {
    // Final inbound resolution must use the same transaction as authority locks.
    const resolver = client
      ? new MetaConnectionResolverService(
          client as PrismaService,
          this.metaTokenEncryption,
        )
      : this.connectionResolver;
    if (log.workspaceId && resolver) {
      try {
        const route = await resolver.resolveCapiRoute({
          workspaceId: log.workspaceId,
          ...(log.sourceTrigger === "kommo_stage" ||
          log.sourceTrigger === PIPEDRIVE_STAGE_TRIGGER
            ? { requireNormalized: true }
            : {}),
          metaAccountId: log.metaAccountId,
          campaignId: log.campaignId,
          adId: log.adId,
          ...(log.metaBusinessConnectionId
            ? { businessConnectionId: log.metaBusinessConnectionId }
            : {}),
          ...(log.metaConversionDestinationId
            ? {
                conversionDestinationId: log.metaConversionDestinationId,
              }
            : {}),
        });

        return this.normalizedDeliveryRoute(route);
      } catch (error) {
        return {
          source: "manual",
          accessToken: null,
          pixelId: null,
          pageId: null,
          reportingAccountId: null,
          adAccountId: null,
          businessConnectionId: null,
          conversionDestinationId: null,
          routeError:
            error instanceof Error
              ? error.message
              : "Nao foi possivel resolver a rota Meta deste evento",
          legacyShadowParity: null,
        };
      }
    }

    if (
      log.sourceTrigger === "kommo_stage" ||
      log.sourceTrigger === PIPEDRIVE_STAGE_TRIGGER ||
      log.sourceTrigger === "inbound_webhook:meta_cloud" ||
      log.metaBusinessConnectionId ||
      log.metaConversionDestinationId
    ) {
      return {
        source: "manual",
        accessToken: null,
        pixelId: null,
        pageId: null,
        reportingAccountId: null,
        adAccountId: null,
        businessConnectionId: null,
        conversionDestinationId: null,
        routeError:
          log.sourceTrigger === "kommo_stage"
            ? "Rota Kommo autorizada indisponivel"
            : log.sourceTrigger === PIPEDRIVE_STAGE_TRIGGER
              ? "Rota Pipedrive autorizada indisponivel"
              : "Rota Meta normalizada indisponivel",
        legacyShadowParity: null,
      };
    }

    // This is the existing OAuth execution path. It remains the source of truth
    // for Barbieri and every other legacy workspace.
    const legacyContext = await this.getWorkspaceCapiContext(log.workspaceId);
    const destination = await this.getWorkspaceConversionDestination(
      log.workspaceId,
    );
    const pixelId = destination?.pixelId ?? log.pixelId;
    const pageId = destination?.pageId ?? null;
    const legacyShadowParity = await this.compareLegacyCapiProjection({
      workspaceId: log.workspaceId,
      accessToken: legacyContext.accessToken,
      adAccountId: legacyContext.adAccountId,
      pixelId,
      pageId,
    });

    return {
      source: "legacy_oauth",
      accessToken: legacyContext.accessToken,
      pixelId,
      pageId,
      reportingAccountId: null,
      adAccountId: legacyContext.adAccountId,
      businessConnectionId: null,
      conversionDestinationId: null,
      routeError: null,
      legacyShadowParity,
    };
  }

  private normalizedDeliveryRoute(
    route: ResolvedMetaCapiRoute,
  ): ResolvedConversionDestination {
    return {
      source: route.source,
      accessToken: route.accessToken,
      pixelId: route.pixelId,
      pageId: route.pageId,
      reportingAccountId: route.reportingAccountId,
      adAccountId: route.adAccountId,
      businessConnectionId: route.businessConnectionId,
      conversionDestinationId: route.conversionDestinationId,
      routeError: null,
      legacyShadowParity: null,
    };
  }

  private async getWorkspaceCapiContext(
    workspaceId: string | null,
  ): Promise<{ accessToken: string | null; adAccountId: string | null }> {
    if (!workspaceId) {
      return { accessToken: null, adAccountId: null };
    }

    const connection = (await this.prisma.metaIntegration.findUnique({
      where: { workspaceId },
      select: {
        encryptedAccessToken: true,
        tokenIv: true,
        tokenTag: true,
        capiAccessTokenEncrypted: true,
        capiTokenIv: true,
        capiTokenTag: true,
        selectedAdAccountId: true,
      },
    })) as MetaIntegrationCapiTokenRecord | null;

    if (!connection) {
      return { accessToken: null, adAccountId: null };
    }

    const encryptedAccessToken =
      connection.capiAccessTokenEncrypted ?? connection.encryptedAccessToken;
    const tokenIv = connection.capiTokenIv ?? connection.tokenIv;
    const tokenTag = connection.capiTokenTag ?? connection.tokenTag;

    if (!encryptedAccessToken || !tokenIv || !tokenTag) {
      return {
        accessToken: null,
        adAccountId: connection.selectedAdAccountId,
      };
    }

    try {
      return {
        accessToken: this.metaTokenEncryption.decrypt({
          encryptedAccessToken,
          tokenIv,
          tokenTag,
        }),
        adAccountId: connection.selectedAdAccountId,
      };
    } catch {
      return {
        accessToken: null,
        adAccountId: connection.selectedAdAccountId,
      };
    }
  }

  private async compareLegacyCapiProjection(input: {
    workspaceId: string | null;
    accessToken: string | null;
    adAccountId: string | null;
    pixelId: string | null;
    pageId: string | null;
  }): Promise<LegacyRouteShadowParity | null> {
    if (!input.workspaceId || !this.connectionResolver) {
      return null;
    }

    try {
      const projection =
        await this.connectionResolver.getLegacyCompatibilityProjection(
          input.workspaceId,
          "capi",
        );
      const credentialFingerprintMatch = Boolean(
        input.accessToken &&
        this.metaTokenEncryption.fingerprint(input.accessToken) ===
          projection.credentialFingerprint,
      );
      const adAccountMatch = input.adAccountId === projection.adAccountId;
      const pixelMatch = input.pixelId === projection.destinationPixelId;
      const pageMatch = input.pageId === projection.destinationPageId;
      const parity =
        credentialFingerprintMatch && adAccountMatch && pixelMatch && pageMatch;

      return {
        comparisonStatus: parity ? "matched" : "mismatch",
        credentialFingerprintMatch,
        adAccountMatch,
        pixelMatch,
        pageMatch,
        parity,
      };
    } catch {
      return {
        comparisonStatus: "unavailable",
        credentialFingerprintMatch: null,
        adAccountMatch: null,
        pixelMatch: null,
        pageMatch: null,
        parity: false,
      };
    }
  }

  private async getWorkspaceConversionDestination(
    workspaceId: string | null,
  ): Promise<MetaConversionDestinationRecord | null> {
    if (!workspaceId) {
      return null;
    }

    return (await this.prisma.metaConversionDestination.findFirst({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      select: {
        pixelId: true,
        pageId: true,
      },
    })) as MetaConversionDestinationRecord | null;
  }

  private async recordMetaCapiIntegrationLog(
    log: ConversionEventLogRecord,
    startedAt: Date,
    result: {
      status: SendReadyEventResult["status"];
      requestPayload: unknown;
      responseSummary: unknown;
      errorMessage: string | null;
      errorCode: MetaCapiSendEventErrorCode;
    },
    destination: ResolvedConversionDestination,
  ): Promise<string | null> {
    const finishedAt = new Date();
    const status =
      result.status === "sent"
        ? "success"
        : result.status === "not_configured"
          ? "blocked"
          : "error";

    try {
      const integrationLog = await this.prisma.integrationLog.create({
        data: {
          workspaceId: log.workspaceId,
          source: "meta",
          operation: "meta.capi.send_event",
          status,
          startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          providerRequestId: log.id,
          providerErrorCode: result.errorCode,
          providerErrorMessage: result.errorMessage,
          leadId: log.leadId,
          campaignId: log.campaignId,
          adSetId: log.adSetId,
          adId: log.adId,
          jobId: log.id,
          requestSummary: {
            conversionEventLogId: log.id,
            eventName: log.eventName,
            pixelId: destination.pixelId,
            pageId: destination.pageId,
            routeSource: destination.source,
            reportingAccountId: destination.reportingAccountId,
            adAccountId: destination.adAccountId,
            businessConnectionId: destination.businessConnectionId,
            conversionDestinationId: destination.conversionDestinationId,
            ...(destination.legacyShadowParity
              ? { legacyShadowParity: destination.legacyShadowParity }
              : {}),
            eventId: log.eventId,
            dedupeKey: log.dedupeKey,
            phoneHash: log.phoneHash,
            adId: log.adId,
            ctwaClid: log.ctwaClid,
            valueCents: log.valueCents,
            currency: log.currency,
            contentName: log.contentName,
            payload: result.requestPayload,
            errorCode: result.errorCode,
          } as Prisma.InputJsonValue,
          responseSummary:
            result.responseSummary === null
              ? Prisma.JsonNull
              : (result.responseSummary as Prisma.InputJsonValue),
        },
      });
      return integrationLog.id;
    } catch {
      return null;
    }
  }

  private async recordMetaCapiDiagnosticEvent(
    log: ConversionEventLogRecord,
    result: {
      status: SendReadyEventResult["status"];
      errorMessage: string | null;
      errorCode: MetaCapiSendEventErrorCode;
    },
    integrationLogId: string | null,
    destination: ResolvedConversionDestination,
  ): Promise<void> {
    if (result.status === "sent" || result.status === "skipped") {
      return;
    }

    const isBlocked = result.status === "not_configured";

    try {
      await this.prisma.diagnosticEvent.create({
        data: {
          workspaceId: log.workspaceId,
          source: "meta",
          eventType: "meta.capi.send_event",
          severity: isBlocked ? "warning" : "error",
          status: isBlocked ? "blocked" : "error",
          title: isBlocked
            ? "Envio Meta CAPI bloqueado por configuracao"
            : "Falha no envio Meta CAPI",
          message:
            result.errorMessage ??
            (isBlocked
              ? "Pixel ou token Meta CAPI nao configurado."
              : "O envio do evento para a Meta falhou."),
          leadId: log.leadId,
          phoneHash: log.phoneHash,
          campaignId: log.campaignId,
          adSetId: log.adSetId,
          adId: log.adId,
          jobId: log.id,
          errorCode:
            result.errorCode ??
            (isBlocked ? "MetaCapiNotConfigured" : "MetaCapiSendError"),
          integrationLogId,
          conversionEventLogId: log.id,
          summaryPayload: {
            conversionEventLogId: log.id,
            eventName: log.eventName,
            pixelId: destination.pixelId,
            pageId: destination.pageId,
            routeSource: destination.source,
            reportingAccountId: destination.reportingAccountId,
            adAccountId: destination.adAccountId,
            businessConnectionId: destination.businessConnectionId,
            conversionDestinationId: destination.conversionDestinationId,
            ...(destination.legacyShadowParity
              ? { legacyShadowParity: destination.legacyShadowParity }
              : {}),
            eventId: log.eventId,
            status: result.status,
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
          } as Prisma.InputJsonValue,
        },
      });
    } catch {
      return;
    }
  }

  private buildDedupeKey(
    input: RecordRuleMatchesInput,
    rule: ConversionRuleDto,
  ): string {
    const subject = input.leadId ?? input.phoneHash ?? "unknown";
    return [
      input.workspaceId,
      subject,
      rule.id,
      rule.eventName,
      input.adId ?? "missing_ad",
    ].join(":");
  }

  private resolveEventOccurredAt(value?: Date | string | null): Date {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value;
    }

    if (typeof value === "string") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return new Date();
  }

  private resolveCustomerIdentityKey(phoneHash?: string | null): string | null {
    const normalized = phoneHash?.trim();
    return normalized ? normalized : null;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002",
    );
  }

  private async resolvePurchaseKind(
    input: {
      workspaceId: string;
      eventName: ConversionEventNameDto;
      customerIdentityKey: string | null;
    },
    client: ConversionEventPrismaClient = this.prisma,
  ): Promise<"first_purchase" | "repurchase" | null> {
    if (input.eventName !== "Purchase" || !input.customerIdentityKey) {
      return null;
    }

    const previousPurchases = await client.conversionEventLog.count({
      where: {
        workspaceId: input.workspaceId,
        eventName: "Purchase",
        customerIdentityKey: input.customerIdentityKey,
        sourceTrigger: {
          not: "manual_test",
        },
      },
    });

    return previousPurchases === 0 ? "first_purchase" : "repurchase";
  }

  private resolveInitialStatus(input: {
    eventName: ConversionEventNameDto;
    adId?: string | null;
    ctwaClid?: string | null;
    valueCents?: number | null;
    ctwaDestination?: AuthorizedCtwaDestination;
  }): InitialStatus {
    if (!isSupportedConversionEventName(input.eventName)) {
      return {
        status: "skipped",
        errorCode: "UnsupportedConversionEventName",
        errorMessage: "Unsupported conversion event name",
      };
    }

    if (!input.adId && !input.ctwaDestination) {
      return {
        status: "pending_meta_context",
        errorCode: "MissingAdId",
        errorMessage: "Meta CAPI ad id not available",
      };
    }

    if (!input.ctwaClid) {
      return {
        status: "pending_meta_context",
        errorCode: "MissingCtwaClid",
        errorMessage: "Meta CAPI ctwa_clid not available",
      };
    }

    if (
      isConversionEventRequiringValue(input.eventName) &&
      input.valueCents == null
    ) {
      return {
        status: "pending_value",
        errorCode: "EventValueMissing",
        errorMessage: "Conversion event value is required",
      };
    }

    return {
      status: "ready_to_send",
      errorCode: null,
      errorMessage: null,
    };
  }

  private resolveExternalInitialStatus(
    input: RecordExternalConversionInput,
  ): InitialStatus {
    if (
      input.deliveryStatus === "imported" ||
      input.deliveryStatus === "shadow_observed"
    ) {
      return {
        status: input.deliveryStatus,
        errorCode: null,
        errorMessage: null,
      };
    }

    if (
      input.ctwaDestination &&
      (!Number.isFinite(input.eventOccurredAt.getTime()) ||
        input.eventOccurredAt.getTime() > Date.now() ||
        Date.now() - input.eventOccurredAt.getTime() > 7 * 86400000)
    )
      return {
        status: "not_eligible",
        errorCode: "MetaEventTimeExpired",
        errorMessage:
          "Local CTWA lead retained; original event time is outside Meta's seven day window",
      };
    const resolved = this.resolveInitialStatus({
      eventName: input.eventName,
      adId: input.adId,
      ctwaClid: input.ctwaClid,
      valueCents: input.valueCents,
      ctwaDestination: input.ctwaDestination,
    });

    if (input.deliveryStatus !== "not_eligible") {
      return resolved;
    }

    return {
      status: "not_eligible",
      errorCode:
        resolved.errorCode === "MissingAdId" ||
        resolved.errorCode === "MissingCtwaClid"
          ? resolved.errorCode
          : null,
      errorMessage:
        resolved.errorCode === "MissingAdId" ||
        resolved.errorCode === "MissingCtwaClid"
          ? resolved.errorMessage
          : null,
    };
  }
}
