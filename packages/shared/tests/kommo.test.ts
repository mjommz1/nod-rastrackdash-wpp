import { describe, expect, it } from "vitest";
import {
  kommoConnectionCreateInputSchema,
  kommoConversionRuleCreateInputSchema,
} from "../src/schemas/kommo";

describe("Kommo shared contracts", () => {
  it("permits only an official HTTPS account origin", () => {
    const valid = {
      displayName: "Conta",
      accountOrigin: "https://clinic.kommo.com/",
      accessToken: "a".repeat(16),
    };
    expect(kommoConnectionCreateInputSchema.safeParse(valid).success).toBe(
      true,
    );
    for (const accountOrigin of [
      "http://clinic.kommo.com/",
      "https://clinic.kommo.com/path",
      "https://user@clinic.kommo.com/",
      "https://127.0.0.1/",
      "https://clinic.example.com/",
    ]) {
      expect(
        kommoConnectionCreateInputSchema.safeParse({ ...valid, accountOrigin })
          .success,
      ).toBe(false);
    }
  });

  it("requires a currency for every fixed monetary value", () => {
    expect(
      kommoConversionRuleCreateInputSchema.safeParse({
        name: "Compra",
        pipelineId: "p",
        statusId: "142",
        eventName: "Purchase",
        valueMode: "fixed",
        fixedValueCents: 100,
      }).success,
    ).toBe(false);
    expect(
      kommoConversionRuleCreateInputSchema.safeParse({
        name: "Compra",
        pipelineId: "p",
        statusId: "142",
        eventName: "Purchase",
        valueMode: "fixed",
        fixedValueCents: 100,
        currency: "brl",
      }).success,
    ).toBe(true);
  });
});

import {
  kommoConnectionChannelBindingsInputSchema,
  kommoConversionRuleUpdateInputSchema,
} from "../src/schemas/kommo";
it("defaults to no channel grants and rejects duplicate/extra binding fields", () => {
  const connection = kommoConnectionCreateInputSchema.parse({
    displayName: "Synthetic",
    accountOrigin: "https://synthetic.kommo.com/",
    accessToken: "synthetic-token-only",
  });
  expect(connection.allowedChannelRouteIds).toEqual([]);
  expect(
    kommoConnectionChannelBindingsInputSchema.safeParse({
      allowedChannelRouteIds: ["route", "route"],
    }).success,
  ).toBe(false);
  expect(
    kommoConnectionChannelBindingsInputSchema.safeParse({
      allowedChannelRouteIds: [],
      workspaceId: "other",
    }).success,
  ).toBe(false);
});
it("permits explicit null clearing in a strict PATCH while requiring monetary currency", () => {
  expect(
    kommoConversionRuleUpdateInputSchema.safeParse({
      currency: null,
      fixedValueCents: null,
      contentName: null,
    }).success,
  ).toBe(true);
  expect(
    kommoConversionRuleUpdateInputSchema.safeParse({
      eventName: "QualifiedLead",
      valueCents: 100,
    }).success,
  ).toBe(false);
  expect(
    kommoConversionRuleCreateInputSchema.safeParse({
      name: "Purchase",
      pipelineId: "p",
      statusId: "142",
      eventName: "Purchase",
      currency: null,
    }).success,
  ).toBe(false);
});
