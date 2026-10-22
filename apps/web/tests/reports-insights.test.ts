// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  usePathname: () => "/reports",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import ReportsPage from "../src/app/(app)/reports/page";
import {
  REPORT_INSIGHT_FETCH_SIZE,
  REPORT_INSIGHT_MIN_SAMPLE,
  REPORT_INSIGHT_TOP_N,
  buildReportInsightRanking,
  parseReportInsightObjective,
  reportInsightSorts,
} from "../src/app/(app)/reports/report-insights";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Values = {
  spendCents: number;
  realConversations: number;
  qualifiedLead: number;
  purchases: number;
};

const trackedSteps = [
  ["real_conversations", "Conversas reais iniciadas", "realConversations"],
  ["qualified_lead", "Oportunidades", "qualifiedLead"],
  ["purchase", "Vendas", "purchases"],
] as const;

function costPer(spendCents: number, value: number) {
  return value > 0 ? Math.floor(spendCents / value) : null;
}

function metrics(
  values: Values,
  steps: readonly (typeof trackedSteps)[number][] = trackedSteps,
) {
  return {
    spendCents: values.spendCents,
    metaConversationsStarted: values.realConversations,
    costPerMetaConversationCents: costPer(
      values.spendCents,
      values.realConversations,
    ),
    realConversations: values.realConversations,
    costPerRealConversationCents: costPer(
      values.spendCents,
      values.realConversations,
    ),
    organicLeads: 0,
    totalReceived: values.realConversations,
    trackingRate: values.realConversations > 0 ? 1 : null,
    qualifiedLead: values.qualifiedLead,
    costPerQualifiedLeadCents: costPer(values.spendCents, values.qualifiedLead),
    purchases: values.purchases,
    firstPurchases: values.purchases,
    repurchases: 0,
    costPerPurchaseCents: costPer(values.spendCents, values.purchases),
    trafficRevenueCents: 0,
    organicRevenueCents: 0,
    totalRevenueCents: 0,
    firstPurchaseRevenueCents: 0,
    repurchaseRevenueCents: 0,
    roasAcquisition: null,
    roasWithRepurchase: null,
    funnelSteps: steps.map(([key, label, field]) => ({
      key,
      label,
      value: values[field],
      costCents: costPer(values.spendCents, values[field]),
    })),
  };
}

const base = {
  status: "active",
  configuredStatus: "ACTIVE",
  effectiveStatus: "ACTIVE",
  whatsappClassification: "auto_include",
};

function campaign(id: string, name: string, values: Values) {
  return { ...base, id, name, ...metrics(values) };
}

// Unsorted server order. "Campanha Z" is the 11th item, so it is outside the
// first page of the default 10-item table and only reaches the top through
// the API ordering applied before pagination.
const campaignPopulation = [
  campaign("cmp_a", "Campanha A", {
    spendCents: 50000,
    realConversations: 9,
    qualifiedLead: 7,
    purchases: 0,
  }),
  campaign("cmp_b", "Campanha B", {
    spendCents: 40000,
    realConversations: 8,
    qualifiedLead: 1,
    purchases: 3,
  }),
  campaign("cmp_c", "Campanha C", {
    spendCents: 30000,
    realConversations: 6,
    qualifiedLead: 3,
    purchases: 5,
  }),
  campaign("cmp_d", "Campanha D", {
    spendCents: 20000,
    realConversations: 5,
    qualifiedLead: 2,
    purchases: 1,
  }),
  campaign("cmp_e", "Campanha E", {
    spendCents: 10000,
    realConversations: 0,
    qualifiedLead: 0,
    purchases: 0,
  }),
  campaign("cmp_f", "Campanha F", {
    spendCents: 500,
    realConversations: 1,
    qualifiedLead: 1,
    purchases: 1,
  }),
  campaign("cmp_g", "Campanha G", {
    spendCents: 0,
    realConversations: 3,
    qualifiedLead: 0,
    purchases: 0,
  }),
  campaign("cmp_h", "Campanha H", {
    spendCents: 15000,
    realConversations: 2,
    qualifiedLead: 0,
    purchases: 0,
  }),
  campaign("cmp_i", "Campanha I", {
    spendCents: 12000,
    realConversations: 2,
    qualifiedLead: 0,
    purchases: 0,
  }),
  campaign("cmp_j", "Campanha J", {
    spendCents: 9000,
    realConversations: 1,
    qualifiedLead: 0,
    purchases: 0,
  }),
  campaign("cmp_z", "Campanha Z", {
    spendCents: 60000,
    realConversations: 40,
    qualifiedLead: 12,
    purchases: 6,
  }),
];

const adSetPopulation = [
  {
    ...base,
    id: "adset_1",
    campaignId: "cmp_a",
    campaignName: "Campanha A",
    name: "Publico 1",
    ...metrics({
      spendCents: 9000,
      realConversations: 3,
      qualifiedLead: 2,
      purchases: 1,
    }),
  },
  {
    ...base,
    id: "adset_2",
    campaignId: "cmp_a",
    campaignName: "Campanha A",
    name: "Publico 2",
    ...metrics({
      spendCents: 30000,
      realConversations: 20,
      qualifiedLead: 6,
      purchases: 2,
    }),
  },
];

const adPopulation = [
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
    ...metrics({
      spendCents: 9000,
      realConversations: 3,
      qualifiedLead: 2,
      purchases: 1,
    }),
  },
  {
    ...base,
    id: "ad_2",
    campaignId: "cmp_a",
    campaignName: "Campanha A",
    adSetId: "adset_2",
    adSetName: "Publico 2",
    name: "Criativo 2",
    thumbnailUrl: "https://cdn.example.test/ad_2.jpg",
    previewUrl: "https://cdn.example.test/ad_2-full.jpg",
    ...metrics({
      spendCents: 30000,
      realConversations: 20,
      qualifiedLead: 6,
      purchases: 2,
    }),
  },
];

function sumValues(rows: Array<Values>): Values {
  return rows.reduce(
    (total, row) => ({
      spendCents: total.spendCents + row.spendCents,
      realConversations: total.realConversations + row.realConversations,
      qualifiedLead: total.qualifiedLead + row.qualifiedLead,
      purchases: total.purchases + row.purchases,
    }),
    { spendCents: 0, realConversations: 0, qualifiedLead: 0, purchases: 0 },
  );
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

type ApiOptions = {
  failing?: boolean;
  population?: {
    campaigns?: Array<ReturnType<typeof campaign>>;
  };
  steps?: readonly (typeof trackedSteps)[number][];
};

// Same ordering contract as apps/api/src/reporting/report-row-sort.ts: finite
// values by direction (zero included), missing values last in both
// directions, ties by name then id. Kept local so the web typecheck does not
// depend on API sources.
function sortReportRows<T extends { id: string; name: string }>(
  rows: readonly T[],
  sort: { key: string; direction: "asc" | "desc" },
): T[] {
  const factor = sort.direction === "asc" ? 1 : -1;
  const valueOf = (row: T) => {
    const value = (row as Record<string, unknown>)[sort.key];

    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const compare = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;

  return [...rows].sort((left, right) => {
    const leftValue = valueOf(left);
    const rightValue = valueOf(right);

    if (leftValue !== rightValue) {
      if (leftValue === null) {
        return 1;
      }

      if (rightValue === null) {
        return -1;
      }

      return (leftValue - rightValue) * factor;
    }

    return compare(left.name, right.name) || compare(left.id, right.id);
  });
}

// Fake API that orders the full population and only then paginates,
// mirroring the reporting service contract.
function reportResponse(
  url: URL,
  key: "campaigns" | "adSets" | "ads",
  population: Array<Values & { id: string; name: string }>,
  steps: readonly (typeof trackedSteps)[number][],
) {
  const sort = url.searchParams.get("sort");
  const dir = url.searchParams.get("dir");
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("pageSize") ?? "10");
  const ordered = sort
    ? sortReportRows(population, {
        key: sort,
        direction: dir === "asc" ? "asc" : "desc",
      })
    : population;
  const offset = (page - 1) * pageSize;
  const rows = ordered
    .slice(offset, offset + pageSize)
    .map((row) => ({ ...row, funnelSteps: metrics(row, steps).funnelSteps }));

  return {
    workspaceId: "workspace_1",
    rangeLabel: "06/07/2026 a 12/07/2026",
    since: "2026-07-06",
    until: "2026-07-12",
    [key]: rows,
    totals: metrics(sumValues(population), steps),
    pagination: {
      page,
      pageSize,
      totalItems: population.length,
      totalPages: Math.ceil(population.length / pageSize),
    },
  };
}

function mockReportsApi(options: ApiOptions = {}) {
  const steps = options.steps ?? trackedSteps;

  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input), "http://api.test");

    if (url.pathname.endsWith("/workspaces/current")) {
      return json(workspace);
    }

    if (url.pathname.endsWith("/integrations/meta/assets")) {
      return json({ reportingAccounts: [], lastSyncedAt: null });
    }

    if (options.failing && url.pathname.includes("/reports/")) {
      return json({ message: "boom" }, 500);
    }

    if (url.pathname.endsWith("/reports/adsets")) {
      return json(reportResponse(url, "adSets", adSetPopulation, steps));
    }

    if (url.pathname.endsWith("/reports/ads")) {
      return json(reportResponse(url, "ads", adPopulation, steps));
    }

    if (url.pathname.endsWith("/reports/campaigns")) {
      return json(
        reportResponse(
          url,
          "campaigns",
          options.population?.campaigns ?? campaignPopulation,
          steps,
        ),
      );
    }

    return json({ message: "not found" }, 404);
  });
}

async function renderReports(
  searchParams: Record<string, string> = {},
  options: ApiOptions = {},
) {
  const fetchMock = mockReportsApi(options);
  const element = await ReportsPage({
    searchParams: Promise.resolve(searchParams),
  });
  const view = render(createElement("div", null, element));
  const apiUrls = fetchMock.mock.calls.map(
    ([input]) => new URL(String(input), "http://api.test"),
  );

  return { ...view, apiUrls };
}

function reportCalls(apiUrls: URL[], endpoint: string) {
  return apiUrls.filter((url) => url.pathname.endsWith(`/reports/${endpoint}`));
}

function insightsRegion() {
  return screen.getByRole("region", { name: /^Insights/ });
}

function ranking(name: RegExp) {
  return within(insightsRegion()).getByRole("region", { name });
}

function rankedNames(region: HTMLElement) {
  return within(region)
    .queryAllByRole("listitem")
    .filter((item) => item.hasAttribute("data-insight-rank"))
    .map(
      (item) =>
        item.querySelector(".report-insight-name .presentation-mask-value")
          ?.textContent,
    );
}

function rankedItem(region: HTMLElement, name: string) {
  const item = within(region)
    .getAllByRole("listitem")
    .find(
      (candidate) =>
        candidate.hasAttribute("data-insight-rank") &&
        candidate.querySelector(".report-insight-name .presentation-mask-value")
          ?.textContent === name,
    );

  expect(item, `ranked item ${name}`).toBeTruthy();

  return item as HTMLElement;
}

function hrefOf(element: HTMLElement) {
  return new URL(element.getAttribute("href") ?? "", "http://web.test");
}

describe("report insights helpers", () => {
  it("defaults unknown objectives to real conversations", () => {
    expect(parseReportInsightObjective(undefined)).toBe("real_conversations");
    expect(parseReportInsightObjective("roas")).toBe("real_conversations");
    expect(parseReportInsightObjective("qualified_lead")).toBe(
      "qualified_lead",
    );
    expect(parseReportInsightObjective("purchase")).toBe("purchase");
  });

  it("maps each objective to existing API sort keys: volume desc and cost asc", () => {
    expect(reportInsightSorts("real_conversations")).toEqual({
      volume: { key: "realConversations", direction: "desc" },
      cost: { key: "costPerRealConversationCents", direction: "asc" },
    });
    expect(reportInsightSorts("qualified_lead")).toEqual({
      volume: { key: "qualifiedLead", direction: "desc" },
      cost: { key: "costPerQualifiedLeadCents", direction: "asc" },
    });
    expect(reportInsightSorts("purchase")).toEqual({
      volume: { key: "purchases", direction: "desc" },
      cost: { key: "costPerPurchaseCents", direction: "asc" },
    });
  });

  it("fetches one extra row so a tie at the top boundary is detectable", () => {
    expect(REPORT_INSIGHT_TOP_N).toBe(5);
    expect(REPORT_INSIGHT_FETCH_SIZE).toBe(REPORT_INSIGHT_TOP_N + 1);
    expect(REPORT_INSIGHT_MIN_SAMPLE).toBe(5);
  });

  it("keeps server order, drops zero volume and flags a boundary tie", () => {
    const rows = [
      {
        id: "1",
        name: "Um",
        ...metrics({
          spendCents: 1000,
          realConversations: 9,
          qualifiedLead: 0,
          purchases: 0,
        }),
      },
      {
        id: "2",
        name: "Dois",
        ...metrics({
          spendCents: 1000,
          realConversations: 7,
          qualifiedLead: 0,
          purchases: 0,
        }),
      },
      {
        id: "3",
        name: "Tres",
        ...metrics({
          spendCents: 1000,
          realConversations: 6,
          qualifiedLead: 0,
          purchases: 0,
        }),
      },
      {
        id: "4",
        name: "Quatro",
        ...metrics({
          spendCents: 1000,
          realConversations: 5,
          qualifiedLead: 0,
          purchases: 0,
        }),
      },
      {
        id: "5",
        name: "Cinco",
        ...metrics({
          spendCents: 1000,
          realConversations: 5,
          qualifiedLead: 0,
          purchases: 0,
        }),
      },
      {
        id: "6",
        name: "Seis",
        ...metrics({
          spendCents: 1000,
          realConversations: 5,
          qualifiedLead: 0,
          purchases: 0,
        }),
      },
    ];
    const result = buildReportInsightRanking({
      kind: "volume",
      objective: "real_conversations",
      rows,
      totals: metrics({
        spendCents: 6000,
        realConversations: 37,
        qualifiedLead: 0,
        purchases: 0,
      }),
    });

    expect(result.items.map((item) => item.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(result.items.map((item) => item.position)).toEqual([1, 2, 3, 4, 5]);
    expect(result.items[4].signals.map((signal) => signal.key)).toContain(
      "tie",
    );
    expect(result.items[0].signals.map((signal) => signal.key)).not.toContain(
      "tie",
    );

    const withZero = buildReportInsightRanking({
      kind: "volume",
      objective: "real_conversations",
      rows: [
        rows[0],
        {
          id: "z",
          name: "Zero",
          ...metrics({
            spendCents: 1000,
            realConversations: 0,
            qualifiedLead: 0,
            purchases: 0,
          }),
        },
      ],
      totals: metrics({
        spendCents: 2000,
        realConversations: 9,
        qualifiedLead: 0,
        purchases: 0,
      }),
    });

    expect(withZero.items.map((item) => item.id)).toEqual(["1"]);
    expect(withZero.excludedWithoutResult).toBe(1);
  });

  it("excludes unavailable cost and explains zero spend and low sample", () => {
    const rows = [
      {
        id: "free",
        name: "Sem gasto",
        ...metrics({
          spendCents: 0,
          realConversations: 3,
          qualifiedLead: 0,
          purchases: 0,
        }),
      },
      {
        id: "one",
        name: "Uma conversa",
        ...metrics({
          spendCents: 500,
          realConversations: 1,
          qualifiedLead: 0,
          purchases: 0,
        }),
      },
      {
        id: "big",
        name: "Grande",
        ...metrics({
          spendCents: 60000,
          realConversations: 40,
          qualifiedLead: 0,
          purchases: 0,
        }),
      },
      {
        id: "none",
        name: "Sem conversa",
        ...metrics({
          spendCents: 1000,
          realConversations: 0,
          qualifiedLead: 0,
          purchases: 0,
        }),
      },
    ];
    const result = buildReportInsightRanking({
      kind: "cost",
      objective: "real_conversations",
      rows,
      totals: metrics({
        spendCents: 61500,
        realConversations: 44,
        qualifiedLead: 0,
        purchases: 0,
      }),
    });

    expect(result.items.map((item) => item.id)).toEqual(["free", "one", "big"]);
    expect(result.items[0].costCents).toBe(0);
    expect(result.items[0].signals.map((signal) => signal.key)).toEqual(
      expect.arrayContaining(["no_spend", "low_sample"]),
    );
    expect(result.items[1].signals.map((signal) => signal.key)).toContain(
      "low_sample",
    );
    // Low-sample items never get a comparative cost signal.
    expect(result.items[1].signals.map((signal) => signal.key)).not.toContain(
      "cost_vs_filter",
    );
    expect(result.items[2].signals.map((signal) => signal.key)).toEqual(
      expect.arrayContaining(["volume_share"]),
    );
    expect(result.excludedWithoutResult).toBe(1);
  });

  it("states cost against the full-filter average with an explicit threshold", () => {
    const result = buildReportInsightRanking({
      kind: "cost",
      objective: "purchase",
      rows: [
        {
          id: "cheap",
          name: "Barata",
          ...metrics({
            spendCents: 5000,
            realConversations: 0,
            qualifiedLead: 0,
            purchases: 10,
          }),
        },
        {
          id: "near",
          name: "Media",
          ...metrics({
            spendCents: 10500,
            realConversations: 0,
            qualifiedLead: 0,
            purchases: 10,
          }),
        },
        {
          id: "pricey",
          name: "Cara",
          ...metrics({
            spendCents: 20000,
            realConversations: 0,
            qualifiedLead: 0,
            purchases: 10,
          }),
        },
      ],
      totals: metrics({
        spendCents: 30000,
        realConversations: 0,
        qualifiedLead: 0,
        purchases: 30,
      }),
    });
    const [cheap, near, pricey] = result.items;
    const costSignal = (item: (typeof result.items)[number]) =>
      item.signals.find((signal) => signal.key === "cost_vs_filter");

    expect(costSignal(cheap)?.label).toBe(
      "Custo 50% abaixo da media do filtro",
    );
    expect(costSignal(cheap)?.basis).toMatch(/R\$\s?10,00/);
    expect(costSignal(cheap)?.basis).toMatch(/20%/);
    expect(costSignal(near)).toBeUndefined();
    expect(costSignal(pricey)?.label).toBe(
      "Custo 100% acima da media do filtro",
    );
  });
});

describe("reports insights tab", () => {
  it("keeps the table as default and offers an Insights tab that preserves query state", async () => {
    const { apiUrls } = await renderReports({
      since: "2026-07-06",
      until: "2026-07-12",
      businessId: "bm_1",
      nameContains: "Camp",
      sort: "qualifiedLead",
      dir: "desc",
      view: "adsets",
    });
    const modeNav = screen.getByRole("navigation", {
      name: "Modo do relatorio",
    });
    const tableTab = within(modeNav).getByRole("link", { name: "Tabela" });
    const insightsTab = within(modeNav).getByRole("link", { name: "Insights" });
    const insightsUrl = hrefOf(insightsTab);

    expect(tableTab.getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("region", { name: /^Insights/ })).toBeNull();
    expect(insightsUrl.searchParams.get("mode")).toBe("insights");
    expect(insightsUrl.searchParams.get("view")).toBe("adsets");
    expect(insightsUrl.searchParams.get("since")).toBe("2026-07-06");
    expect(insightsUrl.searchParams.get("businessId")).toBe("bm_1");
    expect(insightsUrl.searchParams.get("nameContains")).toBe("Camp");
    expect(insightsUrl.searchParams.get("sort")).toBe("qualifiedLead");
    // Table mode keeps a single unsorted-or-user-sorted page request.
    expect(reportCalls(apiUrls, "adsets")).toHaveLength(1);
    expect(reportCalls(apiUrls, "adsets")[0].searchParams.get("pageSize")).toBe(
      "10",
    );
  });

  it("ranks campaigns from server ordering, surfacing a row outside the table's first page", async () => {
    const { apiUrls } = await renderReports({
      mode: "insights",
      since: "2026-07-06",
      until: "2026-07-12",
    });
    const calls = reportCalls(apiUrls, "campaigns");
    const volumeCall = calls.find(
      (url) => url.searchParams.get("sort") === "realConversations",
    );
    const costCall = calls.find(
      (url) => url.searchParams.get("sort") === "costPerRealConversationCents",
    );

    // Only the two ordered requests; no unsorted table page is loaded.
    expect(calls).toHaveLength(2);
    expect(volumeCall?.searchParams.get("dir")).toBe("desc");
    expect(volumeCall?.searchParams.get("page")).toBe("1");
    expect(volumeCall?.searchParams.get("pageSize")).toBe("6");
    expect(costCall?.searchParams.get("dir")).toBe("asc");
    expect(costCall?.searchParams.get("page")).toBe("1");
    expect(costCall?.searchParams.get("pageSize")).toBe("6");
    expect(
      campaignPopulation.slice(0, 10).map((row) => row.name),
    ).not.toContain("Campanha Z");

    const volume = ranking(/Maior volume/);

    expect(rankedNames(volume)).toEqual([
      "Campanha Z",
      "Campanha A",
      "Campanha B",
      "Campanha C",
      "Campanha D",
    ]);
    expect(
      within(volume).getByText(/Posicao 1 de 11 campanhas no filtro/),
    ).toBeTruthy();
    expect(
      within(insightsRegion()).getByText(/antes da paginacao/),
    ).toBeTruthy();
  });

  it("keeps zero-spend and one-conversion items explicit in the cost ranking", async () => {
    await renderReports({ mode: "insights" });

    const cost = ranking(/Menor custo/);
    const names = rankedNames(cost);

    expect(names.slice(0, 2)).toEqual(["Campanha G", "Campanha F"]);
    // Zero volume has no computable cost and stays out of the cost ranking.
    expect(names).not.toContain("Campanha E");
    // The API does not report how many rows lack a result, so the note stays
    // generic instead of inventing a count.
    expect(
      within(cost).getByText(
        /Campanhas sem Conversas reais iniciadas nao tem custo calculavel e ficam fora deste ranking/,
      ),
    ).toBeTruthy();

    const free = rankedItem(cost, "Campanha G");
    const single = rankedItem(cost, "Campanha F");

    expect(within(free).getByText("Sem investimento registrado")).toBeTruthy();
    expect(
      within(free).getByText(/custo zero nao indica eficiencia/),
    ).toBeTruthy();
    expect(within(single).getByText("Amostra insuficiente")).toBeTruthy();
    expect(
      within(single).getByText(
        /1 Conversas reais iniciadas no periodo, abaixo do minimo de 5/,
      ),
    ).toBeTruthy();
    expect(insightsRegion().textContent).not.toMatch(
      /melhor|vencedor|campe[aã]/i,
    );
  });

  it.each([
    [
      "qualified_lead",
      "qualifiedLead",
      "costPerQualifiedLeadCents",
      "Oportunidades",
    ],
    ["purchase", "purchases", "costPerPurchaseCents", "Vendas"],
  ])(
    "requests %s rankings with the matching API keys",
    async (objective, volumeKey, costKey, label) => {
      const { apiUrls } = await renderReports({ mode: "insights", objective });
      const sorts = reportCalls(apiUrls, "campaigns").map((url) => [
        url.searchParams.get("sort"),
        url.searchParams.get("dir"),
      ]);

      expect(sorts).toEqual(
        expect.arrayContaining([
          [volumeKey, "desc"],
          [costKey, "asc"],
        ]),
      );

      const objectiveNav = screen.getByRole("navigation", {
        name: "Objetivo do insight",
      });

      expect(
        within(objectiveNav)
          .getByRole("link", { name: label })
          .getAttribute("aria-current"),
      ).toBe("page");
      expect(rankedNames(ranking(/Maior volume/))[0]).toBe("Campanha Z");
    },
  );

  it("ranks ad sets and ads with the same contract and shows ad previews with fallback", async () => {
    const adSets = await renderReports({ mode: "insights", view: "adsets" });

    expect(reportCalls(adSets.apiUrls, "adsets")).toHaveLength(2);
    expect(rankedNames(ranking(/Maior volume/))).toEqual([
      "Publico 2",
      "Publico 1",
    ]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Insights por conjunto",
    );
    cleanup();
    vi.restoreAllMocks();

    const ads = await renderReports({ mode: "insights", view: "ads" });
    const volume = ranking(/Maior volume/);

    expect(reportCalls(ads.apiUrls, "ads")).toHaveLength(2);
    expect(rankedNames(volume)).toEqual(["Criativo 2", "Criativo 1"]);
    expect(
      within(rankedItem(volume, "Criativo 2")).getByRole("button", {
        name: "Ampliar criativo do anuncio Criativo 2",
      }),
    ).toBeTruthy();
    expect(
      within(rankedItem(volume, "Criativo 1")).getByRole("img", {
        name: "Miniatura indisponivel",
      }),
    ).toBeTruthy();
  });

  it("forwards every report filter to both ranking requests", async () => {
    const { apiUrls } = await renderReports({
      mode: "insights",
      view: "ads",
      since: "2026-07-06",
      until: "2026-07-12",
      businessId: "bm_1",
      adAccountId: "act_1",
      campaignId: "cmp_a",
      adSetId: "adset_2",
      nameScope: "ad",
      nameContains: "Criativo",
      status: "active",
      delivery: "had_delivery",
      selectedIds: "ad_1,ad_2",
      whatsappClassification: "all",
      page: "4",
      pageSize: "50",
    });

    for (const call of reportCalls(apiUrls, "ads")) {
      expect(call.searchParams.get("since")).toBe("2026-07-06");
      expect(call.searchParams.get("until")).toBe("2026-07-12");
      expect(call.searchParams.get("businessId")).toBe("bm_1");
      expect(call.searchParams.get("adAccountId")).toBe("act_1");
      expect(call.searchParams.get("campaignId")).toBe("cmp_a");
      expect(call.searchParams.get("adSetId")).toBe("adset_2");
      expect(call.searchParams.get("nameScope")).toBe("ad");
      expect(call.searchParams.get("nameContains")).toBe("Criativo");
      expect(call.searchParams.get("status")).toBe("active");
      expect(call.searchParams.get("delivery")).toBe("had_delivery");
      expect(call.searchParams.get("selectedIds")).toBe("ad_1,ad_2");
      expect(call.searchParams.get("whatsappClassification")).toBe("all");
      // Rankings always read the head of the ordered population.
      expect(call.searchParams.get("page")).toBe("1");
      expect(call.searchParams.get("pageSize")).toBe("6");
    }
  });

  it("keeps insights mode and objective across level tabs, filters and the period form", async () => {
    const { container } = await renderReports({
      mode: "insights",
      objective: "purchase",
      view: "campaigns",
      nameContains: "Camp",
    });
    const levelNav = screen.getByRole("navigation", {
      name: "Nivel do relatorio",
    });
    const adsTab = hrefOf(
      within(levelNav).getByRole("link", { name: "Anuncios" }),
    );

    expect(adsTab.searchParams.get("mode")).toBe("insights");
    expect(adsTab.searchParams.get("objective")).toBe("purchase");
    expect(adsTab.searchParams.get("nameContains")).toBe("Camp");

    const getForms = Array.from(container.querySelectorAll("form")).filter(
      (form) => form.getAttribute("action") === "/reports",
    );

    // Period form and Meta filters form.
    expect(getForms).toHaveLength(2);

    for (const form of getForms) {
      const data = new FormData(form);

      expect(data.getAll("mode")).toEqual(["insights"]);
      expect(data.getAll("objective")).toEqual(["purchase"]);
    }

    const tableLink = within(insightsRegion()).getAllByRole("link", {
      name: /Ver ranking completo na tabela/,
    })[0];
    const tableUrl = hrefOf(tableLink);

    expect(tableUrl.searchParams.get("mode")).toBeNull();
    expect(tableUrl.searchParams.get("sort")).toBe("purchases");
    expect(tableUrl.searchParams.get("dir")).toBe("desc");
    expect(tableUrl.searchParams.get("page")).toBe("1");
    expect(tableUrl.searchParams.get("nameContains")).toBe("Camp");
  });

  it("shows an untracked objective as unavailable, never as zero", async () => {
    await renderReports(
      { mode: "insights", objective: "qualified_lead" },
      { steps: trackedSteps.filter(([key]) => key === "real_conversations") },
    );

    const region = insightsRegion();

    expect(
      within(region).getByText(/ainda nao e rastreado neste filtro/),
    ).toBeTruthy();
    expect(within(region).getByText(/nao equivale a zero/)).toBeTruthy();
    expect(
      within(region).queryByRole("region", { name: /Maior volume/ }),
    ).toBeNull();
  });

  it("keeps a real zero total and an unavailable cost distinct", async () => {
    const zeroPopulation = [
      campaign("cmp_x", "Campanha X", {
        spendCents: 10000,
        realConversations: 0,
        qualifiedLead: 0,
        purchases: 0,
      }),
      campaign("cmp_y", "Campanha Y", {
        spendCents: 5000,
        realConversations: 0,
        qualifiedLead: 0,
        purchases: 0,
      }),
    ];

    await renderReports(
      { mode: "insights" },
      { population: { campaigns: zeroPopulation } },
    );

    const summary = within(insightsRegion()).getByRole("group", {
      name: "Total do filtro",
    });

    expect(within(summary).getByText("0")).toBeTruthy();
    expect(within(summary).getByText("Custo indisponivel")).toBeTruthy();
    expect(
      within(ranking(/Maior volume/)).getByText(
        /Nenhuma campanha registrou Conversas reais iniciadas/,
      ),
    ).toBeTruthy();
    expect(
      within(ranking(/Menor custo/)).getByText("Sem custo calculavel"),
    ).toBeTruthy();
  });

  it("shows an empty state when the filter has no items", async () => {
    await renderReports(
      { mode: "insights" },
      { population: { campaigns: [] } },
    );

    expect(
      within(insightsRegion()).getByText("Nenhuma campanha no filtro atual"),
    ).toBeTruthy();
  });

  it("shows an error state instead of zeros when the API fails", async () => {
    await renderReports({ mode: "insights" }, { failing: true });

    const region = insightsRegion();

    expect(
      within(region).getAllByText("Nao foi possivel carregar o ranking").length,
    ).toBeGreaterThan(0);
    expect(
      within(region).getAllByText(/Nenhum valor foi presumido como zero/)
        .length,
    ).toBeGreaterThan(0);
    expect(
      within(region).queryByRole("group", { name: "Total do filtro" }),
    ).toBeNull();
  });

  it("explains the heuristic and offers no automatic actions", async () => {
    await renderReports({ mode: "insights" });

    const region = insightsRegion();

    expect(
      within(region).getByText(/Nenhuma acao e executada automaticamente/),
    ).toBeTruthy();
    expect(
      within(region).getByText(/menos de 5 resultados no periodo/),
    ).toBeTruthy();
    expect(
      within(region).queryByRole("button", {
        name: /Pausar|Ativar|Incluir|Excluir/,
      }),
    ).toBeNull();
  });
});
