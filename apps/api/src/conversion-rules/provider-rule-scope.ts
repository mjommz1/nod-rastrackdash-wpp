import { Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  paytBetaSaleEventNames,
  paytSaleEventNames,
  providerConversionRuleGlobalPrecedence,
  type ProviderConversionRuleCapabilitiesDto,
  type ProviderConversionRuleOriginDto,
  type ProviderConversionRuleScopeDto,
} from "@wpptrack/shared";
import { phoneIdentityKey } from "../common/phone/phone-identity";

/**
 * Alcance das regras de conversao por provedor (Fase 3, Conversoes).
 *
 * Sempre ligado nesta edicao (sem variavel de ambiente). Uma regra e avaliada
 * num canal (numero de WhatsApp) quando:
 *  - scope "specific_numbers" (toda regra criada antes desta fase): o canal e
 *    uma das linhas ProviderConversionRuleChannel da regra; ou
 *  - scope "all_numbers": o provedor do canal suporta a origem da regra (e,
 *    para a automacao Umbler, o canal e da conexao da regra). Avaliado na
 *    hora, entao numeros conectados depois entram automaticamente.
 *
 * Precedencia: num canal, uma regra especifica ativa com a mesma origem e o
 * mesmo evento SUBSTITUI toda regra "all_numbers" dessa origem/evento; a
 * global nem e avaliada ali.
 *
 * Mesmo telefone em varios canais (ex.: o numero conectado pelo Umbler e por
 * uma instancia Uazapi): os dois canais veem a mesma mensagem da equipe. A
 * regra global roda em UM canal canonico por telefone (ativo primeiro, depois
 * o mais antigo), e uma regra especifica em qualquer canal desse telefone
 * substitui a global em todos os canais dele. Canais sem telefone verificavel
 * ficam independentes; o dedupe de negocio (evento + workspace + lead) segue
 * como rede de seguranca contra envio duplicado.
 *
 * Matriz de capacidade desta edicao (derivada dos parsers/ingestao):
 *  - frase da equipe: umbler (observacao de mensagens) e uazapi (fromMe=true
 *    no webhook Uazapi/uazapi_byo);
 *  - frase do contato: umbler (o parser marca authorType "contact"); Uazapi
 *    so avalia mensagens da equipe; gupshup/data_crazy/meta_cloud ainda nao
 *    avaliam regras de mensagem (a observacao so aceita eventos umbler);
 *  - catalogo estruturado: umbler e uazapi (mensagem da equipe, como no SaaS);
 *  - etiqueta: uazapi (por nome entre instancias);
 *  - automacao Umbler: presa a conexao que recebe o callback;
 *  - venda Payt (Fase 4a): qualquer numero de WhatsApp do workspace; a regra
 *    guarda a conexao dos numeros escolhidos so como ancora da URL;
 *  - automacao Unnichat (Fase 4b): presa a conexao Unnichat que recebe o
 *    callback (o numero ligado a conexao), como a automacao Umbler.
 *  WAHA, Z-API e NOD API nao entram em regras de provedor (nao possuem canal
 *  de entrada); ficam "Em breve".
 */

export type ProviderRuleScope = ProviderConversionRuleScopeDto;
export type ProviderRuleOrigin = ProviderConversionRuleOriginDto;

/** Minimal rule shape every caller can provide from its own include. */
export type ScopedProviderRule = {
  id: string;
  scope?: string | null;
  connectionId: string | null;
  removedAt?: Date | null;
  messageAuthorScope?: string | null;
  conversionRule: {
    triggerType: string;
    eventName: string;
    active?: boolean;
  };
  parserRelease?: { provider: string } | null;
  connection?: { provider: string } | null;
  channels: ReadonlyArray<{ channelId: string }>;
};

/** A WhatsApp channel and the provider of the connection it belongs to. */
export type ScopedChannel = {
  id: string;
  connectionId: string;
  provider: string;
  /** BR-equivalent phone identity of the connected number (null: unknown). */
  phoneKey?: string | null;
  status?: string;
  createdAt?: Date;
  /**
   * Channel active AND its connection in production: an occurrence here can
   * be sent. Undefined when unknown (occurrence-side channels).
   */
  productionReady?: boolean;
};

/** For UI copy: a specific rule disables the global rule on that number. */
export const PROVIDER_RULE_GLOBAL_PRECEDENCE =
  providerConversionRuleGlobalPrecedence;

/** Reason recorded when a global rule yields to a specific one. */
export const PROVIDER_RULE_OVERRIDDEN_REASON = "overridden_by_specific_rule";

/** Providers whose TEAM messages run message_phrase rules. */
export const MESSAGE_TEAM_CHANNEL_PROVIDERS = ["umbler", "uazapi"] as const;
/** Providers whose CONTACT messages run message_phrase rules. */
export const MESSAGE_CONTACT_CHANNEL_PROVIDERS = ["umbler"] as const;
/** Providers whose team messages run structured catalog rules (as the SaaS). */
export const CATALOG_RULE_CHANNEL_PROVIDERS = ["umbler", "uazapi"] as const;
/** Providers whose chats expose WhatsApp labels (tags). */
export const LABEL_RULE_CHANNEL_PROVIDERS = ["uazapi"] as const;
/**
 * Every inbound provider whose channel is a WhatsApp number (Payt is a sales
 * platform and has no channel): a Payt sale may belong to any of them.
 */
export const WHATSAPP_CHANNEL_PROVIDERS = [
  "umbler",
  "gupshup",
  "uazapi",
  "meta_cloud",
  "data_crazy",
  "unnichat",
] as const;
/** Payt events (Fase 4a); "Carrinho abandonado" is still beta. */
export const PAYT_RULE_EVENT_NAMES = [...paytSaleEventNames];
export const PAYT_RULE_BETA_EVENT_NAMES = [...paytBetaSaleEventNames];
/** WhatsApp providers of this edition that do not run provider rules yet. */
export const UNSUPPORTED_RULE_WHATSAPP_PROVIDERS = [
  "waha",
  "zapi",
  "nod_api",
] as const;

export function providerRuleScope(rule: {
  scope?: string | null;
}): ProviderRuleScope {
  return rule.scope === "all_numbers" ? "all_numbers" : "specific_numbers";
}

/**
 * Origin of a rule, from its trigger and the parser it is bound to. An unbound
 * provider_automation rule can only be a WhatsApp label rule: the Umbler
 * automation always keeps its connection and parser release.
 */
export function providerRuleOrigin(
  rule: Pick<
    ScopedProviderRule,
    "conversionRule" | "parserRelease" | "connection"
  >,
): ProviderRuleOrigin | null {
  switch (rule.conversionRule.triggerType) {
    case "message_phrase":
      return "message_phrase";
    case "structured_catalog":
      return "structured_catalog";
    case "provider_automation": {
      const provider =
        rule.parserRelease?.provider ?? rule.connection?.provider ?? null;
      if (provider === null || provider === "uazapi") return "whatsapp_label";
      if (provider === "payt") return "automation_payt";
      if (provider === "umbler") return "automation_umbler";
      if (provider === "unnichat") return "automation_unnichat";
      return null;
    }
    default:
      return null;
  }
}

/** Channel providers on which a rule origin can be evaluated (any author). */
export function providerRuleOriginChannelProviders(
  origin: ProviderRuleOrigin,
): readonly string[] {
  switch (origin) {
    case "message_phrase":
      return MESSAGE_TEAM_CHANNEL_PROVIDERS;
    case "structured_catalog":
      return CATALOG_RULE_CHANNEL_PROVIDERS;
    case "whatsapp_label":
      return LABEL_RULE_CHANNEL_PROVIDERS;
    case "automation_umbler":
      return ["umbler"];
    case "automation_unnichat":
      return ["unnichat"];
    case "automation_payt":
      return WHATSAPP_CHANNEL_PROVIDERS;
  }
}

/**
 * Channel providers on which THIS rule can match: a message rule restricted
 * to contact messages only runs where contact messages are evaluated.
 */
export function providerRuleChannelProviders(
  rule: Pick<
    ScopedProviderRule,
    "conversionRule" | "parserRelease" | "connection" | "messageAuthorScope"
  >,
): readonly string[] {
  const origin = providerRuleOrigin(rule);
  if (!origin) return [];
  if (origin === "message_phrase" && rule.messageAuthorScope === "contact") {
    return MESSAGE_CONTACT_CHANNEL_PROVIDERS;
  }
  return providerRuleOriginChannelProviders(origin);
}

/**
 * Umbler/Unnichat automations resolve the contact on the connection that
 * received the callback, so even "all numbers" means all numbers of that
 * connection. Payt callbacks carry no channel and may own any WhatsApp number.
 */
export function providerRuleOriginIsConnectionBound(
  origin: ProviderRuleOrigin,
): boolean {
  return origin === "automation_umbler" || origin === "automation_unnichat";
}

/** Origins whose rule must keep a connection binding (signed endpoint). */
export function providerRuleOriginRequiresConnection(
  origin: ProviderRuleOrigin,
): boolean {
  return (
    origin === "automation_umbler" ||
    origin === "automation_unnichat" ||
    origin === "automation_payt"
  );
}

/** Origins that "Unificar" may merge (never endpoint automations). */
export function providerRuleOriginUnifiable(origin: ProviderRuleOrigin): boolean {
  return (
    origin === "message_phrase" ||
    origin === "structured_catalog" ||
    origin === "whatsapp_label"
  );
}

/** Capability matrix exposed to the Conversions screen. */
export function providerRuleCapabilities(): ProviderConversionRuleCapabilitiesDto {
  const origins: ProviderConversionRuleCapabilitiesDto["origins"] = [
    {
      origin: "message_phrase",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: [...MESSAGE_TEAM_CHANNEL_PROVIDERS],
      authorChannelProviders: {
        team: [...MESSAGE_TEAM_CHANNEL_PROVIDERS],
        contact: [...MESSAGE_CONTACT_CHANNEL_PROVIDERS],
      },
      connectionBound: false,
      requiresConnection: false,
      labelMatch: null,
      unifiable: true,
    },
    {
      origin: "structured_catalog",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: [...CATALOG_RULE_CHANNEL_PROVIDERS],
      authorChannelProviders: null,
      connectionBound: false,
      requiresConnection: false,
      labelMatch: null,
      unifiable: true,
    },
    {
      origin: "whatsapp_label",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: [...LABEL_RULE_CHANNEL_PROVIDERS],
      authorChannelProviders: null,
      connectionBound: false,
      requiresConnection: false,
      labelMatch: "name_across_instances",
      unifiable: true,
    },
    {
      origin: "automation_umbler",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: ["umbler"],
      authorChannelProviders: null,
      connectionBound: true,
      requiresConnection: providerRuleOriginRequiresConnection(
        "automation_umbler",
      ),
      labelMatch: null,
      unifiable: false,
      eventNames: ["QualifiedLead", "Purchase"],
    },
    {
      // Fase 4a: the sale event comes from each Payt postback status. The
      // scope is not connection-bound (its numbers may be any WhatsApp
      // number), but creating the rule requires a WhatsApp connection (its
      // numbers' connection) as the anchor of the signed URL, as in the SaaS.
      origin: "automation_payt",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: [...WHATSAPP_CHANNEL_PROVIDERS],
      authorChannelProviders: null,
      connectionBound: false,
      requiresConnection: providerRuleOriginRequiresConnection(
        "automation_payt",
      ),
      labelMatch: null,
      unifiable: false,
      eventNames: PAYT_RULE_EVENT_NAMES,
      betaEventNames: PAYT_RULE_BETA_EVENT_NAMES,
    },
    {
      // Fase 4b (as in the SaaS): an Unnichat flow calls the rule URL. The
      // rule is bound to the Unnichat connection (its number); the event is
      // chosen in the rule (any catalog event), never by the payload, and a
      // callback without ctwa_clid is never sent.
      origin: "automation_unnichat",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: ["unnichat"],
      authorChannelProviders: null,
      connectionBound: true,
      requiresConnection: providerRuleOriginRequiresConnection(
        "automation_unnichat",
      ),
      labelMatch: null,
      unifiable: false,
    },
  ];
  return {
    workspaceScopeEnabled: true,
    globalPrecedence: PROVIDER_RULE_GLOBAL_PRECEDENCE,
    origins,
    unsupportedWhatsappProviders: [...UNSUPPORTED_RULE_WHATSAPP_PROVIDERS],
  };
}

export function providerRulePrecedenceKey(
  rule: Pick<
    ScopedProviderRule,
    "conversionRule" | "parserRelease" | "connection"
  >,
): string | null {
  const origin = providerRuleOrigin(rule);
  return origin ? `${origin}|${rule.conversionRule.eventName}` : null;
}

function isLiveRule(rule: ScopedProviderRule): boolean {
  return rule.conversionRule.active !== false && !rule.removedAt;
}

/** Whether the rule's scope (ignoring precedence) includes this channel. */
export function providerRuleCoversChannel(
  rule: ScopedProviderRule,
  channel: ScopedChannel,
): boolean {
  if (providerRuleScope(rule) === "specific_numbers") {
    return rule.channels.some((scope) => scope.channelId === channel.id);
  }
  const origin = providerRuleOrigin(rule);
  if (!origin) return false;
  if (!providerRuleChannelProviders(rule).includes(channel.provider))
    return false;
  return (
    !providerRuleOriginIsConnectionBound(origin) ||
    rule.connectionId === channel.connectionId
  );
}

export type ProviderRuleApplicability<R> = {
  /** Rules to evaluate on the channel, in the input order. */
  applicable: R[];
  /** Global rules skipped on this channel and the specific rules that won. */
  overridden: Array<{ rule: R; bySpecificRuleIds: string[] }>;
  /** Global rules skipped because the same phone runs them on another channel. */
  duplicatePhone: Array<{ rule: R; canonicalChannelId: string }>;
  /**
   * Global rules not evaluated because the workspace scope could not be
   * resolved (more than PROVIDER_RULE_SCOPE_CHANNEL_LIMIT channels).
   */
  skippedGlobal: Array<{ rule: R; reason: "scope_channel_limit" }>;
};

export type ProviderRulePhoneContext = {
  /** Every live channel of the same phone, including the channel itself. */
  phoneChannels?: readonly ScopedChannel[];
  /** Specific rules (beyond `rules`) that may own a channel of that phone. */
  peerRules?: readonly ScopedProviderRule[];
};

/** Active channels first, then the oldest, then the smallest id. */
export function canonicalPhoneChannel(
  channels: readonly ScopedChannel[],
): ScopedChannel | null {
  const sorted = [...channels].sort((left, right) => {
    const leftActive = left.status === undefined || left.status === "active";
    const rightActive = right.status === undefined || right.status === "active";
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    const byDate =
      (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0);
    if (byDate !== 0) return byDate;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return sorted[0] ?? null;
}

/**
 * Applies scope + precedence for one channel. Input order is preserved, so a
 * set of specific-only rules (every rule before this phase) comes back exactly
 * as the old `rule.channels.some(...)` filter returned it. `context` carries
 * the other channels of the same phone (see the module comment).
 */
export function selectApplicableProviderRules<R extends ScopedProviderRule>(
  rules: readonly R[],
  channel: ScopedChannel,
  context: ProviderRulePhoneContext = {},
): ProviderRuleApplicability<R> {
  const phoneChannels = context.phoneChannels?.some(
    (candidate) => candidate.id === channel.id,
  )
    ? context.phoneChannels
    : [channel, ...(context.phoneChannels ?? [])];
  const covering = rules.filter(
    (rule) => isLiveRule(rule) && providerRuleCoversChannel(rule, channel),
  );
  const specificByKey = new Map<string, Set<string>>();
  for (const rule of [...rules, ...(context.peerRules ?? [])]) {
    if (!isLiveRule(rule) || providerRuleScope(rule) !== "specific_numbers")
      continue;
    const key = providerRulePrecedenceKey(rule);
    if (!key) continue;
    if (
      !phoneChannels.some((candidate) =>
        providerRuleCoversChannel(rule, candidate),
      )
    )
      continue;
    specificByKey.set(key, (specificByKey.get(key) ?? new Set()).add(rule.id));
  }
  const applicable: R[] = [];
  const overridden: ProviderRuleApplicability<R>["overridden"] = [];
  const duplicatePhone: ProviderRuleApplicability<R>["duplicatePhone"] = [];
  for (const rule of covering) {
    if (providerRuleScope(rule) !== "all_numbers") {
      applicable.push(rule);
      continue;
    }
    const key = providerRulePrecedenceKey(rule);
    const winners = key ? specificByKey.get(key) : undefined;
    if (winners?.size) {
      overridden.push({ rule, bySpecificRuleIds: [...winners] });
      continue;
    }
    const canonical = canonicalPhoneChannel(
      phoneChannels.filter((candidate) =>
        providerRuleCoversChannel(rule, candidate),
      ),
    );
    if (canonical && canonical.id !== channel.id) {
      duplicatePhone.push({ rule, canonicalChannelId: canonical.id });
      continue;
    }
    applicable.push(rule);
  }
  return { applicable, overridden, duplicatePhone, skippedGlobal: [] };
}

/**
 * Prisma filter for "rules that may apply to a channel of `connectionId`":
 * rules bound to that connection or unbound ones, which are either scoped to
 * one of the channels or global. Precedence and capability are then applied in
 * memory by `selectApplicableProviderRules`.
 */
export function providerRuleCandidateWhere(input: {
  connectionId: string;
  channelIds: string[];
}): Prisma.ProviderConversionRuleConfigWhereInput {
  return {
    AND: [
      { OR: [{ connectionId: input.connectionId }, { connectionId: null }] },
      {
        OR: [
          {
            channels: {
              some:
                input.channelIds.length === 1
                  ? { channelId: input.channelIds[0]! }
                  : { channelId: { in: input.channelIds } },
            },
          },
          { scope: "all_numbers" },
        ],
      },
    ],
  };
}

type ChannelLookupClient = Pick<
  Prisma.TransactionClient,
  "inboundWebhookChannel"
>;

/** Page size of the workspace channel scan. */
export const PROVIDER_RULE_SCOPE_CHANNEL_PAGE = 500;
/** Hard bound: a scope never silently truncates; past this it refuses. */
export const PROVIDER_RULE_SCOPE_CHANNEL_LIMIT = 5_000;

const scopeLogger = new Logger("ProviderRuleScope");

/**
 * Phone of a channel. A Uazapi bridge channel stores a placeholder (the
 * provider instance id or the instance id) until a connection test reports
 * the real number, so only a value different from those placeholders is a
 * phone. Unverifiable values yield null (the channel stays independent).
 */
export function channelPhoneKey(channel: {
  connectedPhone?: string | null;
  providerChannelId?: string | null;
  organizationId?: string | null;
  provider?: string | null;
}): string | null {
  const phone = channel.connectedPhone?.trim();
  if (!phone) return null;
  if (
    channel.provider === "uazapi" &&
    (phone === channel.providerChannelId?.trim() ||
      phone === channel.organizationId?.trim())
  ) {
    return null;
  }
  return phoneIdentityKey(phone) ?? null;
}

export type WorkspaceScopeChannelScan = {
  channels: ScopedChannel[];
  /**
   * True past PROVIDER_RULE_SCOPE_CHANNEL_LIMIT: `channels` is then cut at the
   * limit and must never be used to evaluate a global rule.
   */
  limitExceeded: boolean;
};

/**
 * Every live channel of the workspace with its connection provider and phone.
 * Channels of removed connections, and of deleted (suspended) WhatsApp
 * instances, are never part of a dynamic scope. Pages through the workspace;
 * past PROVIDER_RULE_SCOPE_CHANNEL_LIMIT it stops, logs and reports
 * `limitExceeded` instead of throwing (callers then skip global rules and keep
 * evaluating specific ones).
 */
export async function scanWorkspaceScopeChannels(
  client: ChannelLookupClient,
  workspaceId: string,
): Promise<WorkspaceScopeChannelScan> {
  const result: ScopedChannel[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.inboundWebhookChannel.findMany({
      where: {
        workspaceId,
        connection: { is: { workspaceId, removedAt: null } },
        OR: [
          { whatsappInstanceId: null },
          { whatsappInstance: { is: { status: { not: "suspended" } } } },
        ],
      },
      select: {
        id: true,
        connectionId: true,
        organizationId: true,
        providerChannelId: true,
        status: true,
        createdAt: true,
        connectedPhone: true,
        connection: { select: { provider: true, status: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: PROVIDER_RULE_SCOPE_CHANNEL_PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    for (const channel of page) {
      const provider = channel.connection?.provider ?? "";
      result.push({
        id: channel.id,
        connectionId: channel.connectionId,
        provider,
        phoneKey: channelPhoneKey({ ...channel, provider }),
        status: channel.status,
        createdAt: channel.createdAt,
        productionReady:
          channel.status === "active" &&
          channel.connection?.status === "production",
      });
    }
    if (result.length > PROVIDER_RULE_SCOPE_CHANNEL_LIMIT) {
      scopeLogger.warn(
        JSON.stringify({
          event: "provider_rule_scope_channel_limit",
          workspaceId,
          limit: PROVIDER_RULE_SCOPE_CHANNEL_LIMIT,
        }),
      );
      return {
        channels: result.slice(0, PROVIDER_RULE_SCOPE_CHANNEL_LIMIT),
        limitExceeded: true,
      };
    }
    if (page.length < PROVIDER_RULE_SCOPE_CHANNEL_PAGE)
      return { channels: result, limitExceeded: false };
    cursor = page[page.length - 1]!.id;
  }
}

/**
 * Channels for display (DTOs, "Unificar" preview). Past the limit the list is
 * cut at PROVIDER_RULE_SCOPE_CHANNEL_LIMIT (logged); evaluation paths use
 * `scanWorkspaceScopeChannels` and skip global rules instead.
 */
export async function listWorkspaceScopeChannels(
  client: ChannelLookupClient,
  workspaceId: string,
): Promise<ScopedChannel[]> {
  return (await scanWorkspaceScopeChannels(client, workspaceId)).channels;
}

/** Channels of the same phone as `channelId` (itself included). */
export function samePhoneChannels(
  channels: readonly ScopedChannel[],
  channelId: string,
): ScopedChannel[] {
  const self = channels.find((channel) => channel.id === channelId);
  if (!self) return [];
  if (!self.phoneKey) return [self];
  return channels.filter((channel) => channel.phoneKey === self.phoneKey);
}

/**
 * Channel ids a rule may resolve an occurrence to (scope only, precedence is
 * applied once the channel is known). Specific rules answer without a query.
 */
export async function resolveProviderRuleScopeChannelIds(
  client: ChannelLookupClient,
  workspaceId: string,
  rule: ScopedProviderRule,
): Promise<string[]> {
  if (providerRuleScope(rule) === "specific_numbers") {
    return rule.channels.map((scope) => scope.channelId);
  }
  const scan = await scanWorkspaceScopeChannels(client, workspaceId);
  if (scan.limitExceeded) {
    // The global rule is skipped (logged by the scan): never a partial scope.
    return [];
  }
  return scan.channels
    .filter((channel) => providerRuleCoversChannel(rule, channel))
    .map((channel) => channel.id);
}

type RuleLookupClient = Pick<
  Prisma.TransactionClient,
  "providerConversionRuleConfig"
>;

const peerRuleSelect = {
  id: true,
  scope: true,
  connectionId: true,
  removedAt: true,
  messageAuthorScope: true,
  conversionRule: {
    select: { triggerType: true, eventName: true, active: true },
  },
  parserRelease: { select: { provider: true } },
  connection: { select: { provider: true } },
  channels: { select: { channelId: true } },
} satisfies Prisma.ProviderConversionRuleConfigSelect;

/** Active specific rules of the given triggers scoped to any of the channels. */
async function loadSpecificPeerRules(
  client: RuleLookupClient,
  input: { workspaceId: string; channelIds: string[]; triggerTypes: string[] },
): Promise<ScopedProviderRule[]> {
  if (input.channelIds.length === 0 || input.triggerTypes.length === 0)
    return [];
  return client.providerConversionRuleConfig.findMany({
    where: {
      workspaceId: input.workspaceId,
      removedAt: null,
      scope: "specific_numbers",
      conversionRule: {
        active: true,
        triggerType: { in: input.triggerTypes as never[] },
      },
      channels: { some: { channelId: { in: input.channelIds } } },
    },
    select: peerRuleSelect,
    take: 200,
  });
}

/**
 * Scope + precedence for one occurrence channel, phone-aware. Rule sets
 * without any live global rule (every rule created before this phase) take
 * the synchronous path and issue no query at all.
 */
export async function resolveApplicableProviderRules<
  R extends ScopedProviderRule,
>(
  client: ChannelLookupClient & RuleLookupClient,
  input: { workspaceId: string; rules: readonly R[]; channel: ScopedChannel },
): Promise<ProviderRuleApplicability<R>> {
  const globals = input.rules.filter(
    (rule) => isLiveRule(rule) && providerRuleScope(rule) === "all_numbers",
  );
  if (globals.length === 0) {
    return selectApplicableProviderRules(input.rules, input.channel);
  }
  const scan = await scanWorkspaceScopeChannels(client, input.workspaceId);
  if (scan.limitExceeded) {
    // Specific rules keep running; global rules are skipped (never evaluated
    // on a partial view of the phone's channels).
    const result = selectApplicableProviderRules(
      input.rules.filter((rule) => providerRuleScope(rule) !== "all_numbers"),
      input.channel,
    );
    scopeLogger.warn(
      JSON.stringify({
        event: "provider_rule_global_skipped",
        reason: "scope_channel_limit",
        workspaceId: input.workspaceId,
        channelId: input.channel.id,
        providerRuleIds: globals.map((rule) => rule.id),
      }),
    );
    return {
      ...result,
      skippedGlobal: globals.map((rule) => ({
        rule,
        reason: "scope_channel_limit" as const,
      })),
    };
  }
  const channels = scan.channels;
  const phoneChannels = samePhoneChannels(channels, input.channel.id).map(
    (candidate) =>
      // The occurrence knows its own provider/connection for sure.
      candidate.id === input.channel.id
        ? { ...candidate, ...input.channel, phoneKey: candidate.phoneKey }
        : candidate,
  );
  const self =
    phoneChannels.find((candidate) => candidate.id === input.channel.id) ??
    input.channel;
  const siblingIds = phoneChannels
    .map((candidate) => candidate.id)
    .filter((id) => id !== input.channel.id);
  const peerRules = await loadSpecificPeerRules(client, {
    workspaceId: input.workspaceId,
    channelIds: siblingIds,
    triggerTypes: [
      ...new Set(globals.map((rule) => rule.conversionRule.triggerType)),
    ],
  });
  return selectApplicableProviderRules(input.rules, self, {
    phoneChannels,
    peerRules,
  });
}

/**
 * For an all_numbers rule whose occurrence resolved to `channelId`: the active
 * specific rules of the same origin and event that own that channel, or any
 * channel of the same phone. Empty for specific rules (never overridden).
 */
export async function findOverridingSpecificRuleIds(
  client: ChannelLookupClient & RuleLookupClient,
  input: { workspaceId: string; rule: ScopedProviderRule; channelId: string },
): Promise<string[]> {
  if (providerRuleScope(input.rule) !== "all_numbers") return [];
  const origin = providerRuleOrigin(input.rule);
  if (!origin) return [];
  const scan = await scanWorkspaceScopeChannels(client, input.workspaceId);
  // Past the channel limit only the channel itself is checked.
  const phoneChannelIds = scan.limitExceeded
    ? [input.channelId]
    : samePhoneChannels(scan.channels, input.channelId).map(
        (channel) => channel.id,
      );
  const channelIds = [...new Set([input.channelId, ...phoneChannelIds])];
  const candidates = await client.providerConversionRuleConfig.findMany({
    where: {
      workspaceId: input.workspaceId,
      id: { not: input.rule.id },
      removedAt: null,
      scope: "specific_numbers",
      conversionRule: {
        active: true,
        triggerType: input.rule.conversionRule.triggerType as never,
        eventName: input.rule.conversionRule.eventName,
      },
      channels: {
        some:
          channelIds.length === 1
            ? { channelId: input.channelId }
            : { channelId: { in: channelIds } },
      },
    },
    select: {
      id: true,
      conversionRule: { select: { triggerType: true, eventName: true } },
      parserRelease: { select: { provider: true } },
      connection: { select: { provider: true } },
    },
    take: 20,
  });
  return candidates
    .filter((candidate) => providerRuleOrigin(candidate) === origin)
    .map((candidate) => candidate.id);
}
