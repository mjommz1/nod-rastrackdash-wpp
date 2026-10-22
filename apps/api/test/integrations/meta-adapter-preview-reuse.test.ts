import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaAdapter } from "../../src/integrations/meta/meta.adapter";
import {
  FakeMetaGraph,
  type FakeAd,
  fbcdnUrl,
  hoursFromNow,
} from "../support/fake-meta-graph";

const ACCOUNT = "act_100";
const TOKEN = "adapter-secret-token";

function seed(graph: FakeMetaGraph, ads: FakeAd[]): void {
  graph.accounts.set(ACCOUNT, {
    campaigns: [{ id: "c1", name: "Campaign" }],
    adSets: [{ id: "s1", name: "Set", campaignId: "c1" }],
    ads,
  });
}

function ad(id: string, creativeId: string | null): FakeAd {
  return { id, name: `Ad ${id}`, campaignId: "c1", adSetId: "s1", creativeId };
}

function imageCreative(graph: FakeMetaGraph, id: string): string {
  const url = fbcdnUrl(`img-${id}`, hoursFromNow(72));
  graph.creatives.set(id, { id, imageUrl: url });
  return url;
}

function videoCreative(
  graph: FakeMetaGraph,
  id: string,
  videoId: string,
): string {
  const url = fbcdnUrl(`video-${videoId}`, hoursFromNow(72));
  graph.creatives.set(id, {
    id,
    videoId,
    thumbnailUrl: fbcdnUrl(`small-${id}`, hoursFromNow(72)),
  });
  graph.videoThumbnails.set(videoId, [
    {
      uri: fbcdnUrl(`tiny-${videoId}`, hoursFromNow(72)),
      width: 64,
      height: 64,
    },
    { uri: url, width: 1080, height: 1080, is_preferred: true },
  ]);
  return url;
}

function adapterFor(
  graph: FakeMetaGraph,
  env: Record<string, string | undefined> = {},
): MetaAdapter {
  return new MetaAdapter(
    { META_GRAPH_SLOW_LOG_MS: "999999", ...env },
    graph.fetch,
  );
}

const VIDEO_THUMBNAILS_ON = { META_VIDEO_THUMBNAILS_ENABLED: "true" };

describe("MetaAdapter preview enrichment reuse", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps listAds callers without cache input requesting every distinct creative", async () => {
    const graph = new FakeMetaGraph();
    seed(graph, [ad("a1", "cr1"), ad("a2", "cr2"), ad("a3", "cr1")]);
    const url1 = imageCreative(graph, "cr1");
    const url2 = imageCreative(graph, "cr2");

    const ads = await adapterFor(graph).listAds({
      accessToken: TOKEN,
      adAccountId: ACCOUNT,
    });

    expect(graph.creativeSubrequestIds.sort()).toEqual(["cr1", "cr2"]);
    expect(ads.map((item) => [item.id, item.previewUrl])).toEqual([
      ["a1", url1],
      ["a2", url2],
      ["a3", url1],
    ]);
  });

  it("skips Graph enrichment for creatives supplied as reusable and requests only the rest", async () => {
    const graph = new FakeMetaGraph();
    seed(graph, [ad("a1", "cr1"), ad("a2", "cr2"), ad("a3", "cr3")]);
    imageCreative(graph, "cr1");
    const url2 = imageCreative(graph, "cr2");
    videoCreative(graph, "cr3", "v3");
    const creativeThumb3 = graph.creatives.get("cr3")?.thumbnailUrl;
    const saved1 = fbcdnUrl("saved-cr1", hoursFromNow(48));

    const result = await adapterFor(graph).listAdsWithPreviewStats({
      accessToken: TOKEN,
      adAccountId: ACCOUNT,
      reusablePreviewUrls: new Map([["cr1", saved1]]),
    });

    expect(graph.creativeSubrequestIds.sort()).toEqual(["cr2", "cr3"]);
    // Video thumbnails are opt-in: the creative's own thumbnail is used.
    expect(graph.videoSubrequestIds).toEqual([]);
    expect(
      result.ads.map((item) => [item.id, item.previewUrl, item.previewSource]),
    ).toEqual([
      ["a1", saved1, "reused"],
      ["a2", url2, "fetched"],
      ["a3", creativeThumb3, "fetched"],
    ]);
    expect(result.previewStats).toMatchObject({
      distinctCreatives: 3,
      creativesReused: 1,
      creativesRequested: 2,
      creativesSucceeded: 2,
      creativesFailed: 0,
      creativesWithoutPreview: 0,
      creativeBatchRequests: 1,
      videosRequested: 0,
      videosSucceeded: 0,
      videosFailed: 0,
      videoBatchRequests: 0,
    });
  });

  it("never calls /{video}/thumbnails unless META_VIDEO_THUMBNAILS_ENABLED is exactly \"true\"", async () => {
    for (const value of [undefined, "", "false", "1", "yes", "TRUE"]) {
      const graph = new FakeMetaGraph();
      seed(graph, [ad("a1", "cr1")]);
      videoCreative(graph, "cr1", "v1");
      const creativeThumb = graph.creatives.get("cr1")?.thumbnailUrl;

      const result = await adapterFor(graph, {
        META_VIDEO_THUMBNAILS_ENABLED: value,
      }).listAdsWithPreviewStats({ accessToken: TOKEN, adAccountId: ACCOUNT });

      expect(graph.videoBatches).toBe(0);
      expect(graph.videoSubrequestIds).toEqual([]);
      expect(result.ads[0]).toMatchObject({
        previewUrl: creativeThumb,
        previewSource: "fetched",
      });
    }

    const graph = new FakeMetaGraph();
    seed(graph, [ad("a1", "cr1")]);
    const bigUrl = videoCreative(graph, "cr1", "v1");
    const result = await adapterFor(
      graph,
      VIDEO_THUMBNAILS_ON,
    ).listAdsWithPreviewStats({ accessToken: TOKEN, adAccountId: ACCOUNT });

    expect(graph.videoSubrequestIds).toEqual(["v1"]);
    expect(result.ads[0]?.previewUrl).toBe(bigUrl);
  });

  it("does not request creatives the caller asked to skip and reports them as skipped", async () => {
    const graph = new FakeMetaGraph();
    seed(graph, [ad("a1", "cr1"), ad("a2", "cr2"), ad("a3", "cr3")]);
    imageCreative(graph, "cr1");
    const url2 = imageCreative(graph, "cr2");
    imageCreative(graph, "cr3");
    const saved3 = fbcdnUrl("saved-cr3", hoursFromNow(-48));

    const result = await adapterFor(graph).listAdsWithPreviewStats({
      accessToken: TOKEN,
      adAccountId: ACCOUNT,
      reusablePreviewUrls: new Map([["cr3", saved3]]),
      skipPreviewCreativeIds: new Set(["cr1", "cr3"]),
    });

    expect(graph.creativeSubrequestIds).toEqual(["cr2"]);
    expect(
      result.ads.map((item) => [item.id, item.previewUrl, item.previewSource]),
    ).toEqual([
      ["a1", null, "skipped"],
      ["a2", url2, "fetched"],
      ["a3", saved3, "reused"],
    ]);
    expect(result.previewStats).toMatchObject({
      distinctCreatives: 3,
      creativesReused: 1,
      creativesSkipped: 1,
      creativesRequested: 1,
    });
  });

  it("makes zero enrichment batches when every creative is reusable", async () => {
    const graph = new FakeMetaGraph();
    seed(graph, [ad("a1", "cr1"), ad("a2", "cr2")]);
    imageCreative(graph, "cr1");
    videoCreative(graph, "cr2", "v2");

    const result = await adapterFor(graph).listAdsWithPreviewStats({
      accessToken: TOKEN,
      adAccountId: ACCOUNT,
      reusablePreviewUrls: new Map([
        ["cr1", fbcdnUrl("s1", hoursFromNow(48))],
        ["cr2", fbcdnUrl("s2", hoursFromNow(48))],
      ]),
    });

    expect(graph.creativeBatches).toBe(0);
    expect(graph.videoBatches).toBe(0);
    expect(graph.getRequestCountByPath()).toEqual({ "/ads": 1 });
    expect(result.previewStats).toMatchObject({
      creativesReused: 2,
      creativesRequested: 0,
      creativeBatchRequests: 0,
      videoBatchRequests: 0,
    });
  });

  it("deduplicates shared creatives and shared video ids", async () => {
    const graph = new FakeMetaGraph();
    seed(graph, [
      ad("a1", "cr1"),
      ad("a2", "cr1"),
      ad("a3", "cr2"),
      ad("a4", "cr3"),
    ]);
    videoCreative(graph, "cr1", "vShared");
    videoCreative(graph, "cr2", "vShared");
    videoCreative(graph, "cr3", "vOther");

    const result = await adapterFor(
      graph,
      VIDEO_THUMBNAILS_ON,
    ).listAdsWithPreviewStats({
      accessToken: TOKEN,
      adAccountId: ACCOUNT,
    });

    expect(graph.creativeSubrequestIds.sort()).toEqual(["cr1", "cr2", "cr3"]);
    expect(graph.videoSubrequestIds.sort()).toEqual(["vOther", "vShared"]);
    expect(result.previewStats).toMatchObject({
      distinctCreatives: 3,
      creativesRequested: 3,
      videosRequested: 2,
    });
  });

  it("marks only the failing item as failed on a per-item 500 and keeps the rest", async () => {
    const graph = new FakeMetaGraph();
    seed(graph, [ad("a1", "cr1"), ad("a2", "cr2")]);
    imageCreative(graph, "cr1");
    const url2 = imageCreative(graph, "cr2");
    graph.itemFault = (kind, key) =>
      kind === "creative" && key === "cr1" ? { kind: "code", code: 500 } : null;

    const result = await adapterFor(graph).listAdsWithPreviewStats({
      accessToken: TOKEN,
      adAccountId: ACCOUNT,
    });

    expect(
      result.ads.map((item) => [item.id, item.previewUrl, item.previewSource]),
    ).toEqual([
      ["a1", null, "failed"],
      ["a2", url2, "fetched"],
    ]);
    expect(result.previewStats).toMatchObject({
      creativesSucceeded: 1,
      creativesFailed: 1,
      failureReasons: {
        rateLimited: 0,
        serverError: 1,
        clientError: 0,
        missingItem: 0,
        notAttempted: 0,
        transportError: 0,
      },
    });
  });

  it("classifies per-item Graph rate-limit codes as rate limited", async () => {
    const graph = new FakeMetaGraph();
    seed(graph, [ad("a1", "cr1")]);
    imageCreative(graph, "cr1");
    graph.itemFault = () => ({ kind: "code", code: 400, graphCode: 17 });

    const result = await adapterFor(graph).listAdsWithPreviewStats({
      accessToken: TOKEN,
      adAccountId: ACCOUNT,
    });

    expect(result.ads[0]?.previewSource).toBe("failed");
    expect(result.previewStats.failureReasons.rateLimited).toBe(1);
  });

  it("does not report null batch items as rate limiting", async () => {
    const graph = new FakeMetaGraph();
    seed(graph, [ad("a1", "cr1")]);
    imageCreative(graph, "cr1");
    graph.itemFault = () => ({ kind: "null" });

    const result = await adapterFor(graph).listAdsWithPreviewStats({
      accessToken: TOKEN,
      adAccountId: ACCOUNT,
    });

    expect(result.ads[0]?.previewSource).toBe("failed");
    expect(result.previewStats.failureReasons).toMatchObject({
      rateLimited: 0,
      missingItem: 1,
    });
  });

  it("keeps earlier chunk results and stops further chunks after a batch-level 429", async () => {
    const graph = new FakeMetaGraph();
    const ads = Array.from({ length: 120 }, (_, index) =>
      ad(`a${index}`, `cr${index}`),
    );
    seed(graph, ads);
    ads.forEach((item) => imageCreative(graph, item.creativeId as string));
    graph.batchFault = (kind, index) =>
      kind === "creative" && index === 1 ? { kind: "http", status: 429 } : null;

    const result = await adapterFor(graph).listAdsWithPreviewStats({
      accessToken: TOKEN,
      adAccountId: ACCOUNT,
    });

    expect(graph.creativeBatches).toBe(2);
    expect(
      result.ads.filter((item) => item.previewSource === "fetched"),
    ).toHaveLength(50);
    expect(
      result.ads.filter((item) => item.previewSource === "failed"),
    ).toHaveLength(70);
    expect(result.previewStats).toMatchObject({
      creativesRequested: 120,
      creativesSucceeded: 50,
      creativesFailed: 70,
      creativeBatchRequests: 2,
      failureReasons: {
        rateLimited: 50,
        notAttempted: 20,
        serverError: 0,
        missingItem: 0,
      },
    });
  });

  it("treats a rejected batch fetch as failure without throwing out of listAds", async () => {
    const graph = new FakeMetaGraph();
    seed(graph, [ad("a1", "cr1")]);
    imageCreative(graph, "cr1");
    graph.batchFault = () => ({ kind: "network" });

    const result = await adapterFor(graph).listAdsWithPreviewStats({
      accessToken: TOKEN,
      adAccountId: ACCOUNT,
    });

    expect(result.ads).toHaveLength(1);
    expect(result.ads[0]?.previewSource).toBe("failed");
    expect(result.previewStats.failureReasons).toMatchObject({
      rateLimited: 0,
      transportError: 1,
    });
  });

  it("reports a successfully fetched creative with no media as deliberate absence", async () => {
    const graph = new FakeMetaGraph();
    seed(graph, [ad("a1", "cr1"), ad("a2", null)]);
    graph.creatives.set("cr1", { id: "cr1" });

    const result = await adapterFor(graph).listAdsWithPreviewStats({
      accessToken: TOKEN,
      adAccountId: ACCOUNT,
    });

    expect(
      result.ads.map((item) => [item.id, item.previewUrl, item.previewSource]),
    ).toEqual([
      ["a1", null, "absent"],
      ["a2", null, "no_creative"],
    ]);
    expect(result.previewStats).toMatchObject({
      creativesSucceeded: 1,
      creativesWithoutPreview: 1,
      creativesFailed: 0,
    });
  });

  it("marks a creative as failed (with fallback image) when only its video thumbnail lookup fails", async () => {
    const graph = new FakeMetaGraph();
    seed(graph, [ad("a1", "cr1")]);
    videoCreative(graph, "cr1", "v1");
    const fallback = graph.creatives.get("cr1")?.thumbnailUrl;
    graph.itemFault = (kind) =>
      kind === "video" ? { kind: "code", code: 503 } : null;

    const result = await adapterFor(
      graph,
      VIDEO_THUMBNAILS_ON,
    ).listAdsWithPreviewStats({
      accessToken: TOKEN,
      adAccountId: ACCOUNT,
    });

    expect(result.ads[0]).toMatchObject({
      previewUrl: fallback,
      previewSource: "failed",
    });
    expect(result.previewStats).toMatchObject({
      videosRequested: 1,
      videosFailed: 1,
      videosSucceeded: 0,
    });
  });

  it("never logs access tokens or media URLs on enrichment failures", async () => {
    const graph = new FakeMetaGraph();
    seed(graph, [ad("a1", "cr1")]);
    imageCreative(graph, "cr1");
    graph.batchFault = () => ({ kind: "http", status: 500 });

    await adapterFor(graph).listAdsWithPreviewStats({
      accessToken: TOKEN,
      adAccountId: ACCOUNT,
    });

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("fbcdn");
    expect(logged).not.toContain("oe=");
  });
});
