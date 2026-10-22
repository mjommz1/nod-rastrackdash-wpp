import { createHash, randomBytes } from "node:crypto";
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  InboundWebhookConnectionCreateInputDto,
  InboundWebhookConnectionCreateResultDto,
  InboundWebhookConnectionDto,
  InboundWebhookConnectionOverviewDto,
  InboundWebhookConnectionRotateSecretResultDto,
  InboundWebhookConnectionStatusUpdateInputDto,
  InboundWebhookCapabilitiesDto,
} from "@wpptrack/shared";
import { inboundWebhookProviders } from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import {
  applyInboundWebhookConnectionStatus,
  concurrentMutationMessage,
  connectionAuditSummary,
  connectionNotFoundMessage,
  type ExternalChannelSeatHook,
  metaRouteRequiredForProvider,
  nextMutationTime,
  type PersistedInboundWebhookConnection,
  requireInboundWebhookConnection,
} from "./inbound-webhook-production-activation";
import { UazapiConversionBridgeService } from "./uazapi-conversion-bridge.service";
import { effectiveInboundParserStatus } from "./inbound-webhook-parser-eligibility";
import { normalizePhoneIdentity } from "../common/phone/phone-identity";

const parserVersion = "v1";

type UnnichatConnectionBind = {
  providerChannelId: string;
  connectedPhone: string;
  channelName: string;
};

/**
 * Fase 4b: the Unnichat entry webhook carries no provider channel id, so the
 * connection is created already bound to the client's WhatsApp number. The
 * normalized phone is the stable channel identity, the same one the parser
 * receives from the connection (never from the provider payload).
 */
function resolveUnnichatConnectionBind(
  input: InboundWebhookConnectionCreateInputDto,
): UnnichatConnectionBind | null {
  if (input.provider !== "unnichat") return null;
  const connectedPhone = input.connectedPhone
    ? normalizePhoneIdentity(input.connectedPhone)
    : undefined;
  const channelName = input.displayName?.trim();
  if (!connectedPhone || !channelName || channelName.length > 120) return null;
  return { providerChannelId: connectedPhone, connectedPhone, channelName };
}

@Injectable()
export class InboundWebhookConnectionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv,
    @Optional()
    @Inject(UazapiConversionBridgeService)
    private readonly uazapiBridge?: UazapiConversionBridgeService,
  ) {}

  async getCapabilities(): Promise<InboundWebhookCapabilitiesDto> {
    const config = parseInboundWebhooksConfig(this.env);
    const releases = await this.prisma.inboundWebhookParserRelease.findMany({
      where: {
        provider: {
          in: [...inboundWebhookProviders],
        },
        version: parserVersion,
      },
      select: {
        provider: true,
        status: true,
      },
    });
    const releaseByProvider = new Map(
      releases.map((release) => [release.provider, release]),
    );

    return {
      enabled: config.enabled,
      productionEnabled: config.enabled && config.productionEnabled,
      // UAZAPI/NOD is bridged automatically from the WhatsApp instance and
      // never goes through the generic manual creation flow. Payt is a sales
      // platform with no WhatsApp number: its rules live in Conversoes.
      providers: inboundWebhookProviders
        .filter((provider) => provider !== "uazapi" && provider !== "payt")
        .map((provider) => {
          const release = releaseByProvider.get(provider);

          return {
            provider,
            parserVersion,
            parserReleaseStatus: release ? effectiveInboundParserStatus({ provider, version: parserVersion, status: release.status }) : null,
            creationEnabled:
              config.enabled === true &&
              release !== undefined &&
              release.status !== "retired",
          };
        }),
    };
  }

  async listConnections(
    workspaceId: string,
  ): Promise<InboundWebhookConnectionDto[]> {
    await this.syncUazapiBridges(workspaceId);

    const connections = await this.prisma.inboundWebhookConnection.findMany({
      where: {
        workspaceId,
        removedAt: null,
      },
      include: {
        parserRelease: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return connections.map((connection) => this.toDto(connection));
  }

  async getOverview(
    workspaceId: string,
    connectionId: string,
  ): Promise<InboundWebhookConnectionOverviewDto> {
    const connection = await this.requireConnection(
      this.prisma,
      workspaceId,
      connectionId,
    );
    const [eventCounts, deliveries] = await Promise.all([
      this.prisma.inboundWebhookEvent.groupBy({
        by: ["classification"],
        where: {
          workspaceId,
          connectionId,
        },
        _count: {
          _all: true,
        },
      }),
      this.prisma.inboundWebhookDelivery.findMany({
        where: {
          workspaceId,
          connectionId,
        },
        select: {
          attemptCount: true,
          classification: true,
        },
      }),
    ]);
    const countsByClassification = new Map(
      eventCounts.map((row) => [row.classification, row._count._all]),
    );
    // Fase 4b: the Unnichat sale automation has its own parser release.
    const automationParserRelease =
      connection.provider === "unnichat"
        ? await this.prisma.inboundWebhookParserRelease.findFirst({
            where: { provider: "unnichat", version: "automation-v1" },
            select: { id: true, version: true, status: true },
          })
        : undefined;

    return {
      ...(automationParserRelease !== undefined
        ? { automationParserRelease }
        : {}),
      connection: this.toDto(connection),
      counters: {
        eligibleRouted:
          countsByClassification.get("eligible_route_resolved") ?? 0,
        eligibleUnresolved:
          countsByClassification.get("eligible_route_unresolved") ?? 0,
        ignoredNoCtwa: countsByClassification.get("ignored_no_ctwa") ?? 0,
        duplicate: deliveries.reduce(
          (total, delivery) => total + Math.max(0, delivery.attemptCount - 1),
          0,
        ),
        invalid: deliveries.filter(
          (delivery) => delivery.classification === "invalid_payload",
        ).length,
      },
    };
  }

  async getConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<InboundWebhookConnectionDto> {
    return this.toDto(
      await this.requireConnection(this.prisma, workspaceId, connectionId),
    );
  }

  async createConnection(
    workspaceId: string,
    input: InboundWebhookConnectionCreateInputDto,
    actorUserId: string,
  ): Promise<InboundWebhookConnectionCreateResultDto> {
    if (input.provider === "uazapi") {
      // UAZAPI/NOD connections are provisioned automatically from the
      // workspace's WhatsApp instance (see UazapiConversionBridgeService);
      // they never go through the generic secret-based creation flow.
      throw new ConflictException(
        "Conexoes UAZAPI sao criadas automaticamente a partir da instancia WhatsApp",
      );
    }
    if (input.provider === "payt") {
      // Payt has no WhatsApp number: a Payt rule is created in Conversões
      // and bound to the connection of its WhatsApp numbers.
      throw new ConflictException(
        "A Payt não usa conexão própria: crie a regra de venda em Conversões",
      );
    }
    const unnichatBind = resolveUnnichatConnectionBind(input);
    if (input.provider === "unnichat" && !unnichatBind) {
      // The shared schema already requires it; keep the service boundary
      // fail-closed for direct callers too: the connection must own the
      // client's number before any payload can be parsed.
      throw new ConflictException(
        "Conexões Unnichat exigem o número de WhatsApp do cliente",
      );
    }

    const config = this.requireEnabledConfig();
    const secret = this.generateSecret();
    const secretHash = this.hashSecret(secret);

    const connection = await this.prisma.$transaction(async (transaction) => {
      const release = await transaction.inboundWebhookParserRelease.findFirst({
        where: {
          provider: input.provider,
          version: parserVersion,
          status: {
            not: "retired",
          },
        },
      });

      if (!release) {
        throw new ConflictException(
          "Versao de observacao do provedor indisponivel",
        );
      }

      const created = await transaction.inboundWebhookConnection.create({
        data: {
          workspaceId,
          provider: input.provider,
          displayName: input.displayName,
          parserReleaseId: release.id,
          secretHash,
          status: "observation",
          createdByUserId: actorUserId,
        },
        include: {
          parserRelease: true,
        },
      });

      if (unnichatBind) {
        await transaction.inboundWebhookChannel.create({
          data: {
            metaRoutingMode: "inherit_workspace",
            workspaceId,
            connectionId: created.id,
            organizationId: workspaceId,
            providerChannelId: unnichatBind.providerChannelId,
            connectedPhone: unnichatBind.connectedPhone,
            channelName: unnichatBind.channelName,
            status: "discovered",
            conversionEngineMode: "canonical",
            firstSeenAt: created.createdAt,
            lastSeenAt: created.createdAt,
          },
        });
      }

      await this.createAudit(transaction, {
        workspaceId,
        actorUserId,
        action: "inbound_webhook.connection_created",
        targetId: created.id,
        resultStatus: created.status,
        beforeSummary: undefined,
        afterSummary: this.auditSummary(created),
      });

      return created;
    });

    return {
      connection: this.toDto(connection),
      secret,
      webhookUrl: this.buildWebhookUrl(
        config.apiPublicUrl,
        connection.id,
        secret,
        connection.provider,
      ),
    };
  }

  async rotateSecret(
    workspaceId: string,
    connectionId: string,
    actorUserId: string,
  ): Promise<InboundWebhookConnectionRotateSecretResultDto> {
    const config = this.requireEnabledConfig();
    const secret = this.generateSecret();
    const secretHash = this.hashSecret(secret);

    const connection = await this.prisma.$transaction(async (transaction) => {
      const current = await this.requireConnection(
        transaction,
        workspaceId,
        connectionId,
      );
      const updatedAt = this.nextMutationTime(current.updatedAt);
      const claimed = await transaction.inboundWebhookConnection.updateMany({
        where: this.activeMutationWhere(current),
        data: {
          secretHash,
          updatedAt,
        },
      });

      this.assertMutationClaimed(claimed.count);
      const updated = await this.requireConnection(
        transaction,
        workspaceId,
        connectionId,
      );

      await this.createAudit(transaction, {
        workspaceId,
        actorUserId,
        action: "inbound_webhook.secret_rotated",
        targetId: updated.id,
        resultStatus: updated.status,
        beforeSummary: this.auditSummary(current),
        afterSummary: {
          ...this.auditSummary(updated),
          secretRotated: true,
        },
      });

      return updated;
    });

    return {
      connectionId: connection.id,
      provider: connection.provider,
      secret,
      webhookUrl: this.buildWebhookUrl(
        config.apiPublicUrl,
        connection.id,
        secret,
        connection.provider,
      ),
      rotatedAt: connection.updatedAt.toISOString(),
    };
  }

  async updateStatus(
    workspaceId: string,
    connectionId: string,
    input: InboundWebhookConnectionStatusUpdateInputDto,
    actorUserId: string,
  ): Promise<InboundWebhookConnectionDto> {
    if (input.status === "observation") {
      this.requireEnabledConfig();
    }

    if (input.status === "production") {
      this.requireProductionEnabledConfig();
    }

    const updated = await this.prisma.$transaction(async (transaction) => {
      const current = await this.requireConnection(
        transaction,
        workspaceId,
        connectionId,
      );

      return applyInboundWebhookConnectionStatus(transaction, {
        workspaceId,
        connectionId,
        status: input.status,
        actorUserId,
        requireValidMetaRoute: metaRouteRequiredForProvider(current.provider),
        seats: this.seatHook(),
        env: this.env,
      });
    });

    return this.toDto(updated);
  }

  async removeConnection(
    workspaceId: string,
    connectionId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const current = await this.requireConnection(
        transaction,
        workspaceId,
        connectionId,
      );
      const removedAt = this.nextMutationTime(current.updatedAt);
      const claimed = await transaction.inboundWebhookConnection.updateMany({
        where: this.activeMutationWhere(current),
        data: {
          status: "paused",
          secretHash: null,
          productionActivatedAt: null,
          removedAt,
          updatedAt: removedAt,
        },
      });

      this.assertMutationClaimed(claimed.count);

      // rastrackdash sanitize (rewrite_rules.external-channel-seat-gate-noop):
      // billing/ is stripped in this edition, so external-channel seats are
      // never allocated and there is nothing to release here.

      const removed: PersistedInboundWebhookConnection = {
        ...current,
        status: "paused",
        secretHash: null,
        productionActivatedAt: null,
        removedAt,
        updatedAt: removedAt,
      };

      await this.createAudit(transaction, {
        workspaceId,
        actorUserId,
        action: "inbound_webhook.connection_removed",
        targetId: removed.id,
        resultStatus: "removed",
        beforeSummary: this.auditSummary(current),
        afterSummary: {
          ...this.auditSummary(removed),
          removed: true,
        },
      });
    });
  }

  /**
   * U2c: lazily provisions the InboundWebhookConnection/Channel bridge for
   * every active UAZAPI/NOD instance so it shows up in the same Gatilhos
   * builder without requiring a webhook to have arrived yet. Best-effort:
   * a failure here just means the instance stays invisible until its next
   * successful webhook (see UazapiProviderConversionService), not a 500.
   */
  private async syncUazapiBridges(workspaceId: string): Promise<void> {
    if (!this.uazapiBridge) return;

    const instances = await this.prisma.whatsappInstance.findMany({
      where: { workspaceId, provider: "uazapi", status: "active" },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        providerInstanceId: true,
      },
    });

    for (const instance of instances) {
      try {
        await this.uazapiBridge.ensureBridge(instance);
      } catch {
        // best-effort; see doc comment above
      }
    }
  }

  private activeMutationWhere(
    connection: PersistedInboundWebhookConnection,
  ): Prisma.InboundWebhookConnectionWhereInput {
    return {
      id: connection.id,
      workspaceId: connection.workspaceId,
      removedAt: null,
      updatedAt: connection.updatedAt,
    };
  }

  private assertMutationClaimed(count: number): void {
    if (count !== 1) {
      throw new ConflictException(concurrentMutationMessage);
    }
  }

  private nextMutationTime(previous: Date): Date {
    return nextMutationTime(previous);
  }

  private async requireConnection(
    client: Pick<PrismaService, "inboundWebhookConnection">,
    workspaceId: string,
    connectionId: string,
  ): Promise<PersistedInboundWebhookConnection> {
    return requireInboundWebhookConnection(client, workspaceId, connectionId);
  }

  /**
   * Seat enforcement is resolved lazily: externalChannelEnforcementEnabled()
   * throws when enforcement is on without a seat service, so it must only run
   * at the points the activation flow actually bills a seat.
   */
  private seatHook(): ExternalChannelSeatHook {
    return {
      enforcementEnabled: () => this.externalChannelEnforcementEnabled(),
      activateSeat: () => {
        throw new Error(
          "External channel seat activation is unavailable once billing/ is removed.",
        );
      },
    };
  }

  private requireEnabledConfig() {
    const config = parseInboundWebhooksConfig(this.env);

    if (!config.enabled) {
      throw new ServiceUnavailableException(
        "Conexoes de webhook de entrada ainda nao estao habilitadas",
      );
    }

    return config;
  }

  private generateSecret(): string {
    return randomBytes(32).toString("base64url");
  }

  private hashSecret(secret: string): string {
    return createHash("sha256").update(secret, "utf8").digest("hex");
  }

  private buildWebhookUrl(
    apiPublicUrl: string,
    connectionId: string,
    secret: string,
    provider?: string,
  ): string {
    const url = new URL(
      `/webhooks/inbound/${encodeURIComponent(connectionId)}`,
      apiPublicUrl,
    );

    // Meta Cloud sends the verification token separately as hub.verify_token
    // during its GET handshake. Keeping it out of the callback URL avoids
    // exposing it in Meta's configured endpoint while other providers retain
    // their existing query-token callback contract.
    if (provider === "meta_cloud") {
      return url.toString();
    }

    url.searchParams.set("token", secret);

    return url.toString();
  }

  private toDto(
    connection: PersistedInboundWebhookConnection,
  ): InboundWebhookConnectionDto {
    return {
      id: connection.id,
      workspaceId: connection.workspaceId,
      provider: connection.provider,
      displayName: connection.displayName,
      parserVersion: connection.parserRelease.version,
      parserReleaseStatus: effectiveInboundParserStatus(connection.parserRelease),
      status: connection.status,
      productionActivatedAt:
        connection.productionActivatedAt?.toISOString() ?? null,
      lastDeliveryAt: connection.lastDeliveryAt?.toISOString() ?? null,
      lastSuccessfulParseAt:
        connection.lastSuccessfulParseAt?.toISOString() ?? null,
      createdAt: connection.createdAt.toISOString(),
      updatedAt: connection.updatedAt.toISOString(),
    };
  }

  private auditSummary(
    connection: PersistedInboundWebhookConnection,
  ): Prisma.InputJsonObject {
    return connectionAuditSummary(connection);
  }

  private requireProductionEnabledConfig() {
    const config = this.requireEnabledConfig();

    if (!config.productionEnabled) {
      throw new ServiceUnavailableException(
        "Envio automatico de webhooks ainda nao esta habilitado",
      );
    }

    return config;
  }

  private externalChannelEnforcementEnabled(): boolean {
    // rastrackdash sanitize (rewrite_rules.external-channel-seat-gate-noop):
    // billing/ is stripped in this edition, so external-channel seat
    // enforcement can never be enabled — hardcode the noop outcome instead
    // of inferring it from now-absent optional billing deps.
    return false;
  }

  private async createAudit(
    transaction: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      actorUserId: string;
      action: string;
      targetId: string;
      resultStatus: string;
      beforeSummary: Prisma.InputJsonObject | undefined;
      afterSummary: Prisma.InputJsonObject;
    },
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        actorType: "user",
        action: input.action,
        targetType: "InboundWebhookConnection",
        targetId: input.targetId,
        reason: null,
        sourceIp: null,
        resultStatus: input.resultStatus,
        beforeSummary: input.beforeSummary,
        afterSummary: input.afterSummary,
      },
    });
  }
}
