import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

/**
 * Webhooks v2 "change" deliveries carry the full current deal in `data` and
 * ONLY the changed fields (with their old values) in `previous`. The kind is
 * decided from the keys present in `previous`:
 * - `status` present and data.status is won/lost (and differs) -> deal_won /
 *   deal_lost. Takes precedence over a simultaneous stage change.
 * - `stage_id` present and different from data.stage_id -> stage_change.
 * - anything else (custom_fields, value, title, owner, update_time...) is
 *   ignored: no conversion, no person lookup.
 * All Webhooks v2 envelope assumptions live in this file (and its fixtures).
 */
export type PipedriveDealChangeKind = "stage_change" | "deal_won" | "deal_lost";
export const PIPEDRIVE_DEAL_STATUSES = ["open", "won", "lost", "deleted"] as const;
export type PipedriveDealStatus = (typeof PIPEDRIVE_DEAL_STATUSES)[number];

export type PipedriveStageEvent = {
  kind: PipedriveDealChangeKind;
  accountId: string | null;
  accountSubdomain: string | null;
  dealId: string;
  pipelineId: string;
  stageId: string;
  /** Previous stage; null when the stage did not change (won/lost). */
  oldStageId: string | null;
  dealStatus: PipedriveDealStatus | null;
  previousDealStatus: PipedriveDealStatus | null;
  personId: string | null;
  /** meta.id: diagnostic only, never part of the delivery identity. */
  eventId: string | null;
  occurredAt: Date;
  /** data.update_time when present (stable across retries), else meta.timestamp. */
  changedAt: Date;
  valueCents: number | null;
  valuePresent: boolean;
  currency: string | null;
};

export type PipedriveIgnoredReason =
  | "not_deal_change"
  | "no_relevant_change";

export type PipedriveDealChangeClassification =
  | { kind: "event"; event: PipedriveStageEvent }
  | { kind: "ignored"; reason: PipedriveIgnoredReason };

const MAX_BODY_BYTES = 100 * 1024;
const MAX_DEPTH = 8;
const MAX_ITEMS = 5_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeTree(value: unknown, depth = 0, budget = { items: 0 }): boolean {
  budget.items += 1;
  if (depth > MAX_DEPTH || budget.items > MAX_ITEMS) return false;
  if (Array.isArray(value))
    return (
      value.length <= 1_000 &&
      value.every((item) => safeTree(item, depth + 1, budget))
    );
  const record = object(value);
  if (!record) return true;
  if (![null, Object.prototype].includes(Object.getPrototypeOf(record)))
    return false;
  return Object.keys(record).every(
    (key) =>
      !FORBIDDEN_KEYS.has(key) && safeTree(record[key], depth + 1, budget),
  );
}

/** Bounded JSON-only decoder, safe to call before webhook authentication. */
export function decodePipedriveBody(
  raw: unknown,
  contentType: unknown,
): unknown | null {
  if (
    !Buffer.isBuffer(raw) ||
    raw.byteLength > MAX_BODY_BYTES ||
    typeof contentType !== "string"
  )
    return null;
  const [media, ...parameters] = contentType
    .toLowerCase()
    .split(";")
    .map((part) => part.trim());
  if (
    media !== "application/json" ||
    parameters.some((part) => !/^charset=(?:utf-8|"utf-8")$/.test(part))
  )
    return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    // Bound work before allocating the tree, including escaped forbidden keys.
    let depth = 0;
    let items = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '"') {
        const start = index++;
        while (index < text.length && text[index] !== '"') {
          if (text[index] === "\\") index += 1;
          index += 1;
        }
        if (index >= text.length) return null;
        if (
          /^\s*:/.test(text.slice(index + 1)) &&
          FORBIDDEN_KEYS.has(JSON.parse(text.slice(start, index + 1)))
        )
          return null;
      } else if (char === "{" || char === "[") {
        depth += 1;
        if (depth > MAX_DEPTH + 1) return null;
      } else if (char === "}" || char === "]") depth -= 1;
      if (char === "," || char === ":" || char === "[") items += 1;
      if (items > MAX_ITEMS || depth < 0) return null;
    }
    const parsed: unknown = JSON.parse(text);
    return safeTree(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function id(value: unknown): string | null {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value)) return null;
  return Number.isSafeInteger(Number(value)) ? value : null;
}

function timestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    parts;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}` ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour ?? 0) > 23 ||
    Number(offsetMinute ?? 0) > 59
  )
    return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function cents(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = /^(-?)(\d{1,16})(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  const amount =
    (BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"))) *
    (match[1] ? -1n : 1n);
  return amount >= BigInt(Number.MIN_SAFE_INTEGER) &&
    amount <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(amount)
    : null;
}

function dealStatus(value: unknown): PipedriveDealStatus | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  const status = value.trim().toLowerCase();
  return (PIPEDRIVE_DEAL_STATUSES as readonly string[]).includes(status)
    ? (status as PipedriveDealStatus)
    : // An unknown status string is not a won/lost transition; never malformed.
      null;
}

/**
 * Explicit classification of one delivery. null = malformed (400); ignored =
 * valid delivery that never converts (custom field edits, other entities...).
 * Phone lookup belongs to the adapter, in the worker, never here.
 */
export function classifyPipedriveDealChange(
  value: unknown,
): PipedriveDealChangeClassification | null {
  if (!safeTree(value)) return null;
  const root = object(value);
  const meta = object(root?.meta);
  if (
    !root ||
    !meta ||
    typeof meta.action !== "string" ||
    typeof meta.entity !== "string" ||
    (meta.version != null && meta.version !== "2.0")
  )
    return null;
  const ignored = (reason: PipedriveIgnoredReason) =>
    ({ kind: "ignored", reason }) as const;
  if (meta.entity !== "deal" || meta.action !== "change")
    return ignored("not_deal_change");
  const data = object(root.data);
  const previous = object(root.previous);
  if (!data || (root.previous != null && !previous)) return null;
  const dealId = id(data.id);
  const pipelineId = id(data.pipeline_id);
  const stageId = id(data.stage_id);
  if (!dealId || !pipelineId || !stageId) return null;
  if (meta.entity_id != null && id(meta.entity_id) !== dealId) return null;
  if (!previous) return ignored("no_relevant_change");

  const current = dealStatus(data.status);
  if (current === undefined) return null;
  let kind: PipedriveDealChangeKind | null = null;
  let previousDealStatus: PipedriveDealStatus | null = null;
  // 1) status transition to won/lost (precedence over a stage change).
  if (Object.hasOwn(previous, "status")) {
    const before = dealStatus(previous.status);
    if (before === undefined) return null;
    previousDealStatus = before;
    if ((current === "won" || current === "lost") && before !== current)
      kind = current === "won" ? "deal_won" : "deal_lost";
  }
  // 2) stage transition.
  let oldStageId: string | null = null;
  if (Object.hasOwn(previous, "stage_id")) {
    oldStageId = id(previous.stage_id);
    if (!oldStageId) return null;
    if (oldStageId === stageId) oldStageId = null;
    else if (!kind) kind = "stage_change";
  }
  // 3) everything else (custom fields, value, owner, update_time...).
  if (!kind) return ignored("no_relevant_change");

  const occurredAt = timestamp(meta.timestamp);
  const accountId = meta.company_id == null ? null : id(meta.company_id);
  const personId = data.person_id == null ? null : id(data.person_id);
  if (
    !occurredAt ||
    (meta.company_id != null && !accountId) ||
    (data.person_id != null && !personId)
  )
    return null;
  const updateTime =
    data.update_time == null ? null : timestamp(data.update_time);
  if (data.update_time != null && !updateTime) return null;
  let accountSubdomain: string | null = null;
  if (meta.host != null) {
    if (typeof meta.host !== "string") return null;
    const host = /^([a-z0-9-]+)\.pipedrive\.com$/i.exec(meta.host);
    if (!host || ["www", "api", "app"].includes(host[1]!.toLowerCase()))
      return null;
    accountSubdomain = host[1]!.toLowerCase();
  }
  const eventId =
    meta.id == null
      ? null
      : typeof meta.id === "string" &&
          meta.id.length > 0 &&
          meta.id.length <= 255 &&
          !/[\x00-\x20]/.test(meta.id)
        ? meta.id
        : null;
  if (meta.id != null && !eventId) return null;
  const valuePresent = data.value != null;
  const valueCents = valuePresent ? cents(data.value) : null;
  if (valuePresent && valueCents === null) return null;
  let currency: string | null = null;
  if (data.currency != null) {
    if (
      typeof data.currency !== "string" ||
      !/^[A-Za-z]{3}$/.test(data.currency.trim())
    )
      return null;
    currency = data.currency.trim().toUpperCase();
  }
  return {
    kind: "event",
    event: {
      kind,
      accountId,
      accountSubdomain,
      dealId,
      pipelineId,
      stageId,
      oldStageId,
      dealStatus: current,
      previousDealStatus,
      personId,
      eventId,
      occurredAt,
      changedAt: updateTime ?? occurredAt,
      valueCents,
      valuePresent,
      currency,
    },
  };
}

/** null = malformed; [] = valid delivery that never converts. */
export function parsePipedriveStageEvents(
  value: unknown,
): PipedriveStageEvent[] | null {
  const classified = classifyPipedriveDealChange(value);
  if (!classified) return null;
  return classified.kind === "event" ? [classified.event] : [];
}

/**
 * Identity of one deal transition. meta.id / meta.attempt / correlation_id and
 * unrelated custom fields never affect it, so a redelivered or retried webhook
 * maps to the same inbox row whether or not Pipedrive reuses meta.id.
 */
export function pipedriveDeliveryKey(
  connectionId: string,
  event: PipedriveStageEvent,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        connectionId,
        event.accountId,
        event.dealId,
        event.kind,
        event.pipelineId,
        event.stageId,
        event.oldStageId,
        event.dealStatus,
        event.previousDealStatus,
        event.changedAt.toISOString(),
        event.valuePresent ? event.valueCents : "absent",
        event.currency,
      ]),
      "utf8",
    )
    .digest("hex");
}

/** Strict public ingress metadata, including non-stage events. */
export function parsePipedriveWebhookMetadata(value: unknown) {
  if (!safeTree(value)) return null;
  const meta = object(object(value)?.meta);
  if (
    !meta ||
    meta.version !== "2.0" ||
    !["create", "change", "delete"].includes(String(meta.action))
  )
    return null;
  const accountId = id(meta.company_id);
  const occurredAt = timestamp(meta.timestamp);
  const host =
    typeof meta.host === "string"
      ? /^([a-z0-9-]+)\.pipedrive\.com$/i.exec(meta.host)
      : null;
  if (
    !accountId ||
    !occurredAt ||
    !host ||
    ["www", "api", "app"].includes(host[1]!.toLowerCase())
  )
    return null;
  return { accountId, accountSubdomain: host[1]!.toLowerCase(), occurredAt };
}
