import type {
  ConversionEventNameDto,
  ProviderConversionRuleCapabilitiesDto,
  ProviderConversionRuleOriginDto,
} from "@wpptrack/shared";
import {
  integrationLogoPath,
  integrationProvider,
  type IntegrationProviderId,
} from "../integrations/hub/integration-registry";

/**
 * Origens de uma regra de conversão na tela Conversões. As origens de
 * provedor espelham a API (`providerConversionRuleOrigins`); a etapa do CRM
 * (Kommo, Pipedrive) é listada só para leitura e editada na janela do CRM no Hub.
 *
 * Em quais números cada origem roda NÃO é decidido aqui: vem de
 * GET /conversion-rules/providers/capabilities (`channelProviders`). A tabela
 * `fallbackChannelProviders` só existe para rotular regras já criadas quando a
 * API de capacidades não respondeu.
 */
export type CrmRuleOrigin = "kommo" | "pipedrive";
export type RuleOriginId = ProviderConversionRuleOriginDto | CrmRuleOrigin;

export type RuleOriginDefinition = {
  id: RuleOriginId;
  kind: "provider" | "crm";
  label: string;
  /** Uma linha, sem jargão: quando a regra dispara. */
  description: string;
  /** Logo exibido quando a origem é uma plataforma própria. */
  logoProvider: IntegrationProviderId | null;
  /**
   * Provedores dos números onde a origem roda, na matriz desta edição
   * (usada só se a API de capacidades não respondeu).
   */
  fallbackChannelProviders: readonly string[];
  /**
   * "same_provider": a automação por endereço fica presa à conexão que a
   * chama (Umbler); o alcance "todos os números" vale para essa conexão.
   * "any": a regra de venda (Payt) fica presa à conexão dos números
   * escolhidos, só como âncora da URL; a Payt não tem conexão própria.
   */
  connection: "none" | "same_provider" | "any";
  /** Evento fixo da origem. */
  lockedEvent?: ConversionEventNameDto;
  /** Eventos que a origem reconhece (padrão: todo o catálogo). */
  allowedEvents?: readonly ConversionEventNameDto[];
  /** Eventos ainda em beta nesta origem (selo “beta”); a API informa o atual. */
  betaEvents?: readonly ConversionEventNameDto[];
};

export const ruleOriginDefinitions: readonly RuleOriginDefinition[] = [
  {
    id: "message_phrase",
    kind: "provider",
    label: "Frase na conversa",
    description:
      "Quando a equipe (ou o contato, na Umbler) manda uma mensagem com a frase combinada.",
    logoProvider: null,
    fallbackChannelProviders: ["umbler", "uazapi"],
    connection: "none",
  },
  {
    id: "whatsapp_label",
    kind: "provider",
    label: "Etiqueta no WhatsApp",
    description:
      "Quando a equipe coloca uma etiqueta no contato, nos números conectados por QR code (Uazapi).",
    logoProvider: "uazapi_byo",
    fallbackChannelProviders: ["uazapi"],
    connection: "none",
  },
  {
    id: "structured_catalog",
    kind: "provider",
    label: "Pedido pelo catálogo",
    description:
      "Quando a mensagem traz um pedido com produto e preço do seu catálogo (Umbler).",
    logoProvider: null,
    fallbackChannelProviders: ["umbler"],
    connection: "none",
    lockedEvent: "Purchase",
  },
  {
    id: "automation_umbler",
    kind: "provider",
    label: "Automação da Umbler",
    description:
      "Quando uma automação do Umbler Talk chama o endereço do evento (vale para os números da conexão).",
    logoProvider: "umbler",
    fallbackChannelProviders: ["umbler"],
    connection: "same_provider",
    // O callback da Umbler só conhece estas duas automações.
    allowedEvents: ["QualifiedLead", "Purchase"],
  },
  {
    id: "automation_unnichat",
    kind: "provider",
    label: "Automação do Unnichat",
    description:
      "Quando um fluxo do Unnichat chama a URL da regra (vale para os números da conexão). Qualquer evento do catálogo.",
    logoProvider: "unnichat",
    fallbackChannelProviders: ["unnichat"],
    connection: "same_provider",
    // O evento vem da regra, nunca do corpo enviado pelo Unnichat: sem
    // lista de eventos, vale todo o catálogo.
  },
  {
    id: "automation_payt",
    kind: "provider",
    label: "Venda na Payt",
    description:
      "Quando a Payt avisa uma compra aprovada, um Pix/boleto gerado ou um carrinho abandonado de alguém que chegou pelo WhatsApp.",
    logoProvider: "payt",
    fallbackChannelProviders: [
      "umbler",
      "gupshup",
      "uazapi",
      "meta_cloud",
      "data_crazy",
      "unnichat",
    ],
    connection: "any",
    // O evento vem do status de cada venda; o valor vem da própria venda.
    allowedEvents: ["Purchase", "InitiateCheckout", "CartAbandoned"],
    betaEvents: ["CartAbandoned"],
  },
  {
    id: "kommo",
    kind: "crm",
    label: "Etapa no Kommo",
    description: "Quando o lead muda de etapa no funil do Kommo.",
    logoProvider: "kommo",
    fallbackChannelProviders: [],
    connection: "none",
  },
  {
    id: "pipedrive",
    kind: "crm",
    label: "Etapa ou negócio ganho no Pipedrive",
    description: "Quando o negócio avança de etapa ou é ganho no Pipedrive.",
    logoProvider: "pipedrive",
    fallbackChannelProviders: [],
    connection: "none",
  },
];

export function ruleOriginDefinition(id: RuleOriginId): RuleOriginDefinition {
  const definition = ruleOriginDefinitions.find((item) => item.id === id);

  if (!definition) {
    throw new Error(`Unknown rule origin: ${id}`);
  }

  return definition;
}

export function isRuleOriginId(value: unknown): value is RuleOriginId {
  return ruleOriginDefinitions.some((item) => item.id === value);
}

/** Provedores de número onde a origem roda (API de capacidades primeiro). */
export function originChannelProviders(
  origin: RuleOriginId,
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
): readonly string[] {
  const definition = ruleOriginDefinition(origin);
  if (definition.kind === "crm") return [];

  return (
    capabilities?.origins.find((item) => item.origin === origin)
      ?.channelProviders ?? definition.fallbackChannelProviders
  );
}

/**
 * Eventos que a origem reconhece, na ordem da tela. A API de capacidades
 * manda (`eventNames`); sem ela vale a lista da origem.
 */
export function originEventNames(
  origin: RuleOriginId,
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
): readonly ConversionEventNameDto[] | null {
  const definition = ruleOriginDefinition(origin);
  const fromApi = capabilities?.origins.find(
    (item) => item.origin === origin,
  )?.eventNames;

  return fromApi && fromApi.length > 0
    ? fromApi
    : (definition.allowedEvents ?? null);
}

/** Eventos em beta da origem (API primeiro; só a Payt tem hoje). */
export function originBetaEvents(
  origin: RuleOriginId,
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
): readonly ConversionEventNameDto[] {
  const fromApi = capabilities?.origins.find(
    (item) => item.origin === origin,
  )?.betaEventNames;

  return fromApi ?? ruleOriginDefinition(origin).betaEvents ?? [];
}

/** Provedores que leem mensagens do contato (regra "Só o contato"). */
export function contactMessageProviders(
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
): readonly string[] {
  const entry = capabilities?.origins.find(
    (item) => item.origin === "message_phrase",
  );
  return entry?.authorChannelProviders?.contact ?? ["umbler"];
}

export type RuleLogo = {
  src: string;
  surface: "dark" | "light";
  name: string;
};

export function providerLogo(id: IntegrationProviderId): RuleLogo {
  const provider = integrationProvider(id);

  return {
    src: integrationLogoPath(id),
    surface: provider.logoSurface,
    name: provider.name,
  };
}

/** Cartão do Hub de um provedor de entrada ("uazapi" é o cartão Uazapi). */
export function hubProviderForInbound(
  provider: string,
): IntegrationProviderId | null {
  switch (provider) {
    case "uazapi":
      return "uazapi_byo";
    case "umbler":
    case "gupshup":
    case "data_crazy":
    case "unnichat":
    case "meta_cloud":
      return provider;
    default:
      return null;
  }
}

/** Nome do provedor de um número, para avisos ("Gupshup", "WAHA"...). */
export function providerDisplayName(provider: string): string {
  switch (provider) {
    case "uazapi":
    case "uazapi_byo":
      return "Uazapi";
    case "waha":
      return "WAHA";
    case "zapi":
      return "Z-API";
    case "nod_api":
      return "NOD API";
    case "meta_cloud":
      return "WhatsApp Cloud API";
    case "umbler":
      return "Umbler Talk";
    case "gupshup":
      return "Gupshup";
    case "data_crazy":
      return "Data Crazy";
    case "unnichat":
      return "Unnichat";
    default:
      return provider;
  }
}

/** Onde as regras do CRM são editadas: janela do CRM no Hub (aba CRM). */
export function crmManageHref(origin: CrmRuleOrigin): string {
  return `/integrations?abrir=${origin}`;
}
