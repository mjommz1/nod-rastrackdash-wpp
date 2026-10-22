import {
  integrationProviders,
  integrationTabForCategory,
  type CrmIntegrationProvider,
  type IntegrationCategory,
  type IntegrationProviderDefinition,
  type IntegrationProviderId,
  type IntegrationTabId,
  type WhatsappIntegrationProvider,
} from "./integration-registry";

export type IntegrationCardTone = "ok" | "warn" | "neutral";

export type IntegrationCardStatus = {
  label: string;
  tone: IntegrationCardTone;
};

/** Serializable view of one hub card (server page -> client hub). */
export type IntegrationCardView = {
  id: IntegrationProviderId;
  name: string;
  logo: string;
  initials: string;
  logoSurface: "dark" | "light";
  description: string;
  category: IntegrationCategory;
  tab: IntegrationTabId;
  state: "active" | "available";
  /** "Em breve": no new connections yet; the card is not connectable. */
  comingSoon: boolean;
  status: IntegrationCardStatus;
  /** Short fact under the name, e.g. "2 conexões". */
  detail: string | null;
};

export type CrmLoadState = "real" | "empty" | "error" | "forbidden";

export type CrmSnapshot = {
  loadState: CrmLoadState;
  /** Status of every connection/integration of this CRM. */
  statuses: string[];
};

export type InboundConnectionSnapshot = {
  provider: string;
  status: "observation" | "production" | "paused";
};

export type IntegrationHubSnapshot = {
  /** `null` when the inbound connections could not be read. */
  inbound: {
    enabled: boolean;
    providers: Array<{ provider: string; creationEnabled: boolean }>;
    connections: InboundConnectionSnapshot[];
  } | null;
  whatsapp: {
    /** False when the WhatsApp connections could not be read. */
    loaded: boolean;
    connections: Array<{ provider: string; status: string }>;
    /**
     * Uazapi instance configured through the environment (UAZAPI_BASE_URL /
     * UAZAPI_TOKEN) plus inbound connections bridged from it.
     */
    legacyUazapiInstances: number;
  };
  /**
   * Payt has no connection: it is a rule origin in Conversões. The card
   * reflects the Payt rules of the workspace.
   */
  payt: {
    /** False when the conversion rules could not be read. */
    loaded: boolean;
    ruleCount: number;
    activeRuleCount: number;
    /** Fase 5.3: a URL única da Payt já foi gerada. */
    integrationUrl?: boolean;
  };
  crm: {
    kommo: CrmSnapshot;
    pipedrive: CrmSnapshot;
  };
  meta: {
    connected: boolean;
    needsAttention: boolean;
    statusLabel: string;
  };
};

function plural(count: number, singular: string, pluralWord: string): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

type CardDecision = Pick<IntegrationCardView, "state" | "status" | "detail">;

const comingSoonDecision: CardDecision = {
  state: "available",
  status: { label: "Em breve", tone: "neutral" },
  detail: null,
};

const available: CardDecision = {
  state: "available",
  status: { label: "Disponível", tone: "neutral" },
  detail: null,
};

function inboundDecision(
  snapshot: IntegrationHubSnapshot,
  provider: string,
): CardDecision | null {
  const inbound = snapshot.inbound;

  // The connections could not be read: keep the card (and any open modal)
  // instead of silently dropping the provider.
  if (!inbound) {
    return {
      state: "available",
      status: { label: "Não foi possível verificar", tone: "warn" },
      detail: null,
    };
  }

  const connections = inbound.connections.filter(
    (connection) => connection.provider === provider,
  );
  const creationEnabled = inbound.providers.some(
    (item) => item.provider === provider && item.creationEnabled,
  );

  if (connections.length > 0) {
    const production = connections.filter(
      (connection) => connection.status === "production",
    ).length;
    const observation = connections.filter(
      (connection) => connection.status === "observation",
    ).length;

    return {
      state: "active",
      status:
        production > 0
          ? { label: "Enviando conversões", tone: "ok" }
          : observation > 0
            ? { label: "Em teste", tone: "ok" }
            : { label: "Pausada", tone: "warn" },
      detail: plural(connections.length, "conexão", "conexões"),
    };
  }

  if (!creationEnabled) {
    return null;
  }

  return available;
}

function whatsappDecision(
  snapshot: IntegrationHubSnapshot,
  provider: WhatsappIntegrationProvider,
  comingSoon: boolean,
): CardDecision {
  const { loaded, connections, legacyUazapiInstances } = snapshot.whatsapp;
  const own = connections.filter(
    (connection) => connection.provider === provider,
  );
  const legacy = provider === "uazapi_byo" ? legacyUazapiInstances : 0;

  if (own.length === 0 && legacy === 0) {
    // Not connectable yet, and nothing existing to manage.
    if (comingSoon) {
      return comingSoonDecision;
    }

    return loaded
      ? available
      : {
          state: "available",
          status: { label: "Não foi possível verificar", tone: "warn" },
          detail: null,
        };
  }

  const count = own.length + legacy;
  const statuses = own.map((connection) => connection.status);

  if (statuses.includes("pending_payment")) {
    return {
      state: "active",
      status: { label: "Aguardando ativação", tone: "warn" },
      detail: plural(count, "conexão", "conexões"),
    };
  }

  if (statuses.includes("error")) {
    return {
      state: "active",
      status: { label: "Com erro", tone: "warn" },
      detail: plural(count, "conexão", "conexões"),
    };
  }

  if (own.length > 0 && !statuses.includes("active")) {
    return {
      state: "active",
      status: { label: "Desconectada", tone: "warn" },
      detail: plural(count, "conexão", "conexões"),
    };
  }

  return {
    state: "active",
    status: { label: "Conectada", tone: "ok" },
    detail: plural(count, "conexão", "conexões"),
  };
}

function paytDecision(snapshot: IntegrationHubSnapshot): CardDecision {
  const { loaded, ruleCount, activeRuleCount, integrationUrl = false } =
    snapshot.payt;

  if (ruleCount === 0 && integrationUrl) {
    return {
      state: "active",
      status: { label: "URL criada, sem regras", tone: "warn" },
      detail: "URL única",
    };
  }

  if (ruleCount === 0) {
    return loaded
      ? available
      : {
          state: "available",
          status: { label: "Não foi possível verificar", tone: "warn" },
          detail: null,
        };
  }

  return {
    state: "active",
    status:
      activeRuleCount > 0
        ? { label: "Recebendo vendas", tone: "ok" }
        : { label: "Regras pausadas", tone: "warn" },
    detail: plural(ruleCount, "regra", "regras"),
  };
}

const crmStatusLabels: Record<string, string> = {
  active: "Ativa",
  paused: "Pausada",
  blocked: "Bloqueada",
};

function crmDecision(
  snapshot: IntegrationHubSnapshot,
  provider: CrmIntegrationProvider,
): CardDecision {
  const crm = snapshot.crm[provider];

  if (crm.loadState === "error") {
    return {
      state: "available",
      status: { label: "Não foi possível verificar", tone: "warn" },
      detail: null,
    };
  }

  if (crm.loadState === "forbidden") {
    return {
      state: "available",
      status: { label: "Sem acesso", tone: "warn" },
      detail: null,
    };
  }

  if (crm.loadState === "empty" || crm.statuses.length === 0) {
    return available;
  }

  const active = crm.statuses.filter((status) => status === "active").length;
  const firstStatus = crm.statuses.find((status) => status !== "active");

  return {
    state: "active",
    status:
      active > 0
        ? { label: "Ativa", tone: "ok" }
        : {
            label: crmStatusLabels[firstStatus ?? ""] ?? "Inativa",
            tone: "warn",
          },
    detail: plural(crm.statuses.length, "conexão", "conexões"),
  };
}

function metaDecision(snapshot: IntegrationHubSnapshot): CardDecision {
  const meta = snapshot.meta;

  if (meta.connected) {
    return {
      state: "active",
      status: {
        label: meta.statusLabel,
        tone: meta.needsAttention ? "warn" : "ok",
      },
      detail: null,
    };
  }

  return {
    state: "available",
    status: meta.needsAttention
      ? { label: meta.statusLabel, tone: "warn" }
      : { label: "Disponível", tone: "neutral" },
    detail: null,
  };
}

function decide(
  definition: IntegrationProviderDefinition,
  snapshot: IntegrationHubSnapshot,
): CardDecision | null {
  const gate = definition.gate;

  switch (gate.kind) {
    case "whatsapp_provider":
      return whatsappDecision(snapshot, gate.provider, Boolean(definition.comingSoon));
    case "inbound_provider":
      return inboundDecision(snapshot, gate.provider);
    case "crm":
      return crmDecision(snapshot, gate.provider);
    case "payt_rules":
      return paytDecision(snapshot);
    case "always":
      return definition.id === "meta" ? metaDecision(snapshot) : available;
  }
}

/**
 * Turns what the API returned into the hub cards. A provider whose gate
 * says no (not offered by the API) is left out.
 */
export function buildIntegrationCards(
  snapshot: IntegrationHubSnapshot,
): IntegrationCardView[] {
  return integrationProviders.flatMap((definition) => {
    const decision = decide(definition, snapshot);

    if (!decision) {
      return [];
    }

    return [
      {
        id: definition.id,
        name: definition.name,
        logo: definition.logo,
        initials: definition.initials,
        logoSurface: definition.logoSurface,
        // An active card (existing connection) shows the normal description.
        description:
          definition.comingSoon && decision.state !== "active"
            ? (definition.comingSoonDescription ?? definition.description)
            : definition.description,
        category: definition.category,
        tab: integrationTabForCategory(definition.category),
        // Existing connections keep a coming-soon provider manageable, so the
        // card is only "coming soon" while it is not active.
        comingSoon: Boolean(definition.comingSoon) && decision.state !== "active",
        ...decision,
      },
    ];
  });
}

export function cardsForTab(
  cards: IntegrationCardView[],
  tab: IntegrationTabId,
): { active: IntegrationCardView[]; available: IntegrationCardView[] } {
  const inTab = cards.filter((card) => card.tab === tab);

  return {
    active: inTab.filter((card) => card.state === "active"),
    available: inTab.filter((card) => card.state === "available"),
  };
}
