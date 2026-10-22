import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LeadsService } from "../src/leads/leads.service";

function createHarness() {
  const db = {
    leads: [
      {
        id: "lead_1",
        workspaceId: "workspace_1",
        name: "Mariana Alves",
        phoneDisplay: "+55 11 *****-1020",
        phoneHash: "phone_hash_1",
        status: "active",
        source: "uazapi",
        labels: ["Venda fechada", "VIP"],
        campaignId: "cmp_1",
        adSetId: "adset_1",
        adId: "ad_1",
        ctwaClid: "ctwa_click_1",
        ctwaSourceUrl: "https://www.instagram.com/p/creative/",
        ctwaThumbnailUrl: "https://cdn.example.test/creative.jpg",
        firstMessageAt: new Date("2026-07-02T03:00:00.000Z"),
        lastMessageAt: new Date("2026-07-02T03:10:00.000Z"),
        createdAt: new Date("2026-07-02T03:00:00.000Z"),
        updatedAt: new Date("2026-07-02T03:10:00.000Z"),
      },
    ],
    conversionLogs: [
      {
        id: "conversion_1",
        leadId: "lead_1",
        phoneHash: "phone_hash_1",
        sourceTrigger: "keyword",
        eventName: "QualifiedLead",
        status: "sent",
        pixelId: "pixel_1",
        campaignId: "cmp_1",
        adSetId: "adset_1",
        adId: "ad_1",
        errorCode: null,
        errorMessage: null,
        eventOccurredAt: new Date("2026-07-02T03:11:00.000Z"),
        sentAt: new Date("2026-07-02T03:13:00.000Z"),
        createdAt: new Date("2026-07-02T03:12:00.000Z"),
      },
    ],
    webhookLogs: [
      {
        id: "webhook_1",
        source: "uazapi",
        eventType: "message",
        status: "processed",
        leadId: "lead_1",
        phoneHash: "phone_hash_1",
        errorCode: null,
        errorMessage: null,
        receivedAt: new Date("2026-07-02T03:01:00.000Z"),
        processedAt: new Date("2026-07-02T03:01:01.000Z"),
      },
    ],
    campaigns: [
      {
        campaignId: "cmp_1",
        name: "Black Friday WhatsApp",
      },
    ],
    adSets: [
      {
        adSetId: "adset_1",
        name: "Publico quente",
      },
    ],
    ads: [
      {
        adId: "ad_1",
        campaignId: "cmp_1",
        adSetId: "adset_1",
        name: "Criativo WhatsApp",
      },
    ],
  };
  const prisma = {
    lead: {
      findMany: vi.fn(async () => db.leads),
      count: vi.fn(async () => db.leads.length),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; workspaceId: string } }) =>
          db.leads.find(
            (lead) =>
              lead.id === where.id && lead.workspaceId === where.workspaceId,
          ) ?? null,
      ),
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => ({
          id: "lead_2",
          createdAt: new Date("2026-07-02T04:00:00.000Z"),
          updatedAt: new Date("2026-07-02T04:00:00.000Z"),
          ...create,
          ...update,
        }),
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    conversionEventLog: {
      findMany: vi.fn(async () => db.conversionLogs),
    },
    webhookLog: {
      findMany: vi.fn(async () => db.webhookLogs),
    },
    metaCampaign: {
      findMany: vi.fn(async () => db.campaigns),
    },
    metaAdSet: {
      findMany: vi.fn(async () => db.adSets),
    },
    metaAd: {
      findMany: vi.fn(async () => db.ads),
    },
  };

  return {
    db,
    prisma,
    service: new LeadsService(prisma as never),
  };
}

describe("leads service", () => {
  it("lists leads for a workspace with campaign names and latest conversion event", async () => {
    const { prisma, service } = createHarness();

    const leads = await service.listLeads("workspace_1", {
      search: "Mariana",
      status: "active",
      label: "Venda fechada",
      limit: 25,
    });

    expect(prisma.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace_1",
          status: "active",
          labels: { has: "Venda fechada" },
        }),
        skip: 0,
        take: 25,
      }),
    );
    expect(prisma.lead.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "workspace_1" }),
      }),
    );
    expect(leads).toEqual([
      expect.objectContaining({
        id: "lead_1",
        campaignName: "Black Friday WhatsApp",
        lastEventName: "QualifiedLead",
        labels: ["Venda fechada", "VIP"],
      }),
    ]);
  });

  it("filters leads by attribution and Sao Paulo conversation period", async () => {
    const { prisma, service } = createHarness();

    await service.listLeads("workspace_1", {
      campaignId: "cmp_1",
      adSetId: "adset_1",
      adId: "ad_1",
      since: "2026-07-01",
      until: "2026-07-02",
      limit: 50,
    });

    expect(prisma.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace_1",
          // Drill-downs follow the first-contact attribution (same as the
          // reports); lead_1's first contact is its own row here.
          AND: [
            { OR: [{ campaignId: "cmp_1" }] },
            { OR: [{ adSetId: "adset_1" }] },
            { OR: [{ adId: "ad_1" }] },
            {
              OR: [
                {
                  firstMessageAt: {
                    gte: new Date("2026-07-01T03:00:00.000Z"),
                    lte: new Date("2026-07-03T02:59:59.999Z"),
                  },
                },
                {
                  firstMessageAt: null,
                  createdAt: {
                    gte: new Date("2026-07-01T03:00:00.000Z"),
                    lte: new Date("2026-07-03T02:59:59.999Z"),
                  },
                },
              ],
            },
          ],
        }),
      }),
    );
  });

  it("resolves stale campaign parents through the Meta ad hierarchy", async () => {
    const { db, prisma, service } = createHarness();
    db.leads[0] = {
      ...db.leads[0],
      campaignId: "stale_campaign",
      adSetId: "stale_adset",
    };

    const leads = await service.listLeads("workspace_1", { limit: 25 });

    expect(leads[0]).toMatchObject({
      campaignId: "cmp_1",
      adSetId: "adset_1",
      adId: "ad_1",
      campaignName: "Black Friday WhatsApp",
    });
    expect(prisma.metaAd.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_1",
        adId: { in: ["ad_1"] },
      },
      select: {
        adId: true,
        campaignId: true,
        adSetId: true,
      },
    });
  });

  it("infers LeadSubmitted for an imported conversation without an event log", async () => {
    const { db, service } = createHarness();
    db.conversionLogs = [];

    const leads = await service.listLeads("workspace_1", { limit: 25 });

    expect(leads[0]).toMatchObject({
      id: "lead_1",
      status: "active",
      lastEventName: "LeadSubmitted",
    });
  });

  it("does not display LeadSubmitted after the lead reached qualification", async () => {
    const { db, service } = createHarness();
    db.leads[0] = {
      ...db.leads[0],
      status: "qualified",
    };
    db.conversionLogs = [
      {
        ...db.conversionLogs[0],
        eventName: "LeadSubmitted",
        eventOccurredAt: new Date("2026-07-02T03:20:00.000Z"),
      },
    ];

    const leads = await service.listLeads("workspace_1", { limit: 25 });

    expect(leads[0]).toMatchObject({
      status: "qualified",
      lastEventName: "QualifiedLead",
    });
  });

  it("includes imported conversations in the LeadSubmitted event filter", async () => {
    const { prisma, service } = createHarness();

    await service.listLeads("workspace_1", {
      eventName: "LeadSubmitted",
      limit: 25,
    });

    expect(prisma.lead.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_1",
        firstMessageAt: { not: null },
      },
      select: { id: true },
    });
  });

  it("finds a lead by its complete normalized phone hash", async () => {
    const { prisma, service } = createHarness();
    const phone = "5511999991020";
    const phoneHash = createHash("sha256").update(phone).digest("hex");

    await service.listLeads("workspace_1", {
      search: phone,
      limit: 25,
    });

    expect(prisma.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace_1",
          AND: [
            expect.objectContaining({
              OR: expect.arrayContaining([{ phoneHash }]),
            }),
          ],
        }),
      }),
    );
  });

  it("filters conversations without campaign, ad or ctwa attribution", async () => {
    const { prisma, service } = createHarness();

    await service.listLeads("workspace_1", {
      attribution: "organic",
      limit: 25,
    });

    expect(prisma.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace_1",
          AND: [
            {
              campaignId: null,
              adSetId: null,
              adId: null,
              ctwaClid: null,
            },
          ],
        }),
      }),
    );
  });

  it("upserts a lead from Uazapi webhook attribution data", async () => {
    const { prisma, service } = createHarness();

    const result = await service.upsertFromWhatsappWebhook({
      workspaceId: "workspace_1",
      name: "Rafael Costa",
      phone: "+55 (31) 97710-4300",
      source: "uazapi",
      labels: ["Venda fechada"],
      campaignId: "cmp_2",
      adSetId: "adset_2",
      adId: "ad_2",
      occurredAt: new Date("2026-07-02T04:00:00.000Z"),
    });

    expect(result?.id).toBe("lead_2");
    expect(prisma.lead.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_phoneHash: {
            workspaceId: "workspace_1",
            phoneHash: expect.any(String),
          },
        },
        create: expect.objectContaining({
          workspaceId: "workspace_1",
          name: "Rafael Costa",
          phoneDisplay: "+55 31 97710-4300",
          labels: ["Venda fechada"],
          campaignId: "cmp_2",
          adId: "ad_2",
        }),
        update: expect.objectContaining({
          name: "Rafael Costa",
          labels: ["Venda fechada"],
          lastMessageAt: new Date("2026-07-02T04:00:00.000Z"),
        }),
      }),
    );
  });

  it("preserves the earliest first message when replaying retained events", async () => {
    const { prisma, service } = createHarness();
    const replayedAt = new Date("2026-07-01T04:00:00.000Z");

    await service.upsertFromWhatsappWebhook({
      workspaceId: "workspace_1",
      name: "Rafael Costa",
      phone: "+55 (31) 97710-4300",
      source: "umbler",
      adId: "ad_2",
      occurredAt: replayedAt,
      firstMessageAt: replayedAt,
      preserveExistingSource: true,
      preserveEarliestFirstMessageAt: true,
    });

    expect(prisma.lead.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          firstMessageAt: undefined,
          lastMessageAt: replayedAt,
        }),
      }),
    );
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: {
        id: "lead_2",
        workspaceId: "workspace_1",
        OR: [{ firstMessageAt: null }, { firstMessageAt: { gt: replayedAt } }],
      },
      data: {
        firstMessageAt: replayedAt,
      },
    });
  });

  it("does not create a lead from an invalid short numeric identifier", async () => {
    const { prisma, service } = createHarness();

    const result = await service.upsertFromWhatsappWebhook({
      workspaceId: "workspace_1",
      phone: "20260712",
      source: "external_mysql",
    });

    expect(result).toBeNull();
    expect(prisma.lead.upsert).not.toHaveBeenCalled();
  });

  it("stores CTWA fields on create and preserves them when later webhooks omit CTWA", async () => {
    const { prisma, service } = createHarness();

    await service.upsertFromWhatsappWebhook({
      workspaceId: "workspace_1",
      name: "Rafael Costa",
      phone: "+55 (31) 97710-4300",
      source: "uazapi",
      labels: ["Venda fechada"],
      campaignId: "cmp_2",
      adSetId: "adset_2",
      adId: "ad_2",
      ctwaClid: "ctwa_click_1",
      ctwaSourceUrl: "https://fb.com/ad/ctwa",
      ctwaThumbnailUrl: "https://cdn.example.test/creative.jpg",
      occurredAt: new Date("2026-07-02T04:00:00.000Z"),
    });
    await service.upsertFromWhatsappWebhook({
      workspaceId: "workspace_1",
      name: "Rafael Costa",
      phone: "+55 (31) 97710-4300",
      source: "uazapi",
      labels: ["Venda fechada"],
      campaignId: "cmp_2",
      adSetId: "adset_2",
      adId: "ad_2",
      occurredAt: new Date("2026-07-02T04:05:00.000Z"),
    });

    expect(prisma.lead.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        create: expect.objectContaining({
          ctwaClid: "ctwa_click_1",
          ctwaSourceUrl: "https://fb.com/ad/ctwa",
          ctwaThumbnailUrl: "https://cdn.example.test/creative.jpg",
        }),
        update: expect.objectContaining({
          ctwaClid: "ctwa_click_1",
          ctwaSourceUrl: "https://fb.com/ad/ctwa",
          ctwaThumbnailUrl: "https://cdn.example.test/creative.jpg",
        }),
      }),
    );
    expect(prisma.lead.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        update: expect.objectContaining({
          ctwaClid: undefined,
          ctwaSourceUrl: undefined,
          ctwaThumbnailUrl: undefined,
        }),
      }),
    );
    const secondUpdate = prisma.lead.upsert.mock.calls[1]?.[0].update;

    expect(Object.hasOwn(secondUpdate, "ctwaClid")).toBe(true);
    expect(Object.hasOwn(secondUpdate, "ctwaSourceUrl")).toBe(true);
    expect(Object.hasOwn(secondUpdate, "ctwaThumbnailUrl")).toBe(true);
    expect(secondUpdate.ctwaClid).toBeUndefined();
    expect(secondUpdate.ctwaSourceUrl).toBeUndefined();
    expect(secondUpdate.ctwaThumbnailUrl).toBeUndefined();
  });

  it("returns lead detail with attribution, conversions and webhook timeline", async () => {
    const { prisma, service } = createHarness();

    const detail = await service.getLeadDetail("workspace_1", "lead_1");

    expect(prisma.lead.findFirst).toHaveBeenCalledWith({
      where: {
        id: "lead_1",
        workspaceId: "workspace_1",
      },
    });
    expect(detail).toMatchObject({
      lead: {
        id: "lead_1",
        campaignName: "Black Friday WhatsApp",
        lastEventName: "QualifiedLead",
        labels: ["Venda fechada", "VIP"],
      },
      attribution: {
        campaignName: "Black Friday WhatsApp",
        adSetName: "Publico quente",
        adName: "Criativo WhatsApp",
        creative: {
          thumbnailUrl: "https://cdn.example.test/creative.jpg",
          destinationUrl: "https://www.instagram.com/p/creative/",
        },
      },
      conversionEvents: [
        {
          id: "conversion_1",
          eventName: "QualifiedLead",
          status: "sent",
          occurredAt: "2026-07-02T03:11:00.000Z",
          sentAt: "2026-07-02T03:13:00.000Z",
        },
      ],
      webhookEvents: [
        {
          id: "webhook_1",
          source: "uazapi",
          status: "processed",
        },
      ],
    });
  });

  it("does not expose non-http creative URLs in lead detail", async () => {
    const { db, service } = createHarness();
    db.leads[0]!.ctwaSourceUrl = "javascript:alert(1)";
    db.leads[0]!.ctwaThumbnailUrl = "data:image/png;base64,unsafe";

    const detail = await service.getLeadDetail("workspace_1", "lead_1");

    expect(detail.attribution.creative).toEqual({
      thumbnailUrl: null,
      destinationUrl: null,
    });
  });
});

describe("leads search filters", () => {
  function searchFilter(prisma: any) {
    const where = prisma.lead.findMany.mock.calls.at(-1)[0].where;
    return where.AND[0].OR as Array<Record<string, unknown>>;
  }

  it("keeps a plain name search without phone filters", async () => {
    const { prisma, service } = createHarness();

    await service.listLeads("workspace_1", { search: "Mariana", limit: 25 });

    const filter = searchFilter(prisma);
    expect(filter).toHaveLength(2);
    expect(filter.some((entry) => "phoneHash" in entry)).toBe(false);
  });
});

describe("leads service base (novos x voltaram)", () => {
  const periodStart = new Date("2026-10-14T03:00:00.000Z");
  const periodRange = {
    gte: periodStart,
    lte: new Date("2026-10-15T02:59:59.999Z"),
  };
  // The list/count only carry the people who came back (resolved first).
  const returningWhere = (extra: Record<string, unknown>[] = []) =>
    expect.objectContaining({
      workspaceId: "workspace_1",
      AND: [...extra, { id: { in: ["lead_1"] } }],
    });
  const returningLookup = {
    where: {
      workspaceId: "workspace_1",
      AND: [
        {
          OR: [
            { id: { in: ["lead_1"] } },
            { phoneHash: { in: ["phone_without_lead"] } },
          ],
        },
        {
          OR: [
            { firstMessageAt: { lt: periodStart } },
            { firstMessageAt: null, createdAt: { lt: periodStart } },
          ],
        },
      ],
    },
    select: { id: true },
  };

  function harnessWithReturningConversations() {
    const harness = createHarness();

    (
      harness.prisma.conversionEventLog.findMany as unknown as {
        mockImplementation(
          fn: (args?: { where?: { eventName?: string } }) => Promise<unknown>,
        ): void;
      }
    ).mockImplementation(async (args) =>
      args?.where?.eventName === "LeadSubmitted"
        ? [
            { leadId: "lead_1", phoneHash: "phone_hash_1" },
            { leadId: "lead_1", phoneHash: "phone_hash_1" },
            { leadId: null, phoneHash: "phone_without_lead" },
          ]
        : harness.db.conversionLogs,
    );

    return harness;
  }

  it("lists the leads that came back: paid conversation in the period, first contact before it", async () => {
    const { prisma, service } = harnessWithReturningConversations();

    await service.listLeadsPage("workspace_1", {
      base: "returning",
      since: "2026-10-14",
      until: "2026-10-14",
      page: 1,
      pageSize: 25,
    });

    expect(prisma.conversionEventLog.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_1",
        eventName: "LeadSubmitted",
        status: { not: "skipped" },
        businessSource: { not: "organic" },
        eventOccurredAt: periodRange,
      },
      select: { leadId: true, phoneHash: true },
    });
    expect(prisma.lead.findMany).toHaveBeenCalledWith(returningLookup);
    expect(prisma.lead.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: returningWhere() }),
    );
    // No "first contact in the period" filter on this base.
    expect(
      JSON.stringify(prisma.lead.findMany.mock.calls.at(-1)),
    ).not.toContain('"gte"');
  });

  it("matches nobody as returning without a period start", async () => {
    const { prisma, service } = harnessWithReturningConversations();

    const page = await service.listLeadsPage("workspace_1", {
      base: "returning",
      until: "2026-10-14",
    });

    expect(page.pagination.totalItems).toBe(0);
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
  });

  it("keeps the first-contact period filter for leads novos (default base)", async () => {
    const { prisma, service } = createHarness();

    await service.listLeadsPage("workspace_1", {
      since: "2026-10-14",
      until: "2026-10-14",
    });

    expect(prisma.lead.count).toHaveBeenLastCalledWith({
      where: {
        workspaceId: "workspace_1",
        AND: [
          {
            OR: [
              { firstMessageAt: periodRange },
              { firstMessageAt: null, createdAt: periodRange },
            ],
          },
        ],
      },
    });
  });

  it("splits the same list by origin so organic leads show as their own count", async () => {
    const { prisma, service } = createHarness();
    prisma.lead.count.mockImplementation(
      async (args?: { where?: { AND?: unknown[] } }) => {
        const filters = JSON.stringify(args?.where?.AND ?? []);

        if (filters.includes('"ctwaClid":{"not":null}')) return 50;
        if (filters.includes('"ctwaClid":null')) return 6;
        return 56;
      },
    );

    const page = await service.listLeadsPage("workspace_1", {
      since: "2026-10-14",
      until: "2026-10-14",
    });

    expect(page.pagination.totalItems).toBe(56);
    expect(page.attributionCounts).toEqual({ paid: 50, organic: 6 });
  });

  it("exports the same base the list shows", async () => {
    const { prisma, service } = harnessWithReturningConversations();

    await service.prepareLeadExport("workspace_1", {
      base: "returning",
      attribution: "paid",
      since: "2026-10-14",
      until: "2026-10-14",
    });

    expect(prisma.lead.count).toHaveBeenCalledWith({
      where: returningWhere([
        {
          OR: [
            { campaignId: { not: null } },
            { adSetId: { not: null } },
            { adId: { not: null } },
            { ctwaClid: { not: null } },
          ],
        },
      ]),
    });
  });
});

describe("leads service base repeat (conversaram mais de uma vez)", () => {
  const periodRange = {
    gte: new Date("2026-10-14T03:00:00.000Z"),
    lte: new Date("2026-10-15T02:59:59.999Z"),
  };

  function harnessWithConversations() {
    const harness = createHarness();

    (
      harness.prisma.conversionEventLog.findMany as unknown as {
        mockImplementation(
          fn: (args?: { where?: { eventName?: string } }) => Promise<unknown>,
        ): void;
      }
    ).mockImplementation(async (args) =>
      args?.where?.eventName === "LeadSubmitted"
        ? [
            { leadId: "lead_1", phoneHash: "phone_hash_1" },
            // Same person, event without lead id: matched by phone hash.
            { leadId: null, phoneHash: "phone_hash_1" },
            { leadId: "lead_once", phoneHash: "phone_once" },
            { leadId: "lead_twice", phoneHash: "phone_twice" },
            { leadId: "lead_twice", phoneHash: "phone_twice" },
            // No Lead row behind it: not a person on this page.
            { leadId: null, phoneHash: "phone_orphan" },
            { leadId: null, phoneHash: "phone_orphan" },
          ]
        : harness.db.conversionLogs,
    );

    return harness;
  }

  it("lists people with two or more paid conversations in the period, new or not", async () => {
    const { prisma, service } = harnessWithConversations();
    prisma.lead.findMany.mockImplementationOnce(
      async () => [{ id: "lead_1", phoneHash: "phone_hash_1" }] as never,
    );

    await service.listLeadsPage("workspace_1", {
      base: "repeat",
      since: "2026-10-14",
      until: "2026-10-14",
      page: 1,
      pageSize: 25,
    });

    // Paid, not skipped, inside the Sao Paulo period.
    expect(prisma.conversionEventLog.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_1",
        eventName: "LeadSubmitted",
        status: { not: "skipped" },
        businessSource: { not: "organic" },
        eventOccurredAt: periodRange,
      },
      select: { leadId: true, phoneHash: true },
    });
    expect(prisma.lead.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_1",
        phoneHash: { in: ["phone_hash_1", "phone_orphan"] },
      },
      select: { id: true, phoneHash: true },
    });
    expect(prisma.lead.count).toHaveBeenLastCalledWith({
      where: {
        workspaceId: "workspace_1",
        AND: [{ id: { in: ["lead_1", "lead_twice"] } }],
      },
    });
  });

  it("matches nobody without a period", async () => {
    const { prisma, service } = harnessWithConversations();

    const page = await service.listLeadsPage("workspace_1", {
      base: "repeat",
    });

    expect(page.pagination.totalItems).toBe(0);
    expect(prisma.conversionEventLog.findMany).not.toHaveBeenCalled();
    expect(prisma.lead.count).not.toHaveBeenCalled();
  });

  it("exports the same people the list shows", async () => {
    const { prisma, service } = harnessWithConversations();
    prisma.lead.findMany.mockImplementationOnce(
      async () => [{ id: "lead_1", phoneHash: "phone_hash_1" }] as never,
    );

    await service.prepareLeadExport("workspace_1", {
      base: "repeat",
      since: "2026-10-14",
      until: "2026-10-14",
    });

    expect(prisma.lead.count).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_1",
        AND: [{ id: { in: ["lead_1", "lead_twice"] } }],
      },
    });
  });
});
