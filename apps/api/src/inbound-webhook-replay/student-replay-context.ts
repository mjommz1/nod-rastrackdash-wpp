import { createHash } from "node:crypto";
import { ForbiddenException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { inboundParserProductionEligible } from "../inbound-webhooks/inbound-webhook-parser-eligibility";

export type StudentReplayActor = {
  id: string;
  role: "owner";
  workspaceId: string;
};
type Client = Prisma.TransactionClient;

export async function requireStudentReplayOwner(
  client: Client,
  actor: StudentReplayActor,
): Promise<void> {
  if (!actor.workspaceId || actor.role !== "owner")
    throw new ForbiddenException(
      "Somente o owner do workspace pode recuperar CTWAs anteriores",
    );
  const membership = await client.workspaceMember.findFirst({
    where: {
      userId: actor.id,
      workspaceId: actor.workspaceId,
      role: "owner",
      workspace: { operationalStatus: "active" },
    },
    select: { id: true },
  });
  if (!membership)
    throw new ForbiddenException(
      "Somente o owner do workspace ativo pode recuperar CTWAs anteriores",
    );
}

export function replayContextHash(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input))
      return input
        .map(canonical)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, val]) => [key, canonical(val)]),
      );
    return input;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value ?? null)))
    .digest("hex");
}

/** Metadata snapshot: no credentials or payload. Changes revoke prior approval. */
export async function studentReplayContext(
  client: Client,
  workspaceId: string,
  connectionId: string,
  channelId: string,
): Promise<string | null> {
  const channel = await client.inboundWebhookChannel.findFirst({
    where: {
      id: channelId,
      workspaceId,
      connectionId,
      connection: { workspaceId, removedAt: null },
    },
    include: {
      connection: { include: { parserRelease: true } },
      routes: { where: { active: true } },
    },
  });
  if (
    !channel ||
    channel.workspaceId !== workspaceId ||
    channel.connection.workspaceId !== workspaceId ||
    channel.connectionId !== connectionId ||
    channel.connection.removedAt ||
    channel.status !== "active" ||
    !["observation", "production"].includes(channel.connection.status) ||
    channel.connection.provider !== "meta_cloud" ||
    channel.connection.parserRelease.provider !== channel.connection.provider ||
    !inboundParserProductionEligible(channel.connection.parserRelease)
  )
    return null;
  const businessIds = channel.routes.flatMap((r) =>
    r.metaBusinessConnectionId ? [r.metaBusinessConnectionId] : [],
  );
  const [businesses, accounts, destinations, integration] = await Promise.all([
    client.metaBusinessConnection.findMany({
      where: { workspaceId, id: { in: businessIds } },
      select: {
        id: true,
        credentialId: true,
        status: true,
        defaultConversionDestinationId: true,
        credential: {
          select: {
            id: true,
            workspaceId: true,
            source: true,
            fingerprint: true,
            status: true,
            expiresAt: true,
            updatedAt: true,
          },
        },
      },
    }),
    client.metaReportingAccount.findMany({
      where: { workspaceId, businessConnectionId: { in: businessIds } },
      select: {
        id: true,
        active: true,
        businessConnectionId: true,
        adAccountId: true,
        conversionDestinationId: true,
        allowedDestinations: {
          select: {
            workspaceId: true,
            active: true,
            conversionDestinationId: true,
          },
        },
      },
    }),
    client.metaConversionDestination.findMany({
      where: { workspaceId },
      select: {
        id: true,
        status: true,
        pixelId: true,
        pageId: true,
        updatedAt: true,
      },
    }),
    client.metaIntegration.findUnique({
      where: { workspaceId },
      select: {
        id: true,
        updatedAt: true,
        status: true,
        expiresAt: true,
        advancedRoutingEnabled: true,
        primaryConversionDestinationId: true,
      },
    }),
  ]);
  const c = channel.connection;
  return replayContextHash({
    workspaceId,
    connectionId,
    channelId,
    connection: {
      provider: c.provider,
      status: c.status,
      productionActivatedAt: c.productionActivatedAt,
      release: c.parserRelease,
    },
    channel: {
      status: channel.status,
      organizationId: channel.organizationId,
      providerChannelId: channel.providerChannelId,
      identity: replayContextHash(channel.connectedPhone),
      whatsappInstanceId: channel.whatsappInstanceId,
      productionActivatedAt: channel.productionActivatedAt,
    },
    routes: channel.routes,
    businesses,
    accounts,
    destinations,
    integration,
  });
}

export function studentReplayEventHash(
  event: Prisma.InboundWebhookEventGetPayload<{ include: { delivery: true } }>,
): string {
  return replayContextHash({
    id: event.id,
    workspaceId: event.workspaceId,
    connectionId: event.connectionId,
    channelId: event.channelId,
    provider: event.provider,
    dedupeKey: event.dedupeKey,
    externalMessageId: event.externalMessageId,
    occurredAt: event.occurredAt,
    hasCtwa: event.hasCtwa,
    adId: event.adId,
    classification: event.classification,
    business: event.resolvedBusinessConnectionId,
    reporting: event.resolvedReportingAccountId,
    destination: event.resolvedConversionDestinationId,
    delivery: event.delivery,
  });
}

export async function studentBatchAuthorizationValid(
  client: Client,
  workspaceId: string,
  batchId: string,
  eventId?: string,
): Promise<boolean> {
  const batch = await client.inboundWebhookReplayBatch.findFirst({
    where: { id: batchId, workspaceId },
  });
  if (!batch?.channelId) return false;
  const audit = await client.auditLog.findFirst({
    where: {
      workspaceId,
      targetId: batchId,
      action: "inbound_webhook.replay.authorize",
      actorUserId: batch.requestedByUserId,
    },
    select: { afterSummary: true },
  });
  const summary = audit?.afterSummary as {
    studentContext?: string;
    studentEventHashes?: Record<string, string>;
  } | null;
  if (!summary?.studentContext) return false;
  try {
    await requireStudentReplayOwner(client, {
      id: batch.requestedByUserId,
      role: "owner",
      workspaceId,
    });
  } catch {
    return false;
  }
  const current = await studentReplayContext(
    client,
    workspaceId,
    batch.connectionId,
    batch.channelId,
  );
  if (!current || current !== summary.studentContext) return false;
  if (eventId) {
    const event = await client.inboundWebhookEvent.findFirst({
      where: {
        id: eventId,
        workspaceId,
        connectionId: batch.connectionId,
        channelId: batch.channelId,
      },
      include: { delivery: true },
    });
    if (
      !event ||
      summary.studentEventHashes?.[eventId] !== studentReplayEventHash(event)
    )
      return false;
  }
  return true;
}

/** A materialized batch may still be waiting for the existing CAPI sender. */
export async function studentReplayDispatchUnsettled(
  client: Client,
  workspaceId: string,
  connectionId: string,
): Promise<boolean> {
  const batches = await client.inboundWebhookReplayBatch.findMany({
    where: {
      workspaceId,
      connectionId,
      OR: [
        { status: { in: ["queued", "processing"] } },
        { createdAt: { gte: new Date(Date.now() - 7 * 86400_000) } },
      ],
    },
    include: { items: true },
  });
  for (const batch of batches) {
    if (["queued", "processing"].includes(batch.status)) return true;
    for (const item of batch.items) {
      if (item.status === "duplicate") return true;
      if (item.status !== "materialized") continue;
      const log = item.conversionEventLogId
        ? await client.conversionEventLog.findFirst({
            where: { workspaceId, id: item.conversionEventLogId },
            select: { status: true, sentAt: true },
          })
        : null;
      if (
        !log ||
        ["ready_to_send", "sending", "delivery_unknown"].includes(log.status)
      )
        return true;
      const claim = item.conversionEventLogId
        ? await client.auditLog.findFirst({
            where: {
              workspaceId,
              targetId: item.conversionEventLogId,
              action: "inbound_webhook.dispatch.claim",
            },
            select: { resultStatus: true },
          })
        : null;
      if (
        ["dispatch_started", "delivery_unknown"].includes(
          claim?.resultStatus ?? "",
        ) &&
        !(log.status === "sent" && log.sentAt)
      )
        return true;
    }
  }
  return false;
}
