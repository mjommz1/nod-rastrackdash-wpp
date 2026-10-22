import { createHash } from "node:crypto";
import { boundedString } from "../inbound-webhook-delivery-identity";
import {
  buildInboundWebhookEventDedupeKey,
  type InboundWebhookDeliveryNormalizedSummary,
  type InboundWebhookEventClassification,
  type InboundWebhookEventNormalizedSummary,
  type InboundWebhookParser,
  type InboundWebhookParserContext,
  type InboundWebhookParserResult,
  type ParsedInboundWebhookEvent,
} from "../inbound-webhook-parser";
import { normalizePhoneIdentity } from "../../../common/phone/phone-identity";

export const UNNICHAT_V1_PROVIDER = "unnichat";
export const UNNICHAT_V1_PARSER_VERSION = "v1";

const invalidPayloadError = {
  code: "unnichat_v1_invalid_payload",
  message: "Inbound webhook payload failed validation",
} as const;

type OptionalString = { valid: boolean; value: string | null };

export type ParsedUnnichatV1Payload = {
  event: string;
  phone: string;
  externalId: string;
  ctwaClid: string | null;
  adId: string | null;
  origin: string;
  /** Sanitized display name; PII, never part of any persisted summary. */
  contactName: string | null;
};

const CONTACT_NAME_MAXIMUM_LENGTH = 120;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown, maximumLength: number): OptionalString {
  if (value === null || value === undefined) {
    return { valid: true, value: null };
  }
  if (typeof value !== "string") return { valid: false, value: null };
  const normalized = value.trim();
  if (normalized.length === 0) return { valid: true, value: null };
  const bounded = boundedString(normalized, maximumLength);
  return bounded
    ? { valid: true, value: bounded }
    : { valid: false, value: null };
}

function optionalSourceId(value: unknown): OptionalString {
  if (value === null || value === undefined) {
    return { valid: true, value: null };
  }
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) {
    return { valid: false, value: null };
  }
  if (value.trim().length === 0) return { valid: true, value: null };
  // Preserve the supplied token: malformed identifiers must not be trimmed
  // into a different, potentially resolvable origin. No numeric coercion.
  if (/\s/u.test(value) || boundedString(value, 255) !== value) {
    return { valid: false, value: null };
  }
  return { valid: true, value };
}

/**
 * Optional lead display name from the client's CTWA template (`name`, then
 * `first_name`). Unsubstituted `{{...}}` placeholders, absurd lengths and
 * values that are only a phone number are discarded: the name is enrichment
 * and must never invalidate an event, nor take part in any identity.
 */
function contactDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (name.length === 0 || name.length > CONTACT_NAME_MAXIMUM_LENGTH) {
    return null;
  }
  if (/\{\{|\}\}/u.test(name)) return null;
  if (/^(?:null|undefined|none|n\/a)$/iu.test(name)) return null;
  // A phone number (or any digits/punctuation-only text) is not a name.
  if (!/\p{L}/u.test(name)) return null;
  return name;
}

function unwrap(payload: unknown): Record<string, unknown> | null {
  const direct = asRecord(payload);
  if (direct) return direct;

  if (!Array.isArray(payload) || payload.length !== 1) return null;
  const envelope = asRecord(payload[0]);
  return envelope ? asRecord(envelope.body) : null;
}

/**
 * The provider sends the same body to entry and automation endpoints. This
 * validates only that shared contract and deliberately does not expose
 * event_name as a conversion input.
 */
export function parseUnnichatV1Payload(
  payload: unknown,
): ParsedUnnichatV1Payload | null {
  const body = unwrap(payload);
  if (!body) return null;

  const event = boundedString(body.event, 120);
  const eventName = boundedString(body.event_name, 120);
  const rawPhone = boundedString(body.phone, 256);
  const phone = rawPhone ? normalizePhoneIdentity(rawPhone) : undefined;
  const externalId = boundedString(body.external_id, 255);
  const sourceType = boundedString(body.source_type, 120);
  const leadSource = boundedString(body.lead_source, 120);
  const source = boundedString(body.source, 120);
  const channel = boundedString(body.channel, 120);
  const origin = boundedString(body.origin, 255);
  const ctwaClid = optionalString(body.ctwa_clid, 2_048);
  const sourceId = optionalSourceId(body.ctwa_id);

  if (
    !event ||
    !eventName ||
    !phone ||
    !externalId ||
    !sourceType ||
    !leadSource ||
    source !== UNNICHAT_V1_PROVIDER ||
    channel !== "whatsapp" ||
    !origin ||
    !ctwaClid.valid ||
    !sourceId.valid
  ) {
    return null;
  }

  return {
    event,
    phone,
    externalId,
    ctwaClid: ctwaClid.value,
    // User-confirmed SourceID/ad origin; only the scoped canonical resolver
    // may establish ownership, destination and attribution from this hint.
    adId: sourceId.value,
    origin,
    contactName:
      contactDisplayName(body.name) ?? contactDisplayName(body.first_name),
  };
}

function summary(input: {
  providerEventType: string | null;
  externalDeliveryId: string | null;
  classification: InboundWebhookEventClassification;
  classificationReason: string;
  eventCount: number;
}): InboundWebhookDeliveryNormalizedSummary {
  return {
    provider: UNNICHAT_V1_PROVIDER,
    parserVersion: UNNICHAT_V1_PARSER_VERSION,
    ...input,
  };
}

function invalidResult(
  classificationReason: string,
): InboundWebhookParserResult {
  return {
    provider: UNNICHAT_V1_PROVIDER,
    parserVersion: UNNICHAT_V1_PARSER_VERSION,
    providerEventType: null,
    externalDeliveryId: null,
    classification: "invalid_payload",
    classificationReason,
    events: [],
    normalizedSummary: summary({
      providerEventType: null,
      externalDeliveryId: null,
      classification: "invalid_payload",
      classificationReason,
      eventCount: 0,
    }),
    error: { ...invalidPayloadError },
  };
}

function parsePayload(
  payload: unknown,
  context: InboundWebhookParserContext | undefined,
): InboundWebhookParserResult {
  const organizationId = boundedString(context?.organizationId, 255);
  if (!organizationId) return invalidResult("organization_context_missing");

  // This is a connection bind, never a field accepted from provider JSON.
  const connectedPhone = boundedString(context?.connectedPhone, 256);
  if (!connectedPhone) return invalidResult("connected_phone_context_missing");

  if (!unwrap(payload)) return invalidResult("payload_envelope_unsupported");
  const body = parseUnnichatV1Payload(payload);
  if (!body) return invalidResult("payload_validation_failed");

  const hasCtwa = body.ctwaClid !== null;
  const classification: InboundWebhookEventClassification = hasCtwa
    ? "eligible_route_unresolved"
    : "ignored_no_ctwa";
  const classificationReason = hasCtwa
    ? "route_resolution_pending"
    : "ctwa_missing";
  const occurredAt = new Date();
  const ctwaEntryIdentityHash = body.ctwaClid
    ? createHash("sha256").update(body.ctwaClid, "utf8").digest("hex")
    : undefined;
  const normalizedSummary: InboundWebhookEventNormalizedSummary = {
    provider: UNNICHAT_V1_PROVIDER,
    providerEventType: body.event,
    externalEventId: body.externalId,
    externalMessageId: body.externalId,
    organizationId,
    // There is no provider channel id in this envelope. Until the bound channel
    // phase, the connection-supplied phone is the only safe channel identity.
    providerChannelId: connectedPhone,
    connectedPhoneSuffix: connectedPhone.slice(-4),
    occurredAt: occurredAt.toISOString(),
    adId: body.adId,
    hasCtwa,
    ...(ctwaEntryIdentityHash ? { ctwaEntryIdentityHash } : {}),
    messageDirection: "inbound",
    messageAuthorType: "contact",
    messageType: null,
    classification,
    classificationReason,
  };
  const event: ParsedInboundWebhookEvent = {
    provider: UNNICHAT_V1_PROVIDER,
    providerEventType: body.event,
    externalEventId: body.externalId,
    externalMessageId: body.externalId,
    dedupeKey: buildInboundWebhookEventDedupeKey({
      provider: UNNICHAT_V1_PROVIDER,
      organizationId,
      providerChannelId: connectedPhone,
      externalMessageId: ctwaEntryIdentityHash
        ? `${body.externalId}:${ctwaEntryIdentityHash}`
        : body.externalId,
    }),
    organizationId,
    occurredAt,
    channel: {
      providerChannelId: connectedPhone,
      connectedPhone,
      name: null,
    },
    contact: {
      externalContactId: body.externalId,
      phoneNumber: body.phone,
      // Re-derived from the retained encrypted payload at materialization; the
      // persisted event summary never carries it.
      name: body.contactName,
    },
    message: {
      direction: "inbound",
      authorType: "contact",
      messageType: null,
      text: null,
      isPrivate: false,
    },
    adId: body.adId,
    ad: null,
    ctwaClid: body.ctwaClid,
    hasCtwa,
    classification,
    classificationReason,
    normalizedSummary,
  };

  return {
    provider: UNNICHAT_V1_PROVIDER,
    parserVersion: UNNICHAT_V1_PARSER_VERSION,
    providerEventType: body.event,
    externalDeliveryId: body.externalId,
    classification,
    classificationReason,
    events: [event],
    normalizedSummary: summary({
      providerEventType: body.event,
      externalDeliveryId: body.externalId,
      classification,
      classificationReason,
      eventCount: 1,
    }),
    error: null,
  };
}

export function parseUnnichatV1Webhook(
  payload: unknown,
  context?: InboundWebhookParserContext,
): InboundWebhookParserResult {
  try {
    return parsePayload(payload, context);
  } catch {
    return invalidResult("payload_validation_failed");
  }
}

export class UnnichatV1Parser implements InboundWebhookParser {
  readonly provider = UNNICHAT_V1_PROVIDER;
  readonly parserVersion = UNNICHAT_V1_PARSER_VERSION;

  parse(
    payload: unknown,
    context?: InboundWebhookParserContext,
  ): InboundWebhookParserResult {
    return parseUnnichatV1Webhook(payload, context);
  }
}
