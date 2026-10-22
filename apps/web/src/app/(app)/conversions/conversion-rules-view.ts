import type {
  ConversionEventNameDto,
  InboundWebhookChannelDto,
  InboundWebhookConnectionDto,
  ProviderConversionRuleCapabilitiesDto,
  ProviderConversionRuleDto,
  ProviderConversionRuleOriginDto,
} from "@wpptrack/shared";
import type { KommoConnectionDetailDto } from "../integrations/kommo-actions";
import type { PipedriveConnectionDetailDto } from "../integrations/pipedrive-actions";
import { ruleEventLabel, ruleEventLabelForOrigin } from "./event-copy";
import {
  crmManageHref,
  contactMessageProviders,
  hubProviderForInbound,
  originBetaEvents,
  originChannelProviders,
  providerLogo,
  ruleOriginDefinition,
  ruleOriginDefinitions,
  type CrmRuleOrigin,
  type RuleLogo,
  type RuleOriginDefinition,
  type RuleOriginId,
} from "./conversion-origins";

/**
 * Server-safe view model of the Conversions screen: every rule of the
 * workspace (provider rules + CRM rules) as one flat, filterable list.
 * Pure functions only, so the page, the client screen and the tests share
 * exactly the same wording and decisions.
 */

/** One WhatsApp number (inbound channel) of the workspace. */
export type ConversionNumber = {
  id: string;
  connectionId: string;
  provider: string;
  connectionName: string;
  /** Name given in the provider, else the phone. */
  label: string;
  phone: string;
  whatsappInstanceId: string | null;
  /** Route ids of the number (CRM authorizations may point to them). */
  routeIds: string[];
  status: InboundWebhookChannelDto["status"];
};

export type ConversionConnection = Pick<
  InboundWebhookConnectionDto,
  "id" | "provider" | "displayName" | "status"
>;

export function toConversionNumbers(
  connections: Array<{
    connection: ConversionConnection;
    channels: InboundWebhookChannelDto[];
  }>,
): ConversionNumber[] {
  return connections.flatMap(({ connection, channels }) =>
    channels.map((channel) => ({
      id: channel.id,
      connectionId: channel.connectionId,
      provider: connection.provider,
      connectionName: connection.displayName,
      label: channel.channelName ?? channel.connectedPhone,
      phone: channel.connectedPhone,
      whatsappInstanceId: channel.whatsappInstanceId,
      routeIds: channel.routes.map((route) => route.id),
      status: channel.status,
    })),
  );
}

export type RuleStatus = "observation" | "production" | "paused" | "unified";

export const ruleStatusLabels: Record<RuleStatus, string> = {
  observation: "Observação",
  production: "Envio automático",
  paused: "Pausada",
  unified: "Unificada",
};

export type RuleScopeKind = "all_numbers" | "specific_numbers";

export type RuleRowExecution = {
  label: string;
  occurredAt: string;
  tone: "ok" | "warn" | "bad" | "neutral";
};

export type ConversionRuleRow = {
  key: string;
  kind: "provider" | "crm";
  id: string;
  name: string;
  origin: RuleOriginId;
  originLabel: string;
  /** Platform behind the origin (e.g. "Umbler Talk", "Vários canais"). */
  platformLabel: string | null;
  logo: RuleLogo | null;
  eventName: ConversionEventNameDto;
  eventLabel: string;
  /** Evento ainda em beta na origem (selo “beta” ao lado do evento). */
  eventBeta?: boolean;
  /** What triggers it, in one short line (phrase, tag, stage...). */
  triggerDetail: string | null;
  scope: RuleScopeKind;
  scopeLabel: string;
  /** Numbers the rule is (or would be) evaluated on: drives the filter. */
  numberIds: string[];
  /** CRM rules of the whole account match every number. */
  appliesToAllNumbers: boolean;
  status: RuleStatus;
  statusLabel: string;
  /** "Substituída no número X" and friends. */
  notes: string[];
  /** Avisos que pedem atenção (ex.: regra ativa que não vale em nenhum número). */
  warnings: string[];
  lastExecution: RuleRowExecution | null;
  /** CRM rules: where they are managed today. */
  manageHref: string | null;
  connectionId: string | null;
  mode: "observation" | "production" | null;
  active: boolean;
};

// ---------------------------------------------------------------------------
// Provider rules
// ---------------------------------------------------------------------------

export function providerRuleOrigin(
  rule: ProviderConversionRuleDto,
  connectionsById: ReadonlyMap<string, ConversionConnection>,
): ProviderConversionRuleOriginDto {
  if (rule.origin) return rule.origin;
  if (rule.automationSource === "payt") return "automation_payt";

  switch (rule.conversionRule.triggerType) {
    case "message_phrase":
      return "message_phrase";
    case "structured_catalog":
      return "structured_catalog";
    default: {
      const provider = rule.connectionId
        ? connectionsById.get(rule.connectionId)?.provider
        : null;
      if (provider === "umbler") return "automation_umbler";
      if (provider === "unnichat") return "automation_unnichat";
      return "whatsapp_label";
    }
  }
}

export function providerRuleStatus(rule: ProviderConversionRuleDto): RuleStatus {
  if (!rule.conversionRule.active) {
    return rule.unifiedIntoRuleId ? "unified" : "paused";
  }

  return rule.mode === "production" ? "production" : "observation";
}

/** "Recepção, Comercial e mais 2" (unknown ids read "número removido"). */
export function numberNames(
  ids: readonly string[],
  numbersById: ReadonlyMap<string, ConversionNumber>,
  max = 3,
): string {
  const names = ids.map((id) => numbersById.get(id)?.label ?? "número removido");

  if (names.length <= max) {
    return joinNames(names);
  }

  return `${names.slice(0, max).join(", ")} e mais ${names.length - max}`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

const executionLabels: Record<
  NonNullable<ProviderConversionRuleDto["lastExecution"]>["status"],
  { label: string; tone: RuleRowExecution["tone"] }
> = {
  observed: { label: "Reconhecida em observação", tone: "neutral" },
  eligible: { label: "Na fila de envio", tone: "neutral" },
  materialized: { label: "Evento enviado", tone: "ok" },
  duplicate: { label: "Repetida, não reenviada", tone: "warn" },
  blocked: { label: "Bloqueada", tone: "warn" },
  failed: { label: "Falhou", tone: "bad" },
};

/**
 * Avisos de uma regra de provedor. Um só ponto para somar avisos novos que a
 * API passar a informar (ex.: telefone cujo canal principal está em
 * observação enquanto outro canal do mesmo telefone já envia).
 */
export function providerRuleWarnings(input: {
  status: RuleStatus;
  numberIds: readonly string[];
  observationCanonicalChannels?: ReadonlyArray<{ canonicalChannelId: string }>;
  numbersById?: ReadonlyMap<string, ConversionNumber>;
}): string[] {
  const warnings: string[] = [];

  if (
    input.status !== "paused" &&
    input.status !== "unified" &&
    input.observationCanonicalChannels?.length
  ) {
    warnings.push(
      observationCanonicalWarning(
        input.observationCanonicalChannels.map((item) => item.canonicalChannelId),
        input.numbersById ?? new Map(),
      ),
    );
  }

  if (
    (input.status === "production" || input.status === "observation") &&
    input.numberIds.length === 0
  ) {
    warnings.push(
      "Esta regra não vale em nenhum número agora: conecte um número compatível ou ajuste o alcance.",
    );
  }

  return warnings;
}

/** Telefone cuja regra global roda num canal em observação enquanto outro canal já envia. */
export function observationCanonicalWarning(
  channelIds: readonly string[],
  numbersById: ReadonlyMap<string, ConversionNumber>,
): string {
  const where = numberNames(channelIds, numbersById);
  return `Em ${where}: a regra global roda no canal em observação; outro canal do mesmo número está em produção.`;
}

function triggerDetailForProviderRule(
  rule: ProviderConversionRuleDto,
  origin: ProviderConversionRuleOriginDto,
): string | null {
  const phrases = rule.triggerPhrases;
  const firstWithMore = (prefix: string) =>
    phrases.length === 0
      ? null
      : `${prefix}“${phrases[0]}”${phrases.length > 1 ? ` +${phrases.length - 1}` : ""}`;

  switch (origin) {
    case "message_phrase":
      return firstWithMore("Frase ");
    case "whatsapp_label":
      return firstWithMore("Etiqueta ");
    case "structured_catalog":
      return rule.catalog
        ? `Catálogo “${rule.catalog.name}”`
        : firstWithMore("Frase ");
    case "automation_umbler":
      return rule.endpoint ? "Endereço da automação criado" : null;
    case "automation_payt":
      return rule.endpoint ? "URL de postback criada" : null;
    case "automation_unnichat":
      return rule.endpoint ? "URL da regra criada" : null;
  }
}

function originNumberIds(
  definition: RuleOriginDefinition,
  numbers: readonly ConversionNumber[],
  connectionId: string | null,
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
): string[] {
  const providers = originChannelProviders(definition.id, capabilities);

  return numbers
    .filter(
      (number) =>
        providers.includes(number.provider) &&
        (definition.connection !== "same_provider" ||
          number.connectionId === connectionId),
    )
    .map((number) => number.id);
}

function platformForNumbers(
  ids: readonly string[],
  numbersById: ReadonlyMap<string, ConversionNumber>,
): { label: string | null; logo: RuleLogo | null } {
  const providers = [
    ...new Set(
      ids
        .map((id) => numbersById.get(id)?.provider)
        .filter((provider): provider is string => Boolean(provider)),
    ),
  ];

  if (providers.length === 1) {
    const hubId = hubProviderForInbound(providers[0]!);
    if (hubId) {
      const logo = providerLogo(hubId);
      return { label: logo.name, logo };
    }
  }

  return { label: providers.length > 1 ? "Vários canais" : null, logo: null };
}

export function buildProviderRuleRows(
  rules: readonly ProviderConversionRuleDto[],
  numbers: readonly ConversionNumber[],
  connections: readonly ConversionConnection[],
  capabilities: ProviderConversionRuleCapabilitiesDto | null = null,
): ConversionRuleRow[] {
  const numbersById = new Map(numbers.map((number) => [number.id, number]));
  const connectionsById = new Map(
    connections.map((connection) => [connection.id, connection]),
  );
  const origins = new Map(
    rules.map((rule) => [rule.id, providerRuleOrigin(rule, connectionsById)]),
  );
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));

  return rules.map((rule) => {
    const origin = origins.get(rule.id)!;
    const definition = ruleOriginDefinition(origin);
    const scope = rule.scope ?? "specific_numbers";
    const status = providerRuleStatus(rule);
    const eventName = rule.conversionRule.eventName;
    const connection = rule.connectionId
      ? connectionsById.get(rule.connectionId)
      : undefined;
    const notes: string[] = [];
    let numberIds: string[];
    let scopeLabel: string;

    if (scope === "all_numbers") {
      const covered = [
        ...(rule.effectiveChannelIds ?? []),
        ...(rule.overriddenChannelIds ?? []),
        ...(rule.duplicatePhoneChannelIds ?? []),
      ];
      numberIds =
        covered.length > 0 || rule.conversionRule.active
          ? [...new Set(covered)]
          : originNumberIds(definition, numbers, rule.connectionId, capabilities);
      scopeLabel =
        definition.connection === "same_provider" && connection
          ? `Todos os números de ${connection.displayName}`
          : "Todos os números";

      if (rule.overriddenChannelIds?.length) {
        notes.push(
          `Substituída em ${numberNames(rule.overriddenChannelIds, numbersById)}: ali vale a regra específica do número.`,
        );
      }
      if (rule.duplicatePhoneChannelIds?.length) {
        notes.push(
          `${numberNames(rule.duplicatePhoneChannelIds, numbersById)} tem o mesmo telefone de outro número conectado: o evento sai uma vez só.`,
        );
      }
    } else {
      numberIds = [...rule.channelIds];
      scopeLabel =
        rule.channelIds.length > 0
          ? numberNames(rule.channelIds, numbersById)
          : "Nenhum número";

      if (rule.conversionRule.active) {
        const replaced = rules
          .filter(
            (other) =>
              other.id !== rule.id &&
              other.scope === "all_numbers" &&
              other.conversionRule.active &&
              other.conversionRule.eventName === eventName &&
              origins.get(other.id) === origin,
          )
          .flatMap((other) => other.overriddenChannelIds ?? [])
          .filter((channelId) => rule.channelIds.includes(channelId));
        if (replaced.length > 0) {
          notes.push(
            `Vale no lugar da regra para todos os números em ${numberNames([...new Set(replaced)], numbersById)}.`,
          );
        }
      }
    }

    if (status === "unified" && rule.unifiedIntoRuleId) {
      const target = rulesById.get(rule.unifiedIntoRuleId);
      notes.push(
        target
          ? `Unificada em “${target.conversionRule.name}”, que vale para todos os números.`
          : "Unificada em uma regra para todos os números.",
      );
    }

    const platform = definition.logoProvider
      ? {
          label: providerLogo(definition.logoProvider).name,
          logo: providerLogo(definition.logoProvider),
        }
      : platformForNumbers(
          scope === "all_numbers"
            ? originNumberIds(definition, numbers, rule.connectionId, capabilities)
            : rule.channelIds,
          numbersById,
        );
    const execution = rule.lastExecution;

    return {
      key: `provider:${rule.id}`,
      kind: "provider",
      id: rule.id,
      name: rule.conversionRule.name,
      origin,
      originLabel: definition.label,
      platformLabel:
        definition.connection === "same_provider" && connection
          ? connection.displayName
          : platform.label,
      logo: platform.logo,
      eventName,
      eventLabel: ruleEventLabelForOrigin(origin, eventName),
      eventBeta: originBetaEvents(origin, capabilities).includes(eventName),
      triggerDetail: triggerDetailForProviderRule(rule, origin),
      scope,
      scopeLabel,
      numberIds,
      appliesToAllNumbers: false,
      status,
      statusLabel: ruleStatusLabels[status],
      notes,
      warnings: providerRuleWarnings({
        status,
        numberIds,
        observationCanonicalChannels: rule.observationCanonicalChannels,
        numbersById,
      }),
      lastExecution: execution
        ? {
            label: executionLabels[execution.status].label,
            tone: executionLabels[execution.status].tone,
            occurredAt: execution.occurredAt,
          }
        : null,
      manageHref: null,
      connectionId: rule.connectionId,
      mode: rule.mode,
      active: rule.conversionRule.active,
    };
  });
}

// ---------------------------------------------------------------------------
// Regras do CRM (só leitura aqui; editadas na janela do CRM no Hub)
// ---------------------------------------------------------------------------

export type CrmRulesInput = {
  kommo: KommoConnectionDetailDto[];
  pipedrive: PipedriveConnectionDetailDto[];
};

function authorizedNumberIds(
  allowedIds: readonly string[],
  numbers: readonly ConversionNumber[],
): string[] {
  return numbers
    .filter(
      (number) =>
        allowedIds.includes(number.id) ||
        number.routeIds.some((routeId) => allowedIds.includes(routeId)),
    )
    .map((number) => number.id);
}

function crmStatus(input: {
  active: boolean;
  mode: "observation" | "production";
  connectionActive: boolean;
}): RuleStatus {
  if (!input.active || !input.connectionActive) return "paused";
  return input.mode === "production" ? "production" : "observation";
}

function crmRow(input: {
  origin: CrmRuleOrigin;
  id: string;
  name: string;
  eventName: ConversionEventNameDto;
  triggerDetail: string | null;
  status: RuleStatus;
  mode: "observation" | "production" | null;
  active: boolean;
  scope: RuleScopeKind;
  scopeLabel: string;
  numberIds: string[];
  appliesToAllNumbers: boolean;
  connectionName: string | null;
}): ConversionRuleRow {
  const definition = ruleOriginDefinition(input.origin);
  const logo = definition.logoProvider
    ? providerLogo(definition.logoProvider)
    : null;

  return {
    key: `${input.origin}:${input.id}`,
    kind: "crm",
    id: input.id,
    name: input.name,
    origin: input.origin,
    originLabel: definition.label,
    platformLabel: input.connectionName ?? logo?.name ?? null,
    logo,
    eventName: input.eventName,
    eventLabel: ruleEventLabel(input.eventName),
    triggerDetail: input.triggerDetail,
    scope: input.scope,
    scopeLabel: input.scopeLabel,
    numberIds: input.numberIds,
    appliesToAllNumbers: input.appliesToAllNumbers,
    status: input.status,
    statusLabel: ruleStatusLabels[input.status],
    notes: [],
    warnings: [],
    lastExecution: null,
    manageHref: crmManageHref(input.origin),
    connectionId: null,
    mode: input.mode,
    active: input.active,
  };
}

function crmScope(
  allowedIds: readonly string[],
  numbers: readonly ConversionNumber[],
): Pick<ConversionRuleRow, "scope" | "scopeLabel" | "numberIds"> {
  const ids = authorizedNumberIds(allowedIds, numbers);
  const numbersById = new Map(numbers.map((number) => [number.id, number]));

  return {
    scope: "specific_numbers",
    scopeLabel:
      ids.length > 0
        ? numberNames(ids, numbersById)
        : "Nenhum número autorizado ainda",
    numberIds: ids,
  };
}

export function buildCrmRuleRows(
  crm: CrmRulesInput,
  numbers: readonly ConversionNumber[],
): ConversionRuleRow[] {
  const rows: ConversionRuleRow[] = [];

  for (const connection of crm.kommo) {
    const scope = crmScope(connection.allowedChannelRouteIds, numbers);
    for (const rule of connection.rules) {
      const stage = connection.pipelines.find(
        (row) => row.id === rule.pipelineId && row.status.id === rule.statusId,
      );
      rows.push(
        crmRow({
          origin: "kommo",
          id: rule.id,
          name: rule.name,
          eventName: rule.eventName,
          triggerDetail: stage
            ? `Etapa “${stage.status.name}” em ${stage.name}`
            : null,
          status: crmStatus({
            active: rule.active,
            mode: rule.mode,
            connectionActive: connection.status === "active",
          }),
          mode: rule.mode,
          active: rule.active,
          ...scope,
          appliesToAllNumbers: false,
          connectionName: connection.displayName,
        }),
      );
    }
  }

  for (const connection of crm.pipedrive) {
    const scope = crmScope(connection.allowedChannelRouteIds, numbers);
    for (const rule of connection.rules) {
      const pipeline = connection.pipelines.find(
        (item) => item.id === rule.pipelineId,
      );
      const stage = pipeline?.stages.find((item) => item.id === rule.stageId);
      rows.push(
        crmRow({
          origin: "pipedrive",
          id: rule.id,
          name: rule.name,
          eventName: rule.eventName,
          triggerDetail:
            rule.trigger === "deal_won"
              ? "Negócio ganho"
              : stage
                ? `Etapa “${stage.name}”${pipeline ? ` em ${pipeline.name}` : ""}`
                : null,
          status: crmStatus({
            active: rule.active,
            mode: rule.mode,
            connectionActive: connection.status === "active",
          }),
          mode: rule.mode,
          active: rule.active,
          ...scope,
          appliesToAllNumbers: false,
          connectionName: connection.displayName,
        }),
      );
    }
  }

  return rows;
}

const statusOrder: Record<RuleStatus, number> = {
  production: 0,
  observation: 1,
  paused: 2,
  unified: 3,
};

/** Live rules first, then paused/unified; inside each, by origin then name. */
export function sortRuleRows(rows: readonly ConversionRuleRow[]): ConversionRuleRow[] {
  const originOrder = new Map(
    ruleOriginDefinitions.map((definition, index) => [definition.id, index]),
  );
  const live = (row: ConversionRuleRow) =>
    row.status === "paused" || row.status === "unified" ? 1 : 0;

  return [...rows].sort(
    (left, right) =>
      live(left) - live(right) ||
      (originOrder.get(left.origin) ?? 0) - (originOrder.get(right.origin) ?? 0) ||
      statusOrder[left.status] - statusOrder[right.status] ||
      left.name.localeCompare(right.name, "pt-BR"),
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type RuleStatusFilter =
  | "all"
  | "production"
  | "observation"
  | "paused"
  | "unified";

export type RuleFilters = {
  origin: RuleOriginId | "all";
  numberId: string;
  eventName: string;
  status: RuleStatusFilter;
};

export const emptyRuleFilters: RuleFilters = {
  origin: "all",
  numberId: "all",
  eventName: "all",
  status: "all",
};

export function filterRuleRows(
  rows: readonly ConversionRuleRow[],
  filters: RuleFilters,
): ConversionRuleRow[] {
  return rows.filter(
    (row) =>
      (filters.origin === "all" || row.origin === filters.origin) &&
      (filters.eventName === "all" || row.eventName === filters.eventName) &&
      (filters.numberId === "all" ||
        row.appliesToAllNumbers ||
        row.numberIds.includes(filters.numberId)) &&
      (filters.status === "all" || row.status === filters.status),
  );
}

export function activeFilterCount(filters: RuleFilters): number {
  return (Object.keys(emptyRuleFilters) as Array<keyof RuleFilters>).filter(
    (key) => filters[key] !== emptyRuleFilters[key],
  ).length;
}

// ---------------------------------------------------------------------------
// "Nova regra": which origins can be offered
// ---------------------------------------------------------------------------

export type OriginOfferInput = {
  numbers: readonly ConversionNumber[];
  connections: readonly ConversionConnection[];
  /** GET providers/capabilities; null: não deu para confirmar o que a API aceita. */
  capabilities: ProviderConversionRuleCapabilitiesDto | null;
  crm: Record<CrmRuleOrigin, boolean>;
};

/**
 * Só origens que a API diz que aceita (capabilities) E que têm uma integração
 * ativa por trás: frase e catálogo precisam de um número que lê mensagens,
 * etiqueta de um número Uazapi, automação da Umbler daquela conexão, CRM de
 * uma conexão. Sem resposta das capacidades, nada é oferecido.
 */
export function offeredRuleOrigins(input: OriginOfferInput): RuleOriginId[] {
  return ruleOriginDefinitions
    .filter((definition) => {
      if (definition.kind === "crm") {
        return input.crm[definition.id as CrmRuleOrigin];
      }
      if (!input.capabilities) return false;
      if (
        !input.capabilities.origins.some((item) => item.origin === definition.id)
      ) {
        return false;
      }
      const providers = originChannelProviders(definition.id, input.capabilities);
      if (definition.connection === "same_provider") {
        return input.connections.some(
          (connection) =>
            providers.includes(connection.provider) &&
            connection.status !== "paused",
        );
      }
      return input.numbers.some((number) => providers.includes(number.provider));
    })
    .map((definition) => definition.id);
}

/**
 * Números onde a origem roda (opcionalmente dentro de uma conexão).
 * `authorScope` "contact" restringe aos provedores que leem mensagens do
 * contato (hoje só a Umbler).
 */
export function numbersForOrigin(
  origin: RuleOriginId,
  numbers: readonly ConversionNumber[],
  connectionId: string | null = null,
  capabilities: ProviderConversionRuleCapabilitiesDto | null = null,
  authorScope: "team" | "contact" | "both" = "team",
): ConversionNumber[] {
  const definition = ruleOriginDefinition(origin);
  const providers =
    origin === "message_phrase" && authorScope === "contact"
      ? contactMessageProviders(capabilities)
      : originChannelProviders(origin, capabilities);

  return numbers.filter(
    (number) =>
      providers.includes(number.provider) &&
      (definition.connection !== "same_provider" ||
        connectionId === null ||
        number.connectionId === connectionId),
  );
}

/** Conexões que hospedam uma automação por endereço desta origem. */
export function connectionsForOrigin(
  origin: RuleOriginId,
  connections: readonly ConversionConnection[],
  capabilities: ProviderConversionRuleCapabilitiesDto | null = null,
): ConversionConnection[] {
  const definition = ruleOriginDefinition(origin);
  if (definition.connection !== "same_provider") return [];
  const providers = originChannelProviders(origin, capabilities);

  return connections.filter((connection) =>
    providers.includes(connection.provider),
  );
}

/**
 * Números conectados que NENHUMA origem avalia ainda (Gupshup, Data Crazy,
 * WhatsApp Cloud API: só geram leads pelo webhook de entrada). Aparecem como
 * nota neutra no alcance (as conversões chegam pelo webhook do provedor),
 * nunca como escolha e nunca como "Em breve".
 */
export function ineligibleNumbers(
  numbers: readonly ConversionNumber[],
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
  /**
   * A venda da Payt roda em qualquer número de WhatsApp, então ela não conta
   * como "origem que avalia o número" na nota geral; na própria regra da
   * Payt vale a lista dela.
   */
  origin: RuleOriginId | null = null,
): ConversionNumber[] {
  if (!capabilities) return [];
  const supported = new Set(
    origin === "automation_payt"
      ? originChannelProviders(origin, capabilities)
      : capabilities.origins
          .filter((item) => item.origin !== "automation_payt")
          .flatMap((item) => item.channelProviders),
  );

  return numbers.filter((number) => !supported.has(number.provider));
}
