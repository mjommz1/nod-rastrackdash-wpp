import { Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { InboundWebhookJobPayload } from "../common/queue/queue.constants";
import {
  hashPhoneIdentity,
  normalizePhoneIdentity,
} from "../common/phone/phone-identity";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  ProviderConversionObservationService,
  type ProviderConversionObservationResult,
} from "../conversion-rules/provider-conversion-observation.service";
import { InboundWebhookChannelRoutesService } from "./inbound-webhook-channel-routes.service";
import { InboundWebhookDiagnosticsService } from "./inbound-webhook-diagnostics.service";
import { InboundWebhookPayloadEncryptionService } from "./inbound-webhook-payload-encryption.service";
import { InboundWebhookProductionIntakeService } from "./inbound-webhook-production-intake.service";
import { InboundWebhookProductionQueueService } from "./inbound-webhook-production-queue.service";
import {
  provisionalChannelOrganizationId,
  provisionalChannelProviderChannelId,
} from "./inbound-webhook-provisional-channel";
import { inboundWebhookParserContext } from "./providers/inbound-webhook-parser";
import type {
  InboundWebhookDeliveryNormalizedSummary,
  InboundWebhookEventClassification,
  InboundWebhookEventNormalizedSummary,
  InboundWebhookParser,
  InboundWebhookParserResult,
  ParsedInboundWebhookEvent,
} from "./providers/inbound-webhook-parser";
import {
  InboundWebhookParserRegistry,
  InboundWebhookParserResolutionError,
} from "./providers/inbound-webhook-parser.registry";

const terminalDeliveryStatuses = new Set(["processed", "failed"]);
const supportedClassifications = new Set<InboundWebhookEventClassification>([
  "eligible_route_resolved",
  "eligible_route_unresolved",
  "ignored_no_ctwa",
  "ignored_outbound",
  "ignored_private",
  "ignored_empty_template",
  "ignored_untracked_lead",
  "unsupported_event",
  "invalid_payload",
]);
const safeErrorCodePattern = /^[a-z0-9_]{1,120}$/;

type LoadedDelivery = Prisma.InboundWebhookDeliveryGetPayload<{
  include: {
    workspace: {
      select: {
        id: true;
      };
    };
    connection: {
      include: {
        parserRelease: true;
      };
    };
  };
}>;

type DeterministicFailure = {
  code: string;
  classification?: InboundWebhookEventClassification;
  result?: InboundWebhookParserResult;
};

type PersistedChannelIdentity = {
  id: string;
};

type PersistedObservation = {
  createdEventCount: number;
  routableChannelIds: string[];
};

export type InboundWebhookObservationResult = {
  deliveryId: string;
  status: "processed" | "failed";
  classification: InboundWebhookEventClassification | null;
  parsedEventCount: number;
  persistedEventCount: number;
  idempotent: boolean;
};

export type InboundWebhookObservationErrorCode =
  | "inbound_webhook_context_invalid"
  | "inbound_webhook_delivery_not_claimable"
  | "inbound_webhook_processing_state_changed"
  | "inbound_webhook_provider_conversion_deferred"
  | "inbound_webhook_provider_conversion_reevaluation_unavailable";

const observationErrorMessages: Record<
  InboundWebhookObservationErrorCode,
  string
> = {
  inbound_webhook_context_invalid:
    "Inbound webhook processing context is invalid",
  inbound_webhook_delivery_not_claimable:
    "Inbound webhook delivery cannot be claimed",
  inbound_webhook_processing_state_changed:
    "Inbound webhook processing state changed",
  inbound_webhook_provider_conversion_deferred:
    "Inbound webhook provider conversion processing was deferred",
  inbound_webhook_provider_conversion_reevaluation_unavailable:
    "Inbound webhook provider conversion cannot be reevaluated",
};

export class InboundWebhookObservationError extends Error {
  readonly code: InboundWebhookObservationErrorCode;

  constructor(code: InboundWebhookObservationErrorCode) {
    super(observationErrorMessages[code]);
    this.name = "InboundWebhookObservationError";
    this.code = code;
  }
}

class InboundWebhookDeterministicFailure extends Error {
  readonly code: string;
  readonly classification?: InboundWebhookEventClassification;

  constructor(
    code: string,
    classification?: InboundWebhookEventClassification,
  ) {
    super("Inbound webhook delivery failed deterministic processing");
    this.name = "InboundWebhookDeterministicFailure";
    this.code = code;
    this.classification = classification;
  }
}

@Injectable()
export class InboundWebhookObservationService {
  private readonly logger = new Logger(InboundWebhookObservationService.name);

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(InboundWebhookPayloadEncryptionService)
    private readonly encryption: InboundWebhookPayloadEncryptionService,
    @Inject(InboundWebhookParserRegistry)
    private readonly parserRegistry: InboundWebhookParserRegistry,
    @Inject(InboundWebhookDiagnosticsService)
    private readonly diagnostics: InboundWebhookDiagnosticsService,
    @Inject(InboundWebhookChannelRoutesService)
    private readonly channelRoutes: InboundWebhookChannelRoutesService,
    @Inject(InboundWebhookProductionIntakeService)
    private readonly productionIntake: InboundWebhookProductionIntakeService,
    @Inject(ProviderConversionObservationService)
    private readonly providerConversions: ProviderConversionObservationService,
    @Inject(InboundWebhookProductionQueueService)
    private readonly productionQueue: InboundWebhookProductionQueueService,
  ) {}

  async processDelivery(
    input: Readonly<InboundWebhookJobPayload>,
  ): Promise<InboundWebhookObservationResult> {
    this.assertJobPayload(input);
    let delivery = await this.loadDelivery(input);

    if (!delivery) {
      throw new InboundWebhookObservationError(
        "inbound_webhook_context_invalid",
      );
    }

    if (terminalDeliveryStatuses.has(delivery.status)) {
      if (delivery.status === "processed") {
        await this.prepareProductionDelivery(delivery);
        await this.prepareProviderConversions(
          delivery,
          undefined,
          input.forceProviderConversions === true,
        );
      }

      return this.terminalResult(delivery);
    }

    const claimedAt = new Date(
      Math.max(Date.now(), delivery.updatedAt.getTime() + 1),
    );
    const claim = await this.prisma.inboundWebhookDelivery.updateMany({
      where: {
        id: input.deliveryId,
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        updatedAt: delivery.updatedAt,
        status: {
          in: ["pending", "queued", "processing"],
        },
      },
      data: {
        status: "processing",
        updatedAt: claimedAt,
      },
    });

    if (claim.count !== 1) {
      delivery = await this.loadDelivery(input);

      if (delivery && terminalDeliveryStatuses.has(delivery.status)) {
        if (delivery.status === "processed") {
          await this.prepareProductionDelivery(delivery);
          await this.prepareProviderConversions(
            delivery,
            undefined,
            input.forceProviderConversions === true,
          );
        }

        return this.terminalResult(delivery);
      }

      throw new InboundWebhookObservationError(
        "inbound_webhook_delivery_not_claimable",
      );
    }

    let parser: InboundWebhookParser;

    try {
      this.validateLoadedContext(delivery);
      parser = this.parserRegistry.resolve({
        provider: delivery.connection.provider,
        parserVersion: delivery.connection.parserRelease.version,
        parserReleaseStatus: delivery.connection.parserRelease.status,
      });
    } catch (error) {
      return this.finishFailure(delivery, this.parserResolutionFailure(error));
    }

    try {
      await this.revalidateConnection(delivery);
    } catch (error) {
      if (error instanceof InboundWebhookDeterministicFailure) {
        return this.finishFailure(delivery, {
          code: error.code,
          classification: error.classification,
        });
      }

      throw new InboundWebhookObservationError(
        "inbound_webhook_processing_state_changed",
      );
    }

    let result: InboundWebhookParserResult;

    try {
      result = await this.parseEncryptedPayload(delivery, parser);
      this.validateParserResult(result, parser);
    } catch (error) {
      return this.finishFailure(
        delivery,
        this.deterministicProcessingFailure(error),
      );
    }

    if (result.error || result.classification === "invalid_payload") {
      return this.finishFailure(delivery, {
        code: this.safeErrorCode(
          result.error?.code,
          "inbound_webhook_parser_invalid_payload",
        ),
        classification: "invalid_payload",
        result,
      });
    }

    const processedAt = new Date();
    let persisted: PersistedObservation;

    try {
      persisted = await this.persistResult(delivery, result, processedAt);
    } catch (error) {
      if (error instanceof InboundWebhookObservationError) {
        throw error;
      }

      throw new InboundWebhookObservationError(
        "inbound_webhook_processing_state_changed",
      );
    }

    await this.prepareProductionDelivery(
      delivery,
      persisted.routableChannelIds,
    );
    await this.prepareProviderConversions(
      delivery,
      result,
      input.forceProviderConversions === true,
    );

    await this.recordDiagnostic(delivery, "processed", result);

    return {
      deliveryId: delivery.id,
      status: "processed",
      classification: result.classification,
      parsedEventCount: result.events.length,
      persistedEventCount: persisted.createdEventCount,
      idempotent: false,
    };
  }

  async reevaluateProviderConversionDecision(input: {
    workspaceId: string;
    connectionId: string;
    deliveryId: string;
    providerRuleId: string;
    occurrenceKey: string;
    requestKey: string;
  }): Promise<ProviderConversionObservationResult> {
    this.assertJobPayload(input);
    if (
      !this.isIdentifier(input.providerRuleId) ||
      !this.isIdentifier(input.occurrenceKey) ||
      !this.isIdentifier(input.requestKey)
    ) {
      throw new InboundWebhookObservationError(
        "inbound_webhook_context_invalid",
      );
    }

    const delivery = await this.loadDelivery(input);
    if (
      !delivery ||
      delivery.purpose !== "message_observation" ||
      delivery.status !== "processed"
    ) {
      throw new InboundWebhookObservationError(
        "inbound_webhook_provider_conversion_reevaluation_unavailable",
      );
    }

    try {
      this.validateLoadedContext(delivery);
      const parser = this.parserRegistry.resolve({
        provider: delivery.connection.provider,
        parserVersion: delivery.connection.parserRelease.version,
        parserReleaseStatus: delivery.connection.parserRelease.status,
      });
      const result = await this.parseEncryptedPayload(delivery, parser);
      this.validateParserResult(result, parser);
      if (result.error || result.classification === "invalid_payload") {
        throw new InboundWebhookObservationError(
          "inbound_webhook_provider_conversion_reevaluation_unavailable",
        );
      }

      const reevaluated = await this.providerConversions.reevaluateDelivery({
        workspaceId: delivery.workspaceId,
        connectionId: delivery.connectionId,
        deliveryId: delivery.id,
        externalDeliveryId: delivery.externalDeliveryId,
        deliveryReceivedAt: delivery.firstReceivedAt,
        events: result.events,
        manualRecovery: true,
        requestKey: input.requestKey,
        target: {
          providerRuleId: input.providerRuleId,
          occurrenceKey: input.occurrenceKey,
        },
      });

      for (const providerConversionExecutionId of reevaluated.eligibleExecutionIds) {
        try {
          await this.productionQueue.enqueueProviderConversion({
            providerConversionExecutionId,
            workspaceId: delivery.workspaceId,
          });
        } catch {
          this.logger.warn(
            `Reevaluated provider conversion ${providerConversionExecutionId} remains eligible for queue recovery`,
          );
        }
      }

      return reevaluated;
    } catch (error) {
      if (error instanceof InboundWebhookObservationError) {
        throw error;
      }

      this.logger.warn(
        `Provider conversion reevaluation failed for delivery ${delivery.id} (${this.safeExceptionSummary(error)})`,
      );
      throw new InboundWebhookObservationError(
        "inbound_webhook_provider_conversion_reevaluation_unavailable",
      );
    }
  }

  private assertJobPayload(input: Readonly<InboundWebhookJobPayload>): void {
    if (
      !input ||
      !this.isIdentifier(input.deliveryId) ||
      !this.isIdentifier(input.workspaceId) ||
      !this.isIdentifier(input.connectionId)
    ) {
      throw new InboundWebhookObservationError(
        "inbound_webhook_context_invalid",
      );
    }
  }

  private isIdentifier(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 255 &&
      !value.includes("\0")
    );
  }

  private loadDelivery(
    input: Readonly<InboundWebhookJobPayload>,
  ): Promise<LoadedDelivery | null> {
    return this.prisma.inboundWebhookDelivery.findFirst({
      where: {
        id: input.deliveryId,
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
      },
      include: {
        workspace: {
          select: {
            id: true,
          },
        },
        connection: {
          include: {
            parserRelease: true,
          },
        },
      },
    });
  }

  private terminalResult(
    delivery: LoadedDelivery,
  ): InboundWebhookObservationResult {
    return {
      deliveryId: delivery.id,
      status: delivery.status === "processed" ? "processed" : "failed",
      classification: delivery.classification,
      parsedEventCount: 0,
      persistedEventCount: 0,
      idempotent: true,
    };
  }

  private validateLoadedContext(delivery: LoadedDelivery): void {
    const { connection, workspace } = delivery;

    if (
      workspace.id !== delivery.workspaceId ||
      connection.id !== delivery.connectionId ||
      connection.workspaceId !== delivery.workspaceId ||
      connection.provider !== delivery.provider ||
      !["observation", "production"].includes(connection.status) ||
      connection.removedAt !== null ||
      connection.parserRelease.id !== connection.parserReleaseId ||
      connection.parserRelease.provider !== connection.provider ||
      connection.parserRelease.version !== delivery.parserVersion
    ) {
      throw new InboundWebhookDeterministicFailure(
        "inbound_webhook_connection_invalid",
      );
    }
  }

  private async revalidateConnection(delivery: LoadedDelivery): Promise<void> {
    const connection = await this.prisma.inboundWebhookConnection.findFirst({
      where: {
        id: delivery.connectionId,
        workspaceId: delivery.workspaceId,
        provider: delivery.provider,
        parserReleaseId: delivery.connection.parserReleaseId,
        status: { in: ["observation", "production"] },
        removedAt: null,
        parserRelease: {
          id: delivery.connection.parserRelease.id,
          provider: delivery.provider,
          version: delivery.parserVersion,
          status: delivery.connection.parserRelease.status,
        },
      },
      select: {
        id: true,
      },
    });

    if (!connection) {
      throw new InboundWebhookDeterministicFailure(
        "inbound_webhook_connection_invalid",
      );
    }
  }

  private parserResolutionFailure(error: unknown): DeterministicFailure {
    if (error instanceof InboundWebhookParserResolutionError) {
      return {
        code: error.code,
      };
    }

    if (error instanceof InboundWebhookDeterministicFailure) {
      return {
        code: error.code,
        classification: error.classification,
      };
    }

    return {
      code: "inbound_webhook_parser_resolution_failed",
    };
  }

  private async parseEncryptedPayload(
    delivery: LoadedDelivery,
    parser: InboundWebhookParser,
  ): Promise<InboundWebhookParserResult> {
    if (
      !delivery.encryptedPayload ||
      !delivery.payloadIv ||
      !delivery.payloadTag ||
      delivery.encryptionKeyVersion === null
    ) {
      throw new InboundWebhookDeterministicFailure(
        "inbound_webhook_payload_unavailable",
        "invalid_payload",
      );
    }

    if (delivery.payloadExpiresAt.getTime() <= Date.now()) {
      throw new InboundWebhookDeterministicFailure(
        "inbound_webhook_payload_expired",
        "invalid_payload",
      );
    }

    let plaintext: Buffer;

    try {
      plaintext = this.encryption.decrypt(
        {
          encryptedPayload: delivery.encryptedPayload,
          payloadIv: delivery.payloadIv,
          payloadTag: delivery.payloadTag,
          encryptionKeyVersion: delivery.encryptionKeyVersion,
        },
        {
          workspaceId: delivery.workspaceId,
          connectionId: delivery.connectionId,
          deliveryId: delivery.id,
        },
      );
    } catch {
      throw new InboundWebhookDeterministicFailure(
        "inbound_webhook_payload_decryption_failed",
        "invalid_payload",
      );
    }

    let payload: unknown;

    try {
      payload = JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new InboundWebhookDeterministicFailure(
        "inbound_webhook_payload_json_invalid",
        "invalid_payload",
      );
    }

    try {
      const connectedPhone = await this.resolveBoundConnectedPhone(
        delivery,
        parser,
      );

      return parser.parse(
        payload,
        inboundWebhookParserContext(delivery.workspaceId, connectedPhone),
      );
    } catch (error) {
      if (error instanceof InboundWebhookDeterministicFailure) {
        throw error;
      }
      throw new InboundWebhookDeterministicFailure(
        "inbound_webhook_parser_execution_failed",
        "invalid_payload",
      );
    }
  }

  /**
   * Fase 4b: the Unnichat entry webhook carries no channel id. The number is
   * bound when the connection is created (connectedPhone), so the parser
   * receives it from the connection, never from the provider payload.
   */
  private async resolveBoundConnectedPhone(
    delivery: LoadedDelivery,
    parser: InboundWebhookParser,
  ): Promise<string | null> {
    if (parser.provider !== "unnichat") {
      return null;
    }

    const channel = await this.prisma.inboundWebhookChannel.findFirst({
      where: {
        workspaceId: delivery.workspaceId,
        connectionId: delivery.connectionId,
        organizationId: delivery.workspaceId,
      },
      select: {
        connectedPhone: true,
      },
    });
    if (!channel?.connectedPhone?.trim()) {
      throw new InboundWebhookDeterministicFailure(
        "inbound_webhook_unnichat_channel_binding_missing",
        "invalid_payload",
      );
    }

    return channel.connectedPhone;
  }

  private deterministicProcessingFailure(error: unknown): DeterministicFailure {
    if (error instanceof InboundWebhookDeterministicFailure) {
      return {
        code: error.code,
        classification: error.classification,
      };
    }

    return {
      code: "inbound_webhook_parser_result_invalid",
      classification: "invalid_payload",
    };
  }

  private validateParserResult(
    result: InboundWebhookParserResult,
    parser: InboundWebhookParser,
  ): void {
    if (
      !result ||
      result.provider !== parser.provider ||
      result.parserVersion !== parser.parserVersion ||
      !supportedClassifications.has(result.classification) ||
      !Array.isArray(result.events) ||
      !this.validDeliverySummary(result.normalizedSummary, result) ||
      result.events.some(
        (event) => !this.validParsedEvent(event, result.provider),
      )
    ) {
      throw new InboundWebhookDeterministicFailure(
        "inbound_webhook_parser_result_invalid",
        "invalid_payload",
      );
    }
  }

  private validDeliverySummary(
    summary: InboundWebhookDeliveryNormalizedSummary,
    result: InboundWebhookParserResult,
  ): boolean {
    return (
      summary &&
      summary.provider === result.provider &&
      summary.parserVersion === result.parserVersion &&
      summary.providerEventType === result.providerEventType &&
      summary.externalDeliveryId === result.externalDeliveryId &&
      summary.classification === result.classification &&
      summary.classificationReason === result.classificationReason &&
      summary.eventCount === result.events.length
    );
  }

  private validParsedEvent(
    event: ParsedInboundWebhookEvent,
    provider: string,
  ): boolean {
    return (
      event &&
      event.provider === provider &&
      this.isIdentifier(event.providerEventType) &&
      this.isIdentifier(event.externalEventId) &&
      this.isIdentifier(event.externalMessageId) &&
      /^sha256:[a-f0-9]{64}$/u.test(event.dedupeKey) &&
      this.isIdentifier(event.organizationId) &&
      event.occurredAt instanceof Date &&
      Number.isFinite(event.occurredAt.getTime()) &&
      this.isIdentifier(event.channel.providerChannelId) &&
      this.isIdentifier(event.channel.connectedPhone) &&
      (event.channel.name === null ||
        (typeof event.channel.name === "string" &&
          event.channel.name.length <= 160)) &&
      this.isIdentifier(event.contact.externalContactId) &&
      this.isIdentifier(event.contact.phoneNumber) &&
      ["inbound", "outbound", "unknown"].includes(event.message.direction) &&
      ["contact", "organization_member", "bot", "unknown"].includes(
        event.message.authorType,
      ) &&
      (event.message.messageType === null ||
        (typeof event.message.messageType === "string" &&
          event.message.messageType.length <= 120)) &&
      (event.message.text === null ||
        (typeof event.message.text === "string" &&
          event.message.text.length <= 16_384)) &&
      typeof event.message.isPrivate === "boolean" &&
      (event.adId === null || this.isIdentifier(event.adId)) &&
      typeof event.hasCtwa === "boolean" &&
      supportedClassifications.has(event.classification) &&
      this.validEventSummary(event.normalizedSummary, event)
    );
  }

  private validEventSummary(
    summary: InboundWebhookEventNormalizedSummary,
    event: ParsedInboundWebhookEvent,
  ): boolean {
    return (
      summary &&
      summary.provider === event.provider &&
      summary.providerEventType === event.providerEventType &&
      summary.externalEventId === event.externalEventId &&
      summary.externalMessageId === event.externalMessageId &&
      summary.organizationId === event.organizationId &&
      summary.providerChannelId === event.channel.providerChannelId &&
      /^\d{0,4}$/u.test(summary.connectedPhoneSuffix) &&
      summary.occurredAt === event.occurredAt.toISOString() &&
      summary.adId === event.adId &&
      summary.hasCtwa === event.hasCtwa &&
      summary.messageDirection === event.message.direction &&
      summary.messageAuthorType === event.message.authorType &&
      summary.messageType === event.message.messageType &&
      summary.classification === event.classification &&
      summary.classificationReason === event.classificationReason
    );
  }

  private async persistResult(
    delivery: LoadedDelivery,
    result: InboundWebhookParserResult,
    processedAt: Date,
  ): Promise<PersistedObservation> {
    return this.prisma.$transaction(async (transaction) => {
      await this.assertCurrentConnection(transaction, delivery);

      const eventRows: Prisma.InboundWebhookEventCreateManyInput[] = [];
      const routableChannelIds = new Set<string>();

      for (const event of result.events) {
        const channel = await this.upsertChannelForEvent(
          transaction,
          delivery,
          event,
          processedAt,
        );

        if (
          event.classification === "eligible_route_resolved" ||
          event.classification === "eligible_route_unresolved"
        ) {
          routableChannelIds.add(channel.id);
        }

        eventRows.push({
          workspaceId: delivery.workspaceId,
          connectionId: delivery.connectionId,
          deliveryId: delivery.id,
          channelId: channel.id,
          provider: delivery.provider,
          externalEventId: event.externalEventId,
          externalMessageId: event.externalMessageId,
          dedupeKey: event.dedupeKey,
          occurredAt: event.occurredAt,
          contactIdentityHash:
            hashPhoneIdentity(event.contact.phoneNumber) ?? null,
          adId: event.adId,
          hasCtwa: event.hasCtwa,
          classification: event.classification,
          classificationReason: event.classificationReason,
          normalizedSummary: this.toJsonValue(
            this.eventSummary(event.normalizedSummary),
          ),
        });
      }

      const created =
        eventRows.length === 0
          ? { count: 0 }
          : await transaction.inboundWebhookEvent.createMany({
              data: eventRows,
              skipDuplicates: true,
            });
      const updatedDelivery =
        await transaction.inboundWebhookDelivery.updateMany({
          where: {
            id: delivery.id,
            workspaceId: delivery.workspaceId,
            connectionId: delivery.connectionId,
            status: "processing",
          },
          data: {
            externalDeliveryId: result.externalDeliveryId,
            providerEventType: result.providerEventType,
            classification: result.classification,
            status: "processed",
            normalizedSummary: this.toJsonValue(
              this.deliverySummary(result.normalizedSummary),
            ),
            parseErrorCode: null,
            routingErrorCode: null,
            processedAt,
          },
        });

      if (updatedDelivery.count !== 1) {
        throw new InboundWebhookObservationError(
          "inbound_webhook_processing_state_changed",
        );
      }

      const updatedConnection =
        await transaction.inboundWebhookConnection.updateMany({
          where: this.currentConnectionWhere(delivery),
          data: {
            lastSuccessfulParseAt: processedAt,
          },
        });

      if (updatedConnection.count !== 1) {
        throw new InboundWebhookObservationError(
          "inbound_webhook_processing_state_changed",
        );
      }

      return {
        createdEventCount: created.count,
        routableChannelIds: [...routableChannelIds],
      };
    });
  }

  /**
   * Resolves the InboundWebhookChannel row for an observed event.
   *
   * Anti-duplicate merge (P0.2): a student may have already registered a
   * provisional channel for this connection/phone (see
   * inbound-webhook-provisional-channel.ts) before any webhook arrived, so
   * conversion rules could be created against it right away. When the real
   * webhook shows up, look that provisional row up by its stable placeholder
   * providerChannelId and update it in place with the real identity — same
   * channel id, so routes/rules already scoped to it keep working — instead
   * of inserting a second channel for the same number.
   */
  private async upsertChannelForEvent(
    transaction: Prisma.TransactionClient,
    delivery: LoadedDelivery,
    event: ParsedInboundWebhookEvent,
    processedAt: Date,
  ): Promise<PersistedChannelIdentity> {
    const normalizedPhone = normalizePhoneIdentity(
      event.channel.connectedPhone,
    );

    if (normalizedPhone) {
      const provisional = await transaction.inboundWebhookChannel.findUnique({
        where: {
          connectionId_organizationId_providerChannelId: {
            connectionId: delivery.connectionId,
            organizationId: provisionalChannelOrganizationId(
              delivery.connectionId,
            ),
            providerChannelId:
              provisionalChannelProviderChannelId(normalizedPhone),
          },
        },
        select: { id: true, channelName: true },
      });

      if (provisional) {
        return transaction.inboundWebhookChannel.update({
          where: { id: provisional.id },
          data: {
            organizationId: event.organizationId,
            providerChannelId: event.channel.providerChannelId,
            connectedPhone: event.channel.connectedPhone,
            channelName: event.channel.name ?? provisional.channelName,
            lastSeenAt: processedAt,
          },
          select: { id: true },
        });
      }
    }

    return transaction.inboundWebhookChannel.upsert({
      where: {
        connectionId_organizationId_providerChannelId: {
          connectionId: delivery.connectionId,
          organizationId: event.organizationId,
          providerChannelId: event.channel.providerChannelId,
        },
      },
      create: {
        workspaceId: delivery.workspaceId,
        connectionId: delivery.connectionId,
        organizationId: event.organizationId,
        providerChannelId: event.channel.providerChannelId,
        connectedPhone: event.channel.connectedPhone,
        channelName: event.channel.name,
        status: "discovered",
        conversionEngineMode: "canonical",
        // Unnichat numbers explicitly follow the workspace Meta configuration
        // (as in the SaaS); other providers keep the column default.
        ...(delivery.provider === "unnichat"
          ? { metaRoutingMode: "inherit_workspace" as const }
          : {}),
        firstSeenAt: processedAt,
        lastSeenAt: processedAt,
      },
      update: {
        connectedPhone: event.channel.connectedPhone,
        // The Unnichat entry webhook has no channel name: keep the name given
        // when the connection was created.
        channelName:
          delivery.provider === "unnichat"
            ? (event.channel.name ?? undefined)
            : event.channel.name,
        lastSeenAt: processedAt,
      },
      select: { id: true },
    });
  }

  private async assertCurrentConnection(
    transaction: Prisma.TransactionClient,
    delivery: LoadedDelivery,
  ): Promise<void> {
    const connection = await transaction.inboundWebhookConnection.findFirst({
      where: this.currentConnectionWhere(delivery),
      select: {
        id: true,
      },
    });

    if (!connection) {
      throw new InboundWebhookObservationError(
        "inbound_webhook_processing_state_changed",
      );
    }
  }

  private currentConnectionWhere(
    delivery: LoadedDelivery,
  ): Prisma.InboundWebhookConnectionWhereInput {
    return {
      id: delivery.connectionId,
      workspaceId: delivery.workspaceId,
      provider: delivery.provider,
      parserReleaseId: delivery.connection.parserReleaseId,
      status: { in: ["observation", "production"] },
      removedAt: null,
      parserRelease: {
        id: delivery.connection.parserRelease.id,
        provider: delivery.provider,
        version: delivery.parserVersion,
        status: delivery.connection.parserRelease.status,
      },
    };
  }

  private async prepareProductionDelivery(
    delivery: LoadedDelivery,
    knownChannelIds?: string[],
  ): Promise<void> {
    const channelIds =
      knownChannelIds ??
      (
        await this.prisma.inboundWebhookEvent.findMany({
          where: {
            workspaceId: delivery.workspaceId,
            connectionId: delivery.connectionId,
            deliveryId: delivery.id,
            classification: {
              in: ["eligible_route_resolved", "eligible_route_unresolved"],
            },
          },
          select: { channelId: true },
          distinct: ["channelId"],
        })
      ).map((event) => event.channelId);

    await Promise.allSettled(
      channelIds.map((channelId) =>
        this.channelRoutes.reevaluateUnresolvedEvents(
          delivery.workspaceId,
          channelId,
        ),
      ),
    );

    try {
      await this.productionIntake.enqueueDelivery({
        workspaceId: delivery.workspaceId,
        connectionId: delivery.connectionId,
        deliveryId: delivery.id,
      });
    } catch {
      this.logger.warn(
        `Live production enqueue deferred for delivery ${delivery.id}`,
      );
    }
  }

  private async prepareProviderConversions(
    delivery: LoadedDelivery,
    parsedResult?: InboundWebhookParserResult,
    force = false,
  ): Promise<void> {
    if (delivery.providerConversionsObservedAt && !force) return;

    try {
      const parser = this.parserRegistry.resolve({
        provider: delivery.connection.provider,
        parserVersion: delivery.connection.parserRelease.version,
        parserReleaseStatus: delivery.connection.parserRelease.status,
      });
      const result =
        parsedResult ?? (await this.parseEncryptedPayload(delivery, parser));

      this.validateParserResult(result, parser);
      if (result.error || result.classification === "invalid_payload") {
        await this.markProviderConversionsObserved(delivery, force);
        return;
      }

      const observed = await this.providerConversions.observeDelivery({
        workspaceId: delivery.workspaceId,
        connectionId: delivery.connectionId,
        deliveryId: delivery.id,
        externalDeliveryId: delivery.externalDeliveryId,
        deliveryReceivedAt: delivery.firstReceivedAt,
        events: result.events,
        manualRecovery: force,
      });

      for (const providerConversionExecutionId of observed.eligibleExecutionIds) {
        try {
          await this.productionQueue.enqueueProviderConversion({
            providerConversionExecutionId,
            workspaceId: delivery.workspaceId,
          });
        } catch {
          this.logger.warn(
            `Provider conversion enqueue deferred for execution ${providerConversionExecutionId}`,
          );
        }
      }

      await this.markProviderConversionsObserved(delivery, force);
    } catch (error) {
      this.logger.warn(
        `Provider conversion observation deferred for delivery ${delivery.id} (${this.safeExceptionSummary(error)})`,
      );
      throw new InboundWebhookObservationError(
        "inbound_webhook_provider_conversion_deferred",
      );
    }
  }

  private async markProviderConversionsObserved(
    delivery: LoadedDelivery,
    force = false,
  ): Promise<void> {
    await this.prisma.inboundWebhookDelivery.updateMany({
      where: {
        id: delivery.id,
        workspaceId: delivery.workspaceId,
        connectionId: delivery.connectionId,
        status: "processed",
        ...(force ? {} : { providerConversionsObservedAt: null }),
      },
      data: {
        providerConversionsObservedAt: new Date(),
      },
    });
  }

  private safeExceptionName(error: unknown): string {
    if (!(error instanceof Error)) return "UnknownError";

    return /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(error.name)
      ? error.name
      : "Error";
  }

  private safeExceptionSummary(error: unknown): string {
    const name = this.safeExceptionName(error);
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Za-z0-9_]{1,80}$/u.test(error.code)
        ? error.code
        : null;

    return code ? `${name}:${code}` : name;
  }

  private async finishFailure(
    delivery: LoadedDelivery,
    failure: DeterministicFailure,
  ): Promise<InboundWebhookObservationResult> {
    const processedAt = new Date();
    const classification =
      failure.classification ?? failure.result?.classification ?? null;
    const updated = await this.prisma.inboundWebhookDelivery.updateMany({
      where: {
        id: delivery.id,
        workspaceId: delivery.workspaceId,
        connectionId: delivery.connectionId,
        status: "processing",
      },
      data: {
        classification,
        status: "failed",
        normalizedSummary: failure.result
          ? this.toJsonValue(
              this.deliverySummary(failure.result.normalizedSummary),
            )
          : undefined,
        parseErrorCode: this.safeErrorCode(
          failure.code,
          "inbound_webhook_processing_failed",
        ),
        routingErrorCode: null,
        processedAt,
      },
    });

    if (updated.count !== 1) {
      throw new InboundWebhookObservationError(
        "inbound_webhook_processing_state_changed",
      );
    }

    await this.recordDiagnostic(
      delivery,
      "failed",
      failure.result,
      failure.code,
      classification,
    );

    return {
      deliveryId: delivery.id,
      status: "failed",
      classification,
      parsedEventCount: failure.result?.events.length ?? 0,
      persistedEventCount: 0,
      idempotent: false,
    };
  }

  private async recordDiagnostic(
    delivery: LoadedDelivery,
    processingStatus: "processed" | "failed",
    result?: InboundWebhookParserResult,
    errorCode?: string,
    failureClassification?: InboundWebhookEventClassification | null,
  ): Promise<void> {
    const eventType = result?.providerEventType ?? "unknown";
    const classification =
      result?.classification ?? failureClassification ?? null;

    try {
      await this.diagnostics.recordObservation({
        workspaceId: delivery.workspaceId,
        deliveryId: delivery.id,
        connectionId: delivery.connectionId,
        provider: delivery.provider,
        eventType,
        parserVersion: result?.parserVersion ?? delivery.parserVersion,
        classification,
        routeStatus: this.routeStatus(classification),
        processingStatus,
        eventCount: result?.events.length ?? 0,
        errorCode: errorCode
          ? this.safeErrorCode(errorCode, "inbound_webhook_processing_failed")
          : null,
        events:
          result?.events.map((event) => ({
            channelId: event.normalizedSummary.providerChannelId,
            connectedPhoneSuffix: event.normalizedSummary.connectedPhoneSuffix,
            adId: event.normalizedSummary.adId,
            hasCtwa: event.normalizedSummary.hasCtwa,
            classification: event.normalizedSummary.classification,
            routeStatus: this.routeStatus(
              event.normalizedSummary.classification,
            ),
          })) ?? [],
      });
    } catch {
      // Diagnostic persistence must never retry completed observation work.
    }
  }

  private routeStatus(
    classification: InboundWebhookEventClassification | null,
  ): "resolved" | "unresolved" | "not_applicable" | "not_evaluated" {
    if (classification === "eligible_route_resolved") {
      return "resolved";
    }

    if (classification === "eligible_route_unresolved") {
      return "unresolved";
    }

    return classification ? "not_applicable" : "not_evaluated";
  }

  private deliverySummary(
    summary: InboundWebhookDeliveryNormalizedSummary,
  ): InboundWebhookDeliveryNormalizedSummary {
    return {
      provider: summary.provider,
      parserVersion: summary.parserVersion,
      providerEventType: summary.providerEventType,
      externalDeliveryId: summary.externalDeliveryId,
      classification: summary.classification,
      classificationReason: summary.classificationReason,
      eventCount: summary.eventCount,
    };
  }

  private eventSummary(
    summary: InboundWebhookEventNormalizedSummary,
  ): InboundWebhookEventNormalizedSummary {
    return {
      provider: summary.provider,
      providerEventType: summary.providerEventType,
      externalEventId: summary.externalEventId,
      externalMessageId: summary.externalMessageId,
      organizationId: summary.organizationId,
      providerChannelId: summary.providerChannelId,
      connectedPhoneSuffix: summary.connectedPhoneSuffix,
      occurredAt: summary.occurredAt,
      adId: summary.adId,
      hasCtwa: summary.hasCtwa,
      messageDirection: summary.messageDirection,
      messageAuthorType: summary.messageAuthorType,
      messageType: summary.messageType,
      classification: summary.classification,
      classificationReason: summary.classificationReason,
      // Only the sha256 of ctwa_clid (already part of the Unnichat
      // click-scoped dedupe key) is retained; the raw ctwa_clid never enters
      // the summary.
      ...(typeof summary.ctwaEntryIdentityHash === "string" &&
      /^[0-9a-f]{64}$/u.test(summary.ctwaEntryIdentityHash)
        ? { ctwaEntryIdentityHash: summary.ctwaEntryIdentityHash }
        : {}),
    };
  }

  private safeErrorCode(value: unknown, fallback: string): string {
    return typeof value === "string" && safeErrorCodePattern.test(value)
      ? value
      : fallback;
  }

  private toJsonValue(value: object): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
