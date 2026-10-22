// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  usePathname: () => "/reports",
  useRouter: () => ({ push: routerPush, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import ReportsPage from "../src/app/(app)/reports/page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  routerPush.mockReset();
});

const funnelSteps = [
  { key: "real_conversations", label: "Conversas reais", value: 0, costCents: null },
  { key: "qualified_lead", label: "Oportunidades", value: 0, costCents: null },
  { key: "purchase", label: "Vendas", value: 0, costCents: null },
];

function metrics(values: {
  realConversations: number;
  qualifiedLead: number;
  purchases: number;
}) {
  const spendCents = 100000;
  const costPer = (value: number) =>
    value > 0 ? Math.floor(spendCents / value) : null;

  return {
    spendCents,
    metaConversationsStarted: 10,
    costPerMetaConversationCents: 10000,
    realConversations: values.realConversations,
    costPerRealConversationCents: costPer(values.realConversations),
    organicLeads: 0,
    totalReceived: values.realConversations,
    trackingRate: 1,
    qualifiedLead: values.qualifiedLead,
    costPerQualifiedLeadCents: costPer(values.qualifiedLead),
    purchases: values.purchases,
    firstPurchases: values.purchases,
    repurchases: 0,
    costPerPurchaseCents: costPer(values.purchases),
    trafficRevenueCents: 0,
    organicRevenueCents: 0,
    totalRevenueCents: 0,
    firstPurchaseRevenueCents: 0,
    repurchaseRevenueCents: 0,
    roasAcquisition: null,
    roasWithRepurchase: null,
    funnelSteps: [
      {
        ...funnelSteps[0],
        value: values.realConversations,
        costCents: costPer(values.realConversations),
      },
      {
        ...funnelSteps[1],
        value: values.qualifiedLead,
        costCents: costPer(values.qualifiedLead),
      },
      {
        ...funnelSteps[2],
        value: values.purchases,
        costCents: costPer(values.purchases),
      },
    ],
  };
}

const base = {
  status: "active",
  configuredStatus: "ACTIVE",
  effectiveStatus: "ACTIVE",
  whatsappClassification: "auto_include",
};

// Server order on purpose: neither ascending nor descending by any metric,
// so a client-side reorder would be visible in the DOM.
const campaignRows = [
  { ...base, id: "cmp_b", name: "Campanha B", ...metrics({ realConversations: 4, qualifiedLead: 1, purchases: 3 }) },
  { ...base, id: "cmp_a", name: "Campanha A", ...metrics({ realConversations: 9, qualifiedLead: 7, purchases: 0 }) },
  { ...base, id: "cmp_c", name: "Campanha C", ...metrics({ realConversations: 2, qualifiedLead: 3, purchases: 5 }) },
];

function campaignReport() {
  return {
    workspaceId: "workspace_1",
    rangeLabel: "Ultimos 7 dias",
    since: "2026-07-06",
    until: "2026-07-12",
    campaigns: campaignRows,
    totals: metrics({ realConversations: 15, qualifiedLead: 11, purchases: 8 }),
    pagination: { page: 1, pageSize: 10, totalItems: 25, totalPages: 3 },
  };
}

function adSetReport() {
  return {
    workspaceId: "workspace_1",
    rangeLabel: "Ultimos 7 dias",
    since: "2026-07-06",
    until: "2026-07-12",
    adSets: [
      {
        ...base,
        id: "adset_1",
        campaignId: "cmp_a",
        campaignName: "Campanha A",
        name: "Publico 1",
        ...metrics({ realConversations: 3, qualifiedLead: 2, purchases: 1 }),
      },
    ],
    totals: metrics({ realConversations: 3, qualifiedLead: 2, purchases: 1 }),
    pagination: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
  };
}

function adReport() {
  return {
    workspaceId: "workspace_1",
    rangeLabel: "Ultimos 7 dias",
    since: "2026-07-06",
    until: "2026-07-12",
    ads: [
      {
        ...base,
        id: "ad_1",
        campaignId: "cmp_a",
        campaignName: "Campanha A",
        adSetId: "adset_1",
        adSetName: "Publico 1",
        name: "Criativo 1",
        thumbnailUrl: null,
        previewUrl: null,
        ...metrics({ realConversations: 3, qualifiedLead: 2, purchases: 1 }),
      },
    ],
    totals: metrics({ realConversations: 3, qualifiedLead: 2, purchases: 1 }),
    pagination: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
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

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockReportsApi() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);

    if (url.includes("/workspaces/current")) {
      return json(workspace);
    }

    if (url.includes("/integrations/meta/assets")) {
      return json({ reportingAccounts: [], lastSyncedAt: null });
    }

    if (url.includes("/reports/adsets")) {
      return json(adSetReport());
    }

    if (url.includes("/reports/ads")) {
      return json(adReport());
    }

    if (url.includes("/reports/campaigns")) {
      return json(campaignReport());
    }

    return json({ message: "not found" }, 404);
  });
}

async function renderReports(searchParams: Record<string, string> = {}) {
  const fetchMock = mockReportsApi();
  const element = await ReportsPage({
    searchParams: Promise.resolve(searchParams),
  });
  const view = render(createElement("div", null, element));
  const apiUrls = fetchMock.mock.calls.map(([input]) => String(input));

  return { ...view, apiUrls };
}

function reportCall(apiUrls: string[], endpoint: string) {
  return apiUrls.find((url) =>
    new RegExp(`/reports/${endpoint}(?:\\?|$)`).test(url),
  );
}

function queryOf(url: string | undefined) {
  return new URL(url ?? "", "http://api.test").searchParams;
}

function table() {
  return screen.getByRole("table");
}

function header(name: RegExp) {
  return within(table()).getByRole("columnheader", { name });
}

function sortButton(name: RegExp) {
  return within(table()).getByRole("button", { name });
}

function pushedUrl() {
  expect(routerPush).toHaveBeenCalledTimes(1);
  const [href, options] = routerPush.mock.calls[0];

  expect(options).toEqual({ scroll: false });

  return new URL(String(href), "http://web.test");
}

function bodyRowNames() {
  const [, body] = within(table()).getAllByRole("rowgroup");

  return within(body)
    .getAllByRole("row")
    .map(
      (row) =>
        row.querySelector(".performance-name-cell .presentation-mask-value")
          ?.textContent,
    );
}

describe("reports column sorting", () => {
  it("keeps the unsorted request and markup when no sort is in the URL", async () => {
    const { apiUrls } = await renderReports();
    const query = queryOf(reportCall(apiUrls, "campaigns"));

    expect(query.has("sort")).toBe(false);
    expect(query.has("dir")).toBe(false);
    expect(table().querySelectorAll("th[aria-sort]")).toHaveLength(0);
    expect(sortButton(/^Oportunidades$/).getAttribute("type")).toBe("button");
    expect(sortButton(/^Vendas$/)).toBeTruthy();
    expect(sortButton(/^Conversas reais$/)).toBeTruthy();
    expect(bodyRowNames()).toEqual(["Campanha B", "Campanha A", "Campanha C"]);
  });

  it("does not offer sorting for metrics the API cannot order", async () => {
    await renderReports();

    expect(header(/^Investimento$/).querySelector("button")).toBeNull();
    expect(header(/^Conversas Meta$/).querySelector("button")).toBeNull();
    expect(header(/^ROAS aquisicao$/).querySelector("button")).toBeNull();
  });

  it("requests qualified leads descending on first click and resets to page 1", async () => {
    await renderReports({ page: "3", nameContains: "Camp", businessId: "bm_1" });

    fireEvent.click(sortButton(/^Oportunidades$/));

    const url = pushedUrl();
    expect(url.pathname).toBe("/reports");
    expect(url.searchParams.get("sort")).toBe("qualifiedLead");
    expect(url.searchParams.get("dir")).toBe("desc");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("view")).toBe("campaigns");
    expect(url.searchParams.get("nameContains")).toBe("Camp");
    expect(url.searchParams.get("businessId")).toBe("bm_1");
  });

  it("sends the URL sort to the API, marks only the active header and keeps server row order", async () => {
    const { apiUrls } = await renderReports({
      sort: "qualifiedLead",
      dir: "desc",
    });
    const query = queryOf(reportCall(apiUrls, "campaigns"));

    expect(query.get("sort")).toBe("qualifiedLead");
    expect(query.get("dir")).toBe("desc");
    expect(header(/^Oportunidades/).getAttribute("aria-sort")).toBe(
      "descending",
    );
    expect(table().querySelectorAll("th[aria-sort]")).toHaveLength(1);
    expect(
      sortButton(/^Oportunidades/).querySelector(".report-sort-arrow"),
    ).not.toBeNull();
    expect(
      sortButton(/^Vendas$/).querySelector(".report-sort-arrow"),
    ).toBeNull();
    expect(bodyRowNames()).toEqual(["Campanha B", "Campanha A", "Campanha C"]);
  });

  it("toggles the active key to ascending on a second click", async () => {
    await renderReports({ sort: "qualifiedLead", dir: "desc", page: "2" });

    fireEvent.click(sortButton(/^Oportunidades/));

    const url = pushedUrl();
    expect(url.searchParams.get("sort")).toBe("qualifiedLead");
    expect(url.searchParams.get("dir")).toBe("asc");
    expect(url.searchParams.get("page")).toBe("1");
  });

  it("switches to purchases descending when another header is clicked", async () => {
    await renderReports({ sort: "qualifiedLead", dir: "asc" });

    fireEvent.click(sortButton(/^Vendas$/));

    const url = pushedUrl();
    expect(url.searchParams.get("sort")).toBe("purchases");
    expect(url.searchParams.get("dir")).toBe("desc");
  });

  it("marks purchases ascending and flips back to descending", async () => {
    const { apiUrls } = await renderReports({ sort: "purchases", dir: "asc" });

    expect(queryOf(reportCall(apiUrls, "campaigns")).get("dir")).toBe("asc");
    expect(header(/^Vendas/).getAttribute("aria-sort")).toBe("ascending");

    fireEvent.click(sortButton(/^Vendas/));

    expect(pushedUrl().searchParams.get("dir")).toBe("desc");
  });

  it("sorts by the cost shown under each funnel column", async () => {
    await renderReports();

    fireEvent.click(sortButton(/^Custo por Vendas$/));

    const url = pushedUrl();
    expect(url.searchParams.get("sort")).toBe("costPerPurchaseCents");
    expect(url.searchParams.get("dir")).toBe("desc");
  });

  it("marks the funnel column when its cost is the active sort", async () => {
    const { apiUrls } = await renderReports({
      sort: "costPerQualifiedLeadCents",
      dir: "asc",
    });

    expect(queryOf(reportCall(apiUrls, "campaigns")).get("sort")).toBe(
      "costPerQualifiedLeadCents",
    );
    expect(header(/^Oportunidades/).getAttribute("aria-sort")).toBe(
      "ascending",
    );
    expect(
      sortButton(/^Custo por Oportunidades/).querySelector(".report-sort-arrow"),
    ).not.toBeNull();
    expect(
      sortButton(/^Oportunidades$/).querySelector(".report-sort-arrow"),
    ).toBeNull();
  });

  it.each([
    ["adsets", "Publico 1"],
    ["ads", "Criativo 1"],
  ])("sorts the %s level through its own endpoint", async (view, rowName) => {
    const { apiUrls } = await renderReports({
      view,
      sort: "purchases",
      dir: "desc",
    });
    const query = queryOf(reportCall(apiUrls, view));

    expect(query.get("sort")).toBe("purchases");
    expect(query.get("dir")).toBe("desc");
    expect(screen.getAllByText(rowName).length).toBeGreaterThan(0);
    expect(header(/^Vendas/).getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(sortButton(/^Oportunidades$/));

    const url = pushedUrl();
    expect(url.searchParams.get("view")).toBe(view);
    expect(url.searchParams.get("sort")).toBe("qualifiedLead");
    expect(url.searchParams.get("dir")).toBe("desc");
  });

  it.each([
    [{ sort: "cpm", dir: "desc" }],
    [{ sort: "spendCents" }],
    [{ dir: "asc" }],
  ])("drops unsupported URL sort %o instead of sending it to the API", async (params) => {
    const { apiUrls } = await renderReports(params);
    const query = queryOf(reportCall(apiUrls, "campaigns"));

    expect(query.has("sort")).toBe(false);
    expect(query.has("dir")).toBe(false);
    expect(table().querySelectorAll("th[aria-sort]")).toHaveLength(0);
  });

  it("falls back to descending for an invalid direction on a valid key", async () => {
    const { apiUrls } = await renderReports({
      sort: "qualifiedLead",
      dir: "sideways",
    });
    const query = queryOf(reportCall(apiUrls, "campaigns"));

    expect(query.get("sort")).toBe("qualifiedLead");
    expect(query.get("dir")).toBe("desc");
  });

  it("preserves the sort in pagination links", async () => {
    const { container } = await renderReports({
      sort: "qualifiedLead",
      dir: "asc",
      nameContains: "Camp",
    });
    const next = within(
      container.querySelector<HTMLElement>(".report-pagination")!,
    ).getByRole("link", { name: "Proxima" });
    const url = new URL(next.getAttribute("href")!, "http://web.test");

    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("sort")).toBe("qualifiedLead");
    expect(url.searchParams.get("dir")).toBe("asc");
    expect(url.searchParams.get("nameContains")).toBe("Camp");
  });

  it("keeps the sort exactly once in each GET form and the Meta sync form", async () => {
    const { container } = await renderReports({
      sort: "purchases",
      dir: "asc",
      diagnostic: "open",
    });
    const forms = [
      container.querySelector(".report-period-form"),
      container.querySelector(".report-filter-form"),
      container.querySelector(".meta-structure-filters"),
      container.querySelector(".report-command-actions form"),
    ];

    for (const form of forms) {
      expect(form).not.toBeNull();
      const sortInputs = form!.querySelectorAll('input[name="sort"]');
      const dirInputs = form!.querySelectorAll('input[name="dir"]');

      expect(sortInputs).toHaveLength(1);
      expect(dirInputs).toHaveLength(1);
      expect((sortInputs[0] as HTMLInputElement).value).toBe("purchases");
      expect((dirInputs[0] as HTMLInputElement).value).toBe("asc");
      expect(form!.querySelector('input[name="page"]')).toBeNull();
    }
  });

  it("adds no sort inputs to forms when no sort is active", async () => {
    const { container } = await renderReports({ diagnostic: "open" });

    expect(container.querySelectorAll('input[name="sort"]')).toHaveLength(0);
    expect(container.querySelectorAll('input[name="dir"]')).toHaveLength(0);
  });

  it("keeps the sort when switching report level and resets the page", async () => {
    await renderReports({ sort: "qualifiedLead", dir: "asc", page: "2" });
    const levelLink = within(
      screen.getByRole("navigation", { name: "Nivel do relatorio" }),
    ).getByRole("link", { name: "Conjuntos" });
    const url = new URL(levelLink.getAttribute("href")!, "http://web.test");

    expect(url.searchParams.get("view")).toBe("adsets");
    expect(url.searchParams.get("sort")).toBe("qualifiedLead");
    expect(url.searchParams.get("dir")).toBe("asc");
    expect(url.searchParams.get("page")).toBe("1");
  });

  it("keeps the sort when drilling from a campaign into its ad sets", async () => {
    await renderReports({ sort: "purchases", dir: "desc" });
    const drill = within(table()).getByRole("link", { name: /^Campanha A/ });
    const url = new URL(drill.getAttribute("href")!, "http://web.test");

    expect(url.searchParams.get("view")).toBe("adsets");
    expect(url.searchParams.get("campaignId")).toBe("cmp_a");
    expect(url.searchParams.get("sort")).toBe("purchases");
  });

  it("keeps the sort only for metric groups that show the sorted column", async () => {
    await renderReports({ sort: "qualifiedLead", dir: "desc" });
    const tabs = within(
      screen.getByRole("navigation", { name: "Grupo de metricas" }),
    );
    const hrefFor = (name: string) =>
      new URL(
        tabs.getByRole("link", { name }).getAttribute("href")!,
        "http://web.test",
      ).searchParams;

    expect(hrefFor("Funil").get("sort")).toBe("qualifiedLead");
    expect(hrefFor("Trafego").has("sort")).toBe(false);
    expect(hrefFor("Receita").has("sort")).toBe(false);
    expect(hrefFor("Receita").has("dir")).toBe(false);
  });

  it("ignores a URL sort whose column is hidden by the metric group", async () => {
    const { apiUrls } = await renderReports({
      metrics: "revenue",
      sort: "purchases",
      dir: "desc",
    });

    expect(queryOf(reportCall(apiUrls, "campaigns")).has("sort")).toBe(false);
  });

  it("keeps real conversation sorting in the traffic group", async () => {
    const { apiUrls } = await renderReports({
      metrics: "traffic",
      sort: "costPerRealConversationCents",
      dir: "asc",
    });

    expect(queryOf(reportCall(apiUrls, "campaigns")).get("sort")).toBe(
      "costPerRealConversationCents",
    );
    expect(header(/^Conversas reais/).getAttribute("aria-sort")).toBe(
      "ascending",
    );
  });

  it("leaves CSV export and the comparison request unsorted", async () => {
    const { apiUrls } = await renderReports({
      sort: "purchases",
      dir: "desc",
      since: "2026-07-08",
      until: "2026-07-14",
      compareSince: "2026-07-01",
      compareUntil: "2026-07-07",
    });
    const exportHref = screen
      .getByRole("link", { name: /Exportar CSV/ })
      .getAttribute("href")!;
    const comparisonCall = apiUrls.find(
      (url) =>
        url.includes("/reports/campaigns") && url.includes("since=2026-07-01"),
    );
    const mainCall = apiUrls.find(
      (url) =>
        url.includes("/reports/campaigns") && url.includes("since=2026-07-08"),
    );

    expect(exportHref).not.toContain("sort=");
    expect(exportHref).not.toContain("dir=");
    expect(comparisonCall).toBeDefined();
    expect(queryOf(comparisonCall).has("sort")).toBe(false);
    expect(queryOf(mainCall).get("sort")).toBe("purchases");
  });

  it("keeps the sort when clearing Meta filters", async () => {
    const { container } = await renderReports({
      sort: "purchases",
      dir: "asc",
      nameContains: "Camp",
    });
    const clear = within(
      container.querySelector<HTMLElement>(".report-filter-form")!,
    ).getByRole("link", { name: "Limpar filtros" });
    const url = new URL(clear.getAttribute("href")!, "http://web.test");

    expect(url.searchParams.has("nameContains")).toBe(false);
    expect(url.searchParams.get("sort")).toBe("purchases");
    expect(url.searchParams.get("dir")).toBe("asc");
  });

  it("offers the same sort actions in a mobile toolbar outside the hidden table header", async () => {
    const { container } = await renderReports({
      sort: "purchases",
      dir: "desc",
    });
    const toolbar = within(
      container.querySelector<HTMLElement>(".report-sort-toolbar")!,
    );
    const active = toolbar.getByRole("button", { name: /^Vendas/ });

    expect(
      screen.getByRole("group", { name: "Ordenar resultados" }),
    ).toBeTruthy();
    expect(active.getAttribute("aria-pressed")).toBe("true");
    expect(
      toolbar
        .getByRole("button", { name: /^Oportunidades$/ })
        .getAttribute("aria-pressed"),
    ).toBe("false");

    fireEvent.click(active);

    const url = pushedUrl();
    expect(url.searchParams.get("sort")).toBe("purchases");
    expect(url.searchParams.get("dir")).toBe("asc");
  });
});
