import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIntegrationCards,
  cardsForTab,
  type IntegrationHubSnapshot,
} from "../src/app/(app)/integrations/hub/integration-cards";
import {
  integrationCategories,
  integrationDeepLinkFromHash,
  integrationProviderIds,
  integrationProviders,
  integrationTabForCategory,
  integrationTabFromQuery,
  integrationTabs,
} from "../src/app/(app)/integrations/hub/integration-registry";
import { integrationsHubInitialState } from "../src/app/(app)/integrations/hub/initial-state";

const publicDir = resolve(__dirname, "../public");

function snapshot(
  patch: Partial<IntegrationHubSnapshot> = {},
): IntegrationHubSnapshot {
  return {
    inbound: {
      enabled: true,
      providers: [
        { provider: "umbler", creationEnabled: true },
        { provider: "gupshup", creationEnabled: true },
        { provider: "data_crazy", creationEnabled: false },
        { provider: "meta_cloud", creationEnabled: true },
      ],
      connections: [],
    },
    whatsapp: { loaded: true, connections: [], legacyUazapiInstances: 0 },
    payt: { loaded: true, ruleCount: 0, activeRuleCount: 0 },
    crm: { kommo: { loadState: "empty", statuses: [] }, pipedrive: { loadState: "empty", statuses: [] } },
    meta: {
      connected: false,
      needsAttention: false,
      statusLabel: "Disponível",
    },
    ...patch,
  };
}

function ids(cards: { id: string }[]) {
  return cards.map((card) => card.id);
}

describe("integration registry", () => {
  it("has unique ids, a known category and a tab for every provider", () => {
    expect(new Set(ids([...integrationProviders])).size).toBe(
      integrationProviders.length,
    );
    expect(ids([...integrationProviders]).sort()).toEqual(
      [...integrationProviderIds].sort(),
    );

    for (const provider of integrationProviders) {
      expect(integrationCategories).toContain(provider.category);
      expect(integrationTabs.map((tab) => tab.id)).toContain(
        integrationTabForCategory(provider.category),
      );
      expect(provider.description.length).toBeGreaterThan(10);
      expect(provider.initials.length).toBeGreaterThan(0);
    }
  });

  it("only lists the providers the student backend implements", () => {
    expect([...integrationProviderIds].sort()).toEqual(
      [
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
      ].sort(),
    );
    for (const later of [
      "gohighlevel",
      "guimo",
    ]) {
      expect(integrationProviderIds as readonly string[]).not.toContain(later);
    }
  });

  it("points every card at a local, safe logo asset with a recorded source", () => {
    const sources = readFileSync(
      resolve(publicDir, "integrations/SOURCES.md"),
      "utf8",
    );

    for (const provider of integrationProviders) {
      expect(provider.logo).toMatch(/^\/integrations\/[a-z-]+\.(svg|png)$/u);
      expect(["dark", "light"]).toContain(provider.logoSurface);
      const file = resolve(publicDir, `.${provider.logo}`);
      expect(existsSync(file)).toBe(true);
      const bytes = readFileSync(file);
      expect(bytes.length).toBeLessThan(200 * 1024);
      // Every logo has its source or fallback reason recorded.
      expect(sources).toContain(`\`${provider.logo.split("/").pop()}\``);

      if (provider.logo.endsWith(".png")) {
        expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        continue;
      }

      const svg = bytes.toString("utf8");
      expect(svg.trimStart().startsWith("<svg")).toBe(true);
      expect(svg).toMatch(/viewBox="/u);
      expect(svg).not.toMatch(
        /<script|<foreignObject|\son[a-z]+=|@import|<image|href="(?!#)/iu,
      );
    }
  });

  it("groups categories into the four hub tabs (Meta concepts never mixed)", () => {
    expect(integrationTabs.map((tab) => tab.label)).toEqual([
      "WhatsApp",
      "Atendimento e vendas",
      "Anúncios",
      "CRM",
    ]);
    expect(integrationTabForCategory("whatsapp_number")).toBe("whatsapp");
    expect(integrationTabForCategory("whatsapp_official")).toBe("whatsapp");
    expect(integrationTabForCategory("attendance")).toBe("attendance");
    expect(integrationTabForCategory("ads")).toBe("ads");
    // Cloud API (WhatsApp) and Meta Ads (traffic + CAPI) live in different tabs.
    expect(integrationProviders.find((p) => p.id === "meta_cloud")?.logo).toBe(
      "/integrations/meta.svg",
    );
    const inTab = (tab: string) =>
      integrationProviders
        .filter((p) => integrationTabForCategory(p.category) === tab)
        .map((p) => p.id);
    expect(inTab("whatsapp")).toEqual([
      "uazapi_byo",
      "meta_cloud",
      "waha",
      "zapi",
      "nod_api",
    ]);
    // Only Uazapi (instance) and Cloud API create new WhatsApp connections.
    expect(
      integrationProviders.filter((p) => p.comingSoon).map((p) => p.id),
    ).toEqual(["waha", "zapi", "nod_api"]);
    expect(inTab("attendance")).toEqual([
      "umbler",
      "gupshup",
      "data_crazy",
      "unnichat",
      "payt",
    ]);
    expect(inTab("ads")).toEqual(["meta"]);
    expect(inTab("crm")).toEqual(["kommo", "pipedrive"]);
    expect(integrationTabForCategory("crm")).toBe("crm");
  });

  it("maps old and new deep links to a tab and modal", () => {
    expect(integrationDeepLinkFromHash("#integracao-meta")).toEqual({
      tab: "ads",
      provider: "meta",
    });
    expect(integrationDeepLinkFromHash("#integracao-whatsapp")).toEqual({
      tab: "whatsapp",
      provider: null,
    });
    expect(integrationDeepLinkFromHash("#integracao-kommo")).toEqual({
      tab: "crm",
      provider: "kommo",
    });
    expect(integrationDeepLinkFromHash("#integracao-uazapi_byo")).toEqual({
      tab: "whatsapp",
      provider: "uazapi_byo",
    });
    expect(integrationDeepLinkFromHash("#integracao-pipedrive")).toEqual({
      tab: "crm",
      provider: "pipedrive",
    });
    expect(integrationDeepLinkFromHash("#crm-configurado-pipedrive")).toEqual({
      tab: "crm",
      provider: "pipedrive",
    });
    // Old Settings anchor for the Kommo block.
    expect(integrationDeepLinkFromHash("#integracao-payt")).toEqual({
      tab: "attendance",
      provider: "payt",
    });
    expect(integrationDeepLinkFromHash("#crm-configurado")).toEqual({
      tab: "crm",
      provider: "kommo",
    });
    expect(integrationDeepLinkFromHash("#integracao-fluxo")).toEqual({
      tab: null,
      provider: null,
    });
    expect(integrationDeepLinkFromHash("")).toEqual({
      tab: null,
      provider: null,
    });
    expect(integrationTabFromQuery("crm")).toBe("crm");
    expect(integrationTabFromQuery("atendimento")).toBe("attendance");
    expect(integrationTabFromQuery("conversoes")).toBe("attendance");
    expect(integrationTabFromQuery("vendas")).toBe("attendance");
    expect(integrationTabFromQuery("anuncios")).toBe("ads");
    expect(integrationDeepLinkFromHash("#integracao-conversoes")).toEqual({
      tab: "attendance",
      provider: null,
    });
    expect(integrationDeepLinkFromHash("#integracao-anuncios")).toEqual({
      tab: "ads",
      provider: null,
    });
    expect(integrationTabFromQuery("nada")).toBeNull();
  });

  it("reopens the modal where a redirected action happened", () => {
    expect(integrationsHubInitialState({ meta: "connected" })).toEqual({
      tab: "ads",
      provider: "meta",
    });
    expect(
      integrationsHubInitialState({ notice: "meta-destination-saved" }),
    ).toEqual({ tab: "ads", provider: "meta" });
    expect(
      integrationsHubInitialState({ notice: "meta-license-locked" }),
    ).toEqual({ tab: "ads", provider: "meta" });
    // Server-side deep link used by Settings (no dependency on the URL hash).
    expect(integrationsHubInitialState({ abrir: "kommo" })).toEqual({
      tab: "crm",
      provider: "kommo",
    });
    expect(integrationsHubInitialState({ abrir: "umbler" })).toEqual({
      tab: "attendance",
      provider: "umbler",
    });
    expect(integrationsHubInitialState({ abrir: "payt" })).toEqual({
      tab: "attendance",
      provider: "payt",
    });
    expect(integrationsHubInitialState({ abrir: "nao-existe" })).toEqual({
      tab: "whatsapp",
      provider: null,
    });
    expect(integrationsHubInitialState({ aba: "crm" })).toEqual({
      tab: "crm",
      provider: null,
    });
    expect(integrationsHubInitialState({})).toEqual({
      tab: "whatsapp",
      provider: null,
    });
  });
});

describe("buildIntegrationCards", () => {
  it("splits each tab into active and available from the API data", () => {
    const cards = buildIntegrationCards(
      snapshot({
        inbound: {
          enabled: true,
          providers: [
            { provider: "umbler", creationEnabled: true },
            { provider: "gupshup", creationEnabled: true },
            { provider: "meta_cloud", creationEnabled: true },
          ],
          connections: [
            { provider: "umbler", status: "production" },
            { provider: "umbler", status: "paused" },
          ],
        },
        whatsapp: {
          loaded: true,
          connections: [
            { provider: "waha", status: "active" },
            { provider: "zapi", status: "pending_payment" },
          ],
          legacyUazapiInstances: 1,
        },
        crm: { kommo: { loadState: "real", statuses: ["active"] }, pipedrive: { loadState: "empty", statuses: [] } },
        meta: {
          connected: true,
          needsAttention: false,
          statusLabel: "Conectada",
        },
      }),
    );

    const whatsapp = cardsForTab(cards, "whatsapp");
    expect(ids(whatsapp.active).sort()).toEqual(["uazapi_byo", "waha", "zapi"]);
    expect(ids(whatsapp.available).sort()).toEqual(["meta_cloud", "nod_api"]);
    // "Em breve": never connectable; an existing connection stays manageable.
    const nod = cards.find((card) => card.id === "nod_api");
    expect(nod?.comingSoon).toBe(true);
    expect(nod?.status).toEqual({ label: "Em breve", tone: "neutral" });
    const existingWaha = cards.find((card) => card.id === "waha");
    expect(existingWaha?.state).toBe("active");
    expect(existingWaha?.comingSoon).toBe(false);
    // Active (existing connection): normal description, not the "Em breve" one.
    expect(existingWaha?.description).not.toContain("Em breve");
    expect(nod?.description).toContain("Em breve");
    const existingZapi = cards.find((card) => card.id === "zapi");
    expect(existingZapi?.state).toBe("active");
    expect(existingZapi?.comingSoon).toBe(false);

    const uazapi = cards.find((card) => card.id === "uazapi_byo");
    expect(uazapi?.detail).toBe("1 conexão");
    const zapi = cards.find((card) => card.id === "zapi");
    expect(zapi?.status).toEqual({ label: "Aguardando ativação", tone: "warn" });

    const conversions = cardsForTab(cards, "attendance");
    expect(ids(conversions.active)).toEqual(["umbler"]);
    expect(ids(conversions.available)).toEqual(["gupshup", "payt"]);
    expect(ids(cardsForTab(cards, "ads").active)).toEqual(["meta"]);
    expect(
      conversions.active.find((card) => card.id === "umbler")?.status.label,
    ).toBe("Enviando conversões");
    expect(
      conversions.active.find((card) => card.id === "umbler")?.detail,
    ).toBe("2 conexões");

    const crm = cardsForTab(cards, "crm");
    expect(ids(crm.active)).toEqual(["kommo"]);
    expect(ids(crm.available)).toEqual(["pipedrive"]);
    expect(crm.active[0].status.label).toBe("Ativa");
  });

  it("offers an inbound provider only when the API allows creating it or one exists", () => {
    const hidden = buildIntegrationCards(snapshot());
    expect(ids(hidden)).not.toContain("data_crazy");

    const withExisting = buildIntegrationCards(
      snapshot({
        inbound: {
          enabled: true,
          providers: [{ provider: "data_crazy", creationEnabled: false }],
          connections: [{ provider: "data_crazy", status: "observation" }],
        },
      }),
    );
    expect(
      withExisting.find((card) => card.id === "data_crazy")?.status.label,
    ).toBe("Em teste");
  });

  it("keeps inbound cards, flagged, when the connections could not be read", () => {
    const cards = buildIntegrationCards(snapshot({ inbound: null }));

    for (const id of ["meta_cloud", "umbler", "gupshup", "data_crazy"]) {
      const card = cards.find((item) => item.id === id);
      expect(card?.state).toBe("available");
      expect(card?.status).toEqual({
        label: "Não foi possível verificar",
        tone: "warn",
      });
    }
    expect(ids(cards)).toContain("uazapi_byo");
    expect(ids(cards)).toContain("kommo");
    expect(ids(cards)).toContain("meta");
  });

  it("flags WhatsApp providers whose connections failed to load instead of faking 'available'", () => {
    const cards = buildIntegrationCards(
      snapshot({
        whatsapp: { loaded: false, connections: [], legacyUazapiInstances: 0 },
      }),
    );

    expect(cards.find((card) => card.id === "uazapi_byo")?.status).toEqual({
      label: "Não foi possível verificar",
      tone: "warn",
    });
  });

  it("marks disconnected or failing WhatsApp providers as needing attention", () => {
    const cards = buildIntegrationCards(
      snapshot({
        whatsapp: {
          loaded: true,
          connections: [
            { provider: "waha", status: "disconnected" },
            { provider: "zapi", status: "error" },
          ],
          legacyUazapiInstances: 0,
        },
      }),
    );

    expect(cards.find((card) => card.id === "waha")?.status.tone).toBe("warn");
    expect(cards.find((card) => card.id === "zapi")?.status.label).toBe(
      "Com erro",
    );
  });

  it("shows Kommo load failures and missing access explicitly", () => {
    const error = buildIntegrationCards(
      snapshot({ crm: { kommo: { loadState: "error", statuses: [] }, pipedrive: { loadState: "empty", statuses: [] } } }),
    );
    expect(error.find((card) => card.id === "kommo")?.status.label).toBe(
      "Não foi possível verificar",
    );

    const forbidden = buildIntegrationCards(
      snapshot({ crm: { kommo: { loadState: "forbidden", statuses: [] }, pipedrive: { loadState: "empty", statuses: [] } } }),
    );
    expect(forbidden.find((card) => card.id === "kommo")?.status.label).toBe(
      "Sem acesso",
    );

    const paused = buildIntegrationCards(
      snapshot({ crm: { kommo: { loadState: "real", statuses: ["paused"] }, pipedrive: { loadState: "empty", statuses: [] } } }),
    );
    const kommo = paused.find((card) => card.id === "kommo");
    expect(kommo?.state).toBe("active");
    expect(kommo?.status).toEqual({ label: "Pausada", tone: "warn" });
  });

  it("shows Pipedrive as an always-on CRM card with its own connection state", () => {
    const base = buildIntegrationCards(snapshot());
    const available = base.find((card) => card.id === "pipedrive");
    expect(available?.state).toBe("available");
    expect(available?.status).toEqual({ label: "Disponível", tone: "neutral" });
    expect(available?.logo).toBe("/integrations/pipedrive.svg");
    expect(available?.logoSurface).toBe("dark");

    const empty = { loadState: "empty" as const, statuses: [] as string[] };
    const error = buildIntegrationCards(
      snapshot({
        crm: { kommo: empty, pipedrive: { loadState: "error", statuses: [] } },
      }),
    );
    expect(error.find((card) => card.id === "pipedrive")?.status.label).toBe(
      "Não foi possível verificar",
    );

    const forbidden = buildIntegrationCards(
      snapshot({
        crm: {
          kommo: empty,
          pipedrive: { loadState: "forbidden", statuses: [] },
        },
      }),
    );
    expect(
      forbidden.find((card) => card.id === "pipedrive")?.status.label,
    ).toBe("Sem acesso");

    const two = buildIntegrationCards(
      snapshot({
        crm: {
          kommo: empty,
          pipedrive: { loadState: "real", statuses: ["active", "paused"] },
        },
      }),
    );
    const pipedrive = two.find((card) => card.id === "pipedrive");
    expect(pipedrive?.state).toBe("active");
    expect(pipedrive?.status).toEqual({ label: "Ativa", tone: "ok" });
    expect(pipedrive?.detail).toBe("2 conexões");

    const blocked = buildIntegrationCards(
      snapshot({
        crm: {
          kommo: empty,
          pipedrive: { loadState: "real", statuses: ["blocked"] },
        },
      }),
    );
    expect(blocked.find((card) => card.id === "pipedrive")?.status).toEqual({
      label: "Bloqueada",
      tone: "warn",
    });
  });

  it("shows the Payt card from its rules, never as a connection", () => {
    const find = (patch: IntegrationHubSnapshot["payt"]) =>
      buildIntegrationCards(snapshot({ payt: patch })).find(
        (card) => card.id === "payt",
      );

    const none = find({ loaded: true, ruleCount: 0, activeRuleCount: 0 });
    expect(none?.state).toBe("available");
    expect(none?.status).toEqual({ label: "Disponível", tone: "neutral" });
    expect(none?.tab).toBe("attendance");
    expect(none?.comingSoon).toBe(false);

    const receiving = find({ loaded: true, ruleCount: 3, activeRuleCount: 2 });
    expect(receiving?.state).toBe("active");
    expect(receiving?.status).toEqual({ label: "Recebendo vendas", tone: "ok" });
    expect(receiving?.detail).toBe("3 regras");

    const paused = find({ loaded: true, ruleCount: 1, activeRuleCount: 0 });
    expect(paused?.status).toEqual({ label: "Regras pausadas", tone: "warn" });
    expect(paused?.detail).toBe("1 regra");

    const unknown = find({ loaded: false, ruleCount: 0, activeRuleCount: 0 });
    expect(unknown?.state).toBe("available");
    expect(unknown?.status).toEqual({
      label: "Não foi possível verificar",
      tone: "warn",
    });
    // Offered even though the API never lists Payt as a connection provider.
    expect(ids(buildIntegrationCards(snapshot()))).toContain("payt");
  });

  it("reflects the Meta connection state", () => {
    const attention = buildIntegrationCards(
      snapshot({
        meta: {
          connected: false,
          needsAttention: true,
          statusLabel: "Reconectar",
        },
      }),
    );
    const meta = attention.find((card) => card.id === "meta");
    expect(meta?.state).toBe("available");
    expect(meta?.status).toEqual({ label: "Reconectar", tone: "warn" });
  });
});
