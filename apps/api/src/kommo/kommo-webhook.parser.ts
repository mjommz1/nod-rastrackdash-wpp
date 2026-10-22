import { createHash } from "node:crypto";

export type KommoStageEvent = {
  accountId: string;
  accountSubdomain: string | null;
  dealId: string;
  pipelineId: string;
  statusId: string;
  oldStatusId: string | null;
  occurredAt: Date;
  priceCents: number | null;
  pricePresent: boolean;
};

const MAX_EVENTS = 100;
const MAX_FORM_BYTES = 256 * 1024;
const MAX_FORM_PARAMETERS = 1_000;
const MAX_DEPTH = 8;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function scalar(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim() || null
    : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOnlySafeOwnKeys(
  value: unknown,
  depth = 0,
  budget = { items: 0 },
): boolean {
  budget.items += 1;
  if (depth > MAX_DEPTH || budget.items > 5_000) return false;
  if (Array.isArray(value))
    return (
      value.length <= 1_000 &&
      value.every((item) => hasOnlySafeOwnKeys(item, depth + 1, budget))
    );
  const record = object(value);
  if (!record) return true;
  if (![null, Object.prototype].includes(Object.getPrototypeOf(record)))
    return false;
  return Object.keys(record).every(
    (key) =>
      !FORBIDDEN_KEYS.has(key) &&
      hasOnlySafeOwnKeys(record[key], depth + 1, budget),
  );
}

/** The same raw middleware serves form and JSON. Reject unsupported media types. */
export function decodeKommoBody(
  raw: unknown,
  contentType: unknown,
): unknown | null {
  if (
    !Buffer.isBuffer(raw) ||
    raw.byteLength > MAX_FORM_BYTES ||
    typeof contentType !== "string"
  )
    return null;
  const [media, ...parameters] = contentType
    .toLowerCase()
    .split(";")
    .map((part) => part.trim());
  if (parameters.some((part) => !/^charset=(?:utf-8|"utf-8")$/.test(part)))
    return null;
  if (media === "application/x-www-form-urlencoded")
    return parseKommoFormBody(raw);
  if (media !== "application/json") return null;
  const text = raw.toString("utf8");
  // Bound nesting and items before allocating the parsed tree. Ignore brackets
  // in strings, and validate decoded JSON keys (including unicode escapes).
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
      if (/^\s*:/.test(text.slice(index + 1))) {
        try {
          if (FORBIDDEN_KEYS.has(JSON.parse(text.slice(start, index + 1))))
            return null;
        } catch {
          return null;
        }
      }
    } else if (char === "{" || char === "[") {
      depth += 1;
      if (depth > MAX_DEPTH + 1) return null;
    } else if (char === "}" || char === "]") depth -= 1;
    if (char === "," || char === ":" || char === "[") items += 1;
    if (items > 5_000 || depth < 0) return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return hasOnlySafeOwnKeys(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Parses decoded form brackets and the supported equivalent object shape. */
export function parseKommoStageEvents(
  value: unknown,
): KommoStageEvent[] | null {
  // Parsing can happen before authentication. Never follow attacker-provided
  // prototypes, including ones nested in unused custom fields.
  if (!hasOnlySafeOwnKeys(value)) return null;

  const root = object(value);
  const account = object(root?.account);
  const leads = object(root?.leads);
  const statuses =
    object(leads?.status) ??
    (Array.isArray(leads?.status) ? leads.status : null);
  const accountId = scalar(account?.id);
  if (!accountId || !statuses) return null;

  const accountSubdomain = scalar(account?.subdomain);
  const events: KommoStageEvent[] = [];
  for (const entry of Object.values(statuses)) {
    const item = object(entry);
    if (!item) return null;
    const dealId = scalar(item.id);
    const pipelineId = scalar(item.pipeline_id);
    const statusId = scalar(item.status_id);
    if (!dealId || !pipelineId || !statusId) return null;

    const occurredAt = parseUnixTime(item.updated_at ?? item.last_modified);
    if (!occurredAt) return null;
    const price = parsePrice(item.price_with_minor_units, item.price);
    if (!price.valid) return null;

    events.push({
      accountId,
      accountSubdomain,
      dealId,
      pipelineId,
      statusId,
      oldStatusId: scalar(item.old_status_id),
      occurredAt,
      priceCents: price.cents,
      pricePresent: price.present,
    });
    if (events.length > MAX_EVENTS) return null;
  }
  return events.length > 0 ? events : null;
}

function parseUnixTime(value: unknown): Date | null {
  const input = scalar(value);
  if (!input || !/^\d{1,12}$/.test(input)) return null;
  const date = new Date(Number(input) * 1_000);
  return Number.isFinite(date.getTime()) ? date : null;
}

function parsePrice(
  minor: unknown,
  major: unknown,
): { valid: boolean; present: boolean; cents: number | null } {
  const minorValue = scalar(minor);
  const majorValue = scalar(major);
  if (minorValue !== null) {
    if (!/^-?\d+$/.test(minorValue)) {
      return { valid: false, present: true, cents: null };
    }
    const cents = Number(minorValue);
    return Number.isSafeInteger(cents)
      ? { valid: true, present: true, cents }
      : { valid: false, present: true, cents: null };
  }
  if (majorValue === null) return { valid: true, present: false, cents: null };
  if (!/^-?\d+(?:[.,]\d{1,2})?$/.test(majorValue)) {
    return { valid: false, present: true, cents: null };
  }
  const cents = Math.round(Number(majorValue.replace(",", ".")) * 100);
  return Number.isSafeInteger(cents)
    ? { valid: true, present: true, cents }
    : { valid: false, present: true, cents: null };
}

export function kommoDeliveryKey(
  connectionId: string,
  event: KommoStageEvent,
): string {
  return createHash("sha256")
    .update(
      [
        connectionId,
        event.accountId,
        event.dealId,
        event.pipelineId,
        event.statusId,
        event.oldStatusId ?? "",
        event.occurredAt.toISOString(),
        event.pricePresent ? String(event.priceCents) : "absent",
      ].join("\0"),
      "utf8",
    )
    .digest("hex");
}

/**
 * Bounded urlencoded bracket decoder. Every container has a null prototype
 * and every path segment is an own property, so it is safe before auth.
 */
export function parseKommoFormBody(raw: Buffer): unknown | null {
  if (raw.byteLength > MAX_FORM_BYTES) return null;

  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  const params = new URLSearchParams(raw.toString("utf8"));
  let count = 0;

  for (const [key, value] of params) {
    count += 1;
    if (count > MAX_FORM_PARAMETERS || value.length > 8_192) return null;
    const parts = parseBracketPath(key);
    if (!parts) return null;

    let target = result;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(target, part)) target[part] = Object.create(null);
      const next = object(target[part]);
      if (!next) return null;
      target = next;
    }

    const leaf = parts.at(-1)!;
    if (Object.hasOwn(target, leaf)) return null;
    target[leaf] = value;
  }
  return result;
}

function parseBracketPath(key: string): string[] | null {
  if (!key || key.length > 1_024) return null;
  const parts: string[] = [];
  const base = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(key);
  if (!base) return null;
  parts.push(base[1]!);
  let offset = base[0].length;
  while (offset < key.length) {
    const bracket = /^\[([A-Za-z0-9_]+)\]/.exec(key.slice(offset));
    if (!bracket) return null;
    parts.push(bracket[1]!);
    offset += bracket[0].length;
  }
  if (
    parts.length > MAX_DEPTH ||
    parts.some((part) => part.length > 128 || FORBIDDEN_KEYS.has(part))
  ) {
    return null;
  }
  return parts;
}
