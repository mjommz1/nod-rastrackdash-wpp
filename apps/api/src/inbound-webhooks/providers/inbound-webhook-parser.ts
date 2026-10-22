import { createHash } from "node:crypto";

export type InboundWebhookEventClassification =
  | "eligible_route_resolved"
  | "eligible_route_unresolved"
  | "ignored_no_ctwa"
  | "ignored_outbound"
  | "ignored_private"
  | "ignored_empty_template"
  | "ignored_untracked_lead"
  | "unsupported_event"
  | "invalid_payload";

export type InboundWebhookParserError = {
  code: string;
  message: string;
};

export type InboundWebhookDeliveryNormalizedSummary = {
  provider: string;
  parserVersion: string;
  providerEventType: string | null;
  externalDeliveryId: string | null;
  classification: InboundWebhookEventClassification;
  classificationReason: string;
  eventCount: number;
};

export type InboundWebhookEventNormalizedSummary = {
  provider: string;
  providerEventType: string;
  externalEventId: string;
  externalMessageId: string;
  organizationId: string;
  providerChannelId: string;
  connectedPhoneSuffix: string;
  occurredAt: string;
  adId: string | null;
  hasCtwa: boolean;
  messageDirection: ParsedInboundWebhookMessageDirection;
  messageAuthorType: ParsedInboundWebhookMessageAuthorType;
  messageType: string | null;
  phoneDivergenceDetected?: boolean;
  /** sha256 of ctwa_clid (Unnichat click-scoped dedupe); never the raw id. */
  ctwaEntryIdentityHash?: string;
  classification: InboundWebhookEventClassification;
  classificationReason: string;
};

export type ParsedInboundWebhookMessageDirection =
  "inbound" | "outbound" | "unknown";

export type ParsedInboundWebhookMessageAuthorType =
  "contact" | "organization_member" | "bot" | "unknown";

export type ParsedInboundWebhookMessage = {
  direction: ParsedInboundWebhookMessageDirection;
  authorType: ParsedInboundWebhookMessageAuthorType;
  messageType: string | null;
  text: string | null;
  isPrivate: boolean;
};

export type ParsedInboundWebhookChannel = {
  providerChannelId: string;
  connectedPhone: string;
  name: string | null;
};

export type ParsedInboundWebhookContact = {
  externalContactId: string;
  phoneNumber: string;
  name: string | null;
};

export type ParsedInboundWebhookAd = {
  sourceUrl: string | null;
  description: string | null;
  title: string | null;
  thumbnailUrl: string | null;
  mediaUrl: string | null;
  sourceType: string | null;
};

export type ParsedInboundWebhookEvent = {
  provider: string;
  providerEventType: string;
  externalEventId: string;
  externalMessageId: string;
  dedupeKey: string;
  organizationId: string;
  occurredAt: Date;
  channel: ParsedInboundWebhookChannel;
  contact: ParsedInboundWebhookContact;
  message: ParsedInboundWebhookMessage;
  adId: string | null;
  ad: ParsedInboundWebhookAd | null;
  ctwaClid: string | null;
  hasCtwa: boolean;
  classification: InboundWebhookEventClassification;
  classificationReason: string;
  normalizedSummary: InboundWebhookEventNormalizedSummary;
};

export type InboundWebhookParserResult = {
  provider: string;
  parserVersion: string;
  externalDeliveryId: string | null;
  providerEventType: string | null;
  classification: InboundWebhookEventClassification;
  classificationReason: string;
  events: ParsedInboundWebhookEvent[];
  normalizedSummary: InboundWebhookDeliveryNormalizedSummary;
  error: InboundWebhookParserError | null;
};

export type InboundWebhookParserContext = {
  organizationId?: string;
  /**
   * Channel phone bound by the connection (Unnichat), never a provider
   * payload field.
   */
  connectedPhone?: string;
};

export function inboundWebhookParserContext(
  workspaceId: string,
  connectedPhone?: string | null,
): Readonly<InboundWebhookParserContext> {
  // connectedPhone: only the number bound to the connection (Unnichat).
  return connectedPhone
    ? { organizationId: workspaceId, connectedPhone }
    : { organizationId: workspaceId };
}

export interface InboundWebhookParser {
  readonly provider: string;
  readonly parserVersion: string;
  parse(
    payload: unknown,
    context?: Readonly<InboundWebhookParserContext>,
  ): InboundWebhookParserResult;
}

export type InboundWebhookEventDedupeIdentity = {
  provider: string;
  organizationId: string;
  providerChannelId: string;
  externalMessageId: string;
};

export function buildInboundWebhookEventDedupeKey(
  identity: InboundWebhookEventDedupeIdentity,
): string {
  const canonicalIdentity = JSON.stringify([
    identity.provider,
    identity.organizationId,
    identity.providerChannelId,
    identity.externalMessageId,
  ]);
  const digest = createHash("sha256")
    .update(canonicalIdentity, "utf8")
    .digest("hex");

  return `sha256:${digest}`;
}
