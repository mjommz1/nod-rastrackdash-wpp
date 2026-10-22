export const funnelMetricKeys = [
  "real_conversations",
  "qualified_lead",
  "purchase",
  "first_purchase",
  "repurchase"
] as const;

export type FunnelMetricKey = (typeof funnelMetricKeys)[number];

export const funnelMetricLabels: Record<FunnelMetricKey, string> = {
  real_conversations: "Leads novos",
  qualified_lead: "Lead qualificado",
  purchase: "Compras",
  first_purchase: "Primeira compra",
  repurchase: "Recompra"
};

export type MoneyCents = number;

export interface ReportMetric {
  key: FunnelMetricKey;
  label: string;
  value: number;
  costCents?: MoneyCents | null;
  unavailableReason?: string;
}

export interface CampaignReportRow {
  id: string;
  name: string;
  status: "active" | "paused" | "deleted" | "unknown";
  spendCents: MoneyCents;
  metaConversationsStarted: number;
  costPerMetaConversationCents: MoneyCents | null;
  realConversations: number;
  costPerRealConversationCents: MoneyCents | null;
  organicLeads: number;
  totalReceived: number;
  trackingRate: number | null;
  qualifiedLead: number;
  costPerQualifiedLeadCents: MoneyCents | null;
  purchases: number;
  firstPurchases: number;
  repurchases: number;
  costPerPurchaseCents: MoneyCents | null;
  trafficRevenueCents: MoneyCents;
  organicRevenueCents: MoneyCents;
  totalRevenueCents: MoneyCents;
  firstPurchaseRevenueCents: MoneyCents;
  repurchaseRevenueCents: MoneyCents;
  roasAcquisition: number | null;
  roasWithRepurchase: number | null;
  funnelSteps: ReportMetric[];
}
