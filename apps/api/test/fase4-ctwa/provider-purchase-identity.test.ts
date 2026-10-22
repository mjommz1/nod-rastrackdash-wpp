import { describe, expect, it } from "vitest";
import { buildProviderPurchaseIdentity } from "../../src/conversion-rules/provider-purchase-identity";

describe("provider purchase identity", () => {
  const sale = {
    workspaceId: "w1",
    provider: "payt",
    accountRef: "seller1",
    orderRef: "order1",
    eventName: "Purchase",
  };
  it("ignores endpoint, channel, phone and delivery time; preserves distinct orders and namespaces", () => {
    const key = buildProviderPurchaseIdentity(sale);
    expect(key).toMatch(/^purchase:[a-f0-9]{64}$/);
    expect(buildProviderPurchaseIdentity({ ...sale })).toBe(key);
    for (const change of [
      { workspaceId: "w2" },
      { provider: "other" },
      { accountRef: "seller2" },
      { orderRef: "order2" },
      { eventName: "Other" },
    ]) {
      expect(buildProviderPurchaseIdentity({ ...sale, ...change })).not.toBe(
        key,
      );
    }
    expect(key).not.toContain("seller1");
    expect(key).not.toContain("order1");
  });
  it("fails closed for missing or malformed identity instead of inventing a key", () => {
    for (const change of [
      { accountRef: "" },
      { orderRef: "" },
      { orderRef: "a\0b" },
      { accountRef: "a".repeat(256) },
    ]) {
      expect(() =>
        buildProviderPurchaseIdentity({ ...sale, ...change }),
      ).toThrow();
    }
  });
});
