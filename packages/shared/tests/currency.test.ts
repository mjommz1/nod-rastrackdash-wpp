import { describe, expect, it } from "vitest";
import {
  adAccountCurrencyListSchema,
  adAccountCurrencyOverrideInputSchema,
  currencyCodeSchema,
  effectiveAccountCurrency,
  formatMoney,
  normalizeCurrencyCode,
  resolveConversionCurrency,
  supportedCurrencyOptions,
  workspaceCurrencySettingsSchema,
  workspaceCurrencyUpdateInputSchema,
  RULE_CURRENCY_INVALID_MESSAGE,
  conversionRuleCreateInputSchema,
  conversionRuleSchema,
  conversionRuleUpdateInputSchema,
  hasRuleCurrencyIssue,
  kommoConversionRuleCreateInputSchema,
  pipedriveConversionRuleCreateInputSchema,
  providerConversionRuleCreateInputSchema,
  providerConversionRuleUpdateInputSchema,
  ruleCurrencyInputSchema,
} from "../src";

describe("currency contracts (Fase 5.1)", () => {
  it("accepts only BRL, USD and EUR", () => {
    expect(currencyCodeSchema.parse("USD")).toBe("USD");
    expect(currencyCodeSchema.safeParse("GBP").success).toBe(false);
    expect(currencyCodeSchema.safeParse("usd").success).toBe(false);
    expect(normalizeCurrencyCode(" usd ")).toBe("USD");
    expect(normalizeCurrencyCode("GBP")).toBeNull();
    expect(normalizeCurrencyCode(null)).toBeNull();
  });

  it("formats money per currency in pt-BR", () => {
    expect(formatMoney(123456, "BRL")).toBe("R$ 1.234,56");
    expect(formatMoney(123456, "USD")).toBe("US$ 1.234,56");
    expect(formatMoney(123456, "EUR")).toBe("€ 1.234,56");
    expect(formatMoney(5, "BRL")).toBe("R$ 0,05");
    expect(formatMoney(-150, "USD")).toBe("-US$ 1,50");
    expect(formatMoney(123456789, "BRL")).toBe("R$ 1.234.567,89");
    expect(formatMoney(null, "BRL")).toBe("-");
    expect(formatMoney(100)).toBe("R$ 1,00");
  });

  it("resolves the account currency: override, then Meta, then BRL", () => {
    expect(effectiveAccountCurrency({ currency: "USD" })).toBe("USD");
    expect(
      effectiveAccountCurrency({ currency: "USD", currencyOverride: "EUR" }),
    ).toBe("EUR");
    expect(effectiveAccountCurrency({ currency: "GBP" })).toBe("BRL");
    expect(effectiveAccountCurrency({})).toBe("BRL");
  });

  it("resolves the conversion currency: sale, rule, workspace, BRL", () => {
    expect(
      resolveConversionCurrency({ payload: "eur", rule: "USD", workspace: "BRL" }),
    ).toBe("EUR");
    expect(
      resolveConversionCurrency({ payload: null, rule: "USD", workspace: "EUR" }),
    ).toBe("USD");
    expect(resolveConversionCurrency({ rule: null, workspace: "EUR" })).toBe(
      "EUR",
    );
    expect(resolveConversionCurrency({ payload: "GBP" })).toBe("BRL");
    expect(resolveConversionCurrency({})).toBe("BRL");
  });

  it("validates the settings inputs and outputs", () => {
    expect(
      workspaceCurrencyUpdateInputSchema.parse({ conversionCurrency: "USD" }),
    ).toEqual({ conversionCurrency: "USD" });
    expect(
      workspaceCurrencyUpdateInputSchema.safeParse({ conversionCurrency: "ARS" })
        .success,
    ).toBe(false);
    expect(
      workspaceCurrencyUpdateInputSchema.safeParse({
        conversionCurrency: "USD",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      adAccountCurrencyOverrideInputSchema.parse({ currencyOverride: null }),
    ).toEqual({ currencyOverride: null });
    expect(
      workspaceCurrencySettingsSchema.safeParse({
        workspaceId: "w",
        conversionCurrency: "BRL",
        supportedCurrencies: ["BRL", "USD", "EUR"],
        canManage: false,
      }).success,
    ).toBe(true);
    expect(
      adAccountCurrencyListSchema.safeParse({
        accounts: [
          {
            id: "rep_1",
            adAccountId: "act_1",
            adAccountName: "Conta",
            businessId: "bm_1",
            businessName: "BM",
            active: true,
            detectedCurrency: "GBP",
            detectedCurrencySupported: false,
            currencyOverride: null,
            effectiveCurrency: "BRL",
          },
        ],
        currencies: ["BRL"],
        canManage: true,
      }).success,
    ).toBe(true);
    expect(supportedCurrencyOptions.map((option) => option.code)).toEqual([
      "BRL",
      "USD",
      "EUR",
    ]);
  });
});

describe("rule currency on write (Fase 5.1: only BRL, USD or EUR)", () => {
  const providerRule = {
    name: "Conversoes Umbler",
    connectionId: "connection_1",
    channelIds: ["channel_1"],
    triggerType: "provider_automation" as const,
    eventName: "Purchase" as const,
    defaultValueCents: 9900,
  };

  it("accepts BRL/USD/EUR in any case and null (= workspace)", () => {
    expect(ruleCurrencyInputSchema.parse(" usd ")).toBe("USD");
    expect(
      providerConversionRuleCreateInputSchema.parse({
        ...providerRule,
        defaultCurrency: "eur",
      }).defaultCurrency,
    ).toBe("EUR");
    expect(
      providerConversionRuleCreateInputSchema.parse({
        ...providerRule,
        defaultCurrency: null,
      }).defaultCurrency,
    ).toBeNull();
  });

  it("refuses other codes with a clear message on every rule contract", () => {
    const results = [
      providerConversionRuleCreateInputSchema.safeParse({
        ...providerRule,
        defaultCurrency: "GBP",
      }),
      providerConversionRuleUpdateInputSchema.safeParse({ defaultCurrency: "GBP" }),
      conversionRuleCreateInputSchema.safeParse({
        name: "Compra",
        triggerType: "keyword",
        triggerValue: "paguei",
        eventName: "Purchase",
        defaultValueCents: 100,
        defaultCurrency: "GBP",
      }),
      conversionRuleUpdateInputSchema.safeParse({ defaultCurrency: "ARS" }),
      kommoConversionRuleCreateInputSchema.safeParse({
        name: "Compra",
        pipelineId: "p",
        statusId: "142",
        eventName: "Purchase",
        valueMode: "fixed",
        fixedValueCents: 100,
        currency: "GBP",
      }),
      pipedriveConversionRuleCreateInputSchema.safeParse({
        name: "Compra",
        trigger: "stage_change",
        pipelineId: "1",
        stageId: "10",
        eventName: "Purchase",
        currency: "GBP",
      }),
    ];
    for (const result of results) {
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(hasRuleCurrencyIssue(result.error)).toBe(true);
        expect(JSON.stringify(result.error.issues)).toContain(
          RULE_CURRENCY_INVALID_MESSAGE,
        );
      }
    }
    expect(RULE_CURRENCY_INVALID_MESSAGE).toBe(
      "Moeda inválida: use BRL, USD ou EUR",
    );
  });

  it("keeps reading stored rules with other codes (output contracts unchanged)", () => {
    expect(
      conversionRuleSchema.safeParse({
        id: "r",
        workspaceId: "w",
        name: "Compra",
        triggerType: "keyword",
        triggerValue: "paguei",
        matchMode: "contains",
        eventName: "Purchase",
        pixelId: null,
        defaultValueCents: 100,
        defaultCurrency: "GBP",
        active: true,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }).success,
    ).toBe(true);
  });
});
