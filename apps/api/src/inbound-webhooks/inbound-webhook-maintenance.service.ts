import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import { InboundWebhookDiagnosticsService } from "./inbound-webhook-diagnostics.service";
import { InboundWebhookQueueService } from "./inbound-webhook-queue.service";
import { InboundWebhookProductionIntakeService } from "./inbound-webhook-production-intake.service";
import {
  InboundWebhookParserRegistry,
  InboundWebhookParserResolutionError,
} from "./providers/inbound-webhook-parser.registry";

export const INBOUND_WEBHOOK_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1_000;
export const INBOUND_WEBHOOK_MAINTENANCE_INITIAL_DELAY_MS = 90 * 1_000;
export const INBOUND_WEBHOOK_RECOVERY_GRACE_MS = 60 * 1_000;
export const INBOUND_WEBHOOK_RECOVERY_CLAIM_TTL_MS = 5 * 60 * 1_000;
export const INBOUND_WEBHOOK_MAINTENANCE_BATCH_SIZE = 100;
export const INBOUND_WEBHOOK_PAYLOAD_CLEANUP_BATCH_SIZE = 250;
/**
 * Fase 5.3: receipts of the workspace URLs that never reached a rule
 * (pending, unattributed, ignored, invalid) are deleted after this many days.
 * Routed receipts stay: they point to the rule's delivery and execution.
 */
export const INTEGRATION_RECEIPT_RETENTION_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1_000;

const maintenanceFailedCode = "inbound_webhook_maintenance_failed";
const payloadUnavailableCode = "inbound_webhook_payload_unavailable";
const recoveryQueueErrorCode = "inbound_webhook_recovery_enqueue_failed";

const recoveryCandidateSelect = {
  id: true,
  workspaceId: true,
  connectionId: true,
  provider: true,
  parserVersion: true,
  queuedAt: true,
  connection: {
    select: {
      parserRelease: {
        select: {
          provider: true,
          version: true,
          status: true,
        },
      },
    },
  },
} satisfies Prisma.InboundWebhookDeliverySelect;

type RecoveryCandidate = Prisma.InboundWebhookDeliveryGetPayload<{
  select: typeof recoveryCandidateSelect;
}>;

export type InboundWebhookMaintenanceResult = {
  enabled: boolean;
  payloadsCleared: number;
  integrationReceiptsDeleted: number;
  unavailableMarked: number;
  recoveryCandidates: number;
  recoveryClaims: number;
  enqueued: number;
  existingJobs: number;
  parserFailures: number;
  queueFailures: number;
  productionCandidates: number;
  productionEnqueued: number;
  productionExistingJobs: number;
  productionQueueFailures: number;
  providerConversionCandidates: number;
  providerConversionEnqueued: number;
  providerConversionExistingJobs: number;
  providerConversionQueueFailures: number;
};

function emptyResult(enabled: boolean): InboundWebhookMaintenanceResult {
  return {
    enabled,
    payloadsCleared: 0,
    integrationReceiptsDeleted: 0,
    unavailableMarked: 0,
    recoveryCandidates: 0,
    recoveryClaims: 0,
    enqueued: 0,
    existingJobs: 0,
    parserFailures: 0,
    queueFailures: 0,
    productionCandidates: 0,
    productionEnqueued: 0,
    productionExistingJobs: 0,
    productionQueueFailures: 0,
    providerConversionCandidates: 0,
    providerConversionEnqueued: 0,
    providerConversionExistingJobs: 0,
    providerConversionQueueFailures: 0,
  };
}

@Injectable()
export class InboundWebhookMaintenanceService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(InboundWebhookMaintenanceService.name);
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv,
    @Inject(InboundWebhookQueueService)
    private readonly queue: InboundWebhookQueueService,
    @Inject(InboundWebhookParserRegistry)
    private readonly parserRegistry: InboundWebhookParserRegistry,
    @Inject(InboundWebhookDiagnosticsService)
    private readonly diagnostics: InboundWebhookDiagnosticsService,
    @Inject(InboundWebhookProductionIntakeService)
    private readonly productionIntake: InboundWebhookProductionIntakeService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.shouldStart()) {
      return;
    }

    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      this.runScheduledMaintenance();
      this.timer = setInterval(
        () => this.runScheduledMaintenance(),
        INBOUND_WEBHOOK_MAINTENANCE_INTERVAL_MS,
      );
    }, INBOUND_WEBHOOK_MAINTENANCE_INITIAL_DELAY_MS);
  }

  onModuleDestroy(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runMaintenance(
    now = new Date(),
  ): Promise<InboundWebhookMaintenanceResult> {
    if (!parseInboundWebhooksConfig(this.env).enabled) {
      return emptyResult(false);
    }

    if (this.running) {
      return emptyResult(true);
    }

    this.running = true;

    try {
      const result = emptyResult(true);
      result.payloadsCleared =
        (await this.clearExpiredPayloads(now)) +
        (await this.clearExpiredIntegrationReceiptPayloads(now));
      result.integrationReceiptsDeleted =
        await this.deleteOldIntegrationReceipts(now);
      result.unavailableMarked =
        await this.markUnavailablePendingDeliveries(now);

      const recovery = await this.recoverPendingDeliveries(now);
      result.recoveryCandidates = recovery.candidates;
      result.recoveryClaims = recovery.claims;
      result.enqueued = recovery.enqueued;
      result.existingJobs = recovery.existingJobs;
      result.parserFailures = recovery.parserFailures;
      result.queueFailures = recovery.queueFailures;
      const productionRecovery =
        await this.productionIntake.recoverPendingItems(now);
      result.productionCandidates = productionRecovery.eligible;
      result.productionEnqueued = productionRecovery.queued;
      result.productionExistingJobs = productionRecovery.existing;
      result.productionQueueFailures = productionRecovery.queueFailures;
      result.providerConversionCandidates = productionRecovery.providerEligible;
      result.providerConversionEnqueued = productionRecovery.providerQueued;
      result.providerConversionExistingJobs =
        productionRecovery.providerExisting;
      result.providerConversionQueueFailures =
        productionRecovery.providerQueueFailures;

      return result;
    } catch {
      await this.recordGlobalDiagnostic();
      throw new Error("Inbound webhook maintenance failed");
    } finally {
      this.running = false;
    }
  }

  private shouldStart(): boolean {
    if (!parseInboundWebhooksConfig(this.env).enabled) {
      return false;
    }

    return !(
      this.env.NODE_ENV === "test" &&
      this.env.INBOUND_WEBHOOKS_ENABLED === undefined
    );
  }

  private runScheduledMaintenance(): void {
    void this.runMaintenance()
      .then((result) => {
        this.logger.log(
          [
            `Inbound webhook maintenance cleared=${result.payloadsCleared}`,
            `integrationReceiptsDeleted=${result.integrationReceiptsDeleted}`,
            `unavailable=${result.unavailableMarked}`,
            `candidates=${result.recoveryCandidates}`,
            `claimed=${result.recoveryClaims}`,
            `enqueued=${result.enqueued}`,
            `existing=${result.existingJobs}`,
            `parserFailures=${result.parserFailures}`,
            `queueFailures=${result.queueFailures}`,
            `productionCandidates=${result.productionCandidates}`,
            `productionEnqueued=${result.productionEnqueued}`,
            `productionExisting=${result.productionExistingJobs}`,
            `productionQueueFailures=${result.productionQueueFailures}`,
            `providerConversionCandidates=${result.providerConversionCandidates}`,
            `providerConversionEnqueued=${result.providerConversionEnqueued}`,
            `providerConversionExisting=${result.providerConversionExistingJobs}`,
            `providerConversionQueueFailures=${result.providerConversionQueueFailures}`,
          ].join("; "),
        );
      })
      .catch(() => {
        this.logger.warn("Inbound webhook maintenance failed");
      });
  }

  private async clearExpiredPayloads(now: Date): Promise<number> {
    let total = 0;

    while (true) {
      const candidates = await this.prisma.inboundWebhookDelivery.findMany({
        where: {
          payloadExpiresAt: {
            lte: now,
          },
          OR: [
            { encryptedPayload: { not: null } },
            { payloadIv: { not: null } },
            { payloadTag: { not: null } },
            { encryptionKeyVersion: { not: null } },
          ],
        },
        select: {
          id: true,
        },
        orderBy: [{ payloadExpiresAt: "asc" }, { id: "asc" }],
        take: INBOUND_WEBHOOK_PAYLOAD_CLEANUP_BATCH_SIZE,
      });

      if (candidates.length === 0) {
        return total;
      }

      const cleared = await this.prisma.inboundWebhookDelivery.updateMany({
        where: {
          id: {
            in: candidates.map((candidate) => candidate.id),
          },
          payloadExpiresAt: {
            lte: now,
          },
          OR: [
            { encryptedPayload: { not: null } },
            { payloadIv: { not: null } },
            { payloadTag: { not: null } },
            { encryptionKeyVersion: { not: null } },
          ],
        },
        data: {
          encryptedPayload: null,
          payloadIv: null,
          payloadTag: null,
          encryptionKeyVersion: null,
        },
      });

      total += cleared.count;

      if (cleared.count === 0) {
        return total;
      }
    }
  }

  /**
   * Fase 5.3: receipts of the workspace URLs keep the raw postback (buyer
   * data) only for the same retention as deliveries; the product and reason
   * stay for "Produtos detectados" and "Vendas sem atribuição".
   */
  private async clearExpiredIntegrationReceiptPayloads(
    now: Date,
  ): Promise<number> {
    const where = {
      payloadExpiresAt: { lte: now },
      OR: [
        { encryptedPayload: { not: null } },
        { payloadIv: { not: null } },
        { payloadTag: { not: null } },
        { encryptionKeyVersion: { not: null } },
      ],
    } satisfies Prisma.IntegrationEndpointEventWhereInput;
    let total = 0;
    // Batches, like the delivery payload cleanup: short statements only.
    for (;;) {
      const batch = await this.prisma.integrationEndpointEvent.findMany({
        where,
        select: { id: true },
        orderBy: [{ payloadExpiresAt: "asc" }, { id: "asc" }],
        take: INBOUND_WEBHOOK_PAYLOAD_CLEANUP_BATCH_SIZE,
      });
      if (batch.length === 0) return total;
      const cleared = await this.prisma.integrationEndpointEvent.updateMany({
        where: { ...where, id: { in: batch.map((row) => row.id) } },
        data: {
          encryptedPayload: null,
          payloadIv: null,
          payloadTag: null,
          encryptionKeyVersion: null,
        },
      });
      total += cleared.count;
      if (cleared.count === 0) return total;
    }
  }

  /**
   * Fase 5.3: unrouted receipts (never delivered to a rule) older than
   * INTEGRATION_RECEIPT_RETENTION_DAYS since their last attempt are deleted.
   * "routed" ones stay with the rule's delivery/execution they point to.
   */
  private async deleteOldIntegrationReceipts(now: Date): Promise<number> {
    const where = {
      status: { in: ["pending", "unattributed", "ignored", "invalid"] },
      lastReceivedAt: {
        lt: new Date(now.getTime() - INTEGRATION_RECEIPT_RETENTION_DAYS * DAY_MS),
      },
    } satisfies Prisma.IntegrationEndpointEventWhereInput;
    let total = 0;
    for (;;) {
      const batch = await this.prisma.integrationEndpointEvent.findMany({
        where,
        select: { id: true },
        orderBy: [{ lastReceivedAt: "asc" }, { id: "asc" }],
        take: INBOUND_WEBHOOK_PAYLOAD_CLEANUP_BATCH_SIZE,
      });
      if (batch.length === 0) return total;
      // The status/age filter is repeated: a retry that just touched a row
      // (lastReceivedAt moved) keeps it.
      const deleted = await this.prisma.integrationEndpointEvent.deleteMany({
        where: { ...where, id: { in: batch.map((row) => row.id) } },
      });
      total += deleted.count;
      if (deleted.count === 0) return total;
    }
  }

  private async markUnavailablePendingDeliveries(now: Date): Promise<number> {
    const recoveryBefore = new Date(
      now.getTime() - INBOUND_WEBHOOK_RECOVERY_GRACE_MS,
    );
    const candidates = await this.prisma.inboundWebhookDelivery.findMany({
      where: {
        status: "pending",
        lastReceivedAt: {
          lte: recoveryBefore,
        },
        OR: [
          { payloadExpiresAt: { lte: now } },
          { encryptedPayload: null },
          { payloadIv: null },
          { payloadTag: null },
          { encryptionKeyVersion: null },
        ],
      },
      select: {
        id: true,
        workspaceId: true,
        connectionId: true,
      },
      orderBy: [{ lastReceivedAt: "asc" }, { id: "asc" }],
      take: INBOUND_WEBHOOK_MAINTENANCE_BATCH_SIZE,
    });
    let marked = 0;

    for (const candidate of candidates) {
      const updated = await this.prisma.inboundWebhookDelivery.updateMany({
        where: {
          id: candidate.id,
          workspaceId: candidate.workspaceId,
          connectionId: candidate.connectionId,
          status: "pending",
          OR: [
            { payloadExpiresAt: { lte: now } },
            { encryptedPayload: null },
            { payloadIv: null },
            { payloadTag: null },
            { encryptionKeyVersion: null },
          ],
        },
        data: {
          status: "failed",
          classification: "invalid_payload",
          parseErrorCode: payloadUnavailableCode,
          processedAt: now,
        },
      });

      if (updated.count !== 1) {
        continue;
      }

      marked += 1;
      await this.recordDiagnostic({
        workspaceId: candidate.workspaceId,
        deliveryId: candidate.id,
        connectionId: candidate.connectionId,
        errorCode: payloadUnavailableCode,
        operation: "payload_retention",
      });
    }

    return marked;
  }

  private async recoverPendingDeliveries(now: Date): Promise<{
    candidates: number;
    claims: number;
    enqueued: number;
    existingJobs: number;
    parserFailures: number;
    queueFailures: number;
  }> {
    const recoveryBefore = new Date(
      now.getTime() - INBOUND_WEBHOOK_RECOVERY_GRACE_MS,
    );
    const staleClaimBefore = new Date(
      now.getTime() - INBOUND_WEBHOOK_RECOVERY_CLAIM_TTL_MS,
    );
    const candidates = await this.prisma.inboundWebhookDelivery.findMany({
      where: {
        status: "pending",
        lastReceivedAt: {
          lte: recoveryBefore,
        },
        payloadExpiresAt: {
          gt: now,
        },
        encryptedPayload: {
          not: null,
        },
        payloadIv: {
          not: null,
        },
        payloadTag: {
          not: null,
        },
        encryptionKeyVersion: {
          not: null,
        },
        OR: [
          { queuedAt: null },
          {
            queuedAt: {
              lte: staleClaimBefore,
            },
          },
        ],
        connection: {
          status: { in: ["observation", "production"] },
          removedAt: null,
        },
      },
      select: recoveryCandidateSelect,
      orderBy: [{ lastReceivedAt: "asc" }, { id: "asc" }],
      take: INBOUND_WEBHOOK_MAINTENANCE_BATCH_SIZE,
    });
    const result = {
      candidates: candidates.length,
      claims: 0,
      enqueued: 0,
      existingJobs: 0,
      parserFailures: 0,
      queueFailures: 0,
    };

    for (const candidate of candidates) {
      const parserErrorCode = this.parserErrorCode(candidate);

      if (parserErrorCode) {
        const marked = await this.markParserFailure(
          candidate,
          parserErrorCode,
          now,
        );

        if (marked) {
          result.parserFailures += 1;
        }

        continue;
      }

      const claimedAt = new Date(
        Math.max(now.getTime(), (candidate.queuedAt?.getTime() ?? 0) + 1),
      );
      const claim = await this.prisma.inboundWebhookDelivery.updateMany({
        where: {
          id: candidate.id,
          workspaceId: candidate.workspaceId,
          connectionId: candidate.connectionId,
          status: "pending",
          lastReceivedAt: {
            lte: recoveryBefore,
          },
          queuedAt: candidate.queuedAt,
          payloadExpiresAt: {
            gt: now,
          },
          encryptedPayload: {
            not: null,
          },
          payloadIv: {
            not: null,
          },
          payloadTag: {
            not: null,
          },
          encryptionKeyVersion: {
            not: null,
          },
          connection: {
            status: { in: ["observation", "production"] },
            removedAt: null,
            parserRelease: {
              provider: candidate.provider,
              version: candidate.parserVersion,
              status: candidate.connection.parserRelease.status,
            },
          },
        },
        data: {
          queuedAt: claimedAt,
        },
      });

      if (claim.count !== 1) {
        continue;
      }

      result.claims += 1;

      try {
        const queued = await this.queue.enqueueDelivery({
          deliveryId: candidate.id,
          connectionId: candidate.connectionId,
          workspaceId: candidate.workspaceId,
        });

        if (queued.status === "existing") {
          result.existingJobs += 1;
        } else {
          result.enqueued += 1;
        }

        await this.prisma.inboundWebhookDelivery.updateMany({
          where: {
            id: candidate.id,
            workspaceId: candidate.workspaceId,
            connectionId: candidate.connectionId,
            status: "pending",
            queuedAt: claimedAt,
          },
          data: {
            status: "queued",
          },
        });
      } catch {
        result.queueFailures += 1;

        if (candidate.queuedAt === null) {
          await this.recordDiagnostic({
            workspaceId: candidate.workspaceId,
            deliveryId: candidate.id,
            connectionId: candidate.connectionId,
            errorCode: recoveryQueueErrorCode,
            operation: "queue_recovery",
          });
        }
      }
    }

    return result;
  }

  private parserErrorCode(candidate: RecoveryCandidate): string | null {
    if (
      candidate.connection.parserRelease.provider !== candidate.provider ||
      candidate.connection.parserRelease.version !== candidate.parserVersion
    ) {
      return "inbound_webhook_parser_context_invalid";
    }

    try {
      this.parserRegistry.resolve({
        provider: candidate.provider,
        parserVersion: candidate.parserVersion,
        parserReleaseStatus: candidate.connection.parserRelease.status,
      });

      return null;
    } catch (error) {
      return error instanceof InboundWebhookParserResolutionError
        ? error.code
        : "inbound_webhook_parser_unavailable";
    }
  }

  private async markParserFailure(
    candidate: RecoveryCandidate,
    errorCode: string,
    now: Date,
  ): Promise<boolean> {
    const marked = await this.prisma.inboundWebhookDelivery.updateMany({
      where: {
        id: candidate.id,
        workspaceId: candidate.workspaceId,
        connectionId: candidate.connectionId,
        status: "pending",
        queuedAt: candidate.queuedAt,
      },
      data: {
        status: "failed",
        classification: null,
        parseErrorCode: errorCode,
        processedAt: now,
      },
    });

    if (marked.count !== 1) {
      return false;
    }

    await this.recordDiagnostic({
      workspaceId: candidate.workspaceId,
      deliveryId: candidate.id,
      connectionId: candidate.connectionId,
      errorCode,
      operation: "parser_recovery",
    });

    return true;
  }

  private async recordDiagnostic(input: {
    workspaceId: string;
    deliveryId: string;
    connectionId: string;
    errorCode: string;
    operation: string;
  }): Promise<void> {
    try {
      await this.diagnostics.recordMaintenance({
        workspaceId: input.workspaceId,
        deliveryId: input.deliveryId,
        connectionId: input.connectionId,
        errorCode: input.errorCode,
        operation: input.operation,
        severity: "warning",
        status: "requires_review",
        title: "Inbound webhook requer revisao",
        message: "Uma entrega aceita nao pode ser processada automaticamente.",
      });
    } catch {
      this.logger.warn(
        `Inbound webhook maintenance diagnostic unavailable for delivery ${input.deliveryId}`,
      );
    }
  }

  private async recordGlobalDiagnostic(): Promise<void> {
    try {
      await this.diagnostics.recordMaintenance({
        errorCode: maintenanceFailedCode,
        operation: "maintenance_cycle",
        severity: "error",
        status: "failed",
        title: "Manutencao de inbound webhooks falhou",
        message:
          "A manutencao nao foi concluida e sera tentada novamente sem expor detalhes internos.",
      });
    } catch {
      this.logger.warn("Inbound webhook maintenance diagnostic unavailable");
    }
  }
}
