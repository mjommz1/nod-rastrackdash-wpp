import { inboundParserProductionEligible } from "./inbound-webhook-parser-eligibility";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import { InboundWebhookProductionQueueService } from "./inbound-webhook-production-queue.service";

export const INBOUND_WEBHOOK_PRODUCTION_RECOVERY_TTL_MS = 5 * 60 * 1_000;
export const INBOUND_WEBHOOK_PRODUCTION_RECOVERY_BATCH_SIZE = 100;

export type InboundWebhookProductionEnqueueResult = {
  eligible: number;
  persisted: number;
  queued: number;
  existing: number;
  queueFailures: number;
  providerEligible: number;
  providerQueued: number;
  providerExisting: number;
  providerQueueFailures: number;
};

function emptyResult(): InboundWebhookProductionEnqueueResult {
  return {
    eligible: 0,
    persisted: 0,
    queued: 0,
    existing: 0,
    queueFailures: 0,
    providerEligible: 0,
    providerQueued: 0,
    providerExisting: 0,
    providerQueueFailures: 0,
  };
}

@Injectable()
export class InboundWebhookProductionIntakeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InboundWebhookProductionQueueService)
    private readonly queue: InboundWebhookProductionQueueService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv,
  ) {}

  async enqueueDelivery(input: {
    workspaceId: string;
    connectionId: string;
    deliveryId: string;
  }): Promise<InboundWebhookProductionEnqueueResult> {
    if (!this.productionEnabled()) {
      return emptyResult();
    }

    const events = await this.prisma.inboundWebhookEvent.findMany({
      where: {
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        deliveryId: input.deliveryId,
        classification: "eligible_route_resolved",
        hasCtwa: true,
        // Fase 4b: an Unnichat CTWA entry without ad id is materialized only
        // through the number's unique authorized page/pixel destination
        // (ctwa_clid stays mandatory; the worker re-checks everything).
        OR: [
          { adId: { not: null } },
          {
            provider: "unnichat",
            adId: null,
            classificationReason: "authorized_ctwa_destination",
          },
        ],
        replayItem: null,
        productionItem: null,
      },
      select: {
        id: true,
        workspaceId: true,
        delivery: {
          select: {
            firstReceivedAt: true,
          },
        },
        connection: {
          select: {
            provider: true,
            status: true,
            removedAt: true,
            productionActivatedAt: true,
            parserRelease: {
              select: {
                status: true, provider: true, version: true,
              },
            },
          },
        },
        channel: {
          select: {
            status: true,
            productionActivatedAt: true,
          },
        },
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });
    const eligible = events.filter((event) =>
      this.isAfterActivationBoundary(event),
    );
    const result = emptyResult();
    result.eligible = eligible.length;

    if (eligible.length === 0) {
      return result;
    }

    const queuedAt = new Date();
    const persisted = await this.prisma.inboundWebhookProductionItem.createMany(
      {
        data: eligible.map((event) => ({
          workspaceId: event.workspaceId,
          eventId: event.id,
          status: "queued" as const,
          queuedAt,
        })),
        skipDuplicates: true,
      },
    );
    result.persisted = persisted.count;

    const items = await this.prisma.inboundWebhookProductionItem.findMany({
      where: {
        workspaceId: input.workspaceId,
        eventId: { in: eligible.map((event) => event.id) },
        status: "queued",
      },
      select: {
        id: true,
        workspaceId: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    await this.enqueueItems(items, result);
    return result;
  }

  async recoverPendingItems(
    now = new Date(),
  ): Promise<InboundWebhookProductionEnqueueResult> {
    if (!this.productionEnabled()) {
      return emptyResult();
    }

    const staleBefore = new Date(
      now.getTime() - INBOUND_WEBHOOK_PRODUCTION_RECOVERY_TTL_MS,
    );
    const items = await this.prisma.inboundWebhookProductionItem.findMany({
      where: {
        OR: [
          {
            status: "queued",
            queuedAt: { lte: staleBefore },
          },
          {
            status: "processing",
            lastAttemptedAt: { lte: staleBefore },
          },
        ],
      },
      select: {
        id: true,
        workspaceId: true,
      },
      orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
      take: INBOUND_WEBHOOK_PRODUCTION_RECOVERY_BATCH_SIZE,
    });
    const result = emptyResult();
    result.eligible = items.length;

    await this.enqueueItems(items, result);
    await this.recoverProviderConversions(result);
    return result;
  }

  private async recoverProviderConversions(
    result: InboundWebhookProductionEnqueueResult,
  ): Promise<void> {
    if (!this.conversionProductionEnabled()) {
      return;
    }

    const executions =
      await this.prisma.providerConversionRuleExecution.findMany({
        where: {
          status: "eligible",
          OR: [
            {
              providerRule: {
                mode: "production",
                removedAt: null,
                productionActivatedAt: { not: null },
                conversionRule: { active: true },
                parserRelease: { OR: [{ status: "certified" }, { provider: "meta_cloud", version: "v1", status: "observation_only" }] },
                connection: {
                  status: "production",
                  removedAt: null,
                },
              },
            },
            {
              // A rule spanning connections (no binding, Fase 3) is gated by
              // the connection that delivered the occurrence. The production
              // worker re-checks the full context before sending.
              providerRule: {
                connectionId: null,
                mode: "production",
                removedAt: null,
                productionActivatedAt: { not: null },
                conversionRule: { active: true },
              },
              sourceDelivery: {
                connection: {
                  status: "production",
                  removedAt: null,
                  parserRelease: { OR: [{ status: "certified" }, { provider: "meta_cloud", version: "v1", status: "observation_only" }] },
                },
              },
            },
          ],
        },
        select: {
          id: true,
          workspaceId: true,
        },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        take: INBOUND_WEBHOOK_PRODUCTION_RECOVERY_BATCH_SIZE,
      });

    result.providerEligible = executions.length;

    for (const execution of executions) {
      try {
        const queued = await this.queue.enqueueProviderConversion({
          providerConversionExecutionId: execution.id,
          workspaceId: execution.workspaceId,
        });

        if (queued.status === "existing") {
          result.providerExisting += 1;
        } else {
          result.providerQueued += 1;
        }
      } catch {
        result.providerQueueFailures += 1;
      }
    }
  }

  private async enqueueItems(
    items: Array<{ id: string; workspaceId: string }>,
    result: InboundWebhookProductionEnqueueResult,
  ): Promise<void> {
    for (const item of items) {
      try {
        const queued = await this.queue.enqueueItem({
          productionItemId: item.id,
          workspaceId: item.workspaceId,
        });

        if (queued.status === "existing") {
          result.existing += 1;
        } else {
          result.queued += 1;
        }
      } catch {
        result.queueFailures += 1;
      }
    }
  }

  private isAfterActivationBoundary(event: {
    delivery: { firstReceivedAt: Date };
    connection: {
      provider: string;
      status: string;
      removedAt: Date | null;
      productionActivatedAt: Date | null;
      parserRelease: { status: string; provider: string; version: string };
    };
    channel: {
      status: string;
      productionActivatedAt: Date | null;
    };
  }): boolean {
    const connectionActivatedAt = event.connection.productionActivatedAt;
    const channelActivatedAt = event.channel.productionActivatedAt;

    return Boolean(
      event.connection.status === "production" &&
      event.connection.removedAt === null &&
      event.connection.parserRelease.provider === event.connection.provider &&
      inboundParserProductionEligible(event.connection.parserRelease) &&
      (event.connection.provider !== "meta_cloud" || Boolean(this.env.META_APP_SECRET?.trim())) &&
      event.channel.status === "active" &&
      connectionActivatedAt &&
      channelActivatedAt &&
      event.delivery.firstReceivedAt >= connectionActivatedAt &&
      event.delivery.firstReceivedAt >= channelActivatedAt,
    );
  }

  private productionEnabled(): boolean {
    const config = parseInboundWebhooksConfig(this.env);

    return config.enabled && config.productionEnabled;
  }

  private conversionProductionEnabled(): boolean {
    const config = parseInboundWebhooksConfig(this.env);

    return (
      config.enabled &&
      config.productionEnabled &&
      config.conversionRulesEnabled &&
      config.conversionProductionEnabled
    );
  }
}
