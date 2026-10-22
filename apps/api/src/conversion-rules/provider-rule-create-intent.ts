import { createHash } from "node:crypto";
import type { ProviderConversionRuleCreateInputDto } from "@wpptrack/shared";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined && item !== null)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

/**
 * Hash of the strictly validated, normalized rule intent (never credentials).
 * "specific_numbers" is the default scope: an explicit value hashes exactly
 * like an omitted one.
 */
export function providerRuleCreateIntentHash(
  workspaceId: string,
  input: ProviderConversionRuleCreateInputDto,
): string {
  const { scope, ...intent } = input;
  return createHash("sha256")
    .update(
      JSON.stringify([
        "provider-rule-create-v1",
        workspaceId,
        canonicalValue({
          ...intent,
          ...(scope === "all_numbers" ? { scope } : {}),
          channelIds: [...input.channelIds].sort(),
        }),
      ]),
    )
    .digest("hex");
}

/** Separate namespace; no user/connection input can change the lock key. */
export function providerRuleCreateLockId(
  workspaceId: string,
  requestKey: string,
): bigint {
  const digest = createHash("sha256")
    .update(
      JSON.stringify(["provider-rule-create-lock-v1", workspaceId, requestKey]),
    )
    .digest("hex");
  return BigInt.asIntN(64, BigInt(`0x${digest.slice(0, 16)}`));
}
