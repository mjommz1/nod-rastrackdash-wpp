import type { Prisma } from "@prisma/client";

type RouteReferences = {
  metaBusinessConnectionId: string | null;
  metaReportingAccountId: string | null;
  metaConversionDestinationId: string | null;
};

export function inboundMetaRouteMatches(
  route: RouteReferences,
  resolved: {
    businessConnectionId: string | null;
    reportingAccountId: string | null;
    conversionDestinationId: string | null;
  },
): boolean {
  return Boolean(
    resolved.businessConnectionId &&
    resolved.reportingAccountId &&
    resolved.conversionDestinationId &&
    route.metaBusinessConnectionId === resolved.businessConnectionId &&
    (route.metaReportingAccountId === null ||
      route.metaReportingAccountId === resolved.reportingAccountId) &&
    (route.metaConversionDestinationId === null ||
      route.metaConversionDestinationId === resolved.conversionDestinationId),
  );
}

/** An explicit legacy account binding remains supported. BM defaults alone
 * never grant a reporting account access to a destination. Callers scope the
 * active allowedDestinations relation to the workspace before using it. */
export function authorizedInboundMetaDestinationIds(account: {
  conversionDestinationId: string | null;
  allowedDestinations: Array<{ conversionDestinationId: string }>;
}): string[] {
  return [
    ...new Set(
      account.allowedDestinations.length > 0
        ? account.allowedDestinations.map(
            (item) => item.conversionDestinationId,
          )
        : account.conversionDestinationId
          ? [account.conversionDestinationId]
          : [],
    ),
  ];
}

export async function inboundMetaRouteEligible(
  client: Pick<
    Prisma.TransactionClient,
    | "metaBusinessConnection"
    | "metaReportingAccount"
    | "metaConversionDestination"
  >,
  workspaceId: string,
  route: RouteReferences & {
    workspaceId: string;
    active: boolean;
    validationStatus: string;
  },
): Promise<boolean> {
  if (
    route.workspaceId !== workspaceId ||
    !route.active ||
    route.validationStatus !== "valid" ||
    !route.metaBusinessConnectionId
  )
    return false;

  const business = await client.metaBusinessConnection.findFirst({
    where: { id: route.metaBusinessConnectionId, workspaceId },
    select: {
      id: true,
      workspaceId: true,
      status: true,
      credential: { select: { workspaceId: true, status: true } },
    },
  });
  if (
    !business ||
    business.workspaceId !== workspaceId ||
    business.status !== "active" ||
    business.credential.workspaceId !== workspaceId ||
    business.credential.status !== "active"
  )
    return false;

  const accounts = await client.metaReportingAccount.findMany({
    where: {
      workspaceId,
      businessConnectionId: business.id,
      active: true,
      ...(route.metaReportingAccountId !== null
        ? { id: route.metaReportingAccountId }
        : {}),
    },
    select: {
      id: true,
      conversionDestinationId: true,
      allowedDestinations: {
        where: { workspaceId, active: true },
        select: { conversionDestinationId: true },
      },
    },
  });
  const authorized = [
    ...new Set(accounts.flatMap(authorizedInboundMetaDestinationIds)),
  ];
  const candidates =
    route.metaConversionDestinationId !== null
      ? authorized.filter((id) => id === route.metaConversionDestinationId)
      : authorized;
  if (candidates.length === 0) return false;

  const destination = await client.metaConversionDestination.findFirst({
    where: { workspaceId, status: "configured", id: { in: candidates } },
    select: { id: true },
  });
  // This is route eligibility, not a promise that every ad can be resolved.
  // Ambiguous assignments and unauthorized accounts fail closed per event.
  return destination !== null;
}

export async function hasEligibleInboundMetaRoute(
  client: Parameters<typeof inboundMetaRouteEligible>[0],
  workspaceId: string,
  routes: Array<Parameters<typeof inboundMetaRouteEligible>[2]>,
): Promise<boolean> {
  for (const route of routes) {
    if (await inboundMetaRouteEligible(client, workspaceId, route)) return true;
  }
  return false;
}
