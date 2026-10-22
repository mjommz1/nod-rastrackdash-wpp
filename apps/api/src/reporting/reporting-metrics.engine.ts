import type { FunnelStageConfigurationDto } from "@wpptrack/shared";
import { repeatConversationLeadIds } from "../leads/lead-cohort";

export type ReportingMetricScope = {
  adId?: string | null;
  adSetId?: string | null;
  campaignId?: string | null;
};

export type ReportingInsightInput = {
  spendCents: number;
  metaConversationsStarted: number | null;
};

export type ReportingMetricLead = {
  id: string;
  phoneHash: string | null;
  customerIdentityKey?: string | null;
  businessSource?: string | null;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  ctwaClid?: string | null;
  firstMessageAt: Date | null;
  createdAt?: Date;
};

export type ReportingMetricEvent = {
  id: string;
  /** Lead the event belongs to (resolved by phone hash when missing). */
  leadId?: string | null;
  phoneHash: string | null;
  customerIdentityKey?: string | null;
  businessSource?: string | null;
  campaignId: string | null;
  adSetId: string | null;
  adId: string | null;
  ctwaClid?: string | null;
  eventName: string;
  eventOccurredAt: Date;
  status: string;
  valueCents: number | null;
  valueSource?: string | null;
  currency: string | null;
  purchaseKind?: string | null;
};

export type ReportingMetricsCalculationInput = {
  configuredEvents?: Set<string>;
  funnelStages?: FunnelStageConfigurationDto[];
  events: ReportingMetricEvent[];
  insight: ReportingInsightInput;
  /**
   * Leads whose FIRST contact falls in the period (leads novos), with the
   * attribution of that first contact. They alone make realConversations/CPL.
   */
  leads: ReportingMetricLead[];
  /**
   * Paid LeadSubmitted events in the period from people whose first contact
   * was before it (leads que voltaram), each with `leadId`. Counted apart and
   * never added to realConversations, CPL or the funnel.
   */
  returningEvents?: ReportingMetricEvent[];
  /**
   * Every lead of each phone whose conversations carry no lead id, loaded by
   * the caller from the database (same source as the Leads page). Without it
   * the leads and events given are used.
   */
  leadIdsByPhoneHash?: ReadonlyMap<string, readonly string[]>;
  scope: ReportingMetricScope;
};

type FunnelStepKey = string;

type ReportingFunnelStep = {
  key: FunnelStepKey;
  label: string;
  value: number;
  costCents?: number | null;
  unavailableReason?: string;
};

export type ReportingMetricsResult = {
  spendCents: number;
  metaConversationsStarted: number;
  costPerMetaConversationCents: number | null;
  realConversations: number;
  costPerRealConversationCents: number | null;
  returningLeads: number;
  adConversationEvents: number;
  /**
   * People with two or more paid conversations (LeadSubmitted sent to Meta) in
   * the period, leads novos included. Informational: never part of CPL.
   */
  repeatConversationLeads: number;
  organicLeads: number;
  totalReceived: number;
  trackingRate: number | null;
  qualifiedLead: number;
  costPerQualifiedLeadCents: number | null;
  purchases: number;
  firstPurchases: number;
  repurchases: number;
  costPerPurchaseCents: number | null;
  trafficRevenueCents: number;
  organicRevenueCents: number;
  totalRevenueCents: number;
  firstPurchaseRevenueCents: number;
  repurchaseRevenueCents: number;
  estimatedRevenueCents: number;
  hasEstimatedRevenue: boolean;
  roasAcquisition: number | null;
  roasWithRepurchase: number | null;
  funnelSteps: ReportingFunnelStep[];
};

type ClassifiedPurchase = {
  event: ReportingMetricEvent;
  kind: "first_purchase" | "repurchase";
  source: "paid" | "organic";
};

const funnelLabels: Record<FunnelStepKey, string> = {
  first_purchase: "Primeira compra",
  purchase: "Compras",
  qualified_lead: "Lead qualificado",
  real_conversations: "Leads novos",
  repurchase: "Recompra",
};

const legacyLeadSubmittedLabels = new Set([
  "conversas reais iniciadas",
  "conversas reais",
]);

export class ReportingMetricsEngine {
  calculate(input: ReportingMetricsCalculationInput): ReportingMetricsResult {
    const scopedLeads = input.leads.filter((lead) =>
      this.matchesScope(lead, input.scope),
    );
    const scopedEvents = input.events.filter((event) =>
      this.matchesScope(event, input.scope),
    );
    const countableEvents = scopedEvents.filter((event) =>
      this.isCountableEvent(event),
    );
    const spendCents = input.insight.spendCents;
    const metaConversationsStarted =
      input.insight.metaConversationsStarted ?? 0;
    const scopedReturningEvents = (input.returningEvents ?? []).filter(
      (event) =>
        this.matchesScope(event, input.scope) && this.isCountableEvent(event),
    );
    const realConversationIds = this.realConversationIds(scopedLeads);
    const organicLeadIds = this.organicLeadIds(scopedLeads);
    const realConversations = realConversationIds.size;
    const returningLeads = this.returningLeadIds(scopedReturningEvents).size;
    const paidConversationEvents = [
      ...countableEvents,
      ...scopedReturningEvents,
    ];
    const adConversationEvents = this.adConversationEventCount(
      paidConversationEvents,
    );
    const repeatConversationLeads = this.repeatConversationLeadCount(
      paidConversationEvents,
      input.leadIdsByPhoneHash ??
        this.leadIdsByPhoneHash([
          ...input.leads.map((lead) => ({
            leadId: lead.id,
            phoneHash: lead.phoneHash,
          })),
          ...paidConversationEvents,
        ]),
    );
    const organicLeads = organicLeadIds.size;
    const totalReceived = realConversations + organicLeads;
    const qualifiedLead = countableEvents.filter(
      (event) => event.eventName === "QualifiedLead",
    ).length;
    const purchases = this.classifyPurchases(countableEvents);
    const firstPurchases = purchases.filter(
      (purchase) => purchase.kind === "first_purchase",
    ).length;
    const repurchases = purchases.filter(
      (purchase) => purchase.kind === "repurchase",
    ).length;
    const trafficPurchases = purchases.filter(
      (purchase) => purchase.source === "paid",
    );
    const organicPurchases = purchases.filter(
      (purchase) => purchase.source === "organic",
    );
    const trafficRevenueCents = this.sumPurchaseValue(trafficPurchases);
    const organicRevenueCents = this.sumPurchaseValue(organicPurchases);
    const firstPurchaseRevenueCents = this.sumPurchaseValue(
      purchases.filter((purchase) => purchase.kind === "first_purchase"),
    );
    const repurchaseRevenueCents = this.sumPurchaseValue(
      purchases.filter((purchase) => purchase.kind === "repurchase"),
    );
    const trafficFirstPurchaseRevenueCents = this.sumPurchaseValue(
      trafficPurchases.filter((purchase) => purchase.kind === "first_purchase"),
    );
    const trafficRepurchaseRevenueCents = this.sumPurchaseValue(
      trafficPurchases.filter((purchase) => purchase.kind === "repurchase"),
    );
    const estimatedRevenueCents = this.sumPurchaseValue(
      purchases.filter(
        (purchase) => purchase.event.valueSource === "configured_average",
      ),
    );

    return {
      spendCents,
      metaConversationsStarted,
      costPerMetaConversationCents: this.costPer(
        spendCents,
        metaConversationsStarted,
      ),
      realConversations,
      costPerRealConversationCents: this.costPer(spendCents, realConversations),
      returningLeads,
      adConversationEvents,
      repeatConversationLeads,
      organicLeads,
      totalReceived,
      trackingRate:
        totalReceived > 0 ? realConversations / totalReceived : null,
      qualifiedLead,
      costPerQualifiedLeadCents: this.costPer(spendCents, qualifiedLead),
      purchases: purchases.length,
      firstPurchases,
      repurchases,
      costPerPurchaseCents: this.costPer(spendCents, purchases.length),
      trafficRevenueCents,
      organicRevenueCents,
      totalRevenueCents: trafficRevenueCents + organicRevenueCents,
      firstPurchaseRevenueCents,
      repurchaseRevenueCents,
      estimatedRevenueCents,
      hasEstimatedRevenue: estimatedRevenueCents > 0,
      roasAcquisition: this.roas(trafficFirstPurchaseRevenueCents, spendCents),
      roasWithRepurchase: this.roas(
        trafficFirstPurchaseRevenueCents + trafficRepurchaseRevenueCents,
        spendCents,
      ),
      funnelSteps: this.funnelSteps({
        configuredEvents: input.configuredEvents ?? new Set(),
        funnelStages: input.funnelStages,
        countableEvents,
        firstPurchases,
        purchases: purchases.length,
        qualifiedLead,
        realConversations,
        repurchaseRevenueCents,
        repurchases,
        spendCents,
        firstPurchaseRevenueCents,
      }),
    };
  }

  /**
   * Leads novos per day: each paid lead once, on the day of its first contact.
   * Later conversations of the same person never add to any day.
   */
  dailyRealConversationCounts(
    input: Pick<ReportingMetricsCalculationInput, "leads">,
    dateKey: (date: Date) => string,
  ): Map<string, number> {
    const firstDayByIdentity = new Map<string, string>();

    for (const lead of input.leads) {
      const firstContactAt = lead.firstMessageAt ?? lead.createdAt;

      if (!firstContactAt || !this.isPaidRealConversation(lead)) {
        continue;
      }

      const identity = this.identityKey(lead, `lead:${lead.id}`);
      const day = dateKey(firstContactAt);
      const current = firstDayByIdentity.get(identity);

      if (!current || day < current) {
        firstDayByIdentity.set(identity, day);
      }
    }

    return this.countByDay(firstDayByIdentity.values());
  }

  /** Leads que voltaram per day: each person once per day they came back. */
  dailyReturningLeadCounts(
    input: Pick<ReportingMetricsCalculationInput, "returningEvents">,
    dateKey: (date: Date) => string,
  ): Map<string, number> {
    const seen = new Set<string>();
    const days: string[] = [];

    for (const event of input.returningEvents ?? []) {
      if (!this.isPaidConversation(event)) {
        continue;
      }

      const day = dateKey(event.eventOccurredAt);
      const key = `${day}|${this.returningIdentity(event)}`;

      if (!seen.has(key)) {
        seen.add(key);
        days.push(day);
      }
    }

    return this.countByDay(days);
  }

  private countByDay(days: Iterable<string>): Map<string, number> {
    const counts = new Map<string, number>();

    for (const day of days) {
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }

    return counts;
  }

  /** Leads novos de anuncio: only lead rows, never conversation events. */
  private realConversationIds(leads: ReportingMetricLead[]): Set<string> {
    const ids = new Set<string>();

    for (const lead of leads) {
      if (this.isPaidRealConversation(lead)) {
        ids.add(this.identityKey(lead, `lead:${lead.id}`));
      }
    }

    return ids;
  }

  private organicLeadIds(leads: ReportingMetricLead[]): Set<string> {
    const ids = new Set<string>();

    for (const lead of leads) {
      if (this.isOrganic(lead)) {
        ids.add(this.identityKey(lead, `lead:${lead.id}`));
      }
    }

    return ids;
  }

  private returningLeadIds(events: ReportingMetricEvent[]): Set<string> {
    const ids = new Set<string>();

    for (const event of events) {
      if (this.isPaidConversation(event)) {
        ids.add(this.returningIdentity(event));
      }
    }

    return ids;
  }

  /** A paid conversation: LeadSubmitted sent to Meta (not skipped, not organic). */
  private isPaidConversation(event: ReportingMetricEvent): boolean {
    return (
      event.eventName === "LeadSubmitted" &&
      this.isCountableEvent(event) &&
      this.isPaidLeadEvent(event)
    );
  }

  private returningIdentity(event: ReportingMetricEvent): string {
    return event.leadId
      ? `lead:${event.leadId}`
      : this.identityKey(event, `event:${event.id}`);
  }

  /** Paid LeadSubmitted events (one per CTWA conversation sent to Meta). */
  private adConversationEventCount(events: ReportingMetricEvent[]): number {
    const ids = new Set<string>();

    for (const event of events) {
      if (this.isPaidConversation(event)) {
        ids.add(event.id);
      }
    }

    return ids.size;
  }

  /**
   * Distinct people (lead rows) with at least two paid conversations in the
   * events given (the period's), whether they are leads novos or came back.
   * Same shared rule as the Leads page: a conversation without a lead id
   * counts for every lead of its phone; one with no lead is not a person.
   */
  private repeatConversationLeadCount(
    events: ReportingMetricEvent[],
    leadIdsByPhoneHash: ReadonlyMap<string, readonly string[]>,
  ): number {
    const counted = new Set<string>();
    const conversations = events.filter((event) => {
      if (!this.isPaidConversation(event) || counted.has(event.id)) {
        return false;
      }

      counted.add(event.id);
      return true;
    });

    return repeatConversationLeadIds(conversations, leadIdsByPhoneHash).length;
  }

  /** Fallback phone -> leads map from the leads and events at hand. */
  private leadIdsByPhoneHash(
    items: Array<{ leadId?: string | null; phoneHash: string | null }>,
  ): Map<string, string[]> {
    const map = new Map<string, string[]>();

    for (const item of items) {
      if (!item.leadId || !item.phoneHash) {
        continue;
      }

      const ids = map.get(item.phoneHash) ?? [];

      if (!ids.includes(item.leadId)) {
        ids.push(item.leadId);
      }

      map.set(item.phoneHash, ids);
    }

    return map;
  }

  private classifyPurchases(
    events: ReportingMetricEvent[],
  ): ClassifiedPurchase[] {
    const purchases = events
      .filter((event) => event.eventName === "Purchase")
      .sort((a, b) => {
        const timeDelta =
          a.eventOccurredAt.getTime() - b.eventOccurredAt.getTime();

        return timeDelta === 0 ? a.id.localeCompare(b.id) : timeDelta;
      });
    const seenIdentity = new Set<string>();

    return purchases.map((event) => {
      const explicitKind = this.explicitPurchaseKind(event.purchaseKind);
      const identity = this.optionalIdentityKey(event);
      const kind =
        explicitKind ??
        (identity && seenIdentity.has(identity)
          ? "repurchase"
          : "first_purchase");

      if (identity) {
        seenIdentity.add(identity);
      }

      return {
        event,
        kind,
        source: this.isOrganic(event) ? "organic" : "paid",
      };
    });
  }

  private funnelSteps(input: {
    configuredEvents: Set<string>;
    funnelStages?: FunnelStageConfigurationDto[];
    countableEvents: ReportingMetricEvent[];
    firstPurchaseRevenueCents: number;
    firstPurchases: number;
    purchases: number;
    qualifiedLead: number;
    realConversations: number;
    repurchaseRevenueCents: number;
    repurchases: number;
    spendCents: number;
  }): ReportingFunnelStep[] {
    if (input.funnelStages) {
      return input.funnelStages
        .filter((stage) => stage.visible)
        .sort((left, right) => left.position - right.position)
        .flatMap((stage) => {
          const value = this.funnelStageValue(stage.eventName, input);
          const steps = [
            this.step(
              this.funnelStageKey(stage.eventName),
              this.funnelStageLabel(stage),
              value,
              this.costPer(input.spendCents, value),
            ),
          ];

          if (stage.eventName === "Purchase") {
            if (
              input.firstPurchases > 0 ||
              input.firstPurchaseRevenueCents > 0
            ) {
              steps.push(
                this.step(
                  "first_purchase",
                  funnelLabels.first_purchase,
                  input.firstPurchases,
                  this.costPer(input.spendCents, input.firstPurchases),
                ),
              );
            }

            if (input.repurchases > 0 || input.repurchaseRevenueCents > 0) {
              steps.push(
                this.step(
                  "repurchase",
                  funnelLabels.repurchase,
                  input.repurchases,
                  this.costPer(input.spendCents, input.repurchases),
                ),
              );
            }
          }

          return steps;
        });
    }

    const steps: ReportingFunnelStep[] = [
      this.step(
        "real_conversations",
        funnelLabels.real_conversations,
        input.realConversations,
        this.costPer(input.spendCents, input.realConversations),
      ),
    ];
    const hasQualifiedLead =
      input.configuredEvents.has("QualifiedLead") ||
      input.countableEvents.some(
        (event) => event.eventName === "QualifiedLead",
      );
    const hasPurchase =
      input.configuredEvents.has("Purchase") ||
      input.countableEvents.some((event) => event.eventName === "Purchase");

    if (hasQualifiedLead) {
      steps.push(
        this.step(
          "qualified_lead",
          funnelLabels.qualified_lead,
          input.qualifiedLead,
          this.costPer(input.spendCents, input.qualifiedLead),
        ),
      );
    }

    if (hasPurchase) {
      steps.push(
        this.step(
          "purchase",
          funnelLabels.purchase,
          input.purchases,
          this.costPer(input.spendCents, input.purchases),
        ),
      );

      if (input.firstPurchases > 0 || input.firstPurchaseRevenueCents > 0) {
        steps.push(
          this.step(
            "first_purchase",
            funnelLabels.first_purchase,
            input.firstPurchases,
            this.costPer(input.spendCents, input.firstPurchases),
          ),
        );
      }

      if (input.repurchases > 0 || input.repurchaseRevenueCents > 0) {
        steps.push(
          this.step(
            "repurchase",
            funnelLabels.repurchase,
            input.repurchases,
            this.costPer(input.spendCents, input.repurchases),
          ),
        );
      }
    }

    return steps;
  }

  private step(
    key: FunnelStepKey,
    label: string,
    value: number,
    costCents: number | null,
  ): ReportingFunnelStep {
    return {
      key,
      label,
      value,
      costCents,
    };
  }

  private funnelStageValue(
    eventName: string,
    input: {
      countableEvents: ReportingMetricEvent[];
      purchases: number;
      qualifiedLead: number;
      realConversations: number;
    },
  ): number {
    if (eventName === "LeadSubmitted") {
      return input.realConversations;
    }

    if (eventName === "QualifiedLead") {
      return input.qualifiedLead;
    }

    if (eventName === "Purchase") {
      return input.purchases;
    }

    return input.countableEvents.filter(
      (event) => event.eventName === eventName,
    ).length;
  }

  /**
   * The LeadSubmitted stage now counts leads novos. Workspaces that kept the
   * old default name see the new one; a custom name is left as configured.
   */
  private funnelStageLabel(stage: FunnelStageConfigurationDto): string {
    return stage.eventName === "LeadSubmitted" &&
      legacyLeadSubmittedLabels.has(
        stage.label.trim().toLocaleLowerCase("pt-BR"),
      )
      ? funnelLabels.real_conversations
      : stage.label;
  }

  private funnelStageKey(eventName: string): string {
    if (eventName === "LeadSubmitted") {
      return "real_conversations";
    }

    if (eventName === "QualifiedLead") {
      return "qualified_lead";
    }

    if (eventName === "Purchase") {
      return "purchase";
    }

    return `event_${eventName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}`;
  }

  private matchesScope(
    item: ReportingMetricEvent | ReportingMetricLead,
    scope: ReportingMetricScope,
  ): boolean {
    if (scope.adId) {
      return item.adId === scope.adId;
    }

    if (scope.adSetId) {
      return item.adSetId === scope.adSetId;
    }

    if (scope.campaignId) {
      return item.campaignId === scope.campaignId;
    }

    return true;
  }

  private isCountableEvent(event: ReportingMetricEvent): boolean {
    return event.status !== "skipped";
  }

  private isPaidRealConversation(item: {
    businessSource?: string | null;
    campaignId: string | null;
    adSetId: string | null;
    adId: string | null;
    ctwaClid?: string | null;
  }): boolean {
    return !this.isOrganic(item) && this.hasAttribution(item);
  }

  private isPaidLeadEvent(item: {
    businessSource?: string | null;
    campaignId: string | null;
    adSetId: string | null;
    adId: string | null;
    ctwaClid?: string | null;
  }): boolean {
    return this.normalizedSource(item.businessSource) === "paid"
      ? true
      : !this.isOrganic(item);
  }

  private isOrganic(item: {
    businessSource?: string | null;
    campaignId: string | null;
    adSetId: string | null;
    adId: string | null;
    ctwaClid?: string | null;
  }): boolean {
    const source = this.normalizedSource(item.businessSource);

    if (source === "organic") {
      return true;
    }

    if (source === "paid") {
      return false;
    }

    return !this.hasAttribution(item);
  }

  private hasAttribution(item: {
    campaignId: string | null;
    adSetId: string | null;
    adId: string | null;
    ctwaClid?: string | null;
  }): boolean {
    return Boolean(
      item.campaignId || item.adSetId || item.adId || item.ctwaClid,
    );
  }

  private normalizedSource(value?: string | null): string | null {
    return value?.trim().toLowerCase() || null;
  }

  private explicitPurchaseKind(
    value?: string | null,
  ): "first_purchase" | "repurchase" | null {
    return value === "first_purchase" || value === "repurchase" ? value : null;
  }

  private optionalIdentityKey(item: {
    customerIdentityKey?: string | null;
    phoneHash: string | null;
  }): string | null {
    return item.customerIdentityKey || item.phoneHash || null;
  }

  private identityKey(
    item: {
      customerIdentityKey?: string | null;
      phoneHash: string | null;
    },
    fallback: string,
  ): string {
    return this.optionalIdentityKey(item) ?? fallback;
  }

  private sumPurchaseValue(purchases: ClassifiedPurchase[]): number {
    return purchases.reduce(
      (sum, purchase) => sum + (purchase.event.valueCents ?? 0),
      0,
    );
  }

  private costPer(spendCents: number, count: number): number | null {
    return count > 0 ? Math.floor(spendCents / count) : null;
  }

  private roas(revenueCents: number, spendCents: number): number | null {
    return revenueCents > 0 && spendCents > 0
      ? revenueCents / spendCents
      : null;
  }
}
