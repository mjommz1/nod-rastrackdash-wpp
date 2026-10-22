import type { Prisma, PrismaClient } from "@prisma/client";
import { buildProviderPurchaseIdentity } from "../conversion-rules/provider-purchase-identity";
import type { InboundWebhookPayloadEncryptionService } from "../inbound-webhooks/inbound-webhook-payload-encryption.service";
import {
  parsePaytSaleEventV1,
  paytLegacyTotalPriceCents,
  PAYT_VALUE_CORRECTION_REASON,
} from "../inbound-webhooks/providers/payt/payt-automation-v1.parser";

/**
 * One-off correction of Payt sales recorded with `total_price` (card
 * installment interest included) before the parser preferred
 * `price_without_installments`. Ported from the SaaS (`608ec47`, `1d65161`).
 *
 * Student edition rule (Fase 5.0): only a conversion PROVEN not to have
 * reached Meta is corrected (allowlist of statuses, see
 * NOT_SENT_TO_META_STATUSES). Everything else keeps its value everywhere and
 * is only counted:
 * - `alreadySentToMeta`: sent, or being sent (`dispatching`);
 * - `deliveryUnknown`: outcome unknown (`delivery_unknown`, or an error with
 *   MetaCapiDeliveryUnknown / MetaCapiNetworkError): Meta may have it;
 * - `queued`: `ready_to_send`. The generic sender reads the row once and
 *   keeps `ready_to_send` during the POST, so a correction could race a send
 *   already built with the old value. Run the backfill again once the queue
 *   is empty;
 * - `statusNotCorrectable`: any other status (imported, shadow, ...).
 * Nothing is ever resent: event_id, dedupe key and delivery status are
 * untouched.
 *
 * The new value is re-read from the preserved postback; once that body
 * expired (retention ~7 days) there is no other stored source of the value
 * without interest (the frozen decision only holds total_price), so the row
 * is left as is and counted.
 *
 * The SaaS also corrects the "Vendas sem atribuicao" snapshot
 * (IntegrationEndpointEvent, own cursor `--after-unattributed`, SaaS
 * `1d65161`). Not ported, on purpose: in this edition that table arrives
 * with Fase 5.3, AFTER the Fase 5.0 parser fix, so every receipt is written
 * with the value without installment interest and none ever holds the legacy
 * `total_price`. The other half of `1d65161` (aligning the execution of a
 * log corrected at send time) is ported below.
 *
 * Idempotent: a corrected log carries `sourcePayload.valueCorrection` and
 * every write is guarded by the previous value.
 */

export const PAYT_VALUE_BACKFILL_DEFAULT_LIMIT = 200;
export const PAYT_VALUE_BACKFILL_MAX_LIMIT = 2_000;
const BATCH_SIZE = 100;
const SAMPLE_SIZE = 50;
/** Statuses whose value Meta has (or may have) already received. */
const SENT_TO_META_STATUSES = ["sent", "dispatching"];
/** Delivery attempted with an unknown outcome: Meta may have the event. */
const DELIVERY_UNKNOWN_STATUS = "delivery_unknown";
const DELIVERY_UNKNOWN_ERROR_CODES = [
  "MetaCapiDeliveryUnknown",
  "MetaCapiNetworkError",
];
/** Queued for the sender: never corrected (it may be sending right now). */
const QUEUED_STATUS = "ready_to_send";
/**
 * Allowlist: statuses proven not to have reached Meta (never attempted, or
 * refused before or by Meta). Only these are corrected.
 */
const NOT_SENT_TO_META_STATUSES = [
  "error",
  "skipped",
  "not_configured",
  "not_eligible",
  "pending_meta_context",
  "pending_value",
];

export type PaytValueBackfillOptions = {
  apply: boolean;
  /** Max conversion logs examined in this run. */
  limit: number;
  workspaceId?: string;
  /** Resume after this ConversionEventLog id (the previous `nextCursor`). */
  afterId?: string;
  /** Platform owner recorded in the audit (required when applying). */
  actorUserId?: string;
  now?: Date;
};

type Outcome =
  | "corrected"
  | "unchanged"
  | "alreadyCorrected"
  | "alreadySentToMeta"
  | "deliveryUnknown"
  | "queued"
  | "statusNotCorrectable"
  | "manualAdjustment"
  | "payloadUnavailable"
  | "parseFailed"
  | "identityMismatch"
  | "valueNotLegacy";

export type PaytValueBackfillReport = {
  mode: "dry_run" | "apply";
  conversionEvents: {
    scanned: number;
    /** In dry-run: would be corrected. */
    corrected: number;
    previousTotalCents: number;
    correctedTotalCents: number;
    unchanged: number;
    alreadyCorrected: number;
    /** Already sent to Meta (or being sent): never changed. */
    alreadySentToMeta: number;
    /** Delivery outcome unknown (Meta may have it): never changed. */
    deliveryUnknown: number;
    /** Still queued (ready_to_send): run again once the queue is empty. */
    queued: number;
    /** Any other status outside the allowlist: never changed. */
    statusNotCorrectable: number;
    manualAdjustment: number;
    payloadUnavailable: number;
    parseFailed: number;
    identityMismatch: number;
    valueNotLegacy: number;
    /** Lost a race (value or delivery changed meanwhile): left untouched. */
    concurrentChange: number;
    executionsUpdated: number;
    purchaseReviewsUpdated: number;
    nextCursor: string | null;
    samples: Array<{
      conversionEventLogId: string;
      workspaceId: string | null;
      outcome: Outcome;
      previousValueCents: number | null;
      valueCents: number | null;
    }>;
  };
  safety: {
    metaEventsResent: false;
    metaDeliveryStatusChanged: false;
    eventIdOrDedupeChanged: false;
    sentEventsChanged: false;
  };
};

type LogRow = {
  id: string;
  workspaceId: string | null;
  eventName: string;
  status: string;
  errorCode: string | null;
  sentAt: Date | null;
  dedupeKey: string | null;
  valueCents: number | null;
  sourcePayload: Prisma.JsonValue | null;
  purchaseValueAdjustments: Array<{ id: string }>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type EncryptedRow = {
  encryptedPayload: string | null;
  payloadIv: string | null;
  payloadTag: string | null;
  encryptionKeyVersion: number | null;
  payloadExpiresAt: Date;
};

function decryptJson(
  encryption: Pick<InboundWebhookPayloadEncryptionService, "decrypt">,
  row: EncryptedRow,
  context: { workspaceId: string; connectionId: string; deliveryId: string },
  now: Date,
): unknown | undefined {
  if (
    row.payloadExpiresAt <= now ||
    !row.encryptedPayload ||
    !row.payloadIv ||
    !row.payloadTag ||
    row.encryptionKeyVersion === null
  )
    return undefined;
  try {
    return JSON.parse(
      encryption
        .decrypt(
          {
            encryptedPayload: row.encryptedPayload,
            payloadIv: row.payloadIv,
            payloadTag: row.payloadTag,
            encryptionKeyVersion: row.encryptionKeyVersion,
          },
          context,
        )
        .toString("utf8"),
    ) as unknown;
  } catch {
    return undefined;
  }
}

/** Why a conversion may not be corrected, or null when it never reached Meta. */
function notCorrectableReason(row: {
  status: string;
  errorCode: string | null;
  sentAt: Date | null;
}):
  | "alreadySentToMeta"
  | "deliveryUnknown"
  | "queued"
  | "statusNotCorrectable"
  | null {
  if (row.sentAt !== null || SENT_TO_META_STATUSES.includes(row.status))
    return "alreadySentToMeta";
  if (
    row.status === DELIVERY_UNKNOWN_STATUS ||
    (row.errorCode !== null &&
      DELIVERY_UNKNOWN_ERROR_CODES.includes(row.errorCode))
  )
    return "deliveryUnknown";
  if (row.status === QUEUED_STATUS) return "queued";
  if (!NOT_SENT_TO_META_STATUSES.includes(row.status))
    return "statusNotCorrectable";
  return null;
}

export async function runPaytValueBackfill(
  prisma: PrismaClient,
  encryption: Pick<InboundWebhookPayloadEncryptionService, "decrypt">,
  options: PaytValueBackfillOptions,
): Promise<PaytValueBackfillReport> {
  if (options.apply && !options.actorUserId)
    throw new Error("payt_value_backfill_actor_required");
  const now = options.now ?? new Date();
  const limit = Math.max(
    1,
    Math.min(options.limit, PAYT_VALUE_BACKFILL_MAX_LIMIT),
  );
  const report: PaytValueBackfillReport = {
    mode: options.apply ? "apply" : "dry_run",
    conversionEvents: {
      scanned: 0,
      corrected: 0,
      previousTotalCents: 0,
      correctedTotalCents: 0,
      unchanged: 0,
      alreadyCorrected: 0,
      alreadySentToMeta: 0,
      deliveryUnknown: 0,
      queued: 0,
      statusNotCorrectable: 0,
      manualAdjustment: 0,
      payloadUnavailable: 0,
      parseFailed: 0,
      identityMismatch: 0,
      valueNotLegacy: 0,
      concurrentChange: 0,
      executionsUpdated: 0,
      purchaseReviewsUpdated: 0,
      nextCursor: null,
      samples: [],
    },
    safety: {
      metaEventsResent: false,
      metaDeliveryStatusChanged: false,
      eventIdOrDedupeChanged: false,
      sentEventsChanged: false,
    },
  };
  const events = report.conversionEvents;
  const sample = (
    row: LogRow,
    outcome: Outcome,
    valueCents: number | null = row.valueCents,
  ) => {
    if (events.samples.length < SAMPLE_SIZE)
      events.samples.push({
        conversionEventLogId: row.id,
        workspaceId: row.workspaceId,
        outcome,
        previousValueCents: row.valueCents,
        valueCents,
      });
  };

  async function correctLog(row: LogRow): Promise<void> {
    const source = asRecord(row.sourcePayload) ?? {};
    const existing = asRecord(source.valueCorrection);
    if (existing) {
      events.alreadyCorrected += 1;
      // Corrected at send time (legacy frozen decision): the conversion
      // travelled with the corrected value but the execution may still hold
      // the legacy one. Aligning it changes nothing that Meta received.
      const previous = existing.previousValueCents;
      if (
        options.apply &&
        row.workspaceId &&
        typeof previous === "number" &&
        row.valueCents !== null &&
        previous !== row.valueCents
      ) {
        const executions =
          await prisma.providerConversionRuleExecution.updateMany({
            where: {
              workspaceId: row.workspaceId,
              conversionEventLogId: row.id,
              valueCents: previous,
            },
            data: { valueCents: row.valueCents },
          });
        events.executionsUpdated += executions.count;
      }
      return;
    }
    // Only what provably never reached Meta is corrected.
    const blocked = notCorrectableReason(row);
    if (blocked) {
      events[blocked] += 1;
      sample(row, blocked);
      return;
    }
    // An operator-adjusted value (purchase review) always wins.
    if (row.purchaseValueAdjustments.length > 0) {
      events.manualAdjustment += 1;
      sample(row, "manualAdjustment");
      return;
    }
    const deliveryId =
      typeof source.sourceDeliveryId === "string"
        ? source.sourceDeliveryId
        : null;
    const delivery =
      deliveryId && row.workspaceId
        ? await prisma.inboundWebhookDelivery.findFirst({
            where: { id: deliveryId, workspaceId: row.workspaceId },
            select: {
              id: true,
              workspaceId: true,
              connectionId: true,
              encryptedPayload: true,
              payloadIv: true,
              payloadTag: true,
              encryptionKeyVersion: true,
              payloadExpiresAt: true,
            },
          })
        : null;
    const body = delivery
      ? decryptJson(
          encryption,
          delivery,
          {
            workspaceId: delivery.workspaceId,
            connectionId: delivery.connectionId,
            deliveryId: delivery.id,
          },
          now,
        )
      : undefined;
    if (body === undefined) {
      events.payloadUnavailable += 1;
      sample(row, "payloadUnavailable");
      return;
    }
    const parsed = parsePaytSaleEventV1(body);
    if (!parsed.ok || parsed.value.valueCents === null) {
      events.parseFailed += 1;
      sample(row, "parseFailed");
      return;
    }
    // The preserved body must be THIS sale (same purchase identity).
    if (
      parsed.value.eventName !== row.eventName ||
      !row.workspaceId ||
      row.dedupeKey !==
        buildProviderPurchaseIdentity({
          workspaceId: row.workspaceId,
          provider: "payt",
          accountRef: parsed.value.accountRef,
          orderRef: parsed.value.orderRef,
          eventName: parsed.value.eventName,
        })
    ) {
      events.identityMismatch += 1;
      sample(row, "identityMismatch");
      return;
    }
    const valueCents = parsed.value.valueCents;
    const previousValueCents = row.valueCents!;
    if (valueCents === previousValueCents) {
      events.unchanged += 1;
      return;
    }
    // Only the legacy value (total_price of the same body) is corrected; any
    // other difference has another origin and is left for a human.
    if (previousValueCents !== paytLegacyTotalPriceCents(body)) {
      events.valueNotLegacy += 1;
      sample(row, "valueNotLegacy");
      return;
    }
    if (!options.apply) {
      events.corrected += 1;
      events.previousTotalCents += previousValueCents;
      events.correctedTotalCents += valueCents;
      sample(row, "corrected", valueCents);
      return;
    }
    const valueCorrection = {
      previousValueCents,
      valueCents,
      reason: PAYT_VALUE_CORRECTION_REASON,
      correctedAt: now.toISOString(),
      source: "backfill",
    };
    const outcome = await prisma.$transaction(async (tx) => {
      const updated = await tx.conversionEventLog.updateMany({
        where: {
          id: row.id,
          valueCents: previousValueCents,
          // Never race the sender: the allowlist is re-checked on write, so
          // a conversion queued, sent or with an unknown outcome since it
          // was read keeps its value.
          sentAt: null,
          status: { in: NOT_SENT_TO_META_STATUSES },
          OR: [
            { errorCode: null },
            { errorCode: { notIn: DELIVERY_UNKNOWN_ERROR_CODES } },
          ],
        },
        data: {
          valueCents,
          sourcePayload: {
            ...source,
            valueCorrection,
          } as Prisma.InputJsonValue,
        },
      });
      if (updated.count !== 1) return null;
      const executions = await tx.providerConversionRuleExecution.updateMany({
        where: {
          workspaceId: row.workspaceId!,
          conversionEventLogId: row.id,
          valueCents: previousValueCents,
        },
        data: { valueCents },
      });
      const reviews = await tx.purchaseReview.updateMany({
        where: {
          workspaceId: row.workspaceId!,
          conversionEventLogId: row.id,
          effectiveValueCents: previousValueCents,
        },
        data: { effectiveValueCents: valueCents, version: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          workspaceId: row.workspaceId,
          actorUserId: options.actorUserId!,
          actorType: "platform_owner",
          action: "conversion_event.payt_value_corrected",
          targetType: "ConversionEventLog",
          targetId: row.id,
          reason: "Payt: valor da venda sem juros do parcelamento",
          resultStatus: "success",
          beforeSummary: { valueCents: previousValueCents },
          afterSummary: {
            valueCents,
            executionsUpdated: executions.count,
            purchaseReviewsUpdated: reviews.count,
            metaEventResent: false,
          },
        },
      });
      return { executions: executions.count, reviews: reviews.count };
    });
    if (!outcome) {
      events.concurrentChange += 1;
      return;
    }
    events.corrected += 1;
    events.previousTotalCents += previousValueCents;
    events.correctedTotalCents += valueCents;
    events.executionsUpdated += outcome.executions;
    events.purchaseReviewsUpdated += outcome.reviews;
    sample(row, "corrected", valueCents);
  }

  // Conversion events (reports, revenue, ROAS, Eventos Meta, lead).
  let cursor = options.afterId ?? null;
  let exhausted = false;
  while (events.scanned < limit) {
    const rows = (await prisma.conversionEventLog.findMany({
      where: {
        eventName: "Purchase",
        valueCents: { not: null },
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
        OR: [
          { sourcePayload: { path: ["provider"], equals: "payt" } },
          { sourceTrigger: { startsWith: "inbound_webhook:payt:" } },
        ],
      },
      orderBy: { id: "asc" },
      take: Math.min(BATCH_SIZE, limit - events.scanned),
      select: {
        id: true,
        workspaceId: true,
        eventName: true,
        status: true,
        errorCode: true,
        sentAt: true,
        dedupeKey: true,
        valueCents: true,
        sourcePayload: true,
        purchaseValueAdjustments: { take: 1, select: { id: true } },
      },
    })) as LogRow[];
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    for (const row of rows) {
      events.scanned += 1;
      cursor = row.id;
      await correctLog(row);
    }
  }
  events.nextCursor = exhausted ? null : cursor;

  if (options.apply) {
    await prisma.auditLog.create({
      data: {
        workspaceId: options.workspaceId ?? null,
        actorUserId: options.actorUserId!,
        actorType: "platform_owner",
        action: "conversion_event.payt_value_backfill",
        targetType: options.workspaceId ? "Workspace" : "Platform",
        targetId: options.workspaceId ?? "platform",
        reason: "Payt: valor da venda sem juros do parcelamento",
        resultStatus: "success",
        afterSummary: {
          conversionEventsScanned: events.scanned,
          conversionEventsCorrected: events.corrected,
          executionsUpdated: events.executionsUpdated,
          alreadySentToMeta: events.alreadySentToMeta,
          deliveryUnknown: events.deliveryUnknown,
          queued: events.queued,
          statusNotCorrectable: events.statusNotCorrectable,
          payloadUnavailable: events.payloadUnavailable,
          nextCursor: events.nextCursor,
          metaEventsResent: false,
        },
      },
    });
  }
  return report;
}
