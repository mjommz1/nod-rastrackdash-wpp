import { ConflictException, NotFoundException } from "@nestjs/common";
import { type $Enums, Prisma } from "@prisma/client";
import type {
  InboundWebhookChannelStatusUpdateInputDto,
  InboundWebhookConnectionStatusUpdateInputDto,
} from "@wpptrack/shared";
import { hasEligibleInboundMetaRoute } from "./inbound-webhook-meta-route-eligibility";
import type { RuntimeEnv } from "../common/runtime/runtime.module";
import { assertMetaCloudSigningConfigured, inboundParserProductionEligible } from "./inbound-webhook-parser-eligibility";
import { studentReplayDispatchUnsettled } from "../inbound-webhook-replay/student-replay-context";
import { resolveCtwaDestination } from "./authorized-ctwa-destination";
import { effectiveUnnichatMetaRouting } from "./inbound-webhook-effective-meta-routing";

/**
 * Single implementation of the "promote a connection to production" and
 * "activate a channel" side effects, shared by the Integrations panel buttons
 * (InboundWebhookConnectionsService / InboundWebhookChannelRoutesService) and
 * by the conversion-rule "Envio ativo" cascade
 * (ProviderConversionRulesService). Every caller runs inside its own
 * transaction, so these are plain functions over Prisma.TransactionClient
 * instead of Nest providers - the rules module cannot import the inbound
 * webhooks module without a cycle.
 */

export const connectionNotFoundMessage = "Conexao de webhook nao encontrada";
export const concurrentMutationMessage =
  "A conexao foi alterada por outra operacao; tente novamente";
export const resourceNotFoundMessage = "Recurso de webhook nao encontrado";

const validRouteStatus = "valid";

export const connectionActivationInclude = {
  parserRelease: true,
} satisfies Prisma.InboundWebhookConnectionInclude;

export type PersistedInboundWebhookConnection =
  Prisma.InboundWebhookConnectionGetPayload<{
    include: typeof connectionActivationInclude;
  }>;

export const channelActivationInclude = {
  connection: {
    select: {
      id: true,
      workspaceId: true,
      provider: true,
      status: true,
      removedAt: true,
    },
  },
  routes: {
    where: {
      active: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.InboundWebhookChannelInclude;

export type PersistedInboundWebhookChannel =
  Prisma.InboundWebhookChannelGetPayload<{
    include: typeof channelActivationInclude;
  }>;

/**
 * Seat enforcement is billing-owned and optional in tests, so callers hand it
 * in. `enforcementEnabled` is only consulted at the exact point the legacy
 * inline code consulted it, because it throws when enforcement is on without a
 * seat service wired.
 */
export type ExternalChannelSeatHook = {
  enforcementEnabled(): boolean;
  activateSeat(
    transaction: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      channelId: string;
      // "uazapi" is excluded on purpose: those channels already hold a
      // WhatsappInstance seat, so every caller narrows it away first.
      provider: Exclude<$Enums.InboundWebhookProvider, "uazapi">;
      normalizedPhone: string | null;
      actorUserId: string;
    },
  ): Promise<unknown>;
};

export async function requireInboundWebhookConnection(
  client: Pick<Prisma.TransactionClient, "inboundWebhookConnection">,
  workspaceId: string,
  connectionId: string,
): Promise<PersistedInboundWebhookConnection> {
  const connection = await client.inboundWebhookConnection.findFirst({
    where: {
      id: connectionId,
      workspaceId,
      removedAt: null,
    },
    include: connectionActivationInclude,
  });

  if (!connection) {
    throw new NotFoundException(connectionNotFoundMessage);
  }

  return connection;
}

export async function requireInboundWebhookChannel(
  client: Pick<Prisma.TransactionClient, "inboundWebhookChannel">,
  workspaceId: string,
  channelId: string,
): Promise<PersistedInboundWebhookChannel> {
  const channel = await client.inboundWebhookChannel.findFirst({
    where: {
      id: channelId,
      workspaceId,
      connection: {
        is: {
          workspaceId,
          removedAt: null,
        },
      },
    },
    include: channelActivationInclude,
  });

  if (
    !channel ||
    channel.workspaceId !== workspaceId ||
    channel.connection.workspaceId !== workspaceId ||
    channel.connection.removedAt !== null
  ) {
    throw new NotFoundException(resourceNotFoundMessage);
  }

  return channel;
}

export function nextMutationTime(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1));
}

/**
 * UAZAPI/NOD resolves the Meta destination per ad at send time
 * (InboundWebhookMetaRouteReaderService.previewRoute by adId), so its bridged
 * channels never carry InboundWebhookChannelRoute rows. Requiring one there
 * would make every UAZAPI activation impossible.
 */
export function metaRouteRequiredForProvider(provider: string): boolean {
  return provider !== "uazapi";
}

/**
 * Fase 4b (Unnichat): a number is routable when its effective routing (inherit
 * the workspace or its own override) is eligible, or when it has exactly one
 * authorized page/pixel destination for CTWA leads without an ad id. Other
 * providers keep requiring an eligible saved route.
 */
async function unnichatChannelRoutable(
  transaction: Prisma.TransactionClient,
  channel: PersistedInboundWebhookChannel,
): Promise<boolean> {
  return (
    (await effectiveUnnichatMetaRouting(transaction, channel)).eligible ||
    (await resolveCtwaDestination(transaction, channel)).kind ===
      "authorized_ctwa_destination"
  );
}

export async function applyInboundWebhookChannelStatus(
  transaction: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    channelId: string;
    status: InboundWebhookChannelStatusUpdateInputDto["status"];
    actorUserId: string;
    requireValidMetaRoute: boolean;
    seats: ExternalChannelSeatHook;
  },
): Promise<PersistedInboundWebhookChannel> {
  const { workspaceId, channelId, status, actorUserId } = input;
  const current = await requireInboundWebhookChannel(
    transaction,
    workspaceId,
    channelId,
  );

  if (
    status === "active" &&
    input.requireValidMetaRoute &&
    !(current.connection.provider === "unnichat"
      ? await unnichatChannelRoutable(transaction, current)
      : await hasEligibleInboundMetaRoute(
          transaction,
          workspaceId,
          current.routes,
        ))
  ) {
    throw new ConflictException(
      current.connection.provider === "unnichat"
        ? "Configure a Meta deste número (página e pixel do workspace ou rotas próprias) antes de ativar o canal"
        : "Configure uma rota Meta valida antes de ativar o canal",
    );
  }

  if (
    status === "active" &&
    current.connection.status === "production" &&
    current.connection.provider !== "uazapi" &&
    input.seats.enforcementEnabled()
  ) {
    // UAZAPI/NOD channels are billed as WhatsappInstance seats already
    // (see WhatsappSeatProvider "uazapi"); billing them again here as an
    // "external channel" seat would double-charge the workspace.
    await input.seats.activateSeat(transaction, {
      workspaceId,
      channelId,
      provider: current.connection.provider,
      normalizedPhone: current.connectedPhone || null,
      actorUserId,
    });
  }

  const updatedAt = nextMutationTime(current.updatedAt);
  const changed = await transaction.inboundWebhookChannel.updateMany({
    where: {
      id: channelId,
      workspaceId,
      updatedAt: current.updatedAt,
    },
    data: {
      status,
      productionActivatedAt:
        status === "active" && current.connection.status === "production"
          ? current.status === "active"
            ? (current.productionActivatedAt ?? updatedAt)
            : updatedAt
          : null,
      updatedAt,
    },
  });

  if (changed.count !== 1) {
    throw new NotFoundException(resourceNotFoundMessage);
  }

  const updated = await requireInboundWebhookChannel(
    transaction,
    workspaceId,
    channelId,
  );

  await createActivationAudit(transaction, {
    workspaceId,
    actorUserId,
    action:
      status === "paused"
        ? "inbound_webhook.channel_paused"
        : "inbound_webhook.channel_activated",
    targetType: "InboundWebhookChannel",
    targetId: channelId,
    resultStatus: status,
    beforeSummary: channelStatusAuditSummary(current),
    afterSummary: channelStatusAuditSummary(updated),
  });

  return updated;
}

export async function applyInboundWebhookConnectionStatus(
  transaction: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    connectionId: string;
    status: InboundWebhookConnectionStatusUpdateInputDto["status"];
    actorUserId: string;
    requireValidMetaRoute: boolean;
    seats: ExternalChannelSeatHook;
    env?: RuntimeEnv;
  },
): Promise<PersistedInboundWebhookConnection> {
  const { workspaceId, connectionId, status, actorUserId } = input;
  const current = await requireInboundWebhookConnection(
    transaction,
    workspaceId,
    connectionId,
  );

  if (status === "production") {
    assertMetaCloudSigningConfigured(current.provider, input.env ?? process.env);
    await assertProductionReady(transaction, current, {
      requireValidMetaRoute: input.requireValidMetaRoute,
    });
    await activateProductionSeats(transaction, current, {
      actorUserId,
      seats: input.seats,
    });
  }

  const updatedAt = nextMutationTime(current.updatedAt);
  const claimed = await transaction.inboundWebhookConnection.updateMany({
    where: {
      id: current.id,
      workspaceId: current.workspaceId,
      removedAt: null,
      updatedAt: current.updatedAt,
    },
    data: {
      status,
      productionActivatedAt:
        status === "production"
          ? current.status === "production"
            ? (current.productionActivatedAt ?? updatedAt)
            : updatedAt
          : null,
      updatedAt,
    },
  });

  if (claimed.count !== 1) {
    throw new ConflictException(concurrentMutationMessage);
  }

  await transaction.inboundWebhookChannel.updateMany({
    where: {
      workspaceId,
      connectionId,
      status: "active",
    },
    data: {
      productionActivatedAt: status === "production" ? updatedAt : null,
      updatedAt,
    },
  });

  const connection = await requireInboundWebhookConnection(
    transaction,
    workspaceId,
    connectionId,
  );

  await createActivationAudit(transaction, {
    workspaceId,
    actorUserId,
    action: connectionStatusAuditAction(status),
    targetType: "InboundWebhookConnection",
    targetId: connection.id,
    resultStatus: connection.status,
    beforeSummary: connectionAuditSummary(current),
    afterSummary: connectionAuditSummary(connection),
  });

  return connection;
}

export function connectionStatusAuditAction(
  status: InboundWebhookConnectionStatusUpdateInputDto["status"],
): string {
  if (status === "production") {
    return "inbound_webhook.connection_promoted";
  }

  if (status === "paused") {
    return "inbound_webhook.connection_paused";
  }

  return "inbound_webhook.connection_observation";
}

export function connectionAuditSummary(
  connection: PersistedInboundWebhookConnection,
): Prisma.InputJsonObject {
  return {
    connectionId: connection.id,
    provider: connection.provider,
    parserVersion: connection.parserRelease.version,
    status: connection.status,
    productionActivatedAt:
      connection.productionActivatedAt?.toISOString() ?? null,
  };
}

export function channelStatusAuditSummary(
  channel: Pick<
    PersistedInboundWebhookChannel,
    "id" | "connectionId" | "status" | "productionActivatedAt"
  >,
): Prisma.InputJsonObject {
  return {
    channelId: channel.id,
    connectionId: channel.connectionId,
    status: channel.status,
    productionActivatedAt: channel.productionActivatedAt?.toISOString() ?? null,
  };
}

async function assertProductionReady(
  transaction: Prisma.TransactionClient,
  connection: PersistedInboundWebhookConnection,
  options: { requireValidMetaRoute: boolean },
): Promise<void> {
  if (connection.parserRelease.provider !== connection.provider || !inboundParserProductionEligible(connection.parserRelease)) {
    throw new ConflictException(
      "Certifique o parser antes de ativar o envio automatico. Esta versao da integracao nao e nativa validada ou foi retirada.",
    );
  }

  const activeChannels = await transaction.inboundWebhookChannel.findMany({
    where: {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      status: "active",
    },
    select: {
      id: true,
      routes: {
        where: {
          active: true,
          validationStatus: validRouteStatus,
          metaBusinessConnectionId: { not: null },
        },
      },
    },
  });

  if (activeChannels.length === 0) {
    throw new ConflictException(
      "Ative ao menos um canal validado antes da producao",
    );
  }

  if (options.requireValidMetaRoute) {
    for (const channel of activeChannels) {
      if (
        !(connection.provider === "unnichat"
          ? await unnichatChannelRoutable(
              transaction,
              await requireInboundWebhookChannel(
                transaction,
                connection.workspaceId,
                channel.id,
              ),
            )
          : await hasEligibleInboundMetaRoute(
              transaction,
              connection.workspaceId,
              channel.routes,
            ))
      ) {
        throw new ConflictException(
          "Todo canal ativo precisa de uma rota Meta valida",
        );
      }
    }
  }

  const activeReplay = await transaction.inboundWebhookReplayBatch.count({
    where: {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      status: { in: ["queued", "processing"] },
    },
  });

  if (activeReplay > 0 || (connection.provider === "meta_cloud" && await studentReplayDispatchUnsettled(transaction, connection.workspaceId, connection.id))) {
    throw new ConflictException(
      "Finalize o replay em andamento antes de ativar a producao",
    );
  }
}

async function activateProductionSeats(
  transaction: Prisma.TransactionClient,
  connection: PersistedInboundWebhookConnection,
  options: { actorUserId: string; seats: ExternalChannelSeatHook },
): Promise<void> {
  if (!options.seats.enforcementEnabled() || connection.provider === "uazapi") {
    // UAZAPI/NOD channels are billed as WhatsappInstance seats already
    // (see WhatsappSeatProvider "uazapi"); billing them again here as an
    // "external channel" seat would double-charge the workspace.
    return;
  }

  const channels = await transaction.inboundWebhookChannel.findMany({
    where: {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      status: "active",
    },
    select: {
      id: true,
      connectedPhone: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  for (const channel of channels) {
    await options.seats.activateSeat(transaction, {
      workspaceId: connection.workspaceId,
      channelId: channel.id,
      provider: connection.provider,
      normalizedPhone: channel.connectedPhone || null,
      actorUserId: options.actorUserId,
    });
  }
}

async function createActivationAudit(
  transaction: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    resultStatus: string;
    beforeSummary: Prisma.InputJsonObject;
    afterSummary: Prisma.InputJsonObject;
  },
): Promise<void> {
  await transaction.auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      actorType: "user",
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: null,
      sourceIp: null,
      resultStatus: input.resultStatus,
      beforeSummary: input.beforeSummary,
      afterSummary: input.afterSummary,
    },
  });
}
