import type { Prisma } from "@prisma/client";
import type {
  IntegrationUnattributedReasonDto,
  ProviderConversionPaidLeadResolutionDto,
} from "@wpptrack/shared";
import {
  hashPhoneIdentity,
  hashPhoneIdentityVariants,
  phoneIdentityKey,
} from "../common/phone/phone-identity";
import { resolvePurchaseChannels } from "../conversion-rules/provider-purchase-routing";
import {
  listWorkspaceScopeChannels,
  providerRuleScope,
  samePhoneChannels,
  selectApplicableProviderRules,
  type ScopedChannel,
  type ScopedProviderRule,
} from "../conversion-rules/provider-rule-scope";
import {
  paytProductFilterMatches,
  type ParsedPaytAutomationV1,
} from "./providers/payt/payt-automation-v1.parser";
import type { ParsedUmblerAutomationV1 } from "./providers/umbler/umbler-automation-v1.parser";
import type { ParsedUnnichatAutomationV1 } from "./providers/unnichat/unnichat-automation-v1.parser";

/**
 * Fase 5.3 — roteador das URLs únicas (SaaS 613beb3 + 4cad4963).
 *
 * Decide QUAL regra é dona de um callback recebido pela URL do workspace
 * (Payt: uma por workspace; Unnichat/Umbler: uma por evento). O callback é
 * entregue depois ao processamento normal dessa regra (ingestRouted), que
 * repete todas as validações (lead pago, número, certificação, produção,
 * dedupe). O roteador só escolhe; nunca envia nada sozinho.
 *
 * Ordem na Payt: evento com regra ativa -> produto -> lead do comprador ->
 * número de chegada -> regra do número (a específica vence a de todos os
 * números; empate: a com filtro de produto, depois a mais antiga).
 */

export type IntegrationRoutingProvider = "payt" | "unnichat" | "umbler";

const routingRuleSelect = {
  id: true,
  scope: true,
  connectionId: true,
  removedAt: true,
  createdAt: true,
  productFilterCodes: true,
  conversionRule: {
    select: { triggerType: true, eventName: true, active: true },
  },
  parserRelease: { select: { provider: true } },
  connection: { select: { provider: true } },
  channels: { select: { channelId: true } },
} satisfies Prisma.ProviderConversionRuleConfigSelect;

export type RoutingRule = ScopedProviderRule & {
  createdAt: Date;
  productFilterCodes: string[];
};

export type IntegrationRouteDecision =
  | {
      status: "routed";
      providerRuleId: string;
      channelId: string;
      connectionId: string;
    }
  | {
      status: "unattributed";
      reasonCode: IntegrationUnattributedReasonDto;
      channelId: string | null;
    };

export type RoutingClient = Pick<
  Prisma.TransactionClient,
  | "providerConversionRuleConfig"
  | "inboundWebhookChannel"
  | "inboundWebhookEvent"
  | "conversionEventLog"
>;

export type PaidLeadResolverLike = {
  resolve(input: {
    workspaceId: string;
    phone: string | null | undefined;
    phoneCandidates?: readonly string[];
    channelId?: string;
    connectionId?: string;
    ctwaProofAnyChannel?: boolean;
  }): Promise<ProviderConversionPaidLeadResolutionDto>;
};

function unattributed(
  reasonCode: IntegrationUnattributedReasonDto,
  channelId: string | null = null,
): IntegrationRouteDecision {
  return { status: "unattributed", reasonCode, channelId };
}

/**
 * Active automation rules of one platform and event that still own an
 * endpoint (the internal anchor of their callbacks), oldest first.
 */
export async function loadRoutingRules(
  client: Pick<Prisma.TransactionClient, "providerConversionRuleConfig">,
  input: {
    workspaceId: string;
    provider: IntegrationRoutingProvider;
    eventName: string;
  },
): Promise<RoutingRule[]> {
  return client.providerConversionRuleConfig.findMany({
    where: {
      workspaceId: input.workspaceId,
      removedAt: null,
      connectionId: { not: null },
      conversionRule: {
        active: true,
        triggerType: "provider_automation",
        eventName: input.eventName,
      },
      parserRelease: {
        is: {
          provider: input.provider,
          version: "automation-v1",
          status: { not: "retired" },
        },
      },
      endpoint: { is: { removedAt: null } },
    },
    select: routingRuleSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
  });
}

/**
 * Picks the rule that owns an occurrence on `channel` among `rules` (already
 * restricted to one platform and event). Product filter first, then the
 * precedence of the rules: a specific rule of that number (or of another
 * channel of the same phone) replaces the rule for all numbers. Ties: the rule
 * with a product filter, then the oldest. Pure: no I/O.
 */
export function pickRoutedRule<R extends RoutingRule>(
  rules: readonly R[],
  channel: ScopedChannel,
  options: {
    phoneChannels?: readonly ScopedChannel[];
    /** Sale codes; null = platform without products (no filter). */
    productCodes: readonly string[] | null;
  },
): R | null {
  const productCodes = options.productCodes;
  const matching = productCodes
    ? rules.filter((rule) =>
        paytProductFilterMatches(rule.productFilterCodes, productCodes),
      )
    : [...rules];
  const result = selectApplicableProviderRules(matching, channel, {
    phoneChannels: options.phoneChannels,
  });
  // A global rule whose phone runs on another channel still owns a callback
  // whose origin is THIS channel (the routing already proved the origin).
  const applicable = [
    ...result.applicable,
    ...result.duplicatePhone.map((entry) => entry.rule),
  ];
  let pool = applicable.filter(
    (rule) => providerRuleScope(rule) === "specific_numbers",
  );
  if (pool.length === 0) pool = applicable;
  if (pool.length === 0 && result.overridden.length > 0) {
    // Only reachable when the specific winner sits on a sibling channel of
    // the same phone: that rule replaces the global one there too.
    const winners = new Set(
      result.overridden.flatMap((entry) => entry.bySpecificRuleIds),
    );
    pool = matching.filter((rule) => winners.has(rule.id));
  }
  const sorted = [...pool].sort((left, right) => {
    const leftFiltered = left.productFilterCodes.length > 0 ? 0 : 1;
    const rightFiltered = right.productFilterCodes.length > 0 ? 0 : 1;
    if (leftFiltered !== rightFiltered) return leftFiltered - rightFiltered;
    const byDate = left.createdAt.getTime() - right.createdAt.getTime();
    if (byDate !== 0) return byDate;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return sorted[0] ?? null;
}

function leadUnresolvedReason(
  lead: Exclude<ProviderConversionPaidLeadResolutionDto, { status: "resolved" }>,
): IntegrationUnattributedReasonDto {
  if (lead.status === "ambiguous") return "buyer_ambiguous";
  if (
    lead.status === "not_found" &&
    lead.reasonCode === "paid_attribution_missing"
  )
    return "buyer_without_ad_origin";
  return "buyer_not_whatsapp_lead";
}

function phoneHashes(phones: readonly string[], extra?: string): string[] {
  return [
    ...new Set(
      [
        extra,
        ...phones.map((phone) => hashPhoneIdentity(phone)),
        ...hashPhoneIdentityVariants([...phones]),
      ].filter((hash): hash is string => Boolean(hash)),
    ),
  ];
}

/**
 * Numbers a resolved paid lead arrived on: the typed CTWA entry proof for a
 * lead without ad id, else the materialized first-entry evidence
 * (resolvePurchaseChannels) and, without any, the verified CTWA entry proof
 * of the ad lead (same fallback as the rule, review finding M2). May be more
 * than one when the lead entered through several numbers.
 */
async function leadOriginChannelIds(
  client: RoutingClient,
  input: {
    workspaceId: string;
    lead: Extract<
      ProviderConversionPaidLeadResolutionDto,
      { status: "resolved" }
    >["lead"];
    phones: readonly string[];
    channels: readonly ScopedChannel[];
    receivedAt: Date;
    /** Payt: an ad lead without materialized entry falls back to its proof. */
    adLeadProofFallback?: boolean;
  },
): Promise<string[]> {
  const { lead } = input;
  const proof = lead.ctwaDestination;
  const proofChannel =
    proof && input.channels.some((channel) => channel.id === proof.channelId)
      ? proof.channelId
      : null;
  if (!lead.adId) return proofChannel ? [proofChannel] : [];
  if (input.channels.length === 0) return [];
  const origins = await resolvePurchaseChannels(client, {
    workspaceId: input.workspaceId,
    channelIds: input.channels.map((channel) => channel.id),
    phoneHashes: phoneHashes(input.phones, lead.phoneHash),
    leadId: lead.id,
    adId: lead.adId,
    ctwaClid: lead.ctwaClid,
    receivedAt: input.receivedAt,
  });
  if (origins.length === 0)
    return input.adLeadProofFallback && proofChannel ? [proofChannel] : [];
  return [...new Set(origins.map((origin) => origin.id))];
}

/**
 * Payt lead that entered through more than one number. On the old per-rule
 * URLs only a rule whose OWN numbers contain exactly one of those entries
 * decides the sale (a rule for all numbers sees them all and stays out).
 * The URL única follows the same rule: route when exactly one specific rule
 * owns exactly one of the entries; otherwise it stays unattributed.
 */
function routeMultiOrigin(
  rules: readonly RoutingRule[],
  channels: readonly ScopedChannel[],
  origins: readonly string[],
  productCodes: readonly string[] | null,
): IntegrationRouteDecision {
  const owners = new Map<string, IntegrationRouteDecision>();
  for (const origin of origins) {
    const decision = finishRoute(rules, channels, origin, productCodes);
    if (decision.status !== "routed") continue;
    const rule = rules.find((item) => item.id === decision.providerRuleId);
    if (!rule || providerRuleScope(rule) !== "specific_numbers") continue;
    const owned = origins.filter((candidate) =>
      rule.channels.some((channel) => channel.channelId === candidate),
    );
    if (owned.length === 1) owners.set(rule.id, decision);
  }
  return owners.size === 1
    ? [...owners.values()][0]!
    : unattributed("origin_channel_unresolved");
}

function finishRoute(
  rules: readonly RoutingRule[],
  channels: readonly ScopedChannel[],
  originChannelId: string,
  productCodes: readonly string[] | null,
): IntegrationRouteDecision {
  const channel = channels.find((candidate) => candidate.id === originChannelId);
  if (!channel) return unattributed("origin_channel_unresolved");
  const picked = pickRoutedRule(rules, channel, {
    phoneChannels: samePhoneChannels(channels, channel.id),
    productCodes,
  });
  if (!picked || !picked.connectionId) {
    return unattributed("no_rule_for_number", channel.id);
  }
  return {
    status: "routed",
    providerRuleId: picked.id,
    channelId: channel.id,
    connectionId: channel.connectionId,
  };
}

/** Payt (URL única): the event comes from the postback. */
export async function routePaytSale(
  client: RoutingClient,
  paidLeads: PaidLeadResolverLike,
  input: {
    workspaceId: string;
    sale: ParsedPaytAutomationV1;
    receivedAt: Date;
  },
): Promise<IntegrationRouteDecision> {
  const rules = await loadRoutingRules(client, {
    workspaceId: input.workspaceId,
    provider: "payt",
    eventName: input.sale.eventName,
  });
  if (rules.length === 0) return unattributed("no_active_rule_for_event");
  const productCodes = input.sale.productCodes ?? [];
  const productRules = rules.filter((rule) =>
    paytProductFilterMatches(rule.productFilterCodes, productCodes),
  );
  if (productRules.length === 0) return unattributed("product_without_rule");

  const lead = await paidLeads.resolve({
    workspaceId: input.workspaceId,
    phone: input.sale.phone,
    phoneCandidates: input.sale.phoneCandidates,
    ctwaProofAnyChannel: true,
  });
  if (lead.status !== "resolved") return unattributed(leadUnresolvedReason(lead));

  const channels = await listWorkspaceScopeChannels(client, input.workspaceId);
  const origins = await leadOriginChannelIds(client, {
    workspaceId: input.workspaceId,
    lead: lead.lead,
    phones: input.sale.phoneCandidates,
    channels,
    receivedAt: input.receivedAt,
    adLeadProofFallback: true,
  });
  if (origins.length === 0) return unattributed("origin_channel_unresolved");
  if (origins.length > 1)
    return routeMultiOrigin(productRules, channels, origins, productCodes);
  return finishRoute(productRules, channels, origins[0]!, productCodes);
}

/**
 * Unnichat (URL por evento): the conversation's ctwa_clid points to the exact
 * CTWA entry (its LeadSubmitted receipt carries the channel). Only without
 * that entry does the lead's own origin decide.
 */
export async function routeUnnichatEvent(
  client: RoutingClient,
  paidLeads: PaidLeadResolverLike,
  input: {
    workspaceId: string;
    eventName: string;
    automation: ParsedUnnichatAutomationV1;
    receivedAt: Date;
  },
): Promise<IntegrationRouteDecision> {
  const ctwaClid = input.automation.ctwaClid;
  if (!ctwaClid) return unattributed("conversation_without_ad");
  const rules = await loadRoutingRules(client, {
    workspaceId: input.workspaceId,
    provider: "unnichat",
    eventName: input.eventName,
  });
  if (rules.length === 0) return unattributed("no_active_rule_for_event");

  const channels = (
    await listWorkspaceScopeChannels(client, input.workspaceId)
  ).filter((channel) => channel.provider === "unnichat");
  const phones = [input.automation.phone];
  const entries = await client.conversionEventLog.findMany({
    where: {
      workspaceId: input.workspaceId,
      ctwaClid,
      eventName: "LeadSubmitted",
      sourceTrigger: { startsWith: "inbound_webhook:" },
      phoneHash: { in: phoneHashes(phones) },
    },
    select: { sourcePayload: true },
    take: 50,
  });
  const entryChannels = new Set<string>();
  for (const entry of entries) {
    const payload = entry.sourcePayload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      continue;
    const channelId = (payload as Record<string, unknown>).channelId;
    if (
      typeof channelId === "string" &&
      channels.some((channel) => channel.id === channelId)
    )
      entryChannels.add(channelId);
  }
  if (entryChannels.size === 1) {
    return finishRoute(rules, channels, [...entryChannels][0]!, null);
  }
  if (entryChannels.size > 1) return unattributed("origin_channel_unresolved");

  const lead = await paidLeads.resolve({
    workspaceId: input.workspaceId,
    phone: input.automation.phone,
    ctwaProofAnyChannel: true,
  });
  if (lead.status !== "resolved") return unattributed(leadUnresolvedReason(lead));
  const origins = await leadOriginChannelIds(client, {
    workspaceId: input.workspaceId,
    lead: lead.lead,
    phones,
    channels,
    receivedAt: input.receivedAt,
  });
  if (origins.length !== 1) return unattributed("origin_channel_unresolved");
  return finishRoute(rules, channels, origins[0]!, null);
}

/** Window of the Umbler "number the contact talked to" fallback. */
export const UMBLER_CONTACT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Umbler (URL por evento): the automation contract carries no channel.
 * Preferred: the optional `channel.phone` of the payload (map it, in the
 * Umbler HTTP action, to the number of the channel that served the contact).
 * Fallback: the Umbler number the contact sent messages to in the last 30
 * days, only when it is exactly one; a contact that talked to more than one
 * number is ambiguous and stays unattributed (never guessed).
 */
export async function routeUmblerEvent(
  client: RoutingClient,
  input: {
    workspaceId: string;
    eventName: string;
    automation: ParsedUmblerAutomationV1;
    channelPhoneHint: string | null;
    receivedAt: Date;
  },
): Promise<IntegrationRouteDecision> {
  if (input.automation.eventName !== input.eventName) {
    return unattributed("event_mismatch");
  }
  const rules = await loadRoutingRules(client, {
    workspaceId: input.workspaceId,
    provider: "umbler",
    eventName: input.eventName,
  });
  if (rules.length === 0) return unattributed("no_active_rule_for_event");
  const channels = (
    await listWorkspaceScopeChannels(client, input.workspaceId)
  ).filter((channel) => channel.provider === "umbler");
  if (channels.length === 0) return unattributed("origin_channel_unresolved");

  const hintKey = phoneIdentityKey(input.channelPhoneHint);
  if (hintKey) {
    const hinted = channels.filter((channel) => channel.phoneKey === hintKey);
    if (hinted.length === 1) {
      return finishRoute(rules, channels, hinted[0]!.id, null);
    }
  }
  const recent = await client.inboundWebhookEvent.findMany({
    where: {
      workspaceId: input.workspaceId,
      channelId: { in: channels.map((channel) => channel.id) },
      contactIdentityHash: { in: phoneHashes([input.automation.phone]) },
      occurredAt: {
        gte: new Date(input.receivedAt.getTime() - UMBLER_CONTACT_LOOKBACK_MS),
        lte: new Date(input.receivedAt.getTime() + 5 * 60 * 1_000),
      },
    },
    distinct: ["channelId"],
    select: { channelId: true },
    take: 2,
  });
  if (recent.length === 0) return unattributed("contact_without_conversation");
  if (recent.length > 1) return unattributed("contact_multiple_numbers");
  return finishRoute(rules, channels, recent[0]!.channelId, null);
}
