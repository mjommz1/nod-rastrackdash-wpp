import {
  brazilNinthDigitVariants,
  hashNormalizedPhone,
  hashPhoneIdentityVariants,
  normalizePhoneIdentityWithCountry,
} from "../common/phone/phone-identity";

export { brazilNinthDigitVariants };

/**
 * Every phone of the CRM person (mobile, landline, ...) normalized with the
 * Brazilian default country code plus its 9th-digit variants, hashed like the
 * WhatsApp lead identity, together with the shared lead-identity variants
 * (as received, with/without 55, with/without the 9th digit). The caller
 * decides by DISTINCT matching leads: a person with a mobile and a landline
 * where only one matches a lead is a match.
 */
export function pipedrivePersonPhoneHashes(
  phones: readonly string[],
): string[] {
  const hashes = new Set<string>();
  for (const phone of phones) {
    const normalized = normalizePhoneIdentityWithCountry(phone, "55");
    if (!normalized) continue;
    for (const variant of brazilNinthDigitVariants(normalized)) {
      const hash = hashNormalizedPhone(variant);
      if (hash) hashes.add(hash);
    }
  }
  for (const hash of hashPhoneIdentityVariants(phones)) hashes.add(hash);
  return [...hashes];
}
