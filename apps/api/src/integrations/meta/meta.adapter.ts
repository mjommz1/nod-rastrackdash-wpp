import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  MetaAdAccountAssetDto,
  MetaBusinessAssetDto,
  MetaOAuthCallbackResultDto,
  MetaPageAssetDto,
  MetaPixelAssetDto,
} from "@wpptrack/shared";
import {
  RUNTIME_FETCH,
  type RuntimeFetch,
} from "../../common/runtime/runtime.module";
import type {
  IntegrationAdapter,
  IntegrationEnv,
  IntegrationHealthDto,
} from "../integration.types";
import { INTEGRATION_ENV } from "../integration.types";

type MetaTokenResponse = {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
  };
};

type MetaGraphListResponse<T> = {
  data?: T[];
  paging?: {
    next?: unknown;
  };
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
  };
};

type MetaGraphMutationResponse = {
  success?: unknown;
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
  };
};

type MetaGraphObjectResponse = Record<string, unknown> & {
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
  };
};

type MetaPermissionGraphNode = {
  permission?: unknown;
  status?: unknown;
};

export type MetaTokenProfile = {
  id: string;
  name: string;
  scopes: string[];
};

type MetaBusinessGraphNode = {
  id?: unknown;
  name?: unknown;
  verification_status?: unknown;
};

type MetaAdAccountGraphNode = {
  id?: unknown;
  name?: unknown;
  account_status?: unknown;
  currency?: unknown;
  timezone_name?: unknown;
};

type MetaPixelGraphNode = {
  id?: unknown;
  name?: unknown;
};

type MetaPageGraphNode = {
  id?: unknown;
  name?: unknown;
};

export type MetaOAuthTokenExchangeResult = {
  publicResult: MetaOAuthCallbackResultDto;
  accessToken: string | null;
};

export type MetaCampaignAsset = {
  id: string;
  name: string;
  status: string | null;
  effectiveStatus: string | null;
  objective: string | null;
  dailyBudgetCents: number | null;
  lifetimeBudgetCents: number | null;
};

export type MetaAdSetAsset = {
  id: string;
  name: string;
  campaignId: string;
  status: string | null;
  effectiveStatus: string | null;
  destinationType: string | null;
  dailyBudgetCents: number | null;
  lifetimeBudgetCents: number | null;
};

/**
 * How an ad's previewUrl was obtained in this listAds call:
 * - reused: taken from the caller-supplied reusable map, no Graph request
 * - fetched: Graph returned the creative and a preview URL
 * - absent: Graph returned the creative successfully but it has no media
 * - failed: the creative (or its video thumbnails) could not be read; any
 *   previewUrl is only a lower-quality fallback from the creative itself
 * - skipped: the caller asked not to request this creative now (it recently
 *   came back without a usable preview); previewUrl is null, no Graph request
 * - no_creative: the ad has no creative id
 */
export type MetaAdPreviewSource =
  | "reused"
  | "fetched"
  | "absent"
  | "failed"
  | "skipped"
  | "no_creative";

export type MetaAdAsset = {
  id: string;
  name: string;
  campaignId: string;
  adSetId: string;
  status: string | null;
  effectiveStatus: string | null;
  creativeId: string | null;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  previewSource: MetaAdPreviewSource;
  callToActionType: string | null;
  detectedPixelIds: string[];
  detectedPageIds: string[];
};

/**
 * Why a batched Graph sub-request produced no usable item. Only an HTTP 429 or
 * a documented Graph throttling code counts as rateLimited; a null/omitted
 * item is missingItem because Graph does not say why it was dropped.
 */
export type MetaGraphBatchFailureReason =
  | "rateLimited"
  | "serverError"
  | "clientError"
  | "missingItem"
  | "notAttempted"
  | "transportError"
  | "unexpected";

export type MetaPreviewEnrichmentStats = {
  distinctCreatives: number;
  creativesReused: number;
  creativesSkipped: number;
  creativesRequested: number;
  creativesSucceeded: number;
  creativesFailed: number;
  creativesWithoutPreview: number;
  creativeBatchRequests: number;
  videosRequested: number;
  videosSucceeded: number;
  videosFailed: number;
  videoBatchRequests: number;
  failureReasons: Record<MetaGraphBatchFailureReason, number>;
};

export type MetaListAdsInput = {
  accessToken: string;
  adAccountId: string;
  /**
   * creativeId -> preview URL the caller already validated as reusable. Those
   * creatives are not requested from Graph. Callers must scope this map to
   * the same workspace and ad account.
   */
  reusablePreviewUrls?: ReadonlyMap<string, string>;
  /**
   * Creatives not to request from Graph in this call (e.g. they recently came
   * back absent/failed). They are reported with previewSource "skipped".
   */
  skipPreviewCreativeIds?: ReadonlySet<string>;
};

export type MetaCampaignInsight = {
  campaignId: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  metaConversationsStarted: number;
};

export type MetaCampaignDailyInsight = MetaCampaignInsight & {
  date: string;
};

export type MetaAdSetInsight = {
  adSetId: string;
  campaignId: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  metaConversationsStarted: number;
};

export type MetaAdSetDailyInsight = MetaAdSetInsight & {
  date: string;
};

export type MetaAdInsight = {
  adId: string;
  adSetId: string;
  campaignId: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  metaConversationsStarted: number;
};

export type MetaAdDailyInsight = MetaAdInsight & {
  date: string;
};

export type MetaInsightReadMode = "legacy" | "manual";

type MetaCampaignGraphNode = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  effective_status?: unknown;
  objective?: unknown;
  daily_budget?: unknown;
  lifetime_budget?: unknown;
};

type MetaAdSetGraphNode = {
  id?: unknown;
  name?: unknown;
  campaign_id?: unknown;
  status?: unknown;
  effective_status?: unknown;
  destination_type?: unknown;
  daily_budget?: unknown;
  lifetime_budget?: unknown;
};

type MetaCreativeGraphNode = {
  id?: unknown;
  call_to_action_type?: unknown;
  thumbnail_url?: unknown;
  image_url?: unknown;
  video_id?: unknown;
  object_story_spec?: {
    page_id?: unknown;
    video_data?: {
      image_url?: unknown;
      video_id?: unknown;
    };
    link_data?: {
      image_url?: unknown;
      child_attachments?: Array<{
        image_url?: unknown;
        video_id?: unknown;
      }>;
    };
  };
  asset_feed_spec?: {
    images?: Array<{
      url?: unknown;
    }>;
    videos?: Array<{
      thumbnail_url?: unknown;
      video_id?: unknown;
    }>;
  };
};

type MetaAdGraphNode = {
  id?: unknown;
  name?: unknown;
  campaign_id?: unknown;
  adset_id?: unknown;
  status?: unknown;
  effective_status?: unknown;
  creative?: MetaCreativeGraphNode;
  tracking_specs?: unknown;
};

type MetaVideoThumbnailGraphNode = {
  uri?: unknown;
  height?: unknown;
  width?: unknown;
  is_preferred?: unknown;
};

type MetaGraphBatchItem = {
  code?: unknown;
  body?: unknown;
};

type MetaGraphBatchResult<T> = {
  results: Map<string, T>;
  failures: Map<string, MetaGraphBatchFailureReason>;
  batchRequests: number;
  /** A whole batch request failed and the remaining chunks were skipped. */
  aborted: boolean;
};

type MetaCreativePreview = {
  status: "fetched" | "absent" | "failed";
  url: string | null;
};

// HTTP 429 plus Graph throttling codes (app, user, page, custom, ads BUC).
const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const META_ADS_RATE_LIMIT_CODE_RANGE = [80000, 80014] as const;
const META_GRAPH_BATCH_SIZE = 50;

type MetaInsightGraphNode = {
  campaign_id?: unknown;
  adset_id?: unknown;
  ad_id?: unknown;
  spend?: unknown;
  impressions?: unknown;
  clicks?: unknown;
  date_start?: unknown;
  date_stop?: unknown;
  actions?: Array<{
    action_type?: unknown;
    value?: unknown;
  }>;
};

@Injectable()
export class MetaAdapter implements IntegrationAdapter {
  readonly provider = "meta" as const;

  constructor(
    @Inject(INTEGRATION_ENV) private readonly env: IntegrationEnv = process.env,
    @Optional()
    @Inject(RUNTIME_FETCH)
    private readonly fetchImpl: RuntimeFetch = fetch,
  ) {}

  async getHealth(): Promise<IntegrationHealthDto> {
    const hasCredentials = Boolean(
      this.env.META_APP_ID && this.env.META_APP_SECRET,
    );

    return {
      provider: this.provider,
      status: hasCredentials ? "connected" : "disconnected",
      checkedAt: new Date().toISOString(),
      message: hasCredentials
        ? undefined
        : "Missing META_APP_ID or META_APP_SECRET",
    };
  }

  getOAuthAuthorizationUrl(state?: string): string {
    const params = new URLSearchParams({
      client_id: this.env.META_APP_ID ?? "",
      redirect_uri: this.env.META_OAUTH_REDIRECT_URL ?? "",
      scope: this.getScopes().join(","),
      response_type: "code",
    });

    if (state) {
      params.set("state", state);
    }

    return `https://www.facebook.com/${this.getGraphApiVersion()}/dialog/oauth?${params.toString()}`;
  }

  async exchangeCode(input: {
    code: string;
  }): Promise<MetaOAuthCallbackResultDto> {
    const result = await this.exchangeCodeForToken(input);

    return result.publicResult;
  }

  async exchangeCodeForToken(input: {
    code: string;
  }): Promise<MetaOAuthTokenExchangeResult> {
    const missingEnv = this.missingEnv([
      "META_APP_ID",
      "META_APP_SECRET",
      "META_OAUTH_REDIRECT_URL",
    ]);

    if (missingEnv.length > 0) {
      return {
        accessToken: null,
        publicResult: {
          provider: "meta",
          status: "configure_env",
          tokenType: null,
          expiresInSeconds: null,
          scopes: [],
          missingEnv,
          message: `Missing ${missingEnv.join(", ")}`,
        },
      };
    }

    const params = new URLSearchParams({
      client_id: this.env.META_APP_ID ?? "",
      redirect_uri: this.env.META_OAUTH_REDIRECT_URL ?? "",
      client_secret: this.env.META_APP_SECRET ?? "",
      code: input.code,
    });

    try {
      const response = await this.fetchImpl(
        `https://graph.facebook.com/${this.getGraphApiVersion()}/oauth/access_token?${params.toString()}`,
      );
      const payload = (await response
        .json()
        .catch(() => ({}))) as MetaTokenResponse;
      const shortLivedAccessToken = this.asString(payload.access_token);

      if (!response.ok || !shortLivedAccessToken) {
        return {
          accessToken: null,
          publicResult: {
            provider: "meta",
            status: "exchange_failed",
            tokenType: null,
            expiresInSeconds: null,
            scopes: [],
            missingEnv: [],
            message:
              this.asString(payload.error?.message) ??
              `Meta OAuth HTTP ${response.status}`,
          },
        };
      }

      const extendedToken = await this.exchangeForLongLivedToken(
        shortLivedAccessToken,
      );

      return {
        accessToken: extendedToken.accessToken,
        publicResult: {
          provider: "meta",
          status: "connected",
          tokenType:
            extendedToken.tokenType ??
            this.asString(payload.token_type) ??
            "bearer",
          expiresInSeconds:
            extendedToken.expiresInSeconds ??
            this.asPositiveInteger(payload.expires_in),
          scopes: this.getScopes(),
          missingEnv: [],
          message: "Meta OAuth conectado",
        },
      };
    } catch (error) {
      return {
        accessToken: null,
        publicResult: {
          provider: "meta",
          status: "exchange_failed",
          tokenType: null,
          expiresInSeconds: null,
          scopes: [],
          missingEnv: [],
          message:
            error instanceof Error ? error.message : "Erro ao trocar code Meta",
        },
      };
    }
  }

  private async exchangeForLongLivedToken(
    shortLivedAccessToken: string,
  ): Promise<{
    accessToken: string;
    tokenType: string | null;
    expiresInSeconds: number | null;
  }> {
    const params = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: this.env.META_APP_ID ?? "",
      client_secret: this.env.META_APP_SECRET ?? "",
      fb_exchange_token: shortLivedAccessToken,
    });
    const response = await this.fetchImpl(
      `https://graph.facebook.com/${this.getGraphApiVersion()}/oauth/access_token?${params.toString()}`,
    );
    const payload = (await response
      .json()
      .catch(() => ({}))) as MetaTokenResponse;
    const accessToken = this.asString(payload.access_token);

    if (!response.ok || !accessToken) {
      throw new Error(
        this.asString(payload.error?.message) ??
          `Meta long-lived token HTTP ${response.status}`,
      );
    }

    return {
      accessToken,
      tokenType: this.asString(payload.token_type),
      expiresInSeconds: this.asPositiveInteger(payload.expires_in),
    };
  }

  async listBusinesses(input: {
    accessToken: string;
  }): Promise<MetaBusinessAssetDto[]> {
    const response = await this.getGraphList<MetaBusinessGraphNode>(
      "/me/businesses",
      "id,name,verification_status",
      input.accessToken,
    );

    return response
      .map((item) => ({
        id: this.asString(item.id),
        name: this.asString(item.name),
        verificationStatus: this.asString(item.verification_status),
      }))
      .filter((item): item is MetaBusinessAssetDto =>
        Boolean(item.id && item.name),
      );
  }

  async getTokenProfile(input: {
    accessToken: string;
  }): Promise<MetaTokenProfile> {
    const [profile, permissions] = await Promise.all([
      this.getGraphObject<MetaGraphObjectResponse>(
        "/me",
        "id,name",
        input.accessToken,
      ),
      this.getGraphList<MetaPermissionGraphNode>(
        "/me/permissions",
        "permission,status",
        input.accessToken,
      ).catch(() => []),
    ]);
    const id = this.asString(profile.id);
    const name = this.asString(profile.name) ?? "Usuario do sistema Meta";

    if (!id) {
      throw new Error("A Meta nao confirmou a identidade deste token");
    }

    return {
      id,
      name,
      scopes: permissions
        .filter(
          (permission) =>
            this.asString(permission.status)?.toLowerCase() === "granted",
        )
        .map((permission) => this.asString(permission.permission))
        .filter((permission): permission is string => Boolean(permission)),
    };
  }

  async getBusiness(input: {
    accessToken: string;
    businessId: string;
  }): Promise<MetaBusinessAssetDto> {
    const item = await this.getGraphObject<MetaBusinessGraphNode>(
      `/${input.businessId}`,
      "id,name,verification_status",
      input.accessToken,
    );
    const id = this.asString(item.id);
    const name = this.asString(item.name);

    if (!id || !name) {
      throw new Error("A Meta nao confirmou o Business Manager informado");
    }

    return {
      id,
      name,
      verificationStatus: this.asString(item.verification_status),
    };
  }

  async getAdAccount(input: {
    accessToken: string;
    adAccountId: string;
    businessId?: string | null;
  }): Promise<MetaAdAccountAssetDto> {
    const item = await this.getGraphObject<MetaAdAccountGraphNode>(
      `/${input.adAccountId}`,
      "id,name,account_status,currency,timezone_name",
      input.accessToken,
    );
    const id = this.asString(item.id);
    const name = this.asString(item.name);

    if (!id || !name) {
      throw new Error("A Meta nao confirmou a conta de anuncios informada");
    }

    return {
      id,
      businessId: input.businessId ?? null,
      name,
      accountStatus: this.asString(item.account_status),
      currency: this.asString(item.currency),
      timezoneName: this.asString(item.timezone_name),
    };
  }

  async getPixel(input: {
    accessToken: string;
    pixelId: string;
    businessId?: string | null;
  }): Promise<MetaPixelAssetDto> {
    const item = await this.getGraphObject<MetaPixelGraphNode>(
      `/${input.pixelId}`,
      "id,name",
      input.accessToken,
    );
    const id = this.asString(item.id);
    const name = this.asString(item.name);

    if (!id || !name) {
      throw new Error("A Meta nao confirmou o Pixel/Dataset informado");
    }

    return {
      id,
      businessId: input.businessId ?? null,
      name,
      code: null,
    };
  }

  async getPage(input: {
    accessToken: string;
    pageId: string;
    businessId?: string | null;
  }): Promise<MetaPageAssetDto> {
    const item = await this.getGraphObject<MetaPageGraphNode>(
      `/${input.pageId}`,
      "id,name",
      input.accessToken,
    );
    const id = this.asString(item.id);
    const name = this.asString(item.name);

    if (!id || !name) {
      throw new Error("A Meta nao confirmou a Pagina informada");
    }

    return {
      id,
      businessId: input.businessId ?? null,
      name,
    };
  }

  async listOwnedAdAccounts(input: {
    accessToken: string;
    businessId: string;
  }): Promise<MetaAdAccountAssetDto[]> {
    const response = await this.getGraphList<MetaAdAccountGraphNode>(
      `/${input.businessId}/owned_ad_accounts`,
      "id,name,account_status,currency,timezone_name",
      input.accessToken,
    );

    return response
      .map((item) => ({
        id: this.asString(item.id),
        businessId: input.businessId as string | null,
        name: this.asString(item.name),
        accountStatus: this.asString(item.account_status),
        currency: this.asString(item.currency),
        timezoneName: this.asString(item.timezone_name),
      }))
      .filter((item): item is MetaAdAccountAssetDto =>
        Boolean(item.id && item.name),
      );
  }

  async listBusinessPixels(input: {
    accessToken: string;
    businessId: string;
  }): Promise<MetaPixelAssetDto[]> {
    const response = await this.getGraphList<MetaPixelGraphNode>(
      `/${input.businessId}/adspixels`,
      "id,name",
      input.accessToken,
    );

    return response
      .map((item): MetaPixelAssetDto | null => {
        const id = this.asString(item.id);
        const name = this.asString(item.name);

        if (!id || !name) {
          return null;
        }

        return {
          id,
          businessId: input.businessId,
          name,
          code: null,
        };
      })
      .filter((item): item is MetaPixelAssetDto => Boolean(item));
  }

  async listAdAccountPixels(input: {
    accessToken: string;
    adAccountId: string;
  }): Promise<MetaPixelAssetDto[]> {
    const response = await this.getGraphList<MetaPixelGraphNode>(
      `/${input.adAccountId}/adspixels`,
      "id,name",
      input.accessToken,
    );

    return response
      .map((item): MetaPixelAssetDto | null => {
        const id = this.asString(item.id);
        const name = this.asString(item.name);

        if (!id || !name) {
          return null;
        }

        return {
          id,
          businessId: null,
          name,
          code: null,
        };
      })
      .filter((item): item is MetaPixelAssetDto => Boolean(item));
  }

  async listPages(input: { accessToken: string }): Promise<MetaPageAssetDto[]> {
    const response = await this.getGraphList<MetaPageGraphNode>(
      "/me/accounts",
      "id,name",
      input.accessToken,
    );

    return response
      .map((item): MetaPageAssetDto | null => {
        const id = this.asString(item.id);
        const name = this.asString(item.name);

        if (!id || !name) {
          return null;
        }

        return {
          id,
          businessId: null,
          name,
        };
      })
      .filter((item): item is MetaPageAssetDto => Boolean(item));
  }

  async listBusinessPages(input: {
    accessToken: string;
    businessId: string;
  }): Promise<MetaPageAssetDto[]> {
    const [ownedPages, clientPages] = await Promise.all([
      this.getGraphList<MetaPageGraphNode>(
        `/${input.businessId}/owned_pages`,
        "id,name",
        input.accessToken,
      ),
      this.getGraphList<MetaPageGraphNode>(
        `/${input.businessId}/client_pages`,
        "id,name",
        input.accessToken,
      ),
    ]);
    const pagesById = new Map<string, MetaPageAssetDto>();

    for (const item of [...ownedPages, ...clientPages]) {
      const id = this.asString(item.id);
      const name = this.asString(item.name);

      if (!id || !name || pagesById.has(id)) {
        continue;
      }

      pagesById.set(id, {
        id,
        businessId: input.businessId,
        name,
      });
    }

    return [...pagesById.values()];
  }

  async listCampaigns(input: {
    accessToken: string;
    adAccountId: string;
  }): Promise<MetaCampaignAsset[]> {
    const response = await this.getGraphList<MetaCampaignGraphNode>(
      `/${input.adAccountId}/campaigns`,
      "id,name,status,effective_status,objective,daily_budget,lifetime_budget",
      input.accessToken,
    );

    return response
      .map((item) => ({
        id: this.asString(item.id),
        name: this.asString(item.name),
        status: this.asString(item.status),
        effectiveStatus: this.asString(item.effective_status),
        objective: this.asString(item.objective),
        dailyBudgetCents: this.asMinorCurrencyUnit(item.daily_budget),
        lifetimeBudgetCents: this.asMinorCurrencyUnit(item.lifetime_budget),
      }))
      .filter((item): item is MetaCampaignAsset =>
        Boolean(item.id && item.name),
      );
  }

  async listAdSets(input: {
    accessToken: string;
    adAccountId: string;
  }): Promise<MetaAdSetAsset[]> {
    const response = await this.getGraphList<MetaAdSetGraphNode>(
      `/${input.adAccountId}/adsets`,
      "id,name,campaign_id,status,effective_status,destination_type,daily_budget,lifetime_budget",
      input.accessToken,
    );

    return response
      .map((item) => ({
        id: this.asString(item.id),
        name: this.asString(item.name),
        campaignId: this.asString(item.campaign_id),
        status: this.asString(item.status),
        effectiveStatus: this.asString(item.effective_status),
        destinationType: this.asString(item.destination_type),
        dailyBudgetCents: this.asMinorCurrencyUnit(item.daily_budget),
        lifetimeBudgetCents: this.asMinorCurrencyUnit(item.lifetime_budget),
      }))
      .filter((item): item is MetaAdSetAsset =>
        Boolean(item.id && item.name && item.campaignId),
      );
  }

  async listAds(input: MetaListAdsInput): Promise<MetaAdAsset[]> {
    return (await this.listAdsWithPreviewStats(input)).ads;
  }

  async listAdsWithPreviewStats(input: MetaListAdsInput): Promise<{
    ads: MetaAdAsset[];
    previewStats: MetaPreviewEnrichmentStats;
  }> {
    let response: MetaAdGraphNode[];

    try {
      response = await this.getGraphList<MetaAdGraphNode>(
        `/${input.adAccountId}/ads`,
        "id,name,campaign_id,adset_id,status,effective_status,tracking_specs,creative{id,call_to_action_type,thumbnail_url,object_story_spec}",
        input.accessToken,
      );
    } catch (error) {
      console.warn("[wpptrack:meta-graph] ad destination enrichment failed", {
        adAccountId: input.adAccountId,
        message:
          error instanceof Error ? error.message : "Meta Graph request failed",
      });
      try {
        response = await this.getGraphList<MetaAdGraphNode>(
          `/${input.adAccountId}/ads`,
          "id,name,campaign_id,adset_id,status,effective_status,tracking_specs,creative{id,call_to_action_type,thumbnail_url}",
          input.accessToken,
        );
      } catch {
        response = await this.getGraphList<MetaAdGraphNode>(
          `/${input.adAccountId}/ads`,
          "id,name,campaign_id,adset_id,status,effective_status,creative{id,call_to_action_type,thumbnail_url}",
          input.accessToken,
        );
      }
    }
    const creativeIds = [
      ...new Set(
        response
          .map((item) => this.asString(item.creative?.id))
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const reusedPreviewUrls = new Map<string, string>();
    const skippedCreativeIds = new Set<string>();
    const creativeIdsToRequest: string[] = [];

    for (const creativeId of creativeIds) {
      const reusableUrl = this.asHttpUrl(
        input.reusablePreviewUrls?.get(creativeId),
      );

      if (reusableUrl) {
        reusedPreviewUrls.set(creativeId, reusableUrl);
      } else if (input.skipPreviewCreativeIds?.has(creativeId)) {
        skippedCreativeIds.add(creativeId);
      } else {
        creativeIdsToRequest.push(creativeId);
      }
    }

    const previewStats = this.emptyPreviewStats();
    previewStats.distinctCreatives = creativeIds.length;
    previewStats.creativesReused = reusedPreviewUrls.size;
    previewStats.creativesSkipped = skippedCreativeIds.size;
    previewStats.creativesRequested = creativeIdsToRequest.length;
    let previews: Map<string, MetaCreativePreview>;

    try {
      previews = await this.getCreativePreviews(
        creativeIdsToRequest,
        input.accessToken,
        previewStats,
      );
    } catch {
      // Media enrichment must never abort structure/metrics sync.
      previews = new Map(
        creativeIdsToRequest.map((creativeId) => [
          creativeId,
          { status: "failed", url: null },
        ]),
      );
      previewStats.creativesSucceeded = 0;
      previewStats.creativesWithoutPreview = 0;
      previewStats.creativesFailed = creativeIdsToRequest.length;
      previewStats.failureReasons.unexpected += creativeIdsToRequest.length;
      console.warn("[wpptrack:meta-graph] creative preview enrichment failed", {
        creativeCount: creativeIdsToRequest.length,
      });
    }

    const ads = response
      .map((item) => {
        const creativeId = this.asString(item.creative?.id);
        const destinationHints = this.adDestinationHints(item);
        const reusedUrl = creativeId ? reusedPreviewUrls.get(creativeId) : null;
        const preview = creativeId ? previews.get(creativeId) : null;
        const previewSource: MetaAdPreviewSource = !creativeId
          ? "no_creative"
          : reusedUrl
            ? "reused"
            : skippedCreativeIds.has(creativeId)
              ? "skipped"
              : (preview?.status ?? "failed");

        return {
          id: this.asString(item.id),
          name: this.asString(item.name),
          campaignId: this.asString(item.campaign_id),
          adSetId: this.asString(item.adset_id),
          status: this.asString(item.status),
          effectiveStatus: this.asString(item.effective_status),
          creativeId,
          thumbnailUrl: this.asHttpUrl(item.creative?.thumbnail_url),
          previewUrl: reusedUrl ?? preview?.url ?? null,
          previewSource,
          callToActionType: this.asString(item.creative?.call_to_action_type),
          detectedPixelIds: destinationHints.pixelIds,
          detectedPageIds: destinationHints.pageIds,
        };
      })
      .filter((item): item is MetaAdAsset =>
        Boolean(item.id && item.name && item.campaignId && item.adSetId),
      );

    return { ads, previewStats };
  }

  async updateEntityStatus(input: {
    accessToken: string;
    id: string;
    status: "ACTIVE" | "PAUSED";
  }): Promise<void> {
    await this.postGraphUpdate(input.id, input.accessToken, {
      status: input.status,
    });
  }

  async updateEntityBudget(input: {
    accessToken: string;
    id: string;
    budgetType: "daily" | "lifetime";
    budgetCents: number;
  }): Promise<void> {
    await this.postGraphUpdate(input.id, input.accessToken, {
      [input.budgetType === "daily" ? "daily_budget" : "lifetime_budget"]:
        String(input.budgetCents),
    });
  }

  async listCampaignInsights(input: {
    accessToken: string;
    adAccountId: string;
    since: string;
    until: string;
    readMode?: MetaInsightReadMode;
  }): Promise<MetaCampaignInsight[]> {
    const payload = await this.listInsights({
      ...input,
      fields: "campaign_id,spend,impressions,clicks,actions",
      level: "campaign",
    });

    return payload
      .map((item) => ({
        campaignId: this.asString(item.campaign_id),
        spendCents: this.asMoneyCents(item.spend),
        impressions: this.asInteger(item.impressions),
        clicks: this.asInteger(item.clicks),
        metaConversationsStarted: this.messagingConversationStarted(
          item.actions,
          input.readMode,
        ),
      }))
      .filter((item): item is MetaCampaignInsight => Boolean(item.campaignId));
  }

  async listCampaignDailyInsights(input: {
    accessToken: string;
    adAccountId: string;
    since: string;
    until: string;
    readMode?: MetaInsightReadMode;
  }): Promise<MetaCampaignDailyInsight[]> {
    const payload = await this.listInsights({
      ...input,
      fields:
        "campaign_id,date_start,date_stop,spend,impressions,clicks,actions",
      level: "campaign",
      timeIncrement: 1,
    });

    return payload
      .map((item) => ({
        campaignId: this.asString(item.campaign_id),
        date: this.asString(item.date_start),
        spendCents: this.asMoneyCents(item.spend),
        impressions: this.asInteger(item.impressions),
        clicks: this.asInteger(item.clicks),
        metaConversationsStarted: this.messagingConversationStarted(
          item.actions,
          input.readMode,
        ),
      }))
      .filter((item): item is MetaCampaignDailyInsight =>
        Boolean(item.campaignId && item.date),
      );
  }

  async listAdSetInsights(input: {
    accessToken: string;
    adAccountId: string;
    since: string;
    until: string;
    readMode?: MetaInsightReadMode;
  }): Promise<MetaAdSetInsight[]> {
    const payload = await this.listInsights({
      ...input,
      fields: "campaign_id,adset_id,spend,impressions,clicks,actions",
      level: "adset",
    });

    return payload
      .map((item) => ({
        adSetId: this.asString(item.adset_id),
        campaignId: this.asString(item.campaign_id),
        spendCents: this.asMoneyCents(item.spend),
        impressions: this.asInteger(item.impressions),
        clicks: this.asInteger(item.clicks),
        metaConversationsStarted: this.messagingConversationStarted(
          item.actions,
          input.readMode,
        ),
      }))
      .filter((item): item is MetaAdSetInsight =>
        Boolean(item.adSetId && item.campaignId),
      );
  }

  async listAdSetDailyInsights(input: {
    accessToken: string;
    adAccountId: string;
    since: string;
    until: string;
    readMode?: MetaInsightReadMode;
  }): Promise<MetaAdSetDailyInsight[]> {
    const payload = await this.listInsights({
      ...input,
      fields:
        "campaign_id,adset_id,date_start,date_stop,spend,impressions,clicks,actions",
      level: "adset",
      timeIncrement: 1,
    });

    return payload
      .map((item) => ({
        adSetId: this.asString(item.adset_id),
        campaignId: this.asString(item.campaign_id),
        date: this.asString(item.date_start),
        spendCents: this.asMoneyCents(item.spend),
        impressions: this.asInteger(item.impressions),
        clicks: this.asInteger(item.clicks),
        metaConversationsStarted: this.messagingConversationStarted(
          item.actions,
          input.readMode,
        ),
      }))
      .filter((item): item is MetaAdSetDailyInsight =>
        Boolean(item.adSetId && item.campaignId && item.date),
      );
  }

  async listAdInsights(input: {
    accessToken: string;
    adAccountId: string;
    since: string;
    until: string;
    readMode?: MetaInsightReadMode;
  }): Promise<MetaAdInsight[]> {
    const payload = await this.listInsights({
      ...input,
      fields: "campaign_id,adset_id,ad_id,spend,impressions,clicks,actions",
      level: "ad",
    });

    return payload
      .map((item) => ({
        adId: this.asString(item.ad_id),
        adSetId: this.asString(item.adset_id),
        campaignId: this.asString(item.campaign_id),
        spendCents: this.asMoneyCents(item.spend),
        impressions: this.asInteger(item.impressions),
        clicks: this.asInteger(item.clicks),
        metaConversationsStarted: this.messagingConversationStarted(
          item.actions,
          input.readMode,
        ),
      }))
      .filter((item): item is MetaAdInsight =>
        Boolean(item.adId && item.adSetId && item.campaignId),
      );
  }

  async listAdDailyInsights(input: {
    accessToken: string;
    adAccountId: string;
    since: string;
    until: string;
    readMode?: MetaInsightReadMode;
  }): Promise<MetaAdDailyInsight[]> {
    const payload = await this.listInsights({
      ...input,
      fields:
        "campaign_id,adset_id,ad_id,date_start,date_stop,spend,impressions,clicks,actions",
      level: "ad",
      timeIncrement: 1,
    });

    return payload
      .map((item) => ({
        adId: this.asString(item.ad_id),
        adSetId: this.asString(item.adset_id),
        campaignId: this.asString(item.campaign_id),
        date: this.asString(item.date_start),
        spendCents: this.asMoneyCents(item.spend),
        impressions: this.asInteger(item.impressions),
        clicks: this.asInteger(item.clicks),
        metaConversationsStarted: this.messagingConversationStarted(
          item.actions,
          input.readMode,
        ),
      }))
      .filter((item): item is MetaAdDailyInsight =>
        Boolean(item.adId && item.adSetId && item.campaignId && item.date),
      );
  }

  private getGraphApiVersion(): string {
    return this.env.META_GRAPH_API_VERSION ?? "v21.0";
  }

  private getScopes(): string[] {
    return (
      this.env.META_OAUTH_SCOPES ??
      "ads_read,ads_management,business_management,pages_show_list,pages_read_engagement"
    )
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
  }

  private missingEnv(keys: string[]): string[] {
    return keys.filter((key) => !this.env[key]);
  }

  private asString(value: unknown): string | null {
    if (typeof value === "string" && value.trim()) {
      return value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }

    return null;
  }

  private asHttpUrl(value: unknown): string | null {
    const candidate = this.asString(value);

    if (!candidate) {
      return null;
    }

    try {
      const url = new URL(candidate);
      return url.protocol === "http:" || url.protocol === "https:"
        ? candidate
        : null;
    } catch {
      return null;
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private adDestinationHints(item: MetaAdGraphNode): {
    pixelIds: string[];
    pageIds: string[];
  } {
    const pixelIds = new Set<string>();
    const pageIds = new Set<string>();
    const creativePageId = this.asString(
      item.creative?.object_story_spec?.page_id,
    );

    if (creativePageId) {
      pageIds.add(creativePageId);
    }

    const visit = (value: unknown, depth: number): void => {
      if (depth > 8 || value === null || value === undefined) {
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((entry) => visit(entry, depth + 1));
        return;
      }

      const record = this.asRecord(value);
      if (!record) {
        return;
      }

      for (const [key, nested] of Object.entries(record)) {
        const normalizedKey = key.toLowerCase();

        if (normalizedKey === "dataset" || normalizedKey === "fb_pixel") {
          this.collectGraphIdentifiers(nested, pixelIds, depth + 1);
        } else if (normalizedKey === "page" || normalizedKey === "page_id") {
          this.collectGraphIdentifiers(nested, pageIds, depth + 1);
        } else {
          visit(nested, depth + 1);
        }
      }
    };

    visit(item.tracking_specs, 0);

    return {
      pixelIds: [...pixelIds],
      pageIds: [...pageIds],
    };
  }

  private collectGraphIdentifiers(
    value: unknown,
    target: Set<string>,
    depth: number,
  ): void {
    if (depth > 8 || value === null || value === undefined) {
      return;
    }

    const identifier = this.asString(value);
    if (identifier) {
      target.add(identifier);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) =>
        this.collectGraphIdentifiers(entry, target, depth + 1),
      );
      return;
    }

    const record = this.asRecord(value);
    if (record) {
      Object.values(record).forEach((entry) =>
        this.collectGraphIdentifiers(entry, target, depth + 1),
      );
    }
  }

  private asPositiveInteger(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value > 0
      ? value
      : null;
  }

  private asInteger(value: unknown): number {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : 0;

    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }

  private asMoneyCents(value: unknown): number {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : 0;

    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  }

  private asMinorCurrencyUnit(value: unknown): number | null {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
          ? Number(value)
          : Number.NaN;

    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  private actionValue(
    actions: MetaInsightGraphNode["actions"],
    actionType: string,
  ): number {
    const action = actions?.find(
      (item) => this.asString(item.action_type) === actionType,
    );

    return this.asInteger(action?.value);
  }

  private messagingConversationStarted(
    actions: MetaInsightGraphNode["actions"],
    readMode: MetaInsightReadMode = "legacy",
  ): number {
    const legacyValue = this.actionValue(
      actions,
      "onsite_conversion.messaging_conversation_started_7d",
    );

    if (readMode === "legacy") {
      return legacyValue;
    }

    const compatibleValues = (actions ?? [])
      .filter((action) =>
        this.asString(action.action_type)
          ?.toLowerCase()
          .includes("messaging_conversation_started"),
      )
      .map((action) => this.asInteger(action.value));

    return Math.max(legacyValue, ...compatibleValues, 0);
  }

  private async listInsights(input: {
    accessToken: string;
    adAccountId: string;
    fields: string;
    level: "campaign" | "adset" | "ad";
    since: string;
    until: string;
    timeIncrement?: number;
    readMode?: MetaInsightReadMode;
  }): Promise<MetaInsightGraphNode[]> {
    const params = new URLSearchParams({
      fields: input.fields,
      level: input.level,
      limit: "100",
      time_range: JSON.stringify({
        since: input.since,
        until: input.until,
      }),
      access_token: input.accessToken,
    });

    if (input.timeIncrement) {
      params.set("time_increment", String(input.timeIncrement));
    }

    if (input.readMode === "manual") {
      params.set("action_breakdowns", "action_type");
      params.set("action_report_time", "conversion");
      params.set("use_unified_attribution_setting", "true");
    }
    const initialUrl = `https://graph.facebook.com/${this.getGraphApiVersion()}/${input.adAccountId}/insights?${params.toString()}`;

    return this.getGraphPages<MetaInsightGraphNode>(
      initialUrl,
      `/${input.adAccountId}/insights?level=${input.level}`,
    );
  }

  private async getGraphList<T>(
    path: string,
    fields: string,
    accessToken: string,
  ): Promise<T[]> {
    const params = new URLSearchParams({
      fields,
      limit: "100",
      access_token: accessToken,
    });
    const initialUrl = `https://graph.facebook.com/${this.getGraphApiVersion()}${path}?${params.toString()}`;

    return this.getGraphPages<T>(initialUrl, path);
  }

  private async getGraphObject<T>(
    path: string,
    fields: string,
    accessToken: string,
  ): Promise<T> {
    const params = new URLSearchParams({ fields, access_token: accessToken });
    const response = await this.fetchImpl(
      `https://graph.facebook.com/${this.getGraphApiVersion()}${path}?${params.toString()}`,
    );
    const payload = (await response
      .json()
      .catch(() => ({}))) as MetaGraphObjectResponse;

    if (!response.ok) {
      throw new Error(
        this.asString(payload.error?.message) ??
          `Meta Graph HTTP ${response.status}`,
      );
    }

    return payload as T;
  }

  /** Opt-in only: exact string "true" in META_VIDEO_THUMBNAILS_ENABLED. */
  private videoThumbnailsEnabled(): boolean {
    return this.env.META_VIDEO_THUMBNAILS_ENABLED?.trim() === "true";
  }

  private emptyPreviewStats(): MetaPreviewEnrichmentStats {
    return {
      distinctCreatives: 0,
      creativesReused: 0,
      creativesSkipped: 0,
      creativesRequested: 0,
      creativesSucceeded: 0,
      creativesFailed: 0,
      creativesWithoutPreview: 0,
      creativeBatchRequests: 0,
      videosRequested: 0,
      videosSucceeded: 0,
      videosFailed: 0,
      videoBatchRequests: 0,
      failureReasons: {
        rateLimited: 0,
        serverError: 0,
        clientError: 0,
        missingItem: 0,
        notAttempted: 0,
        transportError: 0,
        unexpected: 0,
      },
    };
  }

  private async getCreativePreviews(
    creativeIds: string[],
    accessToken: string,
    stats: MetaPreviewEnrichmentStats,
  ): Promise<Map<string, MetaCreativePreview>> {
    if (creativeIds.length === 0) {
      return new Map();
    }

    const creativeFields = [
      "id",
      "thumbnail_url",
      "image_url",
      "video_id",
      "object_story_spec",
      "asset_feed_spec",
    ].join(",");
    const creatives = await this.getGraphBatch<MetaCreativeGraphNode>(
      creativeIds.map((creativeId) => {
        const params = new URLSearchParams({
          fields: creativeFields,
          thumbnail_width: "1200",
          thumbnail_height: "1200",
        });

        return {
          key: creativeId,
          relativeUrl: `${creativeId}?${params.toString()}`,
        };
      }),
      accessToken,
      "/creative-previews",
    );
    stats.creativeBatchRequests = creatives.batchRequests;
    stats.creativesSucceeded = creatives.results.size;
    stats.creativesFailed = creatives.failures.size;
    this.countBatchFailures(stats, creatives.failures);

    // GET /{video}/thumbnails costs one extra Graph call per video creative
    // and is disabled by default: installations share the app-level rate
    // limit of the PalmUP Meta app. The creative's own image_url /
    // thumbnail_url (already in this batch) is used as the preview instead.
    const videoIds = this.videoThumbnailsEnabled()
      ? [
          ...new Set(
            [...creatives.results.values()]
              .map((creative) => this.creativeVideoId(creative))
              .filter((videoId): videoId is string => Boolean(videoId)),
          ),
        ]
      : [];
    // After a batch-level failure (e.g. throttling) stop issuing preview
    // requests for this sync instead of immediately hitting Graph again.
    const videoThumbnails: MetaGraphBatchResult<
      MetaGraphListResponse<MetaVideoThumbnailGraphNode>
    > = creatives.aborted
      ? {
          results: new Map(),
          failures: new Map(
            videoIds.map((videoId) => [videoId, "notAttempted"]),
          ),
          batchRequests: 0,
          aborted: true,
        }
      : await this.getGraphBatch<
          MetaGraphListResponse<MetaVideoThumbnailGraphNode>
        >(
          videoIds.map((videoId) => {
            const params = new URLSearchParams({
              fields: "uri,width,height,is_preferred",
              limit: "100",
            });

            return {
              key: videoId,
              relativeUrl: `${videoId}/thumbnails?${params.toString()}`,
            };
          }),
          accessToken,
          "/video-thumbnails",
        );
    stats.videosRequested = videoIds.length;
    stats.videoBatchRequests = videoThumbnails.batchRequests;
    stats.videosSucceeded = videoThumbnails.results.size;
    stats.videosFailed = videoThumbnails.failures.size;
    this.countBatchFailures(stats, videoThumbnails.failures);

    const videoPreviewUrls = new Map<string, string>();

    for (const [videoId, payload] of videoThumbnails.results) {
      const thumbnailUrl = this.largestVideoThumbnailUrl(payload.data);

      if (thumbnailUrl) {
        videoPreviewUrls.set(videoId, thumbnailUrl);
      }
    }

    const previews = new Map<string, MetaCreativePreview>();

    for (const creativeId of creativeIds) {
      const creative = creatives.results.get(creativeId);

      if (!creative) {
        previews.set(creativeId, { status: "failed", url: null });
        continue;
      }

      const videoId = this.creativeVideoId(creative);
      const url = this.creativePreviewUrl(creative, videoPreviewUrls);

      if (videoId && videoThumbnails.failures.has(videoId)) {
        // The creative image is only a lower-quality fallback here.
        previews.set(creativeId, { status: "failed", url });
      } else if (url) {
        previews.set(creativeId, { status: "fetched", url });
      } else {
        stats.creativesWithoutPreview += 1;
        previews.set(creativeId, { status: "absent", url: null });
      }
    }

    return previews;
  }

  private countBatchFailures(
    stats: MetaPreviewEnrichmentStats,
    failures: Map<string, MetaGraphBatchFailureReason>,
  ): void {
    for (const reason of failures.values()) {
      stats.failureReasons[reason] += 1;
    }
  }

  private creativePreviewUrl(
    creative: MetaCreativeGraphNode,
    videoPreviewUrls: Map<string, string>,
  ): string | null {
    const videoId = this.creativeVideoId(creative);
    const videoPreviewUrl = videoId ? videoPreviewUrls.get(videoId) : null;

    if (videoPreviewUrl) {
      return videoPreviewUrl;
    }

    const candidates = [
      creative.image_url,
      creative.object_story_spec?.video_data?.image_url,
      creative.object_story_spec?.link_data?.image_url,
      ...(creative.object_story_spec?.link_data?.child_attachments ?? []).map(
        (attachment) => attachment.image_url,
      ),
      ...(creative.asset_feed_spec?.images ?? []).map((image) => image.url),
      ...(creative.asset_feed_spec?.videos ?? []).map(
        (video) => video.thumbnail_url,
      ),
      creative.thumbnail_url,
    ];

    for (const candidate of candidates) {
      const url = this.asHttpUrl(candidate);

      if (url) {
        return url;
      }
    }

    return null;
  }

  private creativeVideoId(creative: MetaCreativeGraphNode): string | null {
    const candidates = [
      creative.video_id,
      creative.object_story_spec?.video_data?.video_id,
      ...(creative.object_story_spec?.link_data?.child_attachments ?? []).map(
        (attachment) => attachment.video_id,
      ),
      ...(creative.asset_feed_spec?.videos ?? []).map(
        (video) => video.video_id,
      ),
    ];

    for (const candidate of candidates) {
      const videoId = this.asString(candidate);

      if (videoId) {
        return videoId;
      }
    }

    return null;
  }

  private largestVideoThumbnailUrl(
    thumbnails: MetaVideoThumbnailGraphNode[] | undefined,
  ): string | null {
    const candidates = (thumbnails ?? [])
      .map((thumbnail) => ({
        area:
          this.asInteger(thumbnail.width) * this.asInteger(thumbnail.height),
        preferred: thumbnail.is_preferred === true,
        url: this.asHttpUrl(thumbnail.uri),
      }))
      .filter((thumbnail): thumbnail is typeof thumbnail & { url: string } =>
        Boolean(thumbnail.url),
      )
      .sort(
        (left, right) =>
          right.area - left.area ||
          Number(right.preferred) - Number(left.preferred),
      );

    return candidates[0]?.url ?? null;
  }

  /**
   * Runs GET sub-requests through the Graph batch endpoint in chunks of 50.
   * Never throws: every key ends up either in results or in failures. A
   * failing whole batch request marks its chunk failed, skips the remaining
   * chunks (notAttempted) and keeps results from earlier chunks.
   */
  private async getGraphBatch<T>(
    requests: Array<{ key: string; relativeUrl: string }>,
    accessToken: string,
    operation: string,
  ): Promise<MetaGraphBatchResult<T>> {
    const startedAt = Date.now();
    const results = new Map<string, T>();
    const failures = new Map<string, MetaGraphBatchFailureReason>();
    let batchCount = 0;
    let aborted = false;

    try {
      for (
        let offset = 0;
        offset < requests.length;
        offset += META_GRAPH_BATCH_SIZE
      ) {
        const chunk = requests.slice(offset, offset + META_GRAPH_BATCH_SIZE);

        if (aborted) {
          chunk.forEach((request) => failures.set(request.key, "notAttempted"));
          continue;
        }

        batchCount += 1;
        const body = new URLSearchParams({
          access_token: accessToken,
          batch: JSON.stringify(
            chunk.map((request) => ({
              method: "GET",
              relative_url: request.relativeUrl,
            })),
          ),
        });
        let status = 0;
        let payload: unknown = null;
        let chunkFailure: MetaGraphBatchFailureReason | null = null;

        try {
          const response = await this.fetchImpl(
            `https://graph.facebook.com/${this.getGraphApiVersion()}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body,
            },
          );
          status = response.status;
          payload = (await response.json().catch(() => null)) as unknown;

          if (!response.ok || !Array.isArray(payload)) {
            chunkFailure = this.graphFailureReason(status, payload);
          }
        } catch {
          chunkFailure = "transportError";
        }

        if (chunkFailure || !Array.isArray(payload)) {
          const reason = chunkFailure ?? "unexpected";
          chunk.forEach((request) => failures.set(request.key, reason));
          aborted = true;
          // Status and reason only: Graph error text and URLs stay out of logs.
          console.warn("[wpptrack:meta-graph] batch request failed", {
            operation,
            status,
            reason,
            chunkSize: chunk.length,
            skippedRequests: Math.max(
              0,
              requests.length - offset - chunk.length,
            ),
          });
          continue;
        }

        const items = payload;

        chunk.forEach((request, index) => {
          const item = this.asRecord(items[index]) as MetaGraphBatchItem | null;

          const code = this.asInteger(item?.code);

          if (!item || code === 0) {
            failures.set(request.key, "missingItem");
            return;
          }

          const parsedBody = this.parseGraphBatchBody<T>(item.body);

          if (code < 200 || code >= 300) {
            failures.set(
              request.key,
              this.graphFailureReason(code, parsedBody),
            );
          } else if (parsedBody) {
            results.set(request.key, parsedBody);
          } else {
            failures.set(request.key, "missingItem");
          }
        });
      }

      return { results, failures, batchRequests: batchCount, aborted };
    } finally {
      this.logSlowGraphList(
        operation,
        Date.now() - startedAt,
        batchCount,
        results.size,
      );
    }
  }

  private graphFailureReason(
    status: number,
    payload: unknown,
  ): MetaGraphBatchFailureReason {
    const error = this.asRecord(this.asRecord(payload)?.error);
    const graphCode = this.asInteger(error?.code);
    const [minAdsCode, maxAdsCode] = META_ADS_RATE_LIMIT_CODE_RANGE;

    if (
      status === 429 ||
      META_RATE_LIMIT_CODES.has(graphCode) ||
      (graphCode >= minAdsCode && graphCode <= maxAdsCode)
    ) {
      return "rateLimited";
    }

    if (status >= 500) {
      return "serverError";
    }

    if (status >= 400) {
      return "clientError";
    }

    return "unexpected";
  }

  private parseGraphBatchBody<T>(body: unknown): T | null {
    let parsed = body;

    if (typeof body === "string") {
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        return null;
      }
    }

    return this.asRecord(parsed) ? (parsed as T) : null;
  }

  private async postGraphUpdate(
    id: string,
    accessToken: string,
    values: Record<string, string>,
  ): Promise<void> {
    const body = new URLSearchParams({
      ...values,
      access_token: accessToken,
    });
    const response = await this.fetchImpl(
      `https://graph.facebook.com/${this.getGraphApiVersion()}/${id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
    );
    const payload = (await response
      .json()
      .catch(() => ({}))) as MetaGraphMutationResponse;

    if (!response.ok || payload.success !== true) {
      throw new Error(
        this.asString(payload.error?.message) ??
          `Meta Graph HTTP ${response.status}`,
      );
    }
  }

  private async getGraphPages<T>(
    initialUrl: string,
    operation: string,
  ): Promise<T[]> {
    const startedAt = Date.now();
    let nextUrl: string | null = initialUrl;
    const data: T[] = [];
    let pageCount = 0;

    try {
      for (let page = 0; nextUrl && page < 100; page += 1) {
        pageCount = page + 1;
        const response = await this.fetchImpl(nextUrl);
        const payload = (await response
          .json()
          .catch(() => ({}))) as MetaGraphListResponse<T>;

        if (!response.ok) {
          throw new Error(
            this.asString(payload.error?.message) ??
              `Meta Graph HTTP ${response.status}`,
          );
        }

        if (Array.isArray(payload.data)) {
          data.push(...payload.data);
        }

        nextUrl = this.asString(payload.paging?.next);
      }

      if (nextUrl) {
        throw new Error(
          `Meta Graph pagination exceeded 100 pages for ${operation}`,
        );
      }

      return data;
    } finally {
      this.logSlowGraphList(
        operation,
        Date.now() - startedAt,
        pageCount,
        data.length,
      );
    }
  }

  private logSlowGraphList(
    path: string,
    durationMs: number,
    pageCount: number,
    itemCount: number,
  ): void {
    const thresholdMs = Number(this.env.META_GRAPH_SLOW_LOG_MS ?? 1500);

    if (!Number.isFinite(thresholdMs) || durationMs < thresholdMs) {
      return;
    }

    console.warn("[wpptrack:meta-graph] slow list", {
      path,
      durationMs,
      pageCount,
      itemCount,
    });
  }
}
