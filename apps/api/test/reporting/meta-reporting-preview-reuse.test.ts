import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaAdapter } from "../../src/integrations/meta/meta.adapter";
import {
  META_PREVIEW_MISS_TTL_MS,
  MetaReportingService,
} from "../../src/reporting/meta-reporting.service";
import { WhatsappCampaignClassifierService } from "../../src/reporting/whatsapp-campaign-classifier.service";
import {
  FakeMetaGraph,
  type FakeAccount,
  type FakeAd,
  fbcdnUrl,
  hoursFromNow,
} from "../support/fake-meta-graph";
import {
  createFakeReportingPrisma,
  type FakeReportingPrisma,
} from "../support/fake-reporting-prisma";

const TOKEN = "service-secret-token";
const SINCE = "2026-10-05";
const UNTIL = "2026-10-05";

type Harness = {
  graph: FakeMetaGraph;
  prisma: FakeReportingPrisma;
  service: MetaReportingService;
};

function createHarness(env: Record<string, string> = {}): Harness {
  const graph = new FakeMetaGraph();
  const prisma = createFakeReportingPrisma();
  const adapter = new MetaAdapter(
    { META_GRAPH_SLOW_LOG_MS: "999999", ...env },
    graph.fetch,
  );
  const service = new MetaReportingService(
    prisma as never,
    { decrypt: () => TOKEN, fingerprint: () => "fp" } as never,
    adapter,
    { reconcileReportingAccount: async () => undefined } as never,
    new WhatsappCampaignClassifierService(),
    {} as never,
    {} as never,
  );

  return { graph, prisma, service };
}

function seedWorkspace(
  harness: Harness,
  workspaceId: string,
  accounts: Array<{ id: string; businessId: string; adAccountId: string }>,
): void {
  harness.prisma.metaIntegration.rows.push({
    id: `integration_${workspaceId}`,
    workspaceId,
    encryptedAccessToken: "enc",
    tokenIv: "iv",
    tokenTag: "tag",
    selectedAdAccountId: accounts[0]?.adAccountId ?? null,
  });

  for (const account of accounts) {
    harness.prisma.metaReportingAccount.rows.push({
      ...account,
      workspaceId,
      businessName: "Business",
      adAccountName: "Account",
      active: true,
    });
  }
}

function fakeAccount(ads: FakeAd[]): FakeAccount {
  const adSetIds = [...new Set(ads.map((ad) => ad.adSetId))];
  const campaignIds = [...new Set(ads.map((ad) => ad.campaignId))];

  return {
    campaigns: campaignIds.map((id) => ({ id, name: `Campaign ${id}` })),
    adSets: adSetIds.map((id) => ({
      id,
      name: `Set ${id}`,
      campaignId: ads.find((ad) => ad.adSetId === id)?.campaignId ?? "c1",
    })),
    ads,
  };
}

function ad(
  id: string,
  creativeId: string | null,
  listThumbnailUrl?: string | null,
): FakeAd {
  return {
    id,
    name: `Ad ${id}`,
    campaignId: "c1",
    adSetId: "s1",
    creativeId,
    listThumbnailUrl,
  };
}

function imageCreative(graph: FakeMetaGraph, id: string, hours = 72): string {
  const url = fbcdnUrl(`img-${id}-${hours}`, hoursFromNow(hours));
  graph.creatives.set(id, { id, imageUrl: url });
  return url;
}

function sync(harness: Harness, workspaceId: string) {
  return harness.service.syncWorkspaceMetaStructure({
    workspaceId,
    since: SINCE,
    until: UNTIL,
  });
}

function savedAd(harness: Harness, workspaceId: string, adId: string) {
  return harness.prisma.metaAd.rows.find(
    (row) => row.workspaceId === workspaceId && row.adId === adId,
  );
}

function setSavedPreview(
  harness: Harness,
  workspaceId: string,
  adId: string,
  previewUrl: string | null,
): void {
  const row = savedAd(harness, workspaceId, adId);
  if (!row) throw new Error(`missing saved ad ${adId}`);
  row.previewUrl = previewUrl;
}

describe("MetaReportingService preview reuse", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let consoleCalls: unknown[][];

  beforeEach(() => {
    consoleCalls = [];
    logSpy = vi
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);
    for (const method of ["warn", "error", "debug"] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation(
        (...args: unknown[]) => {
          consoleCalls.push(args);
        },
      );
    }
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args);
      });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function advanceClock(ms: number): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + ms));
  }

  function previewLogLines(): string[] {
    return logSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("Meta preview enrichment"));
  }

  function allLogs(): string {
    return JSON.stringify([...logSpy.mock.calls, ...consoleCalls]);
  }

  it("makes zero enrichment batches on a second sync with valid saved previews while structure and metrics calls remain", async () => {
    const harness = createHarness();
    seedWorkspace(harness, "w1", [
      { id: "ra1", businessId: "b1", adAccountId: "act_1" },
    ]);
    harness.graph.accounts.set(
      "act_1",
      fakeAccount([ad("a1", "cr1"), ad("a2", "cr2"), ad("a3", "cr1")]),
    );
    const url1 = imageCreative(harness.graph, "cr1");
    const url2 = imageCreative(harness.graph, "cr2");

    await sync(harness, "w1");
    const coldGets = harness.graph.getRequestCountByPath();
    expect(harness.graph.creativeBatches).toBe(1);
    expect(harness.graph.creativeSubrequestIds.sort()).toEqual(["cr1", "cr2"]);

    harness.graph.resetCounters();
    const result = await sync(harness, "w1");

    expect(result).toMatchObject({
      accountsSynced: 1,
      accountsFailed: 0,
      adsSynced: 3,
    });
    expect(harness.graph.creativeBatches).toBe(0);
    expect(harness.graph.videoBatches).toBe(0);
    expect(harness.graph.getRequestCountByPath()).toEqual(coldGets);
    expect(coldGets).toMatchObject({
      "/ads": 1,
      "/campaigns": 1,
      "/adsets": 1,
      "/insights:campaign": 1,
      "/insights:campaign:daily": 1,
      "/insights:adset": 1,
      "/insights:adset:daily": 1,
      "/insights:ad": 1,
      "/insights:ad:daily": 1,
    });
    expect(savedAd(harness, "w1", "a1")?.previewUrl).toBe(url1);
    expect(savedAd(harness, "w1", "a2")?.previewUrl).toBe(url2);
    expect(savedAd(harness, "w1", "a3")?.previewUrl).toBe(url1);
    expect(savedAd(harness, "w1", "a1")?.spendCents).toBe(150);
    expect(previewLogLines().at(-1)).toMatch(
      /distinctCreatives=2 reused=2 skipped=0 requested=0 .*creativeBatches=0 .*videoBatches=0/,
    );
  });

  it("reuses every saved preview regardless of the CDN expiry hint and requests only new creatives", async () => {
    const harness = createHarness();
    seedWorkspace(harness, "w1", [
      { id: "ra1", businessId: "b1", adAccountId: "act_1" },
    ]);
    const ads = [
      ad("a1", "cr1"),
      ad("a2", "cr2"),
      ad("a3", "cr3"),
      ad("a4", "cr4"),
    ];
    harness.graph.accounts.set("act_1", fakeAccount(ads));
    ["cr1", "cr2", "cr3", "cr4"].forEach((id) =>
      imageCreative(harness.graph, id),
    );
    await sync(harness, "w1");

    const expired = fbcdnUrl("old1", hoursFromNow(-2));
    const otherHost = "https://cdn.example.com/a2.jpg?oe=7fffffff";
    const expiring = fbcdnUrl("old3", hoursFromNow(2));
    setSavedPreview(harness, "w1", "a1", expired);
    setSavedPreview(harness, "w1", "a2", otherHost);
    setSavedPreview(harness, "w1", "a3", expiring);
    const kept4 = savedAd(harness, "w1", "a4")?.previewUrl;
    ads.push(ad("a5", "cr5"));
    harness.graph.accounts.set("act_1", fakeAccount(ads));
    const fresh5 = imageCreative(harness.graph, "cr5", 96);
    harness.graph.resetCounters();

    await sync(harness, "w1");

    expect(harness.graph.creativeSubrequestIds).toEqual(["cr5"]);
    expect(harness.graph.creativeBatches).toBe(1);
    expect(savedAd(harness, "w1", "a1")?.previewUrl).toBe(expired);
    expect(savedAd(harness, "w1", "a2")?.previewUrl).toBe(otherHost);
    expect(savedAd(harness, "w1", "a3")?.previewUrl).toBe(expiring);
    expect(savedAd(harness, "w1", "a4")?.previewUrl).toBe(kept4);
    expect(savedAd(harness, "w1", "a5")?.previewUrl).toBe(fresh5);
    expect(previewLogLines().at(-1)).toMatch(
      /reused=4 skipped=0 requested=1 succeeded=1 failed=0/,
    );
  });

  it("does not call Graph for creatives with saved previews even while Graph is rate limited", async () => {
    const harness = createHarness();
    seedWorkspace(harness, "w1", [
      { id: "ra1", businessId: "b1", adAccountId: "act_1" },
    ]);
    harness.graph.accounts.set(
      "act_1",
      fakeAccount([ad("a1", "cr1"), ad("a2", "cr2")]),
    );
    imageCreative(harness.graph, "cr1");
    imageCreative(harness.graph, "cr2");
    await sync(harness, "w1");
    const stale1 = fbcdnUrl("stale1", hoursFromNow(-3));
    const stale2 = fbcdnUrl("stale2", hoursFromNow(3));
    setSavedPreview(harness, "w1", "a1", stale1);
    setSavedPreview(harness, "w1", "a2", stale2);
    harness.graph.batchFault = (kind) =>
      kind === "creative" ? { kind: "http", status: 429 } : null;
    harness.graph.resetCounters();

    const result = await sync(harness, "w1");

    expect(result).toMatchObject({ accountsSynced: 1, accountsFailed: 0 });
    expect(harness.graph.creativeBatches).toBe(0);
    expect(savedAd(harness, "w1", "a1")?.previewUrl).toBe(stale1);
    expect(savedAd(harness, "w1", "a2")?.previewUrl).toBe(stale2);
  });

  it("does not request a new creative that failed again until the miss TTL expires", async () => {
    const harness = createHarness();
    seedWorkspace(harness, "w1", [
      { id: "ra1", businessId: "b1", adAccountId: "act_1" },
    ]);
    harness.graph.accounts.set(
      "act_1",
      fakeAccount([ad("a1", "cr1"), ad("a2", "cr2")]),
    );
    const url1 = imageCreative(harness.graph, "cr1");
    const url2 = imageCreative(harness.graph, "cr2");
    harness.graph.itemFault = (kind, key) =>
      kind === "creative" && key === "cr2" ? { kind: "code", code: 500 } : null;

    await sync(harness, "w1");
    expect(savedAd(harness, "w1", "a1")?.previewUrl).toBe(url1);
    expect(savedAd(harness, "w1", "a2")?.previewUrl).toBeNull();

    harness.graph.itemFault = () => null;
    harness.graph.resetCounters();
    await sync(harness, "w1");
    expect(harness.graph.creativeBatches).toBe(0);
    expect(savedAd(harness, "w1", "a2")?.previewUrl).toBeNull();
    expect(previewLogLines().at(-1)).toMatch(/reused=1 skipped=1 requested=0/);

    advanceClock(META_PREVIEW_MISS_TTL_MS + 60_000);
    harness.graph.resetCounters();
    await sync(harness, "w1");
    expect(harness.graph.creativeSubrequestIds).toEqual(["cr2"]);
    expect(savedAd(harness, "w1", "a2")?.previewUrl).toBe(url2);
  });

  it("uses the creative's own thumbnail for video creatives and never calls /{video}/thumbnails by default", async () => {
    const harness = createHarness();
    seedWorkspace(harness, "w1", [
      { id: "ra1", businessId: "b1", adAccountId: "act_1" },
    ]);
    harness.graph.accounts.set("act_1", fakeAccount([ad("a1", "cr1")]));
    const small = fbcdnUrl("small", hoursFromNow(72));
    harness.graph.creatives.set("cr1", {
      id: "cr1",
      videoId: "v1",
      thumbnailUrl: small,
    });
    harness.graph.videoThumbnails.set("v1", [
      { uri: fbcdnUrl("big", hoursFromNow(72)), width: 1080, height: 1080 },
    ]);

    await sync(harness, "w1");

    expect(harness.graph.creativeBatches).toBe(1);
    expect(harness.graph.videoBatches).toBe(0);
    expect(savedAd(harness, "w1", "a1")?.previewUrl).toBe(small);
  });

  it("still uses the larger video thumbnail when META_VIDEO_THUMBNAILS_ENABLED=true", async () => {
    const harness = createHarness({ META_VIDEO_THUMBNAILS_ENABLED: "true" });
    seedWorkspace(harness, "w1", [
      { id: "ra1", businessId: "b1", adAccountId: "act_1" },
    ]);
    harness.graph.accounts.set("act_1", fakeAccount([ad("a1", "cr1")]));
    harness.graph.creatives.set("cr1", {
      id: "cr1",
      videoId: "v1",
      thumbnailUrl: fbcdnUrl("small", hoursFromNow(72)),
    });
    const big = fbcdnUrl("big", hoursFromNow(72));
    harness.graph.videoThumbnails.set("v1", [
      { uri: big, width: 1080, height: 1080 },
    ]);

    await sync(harness, "w1");

    expect(harness.graph.videoBatches).toBe(1);
    expect(savedAd(harness, "w1", "a1")?.previewUrl).toBe(big);
  });

  it("clears the old image when the ad's creative changed and the new creative fails", async () => {
    const harness = createHarness();
    seedWorkspace(harness, "w1", [
      { id: "ra1", businessId: "b1", adAccountId: "act_1" },
    ]);
    const thumb1 = fbcdnUrl("thumb1", hoursFromNow(72));
    harness.graph.accounts.set("act_1", fakeAccount([ad("a1", "cr1", thumb1)]));
    imageCreative(harness.graph, "cr1");
    await sync(harness, "w1");
    expect(savedAd(harness, "w1", "a1")).toMatchObject({
      creativeId: "cr1",
      thumbnailUrl: thumb1,
    });

    harness.graph.accounts.set("act_1", fakeAccount([ad("a1", "cr9", null)]));
    imageCreative(harness.graph, "cr9");
    harness.graph.itemFault = (kind, key) =>
      kind === "creative" && key === "cr9" ? { kind: "code", code: 500 } : null;

    await sync(harness, "w1");

    expect(savedAd(harness, "w1", "a1")).toMatchObject({
      creativeId: "cr9",
      previewUrl: null,
      thumbnailUrl: null,
    });
  });

  it("clears the preview when the ad no longer has a creative", async () => {
    const harness = createHarness();
    seedWorkspace(harness, "w1", [
      { id: "ra1", businessId: "b1", adAccountId: "act_1" },
    ]);
    harness.graph.accounts.set(
      "act_1",
      fakeAccount([ad("a1", "cr1", fbcdnUrl("t", hoursFromNow(72)))]),
    );
    imageCreative(harness.graph, "cr1");
    await sync(harness, "w1");

    harness.graph.accounts.set("act_1", fakeAccount([ad("a1", null)]));
    await sync(harness, "w1");

    expect(savedAd(harness, "w1", "a1")).toMatchObject({
      creativeId: null,
      previewUrl: null,
      thumbnailUrl: null,
    });
  });

  it("writes null for a creative Graph returns without media and does not request it again within the TTL", async () => {
    const harness = createHarness();
    seedWorkspace(harness, "w1", [
      { id: "ra1", businessId: "b1", adAccountId: "act_1" },
    ]);
    harness.graph.accounts.set("act_1", fakeAccount([ad("a1", "cr1")]));
    harness.graph.creatives.set("cr1", { id: "cr1" });

    await sync(harness, "w1");

    expect(savedAd(harness, "w1", "a1")?.previewUrl).toBeNull();
    expect(previewLogLines().at(-1)).toMatch(
      /absent=1 .*preservedAfterFailure=0/,
    );

    harness.graph.resetCounters();
    await sync(harness, "w1");
    expect(harness.graph.creativeBatches).toBe(0);
    expect(previewLogLines().at(-1)).toMatch(/skipped=1 requested=0/);
  });

  it("preserves the list thumbnail on transient omission only for the same creative", async () => {
    const harness = createHarness();
    seedWorkspace(harness, "w1", [
      { id: "ra1", businessId: "b1", adAccountId: "act_1" },
    ]);
    const thumb1 = fbcdnUrl("thumb1", hoursFromNow(72));
    const thumb2 = fbcdnUrl("thumb2", hoursFromNow(72));
    harness.graph.accounts.set(
      "act_1",
      fakeAccount([ad("a1", "cr1", thumb1), ad("a2", "cr2", thumb2)]),
    );
    imageCreative(harness.graph, "cr1");
    imageCreative(harness.graph, "cr2");
    imageCreative(harness.graph, "cr3");
    await sync(harness, "w1");

    harness.graph.accounts.set(
      "act_1",
      fakeAccount([ad("a1", "cr1", null), ad("a2", "cr3", null)]),
    );
    await sync(harness, "w1");

    expect(savedAd(harness, "w1", "a1")?.thumbnailUrl).toBe(thumb1);
    expect(savedAd(harness, "w1", "a2")).toMatchObject({
      creativeId: "cr3",
      thumbnailUrl: null,
    });
    expect(previewLogLines().at(-1)).toMatch(/thumbnailsPreserved=1/);
  });

  it("never reuses previews saved by another workspace or another ad account", async () => {
    const harness = createHarness();
    seedWorkspace(harness, "w1", [
      { id: "ra1", businessId: "b1", adAccountId: "act_1" },
    ]);
    harness.graph.accounts.set("act_1", fakeAccount([ad("a1", "cr1")]));
    imageCreative(harness.graph, "cr1");
    await sync(harness, "w1");

    // Same Meta ad account connected by a different tenant.
    seedWorkspace(harness, "w2", [
      { id: "ra2", businessId: "b1", adAccountId: "act_1" },
    ]);
    harness.graph.resetCounters();
    await sync(harness, "w2");
    expect(harness.graph.creativeSubrequestIds).toEqual(["cr1"]);

    // A second account in the original tenant that happens to share the creative id.
    harness.prisma.metaReportingAccount.rows.push({
      id: "ra3",
      workspaceId: "w1",
      businessId: "b1",
      adAccountId: "act_2",
      businessName: "Business",
      adAccountName: "Account 2",
      active: true,
    });
    harness.graph.accounts.set(
      "act_2",
      fakeAccount([{ ...ad("b1", "cr1"), campaignId: "c2", adSetId: "s2" }]),
    );
    harness.graph.resetCounters();
    await sync(harness, "w1");

    // act_1 reuses its own saved preview; act_2 must fetch cr1 itself.
    expect(harness.graph.creativeSubrequestIds).toEqual(["cr1"]);
    expect(harness.graph.creativeBatches).toBe(1);
  });

  it("does not abort structure or metrics sync when every media request fails", async () => {
    const harness = createHarness();
    seedWorkspace(harness, "w1", [
      { id: "ra1", businessId: "b1", adAccountId: "act_1" },
    ]);
    harness.graph.accounts.set(
      "act_1",
      fakeAccount([ad("a1", "cr1"), ad("a2", "cr2")]),
    );
    imageCreative(harness.graph, "cr1");
    harness.graph.batchFault = () => ({ kind: "network" });

    const result = await sync(harness, "w1");

    expect(result).toMatchObject({
      accountsSynced: 1,
      accountsFailed: 0,
      campaignsSynced: 1,
      adSetsSynced: 1,
      adsSynced: 2,
    });
    expect(savedAd(harness, "w1", "a1")).toMatchObject({
      spendCents: 150,
      previewUrl: null,
    });
    expect(
      harness.prisma.metaAdDailyInsight.rows.filter(
        (row) => row.workspaceId === "w1",
      ),
    ).toHaveLength(2);
    expect(
      harness.prisma.metaReportingAccount.rows.find((row) => row.id === "ra1")
        ?.syncStatus,
    ).toBe("synced");
    expect(previewLogLines().at(-1)).toMatch(
      /failed=2 .*rateLimited=0 .*transportError=2/,
    );
  });

  it("logs only aggregate counters, never tokens or media URLs", async () => {
    const harness = createHarness();
    seedWorkspace(harness, "w1", [
      { id: "ra1", businessId: "b1", adAccountId: "act_1" },
    ]);
    harness.graph.accounts.set(
      "act_1",
      fakeAccount([
        ad("a1", "cr1", fbcdnUrl("t", hoursFromNow(72))),
        ad("a2", "cr2"),
      ]),
    );
    imageCreative(harness.graph, "cr1");
    imageCreative(harness.graph, "cr2");
    harness.graph.itemFault = (kind, key) =>
      key === "cr2" ? { kind: "code", code: 500 } : null;
    await sync(harness, "w1");
    harness.graph.batchFault = () => ({ kind: "http", status: 429 });
    setSavedPreview(harness, "w1", "a1", fbcdnUrl("stale", hoursFromNow(1)));
    await sync(harness, "w1");

    expect(previewLogLines()).toHaveLength(2);
    expect(harness.graph.seenAccessTokens.has(TOKEN)).toBe(true);
    const logs = allLogs();
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain("fbcdn");
    expect(logs).not.toContain("oe=");
    expect(logs).not.toContain("access_token");
  });

  describe("large account harness (deterministic fake Graph, not a live measurement)", () => {
    const ADS = 3000;
    const CREATIVES = 2400;
    const VIDEO_CREATIVES = 600;
    const VIDEO_IDS = 500;

    function buildLargeAccount(harness: Harness): FakeAd[] {
      const ads: FakeAd[] = [];

      for (let index = 0; index < ADS; index += 1) {
        const creativeIndex = index % CREATIVES;
        ads.push({
          id: `ad${index}`,
          name: `Ad ${index}`,
          campaignId: `c${index % 20}`,
          adSetId: `s${index % 60}`,
          creativeId: `cr${creativeIndex}`,
          listThumbnailUrl: fbcdnUrl(`t${creativeIndex}`, hoursFromNow(72)),
        });
      }

      for (let index = 0; index < CREATIVES; index += 1) {
        const id = `cr${index}`;

        if (index < VIDEO_CREATIVES) {
          const videoId = `v${index % VIDEO_IDS}`;
          harness.graph.creatives.set(id, {
            id,
            videoId,
            thumbnailUrl: fbcdnUrl(`small${index}`, hoursFromNow(72)),
          });
          harness.graph.videoThumbnails.set(videoId, [
            {
              uri: fbcdnUrl(`big-${videoId}`, hoursFromNow(72)),
              width: 1080,
              height: 1080,
            },
          ]);
        } else {
          imageCreative(harness.graph, id);
        }
      }

      // s{k} always pairs with c{k % 20}, so every ad set has one campaign.
      harness.graph.accounts.set("act_big", fakeAccount(ads));

      return ads;
    }

    function snapshot(harness: Harness) {
      return {
        creativeBatches: harness.graph.creativeBatches,
        creativeSubrequests: harness.graph.creativeSubrequestIds.length,
        distinctCreativeSubrequests: new Set(
          harness.graph.creativeSubrequestIds,
        ).size,
        videoBatches: harness.graph.videoBatches,
        videoSubrequests: harness.graph.videoSubrequestIds.length,
        distinctVideoSubrequests: new Set(harness.graph.videoSubrequestIds)
          .size,
        getRequests: harness.graph.getRequests.length,
      };
    }

    it("cold vs warm vs mixed request counts go through the real adapter and service paths", async () => {
      const harness = createHarness();
      seedWorkspace(harness, "wBig", [
        { id: "raBig", businessId: "bBig", adAccountId: "act_big" },
      ]);
      const ads = buildLargeAccount(harness);

      await sync(harness, "wBig");
      const cold = snapshot(harness);

      harness.graph.resetCounters();
      await sync(harness, "wBig");
      const warm = snapshot(harness);

      // Mixed: 100 saved video previews close to expiry (reused anyway) + 150 brand-new ads/creatives
      // (50 on new videos, 25 on already-known videos, 75 images).
      for (let index = 0; index < 100; index += 1) {
        for (const row of harness.prisma.metaAd.rows) {
          if (row.workspaceId === "wBig" && row.creativeId === `cr${index}`) {
            row.previewUrl = fbcdnUrl(`expiring${index}`, hoursFromNow(6));
          }
        }
      }
      for (let index = 0; index < 150; index += 1) {
        const creativeId = `crNew${index}`;
        ads.push({
          id: `adNew${index}`,
          name: `New ${index}`,
          campaignId: ads[0]?.campaignId ?? "c0",
          adSetId: ads[0]?.adSetId ?? "s0",
          creativeId,
          listThumbnailUrl: null,
        });
        if (index < 50) {
          harness.graph.creatives.set(creativeId, {
            id: creativeId,
            videoId: `vNew${index}`,
            thumbnailUrl: fbcdnUrl(`smallNew${index}`, hoursFromNow(72)),
          });
          harness.graph.videoThumbnails.set(`vNew${index}`, [
            {
              uri: fbcdnUrl(`bigNew${index}`, hoursFromNow(72)),
              width: 720,
              height: 720,
            },
          ]);
        } else if (index < 75) {
          harness.graph.creatives.set(creativeId, {
            id: creativeId,
            videoId: `v${200 + (index - 50)}`,
            thumbnailUrl: fbcdnUrl(`smallKnown${index}`, hoursFromNow(72)),
          });
        } else {
          imageCreative(harness.graph, creativeId);
        }
      }
      harness.graph.resetCounters();
      const mixedResult = await sync(harness, "wBig");
      const mixed = snapshot(harness);

      harness.graph.resetCounters();
      await sync(harness, "wBig");
      const warmAfterMixed = snapshot(harness);

      // Printed so the request counts can be quoted as evidence.
      process.stdout.write(
        `[large-account-harness] ${JSON.stringify({ ads: ADS, creatives: CREATIVES, videoIds: VIDEO_IDS, cold, warm, mixed, warmAfterMixed })}\n`,
      );

      // Video thumbnails are opt-in (META_VIDEO_THUMBNAILS_ENABLED), so there
      // are no /{video}/thumbnails batches at all.
      expect(cold).toEqual({
        creativeBatches: 48,
        creativeSubrequests: 2400,
        distinctCreativeSubrequests: 2400,
        videoBatches: 0,
        videoSubrequests: 0,
        distinctVideoSubrequests: 0,
        getRequests: cold.getRequests,
      });
      expect(warm).toEqual({
        creativeBatches: 0,
        creativeSubrequests: 0,
        distinctCreativeSubrequests: 0,
        videoBatches: 0,
        videoSubrequests: 0,
        distinctVideoSubrequests: 0,
        getRequests: cold.getRequests,
      });
      // Expiring saved previews are reused; only the 150 new creatives are
      // requested -> 3 batches, and no video thumbnail batches.
      expect(mixed).toMatchObject({
        creativeBatches: 3,
        creativeSubrequests: 150,
        distinctCreativeSubrequests: 150,
        videoBatches: 0,
        videoSubrequests: 0,
        distinctVideoSubrequests: 0,
      });
      expect(mixedResult).toMatchObject({ accountsSynced: 1, adsSynced: 3150 });
      expect(warmAfterMixed).toMatchObject({
        creativeBatches: 0,
        videoBatches: 0,
      });
      expect(
        harness.prisma.metaAd.rows.filter(
          (row) =>
            row.workspaceId === "wBig" && typeof row.previewUrl === "string",
        ),
      ).toHaveLength(3150);
    }, 60_000);
  });
});
