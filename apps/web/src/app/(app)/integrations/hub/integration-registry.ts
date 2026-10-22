/**
 * Catalog of the integrations shown in the Integrations hub.
 *
 * Only providers the student backend implements end to end appear here.
 * Adding a provider later (Go High Level, ...) is one entry:
 *   1. add its id to `integrationProviderIds`;
 *   2. add a logo file in `public/integrations/` and a row in `logoAssets`
 *      (and in SOURCES.md);
 *   3. add its definition to `integrationProviders` with a `gate` the cards
 *      builder already understands (or a new gate kind + decision);
 *   4. give the page a modal panel for that id.
 * Logos live in `apps/web/public/integrations/`; replacing a file with the
 * same name needs no code change.
 */

export const integrationCategories = [
  "whatsapp_number",
  "whatsapp_official",
  "attendance",
  "ads",
  "crm",
] as const;

export type IntegrationCategory = (typeof integrationCategories)[number];

export const integrationTabIds = [
  "whatsapp",
  "attendance",
  "ads",
  "crm",
] as const;

export type IntegrationTabId = (typeof integrationTabIds)[number];

export type IntegrationTabDefinition = {
  id: IntegrationTabId;
  label: string;
  /** Value accepted in `?aba=` deep links. */
  query: string;
  /** Extra `?aba=` values that also select this tab. */
  aliases: readonly string[];
  /** Hash that selects the tab (`#integracao-whatsapp`, ...). */
  hash: string;
  /** Older hashes that still select this tab. */
  hashAliases: readonly string[];
  description: string;
  categories: readonly IntegrationCategory[];
};

export const integrationTabs: readonly IntegrationTabDefinition[] = [
  {
    id: "whatsapp",
    label: "WhatsApp",
    query: "whatsapp",
    aliases: [],
    hash: "integracao-whatsapp",
    hashAliases: [],
    description:
      "Por onde as conversas dos anúncios chegam: a sua instância Uazapi ou a API oficial do WhatsApp (Cloud API), conectada direto à Meta. WAHA, Z-API e NOD API estão em breve.",
    categories: ["whatsapp_number", "whatsapp_official"],
  },
  {
    id: "attendance",
    label: "Atendimento e vendas",
    query: "atendimento",
    aliases: ["conversoes", "vendas"],
    hash: "integracao-atendimento",
    hashAliases: ["integracao-conversoes"],
    description:
      "As plataformas de atendimento e vendas que entregam as mensagens dos anúncios para o RastrackDash.",
    categories: ["attendance"],
  },
  {
    id: "ads",
    label: "Anúncios",
    query: "anuncios",
    aliases: [],
    hash: "integracao-anuncios",
    hashAliases: [],
    description:
      "A conta de anúncios da Meta: traz os dados de tráfego, cruza com os seus leads e envia as conversões para a Meta (CAPI). Não recebe conversas.",
    categories: ["ads"],
  },
  {
    id: "crm",
    label: "CRM",
    query: "crm",
    aliases: [],
    hash: "integracao-crm",
    hashAliases: [],
    description:
      "Quando o lead avança no funil do CRM, a conversão chega à Meta. Conectado uma vez para a conta inteira.",
    categories: ["crm"],
  },
];

export const integrationCategoryLabels: Record<IntegrationCategory, string> = {
  whatsapp_number: "Instância WhatsApp",
  whatsapp_official: "API oficial da Meta",
  attendance: "Atendimento e vendas",
  ads: "Anúncios (Meta Ads)",
  crm: "CRM",
};

export const integrationProviderIds = [
  "uazapi_byo",
  "nod_api",
  "waha",
  "zapi",
  "meta_cloud",
  "umbler",
  "gupshup",
  "data_crazy",
  "unnichat",
  "payt",
  "kommo",
  "pipedrive",
  "meta",
] as const;

export type IntegrationProviderId = (typeof integrationProviderIds)[number];

/** WhatsApp instance providers managed by `WhatsappProviderPanel`. */
export type WhatsappIntegrationProvider =
  "uazapi_byo" | "nod_api" | "waha" | "zapi";

/** Inbound webhook providers (`InboundWebhookPanel`, scoped to one). */
export type InboundIntegrationProvider =
  "meta_cloud" | "umbler" | "gupshup" | "data_crazy" | "unnichat";

export type CrmIntegrationProvider = "kommo" | "pipedrive";

/**
 * Decides when a card is offered at all. Every gate reads data the API
 * already returns — no gate is a hardcoded allowlist.
 */
export type IntegrationGate =
  /** WhatsApp instance providers: always offered; active with connections. */
  | { kind: "whatsapp_provider"; provider: WhatsappIntegrationProvider }
  /** Shown when the API offers creation for it or a connection exists. */
  | { kind: "inbound_provider"; provider: InboundIntegrationProvider }
  | { kind: "crm"; provider: CrmIntegrationProvider }
  /**
   * Payt has no connection of its own: it is a conversion-rule origin in
   * Conversões (the Payt postback calls the rule's URL). Always offered; the
   * state comes from the Payt rules the workspace already has.
   */
  | { kind: "payt_rules" }
  | { kind: "always" };

export type IntegrationProviderDefinition = {
  id: IntegrationProviderId;
  name: string;
  category: IntegrationCategory;
  /** Public path of the logo (swap the file to change the artwork). */
  logo: string;
  /**
   * "Em breve": new connections are not offered yet. A provider that already
   * has connections stays manageable (existing data is never hidden).
   */
  comingSoon?: boolean;
  /** Shown instead of `description` while the card is "Em breve". */
  comingSoonDescription?: string;
  /** Short initials shown if the logo file is missing or fails to load. */
  initials: string;
  /**
   * Background the logo needs: official artwork with dark ink sits on a
   * light tile, light/colored artwork on the dark card.
   */
  logoSurface: "dark" | "light";
  description: string;
  gate: IntegrationGate;
};

type LogoAsset = { file: string; surface: "dark" | "light" };

/** Official logos where available; plain wordmark fallbacks otherwise. */
const logoAssets: Record<IntegrationProviderId, LogoAsset> = {
  uazapi_byo: { file: "uazapi.svg", surface: "dark" },
  nod_api: { file: "nod-api.svg", surface: "dark" },
  waha: { file: "waha.png", surface: "light" },
  zapi: { file: "zapi.svg", surface: "dark" },
  meta_cloud: { file: "meta.svg", surface: "dark" },
  umbler: { file: "umbler.svg", surface: "light" },
  gupshup: { file: "gupshup.svg", surface: "light" },
  data_crazy: { file: "datacrazy.svg", surface: "dark" },
  unnichat: { file: "unnichat.png", surface: "light" },
  payt: { file: "payt.svg", surface: "dark" },
  kommo: { file: "kommo.png", surface: "light" },
  pipedrive: { file: "pipedrive.svg", surface: "dark" },
  meta: { file: "meta.svg", surface: "dark" },
};

export function integrationLogoPath(id: IntegrationProviderId): string {
  return `/integrations/${logoAssets[id].file}`;
}

function logoSurface(id: IntegrationProviderId): "dark" | "light" {
  return logoAssets[id].surface;
}

export const integrationProviders: readonly IntegrationProviderDefinition[] = [
  {
    id: "uazapi_byo",
    name: "Uazapi",
    category: "whatsapp_number",
    logo: integrationLogoPath("uazapi_byo"),
    initials: "Uz",
    logoSurface: logoSurface("uazapi_byo"),
    description:
      "Conecte a sua instância Uazapi (leia o QR code no celular) e receba as conversas dos anúncios.",
    gate: { kind: "whatsapp_provider", provider: "uazapi_byo" },
  },
  {
    id: "meta_cloud",
    name: "WhatsApp Cloud API",
    category: "whatsapp_official",
    logo: integrationLogoPath("meta_cloud"),
    initials: "WA",
    logoSurface: logoSurface("meta_cloud"),
    description:
      "Gera o webhook que conecta direto à Meta (API oficial do WhatsApp) para receber as conversas dos anúncios, sem instância intermediária.",
    gate: { kind: "inbound_provider", provider: "meta_cloud" },
  },
  {
    id: "waha",
    name: "WAHA",
    category: "whatsapp_number",
    logo: integrationLogoPath("waha"),
    initials: "WA",
    logoSurface: logoSurface("waha"),
    comingSoon: true,
    comingSoonDescription:
      "Em breve: a conexão com o WAHA ainda não está disponível para novas contas.",
    description:
      "Sua instalação WAHA (WhatsApp HTTP API) já conectada.",
    gate: { kind: "whatsapp_provider", provider: "waha" },
  },
  {
    id: "zapi",
    name: "Z-API",
    category: "whatsapp_number",
    logo: integrationLogoPath("zapi"),
    initials: "Z",
    logoSurface: logoSurface("zapi"),
    comingSoon: true,
    comingSoonDescription:
      "Em breve: a conexão com a Z-API ainda não está disponível para novas contas.",
    description:
      "Sua instância Z-API já conectada.",
    gate: { kind: "whatsapp_provider", provider: "zapi" },
  },
  {
    id: "nod_api",
    name: "NOD API",
    category: "whatsapp_number",
    logo: integrationLogoPath("nod_api"),
    initials: "NOD",
    logoSurface: logoSurface("nod_api"),
    comingSoon: true,
    comingSoonDescription:
      "Em breve: a conexão com a NOD API ainda não está disponível para novas contas.",
    description:
      "Sua instância NOD API (PalmUP) já conectada.",
    gate: { kind: "whatsapp_provider", provider: "nod_api" },
  },
  {
    id: "umbler",
    name: "Umbler Talk",
    category: "attendance",
    logo: integrationLogoPath("umbler"),
    initials: "Um",
    logoSurface: logoSurface("umbler"),
    description:
      "Receba as conversas de anúncio que chegam no Umbler Talk.",
    gate: { kind: "inbound_provider", provider: "umbler" },
  },
  {
    id: "gupshup",
    name: "Gupshup",
    category: "attendance",
    logo: integrationLogoPath("gupshup"),
    initials: "Gs",
    logoSurface: logoSurface("gupshup"),
    description:
      "Receba as conversas de anúncio que chegam na Gupshup.",
    gate: { kind: "inbound_provider", provider: "gupshup" },
  },
  {
    id: "data_crazy",
    name: "Data Crazy",
    category: "attendance",
    logo: integrationLogoPath("data_crazy"),
    initials: "DC",
    logoSurface: logoSurface("data_crazy"),
    description:
      "Receba as conversas de anúncio que chegam na Data Crazy.",
    gate: { kind: "inbound_provider", provider: "data_crazy" },
  },
  {
    id: "unnichat",
    name: "Unnichat",
    category: "attendance",
    logo: integrationLogoPath("unnichat"),
    initials: "Un",
    logoSurface: logoSurface("unnichat"),
    description:
      "Receba as conversas de anúncio que chegam no Unnichat e envie as conversões dos seus fluxos de atendimento.",
    gate: { kind: "inbound_provider", provider: "unnichat" },
  },
  {
    id: "payt",
    name: "Payt",
    category: "attendance",
    logo: integrationLogoPath("payt"),
    initials: "Pt",
    logoSurface: logoSurface("payt"),
    description:
      "Envie compra aprovada, Pix/boleto gerado e carrinho abandonado como conversão do lead que veio do anúncio. Funciona por regra em Conversões.",
    gate: { kind: "payt_rules" },
  },
  {
    id: "meta",
    name: "Meta Ads",
    category: "ads",
    logo: integrationLogoPath("meta"),
    initials: "Mt",
    logoSurface: logoSurface("meta"),
    description:
      "Conecte a conta de anúncios por login social ou token: traz os dados de tráfego, cruza com os leads e envia as conversões para a Meta (CAPI). Não recebe conversas.",
    gate: { kind: "always" },
  },
  {
    id: "kommo",
    name: "Kommo",
    category: "crm",
    logo: integrationLogoPath("kommo"),
    initials: "Ko",
    logoSurface: logoSurface("kommo"),
    description:
      "Envie conversões quando o lead muda de etapa no Kommo.",
    gate: { kind: "crm", provider: "kommo" },
  },
  {
    id: "pipedrive",
    name: "Pipedrive",
    category: "crm",
    logo: integrationLogoPath("pipedrive"),
    initials: "Pd",
    logoSurface: logoSurface("pipedrive"),
    description: "Envie conversões quando o negócio avança no Pipedrive.",
    gate: { kind: "crm", provider: "pipedrive" },
  },
];

export function integrationProvider(
  id: IntegrationProviderId,
): IntegrationProviderDefinition {
  const provider = integrationProviders.find((item) => item.id === id);

  if (!provider) {
    throw new Error(`Unknown integration provider: ${id}`);
  }

  return provider;
}

export function integrationTabForCategory(
  category: IntegrationCategory,
): IntegrationTabId {
  const tab = integrationTabs.find((item) =>
    item.categories.includes(category),
  );

  return tab?.id ?? "whatsapp";
}

export function integrationTabFromQuery(
  value: string | null | undefined,
): IntegrationTabId | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  const tab = integrationTabs.find(
    (item) =>
      item.query === normalized ||
      item.id === normalized ||
      item.aliases.includes(normalized),
  );

  return tab?.id ?? null;
}

export function isIntegrationProviderId(
  value: string,
): value is IntegrationProviderId {
  return (integrationProviderIds as readonly string[]).includes(value);
}

/** `#integracao-<provider>` opens that provider's modal. */
export function integrationProviderHash(id: IntegrationProviderId): string {
  return `integracao-${id}`;
}

export type IntegrationDeepLink = {
  tab: IntegrationTabId | null;
  provider: IntegrationProviderId | null;
};

/**
 * Maps a location hash to the hub state. Keeps the anchors that existed
 * before the hub (`#integracao-meta`, `#integracao-whatsapp`) and the old
 * Settings Kommo anchor (`#crm-configurado`) working.
 */
export function integrationDeepLinkFromHash(
  hash: string | null | undefined,
): IntegrationDeepLink {
  const value = (hash ?? "").replace(/^#/u, "").trim().toLowerCase();

  if (!value) {
    return { tab: null, provider: null };
  }

  const tab = integrationTabs.find(
    (item) => item.hash === value || item.hashAliases.includes(value),
  );
  if (tab) {
    return { tab: tab.id, provider: null };
  }

  if (value.startsWith("integracao-")) {
    const candidate = value.slice("integracao-".length);
    if (isIntegrationProviderId(candidate)) {
      return {
        tab: integrationTabForCategory(integrationProvider(candidate).category),
        provider: candidate,
      };
    }
  }

  // Old Settings anchor for the Kommo CRM block.
  if (value === "crm-configurado") {
    return { tab: "crm", provider: "kommo" };
  }

  if (value === "crm-configurado-pipedrive") {
    return { tab: "crm", provider: "pipedrive" };
  }

  return { tab: null, provider: null };
}
