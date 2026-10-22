import { describe, expect, it } from "vitest";
import {
  firstContactAttribution,
  firstContactScopeWhere,
  loadLeadIdsByPhoneHash,
  phoneHashesWithoutLeadId,
  repeatConversationLeadIds,
} from "../src/leads/lead-cohort";
import { LeadsService } from "../src/leads/leads.service";
import {
  ReportingMetricsEngine,
  type ReportingMetricEvent,
} from "../src/reporting/reporting-metrics.engine";

type Row = Record<string, unknown>;

/** Small Prisma-like `where` evaluator for the operators these queries use. */
function matches(record: Row, where?: Row): boolean {
  if (!where) return true;

  return Object.entries(where).every(([key, value]) => {
    if (key === "AND")
      return (value as Row[]).every((item) => matches(record, item));
    if (key === "OR")
      return (value as Row[]).some((item) => matches(record, item));

    const current = record[key];

    if (value && typeof value === "object" && !(value instanceof Date)) {
      const condition = value as Row;
      const time = (input: unknown) => new Date(input as Date).getTime();

      if ("in" in condition)
        return (condition.in as unknown[]).includes(current);
      if ("notIn" in condition)
        return !(condition.notIn as unknown[]).includes(current);
      if ("not" in condition) return (current ?? null) !== condition.not;
      if ("lt" in condition)
        return current instanceof Date && time(current) < time(condition.lt);
      if ("gte" in condition || "lte" in condition) {
        if (!(current instanceof Date)) return false;
        if ("gte" in condition && time(current) < time(condition.gte))
          return false;
        if ("lte" in condition && time(current) > time(condition.lte))
          return false;
        return true;
      }
    }

    return (current ?? null) === value;
  });
}

function fakePrisma(db: { leads: Row[]; events: Row[] }) {
  const findMany =
    (rows: () => Row[]) =>
    async (args?: { where?: Row; skip?: number; take?: number }) => {
      const found = rows().filter((row) => matches(row, args?.where));
      const start = args?.skip ?? 0;
      return found.slice(start, args?.take ? start + args.take : undefined);
    };

  return {
    lead: {
      findMany: findMany(() => db.leads),
      count: async (args?: { where?: Row }) =>
        db.leads.filter((row) => matches(row, args?.where)).length,
    },
    conversionEventLog: { findMany: findMany(() => db.events) },
    metaCampaign: {
      findMany: async () => [
        { campaignId: "cmp_a", name: "Campanha A" },
        { campaignId: "cmp_b", name: "Campanha B" },
      ],
    },
    metaAd: { findMany: async () => [] },
    metaAdSet: { findMany: async () => [] },
    whatsappInstance: { findFirst: async () => null },
  };
}

const leadSubmitted = (input: Row): Row => ({
  workspaceId: "workspace_1",
  eventName: "LeadSubmitted",
  status: "sent",
  businessSource: "paid",
  phoneHash: "phone_ab",
  ...input,
});

/**
 * The owner's example: first contact on 11/10 through campaign A, back on
 * 14/10 through campaign B. The Lead row now points at B (upserts keep the
 * latest ad); the reports keep the lead on A.
 */
function aToBDb() {
  return {
    leads: [
      {
        id: "lead_ab",
        workspaceId: "workspace_1",
        name: "Volta por B",
        phoneDisplay: null,
        phoneHash: "phone_ab",
        status: "active",
        source: "uazapi",
        labels: [],
        campaignId: "cmp_b",
        adSetId: "adset_b",
        adId: "ad_b",
        ctwaClid: "clid_b",
        ctwaSourceUrl: null,
        ctwaThumbnailUrl: null,
        firstMessageAt: new Date("2026-10-11T15:00:00.000Z"),
        lastMessageAt: new Date("2026-10-14T15:00:00.000Z"),
        createdAt: new Date("2026-10-11T15:00:00.000Z"),
        updatedAt: new Date("2026-10-14T15:00:00.000Z"),
      },
    ] as Row[],
    events: [
      leadSubmitted({
        id: "ev_a",
        leadId: "lead_ab",
        campaignId: "cmp_a",
        adSetId: "adset_a",
        adId: "ad_a",
        eventOccurredAt: new Date("2026-10-11T15:00:00.000Z"),
      }),
      leadSubmitted({
        id: "ev_b",
        leadId: "lead_ab",
        campaignId: "cmp_b",
        adSetId: "adset_b",
        adId: "ad_b",
        eventOccurredAt: new Date("2026-10-14T15:00:00.000Z"),
      }),
    ] as Row[],
  };
}

describe("first-contact attribution (shared by Leads and reports)", () => {
  it("lists the A->B lead under campaign A, like the reports, and never under B as new", async () => {
    const service = new LeadsService(fakePrisma(aToBDb()) as never);
    const period = { since: "2026-10-11", until: "2026-10-11" };

    const underA = await service.listLeadsPage("workspace_1", {
      ...period,
      campaignId: "cmp_a",
    });
    const underB = await service.listLeadsPage("workspace_1", {
      ...period,
      campaignId: "cmp_b",
    });
    const adSetA = await service.listLeadsPage("workspace_1", {
      ...period,
      adSetId: "adset_a",
      adId: "ad_a",
    });

    expect(underA.pagination.totalItems).toBe(1);
    expect(underA.items[0]).toMatchObject({
      campaignId: "cmp_a",
      campaignName: "Campanha A",
      adId: "ad_a",
    });
    expect(underB.pagination.totalItems).toBe(0);
    expect(adSetA.pagination.totalItems).toBe(1);
  });

  it("lists the A->B lead as 'voltou' on the return day under the campaign that brought it back", async () => {
    const service = new LeadsService(fakePrisma(aToBDb()) as never);
    const today = { since: "2026-10-14", until: "2026-10-14" };

    const newToday = await service.listLeadsPage("workspace_1", today);
    const returnedToday = await service.listLeadsPage("workspace_1", {
      ...today,
      base: "returning",
    });

    expect(newToday.pagination.totalItems).toBe(0);
    expect(returnedToday.pagination.totalItems).toBe(1);
  });

  it("exports with the same first-contact campaign filter", async () => {
    const service = new LeadsService(fakePrisma(aToBDb()) as never);

    const underA = await service.prepareLeadExport("workspace_1", {
      campaignId: "cmp_a",
    });
    const underB = await service.prepareLeadExport("workspace_1", {
      campaignId: "cmp_b",
    });
    const rows = [];

    for await (const batch of underA.batches) rows.push(...batch);

    expect(underA.totalItems).toBe(1);
    expect(underB.totalItems).toBe(0);
    expect(rows[0]).toMatchObject({ campaign: "Campanha A", adId: "ad_a" });
  });

  it("keeps the filter short: only leads whose ad changed are listed by id", async () => {
    const db = aToBDb();
    const where = await firstContactScopeWhere(
      fakePrisma(db) as never,
      "workspace_1",
      "campaignId",
      "cmp_b",
    );

    expect(where).toEqual({
      OR: [{ campaignId: "cmp_b", id: { notIn: ["lead_ab"] } }],
    });
  });

  it("fills fields the first event lacks only from compatible later events", () => {
    const lead = { campaignId: "cmp_b", adSetId: "adset_b", adId: "ad_b" };
    const event = (input: Row) =>
      leadSubmitted({ leadId: "lead_ab", ...input }) as never;

    // First event names only the campaign; a later one of the same campaign
    // completes it, the B row (other campaign) never does.
    expect(
      firstContactAttribution(lead, [
        event({
          campaignId: "cmp_a",
          adSetId: null,
          adId: null,
          eventOccurredAt: new Date("2026-10-11T10:00:00.000Z"),
        }),
        event({
          campaignId: "cmp_a",
          adSetId: "adset_a",
          adId: "ad_a",
          eventOccurredAt: new Date("2026-10-12T10:00:00.000Z"),
        }),
        event({
          campaignId: "cmp_b",
          adSetId: "adset_b",
          adId: "ad_b",
          eventOccurredAt: new Date("2026-10-14T10:00:00.000Z"),
        }),
      ]),
    ).toEqual({ campaignId: "cmp_a", adSetId: "adset_a", adId: "ad_a" });
    // Only an ad id (no hierarchy yet): the row fills nothing of another ad.
    expect(
      firstContactAttribution(lead, [
        event({
          campaignId: null,
          adSetId: null,
          adId: "ad_a",
          eventOccurredAt: new Date("2026-10-11T10:00:00.000Z"),
        }),
      ]),
    ).toEqual({ campaignId: null, adSetId: null, adId: "ad_a" });
    // No ad event: the row stands; skipped/organic events are ignored.
    expect(
      firstContactAttribution(lead, [
        event({
          campaignId: "cmp_a",
          status: "skipped",
          eventOccurredAt: new Date("2026-10-11T10:00:00.000Z"),
        }),
        event({
          campaignId: "cmp_a",
          businessSource: "organic",
          eventOccurredAt: new Date("2026-10-11T10:00:00.000Z"),
        }),
      ]),
    ).toEqual(lead);
  });
});

describe("conversaram mais de uma vez (shared by Leads and reports)", () => {
  const lead = (id: string, firstMessageAt: string): Row => ({
    ...aToBDb().leads[0]!,
    id,
    phoneHash: "phone_dup",
    firstMessageAt: new Date(firstMessageAt),
    createdAt: new Date(firstMessageAt),
  });

  /** One phone, two Lead rows (e.g. two numbers of the workspace). */
  function samePhoneDb() {
    const at = (time: string) => new Date(`2026-10-14T${time}:00.000Z`);

    return {
      leads: [
        lead("lead_x", "2026-10-14T12:00:00.000Z"),
        lead("lead_y", "2026-09-01T12:00:00.000Z"),
      ],
      events: [
        leadSubmitted({
          id: "ev_x",
          leadId: "lead_x",
          phoneHash: "phone_dup",
          eventOccurredAt: at("12:00"),
        }),
        // No lead id: counts for every lead of the phone.
        leadSubmitted({
          id: "ev_phone",
          leadId: null,
          phoneHash: "phone_dup",
          eventOccurredAt: at("13:00"),
        }),
        leadSubmitted({
          id: "ev_y",
          leadId: "lead_y",
          phoneHash: "phone_dup",
          eventOccurredAt: at("14:00"),
        }),
        leadSubmitted({
          id: "ev_skipped",
          leadId: "lead_x",
          phoneHash: "phone_dup",
          status: "skipped",
          eventOccurredAt: at("15:00"),
        }),
      ] as Row[],
    };
  }

  it("counts a conversation without lead id for every lead of the phone", () => {
    expect(
      repeatConversationLeadIds(
        [
          { leadId: "lead_x" },
          { leadId: null, phoneHash: "phone_dup" },
          { leadId: "lead_y" },
          { leadId: null, phoneHash: "phone_unknown" },
          { leadId: null, phoneHash: "phone_unknown" },
        ],
        new Map([["phone_dup", ["lead_x", "lead_y"]]]),
      ).sort(),
    ).toEqual(["lead_x", "lead_y"]);
  });

  it("gives the Leads page and the reports the same people", async () => {
    const db = samePhoneDb();
    const prisma = fakePrisma(db);
    const page = await new LeadsService(prisma as never).listLeadsPage(
      "workspace_1",
      { base: "repeat", since: "2026-10-14", until: "2026-10-14" },
    );
    const events = db.events.map((event) => ({
      adId: null,
      adSetId: null,
      campaignId: "cmp_a",
      currency: null,
      valueCents: null,
      ...event,
    })) as unknown as ReportingMetricEvent[];
    const metrics = new ReportingMetricsEngine().calculate({
      events,
      insight: { spendCents: 0, metaConversationsStarted: 0 },
      leads: [],
      leadIdsByPhoneHash: await loadLeadIdsByPhoneHash(
        prisma,
        "workspace_1",
        phoneHashesWithoutLeadId(events),
      ),
      scope: {},
    });

    expect(page.items.map((item) => item.id).sort()).toEqual([
      "lead_x",
      "lead_y",
    ]);
    expect(metrics.repeatConversationLeads).toBe(2);
  });
});
