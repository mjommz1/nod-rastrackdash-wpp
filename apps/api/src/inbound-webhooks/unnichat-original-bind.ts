import { createHash } from "node:crypto";
import type {
  ParsedInboundWebhookEvent,
  InboundWebhookParserResult,
  InboundWebhookParserContext,
} from "./providers/inbound-webhook-parser";
import { buildInboundWebhookEventDedupeKey } from "./providers/inbound-webhook-parser";

export const UNNICHAT_ORIGINAL_BIND_MISMATCH =
  "unnichat_original_bind_mismatch";

/** Typed bind failure so replay/production can persist a specific error code
 * instead of collapsing it into a generic "_unexpected". */
export class UnnichatOriginalBindMismatchError extends Error {
  readonly code = UNNICHAT_ORIGINAL_BIND_MISMATCH;

  constructor() {
    super(UNNICHAT_ORIGINAL_BIND_MISMATCH);
    this.name = "UnnichatOriginalBindMismatchError";
  }
}

const ctwaEntryIdentityHashPattern = /^[0-9a-f]{64}$/u;

function ctwaEntryIdentityHash(value: unknown): string | null {
  return typeof value === "string" && ctwaEntryIdentityHashPattern.test(value)
    ? value
    : null;
}

function unnichatDedupeKey(input: {
  organizationId: string;
  providerChannelId: string;
  externalMessageId: string;
  ctwaEntryIdentityHash: string | null;
}): string {
  return buildInboundWebhookEventDedupeKey({
    provider: "unnichat",
    organizationId: input.organizationId,
    providerChannelId: input.providerChannelId,
    externalMessageId: input.ctwaEntryIdentityHash
      ? `${input.externalMessageId}:${input.ctwaEntryIdentityHash}`
      : input.externalMessageId,
  });
}

/** Immutable identity plus retained summary and original dedupe prove the bind;
 * mutable connectedPhone and the buyer phone are never historical evidence.
 *
 * Retained summaries come in two shapes:
 * - with ctwaEntryIdentityHash: the click-scoped dedupe key is proven here;
 * - without it (legacy pre-click events, and click-scoped events persisted
 *   before the observation summary kept the hash): the dedupe key cannot be
 *   recomputed before parsing, so it is proven per occurrence by
 *   matchesOriginalUnnichatOccurrence.
 * Both helpers are module-private: the only entry point is
 * parseOriginalUnnichatOccurrence, so the no-hash bind can never be used
 * without the per-occurrence proof. */
function originalUnnichatContext(event: OriginalUnnichatEvent) {
  const c = event.channel;
  const summary = event.normalizedSummary as Record<string, unknown> | null;
  const retainedHash =
    summary && typeof summary === "object"
      ? ctwaEntryIdentityHash(summary.ctwaEntryIdentityHash)
      : null;
  if (
    event.provider !== "unnichat" ||
    event.connection.provider !== "unnichat" ||
    event.connection.workspaceId !== event.workspaceId ||
    event.connection.id !== event.connectionId ||
    event.delivery.workspaceId !== event.workspaceId ||
    event.delivery.connectionId !== event.connectionId ||
    c.workspaceId !== event.workspaceId ||
    c.connectionId !== event.connectionId ||
    c.id !== event.channelId ||
    c.organizationId !== event.workspaceId ||
    !c.providerChannelId ||
    !event.externalMessageId ||
    !summary ||
    typeof summary !== "object" ||
    summary.providerChannelId !== c.providerChannelId ||
    summary.organizationId !== c.organizationId ||
    summary.externalMessageId !== event.externalMessageId ||
    // A present but malformed hash is never silently downgraded to legacy.
    (summary.ctwaEntryIdentityHash !== undefined && !retainedHash) ||
    (retainedHash &&
      unnichatDedupeKey({
        organizationId: c.organizationId,
        providerChannelId: c.providerChannelId,
        externalMessageId: event.externalMessageId,
        ctwaEntryIdentityHash: retainedHash,
      }) !== event.dedupeKey)
  )
    throw new UnnichatOriginalBindMismatchError();
  const context: InboundWebhookParserContext = {
    organizationId: c.organizationId,
    connectedPhone: c.providerChannelId,
  };
  return { context, dedupeProvenByBind: retainedHash !== null };
}

/** Proves the immutable bind, parses with the bound context and selects the
 * candidate that reproduces the stored identity (undefined = no proof). */
export function parseOriginalUnnichatOccurrence(
  event: OriginalUnnichatEvent,
  parse: (context: InboundWebhookParserContext) => InboundWebhookParserResult,
): {
  result: InboundWebhookParserResult;
  occurrence: ParsedInboundWebhookEvent | undefined;
} {
  const bind = originalUnnichatContext(event);
  const result = parse(bind.context);
  const occurrence = result.events.find((candidate) =>
    matchesOriginalUnnichatOccurrence(event, candidate),
  );
  // Without a retained hash the bind above did NOT prove the dedupe key; the
  // selected occurrence must carry that proof or the bind is rejected.
  if (
    occurrence &&
    !bind.dedupeProvenByBind &&
    !occurrenceReproducesStoredKey(event, occurrence)
  )
    throw new UnnichatOriginalBindMismatchError();
  return { result, occurrence };
}

function occurrenceReproducesStoredKey(
  event: OriginalUnnichatEvent,
  occurrence: ParsedInboundWebhookEvent,
): boolean {
  const hash = ctwaEntryIdentityHash(
    occurrence.normalizedSummary?.ctwaEntryIdentityHash,
  );
  const key = (ctwa: string | null) =>
    unnichatDedupeKey({
      organizationId: event.channel.organizationId,
      providerChannelId: event.channel.providerChannelId,
      externalMessageId: event.externalMessageId!,
      ctwaEntryIdentityHash: ctwa,
    });
  return (
    key(null) === event.dedupeKey ||
    (hash !== null && key(hash) === event.dedupeKey)
  );
}

type OriginalUnnichatEvent = {
  workspaceId: string;
  connectionId: string;
  channelId: string;
  provider: string;
  dedupeKey: string;
  externalMessageId: string | null;
  normalizedSummary: unknown;
  delivery: { workspaceId: string; connectionId: string };
  connection: { id: string; workspaceId: string; provider: string };
  channel: {
    id: string;
    workspaceId: string;
    connectionId: string;
    organizationId: string;
    providerChannelId: string;
  };
};

function matchesOriginalUnnichatOccurrence(
  event: {
    dedupeKey: string;
    externalMessageId: string | null;
    normalizedSummary: unknown;
  },
  candidate: ParsedInboundWebhookEvent,
): boolean {
  if (
    candidate.provider !== "unnichat" ||
    !event.externalMessageId ||
    candidate.externalMessageId !== event.externalMessageId
  )
    return false;
  const summary = event.normalizedSummary as Record<string, unknown> | null;
  const retainedHash = ctwaEntryIdentityHash(summary?.ctwaEntryIdentityHash);
  const candidateHash = ctwaEntryIdentityHash(
    candidate.normalizedSummary?.ctwaEntryIdentityHash,
  );
  if (retainedHash)
    return (
      candidate.dedupeKey === event.dedupeKey && candidateHash === retainedHash
    );
  // Retained legacy source can reproduce its original pre-click identity; it
  // keeps its original event ID and receipt, never invents a new historical send.
  if (
    unnichatDedupeKey({
      organizationId: candidate.organizationId,
      providerChannelId: candidate.channel.providerChannelId,
      externalMessageId: candidate.externalMessageId,
      ctwaEntryIdentityHash: null,
    }) === event.dedupeKey
  )
    return true;
  // Click-scoped event whose retained summary lacks the hash: the stored key
  // must be reproduced from the bound org/channel (context above), the same
  // message and the sha256 of this payload's own ctwa_clid.
  return Boolean(
    candidateHash &&
    candidate.ctwaClid &&
    createHash("sha256").update(candidate.ctwaClid, "utf8").digest("hex") ===
      candidateHash &&
    candidate.dedupeKey === event.dedupeKey &&
    unnichatDedupeKey({
      organizationId: candidate.organizationId,
      providerChannelId: candidate.channel.providerChannelId,
      externalMessageId: candidate.externalMessageId,
      ctwaEntryIdentityHash: candidateHash,
    }) === event.dedupeKey,
  );
}
