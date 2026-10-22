import type { CrmChannelBindingFailure } from "@wpptrack/shared";
import {
  CTWA_DESTINATION_PROVIDER,
  resolveCtwaDestination,
  type AuthorizedCtwaDestination,
  type CtwaDestinationResolution,
} from "../inbound-webhooks/authorized-ctwa-destination";
import { resolveCtwaLeadProof } from "../conversion-rules/ctwa-lead-proof";

/**
 * Shared channel policy of the CRM-only integrations (Kommo, Pipedrive).
 *
 * A CRM is only a CRM: no WhatsApp number is connected to it. Its "authorized
 * channels" are the workspace's own production WhatsApp numbers (any provider:
 * Uazapi QR, Gupshup, Umbler, Data Crazy, Cloud API...) whose leads may be
 * matched by phone and whose Meta destination receives the conversion. A
 * binding id is either:
 *  - a valid explicit route id of the number (BM + reporting account +
 *    destination), the ad-attributed path; or
 *  - the channel id of a number whose Meta destination is the verified,
 *    unique workspace page/pixel (inherit_workspace), resolved by the
 *    canonical CTWA destination resolver (CRM mode for non-Unnichat numbers).
 * Only a number bridged to a WhatsApp instance (UAZAPI) requires that
 * instance; official-API/webhook numbers have none and their leads are tied
 * to the number by the materialized inbound entry receipt.
 */

/** Ad-attributed publication intent (route binding). An official-API number
 * has no WhatsApp instance (null). */
export type CrmRouteIntent = {
  connectionId: string;
  routeId: string;
  channelId: string;
  whatsappInstanceId: string | null;
  destinationId: string;
  pixelId: string;
  pageId: string;
  businessConnectionId: string;
  reportingAccountId: string;
  eventId: string;
};

const routeInclude = {
  channel: {
    include: {
      whatsappInstance: true,
      connection: { include: { parserRelease: true } },
    },
  },
  metaBusinessConnection: { include: { credential: true } },
  metaReportingAccount: true,
  metaConversionDestination: true,
} as const;

const channelInclude = {
  whatsappInstance: true,
  connection: { include: { parserRelease: true } },
  routes: true,
} as const;

/** The route row (with channel/Meta includes) of an authorized binding. */
export type CrmAuthorizedRoute = any;

export type CrmBindingInspection =
  | { ok: true; kind: "route"; channelId: string; route: CrmAuthorizedRoute }
  | {
      ok: true;
      kind: "channel";
      channelId: string;
      channel: any;
      destination: AuthorizedCtwaDestination;
    }
  | { ok: false; reason: CrmChannelBindingFailure };

/** Production gates of the WhatsApp number itself (provider-agnostic). */
function numberFailure(
  channel: any,
  workspaceId: string,
): CrmChannelBindingFailure | null {
  const connection = channel?.connection;
  if (
    !channel ||
    channel.workspaceId !== workspaceId ||
    !connection ||
    connection.workspaceId !== workspaceId ||
    connection.removedAt
  )
    return "number_not_found";
  if (channel.status === "paused" || connection.status === "paused")
    return "number_paused";
  if (
    channel.status !== "active" ||
    !channel.productionActivatedAt ||
    connection.status !== "production" ||
    !connection.productionActivatedAt
  )
    return "number_not_in_production";
  if (connection.parserRelease?.status !== "certified")
    return "provider_not_certified";
  // A QR (UAZAPI) number, or any number bridged to a WhatsApp instance, must
  // keep that instance active. Official-API numbers have no instance.
  if (connection.provider === "uazapi" || channel.whatsappInstanceId) {
    const instance = channel.whatsappInstance;
    if (
      !channel.whatsappInstanceId ||
      instance?.workspaceId !== workspaceId ||
      instance.status !== "active"
    )
      return "whatsapp_disconnected";
  }
  return null;
}

/** Meta asset gates of an explicit route. */
function routeMetaFailure(route: any, workspaceId: string): boolean {
  const business = route.metaBusinessConnection;
  const reporting = route.metaReportingAccount;
  const destination = route.metaConversionDestination;
  return (
    !route.active ||
    route.validationStatus !== "valid" ||
    business?.workspaceId !== workspaceId ||
    business.status !== "active" ||
    business.credential?.workspaceId !== workspaceId ||
    business.credential.status !== "active" ||
    reporting?.workspaceId !== workspaceId ||
    !reporting.active ||
    reporting.businessConnectionId !== business.id ||
    destination?.workspaceId !== workspaceId ||
    destination.status !== "configured"
  );
}

function inspectRoute(route: any, workspaceId: string): CrmBindingInspection {
  if (!route || route.workspaceId !== workspaceId)
    return { ok: false, reason: "number_not_found" };
  const failure = numberFailure(route.channel, workspaceId);
  if (failure) return { ok: false, reason: failure };
  if (routeMetaFailure(route, workspaceId))
    return { ok: false, reason: "meta_destination_unverified" };
  return {
    ok: true,
    kind: "route",
    channelId: route.channelId ?? route.channel.id,
    route,
  };
}

/**
 * Meta destination of a number bound by its channel id: the verified unique
 * page/pixel it inherits. Unnichat resolves exactly as its entries do; other
 * official-API/webhook providers use the CRM mode (inherit_workspace only). A
 * number bridged to a WhatsApp instance (UAZAPI) is never bound this way.
 */
export function crmChannelDestination(
  client: any,
  channel: any,
): Promise<CtwaDestinationResolution> {
  return resolveCtwaDestination(client, channel, { crmAnyProvider: true });
}

/** Resolve one binding id (route id, else channel id) and say precisely which
 * requirement fails. Read-only. */
export async function inspectCrmBinding(
  client: any,
  workspaceId: string,
  bindingId: string,
): Promise<CrmBindingInspection> {
  const route = await client.inboundWebhookChannelRoute.findFirst({
    where: { id: bindingId, workspaceId },
    include: routeInclude,
  });
  if (route) return inspectRoute(route, workspaceId);
  const channel = await client.inboundWebhookChannel.findFirst({
    where: { id: bindingId, workspaceId },
    include: channelInclude,
  });
  if (!channel) return { ok: false, reason: "number_not_found" };
  const failure = numberFailure(channel, workspaceId);
  if (failure) return { ok: false, reason: failure };
  const destination = await crmChannelDestination(client, channel);
  if (destination.kind !== "authorized_ctwa_destination")
    return { ok: false, reason: "meta_destination_unverified" };
  return {
    ok: true,
    kind: "channel",
    channelId: channel.id,
    channel,
    destination,
  };
}

/** Current authorization of an explicit route binding, optionally pinned to an
 * immutable publication intent (route, channel, instance and Meta assets). */
export async function authorizedCrmRoute(
  client: any,
  workspaceId: string,
  routeId: string,
  intent?: CrmRouteIntent,
): Promise<CrmAuthorizedRoute | null> {
  const route = await client.inboundWebhookChannelRoute.findFirst({
    where: { id: routeId, workspaceId, active: true, validationStatus: "valid" },
    include: routeInclude,
  });
  const inspected = inspectRoute(route, workspaceId);
  if (!inspected.ok) return null;
  if (
    intent &&
    (route.channel.id !== intent.channelId ||
      (route.channel.whatsappInstanceId ?? null) !==
        (intent.whatsappInstanceId ?? null) ||
      route.metaBusinessConnectionId !== intent.businessConnectionId ||
      route.metaReportingAccountId !== intent.reportingAccountId ||
      route.metaConversionDestinationId !== intent.destinationId ||
      route.metaConversionDestination.pixelId !== intent.pixelId ||
      route.metaConversionDestination.pageId !== intent.pageId)
  )
    return null;
  return route;
}

/** Splits binding ids into existing route ids (with their channel) and the
 * remaining ids, which can only be channel ids. */
async function splitBindings(
  client: any,
  workspaceId: string,
  bindingIds: string[],
): Promise<{
  routes: Array<{ id: string; channelId: string }>;
  channelIds: string[];
}> {
  if (!bindingIds.length) return { routes: [], channelIds: [] };
  const routes: Array<{ id: string; channelId: string }> =
    await client.inboundWebhookChannelRoute.findMany({
      where: { id: { in: bindingIds }, workspaceId },
      select: { id: true, channelId: true },
    });
  const routeIds = new Set(routes.map((route) => route.id));
  return {
    routes,
    channelIds: bindingIds.filter((id) => !routeIds.has(id)),
  };
}

/** Channel ids a connection's bindings point at (route ids map to their
 * channel; channel ids are kept), regardless of current readiness. */
export async function crmBoundChannelIds(
  client: any,
  workspaceId: string,
  bindingIds: string[],
): Promise<string[]> {
  const { routes, channelIds } = await splitBindings(
    client,
    workspaceId,
    bindingIds,
  );
  const channels: Array<{ id: string }> = channelIds.length
    ? await client.inboundWebhookChannel.findMany({
        where: { id: { in: channelIds }, workspaceId },
        select: { id: true },
      })
    : [];
  return [
    ...new Set([
      ...routes.map((route) => route.channelId),
      ...channels.map((channel) => channel.id),
    ]),
  ];
}

/**
 * Channels this lead provably entered through: a materialized inbound
 * LeadSubmitted receipt (live production or authorized replay) of the same
 * lead and phone (and, when given, the same click) on that channel. This is
 * how a lead of an official-API number (no WhatsApp instance on the lead) is
 * tied to its number.
 */
export async function crmLeadEntryChannelIds(
  client: any,
  input: {
    workspaceId: string;
    leadId: string;
    phoneHash: string;
    ctwaClid?: string;
  },
): Promise<Set<string>> {
  const logs: Array<{ id: string; sourcePayload: unknown }> =
    await client.conversionEventLog.findMany({
      where: {
        workspaceId: input.workspaceId,
        leadId: input.leadId,
        phoneHash: input.phoneHash,
        eventName: "LeadSubmitted",
        sourceTrigger: { startsWith: "inbound_webhook:" },
        ...(input.ctwaClid ? { ctwaClid: input.ctwaClid } : {}),
      },
      select: { id: true, sourcePayload: true },
      take: 501,
    });
  const channels = new Set<string>();
  if (logs.length > 500) return channels;
  for (const log of logs) {
    const p = log.sourcePayload as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    const { inboundEventId, channelId, connectionId } = p;
    if (
      typeof inboundEventId !== "string" ||
      typeof channelId !== "string" ||
      typeof connectionId !== "string" ||
      channels.has(channelId)
    )
      continue;
    const receipt = {
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      conversionEventLogId: log.id,
      status: { in: ["materialized", "duplicate"] },
    };
    const event = await client.inboundWebhookEvent.findFirst({
      where: {
        id: inboundEventId,
        workspaceId: input.workspaceId,
        channelId,
        connectionId,
        OR: [
          { productionItem: { is: receipt } },
          { replayItem: { is: receipt } },
        ],
      },
      select: { id: true },
    });
    if (event) channels.add(channelId);
  }
  return channels;
}

type CrmLead = {
  id: string;
  workspaceId: string;
  phoneHash: string;
  whatsappInstanceId: string | null;
  adId: string | null;
  ctwaClid: string | null;
};

/**
 * Currently authorized route bindings whose number this lead belongs to:
 * the lead's WhatsApp instance for a bridged (UAZAPI) number, else the
 * materialized inbound entry receipt on that number.
 */
export async function crmLeadRoutes(
  client: any,
  lead: CrmLead,
  bindingIds: string[],
): Promise<CrmAuthorizedRoute[]> {
  const routes: CrmAuthorizedRoute[] = [];
  // Computed once, only when an official-API number is bound.
  let entryChannels: Set<string> | null = null;
  for (const id of bindingIds) {
    // Route bindings only; a channel binding is the page/pixel path.
    const route = await authorizedCrmRoute(client, lead.workspaceId, id);
    if (!route) continue;
    const instanceId = route.channel.whatsappInstanceId;
    if (instanceId) {
      if (lead.whatsappInstanceId === instanceId) routes.push(route);
      continue;
    }
    entryChannels ??= await crmLeadEntryChannelIds(client, {
      workspaceId: lead.workspaceId,
      leadId: lead.id,
      phoneHash: lead.phoneHash,
    });
    if (entryChannels.has(route.channelId ?? route.channel.id))
      routes.push(route);
  }
  return routes;
}

/**
 * Page/pixel proof of a CTWA lead for a CRM conversion (Meta CAPI needs only
 * pixel + page + ctwa_clid). Exactly one bound number must prove it:
 *  - Unnichat (lead without ad id): its materialized CTWA entry receipt, bound
 *    through a route or the channel itself (unchanged canonical proof);
 *  - another official-API/webhook provider bound BY CHANNEL ID: the lead
 *    entered through that number with the same click (materialized receipt)
 *    and the number inherits the verified unique workspace page/pixel.
 * Bridged (UAZAPI) numbers never use this path. Ambiguity returns null.
 */
export async function crmLeadCtwaProof(
  client: any,
  lead: CrmLead,
  bindingIds: string[],
): Promise<AuthorizedCtwaDestination | null> {
  const ctwaClid = lead.ctwaClid?.trim();
  if (!ctwaClid || !bindingIds.length) return null;
  const proofs = new Map<string, AuthorizedCtwaDestination>();
  if (!lead.adId?.trim()) {
    const bound = await crmBoundChannelIds(
      client,
      lead.workspaceId,
      bindingIds,
    );
    const proof = await resolveCtwaLeadProof(client, {
      workspaceId: lead.workspaceId,
      leadId: lead.id,
      phoneHash: lead.phoneHash,
      ctwaClid: lead.ctwaClid!,
    });
    if (proof && bound.includes(proof.channelId))
      proofs.set(proof.channelId, proof);
  }
  const { channelIds } = await splitBindings(
    client,
    lead.workspaceId,
    bindingIds,
  );
  if (channelIds.length) {
    const channels: any[] = await client.inboundWebhookChannel.findMany({
      where: { id: { in: channelIds }, workspaceId: lead.workspaceId },
      include: channelInclude,
    });
    const official = channels.filter(
      (channel) =>
        channel.connection?.provider &&
        channel.connection.provider !== CTWA_DESTINATION_PROVIDER &&
        channel.connection.provider !== "uazapi" &&
        !channel.whatsappInstanceId,
    );
    if (official.length) {
      const entered = await crmLeadEntryChannelIds(client, {
        workspaceId: lead.workspaceId,
        leadId: lead.id,
        phoneHash: lead.phoneHash,
        ctwaClid: lead.ctwaClid!,
      });
      for (const channel of official) {
        if (
          !entered.has(channel.id) ||
          numberFailure(channel, lead.workspaceId)
        )
          continue;
        const destination = await crmChannelDestination(client, channel);
        if (destination.kind === "authorized_ctwa_destination")
          proofs.set(channel.id, destination);
      }
    }
  }
  return proofs.size === 1 ? [...proofs.values()][0]! : null;
}

/**
 * Send-time binding check of a CRM page/pixel conversion: the number is still
 * bound to the CRM connection (through one of its routes or itself). The
 * destination itself is re-resolved by the canonical CTWA sender.
 */
export async function crmCtwaChannelBound(
  client: any,
  workspaceId: string,
  bindingIds: string[],
  channelId: string,
): Promise<boolean> {
  if (!bindingIds.length) return false;
  return (await crmBoundChannelIds(client, workspaceId, bindingIds)).includes(
    channelId,
  );
}
