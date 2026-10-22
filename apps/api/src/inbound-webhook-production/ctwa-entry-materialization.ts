import { Prisma } from "@prisma/client";
import { ConversionRecordError } from "../conversion-events/conversion-record.error";
import type { LeadsService } from "../leads/leads.service";
import type { ConversionEventsService } from "../conversion-events/conversion-events.service";
import type { ParsedInboundWebhookEvent } from "../inbound-webhooks/providers/inbound-webhook-parser";
import {
  CTWA_DESTINATION_AD_HINT_REASON,
  ctwaAdUnknown,
  isCtwaDestinationEntry,
  isCtwaDestinationReason,
  resolveCtwaDestination,
  type CtwaChannel,
} from "../inbound-webhooks/authorized-ctwa-destination";
import { InboundWebhookMetaRouteReaderService } from "../inbound-webhooks/inbound-webhook-meta-route-reader.service";
import type { PrismaService } from "../common/prisma/prisma.service";
import {
  canonicalRouteAuthorized,
  type CanonicalMetaEvent,
} from "../inbound-webhooks/inbound-webhook-effective-meta-routing";
import {
  normalizePhoneIdentity,
  hashPhoneIdentity,
} from "../common/phone/phone-identity";

/** Typed refusal of the no-ad CTWA entry materializer. Codes are suffixes the
 * replay/production services prefix and persist (never "_unexpected"). */
export type CtwaEntryMaterializationErrorCode =
  "route_invalid" | "identity_invalid" | "lead_invalid";

export class CtwaEntryMaterializationError extends Error {
  constructor(readonly code: CtwaEntryMaterializationErrorCode) {
    super(`ctwa_entry_${code}`);
    this.name = "CtwaEntryMaterializationError";
  }
}

export async function entryRouteAuthorized(
  client: Prisma.TransactionClient,
  event: CanonicalMetaEvent & {
    provider?: string;
    classificationReason?: string | null;
    hasCtwa?: boolean;
  },
): Promise<boolean> {
  const ctwaEntry = isCtwaDestinationEntry(event);
  if (event.adId && !ctwaEntry) {
    // A stored canonical ad decision never borrows the CTWA destination path.
    if (isCtwaDestinationReason(event.classificationReason)) return false;
    return canonicalRouteAuthorized(client, event);
  }
  if (
    !ctwaEntry ||
    !event.hasCtwa ||
    event.workspaceId !== event.channel.workspaceId
  )
    return false;
  const r = await resolveCtwaDestination(client, event.channel as CtwaChannel);
  if (
    r.kind !== "authorized_ctwa_destination" ||
    r.destinationId !== event.resolvedConversionDestinationId ||
    r.businessConnectionId !== event.resolvedBusinessConnectionId ||
    event.resolvedReportingAccountId !== null
  )
    return false;
  // Ad-hint decision: valid only while the ad is still unknown. Once the ad is
  // synced/attributed, the canonical ad route must be re-evaluated instead.
  return event.adId
    ? ctwaAdUnknown(
        new InboundWebhookMetaRouteReaderService(client as PrismaService),
        event.workspaceId,
        event.adId.trim(),
      )
    : true;
}
export async function materializeCtwaEntry(
  client: Prisma.TransactionClient,
  event: {
    id: string;
    workspaceId: string;
    connectionId: string;
    channelId: string;
    dedupeKey: string;
    externalMessageId: string | null;
    occurredAt: Date;
    channel: CtwaChannel;
    provider?: string | null;
    adId?: string | null;
    classificationReason?: string | null;
  },
  parsed: ParsedInboundWebhookEvent,
  leads: LeadsService,
  conversions: ConversionEventsService,
  eventId: string,
  mode: "live_production" | "authorized_replay",
) {
  const route = await resolveCtwaDestination(client, event.channel);
  if (route.kind !== "authorized_ctwa_destination")
    throw new CtwaEntryMaterializationError("route_invalid");
  const phone = normalizePhoneIdentity(parsed.contact.phoneNumber);
  const phoneHash = hashPhoneIdentity(parsed.contact.phoneNumber);
  // No-ad decision (authorized_ctwa_destination): parsed.adId is deliberately
  // NOT a gate. Meta CAPI needs only page + pixel + ctwa_clid. Events stored
  // before the parser read ctwa_id re-parse with a SourceID today; that
  // unverified hint is never used for routing or attribution (no ad id set).
  // Ad-hint decision (authorized_ctwa_destination_ad_hint): the ad id was
  // stored at ingestion, so the retained payload must re-parse to the same id.
  // It is kept only as the conversion's ad_id hint (custom_data.ad_id); it
  // never selects a route and never fills account/campaign/ad set.
  const adHint =
    event.classificationReason === CTWA_DESTINATION_AD_HINT_REASON
      ? (event.adId?.trim() ?? null)
      : null;
  if (
    !phone ||
    !phoneHash ||
    !parsed.ctwaClid ||
    (event.classificationReason === CTWA_DESTINATION_AD_HINT_REASON &&
      (!adHint || parsed.adId?.trim() !== adHint))
  )
    throw new CtwaEntryMaterializationError("identity_invalid");
  const lead = await leads.upsertFromWhatsappWebhook(
    {
      workspaceId: event.workspaceId,
      phone,
      name: parsed.contact.name ?? undefined,
      // Provider-supplied name only fills an empty lead name.
      preserveExistingName: true,
      source: "unnichat",
      preserveExistingSource: true,
      preserveEarliestFirstMessageAt: true,
      ctwaClid: parsed.ctwaClid,
      occurredAt: event.occurredAt,
      firstMessageAt: event.occurredAt,
      lastMessageAt: event.occurredAt,
    },
    client,
  );
  if (!lead) throw new CtwaEntryMaterializationError("lead_invalid");
  const conversion = await conversions.recordExternalConversion(
    {
      workspaceId: event.workspaceId,
      sourceEventId: event.externalMessageId ?? event.id,
      sourceTrigger: "inbound_webhook:unnichat",
      eventName: "LeadSubmitted",
      eventId,
      dedupeKey: `inbound-webhook:${event.connectionId}:${event.dedupeKey}`,
      leadId: lead.id,
      phoneHash,
      businessSource: "paid",
      ...(adHint ? { adId: adHint } : {}),
      ctwaClid: parsed.ctwaClid,
      eventOccurredAt: event.occurredAt,
      ctwaDestination: route,
      sourcePayload: {
        provider: "unnichat",
        connectionId: event.connectionId,
        inboundEventId: event.id,
        channelId: event.channelId,
        processingMode: mode,
      },
    },
    client,
  );
  return {
    leadId: lead.id,
    conversionEventLogId: conversion.conversionEventLogId,
    duplicate: conversion.status === "duplicate",
    queueReady: conversion.deliveryStatus === "ready_to_send",
  };
}

/** Maps known refusals of the CTWA materialization path to a sanitized code
 * suffix (the caller adds its prefix). null = genuinely unexpected. */
export function ctwaMaterializationFailureSuffix(
  error: unknown,
): string | null {
  if (error instanceof CtwaEntryMaterializationError) return error.code;
  if (error instanceof ConversionRecordError)
    return error.code === "ctwa_destination_not_authorized"
      ? "route_invalid"
      : error.code;
  if (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError
  )
    return "database_error";
  return null;
}
