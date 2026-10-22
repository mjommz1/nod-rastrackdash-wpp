import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { PipedriveConnection, Prisma } from "@prisma/client";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  PIPEDRIVE_CONNECTION_NOT_FOUND_MESSAGE,
  pipedriveConnectionSchema,
  type PipedriveConnectionDto,
  type PipedriveConnectionCreateInputDto,
  type PipedriveConnectionCredentialReplaceInputDto,
} from "@wpptrack/shared";
import { pipedriveCrmEncryptionKey } from "../config/deployment-config";
import { nextMutationTime } from "../inbound-webhooks/inbound-webhook-production-activation";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  inspectPipedriveBinding,
  pipedriveBindingMessage,
} from "./pipedrive-channel-policy";
import {
  PipedriveAdapter,
  PipedriveAdapterError,
  type PipedrivePipeline,
} from "./pipedrive.adapter";

export type PipedriveActor = {
  userId: string;
  type: "user" | "platform_admin";
};
type Client = Prisma.TransactionClient;
type ConnectionWithCatalog = PipedriveConnectionDto & {
  pipelines: PipedrivePipeline[];
};

@Injectable()
export class PipedriveService {
  now = () => new Date();
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PipedriveAdapter) private readonly adapter: PipedriveAdapter,
  ) {}

  async list(workspaceId: string): Promise<PipedriveConnectionDto[]> {
    const rows = await this.database(() =>
      this.prisma.pipedriveConnection.findMany({
        where: { workspaceId },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        include: {
          _count: {
            select: { pipelines: { where: { available: true } }, rules: true },
          },
        },
      }),
    );
    return rows.map((row) => this.dto(row));
  }

  async get(
    workspaceId: string,
    connectionId: string,
  ): Promise<ConnectionWithCatalog> {
    // One transaction prevents mixing metadata and catalog from different credentials.
    return this.transaction(async (tx) => {
      const connection = await this.lockConnection(
        tx,
        workspaceId,
        connectionId,
      );
      const pipelines = await tx.pipedrivePipelineCatalog.findMany({
        where: { workspaceId, connectionId, available: true },
        include: {
          stages: { where: { workspaceId, connectionId, available: true } },
        },
      });
      return {
        ...this.dto(connection),
        pipelines: pipelines
          .map((p) => ({
            id: p.pipelineId,
            name: p.pipelineName,
            sort: p.pipelineSort,
            stages: p.stages
              .map((s) => ({
                id: s.stageId,
                name: s.stageName,
                sort: s.stageSort,
              }))
              .sort(this.catalogOrder),
          }))
          .sort(this.catalogOrder),
      };
    });
  }

  async create(
    workspaceId: string,
    actor: PipedriveActor,
    input: PipedriveConnectionCreateInputDto,
  ): Promise<ConnectionWithCatalog> {
    const id = randomUUID();
    const origin = new URL(input.accountOrigin).origin;
    // Seal before any provider call or persistence; there is no Kommo key fallback.
    const sealed = this.encrypt(workspaceId, id, input.apiToken);
    await this.validateBindings(
      this.prisma,
      workspaceId,
      input.allowedChannelRouteIds,
    );
    const account = await this.upstream(() =>
      this.adapter.verify(origin, input.apiToken),
    );
    await this.transaction(async (tx) => {
      await this.validateBindings(
        tx,
        workspaceId,
        input.allowedChannelRouteIds,
      );
      await tx.pipedriveConnection.create({
        data: {
          id,
          workspaceId,
          displayName: input.displayName,
          accountOrigin: origin,
          verifiedAccountId: account.id,
          accountSubdomain: account.subdomain,
          status: "active",
          credentialHealthy: true,
          allowedChannelRouteIds: input.allowedChannelRouteIds,
          ...sealed,
        },
      });
      await this.audit(
        tx,
        workspaceId,
        id,
        actor,
        "connection_created",
        "success",
      );
    });
    // A catalog failure leaves a verified connection recoverable through list/get/refresh.
    return this.refreshCatalog(workspaceId, id);
  }

  async replaceCredential(
    workspaceId: string,
    connectionId: string,
    actor: PipedriveActor,
    input: PipedriveConnectionCredentialReplaceInputDto,
  ): Promise<ConnectionWithCatalog> {
    const current = await this.connection(
      this.prisma,
      workspaceId,
      connectionId,
    );
    const sealed = this.encrypt(workspaceId, connectionId, input.apiToken);
    const origin = new URL(input.accountOrigin ?? current.accountOrigin).origin;
    const account = await this.upstream(() =>
      this.adapter.verify(origin, input.apiToken),
    );
    await this.transaction(async (tx) => {
      const live = await this.lockConnection(tx, workspaceId, connectionId);
      this.requireGeneration(current, live);
      const accountChanged =
        live.verifiedAccountId !== account.id ||
        new URL(live.accountOrigin).origin !== origin ||
        live.accountSubdomain !== account.subdomain;
      if (accountChanged) {
        await tx.pipedriveConversionRule.updateMany({
          where: { workspaceId, connectionId },
          data: { active: false },
        });
        await this.clearCatalog(tx, workspaceId, connectionId);
      }
      await tx.pipedriveConnection.updateMany({
        where: this.generationWhere(live),
        data: {
          mutationRevision: { increment: 1 },
          updatedAt: nextMutationTime(live.updatedAt),
          ...sealed,
          accountOrigin: origin,
          verifiedAccountId: account.id,
          accountSubdomain: account.subdomain,
          credentialGeneration: { increment: 1 },
          credentialActivatedAt: this.now(),
          credentialHealthy: true,
          lastErrorCode: null,
          status: live.status === "paused" ? "paused" : "active",
          catalogState: live.catalogRefreshedAt ? "stale" : "empty",
          ...(accountChanged
            ? {
                catalogState: "empty",
                catalogRefreshedAt: null,
                allowedChannelRouteIds: [],
              }
            : {}),
        },
      });
      await this.audit(
        tx,
        workspaceId,
        connectionId,
        actor,
        "credential_replaced",
        accountChanged ? "account_changed" : "success",
      );
    });
    return this.refreshCatalog(workspaceId, connectionId);
  }

  async setStatus(
    workspaceId: string,
    connectionId: string,
    actor: PipedriveActor,
    status: "active" | "paused",
  ): Promise<ConnectionWithCatalog> {
    await this.transaction(async (tx) => {
      const live = await this.lockConnection(tx, workspaceId, connectionId);
      if (
        status === "active" &&
        (!live.credentialHealthy || !live.verifiedAccountId)
      )
        throw new ConflictException("Credencial Pipedrive requer verificação");
      await tx.pipedriveConnection.updateMany({
        where: this.generationWhere(live),
        data: {
          status,
          mutationRevision: { increment: 1 },
          updatedAt: nextMutationTime(live.updatedAt),
        },
      });
      await this.audit(
        tx,
        workspaceId,
        connectionId,
        actor,
        status === "active" ? "connection_resumed" : "connection_paused",
        "success",
      );
    });
    return this.get(workspaceId, connectionId);
  }

  async setChannelBindings(
    workspaceId: string,
    connectionId: string,
    actor: PipedriveActor,
    routeIds: string[],
  ): Promise<ConnectionWithCatalog> {
    await this.transaction(async (tx) => {
      const live = await this.lockConnection(tx, workspaceId, connectionId);
      await this.validateBindings(tx, workspaceId, routeIds);
      await tx.pipedriveConnection.updateMany({
        where: this.generationWhere(live),
        data: {
          allowedChannelRouteIds: routeIds,
          mutationRevision: { increment: 1 },
          updatedAt: nextMutationTime(live.updatedAt),
        },
      });
      await this.audit(
        tx,
        workspaceId,
        connectionId,
        actor,
        "channel_bindings_updated",
        "success",
      );
    });
    return this.get(workspaceId, connectionId);
  }

  async remove(
    workspaceId: string,
    connectionId: string,
    actor: PipedriveActor,
  ) {
    await this.transaction(async (tx) => {
      const live = await this.lockConnection(tx, workspaceId, connectionId);
      const audited = await tx.pipedriveWebhookEvent.findFirst({
        where: { workspaceId, connectionId },
        select: { id: true },
      });
      if (audited)
        throw new ConflictException(
          "Conexão com eventos auditados não pode ser removida; pause-a",
        );
      await tx.pipedriveConversionRule.deleteMany({
        where: { workspaceId, connectionId },
      });
      await this.clearCatalog(tx, workspaceId, connectionId);
      await tx.pipedriveConnection.deleteMany({
        where: this.generationWhere(live),
      });
      await this.audit(
        tx,
        workspaceId,
        connectionId,
        actor,
        "connection_deleted",
        "success",
      );
    });
    return { status: "deleted" as const };
  }

  async refreshCatalog(
    workspaceId: string,
    connectionId: string,
  ): Promise<ConnectionWithCatalog> {
    const snapshot = await this.connection(
      this.prisma,
      workspaceId,
      connectionId,
    );
    this.key(); // Missing configuration is an operational failure, not an upstream credential verdict.
    try {
      const token = this.decrypt(snapshot);
      const account = await this.upstream(() =>
        this.adapter.verify(snapshot.accountOrigin, token),
      );
      if (
        account.id !== snapshot.verifiedAccountId ||
        account.subdomain !== snapshot.accountSubdomain
      )
        throw new BadGatewayException("pipedrive_account_mismatch");
      const pipelines = await this.upstream(() =>
        this.adapter.listPipelines(snapshot.accountOrigin, token),
      );
      const refreshedAt = this.now();
      await this.transaction(async (tx) => {
        const live = await this.lockConnection(tx, workspaceId, connectionId);
        this.requireGeneration(snapshot, live);
        await tx.pipedriveStageCatalog.updateMany({
          where: { workspaceId, connectionId },
          data: { available: false },
        });
        await tx.pipedrivePipelineCatalog.updateMany({
          where: { workspaceId, connectionId },
          data: { available: false },
        });
        for (const pipeline of pipelines) {
          const where = { workspaceId, connectionId, pipelineId: pipeline.id };
          const data = {
            pipelineName: pipeline.name,
            pipelineSort: pipeline.sort,
            available: true,
            refreshedAt,
          };
          const existing = await tx.pipedrivePipelineCatalog.findFirst({
            where,
          });
          if (existing)
            await tx.pipedrivePipelineCatalog.updateMany({ where, data });
          else
            await tx.pipedrivePipelineCatalog.create({
              data: { ...where, ...data },
            });
          for (const stage of pipeline.stages) {
            const stageWhere = { ...where, stageId: stage.id };
            const stageData = {
              stageName: stage.name,
              stageSort: stage.sort,
              available: true,
              refreshedAt,
            };
            const existingStage = await tx.pipedriveStageCatalog.findFirst({
              where: stageWhere,
            });
            if (existingStage)
              await tx.pipedriveStageCatalog.updateMany({
                where: stageWhere,
                data: stageData,
              });
            else
              await tx.pipedriveStageCatalog.create({
                data: { ...stageWhere, ...stageData },
              });
          }
        }
        await tx.pipedriveConnection.updateMany({
          where: this.generationWhere(live),
          data: {
            mutationRevision: { increment: 1 },
            updatedAt: nextMutationTime(live.updatedAt),
            catalogState: "fresh",
            catalogRefreshedAt: refreshedAt,
            credentialHealthy: true,
            lastErrorCode: null,
            // An explicit pause remains effective; a recovered blocked credential can resume.
            status: live.status === "blocked" ? "active" : live.status,
          },
        });
      });
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ConflictException
      )
        throw error;
      const safe =
        error instanceof HttpException
          ? error
          : new ServiceUnavailableException("pipedrive_persistence_failed");
      await this.transaction(async (tx) => {
        const live = await this.lockConnection(tx, workspaceId, connectionId);
        this.requireGeneration(snapshot, live);
        const code = safe.message;
        const mismatch = code === "pipedrive_account_mismatch";
        const unhealthy =
          mismatch ||
          code === "pipedrive_unauthorized" ||
          code === "credential_decrypt_failed";
        if (mismatch) {
          await tx.pipedriveConversionRule.updateMany({
            where: { workspaceId, connectionId },
            data: { active: false },
          });
          await this.clearCatalog(tx, workspaceId, connectionId);
        }
        await tx.pipedriveConnection.updateMany({
          where: this.generationWhere(live),
          data: {
            mutationRevision: { increment: 1 },
            updatedAt: nextMutationTime(live.updatedAt),
            catalogState:
              live.catalogRefreshedAt && !mismatch ? "stale" : "error",
            lastErrorCode: code,
            ...(unhealthy
              ? {
                  credentialHealthy: false,
                  status: live.status === "paused" ? "paused" : "blocked",
                }
              : {}),
            ...(mismatch
              ? {
                  allowedChannelRouteIds: [],
                  catalogRefreshedAt: null,
                  credentialGeneration: { increment: 1 },
                }
              : {}),
          },
        });
      });
      throw safe;
    }
    return this.get(workspaceId, connectionId);
  }

  private async connection(
    client: Client,
    workspaceId: string,
    connectionId: string,
  ): Promise<PipedriveConnection> {
    const row = await this.database(() =>
      client.pipedriveConnection.findFirst({
        where: { id: connectionId, workspaceId },
      }),
    );
    if (!row)
      throw new NotFoundException({
        statusCode: 404,
        code: "pipedrive_connection_not_found",
        message: PIPEDRIVE_CONNECTION_NOT_FOUND_MESSAGE,
      });
    return row;
  }

  async lockConnection(tx: Client, workspaceId: string, connectionId: string) {
    await tx.$queryRaw`SELECT "id" FROM "PipedriveConnection" WHERE "id" = ${connectionId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
    return this.connection(tx, workspaceId, connectionId);
  }

  private generationWhere(row: PipedriveConnection) {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      credentialGeneration: row.credentialGeneration,
      verifiedAccountId: row.verifiedAccountId,
      accountOrigin: row.accountOrigin,
    };
  }

  private requireGeneration(
    snapshot: PipedriveConnection,
    live: PipedriveConnection,
  ) {
    if (
      snapshot.credentialGeneration !== live.credentialGeneration ||
      snapshot.verifiedAccountId !== live.verifiedAccountId ||
      snapshot.accountOrigin !== live.accountOrigin
    )
      throw new ConflictException("Conexão alterada; tente novamente");
  }

  private async clearCatalog(
    tx: Client,
    workspaceId: string,
    connectionId: string,
  ) {
    await tx.pipedriveStageCatalog.deleteMany({
      where: { workspaceId, connectionId },
    });
    await tx.pipedrivePipelineCatalog.deleteMany({
      where: { workspaceId, connectionId },
    });
  }

  private async validateBindings(
    client: Client,
    workspaceId: string,
    routeIds: string[],
  ) {
    // Any production WhatsApp number of the workspace (any provider) with a
    // verified Meta destination; the first failing requirement is reported.
    for (const bindingId of routeIds) {
      const binding = await this.database(() =>
        inspectPipedriveBinding(client, workspaceId, bindingId),
      );
      if (!binding.ok)
        throw new BadRequestException({
          statusCode: 400,
          code: `pipedrive_channel_${binding.reason}`,
          message: pipedriveBindingMessage(binding.reason),
        });
    }
  }

  private async audit(
    tx: Client,
    workspaceId: string,
    connectionId: string,
    actor: PipedriveActor,
    action: string,
    resultStatus: string,
  ) {
    await tx.auditLog.create({
      data: {
        workspaceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: `pipedrive.${action}`,
        targetType: "PipedriveConnection",
        targetId: connectionId,
        resultStatus,
        afterSummary: { provider: "pipedrive", redacted: true },
      },
    });
  }

  private dto(
    row: PipedriveConnection & {
      _count?: { pipelines: number; rules: number };
    },
  ): PipedriveConnectionDto {
    const age = row.catalogRefreshedAt
      ? +this.now() - row.catalogRefreshedAt.getTime()
      : -1;
    return pipedriveConnectionSchema.parse({
      id: row.id,
      workspaceId: row.workspaceId,
      displayName: row.displayName,
      status: row.status,
      verifiedAccountId: row.verifiedAccountId,
      accountSubdomain: row.accountSubdomain,
      accountOrigin: row.accountOrigin,
      allowedChannelRouteIds: row.allowedChannelRouteIds,
      credentialHealthy: row.credentialHealthy,
      catalogState:
        row.catalogState === "fresh" && (age < 0 || age >= 15 * 60_000)
          ? "stale"
          : row.catalogState,
      catalogRefreshedAt: row.catalogRefreshedAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      mutationRevision: row.mutationRevision,
      webhook: {
        configured: Boolean(row.webhookSecretHash),
        version: row.webhookSecretVersion,
        rotatedAt: row.webhookIssuedAt?.toISOString() ?? null,
        lastReceivedAt: row.webhookLastReceivedAt?.toISOString() ?? null,
      },
      ...(row._count ? { counts: row._count } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  private catalogOrder(
    a: { id: string; sort: number | null },
    b: { id: string; sort: number | null },
  ) {
    return (
      (a.sort ?? Number.MAX_SAFE_INTEGER) -
        (b.sort ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id, "en", { numeric: true })
    );
  }

  private key(): Buffer {
    // Same rule as the boot validation (config/deployment-config.ts): 32
    // bytes in canonical base64, never the Kommo key. There is no fallback.
    const key = pipedriveCrmEncryptionKey(process.env);
    if (!key)
      throw new ServiceUnavailableException("pipedrive_encryption_key_invalid");
    return key;
  }

  private aad(workspaceId: string, connectionId: string) {
    return Buffer.from(
      `wpptrack:pipedrive-token:v1:${workspaceId}:${connectionId}`,
      "utf8",
    );
  }

  private encrypt(workspaceId: string, connectionId: string, token: string) {
    const key = this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(this.aad(workspaceId, connectionId));
    return {
      accessTokenEncrypted: Buffer.concat([
        cipher.update(token, "utf8"),
        cipher.final(),
      ]).toString("base64"),
      accessTokenIv: iv.toString("base64"),
      accessTokenTag: cipher.getAuthTag().toString("base64"),
    };
  }

  decrypt(row: PipedriveConnection): string {
    const key = this.key();
    try {
      const decode = (value: string, size?: number) => {
        const bytes = Buffer.from(value, "base64");
        if (
          !bytes.length ||
          bytes.toString("base64") !== value ||
          (size !== undefined && bytes.length !== size)
        )
          throw new Error();
        return bytes;
      };
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        decode(row.accessTokenIv, 12),
      );
      decipher.setAAD(this.aad(row.workspaceId, row.id));
      decipher.setAuthTag(decode(row.accessTokenTag, 16));
      return Buffer.concat([
        decipher.update(decode(row.accessTokenEncrypted)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new ServiceUnavailableException("credential_decrypt_failed");
    }
  }

  private async upstream<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw new BadGatewayException(
        error instanceof PipedriveAdapterError
          ? error.code
          : "pipedrive_transport",
      );
    }
  }

  private transaction<T>(call: (tx: Client) => Promise<T>): Promise<T> {
    return this.database(() => this.prisma.$transaction(call));
  }

  private async database<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "Conta Pipedrive já conectada neste workspace",
        );
      throw new ServiceUnavailableException("pipedrive_persistence_failed");
    }
  }
}
