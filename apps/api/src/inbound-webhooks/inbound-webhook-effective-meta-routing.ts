import { Prisma } from "@prisma/client";
import { InboundWebhookMetaRouteReaderService } from "./inbound-webhook-meta-route-reader.service";
import type { PrismaService } from "../common/prisma/prisma.service";

type Client = Prisma.TransactionClient;
type LocalRoute = {
  id?: string;
  active?: boolean;
  validationStatus?: string;
  metaBusinessConnectionId?: string | null;
  metaReportingAccountId?: string | null;
  metaConversionDestinationId?: string | null;
};
export type EffectiveMetaChannel = {
  id: string;
  workspaceId: string;
  metaRoutingMode?: "inherit_workspace" | "channel_override" | null;
  routes: LocalRoute[];
  status?: string;
};
export type EffectiveMetaRouting = {
  source: "inherit_workspace" | "channel_override" | "legacy_unknown";
  eligible: boolean;
  routes: LocalRoute[];
};

/** Mirrors MetaConnectionResolver: normalized connections + the existing OAuth
 * integration flag, or enabled manual routing when no legacy integration exists. */
export async function workspaceMetaRoutingEnabled(
  client: Client,
  workspaceId: string,
): Promise<boolean> {
  const [count, integration] = await Promise.all([
    client.metaBusinessConnection.count({ where: { workspaceId } }),
    client.metaIntegration.findUnique({
      where: { workspaceId },
      select: { advancedRoutingEnabled: true },
    }),
  ]);
  return count > 0 && (integration ? integration.advancedRoutingEnabled : true);
}

function auditRoutes(value: Prisma.JsonValue | null): LocalRoute[] | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray(value.routes)
  )
    return null;
  return value.routes as LocalRoute[];
}

export async function effectiveUnnichatMetaRouting(
  client: Client,
  channel: EffectiveMetaChannel,
): Promise<EffectiveMetaRouting> {
  let source: EffectiveMetaRouting["source"] =
    channel.metaRoutingMode ?? "legacy_unknown";
  // Consumers may select only valid routes or omit provenance fields. Always
  // inspect complete current active rows, so projection cannot change the source.
  let routes: LocalRoute[] = await client.inboundWebhookChannelRoute.findMany({
    where: {
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      active: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (!channel.metaRoutingMode) {
    // Include removals: an intentionally emptied override must never start inheriting.
    const audit = await client.auditLog.findMany({
      where: {
        workspaceId: channel.workspaceId,
        OR: [
          {
            targetType: "InboundWebhookChannel",
            targetId: channel.id,
            action: {
              in: [
                "inbound_webhook.channel_routes_replaced",
                "inbound_webhook.channel_routes_learned",
              ],
            },
          },
          {
            targetType: "InboundWebhookChannelRoute",
            action: "inbound_webhook.channel_route_removed",
            beforeSummary: { path: ["channelId"], equals: channel.id },
          },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const manual = audit.filter(
      (row) =>
        row.actorType === "user" &&
        row.action !== "inbound_webhook.channel_routes_learned",
    );
    if (manual.length) {
      const replaced = manual.filter(
        (row) => row.action === "inbound_webhook.channel_routes_replaced",
      );
      const approved = replaced.length
        ? auditRoutes(replaced[replaced.length - 1].afterSummary)
        : null;
      if (approved) {
        source = "channel_override";
        // Automatic learning after a manual edit cannot expand the approved scope.
        routes = routes.filter((route) =>
          approved.some(
            (proof) =>
              proof.metaBusinessConnectionId ===
                route.metaBusinessConnectionId &&
              proof.metaReportingAccountId === route.metaReportingAccountId &&
              proof.metaConversionDestinationId ===
                route.metaConversionDestinationId,
          ),
        );
      }
    } else if (!routes.length && !audit.length) {
      source = "inherit_workspace";
    } else if (
      audit.length &&
      audit.every(
        (row) =>
          row.actorType === "system" &&
          row.action === "inbound_webhook.channel_routes_learned",
      )
    ) {
      const before = auditRoutes(audit[0].beforeSummary);
      const after = auditRoutes(audit[audit.length - 1].afterSummary) as
        (LocalRoute & { routeId?: string })[] | null;
      if (
        before?.length === 0 &&
        after &&
        routes.every(
          (route) =>
            route.id &&
            after.some(
              (proof) =>
                proof.routeId === route.id &&
                proof.metaBusinessConnectionId ===
                  route.metaBusinessConnectionId &&
                proof.metaReportingAccountId === route.metaReportingAccountId &&
                proof.metaConversionDestinationId ===
                  route.metaConversionDestinationId,
            ),
        )
      )
        source = "inherit_workspace";
    }
  }
  if (source === "legacy_unknown") {
    return {
      source,
      routes,
      eligible: routes.some(
        (route) =>
          route.active !== false &&
          route.validationStatus === "valid" &&
          !!route.metaBusinessConnectionId,
      ),
    };
  }
  if (
    source === "inherit_workspace" &&
    !(await workspaceMetaRoutingEnabled(client, channel.workspaceId))
  )
    return { source, routes: [], eligible: false };
  const accounts = await client.metaReportingAccount.findMany({
    where: {
      workspaceId: channel.workspaceId,
      active: true,
      businessConnectionId: { not: null },
    },
    select: {
      id: true,
      businessConnectionId: true,
      conversionDestinationId: true,
      allowedDestinations: {
        select: { active: true, conversionDestinationId: true },
      },
    },
  });
  for (const account of accounts) {
    const matchingRoutes = routes.filter(
      (route) =>
        route.active !== false &&
        route.validationStatus === "valid" &&
        route.metaBusinessConnectionId === account.businessConnectionId &&
        (!route.metaReportingAccountId ||
          route.metaReportingAccountId === account.id),
    );
    if (source === "channel_override" && !matchingRoutes.length) continue;
    const connection = await client.metaBusinessConnection.findFirst({
      where: {
        workspaceId: channel.workspaceId,
        id: account.businessConnectionId!,
        status: "active",
        credential: {
          is: { workspaceId: channel.workspaceId, status: "active" },
        },
      },
      select: {
        status: true,
        defaultConversionDestinationId: true,
        credential: { select: { status: true } },
      },
    });
    if (
      !connection ||
      connection.status !== "active" ||
      connection.credential.status !== "active"
    )
      continue;
    const allowed = account.allowedDestinations;
    const ids = allowed.length
      ? allowed
          .filter((row) => row.active !== false)
          .map((row) => row.conversionDestinationId)
      : [
          account.conversionDestinationId ??
            connection.defaultConversionDestinationId,
        ].filter((id): id is string => !!id);
    for (const id of ids) {
      if (
        source === "channel_override" &&
        !matchingRoutes.some(
          (route) =>
            !route.metaConversionDestinationId ||
            route.metaConversionDestinationId === id,
        )
      )
        continue;
      if (
        await client.metaConversionDestination.findFirst({
          where: { workspaceId: channel.workspaceId, id, status: "configured" },
          select: { id: true },
        })
      )
        return {
          source,
          routes: source === "inherit_workspace" ? [] : routes,
          eligible: true,
        };
    }
  }
  return {
    source,
    routes: source === "inherit_workspace" ? [] : routes,
    eligible: false,
  };
}

export type CanonicalMetaEvent = {
  workspaceId: string;
  adId: string | null;
  channel: EffectiveMetaChannel;
  resolvedBusinessConnectionId: string | null;
  resolvedReportingAccountId: string | null;
  resolvedConversionDestinationId: string | null;
};

export async function canonicalRouteAuthorized(
  client: Client,
  event: CanonicalMetaEvent,
): Promise<boolean> {
  if (
    !event.adId?.trim() ||
    event.workspaceId !== event.channel.workspaceId ||
    event.channel.status === "paused"
  )
    return false;
  const policy = await effectiveUnnichatMetaRouting(client, event.channel);
  if (!policy.eligible) return false;
  const reader = new InboundWebhookMetaRouteReaderService(
    client as PrismaService,
  );
  const scopes = policy.source === "inherit_workspace" ? [null] : policy.routes;
  const matches = [];
  for (const route of scopes) {
    if (
      route &&
      (route.active === false ||
        route.validationStatus !== "valid" ||
        !route.metaBusinessConnectionId)
    )
      continue;
    const preview = await reader.previewRoute({
      workspaceId: event.workspaceId,
      adId: event.adId,
      ...(route
        ? {
            businessConnectionId: route.metaBusinessConnectionId,
            reportingAccountId: route.metaReportingAccountId,
            conversionDestinationId: route.metaConversionDestinationId,
          }
        : {}),
    });
    if (preview.status === "resolved") matches.push(preview);
  }
  return (
    matches.length === 1 &&
    matches[0].businessConnectionId === event.resolvedBusinessConnectionId &&
    matches[0].reportingAccountId === event.resolvedReportingAccountId &&
    matches[0].conversionDestinationId === event.resolvedConversionDestinationId
  );
}

/** PostgreSQL locks serialize the current policy with ordinary UPDATE/DELETE
 * revocations. Workspace-first order also serializes our override mutations.
 * No provider requests or token decryption. Must run on a real transaction. */
export async function lockUnnichatMetaPolicy(
  client: Client,
  workspaceId: string,
  adIds: string[] = [],
): Promise<void> {
  await client.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "MetaIntegration" WHERE "workspaceId" = ${workspaceId} FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "MetaCredential" WHERE "workspaceId" = ${workspaceId} ORDER BY "id" FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "MetaBusinessConnection" WHERE "workspaceId" = ${workspaceId} ORDER BY "id" FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "MetaReportingAccount" WHERE "workspaceId" = ${workspaceId} ORDER BY "id" FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "MetaConversionDestination" WHERE "workspaceId" = ${workspaceId} ORDER BY "id" FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "MetaReportingAccountDestination" WHERE "workspaceId" = ${workspaceId} ORDER BY "id" FOR UPDATE`;
  if (adIds.length) {
    await client.$queryRaw`SELECT "id" FROM "MetaAd" WHERE "workspaceId" = ${workspaceId} AND "adId" IN (${Prisma.join(adIds)}) ORDER BY "id" FOR UPDATE`;
    await client.$queryRaw`SELECT "id" FROM "MetaAdDestinationAssignment" WHERE "workspaceId" = ${workspaceId} AND "adId" IN (${Prisma.join(adIds)}) ORDER BY "id" FOR UPDATE`;
  }
  // ::text keeps this valid before the Unnichat provider value exists (4b).
  await client.$queryRaw`SELECT "id" FROM "InboundWebhookParserRelease" WHERE "provider"::text = 'unnichat' ORDER BY "id" FOR SHARE`;
  await client.$queryRaw`SELECT "id" FROM "InboundWebhookConnection" WHERE "workspaceId" = ${workspaceId} ORDER BY "id" FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "InboundWebhookChannel" WHERE "workspaceId" = ${workspaceId} ORDER BY "id" FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "InboundWebhookChannelRoute" WHERE "workspaceId" = ${workspaceId} ORDER BY "id" FOR UPDATE`;
}
