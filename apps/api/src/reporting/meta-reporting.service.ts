import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type {
  AdReportOverviewDto,
  AdReportRowDto,
  AdSetReportOverviewDto,
  AdSetReportRowDto,
  CampaignReportRowDto,
  ConversionAuditDeliveryStateDto,
  ConversionAuditEventDetailDto,
  ConversionAuditEventDto,
  ConversionAuditOverviewDto,
  ConversionAuditSourceDto,
  ConversionEventCustomDataDto,
  ConversionEventLogStatusDto,
  FunnelStageConfigurationDto,
  MetaBudgetUpdateInputDto,
  MetaEntityMutationResultDto,
  MetaEntityStatusUpdateInputDto,
  MetaStructureReportDto,
  ReportDailyComparisonPointDto,
  ReportOverviewDto,
  ReportPaginationDto,
  ReportSortDto,
  ReportTotalsDto,
} from "@wpptrack/shared";
import {
  DEFAULT_CURRENCY_CODE,
  effectiveAccountCurrency,
  type CurrencyCode,
  type ReportCurrencyGroupDto,
  type UnconvertedRevenueDto,
} from "@wpptrack/shared";
import {
  ExchangeRateService,
  ExchangeRateTable,
  type ExchangeRateRequest,
} from "../currency/exchange-rate.service";
import { loadWorkspaceConversionCurrency } from "../currency/workspace-currency";
import {
  buildCurrencyBreakdown,
  convertEventValues,
  exchangeRateRequests,
  reportCurrencies,
  rowExchangeRateFields,
  type AttributionCurrencyResolver,
  type CurrencyBreakdown,
  type CurrencyConvertedEvent,
  type CurrencyEntity,
} from "./reporting-currency";
import { PrismaService } from "../common/prisma/prisma.service";
import { isSupportedConversionEventName } from "../conversion-events/conversion-event-registry";
import {
  BLOCKED_CONVERSION_RETRY_LIMIT,
  canRetryConversionEvent,
  configurationBlockedConversionEventWhere,
} from "../conversion-events/conversion-event-retry";
import { buildMetaCapiPayload } from "../conversion-events/meta-capi-payload.builder";
import { FunnelConfigurationService } from "../conversion-rules/funnel-configuration.service";
import { InboundWebhookChannelRoutesService } from "../inbound-webhooks/inbound-webhook-channel-routes.service";
import {
  dateRangeInTimezone,
  dateInTimezone,
} from "../external-data/external-event-policy";
import {
  MetaAdapter,
  type MetaAdAsset,
  type MetaAdDailyInsight,
  type MetaAdInsight,
  type MetaAdSetAsset,
  type MetaAdSetDailyInsight,
  type MetaAdSetInsight,
  type MetaCampaignAsset,
  type MetaCampaignDailyInsight,
  type MetaCampaignInsight,
  type MetaPreviewEnrichmentStats,
} from "../integrations/meta/meta.adapter";
import { evaluateMetaPreviewUrlFreshness } from "../integrations/meta/meta-preview-url-freshness";
import { MetaAdDestinationRoutingService } from "../integrations/meta/meta-ad-destination-routing.service";
import { MetaTokenEncryptionService } from "../integrations/meta/meta-token-encryption.service";
import { MetaConnectionResolverService } from "../integrations/meta/meta-connection-resolver.service";
import {
  WhatsappCampaignClassifierService,
  type WhatsappClassification,
} from "./whatsapp-campaign-classifier.service";
import {
  chunked,
  leadFirstContactBeforeWhere,
  leadFirstContactInRangeWhere,
  loadLeadIdsByPhoneHash,
  paidLeadSubmittedEventWhere,
  phoneHashesWithoutLeadId,
  withFirstContactAttribution,
} from "../leads/lead-cohort";
import {
  ReportingMetricsEngine,
  type ReportingMetricEvent,
  type ReportingMetricLead,
  type ReportingMetricScope,
} from "./reporting-metrics.engine";
import {
  sortReportRowsByCurrency,
  type SortableReportRow,
} from "./report-row-sort";

export type MetaStructureSyncInput = {
  workspaceId: string;
  businessConnectionId?: string | null;
  reportingAccountId?: string | null;
  since: string;
  until: string;
};

export type MetaStructureSyncResult = {
  workspaceId: string;
  accountsSynced: number;
  accountsFailed: number;
  campaignsSynced: number;
  adSetsSynced: number;
  adsSynced: number;
};

export type ReportCsvResult = {
  filename: string;
  content: string;
};

type WhatsappClassificationFilter =
  "whatsapp" | "needs_review" | "excluded" | "all";
/** Implatec: tipo da campanha no painel (WhatsApp x formulario Lead Ads). */
type CampaignKind = "whatsapp" | "lead_form" | "other";
type CampaignKindFilter = "all" | "whatsapp" | "lead_form";
/** Lead criado pelo servico da Implatec a partir do formulario (Lead Ads). */
const LEAD_FORM_SOURCE = "meta_leadgen";
/** Destino "no proprio anuncio" = formulario instantaneo. */
const LEAD_FORM_DESTINATION_TYPES = new Set([
  "ON_AD",
  "ON_POST",
  "ON_VIDEO",
  "ON_PAGE",
  "ON_EVENT",
]);
const WHATSAPP_REPORT_CLASSIFICATIONS: WhatsappClassification[] = [
  "auto_whatsapp",
  "creative_whatsapp",
  "detected_by_leads",
  "manual_include",
];
type ReportNameScope = "campaign" | "adset" | "ad";
type ReportStatusFilter = "all" | "active" | "paused";
type ReportDeliveryFilter = "all" | "had_delivery";

type ReportFilterInput = {
  businessId?: string;
  adAccountId?: string;
  /** Several ad accounts (Visão Geral / Relatórios filter). */
  adAccountIds?: string[];
  campaignId?: string;
  adSetId?: string;
  adId?: string;
  nameScope?: ReportNameScope;
  nameContains?: string;
  status?: ReportStatusFilter;
  delivery?: ReportDeliveryFilter;
  selectedEntityIds?: string[];
  whatsappClassification?: WhatsappClassificationFilter;
  /** Implatec: undefined = comportamento original (so WhatsApp). */
  campaignKind?: CampaignKindFilter;
  page?: number;
  pageSize?: number;
  sort?: ReportSortDto;
};

type ReportMetricScopeFilter = {
  campaignIds?: string[];
  adSetIds?: string[];
  adIds?: string[];
};

type PaginatedRecords<T> = {
  items: T[];
  pagination?: ReportPaginationDto;
};

type StringFilter = string | { in: string[] };

type MetaSnapshotWhere = {
  workspaceId: string;
  businessId?: StringFilter;
  adAccountId?: StringFilter;
  campaignId?: StringFilter;
  adSetId?: StringFilter;
  adId?: StringFilter;
  whatsappClassification?:
    WhatsappClassification | { in: WhatsappClassification[] };
  campaignKind?: CampaignKind;
  OR?: Array<{
    whatsappClassification?:
      WhatsappClassification | { in: WhatsappClassification[] };
    campaignKind?: CampaignKind;
    campaignId?: StringFilter;
  }>;
};

type ReportCurrencyContext = {
  accountCurrency(adAccountId: string | null | undefined): CurrencyCode;
  attributionCurrency: AttributionCurrencyResolver;
  /** Effective currencies of the active accounts in the filter scope. */
  scopeCurrencies: CurrencyCode[];
};

type MetaHierarchyScope = {
  where: Omit<MetaSnapshotWhere, "whatsappClassification">;
  accountCurrencies: Map<string, CurrencyCode>;
};

type MetaIntegrationRecord = {
  workspaceId: string;
  encryptedAccessToken: string;
  tokenIv: string;
  tokenTag: string;
  selectedAdAccountId: string | null;
};

type LegacyRouteShadowParity = {
  comparisonStatus: "matched" | "mismatch" | "unavailable";
  credentialFingerprintMatch: boolean | null;
  adAccountMatch: boolean | null;
  pixelMatch: null;
  pageMatch: null;
  parity: boolean;
};

type MetaReportingAccountRecord = {
  id: string;
  workspaceId: string;
  businessId: string;
  businessName: string;
  adAccountId: string;
  adAccountName: string;
  active: boolean;
};

/**
 * Media previously saved for one workspace + reporting account, keyed by
 * creative id so it is only ever applied to the same creative.
 */
type SavedAdMedia = {
  /**
   * Any saved preview of the creative, reused without asking Graph again.
   * The fbcdn `oe` expiry hint is only used to prefer the freshest of several
   * saved URLs, never to force a refetch (Graph calls count against the
   * shared app-level rate limit).
   */
  reusablePreviewUrls: Map<string, string>;
  /** Any saved preview, used only when enrichment of that creative failed. */
  previewByCreative: Map<string, string>;
  thumbnailByCreative: Map<string, string>;
  /**
   * Creatives that recently came back from Graph without a usable preview
   * (absent or failed). They are not requested again until the TTL expires.
   */
  skipPreviewCreativeIds: Set<string>;
};

/**
 * How long a creative that came back absent/failed is not requested again.
 * Kept in memory only (no schema change): a restart forgets it, which costs
 * at most one extra request per such creative.
 */
export const META_PREVIEW_MISS_TTL_MS = 24 * 60 * 60 * 1000;

type AdMediaResolutionCounters = {
  preservedAfterFailure: number;
  thumbnailsPreserved: number;
};

type ExistingClassificationRecord = {
  classificationOverride?: WhatsappClassification | null;
  whatsappClassification?: WhatsappClassification | null;
};

type MetaCampaignRecord = {
  campaignId: string;
  name: string;
  status: string | null;
  effectiveStatus?: string | null;
  objective?: string | null;
  campaignKind?: CampaignKind;
  campaignKindSource?: string | null;
  dailyBudgetCents?: number | null;
  lifetimeBudgetCents?: number | null;
  businessId?: string | null;
  adAccountId?: string | null;
  whatsappClassification?: WhatsappClassification;
  spendCents: number;
  metaConversationsStarted: number;
};

type MetaCampaignDailyInsightRecord = {
  campaignId: string;
  localDate: string;
  spendCents: number;
  metaConversationsStarted: number;
};

type MetaAdSetDailyInsightRecord = {
  adSetId: string;
  localDate: string;
  spendCents: number;
  metaConversationsStarted: number;
};

type MetaAdDailyInsightRecord = {
  adId: string;
  localDate: string;
  spendCents: number;
  metaConversationsStarted: number;
};

type MetaAdSetRecord = {
  adSetId: string;
  campaignId: string;
  name: string;
  status: string | null;
  effectiveStatus: string | null;
  destinationType?: string | null;
  dailyBudgetCents?: number | null;
  lifetimeBudgetCents?: number | null;
  businessId?: string | null;
  adAccountId?: string | null;
  whatsappClassification?: WhatsappClassification;
  spendCents: number;
  metaConversationsStarted: number;
};

type MetaAdRecord = {
  adId: string;
  adSetId: string;
  campaignId: string;
  name: string;
  status: string | null;
  effectiveStatus: string | null;
  destinationType?: string | null;
  callToActionType?: string | null;
  thumbnailUrl?: string | null;
  previewUrl?: string | null;
  businessId?: string | null;
  adAccountId?: string | null;
  whatsappClassification?: WhatsappClassification;
  spendCents: number;
  metaConversationsStarted: number;
};

type ConversionEventRecord = ReportingMetricEvent;

type ConversionAuditFilters = {
  workspaceId: string;
  since?: string;
  until?: string;
  eventName?: string;
  deliveryState?: ConversionAuditDeliveryStateDto;
  source?: ConversionAuditSourceDto;
};

type ConversionAuditEventRecord = {
  id: string;
  eventName: string;
  leadId: string | null;
  phoneHash: string | null;
  sourceTrigger: string;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  ctwaClid: string | null;
  pixelId: string | null;
  pageId: string | null;
  eventOccurredAt: Date;
  sentAt: Date | null;
  status: ConversionEventLogStatusDto;
  providerResponseSummary: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  valueCents: number | null;
  valueSource: "actual" | "configured_average" | "manual" | null;
};

type ConversionAuditEventDetailRecord = ConversionAuditEventRecord & {
  workspaceId: string | null;
  eventId: string | null;
  dedupeKey: string | null;
  sourceEventId: string | null;
  sourcePayload: unknown;
  providerRequestPayload: unknown;
  customData: unknown;
  currency: string | null;
  contentName: string | null;
};

type ConversionAuditContext = {
  leadsById: Map<string, ConversionAuditLeadRecord>;
  leadsByPhoneHash: Map<string, ConversionAuditLeadRecord>;
  campaigns: Map<string, ConversionAuditCampaignRecord>;
  adSets: Map<string, ConversionAuditAdSetRecord>;
  ads: Map<string, ConversionAuditAdRecord>;
};

type ConversionAuditLeadRecord = {
  id: string;
  name: string | null;
  phoneDisplay: string | null;
  phoneHash: string;
};

type ConversionAuditNamedRecord = {
  name: string;
};

type ConversionAuditCampaignRecord = ConversionAuditNamedRecord & {
  campaignId: string;
};

type ConversionAuditAdSetRecord = ConversionAuditNamedRecord & {
  adSetId: string;
};

type ConversionAuditAdRecord = ConversionAuditNamedRecord & {
  adId: string;
};

type LeadRecord = ReportingMetricLead;

type ReportRowMetrics = Omit<
  CampaignReportRowDto,
  | "id"
  | "name"
  | "status"
  | "businessId"
  | "businessName"
  | "adAccountId"
  | "adAccountName"
  | "whatsappClassification"
>;

type LeadEvidenceMaps = {
  campaigns: Set<string>;
  adSets: Set<string>;
  ads: Set<string>;
  /** Campanhas com Lead vindo do formulario (source meta_leadgen). */
  leadFormCampaigns: Set<string>;
};

type CampaignMetricOverride = {
  spendCents: number;
  metaConversationsStarted: number;
  adSetIds: Set<string>;
  adIds: Set<string>;
};

type EntityMetricOverride = Pick<
  CampaignMetricOverride,
  "spendCents" | "metaConversationsStarted"
>;

type WhatsappOverrideLevel = "campaign" | "adset" | "ad";
type WhatsappManualOverride = "manual_include" | "manual_exclude";
type WhatsappOverrideUpdateData = {
  classificationOverride: WhatsappManualOverride | null;
  whatsappClassification: WhatsappClassification;
  classificationSource: string;
};

@Injectable()
export class MetaReportingService {
  private readonly logger = new Logger(MetaReportingService.name);
  /** `${workspaceId}|${businessId}|${adAccountId}|${creativeId}` -> expiry ms */
  private readonly previewMissUntil = new Map<string, number>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly encryption: MetaTokenEncryptionService,
    private readonly metaAdapter: MetaAdapter,
    private readonly adDestinationRouting: MetaAdDestinationRoutingService,
    private readonly whatsappClassifier: WhatsappCampaignClassifierService,
    private readonly metricsEngine: ReportingMetricsEngine,
    private readonly funnelConfiguration: FunnelConfigurationService,
    @Optional()
    private readonly connectionResolver?: MetaConnectionResolverService,
    @Optional()
    private readonly inboundRoutes?: InboundWebhookChannelRoutesService,
    @Optional()
    @Inject(ExchangeRateService)
    private readonly exchangeRates?: ExchangeRateService,
  ) {}

  async syncWorkspaceMetaStructure(
    input: MetaStructureSyncInput,
  ): Promise<MetaStructureSyncResult> {
    const startedAt = new Date();
    const normalizedJob = Boolean(
      input.businessConnectionId || input.reportingAccountId,
    );

    if (
      normalizedJob &&
      (!input.businessConnectionId || !input.reportingAccountId)
    ) {
      throw new BadRequestException(
        "A sincronizacao manual exige conta e conexao Meta",
      );
    }

    let accessToken: string;
    let accounts: MetaReportingAccountRecord[];
    let legacyShadowParity: LegacyRouteShadowParity | null = null;

    if (normalizedJob) {
      if (!this.connectionResolver) {
        throw new NotFoundException("Roteamento Meta indisponivel");
      }

      const route = await this.connectionResolver.resolveReportingRoute({
        workspaceId: input.workspaceId,
        businessConnectionId: input.businessConnectionId,
        reportingAccountId: input.reportingAccountId,
      });
      const account = (await this.prisma.metaReportingAccount.findFirst({
        where: {
          id: route.reportingAccountId,
          workspaceId: input.workspaceId,
          businessConnectionId: route.businessConnectionId,
          active: true,
        },
      })) as MetaReportingAccountRecord | null;

      if (!account) {
        throw new NotFoundException("Conta Meta ativa nao encontrada");
      }

      accessToken = route.accessToken;
      accounts = [account];
    } else {
      // Existing OAuth workspaces stay on the original token and account path.
      const connection = await this.getConnection(input.workspaceId);
      accessToken = this.encryption.decrypt({
        encryptedAccessToken: connection.encryptedAccessToken,
        tokenIv: connection.tokenIv,
        tokenTag: connection.tokenTag,
      });
      accounts = (await this.prisma.metaReportingAccount.findMany({
        where: { workspaceId: input.workspaceId, active: true },
      })) as MetaReportingAccountRecord[];
      legacyShadowParity = await this.compareLegacyReportingProjection({
        workspaceId: input.workspaceId,
        accessToken,
        selectedAdAccountId: connection.selectedAdAccountId,
        accounts,
      });
    }

    if (accounts.length === 0) {
      throw new NotFoundException("Nenhuma conta Meta ativa para relatorios");
    }

    const result: MetaStructureSyncResult = {
      workspaceId: input.workspaceId,
      accountsSynced: 0,
      accountsFailed: 0,
      campaignsSynced: 0,
      adSetsSynced: 0,
      adsSynced: 0,
    };

    for (const account of accounts) {
      try {
        await this.prisma.metaReportingAccount.update({
          where: { id: account.id },
          data: {
            syncStatus: "syncing",
            syncError: null,
          },
        });

        const accountResult = await this.syncReportingAccount({
          workspaceId: input.workspaceId,
          accessToken,
          account,
          since: input.since,
          until: input.until,
          insightReadMode: normalizedJob ? "manual" : "legacy",
        });

        await this.prisma.metaReportingAccount.update({
          where: { id: account.id },
          data: {
            syncStatus: "synced",
            lastSyncedAt: new Date(),
            lastSyncSince: input.since,
            lastSyncUntil: input.until,
            syncError: null,
          },
        });

        if (input.businessConnectionId) {
          await this.prisma.metaBusinessConnection.updateMany({
            where: {
              id: input.businessConnectionId,
              workspaceId: input.workspaceId,
            },
            data: {
              lastSyncedAt: new Date(),
              validationError: null,
            },
          });
        }

        result.accountsSynced += 1;
        result.campaignsSynced += accountResult.campaignsSynced;
        result.adSetsSynced += accountResult.adSetsSynced;
        result.adsSynced += accountResult.adsSynced;
      } catch (error) {
        result.accountsFailed += 1;
        await this.prisma.metaReportingAccount.update({
          where: { id: account.id },
          data: {
            syncStatus: "error",
            syncError: this.errorMessage(error),
          },
        });
      }
    }

    if (result.accountsSynced === 0 && result.accountsFailed > 0) {
      const error = new Error("Todas as contas Meta falharam na sincronizacao");
      await this.recordMetaReportingSyncDiagnostics({
        input,
        startedAt,
        result,
        error,
        legacyShadowParity,
      });
      throw error;
    }

    if (result.accountsSynced > 0 && this.inboundRoutes) {
      try {
        await this.inboundRoutes.reevaluateWorkspaceOpenEvents(
          input.workspaceId,
        );
      } catch (error) {
        this.logger.warn(
          `Meta sync completed, but inbound routes could not be reevaluated: ${this.errorMessage(error)}`,
        );
      }
    }

    await this.recordMetaReportingSyncDiagnostics({
      input,
      startedAt,
      result,
      legacyShadowParity,
    });

    return result;
  }

  private async syncReportingAccount(input: {
    workspaceId: string;
    accessToken: string;
    account: MetaReportingAccountRecord;
    since: string;
    until: string;
    insightReadMode: "legacy" | "manual";
  }): Promise<{
    campaignsSynced: number;
    adSetsSynced: number;
    adsSynced: number;
  }> {
    const adAccountId = input.account.adAccountId;
    const [
      campaigns,
      adSets,
      adListing,
      campaignInsights,
      campaignDailyInsightsBatch,
      adSetInsights,
      adSetDailyInsightsBatch,
      adInsights,
      adDailyInsightsBatch,
    ] = await Promise.all([
      this.metaAdapter.listCampaigns({
        accessToken: input.accessToken,
        adAccountId,
      }),
      this.metaAdapter.listAdSets({
        accessToken: input.accessToken,
        adAccountId,
      }),
      this.listAdsReusingSavedMedia({
        workspaceId: input.workspaceId,
        accessToken: input.accessToken,
        account: input.account,
      }),
      this.metaAdapter.listCampaignInsights({
        accessToken: input.accessToken,
        adAccountId,
        since: input.since,
        until: input.until,
        readMode: input.insightReadMode,
      }),
      this.metaAdapter.listCampaignDailyInsights({
        accessToken: input.accessToken,
        adAccountId,
        since: input.since,
        until: input.until,
        readMode: input.insightReadMode,
      }),
      this.metaAdapter.listAdSetInsights({
        accessToken: input.accessToken,
        adAccountId,
        since: input.since,
        until: input.until,
        readMode: input.insightReadMode,
      }),
      this.metaAdapter.listAdSetDailyInsights({
        accessToken: input.accessToken,
        adAccountId,
        since: input.since,
        until: input.until,
        readMode: input.insightReadMode,
      }),
      this.metaAdapter.listAdInsights({
        accessToken: input.accessToken,
        adAccountId,
        since: input.since,
        until: input.until,
        readMode: input.insightReadMode,
      }),
      this.metaAdapter.listAdDailyInsights({
        accessToken: input.accessToken,
        adAccountId,
        since: input.since,
        until: input.until,
        readMode: input.insightReadMode,
      }),
    ]);
    const campaignDailyInsights =
      input.insightReadMode === "manual"
        ? await this.resolveManualCampaignDailyInsights({
            accessToken: input.accessToken,
            adAccountId,
            since: input.since,
            until: input.until,
            aggregateInsights: campaignInsights,
            dailyInsights: campaignDailyInsightsBatch,
          })
        : campaignDailyInsightsBatch;
    const adSetDailyInsights =
      input.insightReadMode === "manual"
        ? await this.resolveManualAdSetDailyInsights({
            accessToken: input.accessToken,
            adAccountId,
            since: input.since,
            until: input.until,
            aggregateInsights: adSetInsights,
            dailyInsights: adSetDailyInsightsBatch,
          })
        : adSetDailyInsightsBatch;
    const adDailyInsights =
      input.insightReadMode === "manual"
        ? await this.resolveManualAdDailyInsights({
            accessToken: input.accessToken,
            adAccountId,
            since: input.since,
            until: input.until,
            aggregateInsights: adInsights,
            dailyInsights: adDailyInsightsBatch,
          })
        : adDailyInsightsBatch;
    const { ads, previewStats, savedMedia } = adListing;
    const mediaCounters: AdMediaResolutionCounters = {
      preservedAfterFailure: 0,
      thumbnailsPreserved: 0,
    };
    const mediaByAdId = new Map(
      ads.map((ad) => [
        ad.id,
        this.resolveAdMedia(ad, savedMedia, mediaCounters),
      ]),
    );
    this.logPreviewEnrichment({
      workspaceId: input.workspaceId,
      reportingAccountId: input.account.id,
      adCount: ads.length,
      stats: previewStats,
      savedMedia,
      counters: mediaCounters,
    });
    const insightByCampaign = new Map(
      campaignInsights.map((item) => [item.campaignId, item]),
    );
    const insightByAdSet = new Map(
      adSetInsights.map((item) => [item.adSetId, item]),
    );
    const insightByAd = new Map(adInsights.map((item) => [item.adId, item]));
    const adSetById = new Map(adSets.map((adSet) => [adSet.id, adSet]));
    const [existingCampaigns, existingAdSets, existingAds] = await Promise.all([
      this.prisma.metaCampaign.findMany({
        where: {
          workspaceId: input.workspaceId,
          campaignId: { in: campaigns.map((campaign) => campaign.id) },
        },
        select: {
          campaignId: true,
          classificationOverride: true,
          whatsappClassification: true,
        },
      }) as Promise<
        Array<ExistingClassificationRecord & { campaignId: string }>
      >,
      this.prisma.metaAdSet.findMany({
        where: {
          workspaceId: input.workspaceId,
          adSetId: { in: adSets.map((adSet) => adSet.id) },
        },
        select: {
          adSetId: true,
          classificationOverride: true,
          whatsappClassification: true,
        },
      }) as Promise<Array<ExistingClassificationRecord & { adSetId: string }>>,
      this.prisma.metaAd.findMany({
        where: {
          workspaceId: input.workspaceId,
          adId: { in: ads.map((ad) => ad.id) },
        },
        select: {
          adId: true,
          classificationOverride: true,
          whatsappClassification: true,
        },
      }) as Promise<Array<ExistingClassificationRecord & { adId: string }>>,
    ]);
    const existingCampaignById = new Map(
      existingCampaigns.map((campaign) => [campaign.campaignId, campaign]),
    );
    const existingAdSetById = new Map(
      existingAdSets.map((adSet) => [adSet.adSetId, adSet]),
    );
    const existingAdById = new Map(existingAds.map((ad) => [ad.adId, ad]));
    const leadEvidence = await this.loadLeadEvidence({
      workspaceId: input.workspaceId,
      campaignIds: campaigns.map((campaign) => campaign.id),
      adSetIds: adSets.map((adSet) => adSet.id),
      adIds: ads.map((ad) => ad.id),
    });
    const adSetClassificationById = new Map(
      adSets.map((adSet) => [
        adSet.id,
        this.whatsappClassifier.classify({
          destinationType: adSet.destinationType,
          callToActionType: null,
          hasLeadEvidence: leadEvidence.adSets.has(adSet.id),
          override: this.manualOverride(existingAdSetById.get(adSet.id)),
        }),
      ]),
    );
    const adClassificationById = new Map(
      ads.map((ad) => [
        ad.id,
        this.whatsappClassifier.classify({
          destinationType: adSetById.get(ad.adSetId)?.destinationType ?? null,
          callToActionType: ad.callToActionType,
          hasLeadEvidence: leadEvidence.ads.has(ad.id),
          override: this.manualOverride(existingAdById.get(ad.id)),
        }),
      ]),
    );
    const campaignClassificationById = new Map(
      campaigns.map((campaign) => {
        const override = this.manualOverride(
          existingCampaignById.get(campaign.id),
        );
        if (override) {
          return [
            campaign.id,
            {
              classification: override,
              source: "manual",
            },
          ];
        }

        const classification = this.campaignClassificationFromChildren([
          ...(leadEvidence.campaigns.has(campaign.id)
            ? [{ whatsappClassification: "detected_by_leads" }]
            : []),
          ...adSets
            .filter((adSet) => adSet.campaignId === campaign.id)
            .map((adSet) => ({
              whatsappClassification:
                adSetClassificationById.get(adSet.id)?.classification ??
                "not_whatsapp",
            })),
          ...ads
            .filter((ad) => ad.campaignId === campaign.id)
            .map((ad) => ({
              whatsappClassification:
                adClassificationById.get(ad.id)?.classification ??
                "not_whatsapp",
            })),
        ]);

        return [
          campaign.id,
          {
            classification,
            source:
              classification === "not_whatsapp"
                ? "children:no_signal"
                : "children",
          },
        ];
      }),
    );
    const campaignKindById = new Map(
      campaigns.map((campaign) => [
        campaign.id,
        this.campaignKindFor({
          objective: campaign.objective ?? null,
          whatsappClassification:
            campaignClassificationById.get(campaign.id)?.classification ??
            "not_whatsapp",
          adSetDestinationTypes: adSets
            .filter((adSet) => adSet.campaignId === campaign.id)
            .map((adSet) => adSet.destinationType ?? null),
          hasLeadFormEvidence: leadEvidence.leadFormCampaigns.has(campaign.id),
        }),
      ]),
    );
    const syncedAt = new Date();

    await Promise.all([
      ...campaigns.map((campaign) =>
        this.upsertCampaign({
          workspaceId: input.workspaceId,
          account: input.account,
          campaign,
          insight: insightByCampaign.get(campaign.id),
          classification:
            campaignClassificationById.get(campaign.id)?.classification ??
            "not_whatsapp",
          classificationSource:
            campaignClassificationById.get(campaign.id)?.source ??
            "children:no_signal",
          campaignKind: campaignKindById.get(campaign.id)?.kind ?? "other",
          campaignKindSource:
            campaignKindById.get(campaign.id)?.source ?? "no_signal",
          syncedAt,
        }),
      ),
      ...adSets.map((adSet) =>
        this.upsertAdSet({
          workspaceId: input.workspaceId,
          account: input.account,
          adSet,
          insight: insightByAdSet.get(adSet.id),
          classification:
            adSetClassificationById.get(adSet.id)?.classification ??
            "not_whatsapp",
          classificationSource:
            adSetClassificationById.get(adSet.id)?.source ?? "no_signal",
          syncedAt,
        }),
      ),
      ...ads.map((ad) =>
        this.upsertAd({
          workspaceId: input.workspaceId,
          account: input.account,
          ad,
          media: mediaByAdId.get(ad.id) ?? {
            previewUrl: null,
            thumbnailUrl: null,
          },
          destinationType: adSetById.get(ad.adSetId)?.destinationType ?? null,
          insight: insightByAd.get(ad.id),
          classification:
            adClassificationById.get(ad.id)?.classification ?? "not_whatsapp",
          classificationSource:
            adClassificationById.get(ad.id)?.source ?? "no_signal",
          syncedAt,
        }),
      ),
    ]);

    await this.adDestinationRouting.reconcileReportingAccount({
      workspaceId: input.workspaceId,
      reportingAccountId: input.account.id,
      adIds: ads.map((ad) => ad.id),
    });

    await Promise.all([
      this.replaceCampaignDailyInsights({
        workspaceId: input.workspaceId,
        account: input.account,
        campaignIds: campaigns.map((campaign) => campaign.id),
        insights: campaignDailyInsights,
        since: input.since,
        syncedAt,
        until: input.until,
      }),
      this.replaceAdSetDailyInsights({
        workspaceId: input.workspaceId,
        account: input.account,
        adSets: adSets.map((adSet) => ({
          adSetId: adSet.id,
          campaignId: adSet.campaignId,
        })),
        insights: adSetDailyInsights,
        since: input.since,
        syncedAt,
        until: input.until,
      }),
      this.replaceAdDailyInsights({
        workspaceId: input.workspaceId,
        account: input.account,
        ads: ads.map((ad) => ({
          adId: ad.id,
          adSetId: ad.adSetId,
          campaignId: ad.campaignId,
        })),
        insights: adDailyInsights,
        since: input.since,
        syncedAt,
        until: input.until,
      }),
    ]);

    await this.reconcileTrackingHierarchy(input.workspaceId, ads);

    return {
      campaignsSynced: campaigns.length,
      adSetsSynced: adSets.length,
      adsSynced: ads.length,
    };
  }

  private async listAdsReusingSavedMedia(input: {
    workspaceId: string;
    accessToken: string;
    account: MetaReportingAccountRecord;
  }): Promise<{
    ads: MetaAdAsset[];
    previewStats: MetaPreviewEnrichmentStats;
    savedMedia: SavedAdMedia;
  }> {
    const savedMedia = await this.loadSavedAdMedia(input);
    const { ads, previewStats } =
      await this.metaAdapter.listAdsWithPreviewStats({
        accessToken: input.accessToken,
        adAccountId: input.account.adAccountId,
        reusablePreviewUrls: savedMedia.reusablePreviewUrls,
        skipPreviewCreativeIds: savedMedia.skipPreviewCreativeIds,
      });
    this.rememberPreviewMisses(input, ads, savedMedia);

    return { ads, previewStats, savedMedia };
  }

  private previewMissKey(
    input: { workspaceId: string; account: MetaReportingAccountRecord },
    creativeId: string,
  ): string {
    return [
      input.workspaceId,
      input.account.businessId ?? "",
      input.account.adAccountId,
      creativeId,
    ].join("|");
  }

  /**
   * Remembers creatives Graph just returned without a usable preview so the
   * next syncs do not request them again within META_PREVIEW_MISS_TTL_MS.
   */
  private rememberPreviewMisses(
    input: { workspaceId: string; account: MetaReportingAccountRecord },
    ads: MetaAdAsset[],
    savedMedia: SavedAdMedia,
  ): void {
    const until = Date.now() + META_PREVIEW_MISS_TTL_MS;

    for (const ad of ads) {
      if (
        ad.creativeId &&
        (ad.previewSource === "absent" || ad.previewSource === "failed") &&
        !ad.previewUrl &&
        !savedMedia.previewByCreative.has(ad.creativeId)
      ) {
        this.previewMissUntil.set(
          this.previewMissKey(input, ad.creativeId),
          until,
        );
      }
    }
  }

  private async loadSavedAdMedia(input: {
    workspaceId: string;
    account: MetaReportingAccountRecord;
  }): Promise<SavedAdMedia> {
    // Scoped to this tenant and this exact ad account: media saved by another
    // workspace or account is never reused, even for the same creative id.
    const rows = (await this.prisma.metaAd.findMany({
      where: {
        workspaceId: input.workspaceId,
        businessId: input.account.businessId,
        adAccountId: input.account.adAccountId,
        creativeId: { not: null },
      },
      select: { creativeId: true, previewUrl: true, thumbnailUrl: true },
    })) as Array<{
      creativeId: string | null;
      previewUrl: string | null;
      thumbnailUrl: string | null;
    }>;
    const now = new Date();
    const savedMedia: SavedAdMedia = {
      reusablePreviewUrls: new Map(),
      previewByCreative: new Map(),
      thumbnailByCreative: new Map(),
      skipPreviewCreativeIds: new Set(),
    };
    const reusableExpiryByCreative = new Map<string, number>();
    const nowMs = now.getTime();

    for (const [key, until] of this.previewMissUntil) {
      if (until <= nowMs) {
        this.previewMissUntil.delete(key);
      }
    }

    for (const row of rows) {
      const creativeId = row.creativeId;

      if (!creativeId) {
        continue;
      }

      if (row.thumbnailUrl && !savedMedia.thumbnailByCreative.has(creativeId)) {
        savedMedia.thumbnailByCreative.set(creativeId, row.thumbnailUrl);
      }

      if (!row.previewUrl) {
        if (this.previewMissUntil.has(this.previewMissKey(input, creativeId))) {
          savedMedia.skipPreviewCreativeIds.add(creativeId);
        }

        continue;
      }

      if (!savedMedia.previewByCreative.has(creativeId)) {
        savedMedia.previewByCreative.set(creativeId, row.previewUrl);
        savedMedia.reusablePreviewUrls.set(creativeId, row.previewUrl);
      }

      // Expired/unknown hints still reuse the saved URL; the hint only picks
      // the freshest one when the same creative has several saved URLs.
      const freshness = evaluateMetaPreviewUrlFreshness(row.previewUrl, now);

      if (
        freshness.reusable &&
        freshness.expiresAt.getTime() >
          (reusableExpiryByCreative.get(creativeId) ?? 0)
      ) {
        reusableExpiryByCreative.set(creativeId, freshness.expiresAt.getTime());
        savedMedia.reusablePreviewUrls.set(creativeId, row.previewUrl);
        savedMedia.previewByCreative.set(creativeId, row.previewUrl);
      }
    }

    for (const creativeId of savedMedia.reusablePreviewUrls.keys()) {
      savedMedia.skipPreviewCreativeIds.delete(creativeId);
    }

    return savedMedia;
  }

  /**
   * Picks the media to persist for one ad. Prior media is only carried over
   * for the same creative id: a failed lookup keeps that creative's saved
   * preview, a thumbnail missing from the ads list keeps that creative's saved
   * thumbnail. A changed or removed creative never inherits old media, and a
   * creative Graph returned without media ("absent") is stored as null.
   */
  private resolveAdMedia(
    ad: MetaAdAsset,
    savedMedia: SavedAdMedia,
    counters: AdMediaResolutionCounters,
  ): { previewUrl: string | null; thumbnailUrl: string | null } {
    let previewUrl = ad.previewUrl ?? null;
    let thumbnailUrl = ad.thumbnailUrl ?? null;

    if (!ad.creativeId) {
      return { previewUrl: null, thumbnailUrl };
    }

    if (ad.previewSource === "failed") {
      const priorPreview = savedMedia.previewByCreative.get(ad.creativeId);

      if (priorPreview) {
        previewUrl = priorPreview;
        counters.preservedAfterFailure += 1;
      }
    }

    if (!thumbnailUrl) {
      const priorThumbnail = savedMedia.thumbnailByCreative.get(ad.creativeId);

      if (priorThumbnail) {
        thumbnailUrl = priorThumbnail;
        counters.thumbnailsPreserved += 1;
      }
    }

    return { previewUrl, thumbnailUrl };
  }

  private logPreviewEnrichment(input: {
    workspaceId: string;
    reportingAccountId: string;
    adCount: number;
    stats: MetaPreviewEnrichmentStats;
    savedMedia: SavedAdMedia;
    counters: AdMediaResolutionCounters;
  }): void {
    const { stats } = input;
    const savedNotReusable =
      input.savedMedia.previewByCreative.size -
      input.savedMedia.reusablePreviewUrls.size;

    // Aggregate counters only: no URLs, tokens or Graph error text.
    this.logger.log(
      [
        "Meta preview enrichment",
        `workspaceId=${input.workspaceId}`,
        `reportingAccountId=${input.reportingAccountId}`,
        `ads=${input.adCount}`,
        `distinctCreatives=${stats.distinctCreatives}`,
        `reused=${stats.creativesReused}`,
        `skipped=${stats.creativesSkipped}`,
        `requested=${stats.creativesRequested}`,
        `succeeded=${stats.creativesSucceeded}`,
        `failed=${stats.creativesFailed}`,
        `absent=${stats.creativesWithoutPreview}`,
        `creativeBatches=${stats.creativeBatchRequests}`,
        `videosRequested=${stats.videosRequested}`,
        `videosSucceeded=${stats.videosSucceeded}`,
        `videosFailed=${stats.videosFailed}`,
        `videoBatches=${stats.videoBatchRequests}`,
        `rateLimited=${stats.failureReasons.rateLimited}`,
        `serverError=${stats.failureReasons.serverError}`,
        `clientError=${stats.failureReasons.clientError}`,
        `missingItem=${stats.failureReasons.missingItem}`,
        `notAttempted=${stats.failureReasons.notAttempted}`,
        `transportError=${stats.failureReasons.transportError}`,
        `unexpected=${stats.failureReasons.unexpected}`,
        `savedNotReusable=${savedNotReusable}`,
        `preservedAfterFailure=${input.counters.preservedAfterFailure}`,
        `thumbnailsPreserved=${input.counters.thumbnailsPreserved}`,
      ].join(" "),
    );
  }

  private async resolveManualCampaignDailyInsights(input: {
    accessToken: string;
    adAccountId: string;
    since: string;
    until: string;
    aggregateInsights: MetaCampaignInsight[];
    dailyInsights: MetaCampaignDailyInsight[];
  }): Promise<MetaCampaignDailyInsight[]> {
    if (
      this.campaignDailySpendMatchesAggregate(
        input.aggregateInsights,
        input.dailyInsights,
        input.since,
        input.until,
      )
    ) {
      return input.dailyInsights;
    }

    this.logger.warn(
      `Meta daily insights diverged for ${input.adAccountId} from ${input.since} to ${input.until}; retrying one day at a time`,
    );
    const recoveredInsights = await this.listCampaignDailyInsightsByDate(input);

    if (
      !this.campaignDailySpendMatchesAggregate(
        input.aggregateInsights,
        recoveredInsights,
        input.since,
        input.until,
      )
    ) {
      throw new Error(
        "Meta retornou totais diarios inconsistentes com o investimento agregado",
      );
    }

    return recoveredInsights;
  }

  private campaignDailySpendMatchesAggregate(
    aggregateInsights: MetaCampaignInsight[],
    dailyInsights: MetaCampaignDailyInsight[],
    since: string,
    until: string,
  ): boolean {
    return this.dailySpendMatchesAggregate(
      aggregateInsights,
      dailyInsights,
      (insight) => insight.campaignId,
      (insight) => insight.campaignId,
      since,
      until,
    );
  }

  private async resolveManualAdSetDailyInsights(input: {
    accessToken: string;
    adAccountId: string;
    since: string;
    until: string;
    aggregateInsights: MetaAdSetInsight[];
    dailyInsights: MetaAdSetDailyInsight[];
  }): Promise<MetaAdSetDailyInsight[]> {
    const matchesAggregate = (dailyInsights: MetaAdSetDailyInsight[]) =>
      this.dailySpendMatchesAggregate(
        input.aggregateInsights,
        dailyInsights,
        (insight) => insight.adSetId,
        (insight) => insight.adSetId,
        input.since,
        input.until,
      );

    if (matchesAggregate(input.dailyInsights)) {
      return input.dailyInsights;
    }

    this.logger.warn(
      `Meta ad set daily insights diverged for ${input.adAccountId} from ${input.since} to ${input.until}; retrying one day at a time`,
    );
    const recoveredInsights = await this.listAdSetDailyInsightsByDate(input);

    if (!matchesAggregate(recoveredInsights)) {
      throw new Error(
        "Meta retornou totais diarios de conjuntos inconsistentes com o investimento agregado",
      );
    }

    return recoveredInsights;
  }

  private async resolveManualAdDailyInsights(input: {
    accessToken: string;
    adAccountId: string;
    since: string;
    until: string;
    aggregateInsights: MetaAdInsight[];
    dailyInsights: MetaAdDailyInsight[];
  }): Promise<MetaAdDailyInsight[]> {
    const matchesAggregate = (dailyInsights: MetaAdDailyInsight[]) =>
      this.dailySpendMatchesAggregate(
        input.aggregateInsights,
        dailyInsights,
        (insight) => insight.adId,
        (insight) => insight.adId,
        input.since,
        input.until,
      );

    if (matchesAggregate(input.dailyInsights)) {
      return input.dailyInsights;
    }

    this.logger.warn(
      `Meta ad daily insights diverged for ${input.adAccountId} from ${input.since} to ${input.until}; retrying one day at a time`,
    );
    const recoveredInsights = await this.listAdDailyInsightsByDate(input);

    if (!matchesAggregate(recoveredInsights)) {
      throw new Error(
        "Meta retornou totais diarios de anuncios inconsistentes com o investimento agregado",
      );
    }

    return recoveredInsights;
  }

  private dailySpendMatchesAggregate<
    TAggregate extends { spendCents: number },
    TDaily extends { spendCents: number },
  >(
    aggregateInsights: TAggregate[],
    dailyInsights: TDaily[],
    aggregateId: (insight: TAggregate) => string,
    dailyId: (insight: TDaily) => string,
    since: string,
    until: string,
  ): boolean {
    const aggregateSpend = new Map<string, number>();
    const dailySpend = new Map<string, number>();

    for (const insight of aggregateInsights) {
      aggregateSpend.set(aggregateId(insight), insight.spendCents);
    }

    for (const insight of dailyInsights) {
      const entityId = dailyId(insight);
      dailySpend.set(
        entityId,
        (dailySpend.get(entityId) ?? 0) + insight.spendCents,
      );
    }

    const campaignIds = new Set([
      ...aggregateSpend.keys(),
      ...dailySpend.keys(),
    ]);
    const roundingToleranceCents = Math.max(
      1,
      this.reportDateRange(since, until).length,
    );

    return [...campaignIds].every(
      (entityId) =>
        Math.abs(
          (aggregateSpend.get(entityId) ?? 0) - (dailySpend.get(entityId) ?? 0),
        ) <= roundingToleranceCents,
    );
  }

  private async listCampaignDailyInsightsByDate(input: {
    accessToken: string;
    adAccountId: string;
    since: string;
    until: string;
  }): Promise<MetaCampaignDailyInsight[]> {
    const dates = this.reportDateRange(input.since, input.until);
    const results: MetaCampaignDailyInsight[] = [];
    const concurrency = 3;

    for (let index = 0; index < dates.length; index += concurrency) {
      const batch = await Promise.all(
        dates.slice(index, index + concurrency).map(async (date) => {
          const insights = await this.metaAdapter.listCampaignInsights({
            accessToken: input.accessToken,
            adAccountId: input.adAccountId,
            since: date,
            until: date,
            readMode: "manual",
          });

          return insights.map((insight) => ({ ...insight, date }));
        }),
      );

      results.push(...batch.flat());
    }

    return results;
  }

  private async listAdSetDailyInsightsByDate(input: {
    accessToken: string;
    adAccountId: string;
    since: string;
    until: string;
  }): Promise<MetaAdSetDailyInsight[]> {
    const dates = this.reportDateRange(input.since, input.until);
    const results: MetaAdSetDailyInsight[] = [];
    const concurrency = 3;

    for (let index = 0; index < dates.length; index += concurrency) {
      const batch = await Promise.all(
        dates.slice(index, index + concurrency).map(async (date) => {
          const insights = await this.metaAdapter.listAdSetInsights({
            accessToken: input.accessToken,
            adAccountId: input.adAccountId,
            since: date,
            until: date,
            readMode: "manual",
          });

          return insights.map((insight) => ({ ...insight, date }));
        }),
      );

      results.push(...batch.flat());
    }

    return results;
  }

  private async listAdDailyInsightsByDate(input: {
    accessToken: string;
    adAccountId: string;
    since: string;
    until: string;
  }): Promise<MetaAdDailyInsight[]> {
    const dates = this.reportDateRange(input.since, input.until);
    const results: MetaAdDailyInsight[] = [];
    const concurrency = 3;

    for (let index = 0; index < dates.length; index += concurrency) {
      const batch = await Promise.all(
        dates.slice(index, index + concurrency).map(async (date) => {
          const insights = await this.metaAdapter.listAdInsights({
            accessToken: input.accessToken,
            adAccountId: input.adAccountId,
            since: date,
            until: date,
            readMode: "manual",
          });

          return insights.map((insight) => ({ ...insight, date }));
        }),
      );

      results.push(...batch.flat());
    }

    return results;
  }

  private async replaceCampaignDailyInsights(input: {
    workspaceId: string;
    account: MetaReportingAccountRecord;
    campaignIds: string[];
    insights: MetaCampaignDailyInsight[];
    since: string;
    until: string;
    syncedAt: Date;
  }): Promise<void> {
    await this.prisma.metaCampaignDailyInsight.deleteMany({
      where: {
        workspaceId: input.workspaceId,
        adAccountId: input.account.adAccountId,
        localDate: { gte: input.since, lte: input.until },
      },
    });

    if (input.campaignIds.length === 0) {
      return;
    }

    const insightByCampaignAndDate = new Map(
      input.insights.map((insight) => [
        `${insight.campaignId}:${insight.date}`,
        insight,
      ]),
    );
    const dates = this.reportDateRange(input.since, input.until);

    await this.prisma.metaCampaignDailyInsight.createMany({
      data: input.campaignIds.flatMap((campaignId) =>
        dates.map((localDate) => {
          const insight = insightByCampaignAndDate.get(
            `${campaignId}:${localDate}`,
          );

          return {
            workspaceId: input.workspaceId,
            businessId: input.account.businessId,
            adAccountId: input.account.adAccountId,
            campaignId,
            localDate,
            spendCents: insight?.spendCents ?? 0,
            impressions: insight?.impressions ?? 0,
            clicks: insight?.clicks ?? 0,
            metaConversationsStarted: insight?.metaConversationsStarted ?? 0,
            syncedAt: input.syncedAt,
          };
        }),
      ),
    });
  }

  private async replaceAdSetDailyInsights(input: {
    workspaceId: string;
    account: MetaReportingAccountRecord;
    adSets: Array<{ adSetId: string; campaignId: string }>;
    insights: MetaAdSetDailyInsight[];
    since: string;
    until: string;
    syncedAt: Date;
  }): Promise<void> {
    await this.prisma.metaAdSetDailyInsight.deleteMany({
      where: {
        workspaceId: input.workspaceId,
        adAccountId: input.account.adAccountId,
        localDate: { gte: input.since, lte: input.until },
      },
    });

    if (input.adSets.length === 0) {
      return;
    }

    const insightByAdSetAndDate = new Map(
      input.insights.map((insight) => [
        `${insight.adSetId}:${insight.date}`,
        insight,
      ]),
    );
    const dates = this.reportDateRange(input.since, input.until);

    await this.prisma.metaAdSetDailyInsight.createMany({
      data: input.adSets.flatMap((adSet) =>
        dates.map((localDate) => {
          const insight = insightByAdSetAndDate.get(
            `${adSet.adSetId}:${localDate}`,
          );

          return {
            workspaceId: input.workspaceId,
            businessId: input.account.businessId,
            adAccountId: input.account.adAccountId,
            campaignId: adSet.campaignId,
            adSetId: adSet.adSetId,
            localDate,
            spendCents: insight?.spendCents ?? 0,
            impressions: insight?.impressions ?? 0,
            clicks: insight?.clicks ?? 0,
            metaConversationsStarted: insight?.metaConversationsStarted ?? 0,
            syncedAt: input.syncedAt,
          };
        }),
      ),
    });
  }

  private async replaceAdDailyInsights(input: {
    workspaceId: string;
    account: MetaReportingAccountRecord;
    ads: Array<{ adId: string; adSetId: string; campaignId: string }>;
    insights: MetaAdDailyInsight[];
    since: string;
    until: string;
    syncedAt: Date;
  }): Promise<void> {
    await this.prisma.metaAdDailyInsight.deleteMany({
      where: {
        workspaceId: input.workspaceId,
        adAccountId: input.account.adAccountId,
        localDate: { gte: input.since, lte: input.until },
      },
    });

    if (input.ads.length === 0) {
      return;
    }

    const insightByAdAndDate = new Map(
      input.insights.map((insight) => [
        `${insight.adId}:${insight.date}`,
        insight,
      ]),
    );
    const dates = this.reportDateRange(input.since, input.until);

    await this.prisma.metaAdDailyInsight.createMany({
      data: input.ads.flatMap((ad) =>
        dates.map((localDate) => {
          const insight = insightByAdAndDate.get(`${ad.adId}:${localDate}`);

          return {
            workspaceId: input.workspaceId,
            businessId: input.account.businessId,
            adAccountId: input.account.adAccountId,
            campaignId: ad.campaignId,
            adSetId: ad.adSetId,
            adId: ad.adId,
            localDate,
            spendCents: insight?.spendCents ?? 0,
            impressions: insight?.impressions ?? 0,
            clicks: insight?.clicks ?? 0,
            metaConversationsStarted: insight?.metaConversationsStarted ?? 0,
            syncedAt: input.syncedAt,
          };
        }),
      ),
    });
  }

  private async reconcileTrackingHierarchy(
    workspaceId: string,
    ads: MetaAdAsset[],
  ): Promise<void> {
    const hierarchyGroups = new Map<
      string,
      { campaignId: string; adSetId: string; adIds: string[] }
    >();

    for (const ad of ads) {
      const key = `${ad.campaignId}:${ad.adSetId}`;
      const group = hierarchyGroups.get(key);

      if (group) {
        group.adIds.push(ad.id);
      } else {
        hierarchyGroups.set(key, {
          campaignId: ad.campaignId,
          adSetId: ad.adSetId,
          adIds: [ad.id],
        });
      }
    }

    let leadsUpdated = 0;
    let eventsUpdated = 0;

    for (const group of hierarchyGroups.values()) {
      const [leadResult, eventResult] = await Promise.all([
        this.prisma.lead.updateMany({
          where: {
            workspaceId,
            adId: { in: group.adIds },
            OR: [
              { campaignId: null },
              { adSetId: null },
              { campaignId: { not: group.campaignId } },
              { adSetId: { not: group.adSetId } },
            ],
          },
          data: {
            campaignId: group.campaignId,
            adSetId: group.adSetId,
          },
        }),
        this.prisma.conversionEventLog.updateMany({
          where: {
            workspaceId,
            adId: { in: group.adIds },
            OR: [
              { campaignId: null },
              { adSetId: null },
              { campaignId: { not: group.campaignId } },
              { adSetId: { not: group.adSetId } },
            ],
          },
          data: {
            campaignId: group.campaignId,
            adSetId: group.adSetId,
          },
        }),
      ]);
      leadsUpdated += leadResult.count;
      eventsUpdated += eventResult.count;
    }

    if (leadsUpdated > 0 || eventsUpdated > 0) {
      this.logger.log(
        `Meta ad hierarchy reconciled for workspace ${workspaceId}: ${leadsUpdated} leads, ${eventsUpdated} events`,
      );
    }
  }

  private async recordMetaReportingSyncDiagnostics(input: {
    input: MetaStructureSyncInput;
    startedAt: Date;
    result?: MetaStructureSyncResult;
    error?: unknown;
    legacyShadowParity?: LegacyRouteShadowParity | null;
  }): Promise<void> {
    const finishedAt = new Date();
    const errorMessage =
      input.error instanceof Error
        ? input.error.message
        : input.error
          ? "Erro desconhecido ao sincronizar relatorios Meta"
          : null;
    const status = input.error ? "error" : "success";

    try {
      const integrationLog = await this.prisma.integrationLog.create({
        data: {
          workspaceId: input.input.workspaceId,
          source: "meta",
          operation: "meta.reporting.sync",
          status,
          startedAt: input.startedAt,
          finishedAt,
          durationMs: Math.max(
            0,
            finishedAt.getTime() - input.startedAt.getTime(),
          ),
          providerRequestId: null,
          providerErrorCode: input.error ? "MetaReportingSyncError" : null,
          providerErrorMessage: errorMessage,
          requestSummary: {
            since: input.input.since,
            until: input.input.until,
            ...(input.input.businessConnectionId
              ? {
                  businessConnectionId: input.input.businessConnectionId,
                  reportingAccountId: input.input.reportingAccountId,
                }
              : {}),
            ...(input.legacyShadowParity
              ? { legacyShadowParity: input.legacyShadowParity }
              : {}),
          } as Prisma.InputJsonValue,
          responseSummary: input.result
            ? ({
                accountsSynced: input.result.accountsSynced,
                accountsFailed: input.result.accountsFailed,
                campaignsSynced: input.result.campaignsSynced,
                adSetsSynced: input.result.adSetsSynced,
                adsSynced: input.result.adsSynced,
              } as Prisma.InputJsonValue)
            : ({
                errorMessage,
              } as Prisma.InputJsonValue),
        },
      });
      await this.prisma.diagnosticEvent.create({
        data: {
          workspaceId: input.input.workspaceId,
          source: "meta",
          eventType: "meta.reporting.sync",
          severity: input.error ? "error" : "info",
          status,
          occurredAt: finishedAt,
          title: input.error
            ? "Falha na sincronizacao de relatorios Meta"
            : "Sincronizacao de relatorios Meta concluida",
          message: input.error
            ? (errorMessage ?? "A sincronizacao Meta falhou.")
            : "Campanhas, conjuntos e anuncios Meta foram sincronizados.",
          jobId: null,
          errorCode: input.error ? "MetaReportingSyncError" : null,
          integrationLogId: integrationLog.id,
          summaryPayload: {
            since: input.input.since,
            until: input.input.until,
            status,
            ...(input.input.businessConnectionId
              ? {
                  businessConnectionId: input.input.businessConnectionId,
                  reportingAccountId: input.input.reportingAccountId,
                }
              : {}),
            ...(input.legacyShadowParity
              ? { legacyShadowParity: input.legacyShadowParity }
              : {}),
            ...(input.result
              ? {
                  accountsSynced: input.result.accountsSynced,
                  accountsFailed: input.result.accountsFailed,
                  campaignsSynced: input.result.campaignsSynced,
                  adSetsSynced: input.result.adSetsSynced,
                  adsSynced: input.result.adsSynced,
                }
              : {
                  errorMessage,
                }),
          } as Prisma.InputJsonValue,
        },
      });
    } catch {
      return;
    }
  }

  private async compareLegacyReportingProjection(input: {
    workspaceId: string;
    accessToken: string;
    selectedAdAccountId: string | null;
    accounts: MetaReportingAccountRecord[];
  }): Promise<LegacyRouteShadowParity | null> {
    if (!this.connectionResolver) {
      return null;
    }

    try {
      const projection =
        await this.connectionResolver.getLegacyCompatibilityProjection(
          input.workspaceId,
          "reporting",
        );
      const credentialFingerprintMatch =
        this.encryption.fingerprint(input.accessToken) ===
        projection.credentialFingerprint;
      const adAccountMatch =
        input.selectedAdAccountId === projection.adAccountId &&
        (projection.adAccountId === null ||
          input.accounts.some(
            (account) => account.adAccountId === projection.adAccountId,
          ));
      const parity = credentialFingerprintMatch && adAccountMatch;

      return {
        comparisonStatus: parity ? "matched" : "mismatch",
        credentialFingerprintMatch,
        adAccountMatch,
        pixelMatch: null,
        pageMatch: null,
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

  async getCampaignReportOverview(
    input: {
      workspaceId: string;
      rangeLabel: string;
      since?: string;
      until?: string;
      includeSummary?: boolean;
      includeDaily?: boolean;
    } & ReportFilterInput,
  ): Promise<ReportOverviewDto> {
    const startedAt = Date.now();
    const hierarchyScope = await this.metaHierarchyScope(input);
    const campaignWhere = this.metaSnapshotWhereFromHierarchy(
      hierarchyScope.where,
      input,
    );
    const usesWhatsappDefault =
      input.campaignKind !== "lead_form" &&
      (input.whatsappClassification ?? "whatsapp") === "whatsapp";
    const needsChildNameFilter = this.needsCampaignChildNameFilter(input);
    const childWhere =
      usesWhatsappDefault || needsChildNameFilter
        ? await this.metaChildSnapshotWhere(hierarchyScope.where, input)
        : null;
    const [campaigns, whatsappAdSets, whatsappAds, funnelStages, deliveredIds] =
      (await Promise.all([
        this.prisma.metaCampaign.findMany({
          where: campaignWhere,
          orderBy: { name: "asc" },
        }),
        childWhere
          ? this.prisma.metaAdSet.findMany({
              where: childWhere,
              orderBy: { name: "asc" },
            })
          : Promise.resolve([]),
        childWhere
          ? this.prisma.metaAd.findMany({
              where: childWhere,
              orderBy: { name: "asc" },
            })
          : Promise.resolve([]),
        this.getFunnelStages(input.workspaceId),
        this.deliveredEntityIds("campaign", input),
      ])) as [
        MetaCampaignRecord[],
        MetaAdSetRecord[],
        MetaAdRecord[],
        FunnelStageConfigurationDto[],
        Set<string> | null,
      ];
    const filteredCampaigns = this.filterCampaignRecords(
      campaigns,
      input,
      whatsappAdSets,
      whatsappAds,
      deliveredIds,
    );
    const campaignIds = filteredCampaigns.map(
      (campaign) => campaign.campaignId,
    );
    const summaryScope = this.summaryMetricScope(input, campaignIds);
    const needsWorkspaceMetrics = input.includeSummary || input.includeDaily;
    const [
      rawConversionLogs,
      leads,
      rawWorkspaceConversionLogs,
      workspaceLeads,
      dailyInsights,
      returningEvents,
      workspaceReturningEvents,
    ] = await Promise.all([
      this.getMetricConversionEvents(input, { campaignIds }),
      this.getLeads(input, { campaignIds }),
      needsWorkspaceMetrics
        ? this.getMetricConversionEvents(input, summaryScope)
        : Promise.resolve([]),
      needsWorkspaceMetrics
        ? this.getLeads(input, summaryScope)
        : Promise.resolve([]),
      input.includeDaily && input.since && input.until && campaignIds.length
        ? (this.prisma.metaCampaignDailyInsight.findMany({
            where: {
              workspaceId: input.workspaceId,
              campaignId: { in: campaignIds },
              localDate: { gte: input.since, lte: input.until },
            },
            select: {
              campaignId: true,
              localDate: true,
              spendCents: true,
              metaConversationsStarted: true,
            },
          }) as Promise<MetaCampaignDailyInsightRecord[]>)
        : Promise.resolve([] as MetaCampaignDailyInsightRecord[]),
      this.getReturningLeadEvents(input, { campaignIds }),
      needsWorkspaceMetrics
        ? this.getReturningLeadEvents(input, summaryScope)
        : Promise.resolve([]),
    ]);
    // Revenue attributed to an ad is converted to its account currency.
    const currencyContext = this.reportCurrencyContext({
      accountCurrencies: hierarchyScope.accountCurrencies,
      campaigns,
      adSets: whatsappAdSets,
      ads: whatsappAds,
    });
    const [conversionLogs, workspaceConversionLogs] =
      await this.convertReportEvents(currencyContext, [
        rawConversionLogs,
        rawWorkspaceConversionLogs,
      ]);
    // "Conversaram mais de uma vez": conversations without a lead id count
    // for every lead of their phone, resolved from the database like the
    // Leads page does (shared helper).
    const leadIdsByPhoneHash = await loadLeadIdsByPhoneHash(
      this.prisma,
      input.workspaceId,
      phoneHashesWithoutLeadId(
        [...conversionLogs, ...workspaceConversionLogs].filter(
          (event) =>
            event.eventName === "LeadSubmitted" &&
            event.status !== "skipped" &&
            event.businessSource?.trim().toLowerCase() !== "organic",
        ),
      ),
    );
    const conversionLogsByCampaign = this.groupByOptionalKey(
      conversionLogs,
      "campaignId",
    );
    const leadsByCampaign = this.groupByOptionalKey(leads, "campaignId");
    const returningEventsByCampaign = this.groupByOptionalKey(
      returningEvents,
      "campaignId",
    );
    const childMetricByCampaign = this.campaignMetricOverrides(
      usesWhatsappDefault ? whatsappAdSets : [],
      usesWhatsappDefault ? whatsappAds : [],
    );
    const dailyMetricByCampaign = this.dailyCampaignMetrics(dailyInsights);
    const expectedDailyDates =
      input.since && input.until
        ? this.reportDateRange(input.since, input.until).length
        : 0;
    const dailyDatesByCampaign = new Map<string, Set<string>>();

    for (const insight of dailyInsights) {
      const dates =
        dailyDatesByCampaign.get(insight.campaignId) ?? new Set<string>();
      dates.add(insight.localDate);
      dailyDatesByCampaign.set(insight.campaignId, dates);
    }
    const dailyComparisonAvailable =
      Boolean(input.includeDaily) &&
      expectedDailyDates > 0 &&
      filteredCampaigns.length > 0 &&
      filteredCampaigns.every(
        (campaign) =>
          dailyDatesByCampaign.get(campaign.campaignId)?.size ===
          expectedDailyDates,
      );
    const metricByCampaign = dailyComparisonAvailable
      ? dailyMetricByCampaign
      : childMetricByCampaign;
    const paginated = this.paginateReportRows(
      filteredCampaigns,
      input,
      (campaign) => ({
        ...this.toReportRow(
          campaign,
          conversionLogsByCampaign.get(campaign.campaignId) ?? [],
          leadsByCampaign.get(campaign.campaignId) ?? [],
          funnelStages,
          metricByCampaign.get(campaign.campaignId),
          returningEventsByCampaign.get(campaign.campaignId) ?? [],
          leadIdsByPhoneHash,
        ),
        currency: currencyContext.accountCurrency(campaign.adAccountId),
        ...rowExchangeRateFields(
          conversionLogsByCampaign.get(campaign.campaignId) ?? [],
        ),
      }),
    );
    const rows = paginated.items;
    const workspaceMeta = filteredCampaigns.reduce(
      (totals, campaign) => {
        const metricOverride = metricByCampaign.get(campaign.campaignId);

        totals.spendCents += metricOverride?.spendCents ?? campaign.spendCents;
        totals.metaConversationsStarted +=
          metricOverride?.metaConversationsStarted ??
          campaign.metaConversationsStarted;

        return totals;
      },
      { spendCents: 0, metaConversationsStarted: 0 },
    );
    const totals = this.calculateMetrics({
      funnelStages,
      spendCents: workspaceMeta.spendCents,
      metaConversationsStarted: workspaceMeta.metaConversationsStarted,
      events: conversionLogs,
      leads,
      returningEvents,
      leadIdsByPhoneHash,
      scope: {},
    });
    const summary: CampaignReportRowDto | undefined = input.includeSummary
      ? {
          id: "workspace_summary",
          name: "Resumo do workspace",
          status: filteredCampaigns.some(
            (campaign) => this.toReportStatus(campaign.status) === "active",
          )
            ? "active"
            : "unknown",
          ...this.calculateMetrics({
            funnelStages,
            spendCents: workspaceMeta.spendCents,
            metaConversationsStarted: workspaceMeta.metaConversationsStarted,
            events: workspaceConversionLogs,
            leads: workspaceLeads,
            returningEvents: workspaceReturningEvents,
            leadIdsByPhoneHash,
            scope: {},
          }),
        }
      : undefined;
    // Never sum different currencies: one group per currency with activity.
    const campaignCurrencyEntities: CurrencyEntity[] = filteredCampaigns.map(
      (campaign) => {
        const metricOverride = metricByCampaign.get(campaign.campaignId);

        return {
          currency: currencyContext.accountCurrency(campaign.adAccountId),
          adAccountId: campaign.adAccountId ?? null,
          spendCents: metricOverride?.spendCents ?? campaign.spendCents,
          metaConversationsStarted:
            metricOverride?.metaConversationsStarted ??
            campaign.metaConversationsStarted,
        };
      },
    );
    const totalsCurrency = await this.currencyBreakdown({
      workspaceId: input.workspaceId,
      context: currencyContext,
      funnelStages,
      entities: campaignCurrencyEntities,
      events: conversionLogs,
      leads,
      returningEvents,
      leadIdsByPhoneHash,
    });
    const summaryCurrency = summary
      ? await this.currencyBreakdown({
          workspaceId: input.workspaceId,
          context: currencyContext,
          funnelStages,
          entities: campaignCurrencyEntities,
          events: workspaceConversionLogs,
          leads: workspaceLeads,
          returningEvents: workspaceReturningEvents,
          leadIdsByPhoneHash,
        })
      : null;
    const reportCurrency =
      totalsCurrency.currency &&
      (!summaryCurrency || summaryCurrency.currency === totalsCurrency.currency)
        ? totalsCurrency.currency
        : null;
    // `currency: null` always comes with `byCurrency`: when only the summary
    // mixes currencies (e.g. an organic sale in USD), the single-currency
    // totals become their one group.
    const totalsByCurrency =
      totalsCurrency.byCurrency ??
      (reportCurrency === null && totalsCurrency.currency
        ? [
            {
              ...totals,
              currency: totalsCurrency.currency,
              adAccountIds: [
                ...new Set(
                  campaignCurrencyEntities
                    .filter(
                      (entity) => entity.currency === totalsCurrency.currency,
                    )
                    .map((entity) => entity.adAccountId)
                    .filter((id): id is string => Boolean(id)),
                ),
              ],
              exchangeRateMissing: totalsCurrency.exchangeRateMissing,
              unconvertedRevenue: totalsCurrency.unconvertedRevenue,
            },
          ]
        : undefined);
    const summaryByCurrency =
      summaryCurrency?.byCurrency ??
      (reportCurrency === null && summary && summaryCurrency?.currency
        ? (() => {
            const {
              id: _id,
              name: _name,
              status: _status,
              ...summaryMetrics
            } = summary;

            return [
              {
                ...summaryMetrics,
                currency: summaryCurrency.currency,
                adAccountIds: [
                  ...new Set(
                    campaignCurrencyEntities
                      .filter(
                        (entity) =>
                          entity.currency === summaryCurrency.currency,
                      )
                      .map((entity) => entity.adAccountId)
                      .filter((id): id is string => Boolean(id)),
                  ),
                ],
                exchangeRateMissing: summaryCurrency.exchangeRateMissing,
                unconvertedRevenue: summaryCurrency.unconvertedRevenue,
              },
            ];
          })()
        : undefined);
    const dailyComparison =
      input.includeDaily && input.since && input.until
        ? this.dailyComparison({
            dailyInsights,
            leads: workspaceLeads,
            returningEvents: workspaceReturningEvents,
            since: input.since,
            until: input.until,
          })
        : undefined;

    this.logReportRead("campaigns", startedAt, {
      returned: rows.length,
      total: filteredCampaigns.length,
    });

    return {
      workspaceId: input.workspaceId,
      rangeLabel: input.rangeLabel,
      since: input.since ?? null,
      until: input.until ?? null,
      campaigns: rows,
      ...(summary
        ? {
            summary: {
              ...summary,
              ...(summaryCurrency?.currency
                ? { currency: summaryCurrency.currency }
                : {}),
              ...(summaryCurrency?.exchangeRateMissing
                ? {
                    exchangeRateMissing: true,
                    unconvertedRevenue: summaryCurrency.unconvertedRevenue,
                  }
                : {}),
            },
          }
        : {}),
      totals,
      ...this.currencyFields({
        ...totalsCurrency,
        currency: reportCurrency,
        ...(totalsByCurrency ? { byCurrency: totalsByCurrency } : {}),
      }),
      ...(summaryByCurrency ? { summaryByCurrency } : {}),
      ...(dailyComparison ? { dailyComparison } : {}),
      ...(input.includeDaily ? { dailyComparisonAvailable } : {}),
      ...(paginated.pagination ? { pagination: paginated.pagination } : {}),
    };
  }

  async getConversionEventAudit(input: {
    workspaceId: string;
    rangeLabel: string;
    since?: string;
    until?: string;
    eventName?: string;
    deliveryState?: ConversionAuditDeliveryStateDto;
    source?: ConversionAuditSourceDto;
    page: number;
    pageSize: number;
  }): Promise<ConversionAuditOverviewDto> {
    const where = this.conversionAuditWhere(input);
    const [events, statusGroups, funnelStages] = await Promise.all([
      this.prisma.conversionEventLog.findMany({
        where,
        orderBy: [{ eventOccurredAt: "desc" }, { id: "desc" }],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        select: {
          id: true,
          eventName: true,
          leadId: true,
          phoneHash: true,
          sourceTrigger: true,
          campaignId: true,
          adSetId: true,
          adId: true,
          ctwaClid: true,
          pixelId: true,
          pageId: true,
          eventOccurredAt: true,
          sentAt: true,
          status: true,
          providerResponseSummary: true,
          errorCode: true,
          errorMessage: true,
          valueCents: true,
          valueSource: true,
        },
      }) as Promise<ConversionAuditEventRecord[]>,
      this.prisma.conversionEventLog.groupBy({
        by: ["status"],
        where,
        _count: { _all: true },
      }),
      this.getFunnelStages(input.workspaceId),
    ]);
    const eventLabels = new Map<string, string>(
      funnelStages.map((stage) => [stage.eventName, stage.label]),
    );
    const context = await this.conversionAuditContext(
      input.workspaceId,
      events,
    );
    const statusCounts = new Map(
      statusGroups.map((group) => [group.status, group._count._all]),
    );
    const total = statusGroups.reduce(
      (sum, group) => sum + group._count._all,
      0,
    );
    const summary = {
      total,
      sent: this.conversionAuditStateCount(statusCounts, "sent"),
      queued: this.conversionAuditStateCount(statusCounts, "queued"),
      blocked: this.conversionAuditStateCount(statusCounts, "blocked"),
      failed: this.conversionAuditStateCount(statusCounts, "failed"),
      notEligible: this.conversionAuditStateCount(statusCounts, "not_eligible"),
      shadowObserved: this.conversionAuditStateCount(statusCounts, "shadow"),
      historical: this.conversionAuditStateCount(statusCounts, "historical"),
      discarded: this.conversionAuditStateCount(statusCounts, "discarded"),
    };

    return {
      workspaceId: input.workspaceId,
      rangeLabel: input.rangeLabel,
      summary,
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        totalItems: total,
        totalPages: Math.ceil(total / input.pageSize),
      },
      events: events.map((event) =>
        this.conversionAuditEventDto(event, eventLabels, context),
      ),
    };
  }

  async getBlockedConversionEventRetryIds(
    input: ConversionAuditFilters,
  ): Promise<string[]> {
    const events = await this.prisma.conversionEventLog.findMany({
      where: {
        AND: [
          this.conversionAuditWhere(input),
          configurationBlockedConversionEventWhere,
        ],
      },
      orderBy: [{ eventOccurredAt: "desc" }, { id: "desc" }],
      take: BLOCKED_CONVERSION_RETRY_LIMIT,
      select: { id: true },
    });

    return events.map((event) => event.id);
  }

  async getConversionEventAuditDetail(input: {
    workspaceId: string;
    eventId: string;
  }): Promise<ConversionAuditEventDetailDto> {
    const event = (await this.prisma.conversionEventLog.findFirst({
      where: {
        id: input.eventId,
        workspaceId: input.workspaceId,
      },
      select: {
        id: true,
        workspaceId: true,
        eventName: true,
        leadId: true,
        phoneHash: true,
        sourceTrigger: true,
        campaignId: true,
        adSetId: true,
        adId: true,
        pixelId: true,
        pageId: true,
        eventId: true,
        dedupeKey: true,
        sourceEventId: true,
        ctwaClid: true,
        eventOccurredAt: true,
        sentAt: true,
        status: true,
        sourcePayload: true,
        providerRequestPayload: true,
        providerResponseSummary: true,
        customData: true,
        valueCents: true,
        valueSource: true,
        currency: true,
        contentName: true,
        errorCode: true,
        errorMessage: true,
      },
    })) as ConversionAuditEventDetailRecord | null;

    if (!event) {
      throw new NotFoundException("Evento de conversao nao encontrado");
    }

    const [funnelStages, ingestionRecord, context] = await Promise.all([
      this.getFunnelStages(input.workspaceId),
      this.prisma.externalIngestionRecord.findFirst({
        where: {
          workspaceId: input.workspaceId,
          conversionEventLogId: event.id,
        },
        orderBy: { lastReceivedAt: "desc" },
        select: {
          summaryPayload: true,
          errorCode: true,
          errorMessage: true,
        },
      }),
      this.conversionAuditContext(input.workspaceId, [event]),
    ]);
    const eventLabels = new Map<string, string>(
      funnelStages.map((stage) => [stage.eventName, stage.label]),
    );
    const base = this.conversionAuditEventDto(event, eventLabels, context);
    const sourceSnapshot = this.conversionAuditSourceSnapshot(
      event,
      ingestionRecord?.summaryPayload,
    );
    const storedRequest = this.conversionAuditObject(
      event.providerRequestPayload,
    );
    const reconstructedRequest = storedRequest
      ? null
      : this.reconstructMetaCapiRequest(event);
    const response = this.conversionAuditObject(event.providerResponseSummary);
    const missingFields = this.conversionAuditMissingFields(event);
    const reasonCode =
      event.errorCode ??
      ingestionRecord?.errorCode ??
      this.conversionAuditInferredReasonCode(event, missingFields);

    return {
      ...base,
      reasonCode,
      reason: reasonCode
        ? this.conversionAuditSafeError(reasonCode)
        : missingFields.length
          ? this.conversionAuditMissingFieldsReason(missingFields)
          : null,
      missingFields,
      sourceSnapshot,
      metaRequest: storedRequest
        ? {
            mode: "stored",
            label: "Payload exato armazenado no envio",
            payload: storedRequest,
          }
        : reconstructedRequest
          ? {
              mode: "reconstructed",
              label: "Payload reconstruido a partir do evento historico",
              payload: reconstructedRequest,
            }
          : {
              mode: "unavailable",
              label: "Payload de envio indisponivel",
              payload: null,
            },
      metaResponse: response
        ? {
            mode: "stored",
            label: "Resposta armazenada da Meta",
            payload: response,
          }
        : {
            mode: "unavailable",
            label: "Nenhuma resposta da Meta armazenada",
            payload: null,
          },
    };
  }

  async saveWhatsappClassificationOverride(input: {
    workspaceId: string;
    actorUserId: string | null;
    level: WhatsappOverrideLevel;
    id: string;
    override: WhatsappManualOverride | null;
  }): Promise<{
    ok: true;
    whatsappClassification: WhatsappClassification;
  }> {
    const data = input.override
      ? {
          classificationOverride: input.override,
          whatsappClassification: input.override,
          classificationSource: "manual",
        }
      : await this.resetWhatsappClassificationData(input);
    let result: { count: number };

    if (input.level === "campaign") {
      result = await this.prisma.metaCampaign.updateMany({
        where: { workspaceId: input.workspaceId, campaignId: input.id },
        data,
      });
    } else if (input.level === "adset") {
      result = await this.prisma.metaAdSet.updateMany({
        where: { workspaceId: input.workspaceId, adSetId: input.id },
        data,
      });
    } else {
      result = await this.prisma.metaAd.updateMany({
        where: { workspaceId: input.workspaceId, adId: input.id },
        data,
      });
    }

    if (result.count === 0) {
      throw new NotFoundException("Classificacao Meta nao encontrada");
    }

    await this.prisma.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        actorType: input.actorUserId ? "user" : "system",
        action: "meta.whatsapp_classification.override_updated",
        targetType: input.level,
        targetId: input.id,
        reason: null,
        sourceIp: null,
        resultStatus: "success",
        beforeSummary: undefined,
        afterSummary: {
          override: input.override,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      ok: true,
      whatsappClassification: data.whatsappClassification,
    };
  }

  async updateMetaEntityStatus(
    input: MetaEntityStatusUpdateInputDto & {
      workspaceId: string;
      actorUserId: string | null;
    },
  ): Promise<MetaEntityMutationResultDto> {
    let entity: {
      adAccountId: string | null;
      status: string | null;
    } | null;

    if (input.level === "campaign") {
      entity = await this.prisma.metaCampaign.findFirst({
        where: { workspaceId: input.workspaceId, campaignId: input.id },
        select: { adAccountId: true, status: true },
      });
    } else if (input.level === "adset") {
      entity = await this.prisma.metaAdSet.findFirst({
        where: { workspaceId: input.workspaceId, adSetId: input.id },
        select: { adAccountId: true, status: true },
      });
    } else {
      entity = await this.prisma.metaAd.findFirst({
        where: { workspaceId: input.workspaceId, adId: input.id },
        select: { adAccountId: true, status: true },
      });
    }

    if (!entity) {
      throw new NotFoundException("Item Meta nao encontrado");
    }

    const currentStatus = this.mutableMetaStatus(entity.status);

    if (!currentStatus) {
      throw new BadRequestException(
        "Este item nao pode ser ativado ou pausado no estado atual",
      );
    }

    if (currentStatus !== input.expectedStatus) {
      throw new ConflictException(
        "O status mudou desde a ultima atualizacao. Sincronize e tente novamente",
      );
    }

    if (currentStatus === input.targetStatus) {
      return { ok: true, level: input.level, id: input.id };
    }

    const accessToken = await this.metaMutationAccessToken(
      input.workspaceId,
      entity.adAccountId,
    );

    try {
      await this.metaAdapter.updateEntityStatus({
        accessToken,
        id: input.id,
        status: input.targetStatus,
      });
    } catch (error) {
      await this.recordMetaEntityMutationFailure({
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        action: "meta.entity.status_updated",
        level: input.level,
        id: input.id,
        before: { status: currentStatus },
        after: { status: input.targetStatus },
        error,
      });
      throw new BadRequestException(
        "A Meta nao confirmou a alteracao de status. Sincronize e tente novamente",
      );
    }

    try {
      if (input.level === "campaign") {
        await this.prisma.metaCampaign.updateMany({
          where: { workspaceId: input.workspaceId, campaignId: input.id },
          data: { status: input.targetStatus },
        });
      } else if (input.level === "adset") {
        await this.prisma.metaAdSet.updateMany({
          where: { workspaceId: input.workspaceId, adSetId: input.id },
          data: { status: input.targetStatus },
        });
      } else {
        await this.prisma.metaAd.updateMany({
          where: { workspaceId: input.workspaceId, adId: input.id },
          data: { status: input.targetStatus },
        });
      }
    } catch (error) {
      this.logger.error(
        `Status alterado na Meta sem atualizar snapshot local: ${this.errorMessage(error)}`,
      );
      throw new ConflictException(
        "A Meta confirmou a alteracao, mas o painel precisa ser sincronizado",
      );
    }

    await this.recordMetaEntityMutationSuccess({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: "meta.entity.status_updated",
      level: input.level,
      id: input.id,
      before: { status: currentStatus },
      after: { status: input.targetStatus },
    });

    return { ok: true, level: input.level, id: input.id };
  }

  async updateMetaEntityBudget(
    input: MetaBudgetUpdateInputDto & {
      workspaceId: string;
      actorUserId: string | null;
    },
  ): Promise<MetaEntityMutationResultDto> {
    let adAccountId: string | null = null;
    let currentBudgetCents: number | null = null;

    if (input.level === "campaign") {
      const campaign = await this.prisma.metaCampaign.findFirst({
        where: { workspaceId: input.workspaceId, campaignId: input.id },
        select: {
          adAccountId: true,
          dailyBudgetCents: true,
          lifetimeBudgetCents: true,
        },
      });

      if (!campaign) {
        throw new NotFoundException("Campanha Meta nao encontrada");
      }

      adAccountId = campaign.adAccountId;
      currentBudgetCents =
        input.budgetType === "daily"
          ? campaign.dailyBudgetCents
          : campaign.lifetimeBudgetCents;
    } else {
      const adSet = await this.prisma.metaAdSet.findFirst({
        where: { workspaceId: input.workspaceId, adSetId: input.id },
        select: {
          adAccountId: true,
          campaignId: true,
          dailyBudgetCents: true,
          lifetimeBudgetCents: true,
        },
      });

      if (!adSet) {
        throw new NotFoundException("Conjunto Meta nao encontrado");
      }

      const parentCampaign = await this.prisma.metaCampaign.findFirst({
        where: {
          workspaceId: input.workspaceId,
          campaignId: adSet.campaignId,
        },
        select: { dailyBudgetCents: true, lifetimeBudgetCents: true },
      });

      if (
        parentCampaign &&
        (parentCampaign.dailyBudgetCents !== null ||
          parentCampaign.lifetimeBudgetCents !== null)
      ) {
        throw new BadRequestException(
          "O orcamento deste conjunto e controlado pela campanha",
        );
      }

      adAccountId = adSet.adAccountId;
      currentBudgetCents =
        input.budgetType === "daily"
          ? adSet.dailyBudgetCents
          : adSet.lifetimeBudgetCents;
    }

    if (currentBudgetCents === null) {
      throw new BadRequestException(
        "Nenhum orcamento editavel foi encontrado neste nivel",
      );
    }

    if (currentBudgetCents !== input.expectedBudgetCents) {
      throw new ConflictException(
        "O orcamento mudou desde a ultima atualizacao. Sincronize e tente novamente",
      );
    }

    if (currentBudgetCents === input.budgetCents) {
      return { ok: true, level: input.level, id: input.id };
    }

    const accessToken = await this.metaMutationAccessToken(
      input.workspaceId,
      adAccountId,
    );

    try {
      await this.metaAdapter.updateEntityBudget({
        accessToken,
        id: input.id,
        budgetType: input.budgetType,
        budgetCents: input.budgetCents,
      });
    } catch (error) {
      await this.recordMetaEntityMutationFailure({
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        action: "meta.entity.budget_updated",
        level: input.level,
        id: input.id,
        before: {
          budgetType: input.budgetType,
          budgetCents: currentBudgetCents,
        },
        after: {
          budgetType: input.budgetType,
          budgetCents: input.budgetCents,
        },
        error,
      });
      throw new BadRequestException(
        "A Meta nao confirmou a alteracao de orcamento. Sincronize e tente novamente",
      );
    }

    const data =
      input.budgetType === "daily"
        ? { dailyBudgetCents: input.budgetCents }
        : { lifetimeBudgetCents: input.budgetCents };

    try {
      if (input.level === "campaign") {
        await this.prisma.metaCampaign.updateMany({
          where: { workspaceId: input.workspaceId, campaignId: input.id },
          data,
        });
      } else {
        await this.prisma.metaAdSet.updateMany({
          where: { workspaceId: input.workspaceId, adSetId: input.id },
          data,
        });
      }
    } catch (error) {
      this.logger.error(
        `Orcamento alterado na Meta sem atualizar snapshot local: ${this.errorMessage(error)}`,
      );
      throw new ConflictException(
        "A Meta confirmou a alteracao, mas o painel precisa ser sincronizado",
      );
    }

    await this.recordMetaEntityMutationSuccess({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: "meta.entity.budget_updated",
      level: input.level,
      id: input.id,
      before: {
        budgetType: input.budgetType,
        budgetCents: currentBudgetCents,
      },
      after: {
        budgetType: input.budgetType,
        budgetCents: input.budgetCents,
      },
    });

    return { ok: true, level: input.level, id: input.id };
  }

  private async resetWhatsappClassificationData(input: {
    workspaceId: string;
    level: WhatsappOverrideLevel;
    id: string;
  }): Promise<WhatsappOverrideUpdateData> {
    if (input.level === "campaign") {
      return this.resetCampaignWhatsappClassification(
        input.workspaceId,
        input.id,
      );
    }

    if (input.level === "adset") {
      return this.resetAdSetWhatsappClassification(input.workspaceId, input.id);
    }

    return this.resetAdWhatsappClassification(input.workspaceId, input.id);
  }

  private async resetCampaignWhatsappClassification(
    workspaceId: string,
    campaignId: string,
  ): Promise<WhatsappOverrideUpdateData> {
    const campaign = await this.prisma.metaCampaign.findFirst({
      where: { workspaceId, campaignId },
      select: { campaignId: true },
    });

    if (!campaign) {
      throw new NotFoundException("Classificacao Meta nao encontrada");
    }

    const [adSets, ads] = (await Promise.all([
      this.prisma.metaAdSet.findMany({
        where: { workspaceId, campaignId },
        select: { whatsappClassification: true },
      }),
      this.prisma.metaAd.findMany({
        where: { workspaceId, campaignId },
        select: { whatsappClassification: true },
      }),
    ])) as [
      Array<{ whatsappClassification: WhatsappClassification }>,
      Array<{ whatsappClassification: WhatsappClassification }>,
    ];
    const whatsappClassification = this.campaignClassificationFromChildren([
      ...adSets,
      ...ads,
    ]);
    const source =
      whatsappClassification === "not_whatsapp"
        ? "children:no_signal"
        : "children";

    return {
      classificationOverride: null,
      whatsappClassification,
      classificationSource: `auto_reset:${source}`,
    };
  }

  private async resetAdSetWhatsappClassification(
    workspaceId: string,
    adSetId: string,
  ): Promise<WhatsappOverrideUpdateData> {
    const adSet = (await this.prisma.metaAdSet.findFirst({
      where: { workspaceId, adSetId },
      select: { destinationType: true },
    })) as Pick<MetaAdSetRecord, "destinationType"> | null;

    if (!adSet) {
      throw new NotFoundException("Classificacao Meta nao encontrada");
    }

    const result = this.whatsappClassifier.classify({
      destinationType: adSet.destinationType ?? null,
      callToActionType: null,
      hasLeadEvidence: await this.hasLeadEvidence({ workspaceId, adSetId }),
      override: null,
    });

    return {
      classificationOverride: null,
      whatsappClassification: result.classification,
      classificationSource: `auto_reset:${result.source}`,
    };
  }

  private async resetAdWhatsappClassification(
    workspaceId: string,
    adId: string,
  ): Promise<WhatsappOverrideUpdateData> {
    const ad = (await this.prisma.metaAd.findFirst({
      where: { workspaceId, adId },
      select: {
        adSetId: true,
        destinationType: true,
        callToActionType: true,
      },
    })) as Pick<
      MetaAdRecord,
      "adSetId" | "destinationType" | "callToActionType"
    > | null;

    if (!ad) {
      throw new NotFoundException("Classificacao Meta nao encontrada");
    }

    const parentAdSet = ad.destinationType
      ? null
      : ((await this.prisma.metaAdSet.findFirst({
          where: { workspaceId, adSetId: ad.adSetId },
          select: { destinationType: true },
        })) as Pick<MetaAdSetRecord, "destinationType"> | null);
    const result = this.whatsappClassifier.classify({
      destinationType:
        ad.destinationType ?? parentAdSet?.destinationType ?? null,
      callToActionType: ad.callToActionType ?? null,
      hasLeadEvidence: await this.hasLeadEvidence({ workspaceId, adId }),
      override: null,
    });

    return {
      classificationOverride: null,
      whatsappClassification: result.classification,
      classificationSource: `auto_reset:${result.source}`,
    };
  }

  async getCampaignReportCsv(
    input: {
      workspaceId: string;
      rangeLabel: string;
      since?: string;
      until?: string;
    } & ReportFilterInput,
  ): Promise<ReportCsvResult> {
    const report = await this.getCampaignReportOverview({
      ...input,
      includeDaily: Boolean(input.since && input.until),
    });
    const rows = [
      [
        "Campanha",
        "Status",
        "Investimento",
        "Conversas Meta",
        "Leads novos",
        "Leads que voltaram",
        "Leads organicos",
        "Total recebido",
        "Taxa de rastreio",
        "QualifiedLead",
        "Compras",
        "Primeiras compras",
        "Recompras",
        "Receita total",
        "ROAS aquisicao",
        "ROAS com recompra",
        // Last column, so spreadsheets built on the old layout keep working.
        "Moeda",
        // "BRL 100.00; USD 5.00": sales out of the revenue for lack of a rate.
        "Receita sem cotacao",
      ],
      ...report.campaigns.map((campaign) => [
        campaign.name,
        campaign.status,
        this.centsToDecimal(campaign.spendCents),
        String(campaign.metaConversationsStarted),
        String(campaign.realConversations),
        String(campaign.returningLeads ?? 0),
        String(campaign.organicLeads),
        String(campaign.totalReceived),
        campaign.trackingRate === null ? "" : String(campaign.trackingRate),
        String(campaign.qualifiedLead),
        String(campaign.purchases),
        String(campaign.firstPurchases),
        String(campaign.repurchases),
        this.centsToDecimal(campaign.totalRevenueCents),
        campaign.roasAcquisition === null
          ? ""
          : String(campaign.roasAcquisition),
        campaign.roasWithRepurchase === null
          ? ""
          : String(campaign.roasWithRepurchase),
        campaign.currency ?? report.currency ?? DEFAULT_CURRENCY_CODE,
        (campaign.unconvertedRevenue ?? [])
          .map(
            (item) => `${item.currency} ${this.centsToDecimal(item.valueCents)}`,
          )
          .join("; "),
      ]),
    ];

    return {
      filename: this.csvFilename(input),
      content: `${rows.map((row) => row.map(this.csvCell).join(",")).join("\n")}\n`,
    };
  }

  async getAdSetReportOverview(
    input: {
      workspaceId: string;
      rangeLabel: string;
      since?: string;
      until?: string;
    } & ReportFilterInput,
  ): Promise<AdSetReportOverviewDto> {
    const startedAt = Date.now();
    const hierarchyScope = await this.metaHierarchyScope(input);
    const hierarchyWhere = hierarchyScope.where;
    const snapshotWhere = await this.metaChildSnapshotWhere(
      hierarchyWhere,
      input,
    );
    const adSetWhere = {
      ...snapshotWhere,
      ...(input.adSetId ? { adSetId: input.adSetId } : {}),
    };
    const shouldLoadAdsForNameFilter = this.reportNameScope(input) === "ad";
    const [campaigns, adSets, adsForNameFilter, funnelStages, deliveredIds] =
      await Promise.all([
        this.prisma.metaCampaign.findMany({
          where: hierarchyWhere,
          orderBy: { name: "asc" },
        }) as Promise<MetaCampaignRecord[]>,
        this.prisma.metaAdSet.findMany({
          where: adSetWhere,
          orderBy: { name: "asc" },
        }) as Promise<MetaAdSetRecord[]>,
        shouldLoadAdsForNameFilter
          ? (this.prisma.metaAd.findMany({
              where: adSetWhere,
              orderBy: { name: "asc" },
            }) as Promise<MetaAdRecord[]>)
          : Promise.resolve([]),
        this.getFunnelStages(input.workspaceId),
        this.deliveredEntityIds("adset", input),
      ]);
    const campaignById = new Map(
      campaigns.map((campaign) => [campaign.campaignId, campaign]),
    );
    const campaignNames = new Map(
      campaigns.map((campaign) => [campaign.campaignId, campaign.name]),
    );
    const filteredAdSets = this.filterAdSetRecords(
      adSets,
      input,
      campaignNames,
      adsForNameFilter,
      deliveredIds,
    );
    const adSetIds = filteredAdSets.map((adSet) => adSet.adSetId);
    const [rawConversionLogs, leads, dailyInsights, returningEvents] =
      await Promise.all([
        this.getMetricConversionEvents(input, { adSetIds }),
        this.getLeads(input, { adSetIds }),
        input.since && input.until && adSetIds.length
          ? (this.prisma.metaAdSetDailyInsight.findMany({
              where: {
                workspaceId: input.workspaceId,
                adSetId: { in: adSetIds },
                localDate: { gte: input.since, lte: input.until },
              },
              select: {
                adSetId: true,
                localDate: true,
                spendCents: true,
                metaConversationsStarted: true,
              },
            }) as Promise<MetaAdSetDailyInsightRecord[]>)
          : Promise.resolve([] as MetaAdSetDailyInsightRecord[]),
        this.getReturningLeadEvents(input, { adSetIds }),
      ]);
    // Revenue attributed to an ad set is converted to its account currency.
    const adSetCurrencyContext = this.reportCurrencyContext({
      accountCurrencies: hierarchyScope.accountCurrencies,
      campaigns,
      adSets,
    });
    const [conversionLogs] = await this.convertReportEvents(
      adSetCurrencyContext,
      [rawConversionLogs],
    );
    const adSetCurrency = (adSet: MetaAdSetRecord) =>
      adSetCurrencyContext.attributionCurrency({
        campaignId: adSet.campaignId,
        adSetId: adSet.adSetId,
        adId: null,
      }) ?? DEFAULT_CURRENCY_CODE;
    const conversionLogsByAdSet = this.groupByOptionalKey(
      conversionLogs,
      "adSetId",
    );
    const leadsByAdSet = this.groupByOptionalKey(leads, "adSetId");
    const returningEventsByAdSet = this.groupByOptionalKey(
      returningEvents,
      "adSetId",
    );
    const dailyMetricByAdSet = this.completeDailyEntityMetrics({
      entityIds: adSetIds,
      entityId: (insight) => insight.adSetId,
      insights: dailyInsights,
      since: input.since,
      until: input.until,
    });
    const paginated = this.paginateReportRows(
      filteredAdSets,
      input,
      (adSet) => ({
        ...this.toAdSetReportRow({
          adSet,
          campaignName:
            campaignNames.get(adSet.campaignId) ?? "Campanha nao resolvida",
          parentCampaign: campaignById.get(adSet.campaignId),
          conversionLogs: conversionLogsByAdSet.get(adSet.adSetId) ?? [],
          funnelStages,
          leads: leadsByAdSet.get(adSet.adSetId) ?? [],
          returningEvents: returningEventsByAdSet.get(adSet.adSetId) ?? [],
          metricOverride: dailyMetricByAdSet?.get(adSet.adSetId),
        }),
        currency: adSetCurrency(adSet),
        ...rowExchangeRateFields(
          conversionLogsByAdSet.get(adSet.adSetId) ?? [],
        ),
      }),
    );
    const rows = paginated.items;
    const totalsMeta = filteredAdSets.reduce(
      (totals, adSet) => ({
        spendCents:
          totals.spendCents +
          (dailyMetricByAdSet?.get(adSet.adSetId)?.spendCents ??
            adSet.spendCents),
        metaConversationsStarted:
          totals.metaConversationsStarted +
          (dailyMetricByAdSet?.get(adSet.adSetId)?.metaConversationsStarted ??
            adSet.metaConversationsStarted),
      }),
      { spendCents: 0, metaConversationsStarted: 0 },
    );
    const totals = this.calculateMetrics({
      funnelStages,
      spendCents: totalsMeta.spendCents,
      metaConversationsStarted: totalsMeta.metaConversationsStarted,
      events: conversionLogs,
      leads,
      returningEvents,
      scope: {},
    });
    const adSetTotalsCurrency = await this.currencyBreakdown({
      workspaceId: input.workspaceId,
      context: adSetCurrencyContext,
      funnelStages,
      entities: filteredAdSets.map((adSet) => ({
        currency: adSetCurrency(adSet),
        adAccountId:
          adSet.adAccountId ??
          campaignById.get(adSet.campaignId)?.adAccountId ??
          null,
        spendCents:
          dailyMetricByAdSet?.get(adSet.adSetId)?.spendCents ??
          adSet.spendCents,
        metaConversationsStarted:
          dailyMetricByAdSet?.get(adSet.adSetId)?.metaConversationsStarted ??
          adSet.metaConversationsStarted,
      })),
      events: conversionLogs,
      leads,
      returningEvents,
    });

    this.logReportRead("adsets", startedAt, {
      returned: rows.length,
      total: filteredAdSets.length,
    });

    return {
      workspaceId: input.workspaceId,
      rangeLabel: input.rangeLabel,
      since: input.since ?? null,
      until: input.until ?? null,
      adSets: rows,
      totals,
      ...this.currencyFields(adSetTotalsCurrency),
      ...(paginated.pagination ? { pagination: paginated.pagination } : {}),
    };
  }

  async getAdReportOverview(
    input: {
      workspaceId: string;
      rangeLabel: string;
      since?: string;
      until?: string;
    } & ReportFilterInput,
  ): Promise<AdReportOverviewDto> {
    const startedAt = Date.now();
    const hierarchyScope = await this.metaHierarchyScope(input);
    const hierarchyWhere = hierarchyScope.where;
    const snapshotWhere = await this.metaChildSnapshotWhere(
      hierarchyWhere,
      input,
    );
    const adSetWhere = {
      ...snapshotWhere,
      ...(input.adSetId ? { adSetId: input.adSetId } : {}),
    };
    const adWhere = {
      ...adSetWhere,
      ...(input.adId ? { adId: input.adId } : {}),
    };
    const [campaigns, adSets, ads, funnelStages, deliveredIds] =
      await Promise.all([
        this.prisma.metaCampaign.findMany({
          where: hierarchyWhere,
          orderBy: { name: "asc" },
        }) as Promise<MetaCampaignRecord[]>,
        this.prisma.metaAdSet.findMany({
          where: adSetWhere,
          orderBy: { name: "asc" },
        }) as Promise<MetaAdSetRecord[]>,
        this.prisma.metaAd.findMany({
          where: adWhere,
          orderBy: { name: "asc" },
        }) as Promise<MetaAdRecord[]>,
        this.getFunnelStages(input.workspaceId),
        this.deliveredEntityIds("ad", input),
      ]);
    const campaignNames = new Map(
      campaigns.map((campaign) => [campaign.campaignId, campaign.name]),
    );
    const campaignRecordById = new Map(
      campaigns.map((campaign) => [campaign.campaignId, campaign]),
    );
    const adSetNames = new Map(
      adSets.map((adSet) => [adSet.adSetId, adSet.name]),
    );
    const filteredAds = this.filterAdRecords(
      ads,
      input,
      campaignNames,
      adSetNames,
      deliveredIds,
    );
    const adIds = filteredAds.map((ad) => ad.adId);
    const [rawConversionLogs, leads, dailyInsights, returningEvents] =
      await Promise.all([
        this.getMetricConversionEvents(input, { adIds }),
        this.getLeads(input, { adIds }),
        input.since && input.until && adIds.length
          ? (this.prisma.metaAdDailyInsight.findMany({
              where: {
                workspaceId: input.workspaceId,
                adId: { in: adIds },
                localDate: { gte: input.since, lte: input.until },
              },
              select: {
                adId: true,
                localDate: true,
                spendCents: true,
                metaConversationsStarted: true,
              },
            }) as Promise<MetaAdDailyInsightRecord[]>)
          : Promise.resolve([] as MetaAdDailyInsightRecord[]),
        this.getReturningLeadEvents(input, { adIds }),
      ]);
    // Revenue attributed to an ad is converted to its account currency.
    const adCurrencyContext = this.reportCurrencyContext({
      accountCurrencies: hierarchyScope.accountCurrencies,
      campaigns,
      adSets,
      ads,
    });
    const [conversionLogs] = await this.convertReportEvents(
      adCurrencyContext,
      [rawConversionLogs],
    );
    const adCurrency = (ad: MetaAdRecord) =>
      adCurrencyContext.attributionCurrency({
        campaignId: ad.campaignId,
        adSetId: ad.adSetId,
        adId: ad.adId,
      }) ?? DEFAULT_CURRENCY_CODE;
    const conversionLogsByAd = this.groupByOptionalKey(conversionLogs, "adId");
    const leadsByAd = this.groupByOptionalKey(leads, "adId");
    const returningEventsByAd = this.groupByOptionalKey(
      returningEvents,
      "adId",
    );
    const dailyMetricByAd = this.completeDailyEntityMetrics({
      entityIds: adIds,
      entityId: (insight) => insight.adId,
      insights: dailyInsights,
      since: input.since,
      until: input.until,
    });
    const paginated = this.paginateReportRows(filteredAds, input, (ad) => ({
      ...this.toAdReportRow({
        ad,
        parentCampaign: campaignRecordById.get(ad.campaignId),
        campaignName:
          campaignNames.get(ad.campaignId) ?? "Campanha nao resolvida",
        adSetName: adSetNames.get(ad.adSetId) ?? "Conjunto nao resolvido",
        conversionLogs: conversionLogsByAd.get(ad.adId) ?? [],
        funnelStages,
        leads: leadsByAd.get(ad.adId) ?? [],
        returningEvents: returningEventsByAd.get(ad.adId) ?? [],
        metricOverride: dailyMetricByAd?.get(ad.adId),
      }),
      currency: adCurrency(ad),
      ...rowExchangeRateFields(conversionLogsByAd.get(ad.adId) ?? []),
    }));
    const rows = paginated.items;
    const totalsMeta = filteredAds.reduce(
      (totals, ad) => ({
        spendCents:
          totals.spendCents +
          (dailyMetricByAd?.get(ad.adId)?.spendCents ?? ad.spendCents),
        metaConversationsStarted:
          totals.metaConversationsStarted +
          (dailyMetricByAd?.get(ad.adId)?.metaConversationsStarted ??
            ad.metaConversationsStarted),
      }),
      { spendCents: 0, metaConversationsStarted: 0 },
    );
    const totals = this.calculateMetrics({
      funnelStages,
      spendCents: totalsMeta.spendCents,
      metaConversationsStarted: totalsMeta.metaConversationsStarted,
      events: conversionLogs,
      leads,
      returningEvents,
      scope: {},
    });
    const adTotalsCurrency = await this.currencyBreakdown({
      workspaceId: input.workspaceId,
      context: adCurrencyContext,
      funnelStages,
      entities: filteredAds.map((ad) => ({
        currency: adCurrency(ad),
        adAccountId: ad.adAccountId ?? null,
        spendCents: dailyMetricByAd?.get(ad.adId)?.spendCents ?? ad.spendCents,
        metaConversationsStarted:
          dailyMetricByAd?.get(ad.adId)?.metaConversationsStarted ??
          ad.metaConversationsStarted,
      })),
      events: conversionLogs,
      leads,
      returningEvents,
    });

    this.logReportRead("ads", startedAt, {
      returned: rows.length,
      total: filteredAds.length,
    });

    return {
      workspaceId: input.workspaceId,
      rangeLabel: input.rangeLabel,
      since: input.since ?? null,
      until: input.until ?? null,
      ads: rows,
      totals,
      ...this.currencyFields(adTotalsCurrency),
      ...(paginated.pagination ? { pagination: paginated.pagination } : {}),
    };
  }

  private filterCampaignRecords(
    campaigns: MetaCampaignRecord[],
    input: ReportFilterInput,
    adSets: MetaAdSetRecord[],
    ads: MetaAdRecord[],
    deliveredIds: Set<string> | null,
  ): MetaCampaignRecord[] {
    const statusRows = this.filterRecordsByStatus(
      this.filterRecordsByEntityScope(
        campaigns,
        input,
        (campaign) => campaign.campaignId,
        deliveredIds,
      ),
      input,
    );
    const nameContains = this.normalizedReportName(input.nameContains);

    if (!nameContains) {
      return statusRows;
    }

    const scope = this.reportNameScope(input);

    if (scope === "campaign") {
      return statusRows.filter((campaign) =>
        this.normalizedReportName(campaign.name)?.includes(nameContains),
      );
    }

    if (scope === "adset") {
      const campaignIds = new Set(
        adSets
          .filter((adSet) =>
            this.normalizedReportName(adSet.name)?.includes(nameContains),
          )
          .map((adSet) => adSet.campaignId),
      );

      return statusRows.filter((campaign) =>
        campaignIds.has(campaign.campaignId),
      );
    }

    const campaignIds = new Set(
      ads
        .filter((ad) =>
          this.normalizedReportName(ad.name)?.includes(nameContains),
        )
        .map((ad) => ad.campaignId),
    );

    return statusRows.filter((campaign) =>
      campaignIds.has(campaign.campaignId),
    );
  }

  private filterAdSetRecords(
    adSets: MetaAdSetRecord[],
    input: ReportFilterInput,
    campaignNames: Map<string, string>,
    ads: MetaAdRecord[],
    deliveredIds: Set<string> | null,
  ): MetaAdSetRecord[] {
    const statusRows = this.filterRecordsByStatus(
      this.filterRecordsByEntityScope(
        adSets,
        input,
        (adSet) => adSet.adSetId,
        deliveredIds,
      ),
      input,
    );
    const nameContains = this.normalizedReportName(input.nameContains);

    if (!nameContains) {
      return statusRows;
    }

    const scope = this.reportNameScope(input);

    if (scope === "campaign") {
      return statusRows.filter((adSet) =>
        this.normalizedReportName(
          campaignNames.get(adSet.campaignId),
        )?.includes(nameContains),
      );
    }

    if (scope === "adset") {
      return statusRows.filter((adSet) =>
        this.normalizedReportName(adSet.name)?.includes(nameContains),
      );
    }

    const adSetIds = new Set(
      ads
        .filter((ad) =>
          this.normalizedReportName(ad.name)?.includes(nameContains),
        )
        .map((ad) => ad.adSetId),
    );

    return statusRows.filter((adSet) => adSetIds.has(adSet.adSetId));
  }

  private filterAdRecords(
    ads: MetaAdRecord[],
    input: ReportFilterInput,
    campaignNames: Map<string, string>,
    adSetNames: Map<string, string>,
    deliveredIds: Set<string> | null,
  ): MetaAdRecord[] {
    const statusRows = this.filterRecordsByStatus(
      this.filterRecordsByEntityScope(
        ads,
        input,
        (ad) => ad.adId,
        deliveredIds,
      ),
      input,
    );
    const nameContains = this.normalizedReportName(input.nameContains);

    if (!nameContains) {
      return statusRows;
    }

    const scope = this.reportNameScope(input);

    if (scope === "campaign") {
      return statusRows.filter((ad) =>
        this.normalizedReportName(campaignNames.get(ad.campaignId))?.includes(
          nameContains,
        ),
      );
    }

    if (scope === "adset") {
      return statusRows.filter((ad) =>
        this.normalizedReportName(adSetNames.get(ad.adSetId))?.includes(
          nameContains,
        ),
      );
    }

    return statusRows.filter((ad) =>
      this.normalizedReportName(ad.name)?.includes(nameContains),
    );
  }

  private filterRecordsByStatus<T extends { status: string | null }>(
    rows: T[],
    input: ReportFilterInput,
  ): T[] {
    if (!input.status || input.status === "all") {
      return rows;
    }

    return rows.filter(
      (row) => this.toReportStatus(row.status) === input.status,
    );
  }

  private filterRecordsByEntityScope<T>(
    rows: T[],
    input: ReportFilterInput,
    id: (row: T) => string,
    deliveredIds: Set<string> | null,
  ): T[] {
    const selectedIds = input.selectedEntityIds?.length
      ? new Set(input.selectedEntityIds)
      : null;

    return rows.filter((row) => {
      const entityId = id(row);

      return (
        (!selectedIds || selectedIds.has(entityId)) &&
        (!deliveredIds || deliveredIds.has(entityId))
      );
    });
  }

  private async deliveredEntityIds(
    level: "campaign" | "adset" | "ad",
    input: {
      workspaceId: string;
      since?: string;
      until?: string;
      delivery?: ReportDeliveryFilter;
    },
  ): Promise<Set<string> | null> {
    if (input.delivery !== "had_delivery") {
      return null;
    }

    if (!input.since || !input.until) {
      return new Set();
    }

    const where = {
      workspaceId: input.workspaceId,
      localDate: { gte: input.since, lte: input.until },
      impressions: { gt: 0 },
    };

    if (level === "campaign") {
      const rows = await this.prisma.metaCampaignDailyInsight.findMany({
        where,
        select: { campaignId: true },
        distinct: ["campaignId"],
      });

      return new Set(rows.map((row) => row.campaignId));
    }

    if (level === "adset") {
      const rows = await this.prisma.metaAdSetDailyInsight.findMany({
        where,
        select: { adSetId: true },
        distinct: ["adSetId"],
      });

      return new Set(rows.map((row) => row.adSetId));
    }

    const rows = await this.prisma.metaAdDailyInsight.findMany({
      where,
      select: { adId: true },
      distinct: ["adId"],
    });

    return new Set(rows.map((row) => row.adId));
  }

  private paginateRecords<T>(
    records: T[],
    input: Pick<ReportFilterInput, "page" | "pageSize">,
  ): PaginatedRecords<T> {
    if (!input.page && !input.pageSize) {
      return { items: records };
    }

    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 10;
    const totalItems = records.length;
    const totalPages = totalItems > 0 ? Math.ceil(totalItems / pageSize) : 0;
    const offset = (page - 1) * pageSize;

    return {
      items: records.slice(offset, offset + pageSize),
      pagination: { page, pageSize, totalItems, totalPages },
    };
  }

  private paginateReportRows<
    TRecord,
    TRow extends SortableReportRow & { currency?: string | null },
  >(
    records: TRecord[],
    input: Pick<ReportFilterInput, "page" | "pageSize" | "sort">,
    toRow: (record: TRecord) => TRow,
  ): PaginatedRecords<TRow> {
    if (!input.sort) {
      const paginated = this.paginateRecords(records, input);

      return { ...paginated, items: paginated.items.map(toRow) };
    }

    // A metric sort needs every filtered row before slicing the page. The
    // entities, events and leads behind those rows are already loaded for
    // the totals, so this adds row construction but no queries.
    return this.paginateRecords(
      sortReportRowsByCurrency(records.map(toRow), input.sort),
      input,
    );
  }

  private groupByOptionalKey<
    T extends Record<K, string | null>,
    K extends keyof T,
  >(rows: T[], key: K): Map<string, T[]> {
    const grouped = new Map<string, T[]>();

    for (const row of rows) {
      const value = row[key];

      if (!value) {
        continue;
      }

      const group = grouped.get(value) ?? [];
      group.push(row);
      grouped.set(value, group);
    }

    return grouped;
  }

  private logReportRead(
    level: "campaigns" | "adsets" | "ads",
    startedAt: number,
    counts: { returned: number; total: number },
  ): void {
    const durationMs = Date.now() - startedAt;
    const thresholdMs = Number(
      process.env.WPPTRACK_API_SLOW_REPORT_QUERY_MS ?? 750,
    );

    if (!Number.isFinite(thresholdMs) || durationMs < thresholdMs) {
      return;
    }

    this.logger.warn(
      JSON.stringify({
        event: "report.read.slow",
        level,
        durationMs,
        ...counts,
      }),
    );
  }

  private needsCampaignChildNameFilter(input: ReportFilterInput): boolean {
    return Boolean(
      this.normalizedReportName(input.nameContains) &&
      this.reportNameScope(input) !== "campaign",
    );
  }

  private normalizedReportName(value?: string | null): string | null {
    const trimmed = value?.trim();

    return trimmed
      ? trimmed
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
      : null;
  }

  private reportNameScope(input: ReportFilterInput): ReportNameScope {
    return input.nameScope ?? "campaign";
  }

  async getMetaStructureReport(
    workspaceId: string,
  ): Promise<MetaStructureReportDto> {
    const where = await this.metaHierarchyWhere({ workspaceId });
    const [campaigns, adSets, ads] = (await Promise.all([
      this.prisma.metaCampaign.findMany({
        where,
        orderBy: { name: "asc" },
      }),
      this.prisma.metaAdSet.findMany({
        where,
        orderBy: { name: "asc" },
      }),
      this.prisma.metaAd.findMany({
        where,
        orderBy: { name: "asc" },
      }),
    ])) as [MetaCampaignRecord[], MetaAdSetRecord[], MetaAdRecord[]];

    return {
      workspaceId,
      campaigns: campaigns.map((campaign) => ({
        id: campaign.campaignId,
        name: campaign.name,
        status: campaign.status,
        effectiveStatus: campaign.effectiveStatus ?? null,
        objective: campaign.objective ?? null,
        adSets: adSets
          .filter((adSet) => adSet.campaignId === campaign.campaignId)
          .map((adSet) => ({
            id: adSet.adSetId,
            name: adSet.name,
            status: adSet.status,
            effectiveStatus: adSet.effectiveStatus,
            ads: ads
              .filter((ad) => ad.adSetId === adSet.adSetId)
              .map((ad) => ({
                id: ad.adId,
                name: ad.name,
                status: ad.status,
                effectiveStatus: ad.effectiveStatus,
              })),
          })),
      })),
    };
  }

  private mutableMetaStatus(status: string | null): "ACTIVE" | "PAUSED" | null {
    const normalized = status?.trim().toUpperCase();

    return normalized === "ACTIVE" || normalized === "PAUSED"
      ? normalized
      : null;
  }

  private async metaMutationAccessToken(
    workspaceId: string,
    adAccountId: string | null,
  ): Promise<string> {
    if (!adAccountId) {
      throw new BadRequestException(
        "A conta de anuncios deste item nao foi identificada",
      );
    }

    const activeAccount = await this.prisma.metaReportingAccount.findFirst({
      where: { workspaceId, adAccountId, active: true },
      select: { id: true },
    });

    if (!activeAccount) {
      throw new BadRequestException(
        "A conta de anuncios precisa estar ativa antes desta alteracao",
      );
    }

    const connection = await this.getConnection(workspaceId);

    return this.encryption.decrypt({
      encryptedAccessToken: connection.encryptedAccessToken,
      tokenIv: connection.tokenIv,
      tokenTag: connection.tokenTag,
    });
  }

  private async recordMetaEntityMutationAudit(input: {
    workspaceId: string;
    actorUserId: string | null;
    action: string;
    level: "campaign" | "adset" | "ad";
    id: string;
    resultStatus: "success" | "failed";
    before: Record<string, string | number | null>;
    after: Record<string, string | number | null>;
    reason?: string | null;
  }): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        actorType: input.actorUserId ? "user" : "system",
        action: input.action,
        targetType: input.level,
        targetId: input.id,
        reason: input.reason ?? null,
        sourceIp: null,
        resultStatus: input.resultStatus,
        beforeSummary: input.before as Prisma.InputJsonValue,
        afterSummary: input.after as Prisma.InputJsonValue,
      },
    });
  }

  private async recordMetaEntityMutationFailure(input: {
    workspaceId: string;
    actorUserId: string | null;
    action: string;
    level: "campaign" | "adset" | "ad";
    id: string;
    before: Record<string, string | number | null>;
    after: Record<string, string | number | null>;
    error: unknown;
  }): Promise<void> {
    try {
      await this.recordMetaEntityMutationAudit({
        ...input,
        resultStatus: "failed",
        reason: this.errorMessage(input.error).slice(0, 500),
      });
    } catch (auditError) {
      this.logger.warn(
        `Falha ao auditar mutacao Meta: ${this.errorMessage(auditError)}`,
      );
    }
  }

  private async recordMetaEntityMutationSuccess(input: {
    workspaceId: string;
    actorUserId: string | null;
    action: string;
    level: "campaign" | "adset" | "ad";
    id: string;
    before: Record<string, string | number | null>;
    after: Record<string, string | number | null>;
  }): Promise<void> {
    try {
      await this.recordMetaEntityMutationAudit({
        ...input,
        resultStatus: "success",
      });
    } catch (auditError) {
      this.logger.warn(
        `Mutacao Meta concluida sem registro de auditoria: ${this.errorMessage(auditError)}`,
      );
    }
  }

  private async getConnection(
    workspaceId: string,
  ): Promise<MetaIntegrationRecord> {
    const connection = (await this.prisma.metaIntegration.findUnique({
      where: { workspaceId },
    })) as MetaIntegrationRecord | null;

    if (!connection) {
      throw new NotFoundException("Meta nao conectada");
    }

    return connection;
  }

  private upsertCampaign(input: {
    workspaceId: string;
    account: MetaReportingAccountRecord;
    campaign: MetaCampaignAsset;
    insight?: MetaCampaignInsight;
    classification: WhatsappClassification;
    classificationSource: string;
    campaignKind: CampaignKind;
    campaignKindSource: string;
    syncedAt: Date;
  }) {
    const data = {
      businessId: input.account.businessId,
      adAccountId: input.account.adAccountId,
      name: input.campaign.name,
      status: input.campaign.status,
      effectiveStatus: input.campaign.effectiveStatus,
      objective: input.campaign.objective,
      campaignKind: input.campaignKind,
      campaignKindSource: input.campaignKindSource,
      dailyBudgetCents: input.campaign.dailyBudgetCents ?? null,
      lifetimeBudgetCents: input.campaign.lifetimeBudgetCents ?? null,
      whatsappClassification: input.classification,
      classificationSource: input.classificationSource,
      spendCents: input.insight?.spendCents ?? 0,
      impressions: input.insight?.impressions ?? 0,
      clicks: input.insight?.clicks ?? 0,
      metaConversationsStarted: input.insight?.metaConversationsStarted ?? 0,
      lastSyncedAt: input.syncedAt,
    };

    return this.prisma.metaCampaign.upsert({
      where: {
        workspaceId_campaignId: {
          workspaceId: input.workspaceId,
          campaignId: input.campaign.id,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        campaignId: input.campaign.id,
        ...data,
      },
      update: data,
    });
  }

  private upsertAdSet(input: {
    workspaceId: string;
    account: MetaReportingAccountRecord;
    adSet: MetaAdSetAsset;
    insight?: MetaAdSetInsight;
    classification: WhatsappClassification;
    classificationSource: string;
    syncedAt: Date;
  }) {
    const data = {
      businessId: input.account.businessId,
      adAccountId: input.account.adAccountId,
      campaignId: input.adSet.campaignId,
      name: input.adSet.name,
      status: input.adSet.status,
      effectiveStatus: input.adSet.effectiveStatus,
      destinationType: input.adSet.destinationType,
      dailyBudgetCents: input.adSet.dailyBudgetCents ?? null,
      lifetimeBudgetCents: input.adSet.lifetimeBudgetCents ?? null,
      whatsappClassification: input.classification,
      classificationSource: input.classificationSource,
      spendCents: input.insight?.spendCents ?? 0,
      impressions: input.insight?.impressions ?? 0,
      clicks: input.insight?.clicks ?? 0,
      metaConversationsStarted: input.insight?.metaConversationsStarted ?? 0,
      lastSyncedAt: input.syncedAt,
    };

    return this.prisma.metaAdSet.upsert({
      where: {
        workspaceId_adSetId: {
          workspaceId: input.workspaceId,
          adSetId: input.adSet.id,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        adSetId: input.adSet.id,
        ...data,
      },
      update: data,
    });
  }

  private upsertAd(input: {
    workspaceId: string;
    account: MetaReportingAccountRecord;
    ad: MetaAdAsset;
    media: { previewUrl: string | null; thumbnailUrl: string | null };
    destinationType: string | null;
    insight?: MetaAdInsight;
    classification: WhatsappClassification;
    classificationSource: string;
    syncedAt: Date;
  }) {
    const data = {
      businessId: input.account.businessId,
      adAccountId: input.account.adAccountId,
      campaignId: input.ad.campaignId,
      adSetId: input.ad.adSetId,
      name: input.ad.name,
      status: input.ad.status,
      effectiveStatus: input.ad.effectiveStatus,
      destinationType: input.destinationType,
      creativeId: input.ad.creativeId,
      thumbnailUrl: input.media.thumbnailUrl,
      previewUrl: input.media.previewUrl,
      callToActionType: input.ad.callToActionType,
      detectedPixelIds: input.ad.detectedPixelIds,
      detectedPageIds: input.ad.detectedPageIds,
      whatsappClassification: input.classification,
      classificationSource: input.classificationSource,
      spendCents: input.insight?.spendCents ?? 0,
      impressions: input.insight?.impressions ?? 0,
      clicks: input.insight?.clicks ?? 0,
      metaConversationsStarted: input.insight?.metaConversationsStarted ?? 0,
      lastSyncedAt: input.syncedAt,
    };

    return this.prisma.metaAd.upsert({
      where: {
        workspaceId_adId: {
          workspaceId: input.workspaceId,
          adId: input.ad.id,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        adId: input.ad.id,
        ...data,
      },
      update: data,
    });
  }

  private manualOverride(
    record?: ExistingClassificationRecord,
  ): WhatsappClassification | null {
    const override =
      record?.classificationOverride ?? record?.whatsappClassification ?? null;

    return override === "manual_include" || override === "manual_exclude"
      ? override
      : null;
  }

  /**
   * Implatec: tipo da campanha no painel. Formulario (Lead Ads) quando ha
   * Lead vindo do formulario, quando o objetivo e de cadastros com destino
   * no proprio anuncio (formulario instantaneo), ou quando o objetivo e de
   * cadastros sem nenhum sinal de WhatsApp. WhatsApp quando a classificacao
   * de WhatsApp aceita a campanha. Senao, outro (fica fora dos dois tipos).
   */
  private campaignKindFor(input: {
    objective: string | null;
    whatsappClassification: WhatsappClassification;
    adSetDestinationTypes: Array<string | null>;
    hasLeadFormEvidence: boolean;
  }): { kind: CampaignKind; source: string } {
    if (input.hasLeadFormEvidence) {
      return { kind: "lead_form", source: "lead_evidence:meta_leadgen" };
    }

    const objective = (input.objective ?? "").toUpperCase();
    const leadsObjective =
      objective === "OUTCOME_LEADS" || objective === "LEAD_GENERATION";
    const onAdDestination = input.adSetDestinationTypes.some((type) =>
      LEAD_FORM_DESTINATION_TYPES.has((type ?? "").toUpperCase()),
    );

    if (leadsObjective && onAdDestination) {
      return { kind: "lead_form", source: "objective+destination:on_ad" };
    }

    if (WHATSAPP_REPORT_CLASSIFICATIONS.includes(input.whatsappClassification)) {
      return {
        kind: "whatsapp",
        source: "whatsapp:" + input.whatsappClassification,
      };
    }

    if (leadsObjective) {
      return { kind: "lead_form", source: "objective:leads" };
    }

    return { kind: "other", source: "no_signal" };
  }

  private campaignClassificationFromChildren(
    children: Array<{ whatsappClassification: string }>,
  ): WhatsappClassification {
    const order: WhatsappClassification[] = [
      "manual_include",
      "auto_whatsapp",
      "creative_whatsapp",
      "detected_by_leads",
      "needs_review",
      "not_whatsapp",
      "manual_exclude",
    ];

    return (
      order.find((value) =>
        children.some((child) => child.whatsappClassification === value),
      ) ?? "not_whatsapp"
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message
      : "Erro desconhecido ao sincronizar relatorios Meta";
  }

  private toReportRow(
    campaign: MetaCampaignRecord,
    conversionLogs: ConversionEventRecord[],
    leads: LeadRecord[],
    funnelStages: FunnelStageConfigurationDto[],
    metricOverride?: CampaignMetricOverride,
    returningEvents: ConversionEventRecord[] = [],
    leadIdsByPhoneHash?: ReadonlyMap<string, readonly string[]>,
  ): CampaignReportRowDto {
    const restrictToAdIds = metricOverride?.adIds.size
      ? metricOverride.adIds
      : null;
    const restrictToAdSets = metricOverride?.adSetIds.size
      ? metricOverride.adSetIds
      : null;
    const belongsToMetricScope = (item: ConversionEventRecord | LeadRecord) => {
      if (restrictToAdIds) {
        return Boolean(item.adId && restrictToAdIds.has(item.adId));
      }

      if (restrictToAdSets) {
        return Boolean(item.adSetId && restrictToAdSets.has(item.adSetId));
      }

      return true;
    };
    const campaignEvents = conversionLogs.filter(
      (item) =>
        item.campaignId === campaign.campaignId && belongsToMetricScope(item),
    );
    const campaignLeads = leads.filter(
      (item) =>
        item.campaignId === campaign.campaignId && belongsToMetricScope(item),
    );
    const metrics = this.calculateMetrics({
      funnelStages,
      spendCents: metricOverride?.spendCents ?? campaign.spendCents,
      metaConversationsStarted:
        metricOverride?.metaConversationsStarted ??
        campaign.metaConversationsStarted,
      events: campaignEvents,
      leads: campaignLeads,
      returningEvents: returningEvents.filter(
        (item) =>
          item.campaignId === campaign.campaignId && belongsToMetricScope(item),
      ),
      leadIdsByPhoneHash,
      scope: { campaignId: campaign.campaignId },
    });

    return {
      id: campaign.campaignId,
      name: campaign.name,
      status: this.toReportStatus(campaign.status),
      configuredStatus: campaign.status,
      effectiveStatus: campaign.effectiveStatus ?? null,
      budget: this.reportBudget(campaign, "campaign", true),
      businessId: campaign.businessId,
      adAccountId: campaign.adAccountId,
      whatsappClassification: campaign.whatsappClassification,
      // Implatec: so quando a coluna existe (snapshots antigos ficam iguais).
      ...(campaign.campaignKind ? { campaignKind: campaign.campaignKind } : {}),
      ...metrics,
    };
  }

  private toAdSetReportRow(input: {
    adSet: MetaAdSetRecord;
    campaignName: string;
    parentCampaign?: MetaCampaignRecord;
    conversionLogs: ConversionEventRecord[];
    funnelStages: FunnelStageConfigurationDto[];
    leads: LeadRecord[];
    returningEvents?: ConversionEventRecord[];
    metricOverride?: EntityMetricOverride;
  }): AdSetReportRowDto {
    const metrics = this.calculateMetrics({
      funnelStages: input.funnelStages,
      spendCents: input.metricOverride?.spendCents ?? input.adSet.spendCents,
      metaConversationsStarted:
        input.metricOverride?.metaConversationsStarted ??
        input.adSet.metaConversationsStarted,
      events: input.conversionLogs,
      leads: input.leads,
      returningEvents: input.returningEvents,
      scope: { adSetId: input.adSet.adSetId },
    });

    return {
      id: input.adSet.adSetId,
      campaignId: input.adSet.campaignId,
      campaignName: input.campaignName,
      name: input.adSet.name,
      status: this.toReportStatus(input.adSet.status),
      configuredStatus: input.adSet.status,
      effectiveStatus: input.adSet.effectiveStatus,
      budget:
        this.reportBudget(input.parentCampaign, "campaign", false) ??
        this.reportBudget(input.adSet, "adset", true),
      businessId: input.adSet.businessId,
      adAccountId: input.adSet.adAccountId,
      whatsappClassification: input.adSet.whatsappClassification,
      ...(input.parentCampaign?.campaignKind
        ? { campaignKind: input.parentCampaign.campaignKind }
        : {}),
      ...metrics,
    };
  }

  private toAdReportRow(input: {
    ad: MetaAdRecord;
    campaignName: string;
    adSetName: string;
    parentCampaign?: MetaCampaignRecord;
    conversionLogs: ConversionEventRecord[];
    funnelStages: FunnelStageConfigurationDto[];
    leads: LeadRecord[];
    returningEvents?: ConversionEventRecord[];
    metricOverride?: EntityMetricOverride;
  }): AdReportRowDto {
    const metrics = this.calculateMetrics({
      funnelStages: input.funnelStages,
      spendCents: input.metricOverride?.spendCents ?? input.ad.spendCents,
      metaConversationsStarted:
        input.metricOverride?.metaConversationsStarted ??
        input.ad.metaConversationsStarted,
      events: input.conversionLogs,
      leads: input.leads,
      returningEvents: input.returningEvents,
      scope: { adId: input.ad.adId },
    });

    return {
      id: input.ad.adId,
      campaignId: input.ad.campaignId,
      campaignName: input.campaignName,
      adSetId: input.ad.adSetId,
      adSetName: input.adSetName,
      name: input.ad.name,
      status: this.toReportStatus(input.ad.status),
      configuredStatus: input.ad.status,
      effectiveStatus: input.ad.effectiveStatus,
      thumbnailUrl: input.ad.thumbnailUrl ?? null,
      previewUrl: input.ad.previewUrl ?? null,
      businessId: input.ad.businessId,
      adAccountId: input.ad.adAccountId,
      whatsappClassification: input.ad.whatsappClassification,
      ...(input.parentCampaign?.campaignKind
        ? { campaignKind: input.parentCampaign.campaignKind }
        : {}),
      ...metrics,
    };
  }

  private reportBudget(
    record:
      | Pick<
          MetaCampaignRecord | MetaAdSetRecord,
          "dailyBudgetCents" | "lifetimeBudgetCents"
        >
      | undefined,
    owner: "campaign" | "adset",
    editable: boolean,
  ): NonNullable<CampaignReportRowDto["budget"]> | null {
    if (
      record?.dailyBudgetCents !== null &&
      record?.dailyBudgetCents !== undefined
    ) {
      return {
        owner,
        type: "daily",
        amountCents: record.dailyBudgetCents,
        editable,
      };
    }

    if (
      record?.lifetimeBudgetCents !== null &&
      record?.lifetimeBudgetCents !== undefined
    ) {
      return {
        owner,
        type: "lifetime",
        amountCents: record.lifetimeBudgetCents,
        editable,
      };
    }

    return null;
  }

  private calculateMetrics(input: {
    funnelStages: FunnelStageConfigurationDto[];
    spendCents: number;
    metaConversationsStarted: number;
    events: ConversionEventRecord[];
    leads: LeadRecord[];
    returningEvents?: ConversionEventRecord[];
    leadIdsByPhoneHash?: ReadonlyMap<string, readonly string[]>;
    scope: ReportingMetricScope;
  }): ReportRowMetrics {
    return this.metricsEngine.calculate({
      funnelStages: input.funnelStages,
      events: input.events,
      insight: {
        spendCents: input.spendCents,
        metaConversationsStarted: input.metaConversationsStarted,
      },
      leads: input.leads,
      returningEvents: input.returningEvents ?? [],
      ...(input.leadIdsByPhoneHash
        ? { leadIdsByPhoneHash: input.leadIdsByPhoneHash }
        : {}),
      scope: input.scope,
    }) as ReportRowMetrics;
  }

  private async getMetricConversionEvents(
    input: {
      workspaceId: string;
      since?: string;
      until?: string;
    },
    scope: ReportMetricScopeFilter = {},
  ): Promise<ConversionEventRecord[]> {
    if (this.isEmptyMetricScope(scope)) {
      return Promise.resolve([]);
    }

    const events = await this.prisma.conversionEventLog.findMany({
      where: {
        workspaceId: input.workspaceId,
        status: { not: "skipped" },
        ...this.metricScopeWhere(scope),
        ...this.eventPeriodWhere(input),
      },
      select: {
        id: true,
        leadId: true,
        phoneHash: true,
        customerIdentityKey: true,
        businessSource: true,
        campaignId: true,
        adSetId: true,
        adId: true,
        ctwaClid: true,
        eventName: true,
        eventOccurredAt: true,
        status: true,
        valueCents: true,
        valueSource: true,
        currency: true,
        purchaseKind: true,
        purchaseValueAdjustments: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { effectiveValueCents: true },
        },
      },
    });

    return events.map(({ purchaseValueAdjustments, ...event }) => ({
      ...event,
      valueCents:
        purchaseValueAdjustments?.[0]?.effectiveValueCents ?? event.valueCents,
    })) as ConversionEventRecord[];
  }

  /**
   * Leads novos of the period (first contact inside it), each carrying the
   * attribution of that FIRST contact: a lead that later came back through
   * another ad stays with the ad that brought it in (Lead rows keep the latest
   * ad, so the first paid LeadSubmitted event decides). With a scope, a lead
   * belongs to it when its first-contact attribution matches.
   */
  private async getLeads(
    input: {
      workspaceId: string;
      since?: string;
      until?: string;
    },
    scope: ReportMetricScopeFilter = {},
  ): Promise<LeadRecord[]> {
    if (this.isEmptyMetricScope(scope)) {
      return [];
    }

    const scopeWhere = this.metricScopeWhere(scope);
    const scoped = Object.keys(scopeWhere).length > 0;
    // A lead whose row now points at another ad still belongs to the scope
    // when its first conversation in the period came from it.
    const firstContactLeadIds = scoped
      ? await this.leadIdsWithLeadSubmittedInScope(input, scope)
      : [];
    const periodWhere = this.leadPeriodWhere(input);
    const leads = (await this.prisma.lead.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(scoped
          ? {
              AND: [
                periodWhere,
                firstContactLeadIds.length
                  ? {
                      OR: [scopeWhere, { id: { in: firstContactLeadIds } }],
                    }
                  : scopeWhere,
              ],
            }
          : periodWhere),
      },
      select: {
        id: true,
        phoneHash: true,
        campaignId: true,
        adSetId: true,
        adId: true,
        ctwaClid: true,
        firstMessageAt: true,
        createdAt: true,
      },
    })) as LeadRecord[];
    // Same first-contact rule as the Leads page filters (shared helper).
    const resolved = await withFirstContactAttribution(
      this.prisma,
      input.workspaceId,
      leads,
    );

    return scoped
      ? resolved.filter((lead) => this.matchesMetricScopeFilter(lead, scope))
      : resolved;
  }

  private async leadIdsWithLeadSubmittedInScope(
    input: { workspaceId: string; since?: string; until?: string },
    scope: ReportMetricScopeFilter,
  ): Promise<string[]> {
    const events = (await this.prisma.conversionEventLog.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...paidLeadSubmittedEventWhere,
        leadId: { not: null },
        ...this.metricScopeWhere(scope),
        ...this.eventPeriodWhere(input),
      },
      select: { leadId: true },
    })) as Array<{ leadId: string | null }>;

    return this.uniqueStrings(events.map((event) => event.leadId));
  }

  private matchesMetricScopeFilter(
    item: {
      campaignId: string | null;
      adSetId: string | null;
      adId: string | null;
    },
    scope: ReportMetricScopeFilter,
  ): boolean {
    if (scope.adIds) {
      return Boolean(item.adId && scope.adIds.includes(item.adId));
    }

    if (scope.adSetIds) {
      return Boolean(item.adSetId && scope.adSetIds.includes(item.adSetId));
    }

    if (scope.campaignIds) {
      return Boolean(
        item.campaignId && scope.campaignIds.includes(item.campaignId),
      );
    }

    return true;
  }

  /**
   * Leads que voltaram por anuncio: paid LeadSubmitted events in the period
   * (attributed to the ad that brought them back) from people whose first
   * contact was before the period. Needs a period start; events without a
   * lead id are matched to the lead by phone hash.
   */
  private async getReturningLeadEvents(
    input: {
      workspaceId: string;
      since?: string;
      until?: string;
    },
    scope: ReportMetricScopeFilter = {},
  ): Promise<ConversionEventRecord[]> {
    if (!input.since || !input.until || this.isEmptyMetricScope(scope)) {
      return [];
    }

    const events = (await this.prisma.conversionEventLog.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...paidLeadSubmittedEventWhere,
        ...this.metricScopeWhere(scope),
        ...this.eventPeriodWhere(input),
      },
      select: {
        id: true,
        leadId: true,
        phoneHash: true,
        customerIdentityKey: true,
        businessSource: true,
        campaignId: true,
        adSetId: true,
        adId: true,
        ctwaClid: true,
        eventName: true,
        eventOccurredAt: true,
        status: true,
        valueCents: true,
        valueSource: true,
        currency: true,
        purchaseKind: true,
      },
    })) as ConversionEventRecord[];

    if (events.length === 0) {
      return [];
    }

    const periodStart = this.eventPeriodWhere(input).eventOccurredAt?.gte;

    if (!periodStart) {
      return [];
    }

    const leadIds = this.uniqueStrings(
      events.map((event) => event.leadId ?? null),
    );
    const phoneHashes = this.uniqueStrings(
      events.map((event) => (event.leadId ? null : event.phoneHash)),
    );
    const returningLeads: Array<{ id: string; phoneHash: string }> = [];
    const leadIdChunks = chunked(leadIds);
    const phoneHashChunks = chunked(phoneHashes);

    for (
      let index = 0;
      index < Math.max(leadIdChunks.length, phoneHashChunks.length);
      index += 1
    ) {
      const ids = leadIdChunks[index] ?? [];
      const hashes = phoneHashChunks[index] ?? [];
      const rows = (await this.prisma.lead.findMany({
        where: {
          workspaceId: input.workspaceId,
          AND: [
            {
              OR: [
                ...(ids.length ? [{ id: { in: ids } }] : []),
                ...(hashes.length ? [{ phoneHash: { in: hashes } }] : []),
              ],
            },
            leadFirstContactBeforeWhere(periodStart),
          ],
        },
        select: { id: true, phoneHash: true },
      })) as Array<{ id: string; phoneHash: string }>;

      returningLeads.push(...rows);
    }

    const returningIds = new Set(returningLeads.map((lead) => lead.id));
    const leadIdByPhoneHash = new Map(
      returningLeads.map((lead) => [lead.phoneHash, lead.id]),
    );

    return events.flatMap((event) => {
      const leadId =
        event.leadId ??
        (event.phoneHash ? leadIdByPhoneHash.get(event.phoneHash) : undefined);

      return leadId && returningIds.has(leadId) ? [{ ...event, leadId }] : [];
    });
  }

  private metricScopeWhere(scope: ReportMetricScopeFilter) {
    if (scope.adIds) {
      return { adId: { in: scope.adIds } };
    }

    if (scope.adSetIds) {
      return { adSetId: { in: scope.adSetIds } };
    }

    if (scope.campaignIds) {
      return { campaignId: { in: scope.campaignIds } };
    }

    return {};
  }

  private isEmptyMetricScope(scope: ReportMetricScopeFilter): boolean {
    return (
      (scope.adIds !== undefined && scope.adIds.length === 0) ||
      (scope.adSetIds !== undefined && scope.adSetIds.length === 0) ||
      (scope.campaignIds !== undefined && scope.campaignIds.length === 0)
    );
  }

  private async getFunnelStages(
    workspaceId: string,
  ): Promise<FunnelStageConfigurationDto[]> {
    const configuration =
      await this.funnelConfiguration.getConfiguration(workspaceId);

    return configuration.stages;
  }

  private async hasLeadEvidence(input: {
    workspaceId: string;
    campaignId?: string;
    adSetId?: string;
    adId?: string;
  }): Promise<boolean> {
    const leads = await this.prisma.lead.findMany({
      where: {
        workspaceId: input.workspaceId,
        // Lead de formulario (Implatec) nao conta como prova de WhatsApp.
        OR: [{ source: null }, { source: { not: LEAD_FORM_SOURCE } }],
        ...(input.campaignId ? { campaignId: input.campaignId } : {}),
        ...(input.adSetId ? { adSetId: input.adSetId } : {}),
        ...(input.adId ? { adId: input.adId } : {}),
      },
      select: { id: true },
      take: 1,
    });

    return leads.length > 0;
  }

  private async loadLeadEvidence(input: {
    workspaceId: string;
    campaignIds: string[];
    adSetIds: string[];
    adIds: string[];
  }): Promise<LeadEvidenceMaps> {
    const evidence: LeadEvidenceMaps = {
      campaigns: new Set(),
      adSets: new Set(),
      ads: new Set(),
      leadFormCampaigns: new Set(),
    };

    if (
      input.campaignIds.length === 0 &&
      input.adSetIds.length === 0 &&
      input.adIds.length === 0
    ) {
      return evidence;
    }

    const leads = (await this.prisma.lead.findMany({
      where: {
        workspaceId: input.workspaceId,
        OR: [
          ...(input.campaignIds.length
            ? [{ campaignId: { in: input.campaignIds } }]
            : []),
          ...(input.adSetIds.length
            ? [{ adSetId: { in: input.adSetIds } }]
            : []),
          ...(input.adIds.length ? [{ adId: { in: input.adIds } }] : []),
        ],
      },
      select: {
        campaignId: true,
        adSetId: true,
        adId: true,
        source: true,
      },
    })) as Array<LeadRecord & { source?: string | null }>;

    const adSetIds = new Set(input.adSetIds);
    const adIds = new Set(input.adIds);

    for (const lead of leads) {
      if (lead.source === LEAD_FORM_SOURCE) {
        // Lead de formulario nao e prova de WhatsApp: so marca a campanha
        // como formulario (Implatec).
        if (lead.campaignId) {
          evidence.leadFormCampaigns.add(lead.campaignId);
        }

        continue;
      }

      if (lead.campaignId) {
        evidence.campaigns.add(lead.campaignId);
      }

      if (lead.adSetId && adSetIds.has(lead.adSetId)) {
        evidence.adSets.add(lead.adSetId);
      }

      if (lead.adId && adIds.has(lead.adId)) {
        evidence.ads.add(lead.adId);
      }
    }

    return evidence;
  }

  private campaignMetricOverrides(
    adSets: MetaAdSetRecord[],
    ads: MetaAdRecord[],
  ): Map<string, CampaignMetricOverride> {
    const metrics = new Map<string, CampaignMetricOverride>();

    for (const adSet of adSets) {
      const current =
        metrics.get(adSet.campaignId) ??
        ({
          spendCents: 0,
          metaConversationsStarted: 0,
          adSetIds: new Set<string>(),
          adIds: new Set<string>(),
        } satisfies CampaignMetricOverride);

      current.spendCents += adSet.spendCents;
      current.metaConversationsStarted += adSet.metaConversationsStarted;
      current.adSetIds.add(adSet.adSetId);
      metrics.set(adSet.campaignId, current);
    }

    for (const ad of ads) {
      if (metrics.has(ad.campaignId)) {
        continue;
      }

      const current =
        metrics.get(ad.campaignId) ??
        ({
          spendCents: 0,
          metaConversationsStarted: 0,
          adSetIds: new Set<string>(),
          adIds: new Set<string>(),
        } satisfies CampaignMetricOverride);

      current.spendCents += ad.spendCents;
      current.metaConversationsStarted += ad.metaConversationsStarted;
      current.adIds.add(ad.adId);
      metrics.set(ad.campaignId, current);
    }

    return metrics;
  }

  private dailyCampaignMetrics(
    insights: MetaCampaignDailyInsightRecord[],
  ): Map<string, CampaignMetricOverride> {
    const metrics = new Map<string, CampaignMetricOverride>();

    for (const insight of insights) {
      const current =
        metrics.get(insight.campaignId) ??
        ({
          spendCents: 0,
          metaConversationsStarted: 0,
          adSetIds: new Set<string>(),
          adIds: new Set<string>(),
        } satisfies CampaignMetricOverride);

      current.spendCents += insight.spendCents;
      current.metaConversationsStarted += insight.metaConversationsStarted;
      metrics.set(insight.campaignId, current);
    }

    return metrics;
  }

  private completeDailyEntityMetrics<
    T extends {
      localDate: string;
      spendCents: number;
      metaConversationsStarted: number;
    },
  >(input: {
    entityIds: string[];
    entityId: (insight: T) => string;
    insights: T[];
    since?: string;
    until?: string;
  }): Map<string, EntityMetricOverride> | null {
    if (
      !input.since ||
      !input.until ||
      input.entityIds.length === 0 ||
      input.insights.length === 0
    ) {
      return null;
    }

    const expectedDates = this.reportDateRange(input.since, input.until).length;
    const datesByEntity = new Map<string, Set<string>>();
    const metrics = new Map<string, EntityMetricOverride>();

    for (const insight of input.insights) {
      const entityId = input.entityId(insight);
      const dates = datesByEntity.get(entityId) ?? new Set<string>();
      const current = metrics.get(entityId) ?? {
        spendCents: 0,
        metaConversationsStarted: 0,
      };

      dates.add(insight.localDate);
      datesByEntity.set(entityId, dates);
      current.spendCents += insight.spendCents;
      current.metaConversationsStarted += insight.metaConversationsStarted;
      metrics.set(entityId, current);
    }

    const complete =
      expectedDates > 0 &&
      input.entityIds.every(
        (entityId) => datesByEntity.get(entityId)?.size === expectedDates,
      );

    return complete ? metrics : null;
  }

  private summaryMetricScope(
    input: ReportFilterInput,
    campaignIds: string[],
  ): ReportMetricScopeFilter {
    return input.businessId || input.adAccountId || input.adAccountIds?.length
      ? { campaignIds }
      : {};
  }

  private dailyComparison(input: {
    dailyInsights: MetaCampaignDailyInsightRecord[];
    leads: LeadRecord[];
    returningEvents: ConversionEventRecord[];
    since: string;
    until: string;
  }): ReportDailyComparisonPointDto[] {
    const timezone = this.reportTimezone();
    const metaByDate = new Map<string, number>();

    for (const insight of input.dailyInsights) {
      metaByDate.set(
        insight.localDate,
        (metaByDate.get(insight.localDate) ?? 0) +
          insight.metaConversationsStarted,
      );
    }

    const dateKey = (date: Date) => dateInTimezone(date, timezone);
    const realByDate = this.metricsEngine.dailyRealConversationCounts(
      { leads: input.leads },
      dateKey,
    );
    const returningByDate = this.metricsEngine.dailyReturningLeadCounts(
      { returningEvents: input.returningEvents },
      dateKey,
    );

    return this.reportDateRange(input.since, input.until).map((date) => ({
      date,
      metaConversationsStarted: metaByDate.get(date) ?? 0,
      realConversations: realByDate.get(date) ?? 0,
      returningLeads: returningByDate.get(date) ?? 0,
    }));
  }

  private reportDateRange(since: string, until: string): string[] {
    const current = new Date(`${since}T12:00:00.000Z`);
    const last = new Date(`${until}T12:00:00.000Z`);
    const dates: string[] = [];

    while (current <= last) {
      dates.push(current.toISOString().slice(0, 10));
      current.setUTCDate(current.getUTCDate() + 1);
    }

    return dates;
  }

  private eventPeriodWhere(input: { since?: string; until?: string }) {
    if (!input.since || !input.until) {
      return {};
    }

    return {
      eventOccurredAt: dateRangeInTimezone(
        input.since,
        input.until,
        this.reportTimezone(),
      ),
    };
  }

  private leadPeriodWhere(input: { since?: string; until?: string }) {
    if (!input.since || !input.until) {
      return {};
    }

    return leadFirstContactInRangeWhere(
      dateRangeInTimezone(input.since, input.until, this.reportTimezone()),
    );
  }

  private conversionAuditEventDto(
    event: ConversionAuditEventRecord,
    eventLabels: Map<string, string>,
    context: ConversionAuditContext,
  ): ConversionAuditEventDto {
    const lead =
      (event.leadId ? context.leadsById.get(event.leadId) : undefined) ??
      (event.phoneHash
        ? context.leadsByPhoneHash.get(event.phoneHash)
        : undefined);
    const deliveryState = this.conversionAuditDeliveryState(event.status);
    const source = this.conversionAuditSource(event.sourceTrigger);
    const inferredErrorCode =
      event.errorCode ??
      this.conversionAuditInferredReasonCode(
        event,
        this.conversionAuditMissingFields(event),
      );

    return {
      id: event.id,
      eventName: event.eventName,
      eventLabel:
        eventLabels.get(event.eventName) ??
        this.conversionEventLabel(event.eventName),
      deliveryState,
      statusLabel: this.conversionAuditStatusLabel(event.status),
      statusDetail: this.conversionAuditStatusDetail(event.status, event),
      source,
      sourceLabel: this.conversionAuditSourceLabel(source),
      leadId: lead?.id ?? null,
      leadName: lead?.name ?? null,
      phoneDisplay: lead?.phoneDisplay ?? null,
      campaignId: event.campaignId,
      campaignName: event.campaignId
        ? (context.campaigns.get(event.campaignId)?.name ?? null)
        : null,
      adSetId: event.adSetId,
      adSetName: event.adSetId
        ? (context.adSets.get(event.adSetId)?.name ?? null)
        : null,
      adId: event.adId,
      adName: event.adId ? (context.ads.get(event.adId)?.name ?? null) : null,
      pixelId: event.pixelId,
      pageId: event.pageId,
      occurredAt: event.eventOccurredAt.toISOString(),
      sentAt: event.sentAt?.toISOString() ?? null,
      status: event.status,
      canRetry: canRetryConversionEvent(event),
      providerResponseSummary:
        event.status === "sent" && event.providerResponseSummary != null
          ? "Meta confirmou o recebimento"
          : null,
      errorCode: inferredErrorCode,
      errorMessage: inferredErrorCode
        ? this.conversionAuditSafeError(inferredErrorCode)
        : null,
      valueSource: event.valueSource ?? null,
    };
  }

  private conversionAuditSourceSnapshot(
    event: ConversionAuditEventDetailRecord,
    ingestionSummary: unknown,
  ): ConversionAuditEventDetailDto["sourceSnapshot"] {
    const stored = this.conversionAuditObject(event.sourcePayload);
    if (stored) {
      return {
        mode: "stored_normalized",
        label: "Entrada normalizada armazenada",
        payload: stored,
      };
    }

    const summary = this.conversionAuditObject(ingestionSummary);
    const nestedSource = summary
      ? this.conversionAuditObject(summary.sourcePayload)
      : null;
    if (nestedSource) {
      return {
        mode: "stored_normalized",
        label: "Entrada normalizada armazenada na ingestao",
        payload: nestedSource,
      };
    }

    if (summary) {
      return {
        mode: "historical_summary",
        label: "Resumo historico com contexto interno reconstruido",
        payload: {
          ...summary,
          reconstructedEventContext:
            this.conversionAuditReconstructedSource(event),
        },
      };
    }

    return {
      mode: "reconstructed",
      label: "Registro interno reconstruido; entrada original indisponivel",
      payload: this.conversionAuditReconstructedSource(event),
    };
  }

  private conversionAuditReconstructedSource(
    event: ConversionAuditEventDetailRecord,
  ): Record<string, unknown> {
    return {
      sourceTrigger: event.sourceTrigger,
      sourceEventId: event.sourceEventId,
      eventId: event.eventId,
      eventName: event.eventName,
      eventOccurredAt: event.eventOccurredAt.toISOString(),
      phoneHash: event.phoneHash,
      campaignId: event.campaignId,
      adSetId: event.adSetId,
      adId: event.adId,
      ctwaClid: event.ctwaClid,
      valueCents: event.valueCents,
      currency: event.currency,
      contentName: event.contentName,
    };
  }

  private reconstructMetaCapiRequest(
    event: ConversionAuditEventDetailRecord,
  ): Record<string, unknown> | null {
    const eventId = event.eventId ?? event.dedupeKey;
    if (
      !isSupportedConversionEventName(event.eventName) ||
      !eventId ||
      !event.phoneHash ||
      !event.ctwaClid ||
      !event.pageId ||
      !event.adId
    ) {
      return null;
    }

    const customData = this.conversionAuditObject(
      event.customData,
    ) as ConversionEventCustomDataDto | null;

    return buildMetaCapiPayload({
      eventName: event.eventName,
      eventTime: event.eventOccurredAt,
      eventId,
      phoneHash: event.phoneHash,
      ctwaClid: event.ctwaClid,
      pageId: event.pageId,
      adId: event.adId,
      valueCents: event.valueCents,
      currency: event.currency,
      contentName: event.contentName,
      customData,
    }) as unknown as Record<string, unknown>;
  }

  private conversionAuditObject(
    value: unknown,
  ): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    return this.conversionAuditSanitizeValue(value) as Record<string, unknown>;
  }

  private conversionAuditSanitizeValue(value: unknown, key = ""): unknown {
    if (
      key &&
      /(access[_-]?token|authorization|password|secret|encrypted|tokenIv|tokenTag)/i.test(
        key,
      )
    ) {
      return "[redacted]";
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.conversionAuditSanitizeValue(item));
    }

    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          this.conversionAuditSanitizeValue(entryValue, entryKey),
        ]),
      );
    }

    return value;
  }

  private conversionAuditMissingFields(
    event: Pick<
      ConversionAuditEventDetailRecord,
      | "eventName"
      | "status"
      | "phoneHash"
      | "adId"
      | "ctwaClid"
      | "pixelId"
      | "pageId"
      | "valueCents"
    >,
  ): string[] {
    const missing: string[] = [];

    if (!event.phoneHash) {
      missing.push("phone_hash");
    }
    if (!event.adId) {
      missing.push("ad_id");
    }
    if (!event.ctwaClid) {
      missing.push("ctwa_clid");
    }
    if (event.eventName === "Purchase" && event.valueCents == null) {
      missing.push("value");
    }
    if (event.status === "not_configured") {
      if (!event.pixelId) {
        missing.push("pixel_id");
      }
      if (!event.pageId) {
        missing.push("page_id");
      }
    }

    return missing;
  }

  private conversionAuditInferredReasonCode(
    event: Pick<ConversionAuditEventRecord, "status">,
    missingFields: string[],
  ): string | null {
    if (
      ![
        "not_eligible",
        "pending_meta_context",
        "pending_value",
        "not_configured",
      ].includes(event.status)
    ) {
      return null;
    }

    if (missingFields.includes("phone_hash")) {
      return "MissingPhoneHash";
    }
    if (missingFields.includes("ad_id")) {
      return "MissingAdId";
    }
    if (missingFields.includes("ctwa_clid")) {
      return "MissingCtwaClid";
    }
    if (missingFields.includes("value")) {
      return "EventValueMissing";
    }
    if (
      missingFields.includes("pixel_id") ||
      missingFields.includes("page_id")
    ) {
      return "MissingMetaDestination";
    }

    return null;
  }

  private conversionAuditMissingFieldsReason(missingFields: string[]): string {
    const labels: Record<string, string> = {
      phone_hash: "telefone identificavel",
      ad_id: "anuncio de origem",
      ctwa_clid: "identificador de clique",
      value: "valor da conversao",
      pixel_id: "pixel Meta",
      page_id: "pagina Facebook",
    };
    const readable = missingFields.map((field) => labels[field] ?? field);

    return `Campos obrigatorios ausentes: ${readable.join(", ")}`;
  }

  private async conversionAuditContext(
    workspaceId: string,
    events: ConversionAuditEventRecord[],
  ): Promise<ConversionAuditContext> {
    const leadIds = this.uniqueStrings(events.map((event) => event.leadId));
    const phoneHashes = this.uniqueStrings(
      events.map((event) => event.phoneHash),
    );
    const campaignIds = this.uniqueStrings(
      events.map((event) => event.campaignId),
    );
    const adSetIds = this.uniqueStrings(events.map((event) => event.adSetId));
    const adIds = this.uniqueStrings(events.map((event) => event.adId));
    const [leads, campaigns, adSets, ads] = await Promise.all([
      leadIds.length || phoneHashes.length
        ? (this.prisma.lead.findMany({
            where: {
              workspaceId,
              OR: [
                ...(leadIds.length ? [{ id: { in: leadIds } }] : []),
                ...(phoneHashes.length
                  ? [{ phoneHash: { in: phoneHashes } }]
                  : []),
              ],
            },
            select: {
              id: true,
              name: true,
              phoneDisplay: true,
              phoneHash: true,
            },
          }) as Promise<ConversionAuditLeadRecord[]>)
        : Promise.resolve([] as ConversionAuditLeadRecord[]),
      campaignIds.length
        ? (this.prisma.metaCampaign.findMany({
            where: { workspaceId, campaignId: { in: campaignIds } },
            select: { campaignId: true, name: true },
          }) as Promise<ConversionAuditCampaignRecord[]>)
        : Promise.resolve([] as ConversionAuditCampaignRecord[]),
      adSetIds.length
        ? (this.prisma.metaAdSet.findMany({
            where: { workspaceId, adSetId: { in: adSetIds } },
            select: { adSetId: true, name: true },
          }) as Promise<ConversionAuditAdSetRecord[]>)
        : Promise.resolve([] as ConversionAuditAdSetRecord[]),
      adIds.length
        ? (this.prisma.metaAd.findMany({
            where: { workspaceId, adId: { in: adIds } },
            select: { adId: true, name: true },
          }) as Promise<ConversionAuditAdRecord[]>)
        : Promise.resolve([] as ConversionAuditAdRecord[]),
    ]);

    return {
      leadsById: new Map(leads.map((lead) => [lead.id, lead])),
      leadsByPhoneHash: new Map(leads.map((lead) => [lead.phoneHash, lead])),
      campaigns: new Map(
        campaigns.map((campaign) => [campaign.campaignId, campaign]),
      ),
      adSets: new Map(adSets.map((adSet) => [adSet.adSetId, adSet])),
      ads: new Map(ads.map((ad) => [ad.adId, ad])),
    };
  }

  private conversionAuditPeriodWhere(input: {
    since?: string;
    until?: string;
  }) {
    if (!input.since || !input.until) {
      return {};
    }

    return {
      eventOccurredAt: dateRangeInTimezone(
        input.since,
        input.until,
        this.reportTimezone(),
      ),
    };
  }

  private reportTimezone(): string {
    return process.env.WPPTRACK_REPORT_TIMEZONE ?? "America/Sao_Paulo";
  }

  private uniqueStrings(values: Array<string | null>): string[] {
    return [
      ...new Set(values.filter((value): value is string => Boolean(value))),
    ];
  }

  private conversionAuditWhere(
    input: ConversionAuditFilters,
  ): Prisma.ConversionEventLogWhereInput {
    return {
      workspaceId: input.workspaceId,
      ...this.conversionAuditPeriodWhere(input),
      ...(input.eventName ? { eventName: input.eventName } : {}),
      ...(input.deliveryState
        ? { status: { in: this.conversionAuditStatuses(input.deliveryState) } }
        : {}),
      AND: [
        this.conversionAuditSourceWhere(input.source),
        { NOT: { sourceTrigger: "auto_lead", ctwaClid: null } },
      ],
    };
  }

  private conversionAuditSourceWhere(
    source?: ConversionAuditSourceDto,
  ): Prisma.ConversionEventLogWhereInput {
    if (!source) {
      return {};
    }

    if (source === "external_integration") {
      return { sourceTrigger: { startsWith: "external_mysql:" } };
    }

    if (source === "whatsapp_automation") {
      return {
        OR: [
          { sourceTrigger: { in: ["keyword", "whatsapp_label"] } },
          { sourceTrigger: { startsWith: "inbound_webhook:" } },
        ],
      };
    }

    if (source === "system") {
      return { sourceTrigger: "auto_lead" };
    }

    if (source === "manual_test") {
      return { sourceTrigger: "manual_test" };
    }

    return {
      NOT: {
        OR: [
          { sourceTrigger: { startsWith: "external_mysql:" } },
          {
            sourceTrigger: {
              in: ["keyword", "whatsapp_label", "auto_lead", "manual_test"],
            },
          },
        ],
      },
    };
  }

  private conversionAuditStatuses(
    state: ConversionAuditDeliveryStateDto,
  ): ConversionEventLogStatusDto[] {
    const statuses: Record<
      ConversionAuditDeliveryStateDto,
      ConversionEventLogStatusDto[]
    > = {
      sent: ["sent"],
      queued: ["ready_to_send", "queued"],
      blocked: ["pending_meta_context", "pending_value", "not_configured"],
      failed: ["error"],
      not_eligible: ["not_eligible"],
      shadow: ["shadow_observed"],
      historical: ["imported"],
      discarded: ["skipped"],
    };

    return statuses[state];
  }

  private conversionAuditDeliveryState(
    status: ConversionEventLogStatusDto,
  ): ConversionAuditDeliveryStateDto {
    const states: ConversionAuditDeliveryStateDto[] = [
      "sent",
      "queued",
      "blocked",
      "failed",
      "not_eligible",
      "shadow",
      "historical",
      "discarded",
    ];

    return (
      states.find((state) =>
        this.conversionAuditStatuses(state).includes(status),
      ) ?? "blocked"
    );
  }

  private conversionAuditStateCount(
    counts: Map<string, number>,
    state: ConversionAuditDeliveryStateDto,
  ): number {
    return this.conversionAuditStatuses(state).reduce(
      (total, status) => total + (counts.get(status) ?? 0),
      0,
    );
  }

  private conversionAuditStatusLabel(
    status: ConversionEventLogStatusDto,
  ): string {
    const labels: Record<ConversionEventLogStatusDto, string> = {
      pending_meta_context: "Bloqueado",
      pending_value: "Bloqueado",
      ready_to_send: "Pronto para envio",
      queued: "Na fila",
      sent: "Enviado",
      error: "Falhou",
      imported: "Historico",
      not_eligible: "Nao elegivel",
      shadow_observed: "Observado em sombra",
      not_configured: "Bloqueado",
      skipped: "Descartado",
    };

    return labels[status];
  }

  private conversionAuditStatusDetail(
    status: ConversionEventLogStatusDto,
    event?: ConversionAuditEventRecord,
  ): string {
    const details: Record<ConversionEventLogStatusDto, string> = {
      pending_meta_context: "Aguardando identificacao de anuncio e conversa",
      pending_value: "Aguardando valor do evento",
      ready_to_send: "Pronto para entrar na fila de envio",
      queued: "Aguardando processamento da fila Meta",
      sent: "Recebido pela Meta",
      error: "O envio nao foi concluido",
      imported: "Marco historico, sem reenvio para a Meta",
      not_eligible: event
        ? this.conversionAuditNotEligibleDetail(event)
        : "Sem dados obrigatorios, sem envio para a Meta",
      shadow_observed: "Coletado antes do corte, sem envio pelo WppTrack",
      not_configured: "Destino Meta ainda nao configurado",
      skipped: "Descartado pelas regras de validacao",
    };

    return details[status];
  }

  private conversionAuditNotEligibleDetail(
    event: ConversionAuditEventRecord,
  ): string {
    const missingFields = this.conversionAuditMissingFields(event);

    return missingFields.length
      ? this.conversionAuditMissingFieldsReason(missingFields)
      : "Sem dados obrigatorios, sem envio para a Meta";
  }

  private conversionAuditSource(
    sourceTrigger: string,
  ): ConversionAuditSourceDto {
    if (sourceTrigger.startsWith("external_mysql:")) {
      return "external_integration";
    }

    if (["keyword", "whatsapp_label"].includes(sourceTrigger)) {
      return "whatsapp_automation";
    }

    if (sourceTrigger === "auto_lead") {
      return "system";
    }

    if (sourceTrigger === "manual_test") {
      return "manual_test";
    }

    return "other";
  }

  private conversionAuditSourceLabel(source: ConversionAuditSourceDto): string {
    const labels: Record<ConversionAuditSourceDto, string> = {
      external_integration: "Integracao externa",
      whatsapp_automation: "Automacao do WhatsApp",
      system: "Regra automatica",
      manual_test: "Teste manual",
      other: "Outra origem",
    };

    return labels[source];
  }

  private conversionAuditSafeError(errorCode: string): string {
    const errors: Record<string, string> = {
      MissingMetaDestination: "Destino Meta nao configurado",
      MissingAccessToken: "A conexao Meta precisa ser refeita",
      MissingPhoneHash: "Telefone do lead indisponivel",
      MissingCtwaClid: "Identificador da conversa de anuncio ausente",
      MissingAdId: "Anuncio de origem nao identificado",
      EventValueMissing: "Valor do evento nao configurado",
      MetaCapiRejected: "A Meta recusou o evento",
      MetaCapiNetworkError: "Falha de comunicacao com a Meta",
    };

    return errors[errorCode] ?? "Falha no processamento do evento";
  }

  private conversionEventLabel(eventName: string): string {
    if (eventName === "LeadSubmitted") {
      return "Conversas reais iniciadas";
    }

    if (eventName === "QualifiedLead") {
      return "Lead qualificado";
    }

    if (eventName === "Purchase") {
      return "Compras";
    }

    return eventName;
  }

  private metaSnapshotWhereFromHierarchy(
    hierarchyWhere: Omit<MetaSnapshotWhere, "whatsappClassification">,
    input: ReportFilterInput,
  ): MetaSnapshotWhere {
    const where: MetaSnapshotWhere = { ...hierarchyWhere };

    // Implatec: so a tabela MetaCampaign tem campaignKind; para conjuntos e
    // anuncios use metaChildSnapshotWhere.
    if (input.campaignKind === "lead_form") {
      where.campaignKind = "lead_form";

      return where;
    }

    const classification = input.whatsappClassification ?? "whatsapp";

    if (classification === "whatsapp") {
      where.whatsappClassification = {
        in: [
          "auto_whatsapp",
          "creative_whatsapp",
          "detected_by_leads",
          "manual_include",
        ],
      };
    } else if (classification === "needs_review") {
      where.whatsappClassification = "needs_review";
    } else if (classification === "excluded") {
      where.whatsappClassification = "manual_exclude";
    }

    if (input.campaignKind === "all" && where.whatsappClassification) {
      // Todas = as campanhas de WhatsApp do filtro de canal + as de formulario.
      where.OR = [
        { whatsappClassification: where.whatsappClassification },
        { campaignKind: "lead_form" },
      ];
      delete where.whatsappClassification;
    }

    return where;
  }

  /**
   * Implatec: o mesmo recorte para MetaAdSet/MetaAd, que nao tem a coluna
   * campaignKind: o tipo vira uma lista de campanhas.
   */
  private async metaChildSnapshotWhere(
    hierarchyWhere: Omit<MetaSnapshotWhere, "whatsappClassification">,
    input: ReportFilterInput,
  ): Promise<MetaSnapshotWhere> {
    const kind = input.campaignKind;
    const withoutKind = { ...input, campaignKind: undefined };

    if (!kind || kind === "whatsapp") {
      return this.metaSnapshotWhereFromHierarchy(hierarchyWhere, withoutKind);
    }

    const leadFormCampaignIds = (
      (await this.prisma.metaCampaign.findMany({
        where: { ...hierarchyWhere, campaignKind: "lead_form" },
        select: { campaignId: true },
      })) as Array<{ campaignId: string }>
    ).map((campaign) => campaign.campaignId);

    if (kind === "lead_form") {
      return { ...hierarchyWhere, campaignId: { in: leadFormCampaignIds } };
    }

    const base = this.metaSnapshotWhereFromHierarchy(
      hierarchyWhere,
      withoutKind,
    );
    const { whatsappClassification, ...rest } = base;

    if (!whatsappClassification) {
      return rest;
    }

    return {
      ...rest,
      OR: [
        { whatsappClassification },
        { campaignId: { in: leadFormCampaignIds } },
      ],
    };
  }

  private async metaHierarchyWhere(
    input: {
      workspaceId: string;
    } & ReportFilterInput,
  ): Promise<Omit<MetaSnapshotWhere, "whatsappClassification">> {
    return (await this.metaHierarchyScope(input)).where;
  }

  /**
   * Hierarchy filter of the active reporting accounts (business / one ad
   * account / several ad accounts / campaign) plus the effective spend
   * currency of each of those accounts, read by the same query.
   */
  private async metaHierarchyScope(
    input: {
      workspaceId: string;
    } & ReportFilterInput,
  ): Promise<MetaHierarchyScope> {
    const where: Omit<MetaSnapshotWhere, "whatsappClassification"> = {
      workspaceId: input.workspaceId,
    };
    const requestedAccountIds = [
      ...new Set(
        [input.adAccountId, ...(input.adAccountIds ?? [])].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ];
    const singleAccount =
      input.adAccountId && !input.adAccountIds?.length
        ? input.adAccountId
        : null;
    const allActiveAccounts = (await this.prisma.metaReportingAccount.findMany(
      {
        where: {
          workspaceId: input.workspaceId,
          active: true,
          ...(input.businessId ? { businessId: input.businessId } : {}),
          ...(singleAccount ? { adAccountId: singleAccount } : {}),
        },
        select: {
          businessId: true,
          adAccountId: true,
          currency: true,
          currencyOverride: true,
        },
      },
    )) as Array<{
      businessId: string;
      adAccountId: string;
      currency?: string | null;
      currencyOverride?: string | null;
    }>;
    const activeAccounts = requestedAccountIds.length
      ? allActiveAccounts.filter((account) =>
          requestedAccountIds.includes(account.adAccountId),
        )
      : allActiveAccounts;
    const accountCurrencies = new Map(
      activeAccounts.map((account) => [
        account.adAccountId,
        effectiveAccountCurrency(account),
      ]),
    );
    const scope = (): MetaHierarchyScope => ({ where, accountCurrencies });

    if (input.businessId) {
      where.businessId = input.businessId;
    }

    if (input.campaignId) {
      where.campaignId = input.campaignId;
    }

    if (singleAccount) {
      where.adAccountId = activeAccounts.some(
        (account) => account.adAccountId === singleAccount,
      )
        ? singleAccount
        : { in: [] };
      return scope();
    }

    where.adAccountId = {
      in: [...new Set(activeAccounts.map((account) => account.adAccountId))],
    };

    if (!input.businessId && activeAccounts.length > 0) {
      where.businessId = {
        in: [...new Set(activeAccounts.map((account) => account.businessId))],
      };
    }

    return scope();
  }

  /**
   * Currency of every campaign / ad set / ad of the report: the effective
   * currency of its ad account. Revenue attributed to them is converted to it.
   */
  private reportCurrencyContext(input: {
    accountCurrencies: Map<string, CurrencyCode>;
    campaigns: Array<{ campaignId: string; adAccountId?: string | null }>;
    adSets?: Array<{
      adSetId: string;
      campaignId: string;
      adAccountId?: string | null;
    }>;
    ads?: Array<{
      adId: string;
      adSetId: string;
      campaignId: string;
      adAccountId?: string | null;
    }>;
  }): ReportCurrencyContext {
    const accountCurrency = (adAccountId: string | null | undefined) =>
      (adAccountId ? input.accountCurrencies.get(adAccountId) : undefined) ??
      DEFAULT_CURRENCY_CODE;
    const campaignCurrency = new Map(
      input.campaigns.map((campaign) => [
        campaign.campaignId,
        accountCurrency(campaign.adAccountId),
      ]),
    );
    const adSetCurrency = new Map(
      (input.adSets ?? []).map((adSet) => [
        adSet.adSetId,
        adSet.adAccountId
          ? accountCurrency(adSet.adAccountId)
          : (campaignCurrency.get(adSet.campaignId) ?? DEFAULT_CURRENCY_CODE),
      ]),
    );
    const adCurrency = new Map(
      (input.ads ?? []).map((ad) => [
        ad.adId,
        ad.adAccountId
          ? accountCurrency(ad.adAccountId)
          : (campaignCurrency.get(ad.campaignId) ??
            adSetCurrency.get(ad.adSetId) ??
            DEFAULT_CURRENCY_CODE),
      ]),
    );

    return {
      accountCurrency,
      attributionCurrency: (item) =>
        (item.adId ? adCurrency.get(item.adId) : undefined) ??
        (item.adSetId ? adSetCurrency.get(item.adSetId) : undefined) ??
        (item.campaignId ? campaignCurrency.get(item.campaignId) : undefined) ??
        null,
      scopeCurrencies: [...new Set(input.accountCurrencies.values())],
    };
  }

  /** Revenue of each event in the currency of the account of its ad (PTAX). */
  private async convertReportEvents<E extends ReportingMetricEvent>(
    context: ReportCurrencyContext,
    eventLists: E[][],
  ): Promise<Array<Array<E & CurrencyConvertedEvent>>> {
    const requests = exchangeRateRequests(
      eventLists.flat(),
      context.attributionCurrency,
    );
    // BRL-only workspaces never get here with requests: no lookup at all.
    const table = requests.length
      ? await this.loadExchangeRates(requests)
      : null;

    return eventLists.map((events) =>
      convertEventValues(events, context.attributionCurrency, table),
    );
  }

  private async loadExchangeRates(
    requests: ExchangeRateRequest[],
  ): Promise<ExchangeRateTable> {
    if (!this.exchangeRates) return new ExchangeRateTable();

    try {
      return await this.exchangeRates.loadRateTable(requests);
    } catch {
      return new ExchangeRateTable();
    }
  }

  /**
   * `currency` (single) or `byCurrency` (mixed) for a report scope. Only
   * currencies with spend or revenue in the period count: one -> single
   * report in it; none -> the currency of the filtered accounts (when they
   * agree) or the workspace conversion currency.
   */
  private async currencyBreakdown<
    E extends CurrencyConvertedEvent,
    L extends LeadRecord,
  >(input: {
    workspaceId: string;
    context: ReportCurrencyContext;
    funnelStages: FunnelStageConfigurationDto[];
    entities: CurrencyEntity[];
    events: E[];
    leads: L[];
    returningEvents: E[];
    leadIdsByPhoneHash?: ReadonlyMap<string, readonly string[]>;
  }): Promise<CurrencyBreakdown> {
    const currencies = reportCurrencies(input);
    const fallbackCurrency =
      currencies.length === 1
        ? currencies[0]!
        : currencies.length === 0 && input.context.scopeCurrencies.length === 1
          ? input.context.scopeCurrencies[0]!
          : await loadWorkspaceConversionCurrency(
              this.prisma,
              input.workspaceId,
            );

    return buildCurrencyBreakdown({
      entities: input.entities,
      events: input.events,
      leads: input.leads,
      returningEvents: input.returningEvents,
      attributionCurrency: input.context.attributionCurrency,
      fallbackCurrency,
      calculate: (group) =>
        this.calculateMetrics({
          funnelStages: input.funnelStages,
          spendCents: group.spendCents,
          metaConversationsStarted: group.metaConversationsStarted,
          events: group.events,
          leads: group.leads,
          returningEvents: group.returningEvents,
          ...(input.leadIdsByPhoneHash
            ? { leadIdsByPhoneHash: input.leadIdsByPhoneHash }
            : {}),
          scope: {},
        }) as ReportTotalsDto,
    });
  }

  private currencyFields(breakdown: CurrencyBreakdown): {
    currency: CurrencyCode | null;
    byCurrency?: ReportCurrencyGroupDto[];
    exchangeRateMissing?: boolean;
    unconvertedRevenue?: UnconvertedRevenueDto[];
  } {
    return {
      currency: breakdown.currency,
      ...(breakdown.byCurrency ? { byCurrency: breakdown.byCurrency } : {}),
      ...(breakdown.exchangeRateMissing
        ? {
            exchangeRateMissing: true,
            unconvertedRevenue: breakdown.unconvertedRevenue,
          }
        : {}),
    };
  }

  private centsToDecimal(cents: number): string {
    return (cents / 100).toFixed(2);
  }

  private csvCell(value: string): string {
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }

  private csvFilename(input: { since?: string; until?: string }): string {
    return input.since && input.until
      ? `wpptrack-campanhas-${input.since}-${input.until}.csv`
      : "wpptrack-campanhas.csv";
  }

  private toReportStatus(
    status: string | null,
  ): CampaignReportRowDto["status"] {
    if (status === "ACTIVE") {
      return "active";
    }

    if (status === "PAUSED") {
      return "paused";
    }

    if (status === "DELETED" || status === "ARCHIVED") {
      return "deleted";
    }

    return "unknown";
  }
}
