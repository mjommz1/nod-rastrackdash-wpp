import { z } from "zod";

import { currencyCodeSchema, unconvertedRevenueSchema } from "../currency";
import { conversionEventLogStatusSchema } from "./conversion-events";

const moneyCentsSchema = z.number().int().nonnegative();
const nonnegativeIntSchema = z.number().int().nonnegative();
const nonnegativeRateSchema = z.number().nonnegative();
const reportDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const metaWhatsappClassificationSchema = z.enum([
  "auto_whatsapp",
  "creative_whatsapp",
  "detected_by_leads",
  "manual_include",
  "manual_exclude",
  "needs_review",
  "not_whatsapp",
]);

export const metaWhatsappOverrideInputSchema = z.object({
  level: z.enum(["campaign", "adset", "ad"]),
  id: z.string().trim().min(1),
  override: z.enum(["manual_include", "manual_exclude"]).nullable(),
});

export const metaEntityStatusUpdateInputSchema = z.object({
  level: z.enum(["campaign", "adset", "ad"]),
  id: z.string().trim().min(1),
  expectedStatus: z.enum(["ACTIVE", "PAUSED"]),
  targetStatus: z.enum(["ACTIVE", "PAUSED"]),
});

export const metaBudgetUpdateInputSchema = z.object({
  level: z.enum(["campaign", "adset"]),
  id: z.string().trim().min(1),
  budgetType: z.enum(["daily", "lifetime"]),
  expectedBudgetCents: moneyCentsSchema,
  budgetCents: z.number().int().positive().max(2_147_483_647),
});

export const metaEntityMutationResultSchema = z.object({
  ok: z.literal(true),
  level: z.enum(["campaign", "adset", "ad"]),
  id: z.string().min(1),
});

export const reportFunnelStepKeySchema = z.string().trim().min(1).max(120);

export const reportFunnelStepSchema = z.object({
  key: reportFunnelStepKeySchema,
  label: z.string().trim().min(1).max(80),
  value: nonnegativeIntSchema,
  costCents: moneyCentsSchema.nullable().optional(),
  unavailableReason: z.string().trim().min(1).optional(),
});

export const reportPaginationSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalItems: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});

const metaBudgetSnapshotSchema = z.object({
  owner: z.enum(["campaign", "adset"]),
  type: z.enum(["daily", "lifetime"]),
  amountCents: moneyCentsSchema,
  editable: z.boolean(),
});

export const campaignReportRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["active", "paused", "deleted", "unknown"]),
  businessId: z.string().min(1).nullable().optional(),
  businessName: z.string().min(1).nullable().optional(),
  adAccountId: z.string().min(1).nullable().optional(),
  adAccountName: z.string().min(1).nullable().optional(),
  /**
   * Moeda dos valores em dinheiro da linha: a moeda do gasto da conta de
   * anúncio (correção manual -> moeda da Meta -> BRL). A receita de vendas em
   * outra moeda vem convertida pela PTAX do dia da venda, quando há cotação.
   */
  currency: currencyCodeSchema.optional(),
  /** true quando alguma venda da linha ficou sem cotação (fora da receita). */
  exchangeRateMissing: z.boolean().optional(),
  /** Receita fora da linha por falta de cotação, na moeda original. */
  unconvertedRevenue: z.array(unconvertedRevenueSchema).optional(),
  whatsappClassification: metaWhatsappClassificationSchema.optional(),
  configuredStatus: z.string().min(1).nullable().optional(),
  effectiveStatus: z.string().min(1).nullable().optional(),
  budget: metaBudgetSnapshotSchema.nullable().optional(),
  spendCents: moneyCentsSchema,
  metaConversationsStarted: nonnegativeIntSchema,
  costPerMetaConversationCents: moneyCentsSchema.nullable(),
  /**
   * Leads novos (paid): people whose FIRST contact ever falls in the period,
   * counted once, attributed to the ad of that first contact. CPL and the
   * LeadSubmitted funnel stage use this number.
   */
  realConversations: nonnegativeIntSchema,
  costPerRealConversationCents: moneyCentsSchema.nullable(),
  /**
   * People whose first contact was before the period and who started a new
   * paid conversation in it ("voltaram por anuncio"). Never part of CPL.
   */
  returningLeads: nonnegativeIntSchema.optional(),
  /** Paid LeadSubmitted events in the period (one per CTWA conversation sent to Meta). */
  adConversationEvents: nonnegativeIntSchema.optional(),
  /**
   * People with two or more paid conversations (LeadSubmitted) in the period,
   * leads novos included ("conversaram mais de uma vez"). Never part of CPL.
   */
  repeatConversationLeads: nonnegativeIntSchema.optional(),
  organicLeads: nonnegativeIntSchema,
  totalReceived: nonnegativeIntSchema,
  trackingRate: nonnegativeRateSchema.nullable(),
  qualifiedLead: nonnegativeIntSchema,
  costPerQualifiedLeadCents: moneyCentsSchema.nullable(),
  purchases: nonnegativeIntSchema,
  firstPurchases: nonnegativeIntSchema,
  repurchases: nonnegativeIntSchema,
  costPerPurchaseCents: moneyCentsSchema.nullable(),
  trafficRevenueCents: moneyCentsSchema,
  organicRevenueCents: moneyCentsSchema,
  totalRevenueCents: moneyCentsSchema,
  firstPurchaseRevenueCents: moneyCentsSchema,
  repurchaseRevenueCents: moneyCentsSchema,
  estimatedRevenueCents: moneyCentsSchema.default(0),
  hasEstimatedRevenue: z.boolean().default(false),
  roasAcquisition: nonnegativeRateSchema.nullable(),
  roasWithRepurchase: nonnegativeRateSchema.nullable(),
  funnelSteps: z.array(reportFunnelStepSchema),
});

export const reportTotalsSchema = campaignReportRowSchema.omit({
  id: true,
  name: true,
  status: true,
  businessId: true,
  businessName: true,
  adAccountId: true,
  adAccountName: true,
  whatsappClassification: true,
  configuredStatus: true,
  effectiveStatus: true,
  budget: true,
});

/**
 * Totais de UMA moeda (moedas diferentes nunca são somadas): mesmo formato de
 * `totals`, com a moeda obrigatória. Gasto e custos (CPL, custo por conversa,
 * custo por compra) estão na moeda das contas do grupo; a receita atribuída a
 * anúncios foi convertida para ela pela PTAX do dia da venda; receita sem
 * anúncio entra no grupo da própria moeda.
 */
export const reportCurrencyGroupSchema = reportTotalsSchema.extend({
  currency: currencyCodeSchema,
  /** Contas de anúncio (ids da Meta) cujo gasto está neste grupo. */
  adAccountIds: z.array(z.string().min(1)),
  /** true quando alguma venda do grupo ficou sem cotação. */
  exchangeRateMissing: z.boolean(),
  /** Receita fora do grupo por falta de cotação, na moeda original. */
  unconvertedRevenue: z.array(unconvertedRevenueSchema),
});

/**
 * Moeda nas respostas de relatório:
 * - `currency`: moeda única de todos os valores (linhas, `totals`, `summary`),
 *   ou null quando o período teve movimento em mais de uma moeda.
 * - `byCurrency`: só quando `currency` é null; um grupo por moeda com gasto
 *   ou receita no período, nunca um grupo zerado. Com `currency` null, os
 *   valores em dinheiro de `totals`/`summary` misturam moedas: use os grupos.
 * - `exchangeRateMissing` e `unconvertedRevenue`: só quando alguma venda
 *   ficou sem cotação (PTAX desligada, BCB fora ou dia sem boletim).
 * Workspace todo em BRL recebe só `currency: "BRL"`; o resto não muda.
 */
const reportCurrencyFields = {
  currency: currencyCodeSchema.nullable().optional(),
  byCurrency: z.array(reportCurrencyGroupSchema).optional(),
  exchangeRateMissing: z.boolean().optional(),
  unconvertedRevenue: z.array(unconvertedRevenueSchema).optional(),
};

export const reportDailyComparisonPointSchema = z.object({
  date: reportDateSchema,
  metaConversationsStarted: nonnegativeIntSchema,
  /** Leads novos whose first contact was on this day. */
  realConversations: nonnegativeIntSchema,
  /** Leads antigos que voltaram por anuncio neste dia. */
  returningLeads: nonnegativeIntSchema.optional(),
});

export const reportOverviewSchema = z.object({
  workspaceId: z.string().min(1),
  rangeLabel: z.string().min(1),
  since: reportDateSchema.nullable().optional(),
  until: reportDateSchema.nullable().optional(),
  campaigns: z.array(campaignReportRowSchema),
  summary: campaignReportRowSchema.optional(),
  totals: reportTotalsSchema.optional(),
  ...reportCurrencyFields,
  /** Igual a `byCurrency`, para `summary` (Visão Geral, includeSummary). */
  summaryByCurrency: z.array(reportCurrencyGroupSchema).optional(),
  dailyComparison: z.array(reportDailyComparisonPointSchema).optional(),
  dailyComparisonAvailable: z.boolean().optional(),
  pagination: reportPaginationSchema.optional(),
});

const reportMetricShape = campaignReportRowSchema.omit({
  id: true,
  name: true,
  configuredStatus: true,
  effectiveStatus: true,
  budget: true,
}).shape;

export const adSetReportRowSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  campaignName: z.string().min(1),
  name: z.string().min(1),
  configuredStatus: z.string().min(1).nullable().optional(),
  effectiveStatus: z.string().min(1).nullable().optional(),
  budget: metaBudgetSnapshotSchema.nullable().optional(),
  ...reportMetricShape,
});

export const adSetReportOverviewSchema = z.object({
  workspaceId: z.string().min(1),
  rangeLabel: z.string().min(1),
  since: reportDateSchema.nullable().optional(),
  until: reportDateSchema.nullable().optional(),
  adSets: z.array(adSetReportRowSchema),
  totals: reportTotalsSchema.optional(),
  ...reportCurrencyFields,
  pagination: reportPaginationSchema.optional(),
});

export const adReportRowSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  campaignName: z.string().min(1),
  adSetId: z.string().min(1),
  adSetName: z.string().min(1),
  name: z.string().min(1),
  configuredStatus: z.string().min(1).nullable().optional(),
  effectiveStatus: z.string().min(1).nullable().optional(),
  thumbnailUrl: z.string().url().nullable().optional(),
  previewUrl: z.string().url().nullable().optional(),
  ...reportMetricShape,
});

export const adReportOverviewSchema = z.object({
  workspaceId: z.string().min(1),
  rangeLabel: z.string().min(1),
  since: reportDateSchema.nullable().optional(),
  until: reportDateSchema.nullable().optional(),
  ads: z.array(adReportRowSchema),
  totals: reportTotalsSchema.optional(),
  ...reportCurrencyFields,
  pagination: reportPaginationSchema.optional(),
});

export const metaAdReportSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string().min(1).nullable(),
  effectiveStatus: z.string().min(1).nullable(),
});

export const metaAdSetReportSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string().min(1).nullable(),
  effectiveStatus: z.string().min(1).nullable(),
  ads: z.array(metaAdReportSchema),
});

export const metaCampaignStructureSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string().min(1).nullable(),
  effectiveStatus: z.string().min(1).nullable(),
  objective: z.string().min(1).nullable(),
  adSets: z.array(metaAdSetReportSchema),
});

export const metaStructureReportSchema = z.object({
  workspaceId: z.string().min(1),
  campaigns: z.array(metaCampaignStructureSchema),
});

export const conversionAuditDeliveryStateSchema = z.enum([
  "sent",
  "queued",
  "blocked",
  "failed",
  "not_eligible",
  "shadow",
  "historical",
  "discarded",
]);

export const conversionAuditSourceSchema = z.enum([
  "external_integration",
  "whatsapp_automation",
  "system",
  "manual_test",
  "other",
]);

export const conversionAuditEventSchema = z.object({
  id: z.string().min(1),
  eventName: z.string().min(1),
  eventLabel: z.string().min(1),
  deliveryState: conversionAuditDeliveryStateSchema,
  statusLabel: z.string().min(1),
  statusDetail: z.string().min(1),
  source: conversionAuditSourceSchema,
  sourceLabel: z.string().min(1),
  leadId: z.string().min(1).nullable(),
  leadName: z.string().min(1).nullable(),
  phoneDisplay: z.string().min(1).nullable(),
  campaignId: z.string().min(1).nullable(),
  campaignName: z.string().min(1).nullable(),
  adSetId: z.string().min(1).nullable(),
  adSetName: z.string().min(1).nullable(),
  adId: z.string().min(1).nullable(),
  adName: z.string().min(1).nullable(),
  pixelId: z.string().min(1).nullable(),
  pageId: z.string().min(1).nullable(),
  occurredAt: z.string().min(1),
  sentAt: z.string().min(1).nullable(),
  status: conversionEventLogStatusSchema,
  canRetry: z.boolean().default(false),
  providerResponseSummary: z.string().min(1).nullable(),
  errorCode: z.string().min(1).nullable(),
  errorMessage: z.string().min(1).nullable(),
  valueSource: z
    .enum(["actual", "configured_average", "manual"])
    .nullable()
    .default(null),
});

export const conversionAuditPayloadModeSchema = z.enum([
  "stored",
  "stored_normalized",
  "historical_summary",
  "reconstructed",
  "unavailable",
]);

export const conversionAuditPayloadSnapshotSchema = z.object({
  mode: conversionAuditPayloadModeSchema,
  label: z.string().min(1),
  payload: z.record(z.unknown()).nullable(),
});

export const conversionAuditEventDetailSchema =
  conversionAuditEventSchema.extend({
    reasonCode: z.string().min(1).nullable(),
    reason: z.string().min(1).nullable(),
    missingFields: z.array(z.string().min(1)),
    sourceSnapshot: conversionAuditPayloadSnapshotSchema,
    metaRequest: conversionAuditPayloadSnapshotSchema,
    metaResponse: conversionAuditPayloadSnapshotSchema,
  });

export const conversionAuditSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  notEligible: z.number().int().nonnegative(),
  shadowObserved: z.number().int().nonnegative(),
  historical: z.number().int().nonnegative(),
  discarded: z.number().int().nonnegative(),
});

export const conversionAuditOverviewSchema = z.object({
  workspaceId: z.string().min(1),
  rangeLabel: z.string().min(1),
  summary: conversionAuditSummarySchema,
  pagination: reportPaginationSchema,
  events: z.array(conversionAuditEventSchema),
});

// Server-side report ordering is limited to existing canonical row metrics.
// CPL is costPerRealConversationCents; CPM is not exposed by report rows.
export const reportSortKeySchema = z.enum([
  "realConversations",
  "qualifiedLead",
  "purchases",
  "costPerRealConversationCents",
  "costPerQualifiedLeadCents",
  "costPerPurchaseCents",
]);

export const reportSortDirectionSchema = z.enum(["desc", "asc"]);

export const reportSortSchema = z
  .object({
    key: reportSortKeySchema,
    direction: reportSortDirectionSchema.default("desc"),
  })
  .strict();

export const reportFiltersSchema = z.object({
  businessId: z.string().min(1).optional(),
  adAccountId: z.string().min(1).optional(),
  /** Várias contas de anúncio (query `adAccountIds=a,b` ou repetida). */
  adAccountIds: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  delivery: z.enum(["all", "had_delivery"]).default("all"),
  selectedEntityIds: z
    .array(z.string().trim().min(1).max(200))
    .max(200)
    .optional(),
  nameScope: z.enum(["campaign", "adset", "ad"]).default("campaign"),
  nameContains: z.string().trim().min(1).optional(),
  status: z.enum(["all", "active", "paused"]).default("all"),
  whatsappClassification: z
    .enum(["whatsapp", "needs_review", "excluded", "all"])
    .default("whatsapp"),
});

export type CampaignReportRowDto = z.infer<typeof campaignReportRowSchema>;
export type ReportTotalsDto = z.infer<typeof reportTotalsSchema>;
export type ReportCurrencyGroupDto = z.infer<typeof reportCurrencyGroupSchema>;
export type ReportDailyComparisonPointDto = z.infer<
  typeof reportDailyComparisonPointSchema
>;
export type ReportOverviewDto = z.infer<typeof reportOverviewSchema>;
export type AdSetReportRowDto = z.infer<typeof adSetReportRowSchema>;
export type AdSetReportOverviewDto = z.infer<typeof adSetReportOverviewSchema>;
export type AdReportRowDto = z.infer<typeof adReportRowSchema>;
export type AdReportOverviewDto = z.infer<typeof adReportOverviewSchema>;
export type MetaAdReportDto = z.infer<typeof metaAdReportSchema>;
export type MetaAdSetReportDto = z.infer<typeof metaAdSetReportSchema>;
export type MetaCampaignStructureDto = z.infer<
  typeof metaCampaignStructureSchema
>;
export type MetaStructureReportDto = z.infer<typeof metaStructureReportSchema>;
export type ReportFunnelStepKeyDto = z.infer<typeof reportFunnelStepKeySchema>;
export type ReportFunnelStepDto = z.infer<typeof reportFunnelStepSchema>;
export type ReportPaginationDto = z.infer<typeof reportPaginationSchema>;
export type ConversionAuditEventDto = z.infer<
  typeof conversionAuditEventSchema
>;
export type ConversionAuditEventDetailDto = z.infer<
  typeof conversionAuditEventDetailSchema
>;
export type ConversionAuditPayloadModeDto = z.infer<
  typeof conversionAuditPayloadModeSchema
>;
export type ConversionAuditPayloadSnapshotDto = z.infer<
  typeof conversionAuditPayloadSnapshotSchema
>;
export type ConversionAuditOverviewDto = z.infer<
  typeof conversionAuditOverviewSchema
>;
export type ConversionAuditDeliveryStateDto = z.infer<
  typeof conversionAuditDeliveryStateSchema
>;
export type ConversionAuditSourceDto = z.infer<
  typeof conversionAuditSourceSchema
>;
export type MetaWhatsappClassificationDto = z.infer<
  typeof metaWhatsappClassificationSchema
>;
export type MetaEntityStatusUpdateInputDto = z.infer<
  typeof metaEntityStatusUpdateInputSchema
>;
export type MetaBudgetUpdateInputDto = z.infer<
  typeof metaBudgetUpdateInputSchema
>;
export type MetaEntityMutationResultDto = z.infer<
  typeof metaEntityMutationResultSchema
>;
export type MetaWhatsappOverrideInputDto = z.infer<
  typeof metaWhatsappOverrideInputSchema
>;
export type ReportFiltersDto = z.infer<typeof reportFiltersSchema>;
export type ReportSortKeyDto = z.infer<typeof reportSortKeySchema>;
export type ReportSortDirectionDto = z.infer<typeof reportSortDirectionSchema>;
export type ReportSortDto = z.infer<typeof reportSortSchema>;
