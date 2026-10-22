import {
  conversionEventCatalogOrdered,
  conversionEventValuePolicy,
} from "@wpptrack/shared";
import { describe, expect, it } from "vitest";

const expectedPolicies: Record<string, "required" | "optional" | "none"> = {
  InitiateCheckout: "required",
  Purchase: "required",
  ViewContent: "optional",
  AddToCart: "optional",
  CartAbandoned: "optional",
  OrderCreated: "optional",
  LeadSubmitted: "none",
  QualifiedLead: "none",
  OrderShipped: "none",
  OrderDelivered: "none",
  OrderCanceled: "none",
  OrderReturned: "none",
  RatingProvided: "none",
  ReviewProvided: "none",
};

describe("conversion event catalog — value policies", () => {
  it("covers exactly the 14 catalog events with the approved value policies", () => {
    const names = conversionEventCatalogOrdered.map((item) => item.eventName);

    expect(names.sort()).toEqual(Object.keys(expectedPolicies).sort());
    for (const [eventName, policy] of Object.entries(expectedPolicies)) {
      expect(conversionEventValuePolicy(eventName as never)).toBe(policy);
    }
  });
});
