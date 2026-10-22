import {
  assertMetaCloudSigningConfigured,
  effectiveInboundParserStatus,
  inboundParserProductionEligible,
  missingMetaSigningSecretMessage,
} from "../inbound-webhooks/inbound-webhook-parser-eligibility";
import {
  requireStudentReplayOwner,
  replayContextHash,
  studentReplayContext,
  studentBatchAuthorizationValid,
  studentReplayEventHash,
  studentReplayDispatchUnsettled,
  type StudentReplayActor,
} from "./student-replay-context";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type {
  BackofficeInboundWebhookReplayBatchDto,
  BackofficeInboundWebhookReplayPreviewDto,
  InboundWebhookParserReleaseDto,
  InboundWebhookReplaySelectionDto,
  StudentInboundReplayAuthorizeDto,
  StudentInboundReplayPreviewDto,
  StudentInboundReplayResultDto,
} from "@wpptrack/shared";
import {
  hashPhoneIdentity,
  normalizePhoneIdentity,
} from "../common/phone/phone-identity";
import { PrismaService } from "../common/prisma/prisma.service";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import type { InboundWebhookReplayJobPayload } from "../common/queue/queue.constants";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { parseInboundWebhooksConfig } from "../config/deployment-config";
import { ConversionEventsService } from "../conversion-events/conversion-events.service";
import { InboundWebhookPayloadEncryptionService } from "../inbound-webhooks/inbound-webhook-payload-encryption.service";
import { inboundMetaRouteMatches } from "../inbound-webhooks/inbound-webhook-meta-route-eligibility";
import { InboundWebhookMetaRouteReaderService } from "../inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { inboundWebhookParserContext } from "../inbound-webhooks/providers/inbound-webhook-parser";
import type { ParsedInboundWebhookEvent } from "../inbound-webhooks/providers/inbound-webhook-parser";
import { InboundWebhookParserRegistry } from "../inbound-webhooks/providers/inbound-webhook-parser.registry";
import { LeadsService } from "../leads/leads.service";
import { LicenseClientService } from "../licensing-client/license-client.service";
import { InboundWebhookReplayQueueService } from "./inbound-webhook-replay-queue.service";

const REPLAY_BATCH_LIMIT = 500;
const REPLAY_CANDIDATE_SCAN_LIMIT = REPLAY_BATCH_LIMIT * 5;
const REPLAY_HISTORY_LIMIT = 10;
const replaySelectionLimits: Record<InboundWebhookReplaySelectionDto, number> =
  {
    canary_1: 1,
    canary_5: 5,
    canary_10: 10,
    remaining: REPLAY_BATCH_LIMIT,
  };
const transientReplayErrorCodes = [
  "inbound_webhook_replay_disabled",
  "inbound_webhook_replay_queue_unavailable",
  "inbound_webhook_replay_unexpected",
] as const;
const terminalItemStatuses = new Set([
  "materialized",
  "duplicate",
  "skipped",
  "failed",
]);
const replayItemInclude = {
  event: {
    include: {
      delivery: true,
      connection: {
        include: {
          parserRelease: true,
        },
      },
      channel: {
        include: {
          whatsappInstance: true,
          routes: {
            where: {
              active: true,
              validationStatus: "valid",
            },
          },
        },
      },
      resolvedBusinessConnection: {
        include: {
          credential: true,
        },
      },
      resolvedReportingAccount: true,
      resolvedConversionDestination: true,
    },
  },
} satisfies Prisma.InboundWebhookReplayItemInclude;

type ReplayItemRecord = Prisma.InboundWebhookReplayItemGetPayload<{
  include: typeof replayItemInclude;
}>;

type StudentReplayProof = {
  expires: number;
  context: string;
  eventHashes: Record<string, string>;
  previewDigest: string;
};
type StudentPreviewTicket = StudentReplayProof & {
  actorId: string;
  workspaceId: string;
  connectionId: string;
  channelId: string;
  expires: number;
};

class ReplayItemFailure extends Error {
  constructor(readonly code: string) {
    super("Inbound webhook replay item failed");
    this.name = "ReplayItemFailure";
  }
}

@Injectable()
export class InboundWebhookReplayService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(InboundWebhookPayloadEncryptionService)
    private readonly payloadEncryption: InboundWebhookPayloadEncryptionService,
    @Inject(InboundWebhookParserRegistry)
    private readonly parserRegistry: InboundWebhookParserRegistry,
    @Inject(LeadsService)
    private readonly leads: LeadsService,
    @Inject(ConversionEventsService)
    private readonly conversions: ConversionEventsService,
    @Inject(ConversionEventsQueueService)
    private readonly conversionQueue: ConversionEventsQueueService,
    @Inject(InboundWebhookReplayQueueService)
    private readonly replayQueue: InboundWebhookReplayQueueService,
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
    @Inject(LicenseClientService)
    private readonly licenseClient?: LicenseClientService,
  ) {}

  async previewStudentReplay(
    actor: StudentReplayActor,
    connectionId: string,
    channelId: string,
  ): Promise<StudentInboundReplayPreviewDto> {
    await requireStudentReplayOwner(this.prisma, actor);
    const connection = await this.loadConnection(
      connectionId,
      actor.workspaceId,
    );
    const channel = await this.prisma.inboundWebhookChannel.findFirst({
      where: { id: channelId, workspaceId: actor.workspaceId, connectionId },
    });
    if (
      !channel ||
      channel.workspaceId !== actor.workspaceId ||
      channel.connectionId !== connectionId
    )
      throw new NotFoundException("Canal nao encontrado nesta conexao");
    const context = await studentReplayContext(
      this.prisma,
      actor.workspaceId,
      connectionId,
      channelId,
    );
    const active = await studentReplayDispatchUnsettled(
      this.prisma,
      actor.workspaceId,
      connectionId,
    );
    const latest = await this.prisma.inboundWebhookReplayBatch.findFirst({
      where: { workspaceId: actor.workspaceId, connectionId, channelId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    const unavailableReason = !this.replayEnabled()
      ? "Recuperacao indisponivel. O operador precisa habilitar INBOUND_WEBHOOKS_ENABLED e INBOUND_WEBHOOK_REPLAY_ENABLED na API e reiniciar o servico."
      : !this.env.META_APP_SECRET?.trim()
        ? missingMetaSigningSecretMessage
        : !context
          ? "Habilite o canal, valide a rota Meta e use a integracao Meta Cloud nativa v1 disponivel antes de recuperar."
          : active
            ? "Esta conexao ja possui uma recuperacao em andamento. Aguarde e atualize o resultado."
            : null;
    const { events, scanned } = await this.studentCandidates(
      actor,
      connectionId,
      channelId,
    );
    const expires = Date.now() + 10 * 60_000;
    const eventHashes = Object.fromEntries(
      events
        .slice(0, REPLAY_BATCH_LIMIT)
        .map((event) => [event.id, studentReplayEventHash(event)]),
    );
    const previewToken =
      unavailableReason || !context || !events.length
        ? null
        : this.signStudentPreview({
            actorId: actor.id,
            workspaceId: actor.workspaceId,
            connectionId,
            channelId,
            expires,
            context,
            eventHashes,
            previewDigest: "",
          });
    await this.prisma.auditLog.create({
      data: {
        workspaceId: actor.workspaceId,
        actorUserId: actor.id,
        actorType: "owner",
        action: "inbound_webhook.replay.preview",
        targetType: "InboundWebhookChannel",
        targetId: channelId,
        resultStatus: unavailableReason ? "unavailable" : "previewed",
        afterSummary: {
          connectionId,
          channelId,
          eligible: events.length,
          scanned,
        },
      },
    });
    return {
      connectionId,
      channelId,
      eligible: events.length,
      scanned,
      scanLimit: REPLAY_CANDIDATE_SCAN_LIMIT,
      batchLimit: 500,
      previewToken,
      expiresAt: previewToken ? new Date(expires).toISOString() : null,
      unavailableReason,
      canSendRemaining: Boolean(
        context &&
        !unavailableReason &&
        (await this.studentCanarySucceeded(
          this.prisma,
          actor,
          connectionId,
          channelId,
          context,
        )),
      ),
      latestBatch: latest
        ? await this.getStudentReplayResult(
            actor,
            connectionId,
            channelId,
            latest.id,
          )
        : null,
    };
  }

  async authorizeStudentReplay(
    actor: StudentReplayActor,
    connectionId: string,
    channelId: string,
    input: StudentInboundReplayAuthorizeDto,
  ): Promise<StudentInboundReplayResultDto> {
    await requireStudentReplayOwner(this.prisma, actor);
    const ticket = this.readStudentPreview(input.previewToken);
    if (
      ticket.actorId !== actor.id ||
      ticket.workspaceId !== actor.workspaceId ||
      ticket.connectionId !== connectionId ||
      ticket.channelId !== channelId
    )
      throw new BadRequestException(
        "A previa nao pertence a este owner, conexao e canal",
      );
    const batch = await this.authorizeReplay(
      connectionId,
      input.confirmation,
      input.selection,
      channelId,
      actor,
      null,
      {
        ...ticket,
        previewDigest: createHash("sha256")
          .update(input.previewToken)
          .digest("hex"),
      },
    );
    return this.getStudentReplayResult(
      actor,
      connectionId,
      channelId,
      batch.id,
    );
  }

  async getStudentReplayResult(
    actor: StudentReplayActor,
    connectionId: string,
    channelId: string,
    batchId: string,
  ): Promise<StudentInboundReplayResultDto> {
    await requireStudentReplayOwner(this.prisma, actor);
    await this.loadConnection(connectionId, actor.workspaceId);
    const batch = await this.prisma.inboundWebhookReplayBatch.findFirst({
      where: {
        id: batchId,
        workspaceId: actor.workspaceId,
        connectionId,
        channelId,
      },
      include: { items: { orderBy: { id: "asc" } } },
    });
    if (
      !batch ||
      batch.workspaceId !== actor.workspaceId ||
      batch.connectionId !== connectionId ||
      batch.channelId !== channelId
    )
      throw new NotFoundException("Recuperacao nao encontrada neste canal");
    return this.studentBatchResult(this.prisma, batch);
  }

  private async studentBatchResult(
    client: Prisma.TransactionClient,
    batch: Prisma.InboundWebhookReplayBatchGetPayload<{
      include: { items: true };
    }>,
  ): Promise<StudentInboundReplayResultDto> {
    const logs = await client.conversionEventLog.findMany({
      where: {
        workspaceId: batch.workspaceId,
        id: {
          in: batch.items.flatMap((i) =>
            i.conversionEventLogId ? [i.conversionEventLogId] : [],
          ),
        },
      },
      select: { id: true, status: true, sentAt: true },
    });
    const byId = new Map(logs.map((log) => [log.id, log]));
    const claims = await client.auditLog.findMany({
      where: {
        workspaceId: batch.workspaceId,
        action: "inbound_webhook.dispatch.claim",
        targetId: { in: logs.map((log) => log.id) },
      },
      select: { targetId: true, resultStatus: true, createdAt: true },
    });
    const byClaim = new Map(claims.map((claim) => [claim.targetId, claim]));
    const items = batch.items.map(
      (item): StudentInboundReplayResultDto["items"][number] => {
        const log = item.conversionEventLogId
          ? byId.get(item.conversionEventLogId)
          : null;
        const claim = item.conversionEventLogId
          ? byClaim.get(item.conversionEventLogId)
          : null;
        let state: StudentInboundReplayResultDto["state"];
        if (item.status === "duplicate") state = "delivery_unknown";
        else if (log?.status === "sent" && log.sentAt) state = "delivered";
        else if (
          claim?.resultStatus === "delivery_unknown" ||
          log?.status === "delivery_unknown"
        )
          state = "delivery_unknown";
        else if (claim?.resultStatus === "dispatch_started") {
          // Keep polling during the sender's bounded 15s request plus 5s for
          // persistence. This is only a display window, never a lease/retry:
          // the permanent fence remains consumed after it expires.
          const age =
            claim.createdAt instanceof Date
              ? Date.now() - claim.createdAt.getTime()
              : Infinity;
          state = age >= 0 && age < 20_000 ? "processing" : "delivery_unknown";
        } else if (
          item.status === "failed" ||
          item.status === "skipped" ||
          (log && !["ready_to_send", "sending"].includes(log.status))
        )
          state = "failed";
        else if (item.status === "processing" || log?.status === "sending")
          state = "processing";
        else if (item.status === "materialized" && !log)
          state = "delivery_unknown";
        else state = "pending";
        return { id: item.id, state };
      },
    );
    const count = (state: StudentInboundReplayResultDto["state"]) =>
      items.filter((i) => i.state === state).length;
    const delivered = count("delivered"),
      failed = count("failed"),
      unknown = count("delivery_unknown");
    const state = unknown
      ? "delivery_unknown"
      : failed
        ? "failed"
        : items.length > 0 && delivered === items.length
          ? "delivered"
          : items.some((i) => i.state === "processing")
            ? "processing"
            : "pending";
    return {
      batchId: batch.id,
      selection: batch.selection,
      state,
      total: batch.totalItems,
      delivered,
      failed,
      unknown,
      pending: count("pending") + count("processing"),
      items,
    };
  }

  private async studentCanarySucceeded(
    client: Prisma.TransactionClient,
    actor: StudentReplayActor,
    connectionId: string,
    channelId: string,
    context: string,
  ): Promise<boolean> {
    const canaries = await client.inboundWebhookReplayBatch.findMany({
      where: {
        workspaceId: actor.workspaceId,
        connectionId,
        channelId,
        selection: "canary_1",
        status: "completed",
        totalItems: 1,
      },
      include: { items: true },
      orderBy: { createdAt: "desc" },
      take: REPLAY_HISTORY_LIMIT,
    });
    for (const canary of canaries) {
      const audit = await client.auditLog.findFirst({
        where: {
          workspaceId: actor.workspaceId,
          targetId: canary.id,
          action: "inbound_webhook.replay.authorize",
        },
        select: { afterSummary: true },
      });
      if (
        (audit?.afterSummary as { studentContext?: string } | null)
          ?.studentContext !== context ||
        !(await studentBatchAuthorizationValid(
          client,
          actor.workspaceId,
          canary.id,
        ))
      )
        continue;
      const result = await this.studentBatchResult(client, canary);
      if (
        result.total === 1 &&
        result.delivered === 1 &&
        result.state === "delivered" &&
        canary.items[0]?.status === "materialized"
      )
        return true;
    }
    return false;
  }

  private async studentCandidates(
    actor: StudentReplayActor,
    connectionId: string,
    channelId: string,
  ) {
    const connection = await this.loadConnection(
      connectionId,
      actor.workspaceId,
    );
    const records = await this.prisma.inboundWebhookEvent.findMany({
      where: {
        workspaceId: actor.workspaceId,
        connectionId,
        channelId,
        hasCtwa: true,
        classification: "eligible_route_resolved",
        replayItem: { is: null },
        productionItem: { is: null },
        occurredAt: {
          gte: new Date(Date.now() - 7 * 86400_000),
          lte: new Date(),
        },
      },
      include: {
        ...replayItemInclude.event.include,
        replayItem: true,
        productionItem: true,
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: REPLAY_CANDIDATE_SCAN_LIMIT,
    });
    const events: typeof records = [];
    for (const event of records) {
      if (
        event.workspaceId !== actor.workspaceId ||
        event.connectionId !== connectionId ||
        event.channelId !== channelId ||
        event.replayItem ||
        event.productionItem ||
        !this.payloadAvailable(event.delivery, new Date()) ||
        !this.replayWindowEligible(event, connection) ||
        !this.studentIdentityReady(event)
      )
        continue;
      const ad = await this.prisma.metaAd.findFirst({
        where: { workspaceId: actor.workspaceId, adId: event.adId! },
        select: { adAccountId: true },
      });
      if (
        !this.routeReady(event, ad?.adAccountId ?? null) ||
        !(await this.currentRouteReady(this.prisma, actor.workspaceId, event))
      )
        continue;
      if (
        await this.prisma.conversionEventLog.findFirst({
          where: {
            workspaceId: actor.workspaceId,
            dedupeKey: `inbound-webhook:${connectionId}:${event.dedupeKey}`,
          },
          select: { id: true },
        })
      )
        continue;
      events.push(event);
    }
    return { events, scanned: records.length };
  }

  private studentIdentityReady(event: ReplayItemRecord["event"]): boolean {
    if (
      !event.hasCtwa ||
      !event.adId ||
      event.classification !== "eligible_route_resolved" ||
      event.provider !== "meta_cloud" ||
      event.connection.provider !== event.provider ||
      event.delivery.provider !== event.provider ||
      event.delivery.workspaceId !== event.workspaceId ||
      event.delivery.connectionId !== event.connectionId ||
      event.connection.workspaceId !== event.workspaceId ||
      event.channel.workspaceId !== event.workspaceId ||
      event.channel.connectionId !== event.connectionId ||
      event.channel.id !== event.channelId ||
      event.channel.status !== "active" ||
      event.delivery.parserVersion !== event.connection.parserRelease.version ||
      !inboundParserProductionEligible(
        event.connection.parserRelease,
        this.parserRegistry,
      )
    )
      return false;
    try {
      const parsed = this.reparseEvent({ event } as ReplayItemRecord);
      return Boolean(
        parsed.ctwaClid &&
        parsed.adId &&
        normalizePhoneIdentity(parsed.contact.phoneNumber) &&
        parsed.occurredAt.getTime() === event.occurredAt.getTime(),
      );
    } catch {
      return false;
    }
  }

  private signStudentPreview(ticket: StudentPreviewTicket): string {
    const key = this.env.INBOUND_WEBHOOK_ENCRYPTION_KEY;
    if (!key)
      throw new ServiceUnavailableException(
        "Criptografia de webhooks indisponivel",
      );
    const body = Buffer.from(JSON.stringify(ticket)).toString("base64url");
    return `${body}.${createHmac("sha256", key).update(`student-replay-v1:${body}`).digest("base64url")}`;
  }

  private readStudentPreview(token: string): StudentPreviewTicket {
    try {
      const [body, signature, extra] = token.split(".");
      if (
        !body ||
        !signature ||
        extra ||
        !this.env.INBOUND_WEBHOOK_ENCRYPTION_KEY
      )
        throw new Error();
      const expected = createHmac(
        "sha256",
        this.env.INBOUND_WEBHOOK_ENCRYPTION_KEY,
      )
        .update(`student-replay-v1:${body}`)
        .digest();
      const actual = Buffer.from(signature, "base64url");
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error();
      const ticket = JSON.parse(
        Buffer.from(body, "base64url").toString("utf8"),
      ) as StudentPreviewTicket;
      if (
        !Number.isFinite(ticket.expires) ||
        ticket.expires <= Date.now() ||
        !ticket.context ||
        !ticket.eventHashes ||
        Object.keys(ticket.eventHashes).length > REPLAY_BATCH_LIMIT
      )
        throw new Error();
      return ticket;
    } catch {
      throw new BadRequestException(
        "A previa expirou ou mudou. Atualize a previa antes de enviar",
      );
    }
  }

  async getPreview(
    connectionId: string,
  ): Promise<BackofficeInboundWebhookReplayPreviewDto> {
    const connection = await this.loadConnection(connectionId);
    const now = new Date();
    const [events, channels, recentBatches] = await Promise.all([
      this.prisma.inboundWebhookEvent.findMany({
        where: {
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          hasCtwa: true,
        },
        select: {
          occurredAt: true,
          channelId: true,
          adId: true,
          classification: true,
          resolvedBusinessConnectionId: true,
          resolvedReportingAccountId: true,
          resolvedConversionDestinationId: true,
          resolvedBusinessConnection: {
            select: {
              status: true,
              credential: {
                select: {
                  status: true,
                },
              },
            },
          },
          resolvedReportingAccount: {
            select: {
              active: true,
              adAccountId: true,
              businessConnectionId: true,
            },
          },
          resolvedConversionDestination: {
            select: {
              status: true,
            },
          },
          channel: {
            select: {
              id: true,
              channelName: true,
              connectedPhone: true,
              productionActivatedAt: true,
              routes: {
                where: {
                  active: true,
                  validationStatus: "valid",
                },
                select: {
                  metaBusinessConnectionId: true,
                  metaReportingAccountId: true,
                  metaConversionDestinationId: true,
                },
              },
            },
          },
          replayItem: {
            select: {
              id: true,
              status: true,
            },
          },
          productionItem: {
            select: {
              id: true,
              status: true,
            },
          },
          delivery: {
            select: {
              firstReceivedAt: true,
              payloadExpiresAt: true,
              encryptedPayload: true,
              payloadIv: true,
              payloadTag: true,
              encryptionKeyVersion: true,
            },
          },
        },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      }),
      this.prisma.inboundWebhookChannel.findMany({
        where: {
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
        },
        select: {
          id: true,
          channelName: true,
          connectedPhone: true,
        },
        orderBy: [{ channelName: "asc" }, { connectedPhone: "asc" }],
      }),
      this.prisma.inboundWebhookReplayBatch.findMany({
        where: {
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
        },
        include: {
          items: {
            where: {
              status: "failed",
              errorCode: {
                in: [...transientReplayErrorCodes],
              },
              event: {
                delivery: {
                  payloadExpiresAt: { gt: now },
                  encryptedPayload: { not: null },
                  payloadIv: { not: null },
                  payloadTag: { not: null },
                  encryptionKeyVersion: { not: null },
                },
              },
            },
            select: { id: true },
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: REPLAY_HISTORY_LIMIT,
      }),
    ]);
    const ads = await this.prisma.metaAd.findMany({
      where: {
        workspaceId: connection.workspaceId,
        adId: {
          in: [
            ...new Set(
              events
                .map((event) => event.adId)
                .filter((adId): adId is string => adId !== null),
            ),
          ],
        },
      },
      select: {
        adId: true,
        adAccountId: true,
      },
    });
    const adAccountsByAd = new Map(ads.map((ad) => [ad.adId, ad.adAccountId]));
    const payloadAvailable = (event: (typeof events)[number]) =>
      this.payloadAvailable(event.delivery, now);
    const routeReadiness = new Map(
      await Promise.all(
        events.map(
          async (event) =>
            [
              event,
              this.routeReady(
                event,
                event.adId ? (adAccountsByAd.get(event.adId) ?? null) : null,
              ) &&
                (await this.currentRouteReady(
                  this.prisma,
                  connection.workspaceId,
                  event,
                )),
            ] as const,
        ),
      ),
    );
    const routeResolved = (event: (typeof events)[number]) =>
      routeReadiness.get(event) === true;
    const insideReplayWindow = (event: (typeof events)[number]) =>
      this.replayWindowEligible(event, connection);
    const nextPayloadExpiresAt = events
      .filter(
        (event) =>
          (event.replayItem === null ||
            ["queued", "processing", "failed"].includes(
              event.replayItem.status,
            )) &&
          event.productionItem === null &&
          insideReplayWindow(event) &&
          event.delivery.payloadExpiresAt.getTime() > now.getTime() &&
          payloadAvailable(event),
      )
      .map((event) => event.delivery.payloadExpiresAt)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    const alreadyMaterialized = (event: (typeof events)[number]) =>
      event.replayItem?.status === "materialized" ||
      event.replayItem?.status === "duplicate" ||
      event.productionItem?.status === "materialized" ||
      event.productionItem?.status === "duplicate";
    const eligible = (event: (typeof events)[number]) =>
      event.adId !== null &&
      routeResolved(event) &&
      payloadAvailable(event) &&
      insideReplayWindow(event) &&
      event.replayItem === null &&
      event.productionItem === null;

    return {
      connection: {
        id: connection.id,
        workspaceId: connection.workspaceId,
        provider: connection.provider,
        displayName: connection.displayName,
        parserVersion: connection.parserRelease.version,
        parserReleaseStatus: effectiveInboundParserStatus(
          connection.parserRelease,
        ),
        status: connection.status,
        productionActivatedAt:
          connection.productionActivatedAt?.toISOString() ?? null,
        lastDeliveryAt: connection.lastDeliveryAt?.toISOString() ?? null,
        lastSuccessfulParseAt:
          connection.lastSuccessfulParseAt?.toISOString() ?? null,
        createdAt: connection.createdAt.toISOString(),
        updatedAt: connection.updatedAt.toISOString(),
      },
      parserRelease: this.parserReleaseDto(connection.parserRelease),
      replayEnabled: this.replayEnabled(),
      counts: {
        totalCtwa: events.length,
        routeResolved: events.filter(routeResolved).length,
        routeUnresolved: events.filter((event) => !routeResolved(event)).length,
        payloadAvailable: events.filter(payloadAvailable).length,
        payloadExpired: events.filter(
          (event) => event.delivery.payloadExpiresAt.getTime() <= now.getTime(),
        ).length,
        payloadUnavailable: events.filter(
          (event) =>
            event.delivery.payloadExpiresAt.getTime() > now.getTime() &&
            !payloadAvailable(event),
        ).length,
        alreadyMaterialized: events.filter(alreadyMaterialized).length,
        eligible: events.filter(eligible).length,
      },
      oldestOccurredAt: events[0]?.occurredAt.toISOString() ?? null,
      newestOccurredAt:
        events[events.length - 1]?.occurredAt.toISOString() ?? null,
      nextPayloadExpiresAt: nextPayloadExpiresAt?.toISOString() ?? null,
      channels: channels.map((channel) => {
        const channelEvents = events.filter(
          (event) => event.channelId === channel.id,
        );

        return {
          id: channel.id,
          displayName: channel.channelName ?? channel.connectedPhone,
          connectedPhone: channel.connectedPhone,
          totalCtwa: channelEvents.length,
          routeResolved: channelEvents.filter(routeResolved).length,
          routeUnresolved: channelEvents.filter(
            (event) => !routeResolved(event),
          ).length,
          payloadAvailable: channelEvents.filter(payloadAvailable).length,
          alreadyMaterialized: channelEvents.filter(alreadyMaterialized).length,
          eligible: channelEvents.filter(eligible).length,
        };
      }),
      latestBatch: recentBatches[0]
        ? this.batchDto({
            ...recentBatches[0],
            retryableFailedCount: recentBatches[0].items.length,
          })
        : null,
      recentBatches: recentBatches.map((batch) =>
        this.batchDto({
          ...batch,
          retryableFailedCount: batch.items.length,
        }),
      ),
    };
  }

  async authorizeReplay(
    connectionId: string,
    confirmation: string,
    selection: InboundWebhookReplaySelectionDto,
    channelId: string,
    actor: StudentReplayActor,
    sourceIp: string | null,
    proof?: StudentReplayProof,
  ): Promise<BackofficeInboundWebhookReplayBatchDto> {
    this.assertReplayEnabled();
    await this.assertStudentReplayLicense();
    await requireStudentReplayOwner(this.prisma, actor);
    const connection = await this.loadConnection(
      connectionId,
      actor.workspaceId,
    );
    if (!proof || !["canary_1", "remaining"].includes(selection))
      throw new BadRequestException(
        "Revise a previa antes de confirmar o envio",
      );
    assertMetaCloudSigningConfigured(connection.provider, this.env);
    const requestedLimit = this.replaySelectionLimit(selection);
    const replayChannelId = channelId.trim();

    if (!replayChannelId) {
      throw new BadRequestException(
        "Selecione um canal para autorizar o replay",
      );
    }

    if (confirmation !== connection.displayName) {
      throw new BadRequestException(
        "Digite exatamente o nome da conexao para autorizar",
      );
    }

    if (!["observation", "production"].includes(connection.status)) {
      throw new ConflictException(
        "A conexao precisa estar em observacao ou producao para o replay controlado",
      );
    }

    if (
      !inboundParserProductionEligible(
        connection.parserRelease,
        this.parserRegistry,
      )
    ) {
      throw new ConflictException(
        "Certifique o parser antes de autorizar o replay",
      );
    }

    const channelExists = await this.prisma.inboundWebhookChannel.count({
      where: {
        id: replayChannelId,
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
      },
    });

    if (channelExists !== 1) {
      throw new BadRequestException("Canal invalido para esta conexao");
    }

    const now = new Date();
    let batch;

    try {
      batch = await this.prisma.$transaction(async (tx) => {
        // Serialize concurrent replay approvals on the existing connection row,
        // then revalidate the immutable snapshot and pending dispatches.
        await tx.$queryRaw`SELECT "id" FROM "InboundWebhookConnection" WHERE "id" = ${connection.id} AND "workspaceId" = ${actor.workspaceId} FOR UPDATE`;
        await requireStudentReplayOwner(tx, actor);
        await this.assertStudentReplayLicense();
        if (proof.expires <= Date.now())
          throw new BadRequestException(
            "A previa expirou ou mudou. Atualize a previa antes de enviar",
          );
        const currentContext = await studentReplayContext(
          tx,
          actor.workspaceId,
          connection.id,
          replayChannelId,
        );
        if (!currentContext || currentContext !== proof.context)
          throw new ConflictException(
            "A conexao ou a rota mudou. Atualize a previa antes de enviar",
          );
        if (
          selection === "remaining" &&
          !(await this.studentCanarySucceeded(
            tx,
            actor,
            connection.id,
            replayChannelId,
            currentContext,
          ))
        )
          throw new ConflictException(
            "Envie um de teste e aguarde a confirmacao de entrega antes de recuperar os demais",
          );
        if (
          await studentReplayDispatchUnsettled(
            tx,
            actor.workspaceId,
            connection.id,
          )
        )
          throw new ConflictException(
            "Esta conexao ja possui um replay em andamento",
          );
        const activeBatch = await tx.inboundWebhookReplayBatch.findFirst({
          where: {
            workspaceId: connection.workspaceId,
            connectionId: connection.id,
            status: {
              in: ["queued", "processing"],
            },
          },
          select: { id: true },
        });

        if (activeBatch) {
          throw new ConflictException(
            "Esta conexao ja possui um replay em andamento",
          );
        }

        const candidates = await tx.inboundWebhookEvent.findMany({
          where: {
            workspaceId: connection.workspaceId,
            connectionId: connection.id,
            channelId: replayChannelId,
            id: { in: Object.keys(proof.eventHashes) },
            hasCtwa: true,
            adId: { not: null },
            classification: "eligible_route_resolved",
            resolvedBusinessConnectionId: { not: null },
            resolvedReportingAccountId: { not: null },
            resolvedConversionDestinationId: { not: null },
            replayItem: { is: null },
            productionItem: { is: null },
            delivery: {
              payloadExpiresAt: { gt: now },
              encryptedPayload: { not: null },
              payloadIv: { not: null },
              payloadTag: { not: null },
              encryptionKeyVersion: { not: null },
            },
          },
          include: {
            ...replayItemInclude.event.include,
            replayItem: true,
            productionItem: true,
          },
          orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
          take: REPLAY_CANDIDATE_SCAN_LIMIT,
        });
        const ads = await tx.metaAd.findMany({
          where: {
            workspaceId: connection.workspaceId,
            adId: {
              in: candidates
                .map((event) => event.adId)
                .filter((adId): adId is string => adId !== null),
            },
          },
          select: {
            adId: true,
            adAccountId: true,
          },
        });
        const adAccountsByAd = new Map(
          ads.map((ad) => [ad.adId, ad.adAccountId]),
        );
        const events: typeof candidates = [];
        for (const event of candidates) {
          if (
            studentReplayEventHash(event) === proof.eventHashes[event.id] &&
            this.studentIdentityReady(event) &&
            this.replayWindowEligible(event, connection) &&
            this.routeReady(
              event,
              event.adId ? (adAccountsByAd.get(event.adId) ?? null) : null,
            ) &&
            (await this.currentRouteReady(tx, connection.workspaceId, event))
          ) {
            if (
              await tx.conversionEventLog.findFirst({
                where: {
                  workspaceId: connection.workspaceId,
                  dedupeKey: `inbound-webhook:${connection.id}:${event.dedupeKey}`,
                },
                select: { id: true },
              })
            )
              continue;
            events.push(event);
            if (events.length === requestedLimit) break;
          }
        }

        if (events.length === 0) {
          throw new BadRequestException(
            "Nenhum evento possui rota completa e payload disponivel",
          );
        }

        await requireStudentReplayOwner(tx, actor);
        await this.assertStudentReplayLicense();
        const created = await tx.inboundWebhookReplayBatch.create({
          data: {
            workspaceId: connection.workspaceId,
            connectionId: connection.id,
            channelId: replayChannelId,
            requestedByUserId: actor.id,
            selection,
            requestedLimit,
            status: "queued",
          },
        });
        const inserted = await tx.inboundWebhookReplayItem.createMany({
          data: events.map((event) => ({
            workspaceId: connection.workspaceId,
            batchId: created.id,
            eventId: event.id,
            status: "queued" as const,
          })),
          skipDuplicates: true,
        });

        if (inserted.count === 0) {
          throw new ConflictException(
            "Os eventos elegiveis ja pertencem a outro replay",
          );
        }

        const updated = await tx.inboundWebhookReplayBatch.update({
          where: { id: created.id },
          data: { totalItems: inserted.count },
        });

        await tx.auditLog.create({
          data: {
            id: `student-replay-preview:${proof.previewDigest}`,
            workspaceId: connection.workspaceId,
            actorUserId: actor.id,
            actorType: actor.role,
            action: "inbound_webhook.replay.authorize",
            targetType: "inbound_webhook_replay_batch",
            targetId: created.id,
            sourceIp: this.sourceIp(sourceIp),
            resultStatus: "queued",
            afterSummary: {
              connectionId: connection.id,
              channelId: replayChannelId,
              parserReleaseId: connection.parserRelease.id,
              selection,
              requestedLimit,
              itemCount: inserted.count,
              batchLimit: REPLAY_BATCH_LIMIT,
              studentContext: proof.context,
              studentEventHashes: Object.fromEntries(
                events.map((event) => [event.id, proof.eventHashes[event.id]]),
              ),
            },
          },
        });

        return updated;
      });
    } catch (error) {
      if (this.prismaErrorCode(error) === "P2002") {
        throw new ConflictException(
          "Esta conexao ja possui um replay em andamento",
        );
      }

      throw error;
    }

    try {
      await this.replayQueue.enqueueBatch({
        workspaceId: batch.workspaceId,
        batchId: batch.id,
      });
    } catch {
      await this.removeUnqueuedBatch(batch.id, batch.workspaceId);
      throw new ServiceUnavailableException(
        "Nao foi possivel iniciar o replay; tente novamente",
      );
    }

    return this.batchDto(batch);
  }

  async processBatch(
    input: Readonly<InboundWebhookReplayJobPayload>,
  ): Promise<BackofficeInboundWebhookReplayBatchDto> {
    this.assertJobPayload(input);

    if (!this.replayEnabled()) {
      return this.failEntireBatch(input, "inbound_webhook_replay_disabled");
    }

    const batch = await this.prisma.inboundWebhookReplayBatch.findFirst({
      where: {
        id: input.batchId,
        workspaceId: input.workspaceId,
      },
    });

    if (!batch) {
      throw new ReplayItemFailure("inbound_webhook_replay_batch_not_found");
    }

    if (
      ["completed", "completed_with_failures", "failed"].includes(batch.status)
    ) {
      return this.batchDto(batch);
    }

    await this.prisma.inboundWebhookReplayBatch.update({
      where: { id: batch.id },
      data: {
        status: "processing",
        startedAt: batch.startedAt ?? new Date(),
      },
    });

    const items = await this.prisma.inboundWebhookReplayItem.findMany({
      where: {
        workspaceId: batch.workspaceId,
        batchId: batch.id,
        status: {
          in: ["queued", "processing"],
        },
      },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    for (const item of items) {
      await this.processItem(batch.id, batch.workspaceId, item.id);
    }

    return this.finishBatch(batch.id, batch.workspaceId);
  }

  private async processItem(
    batchId: string,
    workspaceId: string,
    itemId: string,
  ): Promise<void> {
    const item = await this.prisma.inboundWebhookReplayItem.findFirst({
      where: {
        id: itemId,
        batchId,
        workspaceId,
      },
      include: replayItemInclude,
    });

    if (!item || terminalItemStatuses.has(item.status)) {
      return;
    }

    await this.prisma.inboundWebhookReplayItem.update({
      where: { id: item.id },
      data: {
        status: "processing",
        errorCode: null,
        attemptCount: {
          increment: 1,
        },
        lastAttemptedAt: new Date(),
      },
    });

    try {
      const result = await this.materialize(item);

      await this.prisma.inboundWebhookReplayItem.update({
        where: { id: item.id },
        data: {
          status: result.duplicate ? "duplicate" : "materialized",
          leadId: result.leadId,
          conversionEventLogId: result.conversionEventLogId,
          errorCode: null,
          processedAt: new Date(),
        },
      });
    } catch (error) {
      await this.prisma.inboundWebhookReplayItem.update({
        where: { id: item.id },
        data: {
          status: "failed",
          errorCode: this.replayErrorCode(error),
          processedAt: new Date(),
        },
      });
    }
  }

  private async materialize(item: ReplayItemRecord): Promise<{
    leadId: string;
    conversionEventLogId: string;
    duplicate: boolean;
  }> {
    await this.assertStudentReplayLicense();
    this.assertReplayEnabled();
    const event = item.event;
    const connection = event.connection;
    const delivery = event.delivery;
    const business = event.resolvedBusinessConnection;
    const reporting = event.resolvedReportingAccount;
    const destination = event.resolvedConversionDestination;
    const resolved = {
      businessConnectionId: event.resolvedBusinessConnectionId,
      reportingAccountId: event.resolvedReportingAccountId,
      conversionDestinationId: event.resolvedConversionDestinationId,
    };
    const routeStillActive =
      event.channel.routes.filter(
        (route) =>
          route.workspaceId === event.workspaceId &&
          route.active &&
          route.validationStatus === "valid" &&
          inboundMetaRouteMatches(route, resolved),
      ).length === 1;
    // Only the instance bound to this tenant-owned inbound origin is trusted.
    const channelInstance = event.channel.whatsappInstance;
    if (
      item.workspaceId !== event.workspaceId ||
      connection.workspaceId !== event.workspaceId ||
      event.connectionId !== connection.id ||
      event.channelId !== event.channel.id ||
      connection.provider !== event.provider ||
      delivery.provider !== event.provider ||
      delivery.workspaceId !== event.workspaceId ||
      delivery.connectionId !== connection.id ||
      event.channel.workspaceId !== event.workspaceId ||
      event.channel.connectionId !== connection.id ||
      (event.channel.whatsappInstanceId &&
        (!channelInstance ||
          channelInstance.id !== event.channel.whatsappInstanceId ||
          channelInstance.workspaceId !== event.workspaceId ||
          channelInstance.status !== "active"))
    ) {
      throw new ReplayItemFailure("inbound_webhook_replay_context_changed");
    }
    const now = new Date();

    if (
      event.classification !== "eligible_route_resolved" ||
      !event.hasCtwa ||
      !event.adId
    ) {
      throw new ReplayItemFailure("inbound_webhook_replay_event_ineligible");
    }

    if (
      connection.removedAt ||
      !["observation", "production"].includes(connection.status) ||
      connection.parserRelease.provider !== connection.provider ||
      !inboundParserProductionEligible(
        connection.parserRelease,
        this.parserRegistry,
      ) ||
      connection.parserRelease.version !== delivery.parserVersion
    ) {
      throw new ReplayItemFailure("inbound_webhook_replay_context_changed");
    }

    if (!this.replayWindowEligible(event, connection)) {
      throw new ReplayItemFailure(
        "inbound_webhook_replay_outside_historical_window",
      );
    }

    if (
      !business ||
      business.workspaceId !== event.workspaceId ||
      business.credential.workspaceId !== event.workspaceId ||
      business.status !== "active" ||
      business.credential.status !== "active" ||
      !reporting ||
      reporting.workspaceId !== event.workspaceId ||
      !reporting.active ||
      reporting.businessConnectionId !== business.id ||
      !destination ||
      destination.workspaceId !== event.workspaceId ||
      destination.status !== "configured" ||
      !routeStillActive
    ) {
      throw new ReplayItemFailure("inbound_webhook_replay_route_invalid");
    }

    if (!this.payloadAvailable(delivery, now)) {
      throw new ReplayItemFailure("inbound_webhook_replay_payload_unavailable");
    }

    assertMetaCloudSigningConfigured(connection.provider, this.env);
    const parsedEvent = this.reparseEvent(item);
    const phone = normalizePhoneIdentity(parsedEvent.contact.phoneNumber);
    const phoneHash = hashPhoneIdentity(parsedEvent.contact.phoneNumber);

    if (!phone || !phoneHash || !parsedEvent.ctwaClid || !parsedEvent.adId) {
      throw new ReplayItemFailure("inbound_webhook_replay_identity_invalid");
    }

    const ad = await this.prisma.metaAd.findFirst({
      where: {
        workspaceId: event.workspaceId,
        adId: event.adId,
      },
      select: {
        campaignId: true,
        adSetId: true,
        adAccountId: true,
      },
    });

    if (!ad || ad.adAccountId !== reporting.adAccountId) {
      throw new ReplayItemFailure("inbound_webhook_replay_route_invalid");
    }

    const currentRoute = await new InboundWebhookMetaRouteReaderService(
      this.prisma,
    ).previewRoute({
      workspaceId: event.workspaceId,
      adId: event.adId,
      ...resolved,
    });
    if (
      currentRoute.status !== "resolved" ||
      currentRoute.reportingAccountId !== reporting.id ||
      currentRoute.businessConnectionId !== business.id ||
      currentRoute.conversionDestinationId !== destination.id
    ) {
      throw new ReplayItemFailure("inbound_webhook_replay_route_invalid");
    }

    if (
      !(await studentBatchAuthorizationValid(
        this.prisma,
        item.workspaceId,
        item.batchId,
        item.eventId,
      ))
    )
      throw new ReplayItemFailure(
        "inbound_webhook_replay_authorization_changed",
      );
    const lead = await this.leads.upsertFromWhatsappWebhook({
      workspaceId: event.workspaceId,
      whatsappInstanceId: event.channel.whatsappInstanceId ?? undefined,
      name: parsedEvent.contact.name ?? undefined,
      phone,
      source: event.provider,
      preserveExistingSource: true,
      preserveEarliestFirstMessageAt: true,
      campaignId: ad.campaignId ?? undefined,
      adSetId: ad.adSetId ?? undefined,
      adId: event.adId,
      ctwaClid: parsedEvent.ctwaClid,
      ctwaSourceUrl: parsedEvent.ad?.sourceUrl ?? undefined,
      ctwaThumbnailUrl: parsedEvent.ad?.thumbnailUrl ?? undefined,
      occurredAt: event.occurredAt,
      firstMessageAt: event.occurredAt,
      lastMessageAt: event.occurredAt,
    });

    if (!lead) {
      throw new ReplayItemFailure("inbound_webhook_replay_lead_invalid");
    }

    await this.assertStudentReplayLicense();
    if (
      !(await studentBatchAuthorizationValid(
        this.prisma,
        item.workspaceId,
        item.batchId,
        item.eventId,
      ))
    )
      throw new ReplayItemFailure(
        "inbound_webhook_replay_authorization_changed",
      );
    const conversion = await this.conversions.recordExternalConversion({
      workspaceId: event.workspaceId,
      externalConnectorId: null,
      sourceEventId: event.externalMessageId ?? event.id,
      sourceTrigger: `inbound_webhook:${event.provider}`,
      eventName: "LeadSubmitted",
      eventId: this.metaEventId(event.provider, connection.id, event.dedupeKey),
      dedupeKey: `inbound-webhook:${connection.id}:${event.dedupeKey}`,
      leadId: lead.id,
      phoneHash,
      businessSource: "paid",
      metaAccountId: reporting.adAccountId,
      metaBusinessConnectionId: business.id,
      metaConversionDestinationId: destination.id,
      campaignId: ad.campaignId ?? null,
      adSetId: ad.adSetId ?? null,
      adId: event.adId,
      ctwaClid: parsedEvent.ctwaClid,
      eventOccurredAt: event.occurredAt,
      sourcePayload: {
        provider: event.provider,
        connectionId: connection.id,
        inboundEventId: event.id,
        channelId: event.channelId,
        classification: event.classification,
        hasCtwa: true,
        adId: event.adId,
      },
    });

    if (
      conversion.status !== "duplicate" &&
      conversion.deliveryStatus === "ready_to_send"
    ) {
      await this.assertStudentReplayLicense();
      if (
        !(await studentBatchAuthorizationValid(
          this.prisma,
          item.workspaceId,
          item.batchId,
          item.eventId,
        ))
      )
        throw new ReplayItemFailure(
          "inbound_webhook_replay_authorization_changed",
        );
      await this.conversionQueue.enqueueSend(
        conversion.conversionEventLogId,
        event.workspaceId,
      );
    }

    return {
      leadId: lead.id,
      conversionEventLogId: conversion.conversionEventLogId,
      duplicate: conversion.status === "duplicate",
    };
  }

  private reparseEvent(item: ReplayItemRecord): ParsedInboundWebhookEvent {
    const { delivery, connection } = item.event;
    const decrypted = this.payloadEncryption.decrypt(
      {
        encryptedPayload: delivery.encryptedPayload!,
        payloadIv: delivery.payloadIv!,
        payloadTag: delivery.payloadTag!,
        encryptionKeyVersion: delivery.encryptionKeyVersion!,
      },
      {
        workspaceId: delivery.workspaceId,
        connectionId: delivery.connectionId,
        deliveryId: delivery.id,
      },
    );
    let payload: unknown;

    try {
      payload = JSON.parse(decrypted.toString("utf8"));
    } catch {
      throw new ReplayItemFailure("inbound_webhook_replay_payload_invalid");
    }

    const parser = this.parserRegistry.resolve({
      provider: connection.provider,
      parserVersion: connection.parserRelease.version,
      parserReleaseStatus: connection.parserRelease.status,
    });
    const result = parser.parse(
      payload,
      inboundWebhookParserContext(delivery.workspaceId),
    );
    const parsedEvent = result.events.find(
      (candidate) => candidate.dedupeKey === item.event.dedupeKey,
    );

    if (
      result.error ||
      !parsedEvent ||
      parsedEvent.provider !== item.event.provider ||
      parsedEvent.externalMessageId !== item.event.externalMessageId ||
      parsedEvent.adId !== item.event.adId ||
      parsedEvent.organizationId !== item.event.channel.organizationId ||
      parsedEvent.channel.providerChannelId !==
        item.event.channel.providerChannelId
    ) {
      throw new ReplayItemFailure("inbound_webhook_replay_event_mismatch");
    }

    return parsedEvent;
  }

  private async finishBatch(
    batchId: string,
    workspaceId: string,
  ): Promise<BackofficeInboundWebhookReplayBatchDto> {
    const [
      materializedCount,
      duplicateCount,
      skippedCount,
      failedCount,
      retryableFailedCount,
    ] = await Promise.all([
      this.itemCount(batchId, workspaceId, "materialized"),
      this.itemCount(batchId, workspaceId, "duplicate"),
      this.itemCount(batchId, workspaceId, "skipped"),
      this.itemCount(batchId, workspaceId, "failed"),
      this.prisma.inboundWebhookReplayItem.count({
        where: {
          batchId,
          workspaceId,
          status: "failed",
          errorCode: {
            in: [...transientReplayErrorCodes],
          },
        },
      }),
    ]);
    const status =
      skippedCount > 0 || failedCount > 0
        ? "completed_with_failures"
        : "completed";
    const completed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.inboundWebhookReplayBatch.update({
        where: { id: batchId },
        data: {
          status,
          materializedCount,
          duplicateCount,
          skippedCount,
          failedCount,
          retryableFailedCount,
          completedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          workspaceId,
          actorUserId: null,
          actorType: "system",
          action: "inbound_webhook.replay.materialize",
          targetType: "inbound_webhook_replay_batch",
          targetId: batchId,
          resultStatus: status,
          afterSummary: {
            totalItems: updated.totalItems,
            materializedCount,
            duplicateCount,
            skippedCount,
            failedCount,
            retryableFailedCount,
          },
        },
      });

      return updated;
    });

    return this.batchDto(completed);
  }

  private async failEntireBatch(
    input: Readonly<InboundWebhookReplayJobPayload>,
    errorCode: string,
  ): Promise<BackofficeInboundWebhookReplayBatchDto> {
    const result = await this.prisma.$transaction(async (tx) => {
      const batch = await tx.inboundWebhookReplayBatch.findFirst({
        where: {
          id: input.batchId,
          workspaceId: input.workspaceId,
        },
      });

      if (!batch) {
        throw new ReplayItemFailure("inbound_webhook_replay_batch_not_found");
      }

      await tx.inboundWebhookReplayItem.updateMany({
        where: {
          workspaceId: batch.workspaceId,
          batchId: batch.id,
          status: {
            in: ["queued", "processing"],
          },
        },
        data: {
          status: "failed",
          errorCode,
          processedAt: new Date(),
        },
      });
      const failedCount = await tx.inboundWebhookReplayItem.count({
        where: {
          workspaceId: batch.workspaceId,
          batchId: batch.id,
          status: "failed",
        },
      });
      const retryableFailedCount = await tx.inboundWebhookReplayItem.count({
        where: {
          workspaceId: batch.workspaceId,
          batchId: batch.id,
          status: "failed",
          errorCode: {
            in: [...transientReplayErrorCodes],
          },
        },
      });

      return tx.inboundWebhookReplayBatch.update({
        where: { id: batch.id },
        data: {
          status: "failed",
          failedCount,
          retryableFailedCount,
          completedAt: new Date(),
        },
      });
    });

    return this.batchDto(result);
  }

  private itemCount(
    batchId: string,
    workspaceId: string,
    status: "materialized" | "duplicate" | "skipped" | "failed",
  ): Promise<number> {
    return this.prisma.inboundWebhookReplayItem.count({
      where: { batchId, workspaceId, status },
    });
  }

  private async removeUnqueuedBatch(
    batchId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.inboundWebhookReplayItem.deleteMany({
        where: { batchId, workspaceId },
      });
      await tx.inboundWebhookReplayBatch.deleteMany({
        where: { id: batchId, workspaceId, status: "queued" },
      });
      await tx.auditLog.create({
        data: {
          workspaceId,
          actorUserId: null,
          actorType: "system",
          action: "inbound_webhook.replay.enqueue",
          targetType: "inbound_webhook_replay_batch",
          targetId: batchId,
          resultStatus: "failed",
          reason: "inbound_webhook_replay_queue_unavailable",
        },
      });
    });
  }

  private async markRetryQueueUnavailable(
    batch: {
      id: string;
      workspaceId: string;
    },
    itemIds: string[],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.inboundWebhookReplayItem.updateMany({
        where: {
          workspaceId: batch.workspaceId,
          batchId: batch.id,
          id: { in: itemIds },
          status: "queued",
        },
        data: {
          status: "failed",
          errorCode: "inbound_webhook_replay_queue_unavailable",
          processedAt: new Date(),
        },
      });
      const failedCount = await tx.inboundWebhookReplayItem.count({
        where: {
          workspaceId: batch.workspaceId,
          batchId: batch.id,
          status: "failed",
        },
      });
      const retryableFailedCount = await tx.inboundWebhookReplayItem.count({
        where: {
          workspaceId: batch.workspaceId,
          batchId: batch.id,
          status: "failed",
          errorCode: {
            in: [...transientReplayErrorCodes],
          },
        },
      });

      await tx.inboundWebhookReplayBatch.update({
        where: { id: batch.id },
        data: {
          status: "completed_with_failures",
          failedCount,
          retryableFailedCount,
          completedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: batch.workspaceId,
          actorUserId: null,
          actorType: "system",
          action: "inbound_webhook.replay.retry_enqueue",
          targetType: "inbound_webhook_replay_batch",
          targetId: batch.id,
          resultStatus: "failed",
          reason: "inbound_webhook_replay_queue_unavailable",
        },
      });
    });
  }

  private async loadConnection(connectionId: string, workspaceId?: string) {
    const connection = await this.prisma.inboundWebhookConnection.findFirst({
      where: {
        id: connectionId,
        ...(workspaceId ? { workspaceId } : {}),
        removedAt: null,
      },
      include: {
        parserRelease: true,
      },
    });

    if (
      !connection ||
      (workspaceId && connection.workspaceId !== workspaceId)
    ) {
      throw new NotFoundException("Conexao nao encontrada");
    }

    return connection;
  }

  private parserReleaseDto(release: {
    id: string;
    provider: InboundWebhookParserReleaseDto["provider"];
    version: string;
    status: "observation_only" | "certified" | "retired";
    certifiedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): InboundWebhookParserReleaseDto {
    return {
      id: release.id,
      provider: release.provider,
      version: release.version,
      status: effectiveInboundParserStatus(release),
      certifiedAt: release.certifiedAt?.toISOString() ?? null,
      createdAt: release.createdAt.toISOString(),
      updatedAt: release.updatedAt.toISOString(),
    };
  }

  private batchDto(batch: {
    id: string;
    workspaceId: string;
    connectionId: string;
    channelId: string | null;
    requestedByUserId: string;
    selection: InboundWebhookReplaySelectionDto;
    requestedLimit: number;
    status:
      | "queued"
      | "processing"
      | "completed"
      | "completed_with_failures"
      | "failed";
    totalItems: number;
    materializedCount: number;
    duplicateCount: number;
    skippedCount: number;
    failedCount: number;
    retryableFailedCount: number;
    retryCount: number;
    startedAt: Date | null;
    completedAt: Date | null;
    lastRetriedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): BackofficeInboundWebhookReplayBatchDto {
    return {
      id: batch.id,
      workspaceId: batch.workspaceId,
      connectionId: batch.connectionId,
      channelId: batch.channelId,
      requestedByUserId: batch.requestedByUserId,
      selection: batch.selection,
      requestedLimit: batch.requestedLimit,
      status: batch.status,
      totalItems: batch.totalItems,
      materializedCount: batch.materializedCount,
      duplicateCount: batch.duplicateCount,
      skippedCount: batch.skippedCount,
      failedCount: batch.failedCount,
      retryableFailedCount: batch.retryableFailedCount,
      retryCount: batch.retryCount,
      startedAt: batch.startedAt?.toISOString() ?? null,
      completedAt: batch.completedAt?.toISOString() ?? null,
      lastRetriedAt: batch.lastRetriedAt?.toISOString() ?? null,
      createdAt: batch.createdAt.toISOString(),
      updatedAt: batch.updatedAt.toISOString(),
    };
  }

  private async currentRouteReady(
    client: ConstructorParameters<
      typeof InboundWebhookMetaRouteReaderService
    >[0],
    workspaceId: string,
    event: {
      adId: string | null;
      resolvedBusinessConnectionId: string | null;
      resolvedReportingAccountId: string | null;
      resolvedConversionDestinationId: string | null;
    },
  ): Promise<boolean> {
    if (
      !event.adId ||
      !event.resolvedBusinessConnectionId ||
      !event.resolvedReportingAccountId ||
      !event.resolvedConversionDestinationId
    )
      return false;
    const preview = await new InboundWebhookMetaRouteReaderService(
      client,
    ).previewRoute({
      workspaceId,
      adId: event.adId,
      businessConnectionId: event.resolvedBusinessConnectionId,
      reportingAccountId: event.resolvedReportingAccountId,
      conversionDestinationId: event.resolvedConversionDestinationId,
    });
    return (
      preview.status === "resolved" &&
      preview.businessConnectionId === event.resolvedBusinessConnectionId &&
      preview.reportingAccountId === event.resolvedReportingAccountId &&
      preview.conversionDestinationId === event.resolvedConversionDestinationId
    );
  }

  private routeReady(
    event: {
      classification: string;
      resolvedBusinessConnectionId: string | null;
      resolvedReportingAccountId: string | null;
      resolvedConversionDestinationId: string | null;
      resolvedBusinessConnection: {
        status: string;
        credential: {
          status: string;
        };
      } | null;
      resolvedReportingAccount: {
        active: boolean;
        adAccountId: string;
        businessConnectionId: string | null;
      } | null;
      resolvedConversionDestination: {
        status: string;
      } | null;
      channel: {
        routes: Array<{
          metaBusinessConnectionId: string | null;
          metaReportingAccountId: string | null;
          metaConversionDestinationId: string | null;
        }>;
      };
    },
    currentAdAccountId: string | null,
  ): boolean {
    const business = event.resolvedBusinessConnection;
    const reporting = event.resolvedReportingAccount;
    const destination = event.resolvedConversionDestination;

    return Boolean(
      event.classification === "eligible_route_resolved" &&
      event.resolvedBusinessConnectionId &&
      event.resolvedReportingAccountId &&
      event.resolvedConversionDestinationId &&
      business?.status === "active" &&
      business.credential.status === "active" &&
      reporting?.active &&
      reporting.businessConnectionId === event.resolvedBusinessConnectionId &&
      currentAdAccountId &&
      reporting.adAccountId === currentAdAccountId &&
      destination?.status === "configured" &&
      event.channel.routes.filter((route) =>
        inboundMetaRouteMatches(route, {
          businessConnectionId: event.resolvedBusinessConnectionId,
          reportingAccountId: event.resolvedReportingAccountId,
          conversionDestinationId: event.resolvedConversionDestinationId,
        }),
      ).length === 1,
    );
  }

  private replayWindowEligible(
    event: {
      delivery: {
        firstReceivedAt: Date;
      };
      channel: {
        productionActivatedAt: Date | null;
      };
    },
    connection: {
      status: string;
      productionActivatedAt: Date | null;
    },
  ): boolean {
    if ("occurredAt" in event) {
      const occurred = (event as { occurredAt: Date }).occurredAt;
      if (
        !(occurred instanceof Date) ||
        occurred.getTime() > Date.now() ||
        occurred.getTime() < Date.now() - 7 * 86400_000
      )
        return false;
    }
    if (connection.status === "observation") {
      return true;
    }

    if (
      connection.status !== "production" ||
      !connection.productionActivatedAt
    ) {
      return false;
    }

    const channelActivatedAt = event.channel.productionActivatedAt;

    return Boolean(
      !channelActivatedAt ||
      event.delivery.firstReceivedAt.getTime() <
        connection.productionActivatedAt.getTime() ||
      event.delivery.firstReceivedAt.getTime() < channelActivatedAt.getTime(),
    );
  }

  private payloadAvailable(
    delivery: {
      payloadExpiresAt: Date;
      encryptedPayload: string | null;
      payloadIv: string | null;
      payloadTag: string | null;
      encryptionKeyVersion: number | null;
    },
    now: Date,
  ): boolean {
    return Boolean(
      delivery.payloadExpiresAt.getTime() > now.getTime() &&
      delivery.encryptedPayload &&
      delivery.payloadIv &&
      delivery.payloadTag &&
      delivery.encryptionKeyVersion,
    );
  }

  private replayEnabled(): boolean {
    const config = parseInboundWebhooksConfig(this.env);

    return config.enabled && config.replayEnabled;
  }

  private async assertStudentReplayLicense(): Promise<void> {
    const decision = await this.licenseClient?.getLockState();
    if (!decision || (!decision.inert && decision.locked))
      throw new ConflictException(
        "A licenca precisa estar utilizavel antes de recuperar CTWAs",
      );
  }

  private replaySelectionLimit(
    selection: InboundWebhookReplaySelectionDto,
  ): number {
    return replaySelectionLimits[selection];
  }

  private assertReplayEnabled(): void {
    if (!this.replayEnabled()) {
      throw new ServiceUnavailableException(
        "Replay controlado desativado neste ambiente",
      );
    }
  }

  private assertJobPayload(
    input: Readonly<InboundWebhookReplayJobPayload>,
  ): void {
    if (
      !input ||
      !this.identifier(input.batchId) ||
      !this.identifier(input.workspaceId)
    ) {
      throw new ReplayItemFailure("inbound_webhook_replay_context_invalid");
    }
  }

  private identifier(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 255 &&
      !value.includes("\0")
    );
  }

  private replayErrorCode(error: unknown): string {
    return error instanceof ReplayItemFailure &&
      /^[a-z0-9_]{1,120}$/u.test(error.code)
      ? error.code
      : "inbound_webhook_replay_unexpected";
  }

  private prismaErrorCode(error: unknown): string | null {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      typeof error.code !== "string"
    ) {
      return null;
    }

    return error.code;
  }

  private metaEventId(
    provider: string,
    connectionId: string,
    dedupeKey: string,
  ): string {
    const digest = createHash("sha256")
      .update(`${connectionId}\0${dedupeKey}`, "utf8")
      .digest("hex");

    return `${provider}_lead_${digest}`;
  }

  private sourceIp(value: string | null): string | null {
    const normalized = value?.trim();

    return normalized &&
      normalized.length <= 128 &&
      !/[\u0000-\u001f\u007f]/u.test(normalized)
      ? normalized
      : null;
  }
}
