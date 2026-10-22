import { createHash } from "node:crypto";

const MIN_PHONE_DIGITS = 10;
const MAX_PHONE_DIGITS = 15;

/** Valid Brazilian area codes (DDD) — used when prefixing default country code. */
const BR_AREA_CODES = new Set([
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
  "18",
  "19",
  "21",
  "22",
  "24",
  "27",
  "28",
  "31",
  "32",
  "33",
  "34",
  "35",
  "37",
  "38",
  "41",
  "42",
  "43",
  "44",
  "45",
  "46",
  "47",
  "48",
  "49",
  "51",
  "53",
  "54",
  "55",
  "61",
  "62",
  "63",
  "64",
  "65",
  "66",
  "67",
  "68",
  "69",
  "71",
  "73",
  "74",
  "75",
  "77",
  "79",
  "81",
  "82",
  "83",
  "84",
  "85",
  "86",
  "87",
  "88",
  "89",
  "91",
  "92",
  "93",
  "94",
  "95",
  "96",
  "97",
  "98",
  "99",
]);

export function normalizePhoneIdentity(phone?: string): string | undefined {
  const digits = phone?.replace(/\D/g, "");

  if (
    !digits ||
    digits.length < MIN_PHONE_DIGITS ||
    digits.length > MAX_PHONE_DIGITS
  ) {
    return undefined;
  }

  return digits;
}

/**
 * Normalize phone with an account-level default country calling code.
 * - If the number already looks international (starts with the default CC, or
 *   is longer than national length), keep digits as-is (within E.164 bounds).
 * - If national BR-shaped (10–11 digits + valid DDD) and default is 55, prefix 55.
 * - Otherwise, if national length is plausible, prefix the configured default.
 */
export function normalizePhoneIdentityWithCountry(
  phone: string | undefined,
  defaultCountryCode = "55",
): string | undefined {
  const digits = phone?.replace(/\D/g, "");
  if (!digits) {
    return undefined;
  }

  const cc = (defaultCountryCode || "55").replace(/\D/g, "") || "55";

  if (digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS) {
    if (digits.startsWith(cc) && digits.length > cc.length + 7) {
      return digits;
    }
    // Already international-ish (e.g. 12–15 digits not needing prefix)
    if (digits.length >= 12) {
      return digits;
    }
  }

  // National BR mobile/landline without country code
  if (
    cc === "55" &&
    (digits.length === 10 || digits.length === 11) &&
    BR_AREA_CODES.has(digits.slice(0, 2))
  ) {
    return `55${digits}`;
  }

  // Generic: national number + configured CC when still within E.164 max
  if (
    digits.length >= 8 &&
    digits.length <= 12 &&
    !digits.startsWith(cc) &&
    digits.length + cc.length <= MAX_PHONE_DIGITS
  ) {
    return `${cc}${digits}`;
  }

  return normalizePhoneIdentity(digits);
}

export function hashPhoneIdentity(phone?: string): string | undefined {
  const normalized = normalizePhoneIdentity(phone);

  return normalized
    ? createHash("sha256").update(normalized).digest("hex")
    : undefined;
}

export function hashNormalizedPhone(normalized?: string): string | undefined {
  if (!normalized) {
    return undefined;
  }
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Brazilian mobile numbers exist with and without the 9th digit (WhatsApp
 * identities of older numbers often omit it). For a normalized 55+DDD number
 * return both forms; any other number is returned as is.
 */
export function brazilNinthDigitVariants(normalized: string): string[] {
  if (!normalized.startsWith("55")) return [normalized];
  const ddd = normalized.slice(2, 4);
  const local = normalized.slice(4);
  // 55 + DDD + 9XXXXXXXX (mobile with the 9th digit) -> also without it.
  if (
    normalized.length === 13 &&
    local.startsWith("9") &&
    /^[6-9]/u.test(local.slice(1))
  )
    return [normalized, `55${ddd}${local.slice(1)}`];
  // 55 + DDD + 8 digits starting 6-9 (mobile without the 9th digit) -> also with it.
  if (normalized.length === 12 && /^[6-9]/u.test(local))
    return [normalized, `55${ddd}9${local}`];
  return [normalized];
}

/**
 * Every digit form under which the same phone line may be written: for a
 * Brazilian number, with/without the 55 country code and with/without the
 * mobile 9th digit. The form as received always comes first; non-Brazilian
 * numbers yield only it.
 */
export function phoneIdentityVariants(phone?: string | null): string[] {
  const received = normalizePhoneIdentity(phone ?? undefined);
  if (!received) return [];

  const international = new Set<string>();
  if (
    (received.length === 12 || received.length === 13) &&
    received.startsWith("55") &&
    BR_AREA_CODES.has(received.slice(2, 4))
  ) {
    international.add(received);
  }
  if (
    (received.length === 10 || received.length === 11) &&
    BR_AREA_CODES.has(received.slice(0, 2))
  ) {
    international.add(`55${received}`);
  }

  const variants = new Set<string>([received]);
  for (const base of international) {
    for (const variant of brazilNinthDigitVariants(base)) {
      variants.add(variant);
      variants.add(variant.slice(2));
    }
  }
  return [...variants];
}

/**
 * Stable comparison key for "is this the same phone line": equivalent forms
 * (see phoneIdentityVariants) share the same key.
 */
export function phoneIdentityKey(phone?: string | null): string | undefined {
  const variants = phoneIdentityVariants(phone);
  return variants.length ? [...variants].sort()[0] : undefined;
}

/** Hashes (Lead.phoneHash format) of every equivalent form of the phones. */
export function hashPhoneIdentityVariants(
  phones: Iterable<string | null | undefined>,
): string[] {
  const hashes = new Set<string>();
  for (const phone of phones) {
    for (const variant of phoneIdentityVariants(phone)) {
      const hash = hashNormalizedPhone(variant);
      if (hash) hashes.add(hash);
    }
  }
  return [...hashes];
}
