import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));

import OverviewPage from "../src/app/(app)/overview/page";
import { GET as exportGet } from "../src/app/(app)/reports/export/route";
import ReportsPage from "../src/app/(app)/reports/page";

afterEach(() => {
  vi.restoreAllMocks();
});

const NBSP = String.fromCharCode(160);

function metrics(overrides: Record<string, unknown> = {}) {
  return {
    spendCents: 100000,
    metaConversationsStarted: 50,
    costPerMetaConversationCents: 2000,
    realConversations: 20,
    costPerRealConversationCents: 5000,
    organicLeads: 0,
    totalReceived: 20,
    trackingRate: 1,
    qualifiedLead: 4,
    costPerQualifiedLeadCents: 25000,
    purchases: 2,
    firstPurchases: 2,
    repurchases: 0,
    costPerPurchaseCents: 50000,
    trafficRevenueCents: 300000,
    organicRevenueCents: 0,
    totalRevenueCents: 300000,
    firstPurchaseRevenueCents: 300000,
    repurchaseRevenueCents: 0,
    roasAcquisition: 3,
    roasWithRepurchase: 3,
    funnelSteps: [
      {
        key: "real_conversations",
        label: "Conversas reais",
        value: 20,
        costCents: 5000,
      },
      { key: "purchase", label: "Vendas", value: 2, costCents: 50000 },
    ],
    ...overrides,
  };
}

function group(
  currency: "BRL" | "USD" | "EUR",
  overrides: Record<string, unknown> = {},
) {
  return {
    ...metrics(),
    currency,
    adAccountIds: [`act_${currency}`],
    exchangeRateMissing: false,
    unconvertedRevenue: [],
    ...overrides,
  };
}

const workspace = {
  id: "workspace_1",
  name: "Workspace",
  slug: "workspace",
  role: "owner",
  operationalStatus: "active",
  permissions: {
    canInviteMembers: true,
    canManageBilling: true,
    canManageIntegrations: true,
    canViewReports: true,
  },
};

function reportingAccount(
  adAccountId: string,
  adAccountName: string,
  currency: string,
) {
  return {
    id: `reporting_${adAccountId}`,
    workspaceId: "workspace_1",
    businessId: "business_1",
    businessName: "BM Principal",
    adAccountId,
    adAccountName,
    currency,
    timezoneName: "America/Sao_Paulo",
    active: true,
    syncStatus: "synced",
    lastSyncedAt: "2026-07-12T10:00:00.000Z",
    lastSyncSince: "2026-07-06",
    lastSyncUntil: "2026-07-12",
    syncError: null,
  };
}

const assets = {
  workspaceId: "workspace_1",
  status: "connected",
  businesses: [],
  adAccounts: [],
  pixels: [],
  pages: [],
  reportingAccounts: [
    reportingAccount("act_BRL", "Conta Real", "BRL"),
    reportingAccount("act_USD", "Conta Dolar", "USD"),
  ],
  selection: { businessId: null, adAccountId: null, pixelId: null },
  conversionDestination: null,
  lastSyncedAt: "2026-07-10T10:00:00.000Z",
  syncError: null,
};

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockApi(campaignReport: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);

    if (url.includes("/workspaces/current")) return json(workspace);
    if (url.includes("/integrations/meta/assets")) return json(assets);
    if (url.includes("/reports/campaigns")) return json(campaignReport);

    return new Response("not found", { status: 404 });
  });
}

function campaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp_1",
    name: "Campanha Real",
    status: "active",
    configuredStatus: "ACTIVE",
    effectiveStatus: "ACTIVE",
    ...metrics(),
    ...overrides,
  };
}

async function renderReports(searchParams: Record<string, string> = {}) {
  const element = await ReportsPage({
    searchParams: Promise.resolve(searchParams),
  });

  return renderToStaticMarkup(createElement("div", null, element));
}

async function renderOverview(searchParams: Record<string, string> = {}) {
  const element = await OverviewPage({
    searchParams: Promise.resolve(searchParams),
  });

  return renderToStaticMarkup(createElement("div", null, element));
}

const baseReport = {
  workspaceId: "workspace_1",
  rangeLabel: "Ultimos 7 dias",
  since: "2026-07-06",
  until: "2026-07-12",
};

function brlCampaignReport(extra: Record<string, unknown> = {}) {
  return {
    ...baseReport,
    campaigns: [campaignRow()],
    totals: metrics(),
    summary: { ...campaignRow({ id: "all", name: "Todas" }) },
    pagination: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
    ...extra,
  };
}

function mixedCampaignReport(extra: Record<string, unknown> = {}) {
  const brl = group("BRL");
  const usd = group("USD", {
    spendCents: 20000,
    totalRevenueCents: 80000,
    trafficRevenueCents: 80000,
    costPerRealConversationCents: 1000,
    costPerMetaConversationCents: 400,
    roasAcquisition: 4,
  });

  return {
    ...baseReport,
    campaigns: [
      campaignRow(),
      campaignRow({
        id: "cmp_2",
        name: "Campanha Dolar",
        currency: "USD",
        spendCents: 20000,
        trafficRevenueCents: 80000,
        totalRevenueCents: 80000,
        roasAcquisition: 4,
      }),
    ],
    currency: null,
    byCurrency: [brl, usd],
    summaryByCurrency: [brl, usd],
    totals: metrics({ spendCents: 120000 }),
    summary: campaignRow({ id: "all", name: "Todas", spendCents: 120000 }),
    pagination: { page: 1, pageSize: 10, totalItems: 2, totalPages: 1 },
    ...extra,
  };
}

describe("relatório só em real (sem mudança visual)", () => {
  it("Relatórios: com currency BRL a tela é idêntica à de uma resposta sem moeda", async () => {
    mockApi(brlCampaignReport());
    const semMoeda = await renderReports({ metrics: "revenue" });

    vi.restoreAllMocks();
    mockApi(brlCampaignReport({ currency: "BRL" }));
    const comMoeda = await renderReports({ metrics: "revenue" });

    expect(comMoeda).toBe(semMoeda);
    expect(comMoeda).toContain(`R$${NBSP}1.000,00`);
    expect(comMoeda).not.toContain("currency-kpi-groups");
    expect(comMoeda).not.toContain("sem cotação");
    expect(comMoeda).not.toContain("Por moeda");
    expect(comMoeda).not.toContain("US$");
    expect(comMoeda).toContain('data-label="Receita total"');
  });

  it("Visão Geral: com currency BRL a tela é idêntica à de uma resposta sem moeda", async () => {
    const report = {
      ...baseReport,
      campaigns: [campaignRow()],
      summary: campaignRow(),
    };

    mockApi(report);
    const semMoeda = await renderOverview();

    vi.restoreAllMocks();
    mockApi({ ...report, currency: "BRL" });
    const comMoeda = await renderOverview();

    expect(comMoeda).toBe(semMoeda);
    expect(comMoeda).toContain(`R$${NBSP}1.000,00`);
    expect(comMoeda).toContain(`Custo por lead novo R$${NBSP}50,00`);
    expect(comMoeda).not.toContain("currency-kpi-groups");
    expect(comMoeda).not.toContain("Por moeda");
    expect(comMoeda).not.toContain("sem cotação");
  });
});

describe("relatório com duas moedas", () => {
  it("Relatórios: um bloco por moeda, linhas na moeda da conta e rodapé por moeda", async () => {
    mockApi(mixedCampaignReport());
    const html = await renderReports({ metrics: "revenue" });

    expect(html).toContain('data-currency-groups="2"');
    expect(html).toContain('data-currency="BRL"');
    expect(html).toContain('data-currency="USD"');
    expect(html).toContain("Totais por moeda");
    // Bloco do dólar: gasto, receita e ROAS na própria moeda.
    expect(html).toContain(`US$${NBSP}200,00`);
    expect(html).toContain(`US$${NBSP}800,00`);
    // Linha da campanha em dólar e linha em real.
    expect(html).toMatch(/data-label="Investimento">US\$.200,00<\/td>/);
    expect(html).toMatch(/data-label="Investimento">R\$.1\.000,00<\/td>/);
    // Rodapé: um total por moeda, nunca somados.
    expect(html).toContain("Total do filtro · BRL");
    expect(html).toContain("Total do filtro · USD");
    expect(html).toContain("moedas diferentes não são somadas");
    // O cartão do resumo manda olhar os blocos por moeda.
    expect(html).toContain("Por moeda");
    // Nenhum total somado misturando as moedas (R$ 1.200,00).
    expect(html).not.toContain(`R$${NBSP}1.200,00`);
  });

  it("Visão Geral: investimento e receita por moeda, lado a lado", async () => {
    const mixed = mixedCampaignReport();

    mockApi({ ...mixed, campaigns: [] });
    const html = await renderOverview();

    expect(html).toContain('data-currency-groups="2"');
    expect(html).toContain("Por moeda");
    expect(html).toContain(`R$${NBSP}1.000,00`);
    expect(html).toContain(`US$${NBSP}200,00`);
    // CPL em cada moeda.
    expect(html).toContain(
      `Custo por lead novo R$${NBSP}50,00 · US$${NBSP}10,00`,
    );
    // O funil mostra o custo de cada etapa nas duas moedas.
    expect(html).toContain(`R$${NBSP}50,00 · US$${NBSP}10,00`);
    expect(html).not.toContain(`R$${NBSP}1.200,00`);
  });

  it("uma moeda estrangeira só usa os cartões normais, na moeda dela", async () => {
    mockApi({
      ...baseReport,
      campaigns: [campaignRow({ currency: "USD" })],
      currency: "USD",
      summary: campaignRow(),
    });
    const html = await renderOverview();

    expect(html).toContain(`US$${NBSP}1.000,00`);
    expect(html).not.toContain("currency-kpi-groups");
    expect(html).not.toContain("Por moeda");
  });

  it("moeda sem movimento no período não vira bloco", async () => {
    const brl = group("BRL");
    const eur = group("EUR", {
      spendCents: 0,
      trafficRevenueCents: 0,
      totalRevenueCents: 0,
    });

    mockApi({
      ...baseReport,
      campaigns: [campaignRow()],
      currency: null,
      byCurrency: [brl, eur],
      summaryByCurrency: [brl, eur],
      summary: campaignRow(),
    });
    const html = await renderOverview();

    expect(html).not.toContain("currency-kpi-groups");
    expect(html).not.toContain("€");
    expect(html).toContain(`R$${NBSP}1.000,00`);
  });
});

describe("sem cotação", () => {
  it("Relatórios: ROAS vira 'sem cotação', a receita de fora aparece na moeda original e a dica cita a PTAX_SYNC_ENABLED", async () => {
    mockApi(
      brlCampaignReport({
        currency: "BRL",
        exchangeRateMissing: true,
        unconvertedRevenue: [{ currency: "USD", valueCents: 5000 }],
        campaigns: [
          campaignRow({
            exchangeRateMissing: true,
            unconvertedRevenue: [{ currency: "USD", valueCents: 5000 }],
          }),
        ],
      }),
    );
    const html = await renderReports({ metrics: "revenue" });

    expect(html).toContain("report-rate-missing");
    expect(html).toContain("sem cotação");
    expect(html).toContain(`+ US$${NBSP}50,00 sem cotação`);
    expect(html).toContain(
      `Fora da receita por falta de cotação: US$${NBSP}50,00`,
    );
    expect(html).toContain("PTAX_SYNC_ENABLED");
    // O ROAS parcial (3x) não aparece como se fosse completo.
    expect(html).not.toMatch(/data-label="ROAS de aquisicao">3x</);
  });

  it("Relatórios: em duas moedas, só o bloco sem cotação mostra o aviso", async () => {
    const brl = group("BRL");
    const usd = group("USD", {
      exchangeRateMissing: true,
      unconvertedRevenue: [{ currency: "EUR", valueCents: 12345 }],
    });

    mockApi(
      mixedCampaignReport({
        byCurrency: [brl, usd],
        summaryByCurrency: [brl, usd],
      }),
    );
    const html = await renderReports();
    const dolar = html.slice(html.indexOf('data-currency="USD"'));

    expect(dolar).toContain("sem cotação");
    expect(dolar).toContain(`€${NBSP}123,45`);
    expect(dolar).toContain("PTAX_SYNC_ENABLED");
    expect(
      html.slice(
        html.indexOf('data-currency="BRL"'),
        html.indexOf('data-currency="USD"'),
      ),
    ).not.toContain("sem cotação");
  });

  it("Visão Geral: cartão de receita mostra ROAS sem cotação e a dica", async () => {
    mockApi({
      ...baseReport,
      campaigns: [campaignRow()],
      currency: "BRL",
      exchangeRateMissing: true,
      unconvertedRevenue: [{ currency: "USD", valueCents: 7000 }],
      summary: campaignRow(),
    });
    const html = await renderOverview();

    expect(html).toContain("ROAS sem cotação");
    expect(html).toContain(`US$${NBSP}70,00`);
    expect(html).toContain("PTAX_SYNC_ENABLED");
    expect(html).not.toContain("ROAS 3.00x");
  });
});

describe("filtro por conta de anúncio", () => {
  it("Relatórios: várias contas vão para a API, para o CSV e para os formulários", async () => {
    const spy = mockApi(brlCampaignReport({ currency: "BRL" }));
    const html = await renderReports({
      adAccountIds: "act_BRL,act_USD",
    });
    const reportCall = spy.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.includes("/reports/campaigns"));

    expect(reportCall).toContain("adAccountIds=act_BRL%2Cact_USD");
    expect(reportCall).not.toContain("adAccountId=");
    expect(html).toContain('name="adAccountIds" value="act_BRL,act_USD"');
    // Link do CSV com as mesmas contas.
    expect(html).toMatch(
      /href="\/reports\/export\?[^"]*adAccountIds=act_BRL%2Cact_USD/,
    );
    expect(html).toContain("2 contas");
  });

  it("Relatórios: uma conta continua em adAccountId, como sempre", async () => {
    const spy = mockApi(brlCampaignReport({ currency: "BRL" }));
    const html = await renderReports({ adAccountId: "act_USD" });
    const reportCall = spy.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.includes("/reports/campaigns"));

    expect(reportCall).toContain("adAccountId=act_USD");
    expect(reportCall).not.toContain("adAccountIds");
    expect(html).toContain('name="adAccountId" value="act_USD"');
    expect(html).toContain("Conta Dolar");
  });

  it("Visão Geral: várias contas vão para a API e voltam no link dos relatórios", async () => {
    const spy = mockApi({
      ...baseReport,
      campaigns: [campaignRow()],
      summary: campaignRow(),
    });
    const html = await renderOverview({
      adAccountIds: "act_BRL,act_USD",
    });
    const reportCall = spy.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.includes("/reports/campaigns"));

    expect(reportCall).toBe(
      "http://localhost:3333/reports/campaigns?includeDaily=true&includeSummary=true&adAccountIds=act_BRL%2Cact_USD",
    );
    expect(html).toContain('name="adAccountIds" value="act_BRL,act_USD"');
    expect(html).toContain("2 contas");
    expect(html).toContain("Aplicar");
  });

  it("o CSV repassa adAccountIds para a API", async () => {
    const original = global.fetch;
    const fetchMock = vi.fn(
      async () =>
        new Response("Campanha\n", {
          status: 200,
          headers: { "Content-Type": "text/csv; charset=utf-8" },
        }),
    );

    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      await exportGet(
        new Request(
          "http://localhost/reports/export?since=2026-07-01&until=2026-07-02&adAccountIds=act_1%2Cact_2",
        ),
      );
    } finally {
      global.fetch = original;
    }

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3333/reports/campaigns/export.csv?since=2026-07-01&until=2026-07-02&adAccountIds=act_1%2Cact_2",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
