import { describe, expect, it } from "vitest";
import {
  effectiveInboundParserStatus,
  inboundParserProductionEligible,
} from "../../src/inbound-webhooks/inbound-webhook-parser-eligibility";

describe("Parsers certified by migration (validated in production in the SaaS)", () => {
  it("Data Crazy, Gupshup and Umbler v1 are production-eligible once certified, never while observation-only or retired", () => {
    for (const provider of ["data_crazy", "gupshup", "umbler"]) {
      const release = { provider, version: "v1" };
      expect(inboundParserProductionEligible({ ...release, status: "certified" })).toBe(true);
      expect(inboundParserProductionEligible({ ...release, status: "observation_only" })).toBe(false);
      expect(inboundParserProductionEligible({ ...release, status: "retired" })).toBe(false);
      expect(effectiveInboundParserStatus({ ...release, status: "observation_only" })).toBe(
        "observation_only",
      );
    }
  });

  it("Meta Cloud v1 stays eligible without a row change", () => {
    expect(
      inboundParserProductionEligible({ provider: "meta_cloud", version: "v1", status: "observation_only" }),
    ).toBe(true);
    expect(
      inboundParserProductionEligible({ provider: "meta_cloud", version: "v1", status: "retired" }),
    ).toBe(false);
  });
});
