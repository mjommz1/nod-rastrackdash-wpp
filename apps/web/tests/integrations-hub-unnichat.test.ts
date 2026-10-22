import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildIntegrationCards,
  cardsForTab,
  type IntegrationHubSnapshot,
} from "../src/app/(app)/integrations/hub/integration-cards";
import {
  integrationDeepLinkFromHash,
  integrationProvider,
} from "../src/app/(app)/integrations/hub/integration-registry";

const base: IntegrationHubSnapshot = {
  inbound: {
    enabled: true,
    providers: [{ provider: "unnichat", creationEnabled: true }],
    connections: [],
  },
  whatsapp: { loaded: true, connections: [], legacyUazapiInstances: 0 },
  payt: { loaded: true, ruleCount: 0, activeRuleCount: 0 },
  crm: {
    kommo: { loadState: "real", statuses: [] },
    pipedrive: { loadState: "real", statuses: [] },
  },
  meta: { connected: false, needsAttention: false, statusLabel: "Não conectada" },
};

function unnichatCard(snapshot: IntegrationHubSnapshot) {
  return buildIntegrationCards(snapshot).find((card) => card.id === "unnichat");
}

describe("Hub: card do Unnichat", () => {
  it("fica na aba Atendimento e vendas, com o logo e o nome do Unnichat", () => {
    const provider = integrationProvider("unnichat");

    expect(provider).toMatchObject({
      name: "Unnichat",
      category: "attendance",
      logo: "/integrations/unnichat.png",
      logoSurface: "light",
      gate: { kind: "inbound_provider", provider: "unnichat" },
    });
    expect(provider.description).toMatch(/conversas de anúncio/);
    expect(unnichatCard(base)).toMatchObject({ tab: "attendance" });
  });

  it("aparece como Disponível quando a API oferece criar e ainda não há conexão", () => {
    expect(unnichatCard(base)).toMatchObject({
      state: "available",
      status: { label: "Disponível", tone: "neutral" },
      detail: null,
    });
    expect(
      cardsForTab(buildIntegrationCards(base), "attendance").available.map(
        (card) => card.id,
      ),
    ).toContain("unnichat");
  });

  it("não aparece quando a API não oferece o Unnichat e não há conexão", () => {
    expect(
      unnichatCard({
        ...base,
        inbound: { ...base.inbound!, providers: [] },
      }),
    ).toBeUndefined();
  });

  it("fica Ativo com a conexão, e o estado segue a conexão", () => {
    const withStatus = (status: "observation" | "production" | "paused") =>
      unnichatCard({
        ...base,
        inbound: {
          ...base.inbound!,
          connections: [{ provider: "unnichat", status }],
        },
      });

    expect(withStatus("observation")).toMatchObject({
      state: "active",
      status: { label: "Em teste", tone: "ok" },
      detail: "1 conexão",
    });
    expect(withStatus("production")).toMatchObject({
      state: "active",
      status: { label: "Enviando conversões", tone: "ok" },
    });
    expect(withStatus("paused")).toMatchObject({
      state: "active",
      status: { label: "Pausada", tone: "warn" },
    });
  });

  it("segue gerenciável com conexão mesmo se a criação for desligada", () => {
    expect(
      unnichatCard({
        ...base,
        inbound: {
          enabled: true,
          providers: [{ provider: "unnichat", creationEnabled: false }],
          connections: [{ provider: "unnichat", status: "observation" }],
        },
      }),
    ).toMatchObject({ state: "active" });
  });

  it("mantém o cartão com aviso quando as conexões não puderam ser lidas", () => {
    expect(unnichatCard({ ...base, inbound: null })).toMatchObject({
      state: "available",
      status: { label: "Não foi possível verificar", tone: "warn" },
    });
  });

  it("abre o modal do Unnichat pelo link #integracao-unnichat", () => {
    expect(integrationDeepLinkFromHash("#integracao-unnichat")).toEqual({
      tab: "attendance",
      provider: "unnichat",
    });
  });

  it("tem o logo do SaaS registrado em SOURCES.md", () => {
    const sources = readFileSync(
      resolve(__dirname, "../public/integrations/SOURCES.md"),
      "utf8",
    );

    expect(sources).toContain("`unnichat.png`");
    expect(sources).not.toMatch(/later updates \(Unnichat/);
  });
});
