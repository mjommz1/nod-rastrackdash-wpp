import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  PipedriveConnection,
  PipedriveWebhookEvent,
  PipedriveConversionRule,
  Prisma,
} from "@prisma/client";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  conversionEventCarriesValue,
  conversionEventNameSchema,
  conversionEventRequiresValue,
  pipedriveConversionRuleCreateInputSchema,
  pipedriveConversionRuleUpdateInputSchema,
  type PipedriveConversionRuleCreateInputDto,
  type PipedriveConversionRuleUpdateInputDto,
  RULE_CURRENCY_INVALID_MESSAGE,
  hasRuleCurrencyIssue,
  normalizeCurrencyCode,
  type ConversionEventNameDto,
  type CurrencyCode,
} from "@wpptrack/shared";
import { nextMutationTime } from "../inbound-webhooks/inbound-webhook-production-activation";
import { ConversionEventsService } from "../conversion-events/conversion-events.service";
import { ConversionEventsQueueService } from "../common/queue/conversion-events-queue.service";
import { lockKommoDispatch } from "../conversion-events/kommo-dispatch-coordination";
import { loadWorkspaceConversionCurrency } from "../currency/workspace-currency";
import { PrismaService } from "../common/prisma/prisma.service";
import { pipedrivePersonPhoneHashes } from "./pipedrive-phone-match";
import { LicenseClientService } from "../licensing-client/license-client.service";
import {
  inspectPipedriveBinding,
  type PipedriveAuthorizedRoute,
  type PipedriveRouteIntent,
} from "./pipedrive-channel-policy";
import {
  crmLeadCtwaProof,
  crmLeadRoutes,
} from "../crm-channels/crm-channel-policy";
import { PipedriveAdapter, PipedriveAdapterError } from "./pipedrive.adapter";
import { PipedriveService, type PipedriveActor } from "./pipedrive.service";
import {
  classifyPipedriveDealChange,
  decodePipedriveBody,
  pipedriveDeliveryKey,
  parsePipedriveWebhookMetadata,
} from "./pipedrive-webhook.parser";
import type { AuthorizedCtwaDestination } from "../inbound-webhooks/authorized-ctwa-destination";
import {
  PIPEDRIVE_CTWA_PROCESSING_MODE,
  type PipedriveCtwaPublicationIntent,
} from "./pipedrive-production-policy";

type Tx = Prisma.TransactionClient;
type Result = {
  ruleId: string;
  eventName: string;
  status: "observed" | "materialized" | "duplicate" | "ignored";
  conversionEventLogId?: string;
  deliveryStatus?: string;
  valueCents: number | null;
  currency: string | null;
  errorCode?: string;
};
const LEASE_MS = 90_000;
const PERSON_CACHE_TTL_MS = 60_000;
const PERSON_CACHE_MAX = 500;
const ACCOUNT_CACHE_TTL_MS = 5 * 60_000;
// Relevant transitions (stage/won/lost) per connection per minute; ignored
// edits are never counted.
const RELEVANT_EVENTS_PER_MINUTE = 1200;
const MAX_ATTEMPTS = 5;
const RETRYABLE = new Set([
  "pipedrive_transport",
  "pipedrive_timeout",
  "pipedrive_rate_limited",
  "pipedrive_encryption_key_invalid",
]);

@Injectable()
export class PipedriveWebhookService {
  // Clock injection for deterministic synthetic tests; production uses wall time.
  now = () => new Date();
  private readonly logger = new Logger(PipedriveWebhookService.name);
  /** Account identity per credential generation, briefly reused across events. */
  private readonly accountCache = new Map<
    string,
    { id: string; subdomain: string; expiresAt: number }
  >();
  private readonly personCache = new Map<
    string,
    { hashes: string[]; expiresAt: number }
  >();
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PipedriveAdapter) private readonly adapter: PipedriveAdapter,
    @Inject(PipedriveService) private readonly connections: PipedriveService,
    @Optional()
    @Inject(ConversionEventsService)
    private readonly conversions?: ConversionEventsService,
    @Optional()
    @Inject(ConversionEventsQueueService)
    private readonly conversionQueue?: ConversionEventsQueueService,
    @Optional()
    @Inject(LicenseClientService)
    private readonly licenseClient?: Pick<LicenseClientService, "getLockState">,
  ) {}

  /**
   * Background work has no HTTP license guard (the public webhook and every
   * management write already get 423 from the global guard). Like Kommo, an
   * unavailable decision is treated as locked: nothing is processed,
   * materialized or published, and the durable inbox simply waits.
   */
  private async licenseAllows(): Promise<boolean> {
    if (!this.licenseClient) return false;
    try {
      const decision = await this.licenseClient.getLockState();
      return decision.inert || !decision.locked;
    } catch {
      return false;
    }
  }

  private async assertLicenseAllows(): Promise<void> {
    if (!(await this.licenseAllows()))
      throw new ServiceUnavailableException("pipedrive_license_locked");
  }

  async rotateSecret(
    workspaceId: string,
    connectionId: string,
    actor: PipedriveActor,
  ) {
    const base = this.publicOrigin(); // No fake URL if deployment configuration is missing.
    const secret = randomBytes(32).toString("base64url");
    const version = await this.transaction(async (tx) => {
      const live = await this.connections.lockConnection(
        tx,
        workspaceId,
        connectionId,
      );
      await tx.pipedriveConnection.updateMany({
        where: { id: connectionId, workspaceId },
        data: {
          mutationRevision: { increment: 1 },
          updatedAt: nextMutationTime(live.updatedAt),
          webhookSecretHash: this.hash(secret),
          webhookSecretVersion: { increment: 1 },
          webhookIssuedAt: this.now(),
        },
      });
      await this.audit(
        tx,
        workspaceId,
        connectionId,
        "webhook_secret_rotated",
        "success",
        actor,
      );
      return live.webhookSecretVersion + 1;
    });
    return {
      webhookUrl: `${base}/webhooks/pipedrive/v1/${encodeURIComponent(connectionId)}?token=${secret}`,
      version,
      rotatedAt: this.now().toISOString(),
    };
  }

  async revokeSecret(
    workspaceId: string,
    connectionId: string,
    actor: PipedriveActor,
  ) {
    await this.transaction(async (tx) => {
      const live = await this.connections.lockConnection(
        tx,
        workspaceId,
        connectionId,
      );
      await tx.pipedriveConnection.updateMany({
        where: { id: connectionId, workspaceId },
        data: {
          mutationRevision: { increment: 1 },
          updatedAt: nextMutationTime(live.updatedAt),
          webhookSecretHash: null,
          webhookIssuedAt: null,
          webhookSecretVersion: { increment: 1 },
        },
      });
      await this.audit(
        tx,
        workspaceId,
        connectionId,
        "webhook_secret_revoked",
        "success",
        actor,
      );
    });
    return { status: "revoked" as const };
  }

  async listRules(workspaceId: string, connectionId: string) {
    return this.transaction(async (tx) => {
      await this.connections.lockConnection(tx, workspaceId, connectionId);
      return (
        await tx.pipedriveConversionRule.findMany({
          where: { workspaceId, connectionId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      ).map((r) => this.ruleDto(r));
    });
  }

  async createRule(
    workspaceId: string,
    connectionId: string,
    actor: PipedriveActor,
    input: PipedriveConversionRuleCreateInputDto,
  ) {
    const data = this.parseRule(input);
    return this.transaction(async (tx) => {
      const live = await this.connections.lockConnection(
        tx,
        workspaceId,
        connectionId,
      );
      await this.requireStage(tx, live, data.pipelineId, data.stageId);
      await this.requireUniqueWonRule(tx, live, data);
      if (data.mode === "production" && data.active)
        await this.requireProduction(tx, live);
      const rule = await tx.pipedriveConversionRule.create({
        data: {
          workspaceId,
          connectionId,
          ...data,
          stageId: data.stageId ?? null,
          productionActivatedAt: data.mode === "production" ? this.now() : null,
          fixedValueCents: data.fixedValueCents ?? null,
          currency: data.currency ?? null,
          contentName: data.contentName ?? null,
        },
      });
      await this.audit(
        tx,
        workspaceId,
        rule.id,
        "rule_created",
        "success",
        actor,
      );
      await this.bumpRevision(tx, workspaceId, connectionId);
      return this.ruleDto(rule);
    });
  }

  async updateRule(
    workspaceId: string,
    connectionId: string,
    ruleId: string,
    actor: PipedriveActor,
    input: PipedriveConversionRuleUpdateInputDto,
  ) {
    const patch = pipedriveConversionRuleUpdateInputSchema.safeParse(input);
    if (!patch.success) throw new BadRequestException("Payload inválido");
    return this.transaction(async (tx) => {
      const live = await this.connections.lockConnection(
        tx,
        workspaceId,
        connectionId,
      );
      const rule = await tx.pipedriveConversionRule.findFirst({
        where: { id: ruleId, workspaceId, connectionId },
      });
      if (!rule) throw new NotFoundException("Regra Pipedrive não encontrada");
      const before = this.ruleDto(rule);
      const data = this.parseRule({
        name: before.name,
        trigger: before.trigger,
        pipelineId: before.pipelineId,
        stageId: before.stageId,
        eventName: before.eventName,
        mode: before.mode,
        valueMode: before.valueMode,
        fixedValueCents: before.fixedValueCents,
        currency: before.currency,
        contentName: before.contentName,
        active: before.active,
        ...patch.data,
      });
      if (
        data.active ||
        data.pipelineId !== rule.pipelineId ||
        data.stageId !== rule.stageId
      )
        await this.requireStage(tx, live, data.pipelineId, data.stageId);
      await this.requireUniqueWonRule(tx, live, data, ruleId);
      if (data.mode === "production" && data.active)
        await this.requireProduction(tx, live);
      await tx.pipedriveConversionRule.updateMany({
        where: { id: ruleId, workspaceId, connectionId },
        data: {
          ...data,
          stageId: data.stageId ?? null,
          productionActivatedAt:
            data.mode === "production" && data.active
              ? rule.mode === "production" && rule.active
                ? rule.productionActivatedAt
                : this.now()
              : null,
        },
      });
      await this.audit(
        tx,
        workspaceId,
        ruleId,
        "rule_updated",
        "success",
        actor,
      );
      await this.bumpRevision(tx, workspaceId, connectionId);
      return this.ruleDto(
        (await tx.pipedriveConversionRule.findFirst({
          where: { id: ruleId, workspaceId, connectionId },
        }))!,
      );
    });
  }

  async removeRule(
    workspaceId: string,
    connectionId: string,
    ruleId: string,
    actor: PipedriveActor,
  ) {
    return this.transaction(async (tx) => {
      await this.connections.lockConnection(tx, workspaceId, connectionId);
      const deleted = await tx.pipedriveConversionRule.deleteMany({
        where: { id: ruleId, workspaceId, connectionId },
      });
      if (!deleted.count)
        throw new NotFoundException("Regra Pipedrive não encontrada");
      await this.audit(
        tx,
        workspaceId,
        ruleId,
        "rule_deleted",
        "success",
        actor,
      );
      await this.bumpRevision(tx, workspaceId, connectionId);
      return { status: "deleted" as const };
    });
  }

  async listEvents(workspaceId: string, connectionId: string) {
    return this.transaction(async (tx) => {
      await this.connections.lockConnection(tx, workspaceId, connectionId);
      const rows = await tx.pipedriveWebhookEvent.findMany({
        where: { workspaceId, connectionId },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: 100,
      });
      const conversionIds = rows.flatMap((row) =>
        Array.isArray(row.results)
          ? row.results.flatMap((result) =>
              result &&
              typeof result === "object" &&
              !Array.isArray(result) &&
              typeof result.conversionEventLogId === "string"
                ? [result.conversionEventLogId]
                : [],
            )
          : [],
      );
      const publications = await tx.pipedriveConversionDedupe.findMany({
        where: {
          workspaceId,
          mode: "production",
          OR: [
            { sourceEventId: { in: rows.map((r) => r.id) } },
            { conversionEventLogId: { in: conversionIds } },
          ],
        },
      });
      return rows.map((r) => ({
        id: r.id,
        status: r.status,
        errorCode: r.errorCode,
        attempts: r.attempts,
        occurredAt: r.occurredAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
        results: Array.isArray(r.results)
          ? r.results.map((result) => {
              if (
                !result ||
                typeof result !== "object" ||
                Array.isArray(result)
              )
                return result;
              const publication = publications.find(
                (p) =>
                  p.eventName === result.eventName &&
                  (p.sourceEventId === r.id ||
                    p.conversionEventLogId === result.conversionEventLogId),
              );
              return publication
                ? {
                    ...result,
                    conversionEventLogId: publication.conversionEventLogId,
                    deliveryStatus: publication.publicationStatus,
                    deliveryErrorCode: publication.publicationErrorCode,
                    deliveryRetryable: false,
                  }
                : result;
            })
          : r.results,
      }));
    });
  }

  async retryEvent(
    workspaceId: string,
    connectionId: string,
    eventId: string,
    actor: PipedriveActor,
  ) {
    await this.transaction(async (tx) => {
      const connection = await this.connections.lockConnection(
        tx,
        workspaceId,
        connectionId,
      );
      const row = await tx.pipedriveWebhookEvent.findFirst({
        where: { id: eventId, workspaceId, connectionId },
      });
      if (!row) throw new NotFoundException("Evento Pipedrive não encontrado");
      if (
        row.status !== "failed" ||
        !this.matchesConnection(row, connection) ||
        !RETRYABLE.has(row.errorCode ?? "")
      )
        throw new ConflictException("Evento não pode ser reprocessado");
      await tx.pipedriveWebhookEvent.updateMany({
        where: { id: eventId, workspaceId, connectionId, status: "failed" },
        data: {
          status: "received",
          attempts: 0,
          errorCode: null,
          nextAttemptAt: this.now(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      await this.audit(
        tx,
        workspaceId,
        eventId,
        "webhook_retry_requested",
        "success",
        actor,
      );
    });
    return { status: "accepted" as const };
  }

  /**
   * No person lookup or rule evaluation in HTTP ingress. Commit before 202.
   * The token is checked against an unlocked read first: an unauthenticated
   * caller never takes the connection row lock and never consumes any
   * budget (there is no shared pre-authentication limiter to exhaust).
   */
  async receive(
    connectionId: string,
    secret: unknown,
    raw: unknown,
    contentType: unknown,
  ) {
    const now = this.now();
    if (!/^[a-zA-Z0-9_-]{1,255}$/.test(connectionId)) this.notFound();
    const snapshot = await this.database(() =>
      this.prisma.pipedriveConnection.findFirst({
        where: { id: connectionId },
      }),
    );
    if (!snapshot || !this.authenticate(snapshot, secret)) this.notFound();
    const decoded = decodePipedriveBody(raw, contentType);
    const classified =
      decoded === null ? null : classifyPipedriveDealChange(decoded);
    if (!classified) throw new BadRequestException("pipedrive_payload_invalid");
    // The public contract requires both account assertions even for ignored events.
    const metadata = parsePipedriveWebhookMetadata(decoded);
    const at = metadata?.occurredAt;
    if (
      !metadata ||
      !at ||
      metadata.accountId !== snapshot.verifiedAccountId ||
      metadata.accountSubdomain !== snapshot.accountSubdomain ||
      +at > +now + 300_000 ||
      +at < +now - 7 * 86400_000 ||
      +at < +snapshot.credentialActivatedAt
    )
      throw new BadRequestException("pipedrive_identity_or_timestamp_invalid");
    const event = classified.kind === "event" ? classified.event : null;
    if (!event) {
      // Custom field / other edits: accepted and dropped. They are never
      // stored, never rate limited (a bulk edit must not starve real stage
      // changes) and only touch the receipt telemetry.
      await this.touchReceipt(snapshot, now);
      return { status: "accepted" as const };
    }
    return this.transaction(async (tx) => {
      const live = await this.connections.lockConnection(
        tx,
        snapshot.workspaceId,
        connectionId,
      );
      // Re-check under the lock: the secret may have rotated meanwhile.
      if (
        !this.authenticate(live, secret) ||
        live.verifiedAccountId !== snapshot.verifiedAccountId ||
        live.accountSubdomain !== snapshot.accountSubdomain
      )
        this.notFound();
      // Durable per-connection limit, shared by all API processes; counts
      // only relevant transitions (stage/won/lost), never ignored edits.
      const reset =
        !live.webhookRateWindowAt || +now - +live.webhookRateWindowAt >= 60_000;
      const count = reset ? 1 : live.webhookRateCount + 1;
      if (count > RELEVANT_EVENTS_PER_MINUTE)
        throw new HttpException("pipedrive_rate_limited", 429);
      // A lost deal is recorded for history only: it never converts.
      const ignoredCode =
        event.kind === "deal_lost" ? "deal_lost_no_conversion" : null;
      // Transition identity excludes retry counters and meta.id (see parser).
      const deliveryKey = pipedriveDeliveryKey(connectionId, event);
      const duplicate = await tx.pipedriveWebhookEvent.findFirst({
        where: { connectionId, workspaceId: live.workspaceId, deliveryKey },
      });
      // Telemetry only: never a configuration revision (the panel read uses
      // mutationRevision/updatedAt as its consistency fence).
      await tx.pipedriveConnection.updateMany({
        where: { id: connectionId, workspaceId: live.workspaceId },
        data: {
          updatedAt: live.updatedAt,
          webhookLastReceivedAt: now,
          webhookRateWindowAt: reset ? now : live.webhookRateWindowAt,
          webhookRateCount: count,
        },
      });
      if (!duplicate) {
        const row = await tx.pipedriveWebhookEvent.create({
          data: {
            workspaceId: live.workspaceId,
            connectionId,
            deliveryKey,
            verifiedAccountId: live.verifiedAccountId!,
            accountSubdomain: live.accountSubdomain!,
            credentialGeneration: live.credentialGeneration,
            webhookSecretVersion: live.webhookSecretVersion,
            changeKind: event.kind,
            dealId: event.dealId,
            pipelineId: event.pipelineId,
            stageId: event.stageId,
            oldStageId: event.oldStageId,
            dealStatus: event.dealStatus,
            previousDealStatus: event.previousDealStatus,
            personId: event.personId,
            occurredAt: at,
            valueCents:
              event.valueCents != null ? BigInt(event.valueCents) : null,
            valuePresent: event.valuePresent,
            currency: event.currency,
            status: ignoredCode ? "ignored" : "received",
            errorCode: ignoredCode,
            nextAttemptAt: ignoredCode ? null : now,
            createdAt: now,
          },
        });
        await this.audit(
          tx,
          live.workspaceId,
          row.id,
          "webhook_received",
          ignoredCode ? "ignored" : "accepted",
        );
      }
      return { status: "accepted" as const };
    });
  }

  /** Last-receipt telemetry without the row lock and without a revision bump. */
  private async touchReceipt(snapshot: PipedriveConnection, now: Date) {
    await this.database(() =>
      this.prisma.pipedriveConnection.updateMany({
        where: {
          id: snapshot.id,
          workspaceId: snapshot.workspaceId,
          updatedAt: snapshot.updatedAt,
        },
        data: { updatedAt: snapshot.updatedAt, webhookLastReceivedAt: now },
      }),
    );
  }

  /** Row lease and durable retry times are the queue. No Redis enqueue gap. */
  async sweep() {
    // Locked license: leave every row untouched until it is reactivated.
    if (!(await this.licenseAllows())) return { scanned: 0, published: 0 };
    const now = this.now();
    const rows = await this.database(() =>
      this.prisma.pipedriveWebhookEvent.findMany({
        where: {
          OR: [
            { status: "received", nextAttemptAt: { lte: now } },
            { status: "retry", nextAttemptAt: { lte: now } },
            { status: "processing", leaseExpiresAt: { lte: now } },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 25,
      }),
    );
    for (const row of rows) {
      try {
        await this.process(row.id, row.workspaceId);
      } catch (error) {
        // Durable state remains reclaimable. Log only the error class and the
        // inbox row id: never provider, database or personal text.
        this.logger.warn(
          JSON.stringify({
            event: "pipedrive.webhook.process_failed",
            webhookEventId: row.id,
            errorClass:
              error instanceof Error ? error.constructor.name : typeof error,
          }),
        );
      }
    }
    const published = await this.publishPending();
    return { scanned: rows.length, published };
  }

  async process(eventId: string, workspaceId: string) {
    if (!(await this.licenseAllows()))
      return { status: "license_locked" as string };
    const claim = await this.transaction(async (tx) => {
      const stored = await tx.pipedriveWebhookEvent.findFirst({
        where: { id: eventId, workspaceId },
      });
      if (!stored) return null;
      const live = await this.connections.lockConnection(
        tx,
        workspaceId,
        stored.connectionId,
      );
      const event = await tx.pipedriveWebhookEvent.findFirst({
        where: { id: eventId, workspaceId },
      });
      if (!event || !["received", "retry", "processing"].includes(event.status))
        return null;
      if (
        event.status === "processing" &&
        event.leaseExpiresAt &&
        +event.leaseExpiresAt > +this.now()
      )
        return null;
      if (event.nextAttemptAt && +event.nextAttemptAt > +this.now())
        return null;
      if (!this.matchesConnection(event, live)) {
        await this.finish(tx, event, "ignored", "connection_fence_changed");
        return null;
      }
      if (event.attempts >= MAX_ATTEMPTS) {
        await this.finish(tx, event, "failed", "attempts_exhausted");
        return null;
      }
      const leaseToken = randomUUID();
      await tx.pipedriveWebhookEvent.updateMany({
        where: { id: eventId, workspaceId },
        data: {
          status: "processing",
          leaseToken,
          leaseExpiresAt: new Date(+this.now() + LEASE_MS),
          nextAttemptAt: null,
          attempts: { increment: 1 },
        },
      });
      return {
        event: { ...event, leaseToken, attempts: event.attempts + 1 },
        connection: live,
      };
    });
    if (!claim) return { status: "missing_or_complete" as string };
    const { event, connection } = claim;
    const context = await this.transaction(async (tx) => {
      const live = await this.connections.lockConnection(
        tx,
        workspaceId,
        connection.id,
      );
      const code = await this.triggerFailure(tx, event, live);
      if (code === "catalog_stale") {
        const rule = await tx.pipedriveConversionRule.findFirst({
          where: {
            ...this.ruleWhere(event, live.id),
            mode: "production",
            productionActivatedAt: { lte: event.occurredAt },
          },
        });
        if (rule) return { refreshCatalog: true };
      }
      if (code) {
        await this.finishLeased(tx, event, "ignored", code);
        return null;
      }
      return { refreshCatalog: false };
    });
    if (!context) return { status: "ignored" };
    try {
      // Reuse the credential/account/generation-fenced catalog service. A
      // transient refresh failure follows the existing durable inbox retry.
      if (context.refreshCatalog)
        await this.connections.refreshCatalog(workspaceId, connection.id);
      if (!event.personId) return this.ignore(event, "person_missing");
      const token = this.connections.decrypt(connection);
      const account = await this.verifiedAccount(connection, token);
      if (
        account.id !== connection.verifiedAccountId ||
        account.subdomain !== connection.accountSubdomain
      )
        return this.ignore(event, "pipedrive_account_mismatch", true);
      // The webhook has no phone/e-mail: fetch the person with the stored
      // credential (worker only, never in the HTTP request path).
      const person = await this.personPhoneHashes(
        connection,
        token,
        event.personId,
      );
      if ("error" in person) return this.ignore(event, person.error);
      const hashes = person.hashes;
      if (!hashes.length) return this.ignore(event, "phone_missing");
      // Remote enrichment can outlive an allowed decision: recheck before the
      // transaction that writes conversions, and again inside it (below).
      await this.assertLicenseAllows();
      return await this.transaction(async (tx) => {
        await lockKommoDispatch(tx, workspaceId);
        const live = await this.connections.lockConnection(
          tx,
          workspaceId,
          connection.id,
        );
        if (
          !(await tx.pipedriveWebhookEvent.findFirst({
            where: this.leaseWhere(event),
          }))
        )
          return { status: "lease_lost" };
        const trigger = await this.triggerFailure(tx, event, live);
        if (trigger) return this.finishLeased(tx, event, "ignored", trigger);
        // Resolve only an existing lead, in the captured workspace. No lead/CTWA writes.
        // All person phones (and BR 9th-digit variants) are candidates; only
        // more than one DISTINCT active lead is ambiguous.
        const candidates = await tx.lead.findMany({
          where: { workspaceId, phoneHash: { in: hashes }, status: "active" },
          select: { id: true },
          take: 3,
        });
        if (candidates.length > 1)
          return this.finishLeased(tx, event, "ignored", "phone_ambiguous");
        if (candidates[0])
          await tx.$queryRaw`SELECT "id" FROM "Lead" WHERE "workspaceId" = ${workspaceId} AND "id" = ${candidates[0].id} FOR UPDATE`;
        const lead = !candidates[0]
          ? null
          : await tx.lead.findFirst({
              where: { id: candidates[0].id, workspaceId },
              select: {
                id: true,
                workspaceId: true,
                whatsappInstanceId: true,
                status: true,
                phoneHash: true,
                adId: true,
                ctwaClid: true,
                campaignId: true,
                adSetId: true,
              },
            });
        if (
          !lead ||
          lead.workspaceId !== workspaceId ||
          lead.status !== "active"
        )
          return this.finishLeased(
            tx,
            event,
            "ignored",
            "workspace_lead_not_found",
          );
        const destination = await this.leadDestination(tx, live, lead);
        if ("error" in destination)
          return this.finishLeased(tx, event, "ignored", destination.error);
        const { routes, ctwa } = destination;
        // Last decision before the first write of this transaction (a failure
        // rolls everything back and releases the row for a later attempt).
        await this.assertLicenseAllows();
        const rules = await tx.pipedriveConversionRule.findMany({
          where: {
            ...this.ruleWhere(event, live.id),
            mode: { in: ["observation", "production"] },
          },
          orderBy: { id: "asc" },
        });
        // Regra sem moeda válida e negócio sem moeda: "Moeda das conversões".
        const workspaceCurrency = await loadWorkspaceConversionCurrency(
          tx,
          workspaceId,
        );
        const results: Result[] = [];
        for (const rule of rules) {
          const value = this.valueFor(rule, event, workspaceCurrency);
          if ("error" in value) {
            results.push({
              ruleId: rule.id,
              eventName: rule.eventName,
              status: "ignored",
              valueCents: null,
              currency: null,
              errorCode: value.error,
            });
            continue;
          }
          if (rule.mode === "production") {
            // Ad-attributed lead: canonical Kommo-class route. CTWA lead with no
            // ad id, or a lead of an official-API number bound by channel
            // (inherit_workspace) with no matching route: the page/pixel
            // destination proven by its entry.
            const viaRoute = Boolean(lead.adId) && (routes.length > 0 || !ctwa);
            const failure = this.productionFailure(
              event,
              rule,
              viaRoute ? (routes[0] ?? null) : null,
            );
            let errorCode: string | null = failure;
            let assignment: {
              reportingAccountId: string;
              conversionDestinationId: string;
            } | null = null;
            if (!errorCode && viaRoute) {
              assignment =
                lead.adId && lead.ctwaClid && routes.length === 1
                  ? await tx.metaAdDestinationAssignment.findUnique({
                      where: {
                        workspaceId_adId: { workspaceId, adId: lead.adId },
                      },
                    })
                  : null;
              errorCode =
                routes.length !== 1
                  ? "lead_channel_route_unauthorized"
                  : !lead.ctwaClid
                    ? "lead_channel_or_attribution_unproven"
                    : !assignment
                      ? "lead_destination_unproven"
                      : assignment.reportingAccountId !==
                            routes[0]!.metaReportingAccountId ||
                          assignment.conversionDestinationId !==
                            routes[0]!.metaConversionDestinationId
                        ? "lead_destination_mismatch"
                        : null;
            } else if (!errorCode && !ctwa)
              errorCode = "lead_channel_or_attribution_unproven";
            if (errorCode) {
              results.push({
                ruleId: rule.id,
                eventName: rule.eventName,
                status: "ignored",
                valueCents: value.cents,
                currency: value.currency,
                errorCode,
              });
              continue;
            }
            const conversion = viaRoute
              ? await this.materialize(
                  tx,
                  event,
                  live,
                  rule,
                  lead,
                  routes[0]!,
                  value,
                )
              : await this.materializeCtwa(
                  tx,
                  event,
                  live,
                  rule,
                  lead,
                  ctwa!,
                  value,
                );
            results.push({
              ruleId: rule.id,
              eventName: rule.eventName,
              status:
                conversion.status === "created" ? "materialized" : "duplicate",
              valueCents: value.cents,
              currency: value.currency,
              conversionEventLogId: conversion.conversionEventLogId,
              deliveryStatus: conversion.deliveryStatus,
            });
            continue;
          }
          const key = {
            workspaceId,
            verifiedAccountId: event.verifiedAccountId,
            dealId: event.dealId!,
            eventName: rule.eventName,
            mode: "observation",
          };
          const existing = await tx.pipedriveConversionDedupe.findFirst({
            where: key,
          });
          if (!existing)
            await tx.pipedriveConversionDedupe.create({
              data: { ...key, sourceEventId: event.id },
            });
          results.push({
            ruleId: rule.id,
            eventName: rule.eventName,
            status: existing ? "duplicate" : "observed",
            valueCents: value.cents,
            currency: value.currency,
          });
        }
        const status = results.some((r) => r.status === "materialized")
          ? "materialized"
          : results.some((r) => r.status === "observed")
            ? "observed"
            : results.some((r) => r.status === "duplicate")
              ? "duplicate"
              : "ignored";
        return this.finishLeased(
          tx,
          event,
          status,
          results.find((r) => r.errorCode)?.errorCode ?? null,
          results,
          lead.id,
          routes.length === 1 ? routes[0]!.id : undefined,
        );
      });
    } catch (error) {
      if (
        error instanceof HttpException &&
        error.message === "pipedrive_license_locked"
      )
        return this.releaseForLicense(event);
      const code =
        error instanceof PipedriveAdapterError
          ? error.code
          : error instanceof HttpException &&
              [
                "credential_decrypt_failed",
                "pipedrive_encryption_key_invalid",
                "pipedrive_transport",
                "pipedrive_timeout",
                "pipedrive_rate_limited",
                "pipedrive_unauthorized",
                "pipedrive_account_mismatch",
              ].includes(error.message)
            ? error.message
            : "pipedrive_transport";
      // Persistence failures are not misreported as provider failures.
      if (
        error instanceof HttpException &&
        error.message === "pipedrive_persistence_failed"
      )
        throw error;
      if (!RETRYABLE.has(code))
        return this.ignore(
          event,
          code,
          code === "pipedrive_unauthorized" ||
            code === "credential_decrypt_failed",
        );
      return this.transaction(async (tx) => {
        await this.connections.lockConnection(tx, workspaceId, connection.id);
        const failed = event.attempts >= MAX_ATTEMPTS;
        const changed = await tx.pipedriveWebhookEvent.updateMany({
          where: this.leaseWhere(event),
          data: {
            status: failed ? "failed" : "retry",
            errorCode: code,
            nextAttemptAt: failed
              ? null
              : new Date(+this.now() + 30_000 * 2 ** (event.attempts - 1)),
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        if (changed.count)
          await this.audit(
            tx,
            workspaceId,
            event.id,
            "webhook_processed",
            failed ? "failed" : "retry",
          );
        return {
          status: changed.count ? (failed ? "failed" : "retry") : "lease_lost",
        };
      });
    }
  }

  private async requireProduction(tx: Tx, live: PipedriveConnection) {
    if (!this.conversions || !this.conversionQueue)
      throw new ConflictException("pipedrive_production_disabled");
    if (
      live.status !== "active" ||
      !live.credentialHealthy ||
      !live.webhookSecretHash ||
      !live.allowedChannelRouteIds.length
    )
      throw new ConflictException("pipedrive_production_context_invalid");
    for (const bindingId of live.allowedChannelRouteIds) {
      if (!(await inspectPipedriveBinding(tx, live.workspaceId, bindingId)).ok)
        throw new ConflictException("pipedrive_production_context_invalid");
    }
  }

  private productionFailure(
    event: PipedriveWebhookEvent,
    rule: PipedriveConversionRule,
    route: PipedriveAuthorizedRoute | null,
  ) {
    if (!this.conversions || !this.conversionQueue)
      return "pipedrive_production_disabled";
    const activated = rule.productionActivatedAt;
    if (
      !activated ||
      event.createdAt < activated ||
      event.occurredAt < activated
    )
      return "production_activation_fence";
    // CTWA destination fences (channel/connection activation, billing, parser
    // certification) are re-checked by the canonical CTWA sender.
    if (
      route &&
      (event.createdAt < route.channel.productionActivatedAt ||
        event.occurredAt < route.channel.productionActivatedAt ||
        event.createdAt < route.channel.connection.productionActivatedAt ||
        event.occurredAt < route.channel.connection.productionActivatedAt)
    )
      return "channel_activation_fence";
    return null;
  }

  /** Rules a classified transition can trigger: the entered stage, or the
   * won-deal rule of the deal's pipeline. Lost/ignored never reach here. */
  private ruleWhere(event: PipedriveWebhookEvent, connectionId: string) {
    return event.changeKind === "deal_won"
      ? {
          workspaceId: event.workspaceId,
          connectionId,
          trigger: "deal_won",
          pipelineId: event.pipelineId!,
          active: true,
        }
      : {
          workspaceId: event.workspaceId,
          connectionId,
          trigger: "stage_change",
          pipelineId: event.pipelineId!,
          stageId: event.stageId!,
          active: true,
        };
  }

  private async verifiedAccount(
    connection: PipedriveConnection,
    token: string,
  ) {
    const key = `${connection.id}:${connection.credentialGeneration}`;
    const now = +this.now();
    const cached = this.accountCache.get(key);
    if (cached && cached.expiresAt > now)
      return { id: cached.id, subdomain: cached.subdomain };
    const account = await this.adapter.verify(connection.accountOrigin, token);
    if (this.accountCache.size >= PERSON_CACHE_MAX) this.accountCache.clear();
    this.accountCache.set(key, {
      ...account,
      expiresAt: now + ACCOUNT_CACHE_TTL_MS,
    });
    return account;
  }

  /**
   * Person phones -> identity hashes, cached briefly per connection credential
   * generation + person so a burst of deal edits does not refetch the person.
   * Only hashes are cached; raw phones/e-mails never leave this call.
   */
  private async personPhoneHashes(
    connection: PipedriveConnection,
    token: string,
    personId: string,
  ): Promise<{ hashes: string[] } | { error: string }> {
    const key = `${connection.id}:${connection.credentialGeneration}:${personId}`;
    const now = +this.now();
    const cached = this.personCache.get(key);
    if (cached && cached.expiresAt > now) return { hashes: cached.hashes };
    const person = await this.adapter.getPerson(
      connection.accountOrigin,
      token,
      personId,
    );
    if (person.id !== personId) return { error: "person_identity_mismatch" };
    const hashes = pipedrivePersonPhoneHashes(person.phones);
    if (this.personCache.size >= PERSON_CACHE_MAX) {
      for (const [entry, value] of this.personCache)
        if (value.expiresAt <= now || this.personCache.size >= PERSON_CACHE_MAX)
          this.personCache.delete(entry);
    }
    this.personCache.set(key, { hashes, expiresAt: now + PERSON_CACHE_TTL_MS });
    return { hashes };
  }

  /**
   * The lead must belong to a channel this connection is bound to: either a
   * valid route on the lead's WhatsApp number (ad-attributed path, as Kommo),
   * or — for a CTWA lead without an ad id — the materialized CTWA entry proof
   * of an allowed channel (page/pixel destination, as the CTWA purchase path).
   */
  private async leadDestination(
    tx: Tx,
    live: PipedriveConnection,
    lead: {
      id: string;
      workspaceId: string;
      phoneHash: string;
      whatsappInstanceId: string | null;
      adId: string | null;
      ctwaClid: string | null;
    },
  ): Promise<
    | {
        routes: PipedriveAuthorizedRoute[];
        ctwa: AuthorizedCtwaDestination | null;
      }
    | { error: string }
  > {
    // Shared CRM channel policy (Kommo/Pipedrive): route bindings matched by
    // the lead's WhatsApp instance (UAZAPI) or its materialized entry receipt
    // (official-API numbers); page/pixel proof for CTWA leads.
    const routes: PipedriveAuthorizedRoute[] = await crmLeadRoutes(
      tx,
      lead,
      live.allowedChannelRouteIds,
    );
    const ctwa: AuthorizedCtwaDestination | null = await crmLeadCtwaProof(
      tx,
      lead,
      live.allowedChannelRouteIds,
    );
    if (routes.length !== 1 && !ctwa)
      return {
        error: routes.length
          ? "lead_channel_route_ambiguous"
          : "lead_channel_route_unauthorized",
      };
    return { routes, ctwa };
  }

  private productionKey(event: PipedriveWebhookEvent, eventName: string) {
    const key = {
      workspaceId: event.workspaceId,
      verifiedAccountId: event.verifiedAccountId,
      dealId: event.dealId!,
      eventName,
      mode: "production",
    };
    const digest = this.hash(
      JSON.stringify([
        key.workspaceId,
        key.verifiedAccountId,
        key.dealId,
        key.eventName,
      ]),
    );
    return { key, dedupeKey: `pipedrive:${digest}` };
  }

  /** CTWA lead (no ad id): canonical conversion carrying the proven channel
   * page/pixel destination; the existing CTWA sender delivers it. */
  private async materializeCtwa(
    tx: Tx,
    event: PipedriveWebhookEvent,
    live: PipedriveConnection,
    rule: PipedriveConversionRule,
    lead: { id: string; phoneHash: string; ctwaClid: string | null },
    proof: AuthorizedCtwaDestination,
    value: { cents: number | null; currency: string | null },
  ) {
    const { key, dedupeKey } = this.productionKey(event, rule.eventName);
    const existing = await tx.pipedriveConversionDedupe.findFirst({
      where: key,
    });
    if (existing?.conversionEventLogId)
      return {
        conversionEventLogId: existing.conversionEventLogId,
        status: "duplicate",
        deliveryStatus: existing.publicationStatus,
      };
    if (existing)
      throw new ConflictException("pipedrive_materialization_incomplete");
    if (await tx.conversionEventLog.findUnique({ where: { dedupeKey } }))
      throw new ConflictException("pipedrive_semantic_identity_conflict");
    const recorded = await this.conversions!.recordExternalConversion(
      {
        ctwaDestination: proof,
        workspaceId: event.workspaceId,
        sourceEventId: event.id,
        sourceTrigger: "pipedrive_stage",
        eventName: conversionEventNameSchema.parse(rule.eventName),
        eventId: dedupeKey,
        dedupeKey,
        leadId: lead.id,
        phoneHash: lead.phoneHash,
        businessSource: "paid",
        adId: null,
        ctwaClid: lead.ctwaClid,
        valueCents: value.cents,
        valueSource:
          value.cents === null
            ? null
            : rule.valueMode === "fixed"
              ? "configured_average"
              : "actual",
        currency: value.currency,
        contentName: rule.contentName,
        eventOccurredAt: event.occurredAt,
        sourcePayload: {
          provider: "pipedrive",
          processingMode: PIPEDRIVE_CTWA_PROCESSING_MODE,
          channelId: proof.channelId,
          connectionId: proof.connectionId,
          pipedriveConnectionId: live.id,
          pipedriveRuleId: rule.id,
          changeKind: event.changeKind,
          verifiedAccountId: event.verifiedAccountId,
          dealId: event.dealId,
          pipelineId: event.pipelineId,
          stageId: event.stageId,
        },
      },
      tx,
    );
    const intent: PipedriveCtwaPublicationIntent = {
      kind: "ctwa_destination",
      pipedriveConnectionId: live.id,
      channelId: proof.channelId,
      connectionId: proof.connectionId,
      destinationId: proof.destinationId,
      eventId: dedupeKey,
    };
    await tx.pipedriveConversionDedupe.create({
      data: {
        ...key,
        sourceEventId: event.id,
        conversionEventLogId: recorded.conversionEventLogId,
        publicationIntent: intent,
        publicationStatus:
          recorded.deliveryStatus === "ready_to_send"
            ? "publication_pending"
            : "materialized",
        publicationNextAttemptAt: this.now(),
      },
    });
    return recorded;
  }

  private async materialize(
    tx: Tx,
    event: PipedriveWebhookEvent,
    live: PipedriveConnection,
    rule: PipedriveConversionRule,
    lead: {
      id: string;
      phoneHash: string;
      whatsappInstanceId: string | null;
      campaignId: string | null;
      adSetId: string | null;
      adId: string | null;
      ctwaClid: string | null;
    },
    route: PipedriveAuthorizedRoute,
    value: { cents: number | null; currency: string | null },
  ) {
    const { key, dedupeKey } = this.productionKey(event, rule.eventName);
    const existing = await tx.pipedriveConversionDedupe.findFirst({
      where: key,
    });
    if (existing?.conversionEventLogId)
      return {
        conversionEventLogId: existing.conversionEventLogId,
        status: "duplicate",
        deliveryStatus: existing.publicationStatus,
      };
    if (existing)
      throw new ConflictException("pipedrive_materialization_incomplete");
    const prior = await tx.conversionEventLog.findUnique({
      where: { dedupeKey },
    });
    if (prior)
      throw new ConflictException("pipedrive_semantic_identity_conflict");
    const recorded = await this.conversions!.recordExternalConversion(
      {
        workspaceId: event.workspaceId,
        sourceEventId: event.id,
        sourceTrigger: "pipedrive_stage",
        eventName: conversionEventNameSchema.parse(rule.eventName),
        eventId: dedupeKey,
        dedupeKey,
        leadId: lead.id,
        phoneHash: lead.phoneHash,
        businessSource: "paid",
        campaignId: lead.campaignId,
        adSetId: lead.adSetId,
        adId: lead.adId,
        ctwaClid: lead.ctwaClid,
        metaAccountId: route.metaReportingAccount.adAccountId,
        metaBusinessConnectionId: route.metaBusinessConnectionId,
        metaConversionDestinationId: route.metaConversionDestinationId,
        valueCents: value.cents,
        valueSource:
          value.cents === null
            ? null
            : rule.valueMode === "fixed"
              ? "configured_average"
              : "actual",
        currency: value.currency,
        contentName: rule.contentName,
        eventOccurredAt: event.occurredAt,
        sourcePayload: {
          provider: "pipedrive",
          verifiedAccountId: event.verifiedAccountId,
          dealId: event.dealId,
          pipelineId: event.pipelineId,
          stageId: event.stageId,
          changeKind: event.changeKind,
        },
      },
      tx,
    );
    const intent: PipedriveRouteIntent = {
      connectionId: live.id,
      routeId: route.id,
      channelId: route.channel.id,
      // UAZAPI: the lead's instance (matched above); official API: none.
      whatsappInstanceId: route.channel.whatsappInstanceId ?? null,
      destinationId: route.metaConversionDestinationId,
      pixelId: route.metaConversionDestination.pixelId,
      pageId: route.metaConversionDestination.pageId,
      businessConnectionId: route.metaBusinessConnectionId,
      reportingAccountId: route.metaReportingAccountId,
      eventId: dedupeKey,
    };
    await tx.pipedriveConversionDedupe.create({
      data: {
        ...key,
        sourceEventId: event.id,
        conversionEventLogId: recorded.conversionEventLogId,
        publicationIntent: intent,
        publicationStatus:
          recorded.deliveryStatus === "ready_to_send"
            ? "publication_pending"
            : "materialized",
        publicationNextAttemptAt: this.now(),
      },
    });
    return recorded;
  }

  /** Same durable publication -> existing conversion queue -> canonical sender
   * contract as Kommo. A queue acknowledgement never means Meta accepted it. */
  private async publishPending() {
    if (!this.conversions || !this.conversionQueue) return 0;
    const now = this.now();
    const rows = await this.database(() =>
      this.prisma.pipedriveConversionDedupe.findMany({
        where: {
          mode: "production",
          publicationStatus: {
            in: ["publication_pending", "queued", "delivery_unknown"],
          },
          AND: [
            {
              OR: [
                { publicationNextAttemptAt: null },
                { publicationNextAttemptAt: { lte: now } },
              ],
            },
            {
              OR: [
                { publicationLeaseToken: null },
                { publicationLeaseExpiresAt: { lte: now } },
              ],
            },
          ],
        },
        orderBy: [
          { publicationNextAttemptAt: { sort: "asc", nulls: "first" } },
          { createdAt: "asc" },
          { id: "asc" },
        ],
        take: 25,
      }),
    );
    for (const row of rows) {
      const token = randomUUID();
      const claim = await this.database(() =>
        this.prisma.pipedriveConversionDedupe.updateMany({
          where: {
            id: row.id,
            workspaceId: row.workspaceId,
            publicationStatus: {
              in: ["publication_pending", "queued", "delivery_unknown"],
            },
            AND: [
              {
                OR: [
                  { publicationNextAttemptAt: null },
                  { publicationNextAttemptAt: { lte: now } },
                ],
              },
              {
                OR: [
                  { publicationLeaseToken: null },
                  { publicationLeaseExpiresAt: { lte: now } },
                ],
              },
            ],
          },
          data: {
            publicationLeaseToken: token,
            publicationLeaseExpiresAt: new Date(+now + LEASE_MS),
          },
        }),
      );
      if (!claim.count) continue;
      const owned = await this.database(() =>
        this.prisma.pipedriveConversionDedupe.findFirst({
          where: {
            id: row.id,
            workspaceId: row.workspaceId,
            publicationLeaseToken: token,
          },
        }),
      );
      if (!owned?.conversionEventLogId) continue;
      const lease = {
        id: row.id,
        workspaceId: row.workspaceId,
        publicationLeaseToken: token,
        publicationLeaseExpiresAt: { gt: this.now() },
      };
      const ctwaIntent = owned.publicationIntent as
        PipedriveCtwaPublicationIntent | Record<string, unknown> | null;
      if (ctwaIntent?.kind === "ctwa_destination") {
        await this.publishCtwa(owned, lease, now);
        continue;
      }
      try {
        const outcome = await this.conversions.preparePipedriveSenderRetry(
          owned.conversionEventLogId,
          owned.workspaceId,
        );
        let status =
          outcome === "sent"
            ? "sent"
            : outcome === "delivery_unknown"
              ? "delivery_unknown"
              : outcome === "revoked"
                ? "revoked"
                : "publication_failed";
        if (
          outcome === "ready_to_send" &&
          owned.publicationStatus !== "delivery_unknown"
        ) {
          await this.conversionQueue.retrySend(
            owned.conversionEventLogId,
            owned.workspaceId,
          );
          status = "queued";
        }
        await this.database(() =>
          this.prisma.pipedriveConversionDedupe.updateMany({
            where: {
              ...lease,
              publicationStatus:
                status === "delivery_unknown"
                  ? "delivery_unknown"
                  : {
                      in: ["publication_pending", "queued", "delivery_unknown"],
                    },
            },
            data: {
              publicationStatus: status,
              publicationErrorCode:
                status === "delivery_unknown"
                  ? "pipedrive_delivery_unknown"
                  : status === "revoked"
                    ? "publication_authorization_revoked"
                    : status === "publication_failed"
                      ? "sender_not_ready"
                      : null,
              publicationLeaseToken: null,
              publicationLeaseExpiresAt: null,
              publicationNextAttemptAt: new Date(+now + 30000),
            },
          }),
        );
      } catch {
        const attempts = owned.publicationAttempts + 1;
        await this.database(() =>
          this.prisma.pipedriveConversionDedupe.updateMany({
            where: {
              ...lease,
              publicationStatus: { in: ["publication_pending", "queued"] },
            },
            data: {
              publicationStatus:
                attempts >= MAX_ATTEMPTS
                  ? "publication_failed"
                  : "publication_pending",
              publicationAttempts: attempts,
              publicationErrorCode: "conversion_enqueue_failed",
              publicationLeaseToken: null,
              publicationLeaseExpiresAt: null,
              publicationNextAttemptAt: new Date(
                +now + Math.min(30000 * 2 ** attempts, 900000),
              ),
            },
          }),
        );
      }
    }
    return rows.length;
  }

  /**
   * CTWA destination conversions are delivered by the canonical CTWA sender,
   * whose own ready_to_send -> dispatching claim is the single-send fence. The
   * outbox only enqueues and mirrors the conversion log state.
   */
  private async publishCtwa(
    owned: {
      id: string;
      workspaceId: string;
      conversionEventLogId: string | null;
      publicationStatus: string;
      publicationAttempts: number;
    },
    lease: Record<string, unknown>,
    now: Date,
  ) {
    const settle = (data: Record<string, unknown>, from: string[]) =>
      this.database(() =>
        this.prisma.pipedriveConversionDedupe.updateMany({
          where: { ...lease, publicationStatus: { in: from } } as never,
          data: {
            ...data,
            publicationLeaseToken: null,
            publicationLeaseExpiresAt: null,
          },
        }),
      );
    try {
      const log = await this.database(() =>
        this.prisma.conversionEventLog.findFirst({
          where: {
            id: owned.conversionEventLogId!,
            workspaceId: owned.workspaceId,
            sourceTrigger: "pipedrive_stage",
          },
          select: { status: true },
        }),
      );
      let status: string;
      if (log?.status === "sent") status = "sent";
      else if (log?.status === "ready_to_send") {
        await this.conversionQueue!.retrySend(
          owned.conversionEventLogId!,
          owned.workspaceId,
        );
        status = "queued";
      } else if (
        log?.status === "dispatching" ||
        log?.status === "delivery_unknown"
      )
        status = "delivery_unknown";
      else status = "publication_failed";
      await settle(
        {
          publicationStatus: status,
          publicationErrorCode:
            status === "delivery_unknown"
              ? "pipedrive_delivery_unknown"
              : status === "publication_failed"
                ? "sender_not_ready"
                : null,
          publicationNextAttemptAt: new Date(+now + 30_000),
        },
        ["publication_pending", "queued", "delivery_unknown"],
      );
    } catch {
      const attempts = owned.publicationAttempts + 1;
      await settle(
        {
          publicationStatus:
            attempts >= MAX_ATTEMPTS
              ? "publication_failed"
              : "publication_pending",
          publicationAttempts: attempts,
          publicationErrorCode: "conversion_enqueue_failed",
          publicationNextAttemptAt: new Date(
            +now + Math.min(30000 * 2 ** attempts, 900000),
          ),
        },
        ["publication_pending", "queued"],
      ).catch(() => undefined);
    }
  }

  private async bumpRevision(
    tx: Tx,
    workspaceId: string,
    connectionId: string,
  ) {
    const live = await this.connections.lockConnection(
      tx,
      workspaceId,
      connectionId,
    );
    await tx.pipedriveConnection.updateMany({
      where: { id: connectionId, workspaceId },
      data: {
        mutationRevision: { increment: 1 },
        updatedAt: nextMutationTime(live.updatedAt),
      },
    });
  }

  private async triggerFailure(
    tx: Tx,
    event: PipedriveWebhookEvent,
    live: PipedriveConnection,
  ) {
    if (!this.matchesConnection(event, live)) return "connection_fence_changed";
    if (event.changeKind !== "stage_change" && event.changeKind !== "deal_won")
      return "no_relevant_change";
    if (!this.catalogFresh(live)) return "catalog_stale";
    // Stage moves supersede older stage moves; status changes (won/lost)
    // supersede older status changes. The two families never cancel each other.
    const family =
      event.changeKind === "stage_change"
        ? ["stage_change"]
        : ["deal_won", "deal_lost"];
    const scope = {
      workspaceId: event.workspaceId,
      connectionId: event.connectionId,
      verifiedAccountId: event.verifiedAccountId,
      credentialGeneration: event.credentialGeneration,
      dealId: event.dealId,
      changeKind: { in: family },
    };
    const newer = await tx.pipedriveWebhookEvent.findFirst({
      where: { ...scope, occurredAt: { gt: event.occurredAt } },
    });
    if (newer) return "out_of_order";
    const tied = await tx.pipedriveWebhookEvent.findFirst({
      where: {
        ...scope,
        id: { not: event.id },
        occurredAt: event.occurredAt,
        OR: [
          { stageId: { not: event.stageId } },
          { pipelineId: { not: event.pipelineId } },
          { changeKind: { not: event.changeKind } },
        ],
      },
    });
    if (tied) return "ordering_ambiguous";
    if (event.changeKind === "deal_won") {
      const pipeline = await tx.pipedrivePipelineCatalog.findFirst({
        where: {
          workspaceId: event.workspaceId,
          connectionId: live.id,
          pipelineId: event.pipelineId!,
          available: true,
        },
      });
      if (!pipeline) return "pipeline_unavailable";
    } else {
      const stage = await tx.pipedriveStageCatalog.findFirst({
        where: {
          workspaceId: event.workspaceId,
          connectionId: live.id,
          pipelineId: event.pipelineId!,
          stageId: event.stageId!,
          available: true,
        },
      });
      if (!stage) return "stage_unavailable";
    }
    const rule = await tx.pipedriveConversionRule.findFirst({
      where: {
        ...this.ruleWhere(event, live.id),
        mode: { in: ["observation", "production"] },
      },
    });
    return rule
      ? null
      : event.changeKind === "deal_won"
        ? "won_not_selected"
        : "stage_not_selected";
  }

  private valueFor(
    rule: PipedriveConversionRule,
    event: PipedriveWebhookEvent,
    workspaceCurrency: CurrencyCode,
  ): { cents: number | null; currency: string | null } | { error: string } {
    // Só BRL/USD/EUR vão à Meta. Regra gravada antes da Fase 5.1 com outro
    // código conta como regra sem moeda (herda o workspace).
    const ruleCurrency = normalizeCurrencyCode(rule.currency);
    const carries = conversionEventCarriesValue(
      rule.eventName as ConversionEventNameDto,
    );
    const parsed = pipedriveConversionRuleCreateInputSchema.safeParse({
      ...this.ruleInput(rule),
      currency: carries ? (ruleCurrency ?? workspaceCurrency) : ruleCurrency,
    });
    if (!parsed.success) return { error: "rule_value_invalid" };
    const input = parsed.data;
    if (!conversionEventCarriesValue(input.eventName))
      return { cents: null, currency: null };
    if (input.valueMode === "fixed")
      return {
        cents: input.fixedValueCents!,
        currency: ruleCurrency ?? workspaceCurrency,
      };
    const cents = event.valueCents === null ? null : Number(event.valueCents);
    if (cents !== null && (!Number.isSafeInteger(cents) || cents > 2147483647))
      return { error: "event_value_out_of_range" };
    if (!event.valuePresent || cents === null || cents <= 0)
      return conversionEventRequiresValue(input.eventName)
        ? { error: "event_price_missing_or_nonpositive" }
        : { cents: null, currency: ruleCurrency };
    // Moeda do negócio -> da regra -> do workspace. Negócio em moeda fora de
    // BRL/USD/EUR nunca vai à Meta (o valor sairia na moeda errada); moeda da
    // regra, quando existe, precisa bater com a do negócio.
    const dealCurrency = normalizeCurrencyCode(event.currency);
    if (event.currency && !dealCurrency)
      return { error: "event_currency_unsupported" };
    if (dealCurrency && ruleCurrency && dealCurrency !== ruleCurrency)
      return { error: "event_currency_mismatch" };
    return { cents, currency: dealCurrency ?? ruleCurrency ?? workspaceCurrency };
  }

  private async ignore(
    event: PipedriveWebhookEvent,
    code: string,
    unhealthy = false,
  ) {
    return this.transaction(async (tx) => {
      const live = await this.connections.lockConnection(
        tx,
        event.workspaceId,
        event.connectionId,
      );
      if (
        !(await tx.pipedriveWebhookEvent.findFirst({
          where: this.leaseWhere(event),
        }))
      )
        return { status: "lease_lost" };
      if (!this.matchesConnection(event, live))
        return this.finishLeased(
          tx,
          event,
          "ignored",
          "connection_fence_changed",
        );
      if (unhealthy)
        await tx.pipedriveConnection.updateMany({
          where: {
            id: live.id,
            workspaceId: live.workspaceId,
            credentialGeneration: event.credentialGeneration,
          },
          data: {
            mutationRevision: { increment: 1 },
            updatedAt: nextMutationTime(live.updatedAt),
            credentialHealthy: false,
            status: live.status === "paused" ? "paused" : "blocked",
            lastErrorCode: code,
          },
        });
      return this.finishLeased(tx, event, "ignored", code);
    });
  }

  /**
   * The license was locked after the row was claimed: give the row back
   * untouched (same status, the attempt is not counted) so it is processed
   * once the license is active again. Nothing was materialized.
   */
  private async releaseForLicense(event: PipedriveWebhookEvent) {
    return this.transaction(async (tx) => {
      const changed = await tx.pipedriveWebhookEvent.updateMany({
        where: this.leaseWhere(event),
        data: {
          status: event.attempts > 1 ? "retry" : "received",
          attempts: { decrement: 1 },
          nextAttemptAt: new Date(+this.now() + 60_000),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      return { status: changed.count ? "license_locked" : "lease_lost" };
    });
  }

  private async finishLeased(
    tx: Tx,
    event: PipedriveWebhookEvent,
    status: string,
    code: string | null,
    results: Result[] = [],
    leadId?: string,
    routeId?: string,
  ) {
    const changed = await tx.pipedriveWebhookEvent.updateMany({
      where: this.leaseWhere(event),
      data: {
        status,
        errorCode: code,
        results,
        matchedLeadId: leadId ?? null,
        matchedRouteId: routeId ?? null,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      },
    });
    if (!changed.count && results.length)
      throw new ConflictException("pipedrive_processing_lease_lost");
    if (changed.count)
      await this.audit(
        tx,
        event.workspaceId,
        event.id,
        "webhook_processed",
        status,
      );
    return { status: changed.count ? status : "lease_lost" };
  }
  private async finish(
    tx: Tx,
    event: PipedriveWebhookEvent,
    status: string,
    code: string,
  ) {
    await tx.pipedriveWebhookEvent.updateMany({
      where: { id: event.id, workspaceId: event.workspaceId },
      data: {
        status,
        errorCode: code,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      },
    });
    await this.audit(
      tx,
      event.workspaceId,
      event.id,
      "webhook_processed",
      status,
    );
  }
  private leaseWhere(event: PipedriveWebhookEvent) {
    return {
      id: event.id,
      workspaceId: event.workspaceId,
      connectionId: event.connectionId,
      status: "processing",
      leaseToken: event.leaseToken,
      leaseExpiresAt: { gt: this.now() },
    };
  }
  private matchesConnection(
    event: PipedriveWebhookEvent,
    live: PipedriveConnection,
  ) {
    return (
      live.status === "active" &&
      live.credentialHealthy &&
      Boolean(live.webhookSecretHash) &&
      event.credentialGeneration === live.credentialGeneration &&
      event.verifiedAccountId === live.verifiedAccountId &&
      event.accountSubdomain === live.accountSubdomain &&
      event.webhookSecretVersion === live.webhookSecretVersion &&
      +event.occurredAt >= +live.credentialActivatedAt
    );
  }
  private authenticate(live: PipedriveConnection, secret: unknown) {
    const valid =
      typeof secret === "string" && /^[A-Za-z0-9_-]{43}$/.test(secret);
    const candidate = this.hash(valid ? secret : "invalid");
    const stored =
      live.webhookSecretHash && /^[a-f0-9]{64}$/.test(live.webhookSecretHash)
        ? live.webhookSecretHash
        : "0".repeat(64);
    return (
      timingSafeEqual(
        Buffer.from(candidate, "hex"),
        Buffer.from(stored, "hex"),
      ) &&
      valid &&
      live.status === "active" &&
      live.credentialHealthy &&
      Boolean(live.verifiedAccountId) &&
      Boolean(live.accountSubdomain) &&
      Boolean(live.webhookIssuedAt)
    );
  }
  private catalogFresh(live: PipedriveConnection) {
    const age = live.catalogRefreshedAt
      ? +this.now() - +live.catalogRefreshedAt
      : -1;
    return live.catalogState === "fresh" && age >= 0 && age < 15 * 60_000;
  }
  /** Stage rules need an available stage; won-deal rules an available pipeline. */
  private async requireStage(
    tx: Tx,
    live: PipedriveConnection,
    pipelineId: string,
    stageId: string | null | undefined,
  ) {
    if (
      !live.verifiedAccountId ||
      !live.credentialHealthy ||
      !this.catalogFresh(live)
    )
      throw new ConflictException("Catálogo Pipedrive requer atualização");
    if (!stageId) {
      const pipeline = await tx.pipedrivePipelineCatalog.findFirst({
        where: {
          workspaceId: live.workspaceId,
          connectionId: live.id,
          pipelineId,
          available: true,
        },
      });
      if (!pipeline)
        throw new BadRequestException("Funil Pipedrive indisponível");
      return;
    }
    const row = await tx.pipedriveStageCatalog.findFirst({
      where: {
        workspaceId: live.workspaceId,
        connectionId: live.id,
        pipelineId,
        stageId,
        available: true,
      },
    });
    if (!row) throw new BadRequestException("Etapa Pipedrive indisponível");
  }
  /** One won-deal rule per pipeline (also enforced by a partial unique index). */
  private async requireUniqueWonRule(
    tx: Tx,
    live: PipedriveConnection,
    data: { trigger: string; pipelineId: string; eventName: string },
    exceptRuleId?: string,
  ) {
    if (data.trigger !== "deal_won") return;
    const existing = await tx.pipedriveConversionRule.findFirst({
      where: {
        workspaceId: live.workspaceId,
        connectionId: live.id,
        trigger: "deal_won",
        pipelineId: data.pipelineId,
        eventName: data.eventName,
        ...(exceptRuleId ? { id: { not: exceptRuleId } } : {}),
      },
    });
    if (existing)
      throw new ConflictException("Regra ou evento Pipedrive já existe");
  }
  private parseRule(input: unknown) {
    const parsed = pipedriveConversionRuleCreateInputSchema.safeParse(input);
    if (
      !parsed.success ||
      (parsed.data.fixedValueCents != null &&
        (!Number.isSafeInteger(parsed.data.fixedValueCents) ||
          parsed.data.fixedValueCents > 2147483647))
    )
      throw new BadRequestException(!parsed.success && hasRuleCurrencyIssue(parsed.error) ? RULE_CURRENCY_INVALID_MESSAGE : "Payload inválido");
    return parsed.data;
  }
  private ruleInput(r: PipedriveConversionRule) {
    return {
      name: r.name,
      trigger: r.trigger,
      pipelineId: r.pipelineId,
      stageId: r.stageId,
      eventName: r.eventName,
      mode: r.mode,
      valueMode: r.valueMode,
      fixedValueCents: r.fixedValueCents,
      currency: r.currency,
      contentName: r.contentName,
      active: r.active,
    };
  }
  private ruleDto(r: PipedriveConversionRule) {
    return {
      id: r.id,
      connectionId: r.connectionId,
      ...this.ruleInput(r),
      productionActivatedAt: r.productionActivatedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
  private publicOrigin() {
    try {
      const url = new URL(process.env.API_PUBLIC_URL ?? "");
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw new Error();
      return url.origin;
    } catch {
      throw new ServiceUnavailableException("pipedrive_public_url_invalid");
    }
  }
  private hash(v: string) {
    return createHash("sha256").update(v).digest("hex");
  }
  private notFound(): never {
    throw new NotFoundException("Webhook não encontrado");
  }
  private async audit(
    tx: Tx,
    workspaceId: string,
    targetId: string,
    action: string,
    resultStatus: string,
    actor?: PipedriveActor,
  ) {
    await tx.auditLog.create({
      data: {
        workspaceId,
        actorUserId: actor?.userId ?? null,
        actorType: actor?.type ?? "system",
        action: `pipedrive.${action}`,
        targetType: action.startsWith("rule_")
          ? "PipedriveConversionRule"
          : action.startsWith("webhook_secret")
            ? "PipedriveConnection"
            : "PipedriveWebhookEvent",
        targetId,
        resultStatus,
        afterSummary: { provider: "pipedrive", redacted: true },
      },
    });
  }
  private transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database(() => this.prisma.$transaction(fn));
  }
  private async database<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2002"
      )
        throw new ConflictException("Regra ou evento Pipedrive já existe");
      throw new ServiceUnavailableException("pipedrive_persistence_failed");
    }
  }
}
