import type {
  CampaignReportRowDto,
  CurrencyCode,
  MetaAssetsDto,
  ReportCurrencyGroupDto,
  ReportDailyComparisonPointDto,
  ReportFunnelStepDto,
  ReportOverviewDto,
} from "@wpptrack/shared";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import {
  CurrencyKpiGroups,
  ExchangeRateMissingNote,
} from "../../../components/currency-kpi-groups";
import { PresentationMask } from "../../../components/presentation-mask";
import {
  joinAdAccountIds,
  parseAdAccountIdsParam,
  setAdAccountParams,
  splitAdAccountIds,
} from "../../../lib/ad-account-params";
import {
  adAccountCurrencyMap,
  getAdAccountCurrencies,
} from "../../../lib/currency-settings";
import {
  currencyKpiGroup,
  exchangeRateMissingLabel,
  formatReportMoney,
  mixedCurrencyGroups,
  reportCurrency,
  singleCurrencyRateGap,
} from "../../../lib/report-currency";
import { serverApiFetch } from "../../../lib/server-api";
import { OverviewFilters } from "./overview-filters";
import {
  OverviewLeadsBlock,
  overviewLeadsHints,
  type OverviewLeadsBlockItem,
} from "./overview-leads-block";
import { overviewLeadsHref } from "./overview-leads-links";

type OverviewSearchParams = Record<string, string | string[] | undefined>;
type OverviewFiltersInput = {
  /** Contas de anúncio juntas por "," (`adAccountId` ou `adAccountIds` na URL). */
  adAccountId?: string;
  businessId?: string;
  since?: string;
  until?: string;
};

type OverviewFetchState = "real" | "empty" | "error";
type OverviewReportResult = {
  report: ReportOverviewDto;
  state: OverviewFetchState;
};

/** Dinheiro na moeda do recorte (BRL quando todas as contas são em real). */
function money(cents: number | null, currency: CurrencyCode = "BRL") {
  return formatReportMoney(cents, currency);
}

async function getOverviewReport(
  filters: OverviewFiltersInput,
): Promise<OverviewReportResult> {
  try {
    const params = new URLSearchParams({
      includeDaily: "true",
      includeSummary: "true",
      // Implatec: WhatsApp + formulario (Lead Ads); cada linha traz campaignKind.
      campaignKind: "all",
    });

    if (filters.since && filters.until) {
      params.set("since", filters.since);
      params.set("until", filters.until);
    }

    if (filters.businessId) {
      params.set("businessId", filters.businessId);
    }

    setAdAccountParams(params, splitAdAccountIds(filters.adAccountId));

    const report = await serverApiFetch<ReportOverviewDto>(
      `/reports/campaigns?${params.toString()}`,
    );

    return {
      report,
      state:
        report.campaigns.length > 0 || (report.summary?.totalReceived ?? 0) > 0
          ? "real"
          : "empty",
    };
  } catch {
    return {
      report: {
        workspaceId: "unavailable",
        rangeLabel: "API indisponivel",
        campaigns: [],
      },
      state: "error",
    };
  }
}

async function getMetaAssets(): Promise<MetaAssetsDto | null> {
  try {
    return await serverApiFetch<MetaAssetsDto>("/integrations/meta/assets");
  } catch {
    return null;
  }
}

function asStringParam(value: string | string[] | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sumCampaigns(campaigns: CampaignReportRowDto[]): CampaignReportRowDto {
  const spendCents = campaigns.reduce(
    (total, campaign) => total + campaign.spendCents,
    0,
  );
  const metaConversationsStarted = campaigns.reduce(
    (total, campaign) => total + campaign.metaConversationsStarted,
    0,
  );
  const realConversations = campaigns.reduce(
    (total, campaign) => total + campaign.realConversations,
    0,
  );
  const organicLeads = campaigns.reduce(
    (total, campaign) => total + campaign.organicLeads,
    0,
  );
  const totalReceived = campaigns.reduce(
    (total, campaign) => total + campaign.totalReceived,
    0,
  );
  const qualifiedLead = campaigns.reduce(
    (total, campaign) => total + campaign.qualifiedLead,
    0,
  );
  const purchases = campaigns.reduce(
    (total, campaign) => total + campaign.purchases,
    0,
  );
  const firstPurchases = campaigns.reduce(
    (total, campaign) => total + campaign.firstPurchases,
    0,
  );
  const repurchases = campaigns.reduce(
    (total, campaign) => total + campaign.repurchases,
    0,
  );
  const trafficRevenueCents = campaigns.reduce(
    (total, campaign) => total + campaign.trafficRevenueCents,
    0,
  );
  const organicRevenueCents = campaigns.reduce(
    (total, campaign) => total + campaign.organicRevenueCents,
    0,
  );
  const totalRevenueCents = trafficRevenueCents + organicRevenueCents;
  const firstPurchaseRevenueCents = campaigns.reduce(
    (total, campaign) => total + campaign.firstPurchaseRevenueCents,
    0,
  );
  const repurchaseRevenueCents = campaigns.reduce(
    (total, campaign) => total + campaign.repurchaseRevenueCents,
    0,
  );
  const estimatedRevenueCents = campaigns.reduce(
    (total, campaign) => total + campaign.estimatedRevenueCents,
    0,
  );

  return {
    id: "all_campaigns",
    name:
      campaigns.length === 0
        ? "Nenhuma campanha sincronizada"
        : campaigns.length === 1
          ? (campaigns[0]?.name ?? "Campanha")
          : "Todas as campanhas",
    status: campaigns.some((campaign) => campaign.status === "active")
      ? "active"
      : "unknown",
    spendCents,
    metaConversationsStarted,
    costPerMetaConversationCents: costPer(spendCents, metaConversationsStarted),
    realConversations,
    costPerRealConversationCents: costPer(spendCents, realConversations),
    organicLeads,
    totalReceived,
    trackingRate: ratio(realConversations, totalReceived),
    qualifiedLead,
    costPerQualifiedLeadCents: costPer(spendCents, qualifiedLead),
    purchases,
    firstPurchases,
    repurchases,
    costPerPurchaseCents: costPer(spendCents, purchases),
    trafficRevenueCents,
    organicRevenueCents,
    totalRevenueCents,
    firstPurchaseRevenueCents,
    repurchaseRevenueCents,
    estimatedRevenueCents,
    hasEstimatedRevenue: estimatedRevenueCents > 0,
    roasAcquisition: weightedRoas(
      campaigns,
      (campaign) => campaign.roasAcquisition,
    ),
    roasWithRepurchase: weightedRoas(
      campaigns,
      (campaign) => campaign.roasWithRepurchase,
    ),
    // R1: preserve every configured funnel stage from the API (IC, AddToCart,
    // custom events). Hardcoding QL/Purchase dropped InitiateCheckout when the
    // overview fell back to client-side aggregation.
    funnelSteps: aggregateFunnelSteps(campaigns, spendCents),
  };
}

function aggregateFunnelSteps(
  campaigns: CampaignReportRowDto[],
  spendCents: number,
): ReportFunnelStepDto[] {
  const steps = new Map<string, ReportFunnelStepDto>();
  const order: string[] = [];

  for (const campaign of campaigns) {
    for (const step of campaign.funnelSteps) {
      const current = steps.get(step.key);
      if (!current) {
        order.push(step.key);
      }
      steps.set(step.key, {
        key: step.key,
        label: current?.label ?? step.label,
        value: (current?.value ?? 0) + step.value,
        costCents: null,
      });
    }
  }

  return order.map((key) => {
    const step = steps.get(key)!;
    return {
      ...step,
      costCents: costPer(spendCents, step.value),
    };
  });
}

/** "R$ 5,00 · US$ 1,00": um custo por moeda, na ordem dos blocos. */
function perCurrencyCost(
  groups: ReportCurrencyGroupDto[],
  select: (group: ReportCurrencyGroupDto) => number | null | undefined,
): string | null {
  const parts = groups.flatMap((group) => {
    const cents = select(group);

    return typeof cents === "number" ? [money(cents, group.currency)] : [];
  });

  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Custo de uma etapa do funil em cada moeda (os grupos têm o próprio funil). */
function perCurrencyStageCost(
  stage: ReportFunnelStepDto,
  groups: ReportCurrencyGroupDto[],
): string {
  return (
    perCurrencyCost(groups, (group) =>
      stage.key === "meta_conversations"
        ? group.costPerMetaConversationCents
        : group.funnelSteps.find((step) => step.key === stage.key)?.costCents,
    ) ?? "-"
  );
}

function costPer(spendCents: number, count: number): number | null {
  return count > 0 ? Math.floor(spendCents / count) : null;
}

function ratio(part: number, total: number): number | null {
  return total > 0 ? part / total : null;
}

function weightedRoas(
  campaigns: CampaignReportRowDto[],
  selectRoas: (campaign: CampaignReportRowDto) => number | null,
): number | null {
  const weighted = campaigns.reduce(
    (total, campaign) => {
      const value = selectRoas(campaign);

      if (value === null || campaign.spendCents === 0) {
        return total;
      }

      return {
        revenueBasis: total.revenueBasis + value * campaign.spendCents,
        spendCents: total.spendCents + campaign.spendCents,
      };
    },
    { revenueBasis: 0, spendCents: 0 },
  );

  return weighted.spendCents > 0
    ? weighted.revenueBasis / weighted.spendCents
    : null;
}

function ratePercent(rate: number | null): number {
  return rate === null ? 0 : Math.round(rate * 100);
}

function ratioLabel(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(2)}x`;
}

function purchaseBreakdownLabel(
  firstPurchases: number,
  repurchases: number,
): string {
  if (firstPurchases === 0 && repurchases === 0) {
    return "Nenhuma compra no periodo";
  }

  const firstPurchaseLabel = `${firstPurchases} ${firstPurchases === 1 ? "primeira compra" : "primeiras compras"}`;

  if (repurchases === 0) {
    return firstPurchaseLabel;
  }

  return `${firstPurchaseLabel}, ${repurchases} ${repurchases === 1 ? "recompra" : "recompras"}`;
}

function funnelStageCostLabel(stage: ReportFunnelStepDto): string {
  const labels: Record<string, string> = {
    meta_conversations: "Custo por conversa Meta",
    real_conversations: "Custo por lead novo",
    qualified_lead: "Custo por lead qualificado",
    purchase: "Custo por compra",
    first_purchase: "Custo por primeira compra",
    repurchase: "Custo por recompra",
    event_initiate_checkout: "Custo por checkout iniciado",
    event_add_to_cart: "Custo por adicao ao carrinho",
  };

  if (labels[stage.key]) {
    return labels[stage.key]!;
  }

  const normalized = stage.label.trim().toLocaleLowerCase("pt-BR");
  return normalized.length > 0 ? `Custo por ${normalized}` : "Custo por etapa";
}

/** Primary KPI cards for configured journey events beyond the fixed set. */
function configuredJourneyMetric(
  funnelSteps: ReportFunnelStepDto[],
): ReportFunnelStepDto | null {
  const preferredKeys = [
    "event_initiate_checkout",
    "event_add_to_cart",
    "event_view_content",
  ];
  for (const key of preferredKeys) {
    const step = funnelSteps.find((item) => item.key === key);
    if (step) return step;
  }
  return (
    funnelSteps.find(
      (step) =>
        step.key.startsWith("event_") &&
        !["event_purchase", "event_qualified_lead"].includes(step.key),
    ) ?? null
  );
}

/** Optional API counts: absent on older payloads, shown as "-". */
function optionalCount(value: number | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function reportsHref(filters: OverviewFiltersInput): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value && key !== "adAccountId") {
      params.set(key, value);
    }
  }

  setAdAccountParams(params, splitAdAccountIds(filters.adAccountId));

  const query = params.toString();
  return query ? `/reports?${query}` : "/reports";
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams?: Promise<OverviewSearchParams>;
}) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const filters: OverviewFiltersInput = {
    since: asStringParam(resolvedSearchParams.since),
    until: asStringParam(resolvedSearchParams.until),
    businessId: asStringParam(resolvedSearchParams.businessId),
    adAccountId:
      joinAdAccountIds(
        parseAdAccountIdsParam(
          resolvedSearchParams.adAccountId,
          resolvedSearchParams.adAccountIds,
        ),
      ) || undefined,
  };
  const [{ report, state: reportState }, metaAssets, adAccountCurrencies] =
    await Promise.all([
      getOverviewReport(filters),
      getMetaAssets(),
      getAdAccountCurrencies(),
    ]);
  const reportingAccounts = (metaAssets?.reportingAccounts ?? []).filter(
    (account) => account.active,
  );
  const accountCurrencies = adAccountCurrencyMap(
    reportingAccounts,
    adAccountCurrencies,
  );
  const selectedAdAccountIds = splitAdAccountIds(filters.adAccountId);
  const campaigns = report.campaigns;
  const campaign = report.summary ?? sumCampaigns(campaigns);
  // Uma moeda só: tudo igual a antes (em real, sem rótulo novo). Duas ou mais
  // com movimento: um bloco por moeda, sem somar valores de moedas diferentes.
  const currencyGroups = mixedCurrencyGroups(report, "summary");
  const mixedCurrency = currencyGroups.length > 0;
  const reportMoneyCurrency = reportCurrency(report, "summary");
  const rateGap = mixedCurrency
    ? { exchangeRateMissing: false, unconvertedRevenue: [] }
    : singleCurrencyRateGap(report, "summary");
  const fmt = (cents: number | null) => money(cents, reportMoneyCurrency);
  const stageCostLabel = (stage: ReportFunnelStepDto): string =>
    mixedCurrency
      ? perCurrencyStageCost(stage, currencyGroups)
      : fmt(stage.costCents ?? null);
  const costPerLeadLabel = mixedCurrency
    ? perCurrencyCost(
        currencyGroups,
        (group) => group.costPerRealConversationCents,
      )
    : campaign.costPerRealConversationCents !== null
      ? fmt(campaign.costPerRealConversationCents)
      : null;
  const dataAvailable = reportState !== "error";
  const trackedRate =
    dataAvailable && campaign.trackingRate !== null
      ? ratePercent(campaign.trackingRate)
      : null;
  const funnelStages: ReportFunnelStepDto[] = [
    {
      key: "meta_conversations",
      label: "Conversas Meta",
      value: campaign.metaConversationsStarted,
      costCents: campaign.costPerMetaConversationCents,
    },
    ...campaign.funnelSteps,
  ];
  const journeyMetric = configuredJourneyMetric(campaign.funnelSteps);
  const selectedBusiness = reportingAccounts.find(
    (account) => account.businessId === filters.businessId,
  );
  const selectedAccount = reportingAccounts.find(
    (account) => account.adAccountId === filters.adAccountId,
  );
  const scopeLabel =
    selectedAccount?.adAccountName ??
    selectedBusiness?.businessName ??
    "Todas as contas";
  const detailHref = reportsHref(filters);
  const leadsPeriod = {
    since: report.since ?? filters.since,
    until: report.until ?? filters.until,
  };
  const newLeadsHref = overviewLeadsHref(filters, leadsPeriod, "new");
  const leadsBlockItems: OverviewLeadsBlockItem[] = [
    {
      key: "new",
      label: "Leads novos",
      value: campaign.realConversations,
      caption:
        costPerLeadLabel !== null
          ? `Custo por lead novo ${costPerLeadLabel}`
          : "1º contato no período",
      hint: overviewLeadsHints.new,
      href: newLeadsHref,
      hrefLabel: "Ver os leads novos na lista de leads",
    },
    {
      key: "returning",
      label: "Voltaram por anúncio",
      value: optionalCount(campaign.returningLeads),
      caption: "Já eram leads antes do período",
      hint: overviewLeadsHints.returning,
      href: overviewLeadsHref(filters, leadsPeriod, "returning"),
      hrefLabel: "Ver quem voltou por anúncio na lista de leads",
    },
    {
      key: "repeat",
      label: "Conversaram mais de uma vez",
      value: optionalCount(campaign.repeatConversationLeads),
      caption: "2 ou mais conversas no período",
      hint: overviewLeadsHints.repeat,
      href: overviewLeadsHref(filters, leadsPeriod, "repeat"),
      hrefLabel: "Ver quem conversou mais de uma vez na lista de leads",
    },
    {
      key: "conversations",
      label: "Conversas por anúncio",
      value: optionalCount(campaign.adConversationEvents),
      caption: "Inclui conversas repetidas",
      hint: overviewLeadsHints.conversations,
    },
  ];
  const funnelSummary = dataAvailable
    ? `${report.rangeLabel}: ${campaign.metaConversationsStarted} conversas registradas pela Meta chegaram a ${campaign.firstPurchases} ${campaign.firstPurchases === 1 ? "primeira compra" : "primeiras compras"}.`
    : "A jornada sera exibida quando a API concluir a inicializacao.";

  return (
    <section className="page-stack page-wide overview-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Visao geral</span>
          <h1>Cockpit da operacao</h1>
          <p>
            {report.rangeLabel} cruzando investimento, leads novos e eventos
            enviados ao Pixel.
          </p>
        </div>
        <div className="header-actions" aria-label="Filtros ativos">
          {reportState === "error" ? (
            <span className="status-chip warn">API indisponivel</span>
          ) : (
            <>
              <span className="tag">{report.rangeLabel}</span>
              <span className="tag">{campaigns.length} campanhas</span>
              <span className="tag">
                {trackedRate === null
                  ? "Aguardando conversas"
                  : `${trackedRate}% rastreadas`}
              </span>
            </>
          )}
        </div>
      </header>

      <OverviewFilters
        accountCurrencies={accountCurrencies}
        adAccountIds={selectedAdAccountIds}
        businessId={filters.businessId}
        hasActiveFilter={Object.values(filters).some(Boolean)}
        reportingAccounts={reportingAccounts}
        since={report.since ?? filters.since}
        until={report.until ?? filters.until}
      />

      <div className="metric-grid overview-primary-metrics">
        <Metric
          label="Investimento"
          value={
            !dataAvailable
              ? "-"
              : mixedCurrency
                ? "Por moeda"
                : fmt(campaign.spendCents)
          }
          delta={
            !dataAvailable
              ? "Aguardando resposta da API"
              : mixedCurrency
                ? "Veja os totais por moeda abaixo"
                : reportState === "empty"
                  ? "Nenhuma campanha sincronizada"
                  : report.rangeLabel
          }
          unavailable={!dataAvailable}
        />
        <Metric
          label="Conversas Meta"
          value={
            dataAvailable ? String(campaign.metaConversationsStarted) : "-"
          }
          delta={
            dataAvailable ? report.rangeLabel : "Aguardando resposta da API"
          }
          unavailable={!dataAvailable}
        />
        <Metric
          label="Leads novos"
          title={overviewLeadsHints.new}
          value={dataAvailable ? String(campaign.realConversations) : "-"}
          href={dataAvailable ? newLeadsHref : null}
          hrefLabel="Ver os leads novos na lista de leads"
          delta={
            dataAvailable
              ? "1º contato no período"
              : "Aguardando resposta da API"
          }
          unavailable={!dataAvailable}
        />
        <Metric
          label="Receita trafego"
          value={
            !dataAvailable
              ? "-"
              : mixedCurrency
                ? "Por moeda"
                : fmt(campaign.trafficRevenueCents)
          }
          delta={
            !dataAvailable
              ? "Aguardando resposta da API"
              : mixedCurrency
                ? "ROAS em cada moeda, abaixo"
                : rateGap.exchangeRateMissing
                  ? `ROAS ${exchangeRateMissingLabel}`
                  : `ROAS ${ratioLabel(campaign.roasAcquisition)}`
          }
          unavailable={!dataAvailable}
        />
        {journeyMetric ? (
          <Metric
            label={journeyMetric.label}
            value={dataAvailable ? String(journeyMetric.value) : "-"}
            delta={
              !dataAvailable
                ? "Aguardando resposta da API"
                : journeyMetric.costCents != null
                  ? funnelStageCostLabel(journeyMetric)
                  : report.rangeLabel
            }
            unavailable={!dataAvailable}
          />
        ) : null}
        <Metric
          label="Compras"
          value={dataAvailable ? String(campaign.purchases) : "-"}
          delta={
            dataAvailable
              ? purchaseBreakdownLabel(
                  campaign.firstPurchases,
                  campaign.repurchases,
                )
              : "Aguardando resposta da API"
          }
          unavailable={!dataAvailable}
        />
      </div>

      {dataAvailable && mixedCurrency ? (
        <CurrencyKpiGroups groups={currencyGroups.map(currencyKpiGroup)} />
      ) : null}

      {dataAvailable && rateGap.exchangeRateMissing ? (
        <ExchangeRateMissingNote
          unconvertedRevenue={rateGap.unconvertedRevenue}
        />
      ) : null}

      <OverviewLeadsBlock
        available={dataAvailable}
        items={leadsBlockItems}
        rangeLabel={report.rangeLabel}
      />

      {dataAvailable ? (
        <CampaignKindComparison
          campaigns={campaigns}
          fmt={fmt}
          mixedCurrency={mixedCurrency}
          rangeLabel={report.rangeLabel}
          reportsHref={detailHref}
        />
      ) : null}

      <section
        className="surface-panel overview-funnel-panel"
        aria-label="Funil integrado"
      >
        {dataAvailable ? (
          <ConversionFunnel
            description={funnelSummary}
            stageCost={stageCostLabel}
            stages={funnelStages}
          />
        ) : (
          <>
            <div className="overview-section-heading">
              <div>
                <span className="eyebrow">Funil integrado</span>
                <h2>Conversao por etapas</h2>
                <p>{funnelSummary}</p>
              </div>
            </div>
            <div className="overview-unavailable" role="status">
              <span className="status-dot" aria-hidden="true" />
              <div>
                <strong>Dados temporariamente indisponiveis</strong>
                <span>
                  Tente novamente quando a API concluir a inicializacao.
                </span>
              </div>
            </div>
          </>
        )}
      </section>

      <DailyConversationComparison
        available={report.dailyComparisonAvailable === true}
        detailHref={detailHref}
        points={report.dailyComparison ?? []}
        reportState={reportState}
        scopeLabel={scopeLabel}
      />
    </section>
  );
}

function DailyConversationComparison({
  available,
  detailHref,
  points,
  reportState,
  scopeLabel,
}: {
  available: boolean;
  detailHref: string;
  points: ReportDailyComparisonPointDto[];
  reportState: OverviewFetchState;
  scopeLabel: string;
}) {
  const metaTotal = points.reduce(
    (total, point) => total + point.metaConversationsStarted,
    0,
  );
  const realTotal = points.reduce(
    (total, point) => total + point.realConversations,
    0,
  );
  const returningTotal = points.reduce(
    (total, point) => total + (point.returningLeads ?? 0),
    0,
  );
  const difference = metaTotal - realTotal;
  const maximum = Math.max(
    1,
    ...points.flatMap((point) => [
      point.metaConversationsStarted,
      point.realConversations,
      point.returningLeads ?? 0,
    ]),
  );
  const viewWidth = Math.max(760, points.length * 54 + 92);
  const viewHeight = 286;
  const plotTop = 22;
  const plotBottom = 226;
  const plotHeight = plotBottom - plotTop;
  const plotLeft = 48;
  const plotRight = viewWidth - 24;
  const plotWidth = plotRight - plotLeft;
  const groupWidth = plotWidth / Math.max(points.length, 1);
  const barWidth = Math.min(13, Math.max(5, groupWidth * 0.22));
  const barGap = 2;
  const labelEvery = Math.max(1, Math.ceil(points.length / 10));
  const barHeight = (value: number) => (value / maximum) * plotHeight;
  const formatDate = (date: string) => {
    const [, month, day] = date.split("-");
    return `${day}/${month}`;
  };
  const differenceLabel =
    difference === 0
      ? "Volumes conciliados no periodo"
      : difference > 0
        ? `${difference} ${difference === 1 ? "conversa" : "conversas"} a mais na Meta`
        : `${Math.abs(difference)} ${Math.abs(difference) === 1 ? "lead novo" : "leads novos"} a mais`;

  return (
    <section
      className="surface-panel daily-comparison"
      aria-labelledby="daily-comparison-title"
    >
      <div className="daily-comparison-header">
        <div>
          <span className="eyebrow">Conciliacao diaria</span>
          <h2 id="daily-comparison-title">Meta x leads novos</h2>
          <p>
            A Meta conta cada conversa iniciada. Leads novos contam uma vez, no
            dia do primeiro contato; retornos são leads antigos que voltaram por
            anúncio naquele dia (quem volta em dois dias conta nos dois).
          </p>
        </div>
        <div
          className="daily-comparison-summary"
          aria-label="Resumo do comparativo"
        >
          <span>
            <PresentationMask placeholder="Conta de anuncios oculta">
              {scopeLabel}
            </PresentationMask>
          </span>
          <strong>{differenceLabel}</strong>
        </div>
      </div>

      {reportState === "error" ? (
        <div className="daily-comparison-empty" role="status">
          <strong>Comparativo indisponivel</strong>
          <span>A API precisa responder para montar a serie diaria.</span>
        </div>
      ) : !available ? (
        <div className="daily-comparison-empty" role="status">
          <strong>Sincronize este periodo para ver a comparacao diaria</strong>
          <span>
            A serie historica da Meta sera registrada na proxima sincronizacao.
          </span>
          <Link className="button ghost" href={detailHref}>
            Abrir relatorios
          </Link>
        </div>
      ) : (
        <>
          <div className="daily-comparison-legend" aria-label="Legenda">
            <span>
              <i className="meta" aria-hidden="true" />
              Conversas contadas pela Meta <strong>{metaTotal}</strong>
            </span>
            <span>
              <i className="real" aria-hidden="true" />
              Leads novos <strong>{realTotal}</strong>
            </span>
            <span title="Soma dos dias: quem volta em dois dias conta nos dois.">
              <i className="returning" aria-hidden="true" />
              Retornos (por dia) <strong>{returningTotal}</strong>
            </span>
          </div>
          <div className="daily-comparison-scroll">
            <svg
              className="daily-comparison-chart"
              viewBox={`0 0 ${viewWidth} ${viewHeight}`}
              style={{ minWidth: `${viewWidth}px` }}
              role="img"
              aria-label={`Comparacao diaria. Conversas contadas pela Meta ${metaTotal}, leads novos ${realTotal}, retornos ${returningTotal}.`}
            >
              <title>
                Conversas contadas pela Meta, leads novos e retornos por dia
              </title>
              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                const y = plotBottom - ratio * plotHeight;
                const value = Math.round(maximum * ratio);

                return (
                  <g key={ratio}>
                    <line x1={plotLeft} x2={plotRight} y1={y} y2={y} />
                    <text x={plotLeft - 10} y={y + 4} textAnchor="end">
                      {value}
                    </text>
                  </g>
                );
              })}
              {points.map((point, index) => {
                const center = plotLeft + groupWidth * index + groupWidth / 2;
                const metaHeight = barHeight(point.metaConversationsStarted);
                const realHeight = barHeight(point.realConversations);
                const returning = point.returningLeads ?? 0;
                const returningHeight = barHeight(returning);
                const groupStart = center - (barWidth * 3 + barGap * 2) / 2;
                const showLabel =
                  index % labelEvery === 0 || index === points.length - 1;

                return (
                  <g key={point.date}>
                    <rect
                      className="daily-bar meta"
                      x={groupStart}
                      y={plotBottom - metaHeight}
                      width={barWidth}
                      height={metaHeight}
                      rx="3"
                    >
                      <title>{`${formatDate(point.date)} - Conversas contadas pela Meta: ${point.metaConversationsStarted}`}</title>
                    </rect>
                    <rect
                      className="daily-bar real"
                      x={groupStart + barWidth + barGap}
                      y={plotBottom - realHeight}
                      width={barWidth}
                      height={realHeight}
                      rx="3"
                    >
                      <title>{`${formatDate(point.date)} - Leads novos: ${point.realConversations}`}</title>
                    </rect>
                    <rect
                      className="daily-bar returning"
                      x={groupStart + (barWidth + barGap) * 2}
                      y={plotBottom - returningHeight}
                      width={barWidth}
                      height={returningHeight}
                      rx="3"
                    >
                      <title>{`${formatDate(point.date)} - Retornos: ${returning}`}</title>
                    </rect>
                    {showLabel ? (
                      <text
                        className="daily-date-label"
                        x={center}
                        y={plotBottom + 26}
                        textAnchor="middle"
                      >
                        {formatDate(point.date)}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Implatec: comparativo por tipo de campanha (WhatsApp x Formulario), com o
 * funil de cada tipo somado a partir das linhas de campanha.
 */
function CampaignKindComparison({
  campaigns,
  fmt,
  mixedCurrency,
  rangeLabel,
  reportsHref,
}: {
  campaigns: CampaignReportRowDto[];
  fmt: (cents: number | null) => string;
  mixedCurrency: boolean;
  rangeLabel: string;
  reportsHref: string;
}) {
  const kinds: Array<{
    key: "whatsapp" | "lead_form";
    label: string;
    description: string;
  }> = [
    {
      key: "whatsapp",
      label: "Campanhas WhatsApp",
      description: "Clique para o WhatsApp (CTWA)",
    },
    {
      key: "lead_form",
      label: "Campanhas de Formulario",
      description: "Cadastros pelo formulario instantaneo (Lead Ads)",
    },
  ];
  const moneyLabel = (cents: number | null) =>
    mixedCurrency ? "Por moeda" : fmt(cents);
  const hrefFor = (kind: string) => {
    const [pathname, query] = reportsHref.split("?");
    const params = new URLSearchParams(query ?? "");
    params.set("campaignKind", kind);

    return `${pathname}?${params.toString()}`;
  };

  return (
    <section
      className="surface-panel overview-campaign-kinds"
      aria-label="Comparativo por tipo de campanha"
    >
      <div className="overview-section-heading">
        <div>
          <span className="eyebrow">Por tipo de campanha</span>
          <h2>WhatsApp x Formulario</h2>
          <p>
            {rangeLabel}: o mesmo funil, separado pelo tipo de campanha, para
            comparar o retorno de cada um.
          </p>
        </div>
      </div>
      <div className="overview-campaign-kind-grid">
        {kinds.map((kind) => {
          const rows = campaigns.filter(
            (campaign) => campaign.campaignKind === kind.key,
          );
          const total = sumCampaigns(rows);
          // WhatsApp começa nas conversas registradas pela Meta; formulário
          // não tem essa etapa (o cadastro já é o lead novo).
          const stages: ReportFunnelStepDto[] =
            kind.key === "whatsapp"
              ? [
                  {
                    key: "meta_conversations",
                    label: "Conversas Meta",
                    value: total.metaConversationsStarted,
                    costCents: total.costPerMetaConversationCents,
                  },
                  ...total.funnelSteps,
                ]
              : total.funnelSteps;

          return (
            <article
              className={`overview-campaign-kind overview-campaign-kind-${kind.key}`}
              key={kind.key}
            >
              <header>
                <span className="micro-label">{kind.label}</span>
                <p>{kind.description}</p>
                <span className="tag">
                  {rows.length} {rows.length === 1 ? "campanha" : "campanhas"}
                </span>
              </header>
              {rows.length === 0 ? (
                <p className="overview-campaign-kind-empty">
                  Nenhuma campanha deste tipo no periodo.
                </p>
              ) : (
                <>
                  <div className="metric-grid overview-campaign-kind-metrics">
                    <Metric
                      label="Investimento"
                      value={moneyLabel(total.spendCents)}
                      delta={rangeLabel}
                    />
                    <Metric
                      label="Leads novos"
                      value={String(total.realConversations)}
                      delta={
                        total.costPerRealConversationCents !== null
                          ? `Custo por lead ${moneyLabel(total.costPerRealConversationCents)}`
                          : "Sem leads no periodo"
                      }
                    />
                    <Metric
                      label="Compras"
                      value={String(total.purchases)}
                      delta={purchaseBreakdownLabel(
                        total.firstPurchases,
                        total.repurchases,
                      )}
                    />
                    <Metric
                      label="Receita trafego"
                      value={moneyLabel(total.trafficRevenueCents)}
                      delta={`ROAS ${ratioLabel(total.roasAcquisition)}`}
                    />
                  </div>
                  <ConversionFunnel
                    eyebrow={kind.label}
                    title="Conversao por etapas"
                    description={`${rangeLabel}: ${rows.length} ${rows.length === 1 ? "campanha" : "campanhas"}, ${total.realConversations} leads novos chegaram a ${total.firstPurchases} ${total.firstPurchases === 1 ? "primeira compra" : "primeiras compras"}.`}
                    stageCost={(stage) =>
                      stage.costCents != null ? moneyLabel(stage.costCents) : "-"
                    }
                    stages={stages}
                  />
                </>
              )}
              <Link className="text-link" href={hrefFor(kind.key)}>
                Ver campanhas deste tipo
              </Link>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  delta,
  href = null,
  hrefLabel,
  title,
  unavailable = false,
}: {
  label: string;
  value: string;
  delta: ReactNode;
  /** The exact list behind the number (Leads page), when one exists. */
  href?: string | null;
  hrefLabel?: string;
  /** Plain-language explanation shown on hover. */
  title?: string;
  unavailable?: boolean;
}) {
  return (
    <div
      className={`metric-card${unavailable ? " unavailable" : ""}`}
      title={title}
    >
      <span>{label}</span>
      <strong>
        {href ? (
          <Link
            className="kpi-number-link"
            href={href}
            aria-label={hrefLabel ? `${value} - ${hrefLabel}` : undefined}
          >
            {value}
          </Link>
        ) : (
          value
        )}
      </strong>
      <small>{delta}</small>
    </div>
  );
}

function ConversionFunnel({
  description,
  stageCost,
  stages,
  eyebrow = "Funil integrado",
  title = "Conversao por etapas",
}: {
  description: string;
  /** Custo da etapa já formatado, na moeda (ou moedas) do recorte. */
  stageCost: (stage: ReportFunnelStepDto) => string;
  stages: ReportFunnelStepDto[];
  /** Implatec: rótulo e título do bloco (o funil por tipo reaproveita). */
  eyebrow?: string;
  title?: string;
}) {
  const palette = [
    "var(--mint)",
    "var(--teal)",
    "var(--cyan)",
    "var(--blue)",
    "var(--amber)",
    "var(--coral)",
  ];
  const viewWidth = 1000;
  const viewHeight = 176;
  const centerY = viewHeight / 2;
  const maximumHalfHeight = centerY - 14;
  const minimumHalfHeight = 10;
  const firstValue = stages[0]?.value ?? 0;
  const visualBase = Math.max(firstValue, 1);
  const segmentWidth = viewWidth / Math.max(stages.length, 1);
  const halfHeight = (value: number) =>
    Math.max(
      minimumHalfHeight,
      Math.round(Math.min(value / visualBase, 1) * maximumHalfHeight),
    );
  const boundaries = stages.map((stage) => halfHeight(stage.value));
  const lastBoundary = boundaries[boundaries.length - 1] ?? minimumHalfHeight;
  boundaries.push(Math.max(6, Math.round(lastBoundary * 0.52)));
  const segmentPath = (index: number) => {
    const startX = index * segmentWidth;
    const endX = (index + 1) * segmentWidth;
    const middleX = startX + segmentWidth / 2;
    const leftHeight = boundaries[index] ?? minimumHalfHeight;
    const rightHeight = boundaries[index + 1] ?? minimumHalfHeight;

    return [
      `M ${startX} ${centerY - leftHeight}`,
      `C ${middleX} ${centerY - leftHeight} ${middleX} ${centerY - rightHeight} ${endX} ${centerY - rightHeight}`,
      `L ${endX} ${centerY + rightHeight}`,
      `C ${middleX} ${centerY + rightHeight} ${middleX} ${centerY + leftHeight} ${startX} ${centerY + leftHeight}`,
      "Z",
    ].join(" ");
  };
  const rateFromPrevious = (index: number) => {
    if (index === 0) {
      return null;
    }

    const previousValue = stages[index - 1]?.value ?? 0;
    return previousValue > 0
      ? Math.round(((stages[index]?.value ?? 0) / previousValue) * 100)
      : null;
  };
  const mobileWidth = (value: number) => {
    if (firstValue === 0 || value === 0) {
      return "0%";
    }

    return `${Math.max(18, Math.min(100, Math.round((value / firstValue) * 100)))}%`;
  };
  const funnelLabel = stages
    .map((stage) => `${stage.label}: ${stage.value}`)
    .join(", ");

  return (
    <section
      className="conversion-funnel"
      aria-label={`Funil de conversao. ${funnelLabel}`}
    >
      <div className="conversion-funnel-heading">
        <div>
          <span className="micro-label">{eyebrow}</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span className="conversion-funnel-stage-count">
          {stages.length} {stages.length === 1 ? "etapa" : "etapas"}
        </span>
      </div>

      <div
        className="conversion-funnel-stage-grid"
        style={{ "--funnel-stage-count": stages.length } as CSSProperties}
      >
        {stages.map((stage, index) => {
          const rate = rateFromPrevious(index);
          const color = palette[index % palette.length];

          return (
            <div
              className="conversion-funnel-stage"
              key={`${stage.key}-${index}`}
              style={{ "--funnel-stage-color": color } as CSSProperties}
            >
              <div className="conversion-funnel-stage-label">
                <span>{index + 1}</span>
                <strong>{stage.label}</strong>
              </div>
              <b>{stage.value}</b>
              <small>
                {index === 0
                  ? "Base do funil"
                  : rate === null
                    ? "Sem base anterior"
                    : `${rate}% da etapa anterior`}
              </small>
              <div className="conversion-funnel-stage-cost">
                <span>{funnelStageCostLabel(stage)}</span>
                <strong>{stageCost(stage)}</strong>
              </div>
            </div>
          );
        })}
      </div>

      <svg
        className="conversion-funnel-chart"
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={funnelLabel}
      >
        {stages.map((stage, index) => (
          <path
            d={segmentPath(index)}
            fill={palette[index % palette.length]}
            key={`${stage.key}-${index}`}
          />
        ))}
      </svg>

      <div className="conversion-funnel-mobile">
        {stages.map((stage, index) => {
          const rate = rateFromPrevious(index);
          const color = palette[index % palette.length];

          return (
            <div
              className="conversion-funnel-mobile-stage"
              key={`${stage.key}-${index}`}
            >
              <div className="conversion-funnel-mobile-main">
                <span
                  className="conversion-funnel-mobile-index"
                  style={{ backgroundColor: color }}
                >
                  {index + 1}
                </span>
                <strong>{stage.label}</strong>
                <b>{stage.value}</b>
              </div>
              <small>
                {index === 0
                  ? "Base do funil"
                  : rate === null
                    ? "Sem base anterior"
                    : `${rate}% da etapa anterior`}
              </small>
              <div className="conversion-funnel-mobile-cost">
                <span>{funnelStageCostLabel(stage)}</span>
                <strong>{stageCost(stage)}</strong>
              </div>
              <span
                className="conversion-funnel-mobile-band"
                style={
                  {
                    "--funnel-stage-color": color,
                    "--funnel-mobile-width": mobileWidth(stage.value),
                  } as CSSProperties
                }
                aria-hidden="true"
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
