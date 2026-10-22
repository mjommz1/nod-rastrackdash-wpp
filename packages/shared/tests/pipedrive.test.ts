import { describe, expect, it } from "vitest";
import {
  conversionEventCatalog,
  conversionEventNameSchema,
  pipedriveConnectionChannelBindingsInputSchema,
  pipedriveConnectionCreateInputSchema,
  pipedriveConnectionCredentialReplaceInputSchema,
  pipedriveConnectionSchema,
  pipedriveConnectionStatusUpdateInputSchema,
  pipedriveConversionRuleCreateInputSchema,
  pipedriveConversionRuleSchema,
  pipedriveConversionRuleUpdateInputSchema,
  pipedrivePipelineSchema,
} from "../src";

const connection = {
  displayName: "Synthetic account",
  accountOrigin: "https://synthetic.pipedrive.com/",
  apiToken: "synthetic-token-only",
};
const rule = {
  name: "Synthetic stage rule",
  pipelineId: "pipeline-synthetic",
  stageId: "stage-synthetic",
  eventName: "QualifiedLead",
};

describe("Pipedrive shared contracts", () => {
  it("accepts only official HTTPS account origins", () => {
    expect(pipedriveConnectionCreateInputSchema.parse(connection)).toEqual({
      ...connection,
      allowedChannelRouteIds: [],
    });
    for (const accountOrigin of [
      "http://synthetic.pipedrive.com/",
      "https://synthetic.pipedrive.com/path",
      "https://user@synthetic.pipedrive.com/",
      "https://user:password@synthetic.pipedrive.com/",
      "https://synthetic.pipedrive.com:8443/",
      "https://synthetic.pipedrive.com/?query=synthetic",
      "https://synthetic.pipedrive.com/#fragment",
      "https://127.0.0.1/",
      "https://pipedrive.com/",
      "https://synthetic.example.com/",
      "https://synthetic.pipedrive.com.example.com/",
      "https://nested.synthetic.pipedrive.com/",
    ]) {
      expect(
        pipedriveConnectionCreateInputSchema.safeParse({
          ...connection,
          accountOrigin,
        }).success,
      ).toBe(false);
      expect(
        pipedriveConnectionCredentialReplaceInputSchema.safeParse({
          accountOrigin,
          apiToken: connection.apiToken,
        }).success,
      ).toBe(false);
    }
  });

  it("validates credentials and explicit unique channel grants", () => {
    expect(
      pipedriveConnectionCredentialReplaceInputSchema.parse({
        apiToken: ` ${connection.apiToken} `,
      }).apiToken,
    ).toBe(connection.apiToken);
    expect(
      pipedriveConnectionCreateInputSchema.safeParse({
        ...connection,
        apiToken: "",
      }).success,
    ).toBe(false);
    expect(
      pipedriveConnectionCreateInputSchema.safeParse({
        ...connection,
        allowedChannelRouteIds: ["route-synthetic", " route-synthetic "],
      }).success,
    ).toBe(false);
    expect(
      pipedriveConnectionChannelBindingsInputSchema.safeParse({
        allowedChannelRouteIds: [],
        workspaceId: "workspace-synthetic",
      }).success,
    ).toBe(false);
    expect(
      pipedriveConnectionChannelBindingsInputSchema.parse({
        allowedChannelRouteIds: ["route-synthetic"],
      }).allowedChannelRouteIds,
    ).toEqual(["route-synthetic"]);
    expect(
      pipedriveConnectionStatusUpdateInputSchema.safeParse({
        status: "blocked",
      }).success,
    ).toBe(false);
  });

  it("represents a pipeline with its stages and exposes credential health", () => {
    expect(
      pipedrivePipelineSchema.parse({
        id: rule.pipelineId,
        name: "Synthetic pipeline",
        sort: 1,
        stages: [{ id: rule.stageId, name: "Synthetic stage", sort: 1 }],
      }).stages[0].id,
    ).toBe(rule.stageId);
    const dto = pipedriveConnectionSchema.parse({
      id: "connection-synthetic",
      workspaceId: "workspace-synthetic",
      displayName: connection.displayName,
      status: "active",
      verifiedAccountId: null,
      accountSubdomain: "synthetic",
      accountOrigin: connection.accountOrigin,
      allowedChannelRouteIds: [],
      credentialHealthy: true,
      catalogState: "empty",
      catalogRefreshedAt: null,
      lastErrorCode: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(dto.credentialHealthy).toBe(true);
    expect(dto).not.toHaveProperty("apiToken");
  });

  it.each(conversionEventNameSchema.options)(
    "supports %s in create, update, and stored stage rules",
    (eventName) => {
      const input = {
        ...rule,
        eventName,
        ...(conversionEventCatalog[eventName].valuePolicy === "required"
          ? { currency: "brl" }
          : {}),
      };
      const created = pipedriveConversionRuleCreateInputSchema.parse(input);
      expect(created.eventName).toBe(eventName);
      expect(created.mode).toBe("observation");
      expect(created.valueMode).toBe("deal");
      expect(created.active).toBe(true);
      expect(
        pipedriveConversionRuleUpdateInputSchema.parse({ eventName }).eventName,
      ).toBe(eventName);
      expect(
        pipedriveConversionRuleSchema.parse({
          ...created,
          id: "rule-synthetic",
          connectionId: "connection-synthetic",
          fixedValueCents: null,
          currency: created.currency ?? null,
          contentName: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }).eventName,
      ).toBe(eventName);
    },
  );

  it.each(conversionEventNameSchema.options)(
    "mirrors Kommo value policy for %s",
    (eventName) => {
      const fixed = {
        ...rule,
        eventName,
        valueMode: "fixed",
        fixedValueCents: 100,
        currency: " brl ",
      };
      const result = pipedriveConversionRuleCreateInputSchema.safeParse(fixed);
      expect(result.success).toBe(
        conversionEventCatalog[eventName].valuePolicy !== "none",
      );
      if (result.success) expect(result.data.currency).toBe("BRL");
      expect(
        pipedriveConversionRuleCreateInputSchema.safeParse({
          ...rule,
          eventName,
        }).success,
      ).toBe(conversionEventCatalog[eventName].valuePolicy !== "required");
    },
  );

  it("requires positive integer fixed values and a three-letter currency", () => {
    const fixed = {
      ...rule,
      eventName: "Purchase",
      valueMode: "fixed",
      fixedValueCents: 100,
      currency: "BRL",
    };
    for (const fixedValueCents of [undefined, null, 0, -1, 1.5]) {
      expect(
        pipedriveConversionRuleCreateInputSchema.safeParse({
          ...fixed,
          fixedValueCents,
        }).success,
      ).toBe(false);
    }
    for (const currency of [undefined, null, "", "BR", "123", "BRLL"]) {
      expect(
        pipedriveConversionRuleCreateInputSchema.safeParse({
          ...fixed,
          currency,
        }).success,
      ).toBe(false);
    }
  });

  it("allows strict nonempty partial updates with explicit null clearing", () => {
    expect(
      pipedriveConversionRuleUpdateInputSchema.parse({
        currency: null,
        fixedValueCents: null,
        contentName: null,
      }),
    ).toEqual({ currency: null, fixedValueCents: null, contentName: null });
    expect(pipedriveConversionRuleUpdateInputSchema.safeParse({}).success).toBe(
      false,
    );
    expect(
      pipedriveConversionRuleUpdateInputSchema.safeParse({
        eventName: "QualifiedLead",
        valueCents: 100,
      }).success,
    ).toBe(false);
  });

  it("accepts explicit production mode without auto-activating the default", () => {
    expect(
      pipedriveConversionRuleCreateInputSchema.parse({
        ...rule,
        mode: "production",
      }).mode,
    ).toBe("production");
    expect(pipedriveConversionRuleCreateInputSchema.parse(rule).mode).toBe(
      "observation",
    );
    expect(
      pipedriveConversionRuleUpdateInputSchema.parse({ mode: "production" }),
    ).toEqual({ mode: "production" });
  });
  it("defaults to stage change rules and requires their stage", () => {
    expect(pipedriveConversionRuleCreateInputSchema.parse(rule).trigger).toBe(
      "stage_change",
    );
    const { stageId: _omitted, ...withoutStage } = rule;
    expect(
      pipedriveConversionRuleCreateInputSchema.safeParse(withoutStage).success,
    ).toBe(false);
  });

  it("accepts a won-deal Purchase rule with the deal currency and no stage", () => {
    const won = {
      name: "Synthetic won rule",
      trigger: "deal_won",
      pipelineId: "pipeline-synthetic",
      eventName: "Purchase",
    };
    const parsed = pipedriveConversionRuleCreateInputSchema.parse(won);
    expect(parsed).toMatchObject({
      trigger: "deal_won",
      valueMode: "deal",
      mode: "observation",
    });
    expect(parsed.currency).toBeUndefined();
    for (const invalid of [
      { ...won, stageId: "stage-synthetic" },
      { ...won, eventName: "QualifiedLead" },
      { ...won, trigger: "deal_lost" },
    ])
      expect(
        pipedriveConversionRuleCreateInputSchema.safeParse(invalid).success,
      ).toBe(false);
  });

  it("rejects unsupported modes, unknown events, and attribution input", () => {
    for (const extra of [
      { mode: "sending" },
      { eventName: "Contact" },
      { valueMode: "lead_price" },
      { ctwaClid: "synthetic-attribution" },
      { leadId: "lead-synthetic" },
      { statusId: "status-synthetic" },
    ]) {
      expect(
        pipedriveConversionRuleCreateInputSchema.safeParse({
          ...rule,
          ...extra,
        }).success,
      ).toBe(false);
      expect(
        pipedriveConversionRuleUpdateInputSchema.safeParse(extra).success,
      ).toBe(false);
    }
  });
});
