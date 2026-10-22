import { describe, expect, it } from "vitest";
import { MetaReportingService } from "../../src/reporting/meta-reporting.service";
import { ReportingMetricsEngine } from "../../src/reporting/reporting-metrics.engine";

// Leads novos x leads que voltaram in the Meta reports (ported from the SaaS
// meta-reporting-service suite, on a small in-memory Prisma).

type Row = Record<string, unknown>;

const WORKSPACE = "workspace_1";

function compare(value: unknown, bound: unknown): number {
  if (value === null || value === undefined) {
    return Number.NaN;
  }

  if (value instanceof Date || bound instanceof Date) {
    return (
      new Date(value as Date).getTime() - new Date(bound as Date).getTime()
    );
  }

  const left = String(value);
  const right = String(bound);

  return left < right ? -1 : left > right ? 1 : 0;
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

    if (key === "AND") {
      if (!(condition as unknown[]).every((item) => matchesWhere(row, item))) {
        return false;
      }
      continue;
    }

    const value = row[key] ?? null;

    if (
      condition !== null &&
      typeof condition === "object" &&
      !(condition instanceof Date)
    ) {
      const ops = condition as Row;

      if ("in" in ops && !(ops.in as unknown[]).includes(value)) return false;
      if ("notIn" in ops && (ops.notIn as unknown[]).includes(value)) {
        return false;
      }
      if ("not" in ops && value === ops.not) return false;
      if ("lt" in ops && !(compare(value, ops.lt) < 0)) return false;
      if ("gt" in ops && !(compare(value, ops.gt) > 0)) return false;
      if ("gte" in ops && !(compare(value, ops.gte) >= 0)) return false;
      if ("lte" in ops && !(compare(value, ops.lte) <= 0)) return false;
      continue;
    }

    if (value !== condition) {
      return false;
    }
  }

  return true;
}

function campaign(campaignId: string, name: string, spendCents: number): Row {
  return {
    workspaceId: WORKSPACE,
    businessId: "business_1",
    adAccountId: "act_123",
    campaignId,
    name,
    status: "ACTIVE",
    effectiveStatus: "ACTIVE",
    whatsappClassification: "manual_include",
    spendCents,
    metaConversationsStarted: 0,
    dailyBudgetCents: null,
    lifetimeBudgetCents: null,
  };
}

function createHarness() {
  const db = {
    campaigns: [campaign("cmp_1", "Campanha WhatsApp", 30_000)],
    leads: [
      {
        id: "lead_1",
        workspaceId: WORKSPACE,
        phoneHash: "phone_a",
        campaignId: "cmp_1",
        adSetId: "adset_1",
        adId: "ad_1",
        ctwaClid: "ctwa_1",
        firstMessageAt: new Date("2026-07-01T12:00:00.000Z"),
        createdAt: new Date("2026-07-01T12:00:00.000Z"),
      },
      {
        id: "lead_2",
        workspaceId: WORKSPACE,
        phoneHash: "phone_b",
        campaignId: "cmp_1",
        adSetId: "adset_1",
        adId: "ad_1",
        ctwaClid: "ctwa_2",
        firstMessageAt: new Date("2026-07-02T12:00:00.000Z"),
        createdAt: new Date("2026-07-02T12:00:00.000Z"),
      },
    ] as Row[],
    conversionLogs: [
      {
        // First conversation of lead_1, recorded without a lead id.
        id: "event_lead_submitted",
        workspaceId: WORKSPACE,
        phoneHash: "phone_a",
        customerIdentityKey: "phone_a",
        businessSource: "paid",
        campaignId: "cmp_1",
        adSetId: "adset_1",
        adId: "ad_1",
        ctwaClid: null,
        eventName: "LeadSubmitted",
        eventOccurredAt: new Date("2026-07-01T12:00:00.000Z"),
        status: "sent",
        valueCents: null,
        valueSource: null,
        currency: null,
        purchaseKind: null,
      },
    ] as Row[],
  };
  const tables = (): Record<string, Row[]> => ({
    metaReportingAccount: [
      {
        workspaceId: WORKSPACE,
        businessId: "business_1",
        adAccountId: "act_123",
        active: true,
      },
    ],
    metaCampaign: db.campaigns,
    metaAdSet: [],
    metaAd: [],
    conversionEventLog: db.conversionLogs,
    lead: db.leads,
    metaCampaignDailyInsight: [],
    metaAdSetDailyInsight: [],
    metaAdDailyInsight: [],
  });
  const prisma = new Proxy(
    {},
    {
      get(_target, model: string) {
        const table = tables()[model];

        if (!table) {
          throw new Error(`Unexpected prisma model access: ${model}`);
        }

        return {
          findMany: async (args: { where?: unknown } = {}) =>
            table
              .filter((row) => matchesWhere(row, args.where))
              .map((row) => ({ ...row })),
        };
      },
    },
  );
  const service = new MetaReportingService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new ReportingMetricsEngine(),
    { getConfiguration: async () => ({ stages: [] }) } as never,
  );

  return { db, service };
}

type Db = ReturnType<typeof createHarness>["db"];

function returningLead(
  db: Db,
  input: { id: string; phoneHash: string; firstMessageAt: Date },
) {
  db.leads.push({
    id: input.id,
    workspaceId: WORKSPACE,
    phoneHash: input.phoneHash,
    // The row now points at the ad of the NEW conversation.
    campaignId: "cmp_1",
    adSetId: "adset_1",
    adId: "ad_1",
    ctwaClid: null,
    firstMessageAt: input.firstMessageAt,
    createdAt: input.firstMessageAt,
  });
}

function leadSubmitted(
  db: Db,
  input: {
    id: string;
    leadId?: string;
    phoneHash: string;
    occurredAt: Date;
    campaignId?: string;
    adSetId?: string;
    adId?: string;
    status?: string;
  },
) {
  db.conversionLogs.push({
    id: input.id,
    workspaceId: WORKSPACE,
    ...(input.leadId ? { leadId: input.leadId } : {}),
    phoneHash: input.phoneHash,
    customerIdentityKey: input.phoneHash,
    businessSource: "paid",
    campaignId: input.campaignId ?? "cmp_1",
    adSetId: input.adSetId ?? "adset_1",
    adId: input.adId ?? "ad_1",
    ctwaClid: null,
    eventName: "LeadSubmitted",
    eventOccurredAt: input.occurredAt,
    status: input.status ?? "sent",
    valueCents: null,
    valueSource: null,
    currency: null,
    purchaseKind: null,
  });
}

const periodInput = {
  workspaceId: WORKSPACE,
  rangeLabel: "2026-07-01 a 2026-07-02",
  since: "2026-07-01",
  until: "2026-07-02",
  includeSummary: true,
  includeDaily: true,
};

describe("meta reporting: leads novos x leads que voltaram", () => {
  it("counts a lead from before the period apart and keeps CPL on leads novos", async () => {
    const { db, service } = createHarness();
    // First contact on 30/06 (before the period), back through an ad on 02/07
    // twice the same day: one person, two conversations sent to Meta.
    returningLead(db, {
      id: "lead_returning",
      phoneHash: "phone_returning",
      firstMessageAt: new Date("2026-06-30T15:00:00.000Z"),
    });
    leadSubmitted(db, {
      id: "event_returning_1",
      leadId: "lead_returning",
      phoneHash: "phone_returning",
      occurredAt: new Date("2026-07-02T13:00:00.000Z"),
    });
    leadSubmitted(db, {
      id: "event_returning_2",
      leadId: "lead_returning",
      phoneHash: "phone_returning",
      occurredAt: new Date("2026-07-02T18:00:00.000Z"),
    });

    const report = await service.getCampaignReportOverview(periodInput);

    // CPL divides the spend by the 2 leads novos only.
    expect(report.summary).toMatchObject({
      spendCents: 30_000,
      realConversations: 2,
      costPerRealConversationCents: 15_000,
      returningLeads: 1,
      // event_lead_submitted + the two conversations of the returning lead.
      adConversationEvents: 3,
    });
    expect(report.campaigns[0]).toMatchObject({
      realConversations: 2,
      returningLeads: 1,
      costPerRealConversationCents: 15_000,
    });
    expect(report.dailyComparison).toEqual([
      expect.objectContaining({
        date: "2026-07-01",
        realConversations: 1,
        returningLeads: 0,
      }),
      expect.objectContaining({
        date: "2026-07-02",
        realConversations: 1,
        returningLeads: 1,
      }),
    ]);
  });

  it("treats the exact local start of the period as a lead novo, not a return", async () => {
    const { db, service } = createHarness();
    // 01/07 00:00 in Sao Paulo = 03:00Z: first contact inside the period.
    returningLead(db, {
      id: "lead_at_start",
      phoneHash: "phone_at_start",
      firstMessageAt: new Date("2026-07-01T03:00:00.000Z"),
    });
    leadSubmitted(db, {
      id: "event_at_start",
      leadId: "lead_at_start",
      phoneHash: "phone_at_start",
      occurredAt: new Date("2026-07-01T03:00:00.000Z"),
    });
    // 30/06 23:59:59.999 in Sao Paulo: one millisecond before the period.
    returningLead(db, {
      id: "lead_just_before",
      phoneHash: "phone_just_before",
      firstMessageAt: new Date("2026-07-01T02:59:59.999Z"),
    });
    leadSubmitted(db, {
      id: "event_just_before_back",
      leadId: "lead_just_before",
      phoneHash: "phone_just_before",
      occurredAt: new Date("2026-07-01T10:00:00.000Z"),
    });

    const report = await service.getCampaignReportOverview(periodInput);

    expect(report.summary).toMatchObject({
      realConversations: 3,
      returningLeads: 1,
    });
  });

  it("keeps a lead novo on the campaign of its first contact when it comes back through another one", async () => {
    const { db, service } = createHarness();
    db.campaigns.push(campaign("cmp_2", "Remarketing", 0));
    // First contact 01/07 via cmp_1; on 02/07 the same person came back via
    // cmp_2, so the Lead row now points at cmp_2.
    db.leads.push({
      id: "lead_switch",
      workspaceId: WORKSPACE,
      phoneHash: "phone_switch",
      campaignId: "cmp_2",
      adSetId: "adset_2",
      adId: "ad_2",
      ctwaClid: null,
      firstMessageAt: new Date("2026-07-01T14:00:00.000Z"),
      createdAt: new Date("2026-07-01T14:00:00.000Z"),
    });
    leadSubmitted(db, {
      id: "event_switch_first",
      leadId: "lead_switch",
      phoneHash: "phone_switch",
      occurredAt: new Date("2026-07-01T14:00:00.000Z"),
    });
    leadSubmitted(db, {
      id: "event_switch_back",
      leadId: "lead_switch",
      phoneHash: "phone_switch",
      occurredAt: new Date("2026-07-02T14:00:00.000Z"),
      campaignId: "cmp_2",
      adSetId: "adset_2",
      adId: "ad_2",
    });

    const report = await service.getCampaignReportOverview(periodInput);
    const byId = new Map(report.campaigns.map((row) => [row.id, row]));

    // Its second conversation is neither a new lead nor a return for cmp_2.
    expect(byId.get("cmp_2")).toMatchObject({
      realConversations: 0,
      returningLeads: 0,
    });
    expect(byId.get("cmp_1")).toMatchObject({ realConversations: 3 });
  });

  it("counts nothing as returning without a period", async () => {
    const { db, service } = createHarness();
    returningLead(db, {
      id: "lead_returning",
      phoneHash: "phone_returning",
      firstMessageAt: new Date("2026-06-30T15:00:00.000Z"),
    });
    leadSubmitted(db, {
      id: "event_returning_1",
      leadId: "lead_returning",
      phoneHash: "phone_returning",
      occurredAt: new Date("2026-07-02T13:00:00.000Z"),
    });

    const report = await service.getCampaignReportOverview({
      workspaceId: WORKSPACE,
      rangeLabel: "Todo o periodo",
      includeSummary: true,
    });

    expect(report.summary?.returningLeads).toBe(0);
  });

  it("counts people with two or more paid conversations inside the period, new or returning", async () => {
    const { db, service } = createHarness();
    // lead_1 (lead novo): its first conversation (no lead id, matched by
    // phone hash) plus a second one on 02/07.
    leadSubmitted(db, {
      id: "event_lead_1_again",
      leadId: "lead_1",
      phoneHash: "phone_a",
      occurredAt: new Date("2026-07-02T10:00:00.000Z"),
    });
    // Lead antigo back twice in the period.
    returningLead(db, {
      id: "lead_back_twice",
      phoneHash: "phone_back_twice",
      firstMessageAt: new Date("2026-06-20T15:00:00.000Z"),
    });
    leadSubmitted(db, {
      id: "event_back_twice_1",
      leadId: "lead_back_twice",
      phoneHash: "phone_back_twice",
      occurredAt: new Date("2026-07-01T13:00:00.000Z"),
    });
    leadSubmitted(db, {
      id: "event_back_twice_2",
      leadId: "lead_back_twice",
      phoneHash: "phone_back_twice",
      occurredAt: new Date("2026-07-02T13:00:00.000Z"),
    });
    // Only one conversation inside the period: the others fall one
    // millisecond before 01/07 00:00 and exactly at 03/07 00:00 (Sao Paulo).
    returningLead(db, {
      id: "lead_edges",
      phoneHash: "phone_edges",
      firstMessageAt: new Date("2026-06-10T15:00:00.000Z"),
    });
    for (const [id, at] of [
      ["event_edges_before", "2026-07-01T02:59:59.999Z"],
      ["event_edges_inside", "2026-07-01T03:00:00.000Z"],
      ["event_edges_after", "2026-07-03T03:00:00.000Z"],
    ] as const) {
      leadSubmitted(db, {
        id,
        leadId: "lead_edges",
        phoneHash: "phone_edges",
        occurredAt: new Date(at),
      });
    }
    // lead_2: one sent conversation and one skipped (never sent to Meta).
    leadSubmitted(db, {
      id: "event_lead_2_sent",
      leadId: "lead_2",
      phoneHash: "phone_b",
      occurredAt: new Date("2026-07-01T16:00:00.000Z"),
    });
    leadSubmitted(db, {
      id: "event_lead_2_skipped",
      leadId: "lead_2",
      phoneHash: "phone_b",
      occurredAt: new Date("2026-07-01T17:00:00.000Z"),
      status: "skipped",
    });

    const report = await service.getCampaignReportOverview(periodInput);

    expect(report.summary).toMatchObject({
      realConversations: 2,
      returningLeads: 2,
      repeatConversationLeads: 2,
      // lead_1 x2, lead_back_twice x2, lead_edges x1, lead_2 x1 (skipped out).
      adConversationEvents: 6,
      // Context only: CPL still divides by the leads novos.
      costPerRealConversationCents: 15_000,
    });
  });

  it("counts a conversation without lead id for every lead of its phone, from the database", async () => {
    const { db, service } = createHarness();
    // One phone, two Lead rows: one new in the period, one from June.
    returningLead(db, {
      id: "lead_dup_new",
      phoneHash: "phone_dup",
      firstMessageAt: new Date("2026-07-01T14:00:00.000Z"),
    });
    returningLead(db, {
      id: "lead_dup_old",
      phoneHash: "phone_dup",
      firstMessageAt: new Date("2026-06-01T14:00:00.000Z"),
    });
    leadSubmitted(db, {
      id: "event_dup_new",
      leadId: "lead_dup_new",
      phoneHash: "phone_dup",
      occurredAt: new Date("2026-07-01T14:00:00.000Z"),
    });
    leadSubmitted(db, {
      id: "event_dup_phone_only",
      phoneHash: "phone_dup",
      occurredAt: new Date("2026-07-01T18:00:00.000Z"),
    });
    leadSubmitted(db, {
      id: "event_dup_old",
      leadId: "lead_dup_old",
      phoneHash: "phone_dup",
      occurredAt: new Date("2026-07-02T14:00:00.000Z"),
    });

    const report = await service.getCampaignReportOverview(periodInput);

    // Both leads of the phone reach two conversations (same rule as Leads).
    expect(report.summary?.repeatConversationLeads).toBe(2);
  });

  it("exports leads novos and leads que voltaram as separate CSV columns", async () => {
    const { db, service } = createHarness();
    returningLead(db, {
      id: "lead_returning",
      phoneHash: "phone_returning",
      firstMessageAt: new Date("2026-06-30T15:00:00.000Z"),
    });
    leadSubmitted(db, {
      id: "event_returning_1",
      leadId: "lead_returning",
      phoneHash: "phone_returning",
      occurredAt: new Date("2026-07-02T13:00:00.000Z"),
    });

    const csv = await service.getCampaignReportCsv(periodInput);
    const [header, row] = csv.content.split(/\r?\n/u);
    const columns = header!.split(",");
    const values = row!.split(",");

    expect(values[columns.indexOf("Leads novos")]).toBe("2");
    expect(values[columns.indexOf("Leads que voltaram")]).toBe("1");
  });
});
