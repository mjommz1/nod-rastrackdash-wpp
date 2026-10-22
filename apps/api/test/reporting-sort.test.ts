import "reflect-metadata";
import { BadRequestException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.service";
import { DiagnosticsService } from "../src/diagnostics/diagnostics.service";
import { MetaInitialSyncPeriodService } from "../src/reporting/meta-initial-sync-period";
import { MetaReportSyncQueueService } from "../src/reporting/meta-report-sync-queue.service";
import { MetaReportingService } from "../src/reporting/meta-reporting.service";
import { ReportingMetricsEngine } from "../src/reporting/reporting-metrics.engine";
import { ReportingController } from "../src/reporting/reporting.controller";
import { WorkspacesService } from "../src/workspaces/workspaces.service";

type Row = Record<string, unknown>;

type EntitySpec = {
  n: number;
  name?: string;
  workspaceId?: string;
  adAccountId?: string;
  status?: string;
  spendCents: number;
  real?: number;
  qualified?: number;
  purchases?: number;
};

type PrismaCall = { model: string; args: unknown };

const WORKSPACE = "ws-1";
const OTHER_WORKSPACE = "ws-2";
const WHATSAPP = "auto_whatsapp";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ids(n: number) {
  return {
    campaignId: `c-${pad(n)}`,
    adSetId: `s-${pad(n)}`,
    adId: `a-${pad(n)}`,
  };
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareValues(value: unknown, bound: unknown): number {
  if (value === null || value === undefined) {
    return Number.NaN;
  }

  if (value instanceof Date && bound instanceof Date) {
    return value.getTime() - bound.getTime();
  }

  return compareCodeUnits(String(value), String(bound));
}

function matchesWhere(row: Row, where: unknown): boolean {
  if (!where) {
    return true;
  }

  for (const [key, condition] of Object.entries(where as Row)) {
    if (key === "OR") {
      if (!(condition as unknown[]).some((item) => matchesWhere(row, item))) {
        return false;
      }
      continue;
    }

    const value = row[key];

    if (
      condition !== null &&
      typeof condition === "object" &&
      !(condition instanceof Date)
    ) {
      const operators = condition as {
        in?: unknown[];
        not?: unknown;
        gt?: unknown;
        gte?: unknown;
        lte?: unknown;
      };

      if ("in" in operators && !operators.in?.includes(value)) {
        return false;
      }

      if ("not" in operators && value === operators.not) {
        return false;
      }

      if (
        ("gt" in operators && !(compareValues(value, operators.gt) > 0)) ||
        ("gte" in operators && !(compareValues(value, operators.gte) >= 0)) ||
        ("lte" in operators && !(compareValues(value, operators.lte) <= 0))
      ) {
        return false;
      }

      continue;
    }

    if (value !== condition) {
      return false;
    }
  }

  return true;
}

function buildFixture(specs: EntitySpec[]) {
  const campaigns: Row[] = [];
  const adSets: Row[] = [];
  const ads: Row[] = [];
  const events: Row[] = [];
  const leads: Row[] = [];
  let sequence = 0;

  for (const spec of specs) {
    const workspaceId = spec.workspaceId ?? WORKSPACE;
    const adAccountId = spec.adAccountId ?? "act-1";
    const businessId = workspaceId === WORKSPACE ? "biz-1" : "biz-9";
    const { campaignId, adSetId, adId } = ids(spec.n);
    const prefix = workspaceId === WORKSPACE ? "" : "w2-";
    const common = {
      workspaceId,
      businessId,
      adAccountId,
      status: spec.status ?? "ACTIVE",
      effectiveStatus: spec.status ?? "ACTIVE",
      whatsappClassification: WHATSAPP,
      spendCents: spec.spendCents,
      metaConversationsStarted: 0,
      dailyBudgetCents: null,
      lifetimeBudgetCents: null,
    };
    const name = spec.name ?? pad(spec.n);

    campaigns.push({
      ...common,
      campaignId: `${prefix}${campaignId}`,
      name: `Campanha ${name}`,
    });
    adSets.push({
      ...common,
      campaignId: `${prefix}${campaignId}`,
      adSetId: `${prefix}${adSetId}`,
      name: `Conjunto ${name}`,
    });
    ads.push({
      ...common,
      campaignId: `${prefix}${campaignId}`,
      adSetId: `${prefix}${adSetId}`,
      adId: `${prefix}${adId}`,
      name: `Anuncio ${name}`,
      thumbnailUrl: null,
      previewUrl: null,
    });

    const attribution = {
      workspaceId,
      campaignId: `${prefix}${campaignId}`,
      adSetId: `${prefix}${adSetId}`,
      adId: `${prefix}${adId}`,
    };

    for (let index = 0; index < (spec.real ?? 0); index += 1) {
      sequence += 1;
      leads.push({
        ...attribution,
        id: `lead-${sequence}`,
        phoneHash: `phone-${sequence}`,
        ctwaClid: `ctwa-${sequence}`,
        firstMessageAt: new Date("2026-09-01T12:00:00.000Z"),
        createdAt: new Date("2026-09-01T12:00:00.000Z"),
      });
    }

    const pushEvent = (eventName: string, count: number) => {
      for (let index = 0; index < count; index += 1) {
        sequence += 1;
        events.push({
          ...attribution,
          id: `event-${sequence}`,
          phoneHash: `buyer-${sequence}`,
          customerIdentityKey: null,
          businessSource: null,
          ctwaClid: null,
          eventName,
          eventOccurredAt: new Date("2026-09-02T12:00:00.000Z"),
          status: "sent",
          valueCents: 10_000,
          valueSource: "actual",
          currency: "BRL",
          purchaseKind: null,
        });
      }
    };

    pushEvent("QualifiedLead", spec.qualified ?? 0);
    pushEvent("Purchase", spec.purchases ?? 0);
  }

  return { campaigns, adSets, ads, events, leads };
}

function createService(specs: EntitySpec[], extra?: { events?: Row[] }) {
  const fixture = buildFixture(specs);
  const tables: Record<string, Row[]> = {
    metaReportingAccount: [
      {
        workspaceId: WORKSPACE,
        businessId: "biz-1",
        adAccountId: "act-1",
        active: true,
      },
      {
        workspaceId: WORKSPACE,
        businessId: "biz-1",
        adAccountId: "act-2",
        active: true,
      },
      {
        workspaceId: OTHER_WORKSPACE,
        businessId: "biz-9",
        adAccountId: "act-9",
        active: true,
      },
    ],
    metaCampaign: fixture.campaigns,
    metaAdSet: fixture.adSets,
    metaAd: fixture.ads,
    conversionEventLog: [...fixture.events, ...(extra?.events ?? [])],
    lead: fixture.leads,
    // No daily snapshots: rows fall back to the entity snapshot spend.
    metaCampaignDailyInsight: [],
    metaAdSetDailyInsight: [],
    metaAdDailyInsight: [],
  };
  const calls: PrismaCall[] = [];
  const prisma = new Proxy(
    {},
    {
      get(_target, model: string) {
        if (!(model in tables)) {
          throw new Error(`Unexpected prisma model access: ${model}`);
        }

        return {
          findMany: async (args: { where?: unknown; orderBy?: unknown }) => {
            calls.push({ model, args: structuredClone(args) });
            const rows = tables[model].filter((row) =>
              matchesWhere(row, args?.where),
            );
            const orderBy = args?.orderBy as { name?: string } | undefined;

            if (orderBy?.name === "asc") {
              rows.sort((a, b) =>
                compareCodeUnits(String(a.name), String(b.name)),
              );
            }

            return rows.map((row) => ({ ...row }));
          },
        };
      },
    },
  );
  const metaAccesses: string[] = [];
  const recordingStub = (label: string) =>
    new Proxy(
      {},
      {
        get(_target, property) {
          metaAccesses.push(`${label}.${String(property)}`);
          return undefined;
        },
      },
    );
  const metricsEngine = new ReportingMetricsEngine();
  const calculate = vi.spyOn(metricsEngine, "calculate");
  const service = new MetaReportingService(
    prisma as never,
    recordingStub("encryption") as never,
    recordingStub("metaAdapter") as never,
    recordingStub("adDestinationRouting") as never,
    recordingStub("whatsappClassifier") as never,
    metricsEngine,
    { getConfiguration: async () => ({ stages: [] }) } as never,
  );

  return { service, calls, metaAccesses, calculate };
}

const baseInput = { workspaceId: WORKSPACE, rangeLabel: "Teste" };

// 25 entities, page size 10. Name order puts 01..10 on page 1, 11..20 on
// page 2 and 21..25 on page 3. Highest purchases (23) and highest qualified
// leads (17) live outside the old first page.
const pagedSpecs: EntitySpec[] = Array.from({ length: 25 }, (_, index) => {
  const n = index + 1;
  return {
    n,
    spendCents: 10_000 + n * 100,
    real: n % 4,
    qualified: n === 17 ? 9 : n % 3,
    purchases: n === 23 ? 7 : n === 4 ? 0 : n % 2,
  };
});

const tenantNoise: EntitySpec = {
  n: 99,
  workspaceId: OTHER_WORKSPACE,
  adAccountId: "act-9",
  name: "00 intrusa",
  spendCents: 1,
  real: 50,
  qualified: 50,
  purchases: 50,
};

type Level = {
  label: string;
  rowsKey: "campaigns" | "adSets" | "ads";
  idPrefix: string;
  load: (
    service: MetaReportingService,
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

const levels: Level[] = [
  {
    label: "campaigns",
    rowsKey: "campaigns",
    idPrefix: "c",
    load: (service, input) =>
      service.getCampaignReportOverview(input as never) as never,
  },
  {
    label: "adsets",
    rowsKey: "adSets",
    idPrefix: "s",
    load: (service, input) =>
      service.getAdSetReportOverview(input as never) as never,
  },
  {
    label: "ads",
    rowsKey: "ads",
    idPrefix: "a",
    load: (service, input) =>
      service.getAdReportOverview(input as never) as never,
  },
];

type ReportRow = {
  id: string;
  name: string;
  realConversations: number;
  qualifiedLead: number;
  purchases: number;
  costPerRealConversationCents: number | null;
  costPerQualifiedLeadCents: number | null;
  costPerPurchaseCents: number | null;
};

function rowsOf(report: Record<string, unknown>, level: Level): ReportRow[] {
  return report[level.rowsKey] as ReportRow[];
}

describe.each(levels)(
  "MetaReportingService sort before pagination ($label)",
  (level) => {
    const entityId = (n: number) => `${level.idPrefix}-${pad(n)}`;

    it("keeps the unsorted name-ascending page when no sort is requested", async () => {
      const { service } = createService([...pagedSpecs, tenantNoise]);

      const report = await level.load(service, {
        ...baseInput,
        page: 1,
        pageSize: 10,
      });

      expect(rowsOf(report, level).map((row) => row.id)).toEqual(
        Array.from({ length: 10 }, (_, index) => entityId(index + 1)),
      );
      expect(report.pagination).toEqual({
        page: 1,
        pageSize: 10,
        totalItems: 25,
        totalPages: 3,
      });
    });

    it("puts the highest purchases first even when it lived on page 3", async () => {
      const { service } = createService([...pagedSpecs, tenantNoise]);

      const report = await level.load(service, {
        ...baseInput,
        page: 1,
        pageSize: 10,
        sort: { key: "purchases", direction: "desc" },
      });
      const rows = rowsOf(report, level);

      expect(rows[0]).toMatchObject({ id: entityId(23), purchases: 7 });
      expect(rows.map((row) => row.purchases)).toEqual([
        7, 1, 1, 1, 1, 1, 1, 1, 1, 1,
      ]);
      // ties on purchases resolve by name ascending
      expect(rows.slice(1).map((row) => row.id)).toEqual(
        [1, 3, 5, 7, 9, 11, 13, 15, 17].map(entityId),
      );
      expect(report.pagination).toEqual({
        page: 1,
        pageSize: 10,
        totalItems: 25,
        totalPages: 3,
      });
    });

    it("puts the highest qualified leads first and continues across pages", async () => {
      const { service } = createService([...pagedSpecs, tenantNoise]);
      const pages = await Promise.all(
        [1, 2, 3].map((page) =>
          level.load(service, {
            ...baseInput,
            page,
            pageSize: 10,
            sort: { key: "qualifiedLead", direction: "desc" },
          }),
        ),
      );
      const all = pages.flatMap((page) => rowsOf(page, level));

      expect(all[0]).toMatchObject({ id: entityId(17), qualifiedLead: 9 });
      expect(all).toHaveLength(25);
      expect(new Set(all.map((row) => row.id)).size).toBe(25);
      expect(all.map((row) => row.qualifiedLead)).toEqual(
        [...all.map((row) => row.qualifiedLead)].sort((a, b) => b - a),
      );
    });

    it("sorts ascending with zero counts first and stable name ties", async () => {
      const { service } = createService([...pagedSpecs, tenantNoise]);

      const report = await level.load(service, {
        ...baseInput,
        page: 1,
        pageSize: 5,
        sort: { key: "realConversations", direction: "asc" },
      });

      expect(rowsOf(report, level).map((row) => row.id)).toEqual(
        [4, 8, 12, 16, 20].map(entityId),
      );
      expect(
        rowsOf(report, level).every((row) => row.realConversations === 0),
      ).toBe(true);
    });

    it("orders costs with zero valid and unavailable values last in both directions", async () => {
      const specs: EntitySpec[] = [
        { n: 1, spendCents: 9_000, purchases: 3 }, // CPA 3000
        { n: 2, spendCents: 5_000, purchases: 0 }, // CPA null
        { n: 3, spendCents: 0, purchases: 2 }, // CPA 0
        { n: 4, spendCents: 8_000, purchases: 1 }, // CPA 8000
        { n: 5, spendCents: 1_000, purchases: 0 }, // CPA null
        { n: 6, spendCents: 6_000, purchases: 2 }, // CPA 3000 (tie with 1)
      ];
      const { service } = createService(specs);

      const asc = await level.load(service, {
        ...baseInput,
        sort: { key: "costPerPurchaseCents", direction: "asc" },
      });
      const desc = await level.load(service, {
        ...baseInput,
        sort: { key: "costPerPurchaseCents", direction: "desc" },
      });

      expect(
        rowsOf(asc, level).map((row) => [row.id, row.costPerPurchaseCents]),
      ).toEqual([
        [entityId(3), 0],
        [entityId(1), 3000],
        [entityId(6), 3000],
        [entityId(4), 8000],
        [entityId(2), null],
        [entityId(5), null],
      ]);
      expect(
        rowsOf(desc, level).map((row) => [row.id, row.costPerPurchaseCents]),
      ).toEqual([
        [entityId(4), 8000],
        [entityId(1), 3000],
        [entityId(6), 3000],
        [entityId(3), 0],
        [entityId(2), null],
        [entityId(5), null],
      ]);
    });

    it("sorts CPL and CPQL from the canonical row metrics", async () => {
      const specs: EntitySpec[] = [
        { n: 1, spendCents: 9_000, real: 3, qualified: 1 }, // CPL 3000 CPQL 9000
        { n: 2, spendCents: 4_000, real: 4, qualified: 0 }, // CPL 1000 CPQL null
        { n: 3, spendCents: 6_000, real: 0, qualified: 3 }, // CPL null CPQL 2000
      ];
      const { service } = createService(specs);

      const cpl = await level.load(service, {
        ...baseInput,
        sort: { key: "costPerRealConversationCents", direction: "asc" },
      });
      const cpql = await level.load(service, {
        ...baseInput,
        sort: { key: "costPerQualifiedLeadCents", direction: "desc" },
      });

      expect(
        rowsOf(cpl, level).map((row) => [
          row.id,
          row.costPerRealConversationCents,
        ]),
      ).toEqual([
        [entityId(2), 1000],
        [entityId(1), 3000],
        [entityId(3), null],
      ]);
      expect(
        rowsOf(cpql, level).map((row) => [
          row.id,
          row.costPerQualifiedLeadCents,
        ]),
      ).toEqual([
        [entityId(1), 9000],
        [entityId(3), 2000],
        [entityId(2), null],
      ]);
    });

    it("returns every filtered row sorted when pagination is not requested", async () => {
      const { service } = createService([...pagedSpecs, tenantNoise]);

      const report = await level.load(service, {
        ...baseInput,
        sort: { key: "purchases", direction: "desc" },
      });

      expect(rowsOf(report, level)).toHaveLength(25);
      expect(rowsOf(report, level)[0].id).toBe(entityId(23));
      expect(report.pagination).toBeUndefined();
    });

    it("keeps totals, pagination and queries identical to the unsorted request", async () => {
      const unsorted = createService([...pagedSpecs, tenantNoise]);
      const sorted = createService([...pagedSpecs, tenantNoise]);

      const unsortedReport = await level.load(unsorted.service, {
        ...baseInput,
        page: 2,
        pageSize: 10,
      });
      const sortedReport = await level.load(sorted.service, {
        ...baseInput,
        page: 2,
        pageSize: 10,
        sort: { key: "purchases", direction: "desc" },
      });

      expect(sortedReport.totals).toEqual(unsortedReport.totals);
      expect(sortedReport.pagination).toEqual(unsortedReport.pagination);
      expect(sorted.calls).toEqual(unsorted.calls);
      expect(sorted.metaAccesses).toEqual([]);
      expect(unsorted.metaAccesses).toEqual([]);
    });

    it("never mixes another workspace's entities or events into the sorted result", async () => {
      const crossTenantEvents = Array.from({ length: 40 }, (_, index) => ({
        ...ids(1),
        workspaceId: OTHER_WORKSPACE,
        id: `foreign-${index}`,
        phoneHash: `foreign-${index}`,
        customerIdentityKey: null,
        businessSource: null,
        ctwaClid: null,
        eventName: "Purchase",
        eventOccurredAt: new Date("2026-09-02T12:00:00.000Z"),
        status: "sent",
        valueCents: 1,
        valueSource: "actual",
        currency: "BRL",
        purchaseKind: null,
      }));
      const { service } = createService([...pagedSpecs, tenantNoise], {
        events: crossTenantEvents,
      });

      const report = await level.load(service, {
        ...baseInput,
        sort: { key: "purchases", direction: "desc" },
      });
      const rows = rowsOf(report, level);

      expect(rows.some((row) => row.id.startsWith("w2-"))).toBe(false);
      expect(rows[0]).toMatchObject({ id: entityId(23), purchases: 7 });
      expect(rows.find((row) => row.id === entityId(1))?.purchases).toBe(1);
    });

    it("applies account and status filters before sorting", async () => {
      const specs: EntitySpec[] = [
        { n: 1, spendCents: 100, purchases: 9 },
        { n: 2, spendCents: 100, purchases: 2, adAccountId: "act-2" },
        { n: 3, spendCents: 100, purchases: 5, adAccountId: "act-2" },
        {
          n: 4,
          spendCents: 100,
          purchases: 8,
          adAccountId: "act-2",
          status: "PAUSED",
        },
        { n: 5, spendCents: 100, purchases: 1, adAccountId: "act-2" },
      ];
      const { service } = createService([...specs, tenantNoise]);

      const report = await level.load(service, {
        ...baseInput,
        adAccountId: "act-2",
        status: "active",
        page: 1,
        pageSize: 2,
        sort: { key: "purchases", direction: "desc" },
      });

      expect(rowsOf(report, level).map((row) => row.id)).toEqual(
        [3, 2].map(entityId),
      );
      expect(report.pagination).toMatchObject({ totalItems: 3, totalPages: 2 });
    });

    it("breaks equal values and equal names by entity id", async () => {
      const specs: EntitySpec[] = [
        { n: 7, name: "Igual", spendCents: 100, purchases: 1 },
        { n: 3, name: "Igual", spendCents: 100, purchases: 1 },
        { n: 5, name: "Antes", spendCents: 100, purchases: 1 },
      ];
      const { service } = createService(specs);

      const desc = await level.load(service, {
        ...baseInput,
        sort: { key: "purchases", direction: "desc" },
      });
      const asc = await level.load(service, {
        ...baseInput,
        sort: { key: "purchases", direction: "asc" },
      });
      const expected = [5, 3, 7].map(entityId);

      expect(rowsOf(desc, level).map((row) => row.id)).toEqual(expected);
      expect(rowsOf(asc, level).map((row) => row.id)).toEqual(expected);
    });
  },
);

describe("MetaReportingService sort with a large deterministic fixture", () => {
  const largeSpecs: EntitySpec[] = Array.from({ length: 2_000 }, (_, index) => {
    const n = index + 1;
    return {
      n,
      spendCents: 50_000 + ((n * 7_919) % 10_000),
      real: n % 5,
      qualified: (n * 31) % 7,
      purchases: n === 1_777 ? 40 : (n * 13) % 4,
    };
  });

  it("builds every filtered row once with a constant query count", async () => {
    const unsorted = createService(largeSpecs);
    const sorted = createService(largeSpecs);

    const unsortedReport = await unsorted.service.getAdReportOverview({
      ...baseInput,
      page: 1,
      pageSize: 25,
    });
    const sortedReport = await sorted.service.getAdReportOverview({
      ...baseInput,
      page: 1,
      pageSize: 25,
      sort: { key: "purchases", direction: "desc" },
    } as never);

    expect(sortedReport.ads[0]).toMatchObject({ purchases: 40 });
    expect(sortedReport.ads).toHaveLength(25);
    expect(sortedReport.pagination).toEqual(unsortedReport.pagination);
    expect(sortedReport.totals).toEqual(unsortedReport.totals);
    // Rows for the whole filtered result plus one totals calculation.
    expect(sorted.calculate).toHaveBeenCalledTimes(2_000 + 1);
    // Unsorted fast path: one page of rows plus one totals calculation.
    expect(unsorted.calculate).toHaveBeenCalledTimes(25 + 1);
    expect(sorted.calls).toEqual(unsorted.calls);
    // Two of these resolve the first-contact attribution of the leads
    // (paid LeadSubmitted in scope + the leads' first paid conversations);
    // the count stays constant whatever the number of rows.
    expect(sorted.calls).toHaveLength(8);
  });
});

function controllerWith(service: Record<string, unknown>) {
  return new ReportingController(
    service as never,
    {} as never,
    {} as never,
    {
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
    } as never,
    {
      getCurrentWorkspace: vi.fn().mockReturnValue({
        id: WORKSPACE,
        permissions: { canViewReports: true, canExportReports: true },
      }),
    } as never,
    {} as never,
  );
}

function callEndpoint(
  controller: ReportingController,
  endpoint: "campaigns" | "adsets" | "ads",
  query: { sort?: unknown; dir?: unknown; page?: string; pageSize?: string },
) {
  const args = [
    "refresh-token",
    "2026-09-01",
    "2026-09-07",
    ...Array(11).fill(undefined),
  ];

  if (endpoint === "campaigns") {
    return (controller.getCampaignReports as (...input: unknown[]) => unknown)(
      ...args,
      undefined,
      undefined,
      query.page,
      query.pageSize,
      query.sort,
      query.dir,
    );
  }

  const method =
    endpoint === "adsets"
      ? controller.getAdSetReports
      : controller.getAdReports;

  return (method as (...input: unknown[]) => unknown).call(
    controller,
    ...args,
    query.page,
    query.pageSize,
    query.sort,
    query.dir,
  );
}

const endpoints = [
  { endpoint: "campaigns", method: "getCampaignReportOverview" },
  { endpoint: "adsets", method: "getAdSetReportOverview" },
  { endpoint: "ads", method: "getAdReportOverview" },
] as const;

describe.each(endpoints)(
  "ReportingController sort query ($endpoint)",
  ({ endpoint, method }) => {
    it("forwards an allowlisted sort and direction", async () => {
      const load = vi.fn().mockResolvedValue({});
      const controller = controllerWith({ [method]: load });

      await callEndpoint(controller, endpoint, {
        sort: "qualifiedLead",
        dir: "asc",
        page: "2",
        pageSize: "10",
      });

      expect(load).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WORKSPACE,
          page: 2,
          pageSize: 10,
          sort: { key: "qualifiedLead", direction: "asc" },
        }),
      );
    });

    it("defaults the direction to desc when only sort is given", async () => {
      const load = vi.fn().mockResolvedValue({});
      const controller = controllerWith({ [method]: load });

      await callEndpoint(controller, endpoint, { sort: "purchases" });

      expect(load.mock.calls[0][0].sort).toEqual({
        key: "purchases",
        direction: "desc",
      });
    });

    it("does not add a sort key to the service input without sort", async () => {
      const load = vi.fn().mockResolvedValue({});
      const controller = controllerWith({ [method]: load });

      await callEndpoint(controller, endpoint, { page: "1", pageSize: "10" });

      expect(load.mock.calls[0][0]).not.toHaveProperty("sort");
    });

    it.each([
      ["unknown key", { sort: "bogus" }],
      ["non-allowlisted DTO field", { sort: "spendCents" }],
      ["name is not a metric sort", { sort: "name" }],
      ["prototype key", { sort: "__proto__" }],
      ["wrong case", { sort: "Purchases" }],
      ["padded key", { sort: " purchases" }],
      ["repeated sort", { sort: ["purchases", "qualifiedLead"] }],
      ["object sort", { sort: { key: "purchases" } }],
      ["invalid direction", { sort: "purchases", dir: "up" }],
      ["upper-case direction", { sort: "purchases", dir: "DESC" }],
      ["repeated direction", { sort: "purchases", dir: ["asc", "desc"] }],
      ["direction without sort", { dir: "asc" }],
      ["direction with empty sort", { sort: "", dir: "asc" }],
    ])("rejects %s with 400 before loading", async (_label, query) => {
      const load = vi.fn().mockResolvedValue({});
      const controller = controllerWith({ [method]: load });

      await expect(
        callEndpoint(controller, endpoint, query),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(load).not.toHaveBeenCalled();
    });
  },
);

describe("Reports HTTP sort contract", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const { service } = createService([...pagedSpecs, tenantNoise]);
    const moduleRef = await Test.createTestingModule({
      controllers: [ReportingController],
      providers: [
        { provide: MetaReportingService, useValue: service },
        { provide: MetaReportSyncQueueService, useValue: {} },
        { provide: MetaInitialSyncPeriodService, useValue: {} },
        {
          provide: AuthService,
          useValue: {
            getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
          },
        },
        {
          provide: WorkspacesService,
          useValue: {
            getCurrentWorkspace: vi.fn().mockReturnValue({
              id: WORKSPACE,
              permissions: { canViewReports: true, canExportReports: true },
            }),
          },
        },
        { provide: DiagnosticsService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const auth = { Authorization: "Bearer refresh-token" };
  // Fixture events are dated 2026-09-01/02; the controller would otherwise
  // default to the last seven days relative to the wall clock.
  const period = { since: "2026-09-01", until: "2026-09-07" };
  const periodQuery = "since=2026-09-01&until=2026-09-07";

  it.each([
    ["campaigns", "campaigns", "c"],
    ["adsets", "adSets", "s"],
    ["ads", "ads", "a"],
  ])(
    "GET /reports/%s sorts the whole result before paginating",
    async (path, rowsKey, prefix) => {
      const response = await request(app.getHttpServer())
        .get(`/reports/${path}`)
        .query({
          ...period,
          page: "1",
          pageSize: "10",
          sort: "purchases",
          dir: "desc",
        })
        .set(auth)
        .expect(200);

      expect(response.body[rowsKey][0]).toMatchObject({
        id: `${prefix}-23`,
        purchases: 7,
      });
      expect(response.body.pagination).toEqual({
        page: 1,
        pageSize: 10,
        totalItems: 25,
        totalPages: 3,
      });
    },
  );

  it("GET without sort keeps the name-ascending first page", async () => {
    const response = await request(app.getHttpServer())
      .get("/reports/ads")
      .query({ ...period, page: "1", pageSize: "10" })
      .set(auth)
      .expect(200);

    expect(response.body.ads.map((row: { id: string }) => row.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `a-${pad(index + 1)}`),
    );
  });

  it.each([
    ["campaigns", "sort=bogus"],
    ["adsets", "sort=purchases&dir=sideways"],
    ["ads", "dir=asc"],
    ["ads", "sort=purchases&sort=qualifiedLead"],
    ["campaigns", "sort[key]=purchases"],
    ["adsets", "sort=costPerMetaConversationCents"],
  ])("GET /reports/%s?%s responds 400", async (path, query) => {
    const response = await request(app.getHttpServer())
      .get(`/reports/${path}?${periodQuery}&${query}`)
      .set(auth)
      .expect(400);

    expect(response.body.statusCode).toBe(400);
    expect(response.body.message).toMatch(/ordenacao/i);
  });
});
