import { describe, expect, it } from "vitest";
import {
  campaignReportRowSchema,
  reportSortDirectionSchema,
  reportSortKeySchema,
  reportSortSchema,
} from "../src";

describe("report sort contract", () => {
  it("allowlists only existing canonical numeric row metrics", () => {
    expect(reportSortKeySchema.options).toEqual([
      "realConversations",
      "qualifiedLead",
      "purchases",
      "costPerRealConversationCents",
      "costPerQualifiedLeadCents",
      "costPerPurchaseCents",
    ]);

    for (const key of reportSortKeySchema.options) {
      expect(campaignReportRowSchema.shape).toHaveProperty(key);
    }
  });

  it("rejects keys outside the allowlist", () => {
    for (const key of ["name", "spendCents", "Purchases", "", "__proto__"]) {
      expect(reportSortKeySchema.safeParse(key).success).toBe(false);
    }
  });

  it("accepts only lower-case asc and desc directions", () => {
    expect(reportSortDirectionSchema.options).toEqual(["desc", "asc"]);
    expect(reportSortDirectionSchema.safeParse("DESC").success).toBe(false);
  });

  it("defaults the direction to desc", () => {
    expect(reportSortSchema.parse({ key: "purchases" })).toEqual({
      key: "purchases",
      direction: "desc",
    });
    expect(
      reportSortSchema.safeParse({ key: "purchases", extra: true }).success,
    ).toBe(false);
  });
});
