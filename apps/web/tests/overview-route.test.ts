import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import OverviewPage from "../src/app/(app)/overview/page";
import { overviewLeadsHref } from "../src/app/(app)/overview/overview-leads-links";

afterEach(() => {
  vi.restoreAllMocks();
});

function reportMetrics(overrides: Record<string, unknown> = {}) {
  const metrics = {
    spendCents: 10000,
    metaConversationsStarted: 10,
    costPerMetaConversationCents: 1000,
    realConversations: 6,
    costPerRealConversationCents: 1666,
    organicLeads: 2,
    totalReceived: 8,
    trackingRate: 0.75,
    qualifiedLead: 1,
    costPerQualifiedLeadCents: 10000,
    purchases: 1,
    firstPurchases: 1,
    repurchases: 0,
    costPerPurchaseCents: 10000,
    trafficRevenueCents: 30000,
    organicRevenueCents: 5000,
    totalRevenueCents: 35000,
    firstPurchaseRevenueCents: 30000,
    repurchaseRevenueCents: 0,
    roasAcquisition: 3,
    roasWithRepurchase: 3,
    funnelSteps: [
      {
        key: "real_conversations",
        label: "Conversas reais iniciadas",
        value: 6,
        costCents: 1666,
      },
      {
        key: "qualified_lead",
        label: "Lead qualificado",
        value: 1,
        costCents: 10000,
      },
      {
        key: "purchase",
        label: "Compras",
        value: 1,
        costCents: 10000,
      },
      {
        key: "first_purchase",
        label: "Primeira compra",
        value: 1,
      },
    ],
  };

  return { ...metrics, ...overrides };
}

describe("overview route", () => {
  it("applies period and Meta account filters and renders the daily comparison", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspaceId: "workspace_1",
            rangeLabel: "2026-07-01 a 2026-07-02",
            since: "2026-07-01",
            until: "2026-07-02",
            campaigns: [
              {
                id: "cmp_1",
                name: "Campanha Real",
                status: "active",
                ...reportMetrics(),
              },
            ],
            dailyComparisonAvailable: true,
            dailyComparison: [
              {
                date: "2026-07-01",
                metaConversationsStarted: 7,
                realConversations: 5,
              },
              {
                date: "2026-07-02",
                metaConversationsStarted: 3,
                realConversations: 1,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspaceId: "workspace_1",
            status: "connected",
            businesses: [],
            adAccounts: [],
            pixels: [],
            reportingAccounts: [
              {
                id: "reporting_1",
                workspaceId: "workspace_1",
                businessId: "business_1",
                businessName: "BM Principal",
                adAccountId: "act_1",
                adAccountName: "Conta Principal",
                currency: "BRL",
                timezoneName: "America/Sao_Paulo",
                active: true,
                syncStatus: "synced",
                lastSyncedAt: "2026-07-02T12:00:00.000Z",
                lastSyncSince: "2026-07-01",
                lastSyncUntil: "2026-07-02",
                syncError: null,
              },
              {
                id: "reporting_2",
                workspaceId: "workspace_1",
                businessId: "business_2",
                businessName: "BM Secundario",
                adAccountId: "act_2",
                adAccountName: "Conta Secundaria",
                currency: "BRL",
                timezoneName: "America/Sao_Paulo",
                active: true,
                syncStatus: "synced",
                lastSyncedAt: "2026-07-02T12:00:00.000Z",
                lastSyncSince: "2026-07-01",
                lastSyncUntil: "2026-07-02",
                syncError: null,
              },
            ],
            selection: {
              businessId: null,
              adAccountId: null,
              pixelId: null,
            },
            lastSyncedAt: "2026-07-02T12:00:00.000Z",
            syncError: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const element = await OverviewPage({
      searchParams: Promise.resolve({
        since: "2026-07-01",
        until: "2026-07-02",
        businessId: "business_1",
        adAccountId: "act_1",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/reports/campaigns?includeDaily=true&includeSummary=true&since=2026-07-01&until=2026-07-02&businessId=business_1&adAccountId=act_1",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("Periodo e contas");
    expect(html).toContain("BM Principal");
    expect(html).toContain("Conta Principal");
    expect(html).toContain("Meta x leads novos");
    expect(html).toContain("4 conversas a mais na Meta");
    expect(html).toContain("daily-comparison-chart");
    expect(html).toContain("overview-primary-metrics");
    expect(html).not.toContain("overview-summary-grid");

    const metricsPosition = html.indexOf("overview-primary-metrics");
    const funnelPosition = html.indexOf("overview-funnel-panel");
    const dailyPosition = html.indexOf("daily-comparison");

    expect(metricsPosition).toBeGreaterThan(-1);
    expect(funnelPosition).toBeGreaterThan(metricsPosition);
    expect(dailyPosition).toBeGreaterThan(funnelPosition);
  });

  it("renders aggregated campaign metrics returned by the backend", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workspaceId: "workspace_1",
          rangeLabel: "2026-07-01 a 2026-07-02",
          campaigns: [
            {
              id: "cmp_1",
              name: "Campanha Real",
              status: "active",
              ...reportMetrics(),
            },
            {
              id: "cmp_2",
              name: "Segunda Campanha",
              status: "paused",
              ...reportMetrics({
                spendCents: 5000,
                metaConversationsStarted: 5,
                realConversations: 2,
                costPerRealConversationCents: 2500,
                organicLeads: 1,
                totalReceived: 3,
                trackingRate: 2 / 3,
                qualifiedLead: 0,
                costPerQualifiedLeadCents: null,
                purchases: 0,
                firstPurchases: 0,
                costPerPurchaseCents: null,
                trafficRevenueCents: 0,
                organicRevenueCents: 0,
                totalRevenueCents: 0,
                firstPurchaseRevenueCents: 0,
                roasAcquisition: 0,
                roasWithRepurchase: 0,
                funnelSteps: [
                  {
                    key: "real_conversations",
                    label: "Conversas reais iniciadas",
                    value: 2,
                    costCents: 2500,
                  },
                ],
              }),
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await OverviewPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/reports/campaigns?includeDaily=true&includeSummary=true",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("2026-07-01 a 2026-07-02");
    expect(html).not.toContain("Campanha Real");
    expect(html).not.toContain("Segunda Campanha");
    expect(html).toContain("2 campanhas");
    expect(html.match(/class=\"metric-card/g)).toHaveLength(5);
    expect(html).toContain("Investimento");
    expect(html).not.toContain("Cobertura das conversas");
    expect(html).not.toContain("Conversas organicas");
    expect(html).not.toContain("attribution=organic");
    expect(html).not.toContain("Resumo do workspace");
    expect(html).toContain(">15<");
    expect(html).toContain(">8<");
    expect(html).toContain("Receita trafego");
    expect(html).toContain("Funil de conversao");
    expect(html).toContain("Base do funil");
    expect(html).toContain("da etapa anterior");
    expect(html).toContain("conversion-funnel-chart");
    expect(html).toContain("Custo por conversa Meta");
    expect(html).toContain("Custo por lead");
    expect(html).toContain("Custo por lead qualificado");
    expect(html).toContain("Custo por compra");
    expect(html).toContain("Custo por primeira compra");
    expect(html).toContain("1 primeira compra");
    expect(html).not.toContain("0 recompra");
    expect(html).toContain(">1<");
    expect(html).not.toContain("LeadSubmitted");
    expect(html).not.toContain("Black Friday WhatsApp");
  });

  it("shows repurchase cost when the period contains repurchases", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workspaceId: "workspace_1",
          rangeLabel: "Ultimos 7 dias",
          campaigns: [
            {
              id: "cmp_1",
              name: "Campanha com recompra",
              status: "active",
              ...reportMetrics({
                purchases: 2,
                firstPurchases: 1,
                repurchases: 1,
                repurchaseRevenueCents: 15000,
                roasWithRepurchase: 4.5,
                funnelSteps: [
                  ...reportMetrics().funnelSteps,
                  {
                    key: "repurchase",
                    label: "Recompra",
                    value: 1,
                    costCents: 10000,
                  },
                ],
              }),
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await OverviewPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("1 primeira compra, 1 recompra");
    expect(html).toContain("Custo por recompra");
    expect(html).not.toContain("ROAS com recompra");
  });

  it("aggregates InitiateCheckout into the overview funnel and primary metrics", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspaceId: "workspace_1",
            rangeLabel: "Ultimos 7 dias",
            campaigns: [
              {
                id: "cmp_1",
                name: "Campanha IC A",
                status: "active",
                ...reportMetrics({
                  spendCents: 20000,
                  funnelSteps: [
                    ...reportMetrics().funnelSteps,
                    {
                      key: "event_initiate_checkout",
                      label: "Checkout iniciado",
                      value: 3,
                      costCents: 6666,
                    },
                  ],
                }),
              },
              {
                id: "cmp_2",
                name: "Campanha IC B",
                status: "active",
                ...reportMetrics({
                  spendCents: 10000,
                  qualifiedLead: 0,
                  purchases: 0,
                  firstPurchases: 0,
                  trafficRevenueCents: 0,
                  totalRevenueCents: 0,
                  firstPurchaseRevenueCents: 0,
                  funnelSteps: [
                    {
                      key: "real_conversations",
                      label: "Conversas reais iniciadas",
                      value: 2,
                      costCents: 5000,
                    },
                    {
                      key: "event_initiate_checkout",
                      label: "Checkout iniciado",
                      value: 2,
                      costCents: 5000,
                    },
                  ],
                }),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspaceId: "workspace_1",
            status: "connected",
            businesses: [],
            adAccounts: [],
            pixels: [],
            reportingAccounts: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const element = await OverviewPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Checkout iniciado");
    expect(html).toContain("Custo por checkout iniciado");
    // Aggregated IC value 3+2 across campaigns
    expect(html).toContain(">5<");
    expect(html.match(/class=\"metric-card/g)).toHaveLength(6);
  });

  it("renders an empty overview state without mock campaign data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workspaceId: "workspace_1",
          rangeLabel: "Ultimos 7 dias",
          campaigns: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await OverviewPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Nenhuma campanha sincronizada");
    expect(html).toContain("0 campanhas");
    expect(html).not.toContain("Black Friday WhatsApp");
  });

  it("renders workspace conversations before campaign metadata is resolved", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          workspaceId: "workspace_1",
          rangeLabel: "Ultimos 7 dias",
          campaigns: [],
          summary: {
            id: "workspace_summary",
            name: "Resumo do workspace",
            status: "unknown",
            ...reportMetrics({
              spendCents: 0,
              metaConversationsStarted: 0,
              costPerMetaConversationCents: null,
              realConversations: 4,
              costPerRealConversationCents: 0,
              organicLeads: 1,
              totalReceived: 5,
              trackingRate: 0.8,
              qualifiedLead: 0,
              costPerQualifiedLeadCents: null,
              purchases: 0,
              firstPurchases: 0,
              costPerPurchaseCents: null,
              trafficRevenueCents: 0,
              organicRevenueCents: 0,
              totalRevenueCents: 0,
              firstPurchaseRevenueCents: 0,
              roasAcquisition: null,
              roasWithRepurchase: null,
            }),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await OverviewPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("0 campanhas");
    expect(html).toContain("Conversas reais");
    expect(html).toContain(">4<");
    expect(html).not.toContain("Resumo do workspace");
    expect(html).not.toContain("Conversas organicas");
    expect(html).not.toContain("Aguardando conversas");
  });

  it("renders an unavailable overview state without mock campaign data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("offline", { status: 503 }),
    );

    const element = await OverviewPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("API indisponivel");
    expect(html).toContain("Dados temporariamente indisponiveis");
    expect(html).toContain("Aguardando resposta da API");
    expect(html).not.toContain("Resumo do workspace");
    expect(html).not.toContain("Qualidade do rastreamento");
    expect(html).not.toContain("0% conciliadas");
    expect(html).not.toContain("Black Friday WhatsApp");
  });
});

// "Leads no período" (leads novos x leads que voltaram), ported from the SaaS.

type LeadsBlockItem = {
  key: string;
  label: string;
  value: string;
  caption: string;
  href: string | null;
};

/** Parses the "Leads no período" block in DOM order. */
function leadsBlockItems(html: string): LeadsBlockItem[] {
  const block = html.slice(
    html.indexOf("overview-leads-block"),
    html.indexOf("overview-funnel-panel"),
  );
  const pattern =
    /data-leads-block="([^"]+)"><dt><span>(.*?)<\/span>.*?<\/dt><dd><strong>(.*?)<\/strong><small>(.*?)<\/small><\/dd>/g;
  const text = (value: string) => value.replace(/<[^>]+>/g, "");
  const items: LeadsBlockItem[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(block)) !== null) {
    items.push({
      key: match[1]!,
      label: match[2]!,
      value: text(match[3]!),
      caption: text(match[4]!),
      href:
        /href="([^"]+)"/.exec(match[3]!)?.[1]?.replace(/&amp;/g, "&") ?? null,
    });
  }

  return items;
}

async function renderOverviewWith(
  report: Record<string, unknown>,
  searchParams: Record<string, string>,
) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body = url.includes("/reports/campaigns")
      ? report
      : {
          workspaceId: "workspace_1",
          status: "connected",
          businesses: [],
          adAccounts: [],
          pixels: [],
          reportingAccounts: [],
        };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const element = await OverviewPage({
    searchParams: Promise.resolve(searchParams),
  });

  return renderToStaticMarkup(createElement("div", null, element));
}

function leadsSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "workspace_summary",
    name: "Resumo do workspace",
    status: "active",
    ...reportMetrics({
      spendCents: 412000,
      realConversations: 412,
      costPerRealConversationCents: 1000,
      returningLeads: 0,
      repeatConversationLeads: 38,
      adConversationEvents: 570,
      ...overrides,
    }),
  };
}

describe("overview leads no periodo", () => {
  it("always shows the four readings, zeros included, with the Leads lists behind them", async () => {
    const html = await renderOverviewWith(
      {
        workspaceId: "workspace_1",
        rangeLabel: "Ultimos 7 dias",
        since: "2026-10-08",
        until: "2026-10-14",
        campaigns: [],
        summary: leadsSummary(),
      },
      { since: "2026-10-08", until: "2026-10-14" },
    );
    const period = "attribution=paid&since=2026-10-08&until=2026-10-14";

    expect(html).toContain("Leads no período");
    expect(leadsBlockItems(html)).toEqual([
      {
        key: "new",
        label: "Leads novos",
        value: "412",
        caption: "Custo por lead novo R$ 10,00",
        href: `/leads?${period}`,
      },
      {
        key: "returning",
        label: "Voltaram por anúncio",
        value: "0",
        caption: "Já eram leads antes do período",
        href: `/leads?${period}&base=returning`,
      },
      {
        key: "repeat",
        label: "Conversaram mais de uma vez",
        value: "38",
        caption: "2 ou mais conversas no período",
        href: `/leads?${period}&base=repeat`,
      },
      {
        key: "conversations",
        label: "Conversas por anúncio",
        value: "570",
        caption: "Inclui conversas repetidas",
        href: null,
      },
    ]);
    expect(html).toContain(
      "Já eram leads antes do período e chamaram de novo por anúncio.",
    );
    expect(html).toContain('aria-label="O que é: Conversas por anúncio"');
    // Closed until hovered, focused or tapped (iOS taps toggle it).
    expect(html).toContain('aria-expanded="false"');
    // The KPI card keeps the headline and opens the same Leads list.
    expect(html).toContain(
      `<span>Leads novos</span><strong><a class="kpi-number-link" aria-label="412 - Ver os leads novos na lista de leads" href="/leads?${period.replace(/&/g, "&amp;")}">412</a></strong><small>1º contato no período</small>`,
    );
  });

  it("drops the links the Leads page cannot reproduce", async () => {
    const html = await renderOverviewWith(
      {
        workspaceId: "workspace_1",
        rangeLabel: "Hoje",
        since: "2026-10-14",
        until: "2026-10-14",
        campaigns: [],
        summary: leadsSummary(),
      },
      { since: "2026-10-14", until: "2026-10-14", adAccountId: "act_1" },
    );

    expect(leadsBlockItems(html).map((item) => item.href)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(html).not.toContain('href="/leads?');
  });

  it("shows a dash for numbers an older API does not send", async () => {
    const html = await renderOverviewWith(
      {
        workspaceId: "workspace_1",
        rangeLabel: "Hoje",
        since: "2026-10-14",
        until: "2026-10-14",
        campaigns: [],
        summary: {
          id: "workspace_summary",
          name: "Resumo do workspace",
          status: "active",
          ...reportMetrics({ realConversations: 3 }),
        },
      },
      { since: "2026-10-14", until: "2026-10-14" },
    );

    expect(
      leadsBlockItems(html).map((item) => [item.key, item.value, item.href]),
    ).toEqual([
      ["new", "3", "/leads?attribution=paid&since=2026-10-14&until=2026-10-14"],
      // No link on "-": there is no number to reproduce.
      ["returning", "-", null],
      ["repeat", "-", null],
      ["conversations", "-", null],
    ]);
  });

  it("keeps the block visible with dashes when the API is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    const element = await OverviewPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Leads no período");
    expect(leadsBlockItems(html).map((item) => item.value)).toEqual([
      "-",
      "-",
      "-",
      "-",
    ]);
    expect(html).toContain("Aguardando resposta da API");
  });
});

describe("overview daily returns", () => {
  it("draws leads novos and returns as separate series with matching legend", async () => {
    const html = await renderOverviewWith(
      {
        workspaceId: "workspace_1",
        rangeLabel: "Ultimos 2 dias",
        since: "2026-10-13",
        until: "2026-10-14",
        campaigns: [],
        summary: leadsSummary({ realConversations: 3, returningLeads: 1 }),
        dailyComparisonAvailable: true,
        dailyComparison: [
          {
            date: "2026-10-13",
            metaConversationsStarted: 3,
            realConversations: 2,
            returningLeads: 1,
          },
          {
            date: "2026-10-14",
            metaConversationsStarted: 2,
            realConversations: 1,
            returningLeads: 1,
          },
        ],
      },
      { since: "2026-10-13", until: "2026-10-14" },
    );

    // Same person back on both days: 1 in the block, 2 returns per day.
    expect(
      leadsBlockItems(html).find((item) => item.key === "returning")?.value,
    ).toBe("1");
    expect(html).toContain("Conversas contadas pela Meta <strong>5</strong>");
    expect(html).toContain("Leads novos <strong>3</strong>");
    expect(html).toContain("Retornos (por dia) <strong>2</strong>");
    expect(html.match(/class="daily-bar returning"/g)).toHaveLength(2);
    expect(html).toContain("13/10 - Retornos: 1");
    expect(html).toContain("14/10 - Leads novos: 1");
  });

  it("keeps the returns series and legend at zero for an older API", async () => {
    const html = await renderOverviewWith(
      {
        workspaceId: "workspace_1",
        rangeLabel: "Hoje",
        since: "2026-10-14",
        until: "2026-10-14",
        campaigns: [],
        summary: leadsSummary({ realConversations: 1 }),
        dailyComparisonAvailable: true,
        dailyComparison: [
          {
            date: "2026-10-14",
            metaConversationsStarted: 2,
            realConversations: 1,
          },
        ],
      },
      { since: "2026-10-14", until: "2026-10-14" },
    );

    expect(html).toContain("Retornos (por dia) <strong>0</strong>");
    expect(html).toContain("14/10 - Retornos: 0");
  });
});

describe("overviewLeadsHref", () => {
  it("builds the Leads list of each overview number", () => {
    const period = { since: "2026-10-14", until: "2026-10-14" };

    expect(overviewLeadsHref({}, period, "new")).toBe(
      "/leads?attribution=paid&since=2026-10-14&until=2026-10-14",
    );
    expect(overviewLeadsHref({}, period, "returning")).toBe(
      "/leads?attribution=paid&since=2026-10-14&until=2026-10-14&base=returning",
    );
    expect(overviewLeadsHref({}, period, "repeat")).toBe(
      "/leads?attribution=paid&since=2026-10-14&until=2026-10-14&base=repeat",
    );
    expect(overviewLeadsHref({}, {}, "new")).toBe("/leads?attribution=paid");
    expect(overviewLeadsHref({}, {}, "returning")).toBeNull();
    expect(overviewLeadsHref({}, {}, "repeat")).toBeNull();
    // The Leads page has no BM/account filter.
    expect(overviewLeadsHref({ businessId: "bm" }, period, "new")).toBeNull();
    expect(overviewLeadsHref({ adAccountId: "act" }, period, "new")).toBeNull();
  });
});
