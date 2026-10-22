import { createHash } from "node:crypto";

/** Versioned identity uses provider merchant and transaction evidence, no PII or endpoint secret. */
export function buildProviderPurchaseIdentity(input: {
  workspaceId: string;
  provider: string;
  accountRef: string;
  orderRef: string;
  eventName: string;
}): string {
  const parts = [
    input.workspaceId,
    input.provider,
    input.accountRef,
    input.orderRef,
    input.eventName,
  ];
  if (
    parts.some(
      (part) =>
        typeof part !== "string" ||
        !part.trim() ||
        part.length > 255 ||
        part.includes("\0"),
    )
  ) {
    throw new Error("provider_purchase_identity_missing");
  }
  return `purchase:${createHash("sha256")
    .update(JSON.stringify(["v1", ...parts]))
    .digest("hex")}`;
}
