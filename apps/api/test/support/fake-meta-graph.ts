/**
 * Deterministic in-memory Meta Graph used by preview reuse tests. It answers
 * the real URLs/batch bodies produced by MetaAdapter and counts every request
 * it actually receives; nothing here talks to the network.
 */

export type FakeCreative = {
  id: string;
  imageUrl?: string | null;
  videoId?: string | null;
  thumbnailUrl?: string | null;
};

export type FakeAd = {
  id: string;
  name: string;
  campaignId: string;
  adSetId: string;
  creativeId: string | null;
  listThumbnailUrl?: string | null;
};

export type FakeAccount = {
  campaigns: Array<{ id: string; name: string }>;
  adSets: Array<{ id: string; name: string; campaignId: string }>;
  ads: FakeAd[];
};

export type BatchKind = "creative" | "video";

export type BatchFault =
  { kind: "http"; status: number; graphCode?: number } | { kind: "network" };

export type ItemFault =
  { kind: "code"; code: number; graphCode?: number } | { kind: "null" };

export function oeHex(date: Date): string {
  return Math.floor(date.getTime() / 1000)
    .toString(16)
    .padStart(8, "0");
}

export function fbcdnUrl(name: string, expiresAt: Date): string {
  return `https://scontent.xx.fbcdn.net/v/t45.1600-4/${name}.jpg?_nc_cat=1&oh=00_sig&oe=${oeHex(expiresAt)}`;
}

export function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

export class FakeMetaGraph {
  readonly accounts = new Map<string, FakeAccount>();
  readonly creatives = new Map<string, FakeCreative>();
  readonly videoThumbnails = new Map<
    string,
    Array<{
      uri: string;
      width: number;
      height: number;
      is_preferred?: boolean;
    }>
  >();

  batchFault: (kind: BatchKind, index: number) => BatchFault | null = () =>
    null;
  itemFault: (kind: BatchKind, key: string) => ItemFault | null = () => null;

  getRequests: string[] = [];
  creativeBatches = 0;
  videoBatches = 0;
  creativeSubrequestIds: string[] = [];
  videoSubrequestIds: string[] = [];
  /** Every raw URL/body seen; used to prove tokens never reach logs. */
  readonly seenAccessTokens = new Set<string>();

  resetCounters(): void {
    this.getRequests = [];
    this.creativeBatches = 0;
    this.videoBatches = 0;
    this.creativeSubrequestIds = [];
    this.videoSubrequestIds = [];
  }

  getRequestCountByPath(): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const path of this.getRequests) {
      counts[path] = (counts[path] ?? 0) + 1;
    }

    return counts;
  }

  readonly fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));

    if (init?.method === "POST") {
      return this.handleBatch(init.body as URLSearchParams);
    }

    const token = url.searchParams.get("access_token");
    if (token) this.seenAccessTokens.add(token);

    return this.handleList(url);
  }) as typeof fetch;

  private handleList(url: URL): Response {
    const path = url.pathname.replace(/^\/v21\.0/, "");
    const [, adAccountId, edge] = path.split("/");
    const account = this.accounts.get(adAccountId ?? "");
    const label = `/${edge}${edge === "insights" ? `:${url.searchParams.get("level")}${url.searchParams.get("time_increment") ? ":daily" : ""}` : ""}`;

    this.getRequests.push(label);

    if (!account) {
      return json({ error: { message: "Unknown account", code: 100 } }, 400);
    }

    let rows: unknown[];

    if (edge === "campaigns") {
      rows = account.campaigns.map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        status: "ACTIVE",
        effective_status: "ACTIVE",
        objective: "OUTCOME_ENGAGEMENT",
      }));
    } else if (edge === "adsets") {
      rows = account.adSets.map((adSet) => ({
        id: adSet.id,
        name: adSet.name,
        campaign_id: adSet.campaignId,
        status: "ACTIVE",
        effective_status: "ACTIVE",
        destination_type: "WHATSAPP",
      }));
    } else if (edge === "ads") {
      rows = account.ads.map((ad) => ({
        id: ad.id,
        name: ad.name,
        campaign_id: ad.campaignId,
        adset_id: ad.adSetId,
        status: "ACTIVE",
        effective_status: "ACTIVE",
        ...(ad.creativeId
          ? {
              creative: {
                id: ad.creativeId,
                call_to_action_type: "WHATSAPP_MESSAGE",
                ...(ad.listThumbnailUrl
                  ? { thumbnail_url: ad.listThumbnailUrl }
                  : {}),
              },
            }
          : {}),
      }));
    } else if (edge === "insights") {
      rows = this.insightRows(account, url);
    } else {
      return json({ error: { message: "Unknown edge", code: 100 } }, 400);
    }

    const limit = Number(url.searchParams.get("limit") ?? "25");
    const offset = Number(url.searchParams.get("after") ?? "0");
    const page = rows.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const next =
      nextOffset < rows.length
        ? (() => {
            const nextUrl = new URL(url.toString());
            nextUrl.searchParams.set("after", String(nextOffset));
            return nextUrl.toString();
          })()
        : undefined;

    return json({ data: page, ...(next ? { paging: { next } } : {}) });
  }

  private insightRows(account: FakeAccount, url: URL): unknown[] {
    const level = url.searchParams.get("level");
    const timeRange = JSON.parse(
      url.searchParams.get("time_range") ?? "{}",
    ) as {
      since?: string;
    };
    const date = timeRange.since ?? "2026-10-05";
    const base = {
      spend: "1.50",
      impressions: "100",
      clicks: "4",
      date_start: date,
      date_stop: date,
    };

    if (level === "campaign") {
      return account.campaigns.map((campaign) => ({
        ...base,
        campaign_id: campaign.id,
      }));
    }

    if (level === "adset") {
      return account.adSets.map((adSet) => ({
        ...base,
        campaign_id: adSet.campaignId,
        adset_id: adSet.id,
      }));
    }

    return account.ads.map((ad) => ({
      ...base,
      campaign_id: ad.campaignId,
      adset_id: ad.adSetId,
      ad_id: ad.id,
    }));
  }

  private handleBatch(body: URLSearchParams): Response {
    const token = body.get("access_token");
    if (token) this.seenAccessTokens.add(token);

    const requests = JSON.parse(body.get("batch") ?? "[]") as Array<{
      method: string;
      relative_url: string;
    }>;
    const parsed = requests.map((request) => {
      const [path] = request.relative_url.split("?");
      const segments = (path ?? "").split("/");

      return segments[1] === "thumbnails"
        ? { kind: "video" as const, key: segments[0] ?? "" }
        : { kind: "creative" as const, key: segments[0] ?? "" };
    });
    const kind: BatchKind = parsed[0]?.kind ?? "creative";

    if (parsed.some((request) => request.kind !== kind)) {
      throw new Error("Fake Graph does not support mixed batches");
    }

    if (requests.length > 50) {
      return json({ error: { message: "Batch limit exceeded", code: 1 } }, 400);
    }

    const index =
      kind === "creative" ? this.creativeBatches : this.videoBatches;

    if (kind === "creative") {
      this.creativeBatches += 1;
      this.creativeSubrequestIds.push(...parsed.map((request) => request.key));
    } else {
      this.videoBatches += 1;
      this.videoSubrequestIds.push(...parsed.map((request) => request.key));
    }

    const fault = this.batchFault(kind, index);

    if (fault?.kind === "network") {
      throw new TypeError("fetch failed");
    }

    if (fault?.kind === "http") {
      return json(
        {
          error: {
            message: "Simulated batch failure",
            code: fault.graphCode ?? (fault.status === 429 ? 4 : 2),
          },
        },
        fault.status,
      );
    }

    return json(
      parsed.map((request) => {
        const itemFault = this.itemFault(kind, request.key);

        if (itemFault?.kind === "null") {
          return null;
        }

        if (itemFault?.kind === "code") {
          return {
            code: itemFault.code,
            body: JSON.stringify({
              error: {
                message: "Simulated item failure",
                code: itemFault.graphCode ?? 2,
              },
            }),
          };
        }

        return kind === "creative"
          ? this.creativeItem(request.key)
          : this.videoItem(request.key);
      }),
    );
  }

  private creativeItem(creativeId: string) {
    const creative = this.creatives.get(creativeId);

    if (!creative) {
      return {
        code: 400,
        body: JSON.stringify({
          error: { message: "Unknown creative", code: 100 },
        }),
      };
    }

    return {
      code: 200,
      body: JSON.stringify({
        id: creative.id,
        ...(creative.imageUrl ? { image_url: creative.imageUrl } : {}),
        ...(creative.videoId ? { video_id: creative.videoId } : {}),
        ...(creative.thumbnailUrl
          ? { thumbnail_url: creative.thumbnailUrl }
          : {}),
      }),
    };
  }

  private videoItem(videoId: string) {
    return {
      code: 200,
      body: JSON.stringify({ data: this.videoThumbnails.get(videoId) ?? [] }),
    };
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
