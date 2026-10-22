import { InboundWebhookProvider, type Prisma } from "@prisma/client";
import type { AuthorizedCtwaDestinationDto } from "@wpptrack/shared";
import {
  workspaceMetaRoutingEnabled,
  effectiveUnnichatMetaRouting,
} from "./inbound-webhook-effective-meta-routing";
import type { InboundWebhookMetaRoutePreview } from "./inbound-webhook-meta-route-reader.service";

/**
 * CTWA lead WITH ctwa_clid and WITHOUT ad id, routed to the WhatsApp number's
 * unique page/pixel destination (same behavior as the validated SaaS path).
 * A lead without ctwa_clid never reaches this path: nothing is sent to Meta.
 *
 * Only the page/pixel delivery is ported. It is authorized by the Meta login
 * the student already uses (business_management + ads_read/ads_management);
 * it needs no WhatsApp Business permission, no WABA binding and no new OAuth
 * scope. The SaaS WABA-dataset binding (MetaConversionDestination
 * .whatsappBinding, verified with whatsapp_business_management /
 * whatsapp_business_manage_events) is intentionally absent here.
 */
export const CTWA_DESTINATION_REASON = "authorized_ctwa_destination";
/** CTWA entry WITH a provider ad id (ctwa_id/SourceID) that is unknown to the
 * workspace Meta structure. Routing comes from the same unique page/pixel
 * destination as the no-ad entry; the ad id is kept only as an attribution
 * hint (conversion ad_id / custom_data.ad_id) and never selects a route,
 * account, campaign or ad set. */
export const CTWA_DESTINATION_AD_HINT_REASON =
  "authorized_ctwa_destination_ad_hint";
/** The only provider whose WhatsApp entries may follow the page/pixel path
 * (as in the SaaS). Other providers keep requiring a known ad. */
export const CTWA_DESTINATION_PROVIDER = "unnichat";

/** Typed provider value for Prisma filters; null until the provider value
 * exists in this database schema (Unnichat arrives in Fase 4b). Callers must
 * fail closed on null. */
export function ctwaDestinationProviderValue(): InboundWebhookProvider | null {
  return (
    (Object.values(InboundWebhookProvider) as string[]).includes(
      CTWA_DESTINATION_PROVIDER,
    )
      ? (CTWA_DESTINATION_PROVIDER as InboundWebhookProvider)
      : null
  );
}

export function isCtwaDestinationReason(
  reason: string | null | undefined,
): boolean {
  return (
    reason === CTWA_DESTINATION_REASON ||
    reason === CTWA_DESTINATION_AD_HINT_REASON
  );
}
/** True when a stored event follows the channel page/pixel destination path:
 * the no-ad decision (adId null) or the ad-hint decision (adId kept). */
export function isCtwaDestinationEntry(event: {
  provider?: string | null;
  classificationReason?: string | null;
  adId?: string | null;
}): boolean {
  if (event.provider !== CTWA_DESTINATION_PROVIDER) return false;
  return (
    (event.classificationReason === CTWA_DESTINATION_REASON && !event.adId) ||
    (event.classificationReason === CTWA_DESTINATION_AD_HINT_REASON &&
      !!event.adId?.trim())
  );
}
/** Only a truly unknown ad (never synced into this workspace) may use the
 * page/pixel fallback. Any other unresolved reason, including an ad without
 * account or whose account is not configured, concerns a KNOWN ad with
 * inconsistent data and keeps its canonical reason. */
const unknownAdReasons = new Set<string>(["ad_not_found"]);
export async function ctwaAdUnknown(
  reader: {
    previewRoute(input: {
      workspaceId: string;
      adId: string;
    }): Promise<InboundWebhookMetaRoutePreview>;
  },
  workspaceId: string,
  adId: string,
): Promise<boolean> {
  const preview = await reader.previewRoute({ workspaceId, adId });
  return (
    preview.status === "unresolved" && unknownAdReasons.has(preview.reason)
  );
}
export type CtwaChannel = {
  id: string;
  workspaceId: string;
  whatsappInstanceId?: string | null;
  connectionId: string;
  organizationId: string;
  providerChannelId: string;
  status?: string;
  metaRoutingMode?: "inherit_workspace" | "channel_override" | null;
  routes: Array<{
    active?: boolean;
    validationStatus?: string;
    metaBusinessConnectionId?: string | null;
    metaReportingAccountId?: string | null;
    metaConversionDestinationId?: string | null;
  }>;
  connection?: {
    provider: string;
    workspaceId?: string;
    id?: string;
    status?: string;
    removedAt?: Date | null;
  };
};
export type AuthorizedCtwaDestination = AuthorizedCtwaDestinationDto;
export type AuthorizedPagePixelCtwaDestination = AuthorizedCtwaDestination;
export type CtwaDestinationResolution =
  | AuthorizedCtwaDestination
  | { kind: "blocked_ctwa_destination"; reason: string };
/**
 * Options of the canonical resolver.
 * `crmAnyProvider`: CRM-driven conversions only (Kommo/Pipedrive, later
 * phases). A channel of any provider other than Unnichat may resolve the
 * verified, unique workspace page/pixel pair, and only while its effective
 * routing is inherit_workspace. It never applies to a channel bridged to a
 * WhatsApp instance (UAZAPI keeps its explicit route). Inbound entry routing
 * never passes it: entry classification of every provider is unchanged.
 */
export type CtwaDestinationOptions = { crmAnyProvider?: boolean };
export async function resolveCtwaDestination(
  client: Prisma.TransactionClient,
  channel: CtwaChannel,
  options: CtwaDestinationOptions = {},
): Promise<CtwaDestinationResolution> {
  const blocked = (reason: string): CtwaDestinationResolution => ({
    kind: "blocked_ctwa_destination",
    reason,
  });
  const provider = channel.connection?.provider;
  // Non-Unnichat CRM path: requires the loaded provider connection.
  const crmProvider =
    options.crmAnyProvider === true &&
    !!provider &&
    provider !== CTWA_DESTINATION_PROVIDER &&
    provider !== "uazapi" &&
    !channel.whatsappInstanceId;
  if (
    !channel.workspaceId ||
    !channel.connectionId ||
    !channel.organizationId ||
    !channel.providerChannelId ||
    channel.status === "paused" ||
    channel.connection?.status === "paused" ||
    channel.connection?.removedAt ||
    (options.crmAnyProvider === true && !channel.connection) ||
    (channel.connection &&
      ((provider !== CTWA_DESTINATION_PROVIDER && !crmProvider) ||
        channel.connection.workspaceId !== channel.workspaceId ||
        channel.connection.id !== channel.connectionId))
  )
    return blocked("ctwa_channel_scope_invalid");
  if (!(await workspaceMetaRoutingEnabled(client, channel.workspaceId)))
    return blocked("ctwa_workspace_routing_disabled");
  const policy = await effectiveUnnichatMetaRouting(client, channel);
  // Unknown legacy routing never inherits nor widens to workspace destinations.
  if (policy.source === "legacy_unknown")
    return blocked("ctwa_channel_routing_mode_unset");
  const destinations = await client.metaConversionDestination.findMany({
    where: { workspaceId: channel.workspaceId, status: "configured" },
    orderBy: { id: "asc" },
  });
  if (crmProvider) {
    // Other providers keep their explicit routes for entries; only a number
    // whose effective routing inherits the workspace may use the page/pixel.
    if (policy.source !== "inherit_workspace")
      return blocked("ctwa_channel_routing_not_inherited");
    return resolvePagePixelDestination(client, channel, destinations, null);
  }
  // A channel override narrows the workspace destinations to its own valid
  // routes: BM-only covers every account of that BM, an account route covers
  // that account, a destination route pins that destination. Uniqueness of the
  // (pixel, page) pair is still required inside that scope.
  const scope: CtwaOverrideScope | null =
    policy.source === "channel_override"
      ? policy.routes.filter(
          (route) =>
            route.active !== false &&
            route.validationStatus === "valid" &&
            !!route.metaBusinessConnectionId,
        )
      : null;
  if (scope && !scope.length) return blocked("ctwa_override_no_valid_routes");
  return resolvePagePixelDestination(client, channel, destinations, scope);
}
type CtwaOverrideScope = Array<{
  metaBusinessConnectionId?: string | null;
  metaReportingAccountId?: string | null;
  metaConversionDestinationId?: string | null;
}>;
/** null scope = workspace inheritance (no channel restriction). */
function overrideAllows(
  scope: CtwaOverrideScope | null,
  target: {
    businessConnectionId: string;
    reportingAccountId: string | null;
    destinationId: string;
  },
): boolean {
  return (
    !scope ||
    scope.some(
      (route) =>
        route.metaBusinessConnectionId === target.businessConnectionId &&
        (!route.metaReportingAccountId ||
          route.metaReportingAccountId === target.reportingAccountId) &&
        (!route.metaConversionDestinationId ||
          route.metaConversionDestinationId === target.destinationId),
    )
  );
}
/** Reuse the page/pixel access checks persisted by Meta setup: active scoped
 * accounts authorize their selected destinations, using the validated BM token.
 * Accounts establish eligibility only; they never become event attribution. */
async function resolvePagePixelDestination(
  client: Prisma.TransactionClient,
  channel: CtwaChannel,
  destinations: Awaited<
    ReturnType<typeof client.metaConversionDestination.findMany>
  >,
  scope: CtwaOverrideScope | null,
): Promise<CtwaDestinationResolution> {
  const accounts = await client.metaReportingAccount.findMany({
    where: {
      workspaceId: channel.workspaceId,
      active: true,
      businessConnectionId: { not: null },
    },
    include: { allowedDestinations: true },
    orderBy: { id: "asc" },
  });
  const candidates: Array<{
    intent: AuthorizedPagePixelCtwaDestination;
    expiresAt: number;
  }> = [];
  const validated = (at: Date | null) =>
    !!at && Number.isFinite(at.getTime()) && at.getTime() <= Date.now();
  for (const account of accounts) {
    if (
      account.workspaceId !== channel.workspaceId ||
      !account.active ||
      !account.businessConnectionId
    )
      continue;
    const business = await client.metaBusinessConnection.findFirst({
      where: {
        id: account.businessConnectionId,
        workspaceId: channel.workspaceId,
      },
      include: { credential: true },
    });
    const credential = business?.credential;
    if (
      !business ||
      business.id !== account.businessConnectionId ||
      business.workspaceId !== channel.workspaceId ||
      business.status !== "active" ||
      business.validationError ||
      !validated(business.lastValidatedAt) ||
      !credential ||
      credential.id !== business.credentialId ||
      credential.workspaceId !== channel.workspaceId ||
      credential.status !== "active" ||
      credential.validationError ||
      !validated(credential.lastValidatedAt) ||
      (credential.rotatedAt &&
        (!validated(credential.rotatedAt) ||
          business.lastValidatedAt! < credential.rotatedAt ||
          credential.lastValidatedAt! < credential.rotatedAt)) ||
      !credential.fingerprint?.trim() ||
      !credential.encryptedAccessToken?.trim() ||
      !credential.tokenIv?.trim() ||
      !credential.tokenTag?.trim() ||
      !credential.scopes.includes("business_management") ||
      !credential.scopes.some(
        (s) => s === "ads_read" || s === "ads_management",
      ) ||
      (credential.expiresAt && credential.expiresAt.getTime() <= Date.now())
    )
      continue;
    // An explicit allowlist (even entirely disabled) must not inherit defaults.
    const ids = account.allowedDestinations.length
      ? account.allowedDestinations
          .filter(
            (d) =>
              d.active &&
              d.workspaceId === channel.workspaceId &&
              d.reportingAccountId === account.id,
          )
          .map((d) => d.conversionDestinationId)
      : [
          account.conversionDestinationId ??
            business.defaultConversionDestinationId,
        ];
    for (const destination of destinations) {
      if (
        !ids.includes(destination.id) ||
        destination.workspaceId !== channel.workspaceId ||
        destination.status !== "configured" ||
        destination.validationError ||
        !validated(destination.lastValidatedAt) ||
        !destination.pixelId?.trim() ||
        !destination.pageId?.trim()
      )
        continue;
      if (
        !overrideAllows(scope, {
          businessConnectionId: business.id,
          reportingAccountId: account.id,
          destinationId: destination.id,
        })
      )
        continue;
      // Rotation verifies the BM default. Additional selected destinations must
      // have been revalidated by the existing account-selection flow afterwards.
      if (
        credential.rotatedAt &&
        destination.id !== business.defaultConversionDestinationId &&
        !account.allowedDestinations.some(
          (d) =>
            d.active &&
            d.workspaceId === channel.workspaceId &&
            d.reportingAccountId === account.id &&
            d.conversionDestinationId === destination.id &&
            validated(d.updatedAt) &&
            d.updatedAt >= credential.rotatedAt!,
        )
      )
        continue;
      candidates.push({
        expiresAt: credential.expiresAt?.getTime() ?? Infinity,
        intent: {
          kind: "authorized_ctwa_destination",
          deliveryKind: "page_pixel",
          workspaceId: channel.workspaceId,
          channelId: channel.id,
          connectionId: channel.connectionId,
          organizationId: channel.organizationId,
          providerChannelId: channel.providerChannelId,
          destinationId: destination.id,
          businessConnectionId: business.id,
          credentialId: credential.id,
          credentialFingerprint: credential.fingerprint,
          pixelId: destination.pixelId,
          pageId: destination.pageId,
        },
      });
    }
  }
  const current = candidates.filter((c) => c.expiresAt > Date.now());
  const targets = new Set(
    current.map(({ intent }) =>
      JSON.stringify([intent.pixelId, intent.pageId]),
    ),
  );
  if (targets.size !== 1)
    return {
      kind: "blocked_ctwa_destination",
      reason:
        targets.size > 1
          ? "ctwa_destination_ambiguous"
          : "ctwa_verified_binding_missing",
    };
  // Canonical ID ordering matches existing Meta readers. Only after logical
  // destination uniqueness is proven may equivalent credentials be selected.
  current.sort((a, b) => {
    for (const key of [
      "businessConnectionId",
      "credentialId",
      "destinationId",
    ] as const) {
      if (a.intent[key] < b.intent[key]) return -1;
      if (a.intent[key] > b.intent[key]) return 1;
    }
    return 0;
  });
  return current[0]!.intent;
}
/** `crmContext`: the caller verified the conversion comes from a CRM
 * page/pixel path (later phases). Only then may a non-Unnichat page/pixel
 * intent be re-authorized; every other caller (entries, replay, provider
 * conversions) keeps the Unnichat-only rule. */
export type CtwaIntentAuthorizationOptions = { crmContext?: boolean };
export async function ctwaIntentAuthorized(
  client: Prisma.TransactionClient,
  intent: AuthorizedCtwaDestination,
  options: CtwaIntentAuthorizationOptions = {},
): Promise<boolean> {
  const channel = await client.inboundWebhookChannel.findFirst({
    where: { id: intent.channelId, workspaceId: intent.workspaceId },
    include: { connection: true, routes: true },
  });
  if (!channel) return false;
  const resolved = await resolveCtwaDestination(client, channel, {
    crmAnyProvider: options.crmContext === true,
  });
  return (
    resolved.kind === "authorized_ctwa_destination" &&
    Object.entries(intent).every(
      ([k, v]) => (resolved as unknown as Record<string, unknown>)[k] === v,
    )
  );
}
