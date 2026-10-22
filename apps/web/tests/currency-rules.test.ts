// @vitest-environment jsdom
import { providerConversionRuleIdempotentCreateInputSchema } from "@wpptrack/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MessagePhraseFields } from "../src/app/(app)/conversions/message-phrase-fields";
import { ruleCurrencyHint } from "../src/app/(app)/conversions/new-rule-flow";
import {
  buildRulePayload,
  emptyRuleDraft,
  moneyToCents,
  type RuleDraft,
} from "../src/app/(app)/conversions/rule-draft";
import {
  buildRuleUpdatePayload,
  ruleEditCapabilities,
  ruleEditDraft,
} from "../src/app/(app)/conversions/rule-edit";
import {
  CrmCurrencySelect,
  RuleCurrencySelect,
  WorkspaceCurrencyProvider,
  ruleCurrencyChoice,
  workspaceDefaultCurrencyLabel,
  type RuleCurrencyChoice,
} from "../src/components/workspace-currency";
import { capabilities, connections, numbers, providerRule } from "./conversions-fixtures";

afterEach(cleanup);

const context = { numbers, connections, capabilities };

function draft(
  origin: RuleDraft["origin"],
  patch: Partial<RuleDraft> = {},
): RuleDraft {
  return { ...emptyRuleDraft(origin), name: "Regra de teste", ...patch };
}

function payloadOf(result: ReturnType<typeof buildRulePayload>): Record<string, unknown> {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

describe("rule draft: moeda", () => {
  it("starts on 'Padrão do workspace' (no currency stored in the draft)", () => {
    expect(emptyRuleDraft("message_phrase").currency).toBe("");
  });

  it("leaves the rule without currency when 'Padrão do workspace' is chosen", () => {
    const payload = payloadOf(
      buildRulePayload(
        draft("message_phrase", {
          channelIds: ["ch_01"],
          scope: "specific_numbers",
          eventName: "Purchase",
          primaryPhrase: "pagamento confirmado",
          averageValue: "250,00",
        }),
        context,
      ),
    );

    expect(payload).toMatchObject({ defaultValueCents: 25_000 });
    expect(payload).not.toHaveProperty("defaultCurrency");
  });

  it.each(["BRL", "USD", "EUR"] as const)(
    "sends %s when the rule has a currency of its own",
    (currency) => {
      const payload = payloadOf(
        buildRulePayload(
          draft("message_phrase", {
            channelIds: ["ch_01"],
            scope: "specific_numbers",
            eventName: "Purchase",
            primaryPhrase: "pagamento confirmado",
            averageValue: "99,90",
            currency,
          }),
          context,
        ),
      );

      expect(payload).toMatchObject({
        defaultValueCents: 9_990,
        defaultCurrency: currency,
      });
    },
  );

  it("sends the currency of the rule for Payt (the sale currency wins at delivery)", () => {
    const payload = payloadOf(
      buildRulePayload(
        draft("automation_payt", {
          scope: "all_numbers",
          eventName: "Purchase",
          currency: "USD",
        }),
        { ...context, capabilities: null },
      ),
    );

    expect(payload).toMatchObject({ automationSource: "payt", defaultCurrency: "USD" });
    const inherit = payloadOf(
      buildRulePayload(
        draft("automation_payt", { scope: "all_numbers", eventName: "Purchase" }),
        { ...context, capabilities: null },
      ),
    );
    expect(inherit).not.toHaveProperty("defaultCurrency");
  });

  it("gives the catalog a concrete currency: the rule's, else the workspace's, else BRL", () => {
    const catalog = {
      name: "Camas",
      productName: "Cama elástica",
      attributes: ["Tamanho"],
      variants: [{ values: ["Pequena"], price: "399,00" }],
    };
    const base = draft("structured_catalog", {
      scope: "specific_numbers",
      channelIds: ["ch_01"],
      primaryPhrase: "Resumo do pedido",
      catalog,
    });
    const currencyOf = (input: RuleDraft, workspaceCurrency?: "USD") =>
      (
        payloadOf(
          buildRulePayload(input, { ...context, workspaceCurrency }),
        ).catalog as { currency: string }
      ).currency;

    expect(currencyOf(base)).toBe("BRL");
    expect(currencyOf(base, "USD")).toBe("USD");
    expect(currencyOf({ ...base, currency: "EUR" }, "USD")).toBe("EUR");
  });

  it("builds a payload the shared create contract accepts, with and without currency", () => {
    for (const currency of ["", "USD"] as const) {
      const payload = payloadOf(
        buildRulePayload(
          draft("message_phrase", {
            channelIds: ["ch_01"],
            scope: "specific_numbers",
            eventName: "Purchase",
            primaryPhrase: "pagamento confirmado",
            averageValue: "99,90",
            currency,
          }),
          context,
        ),
      );

      expect(
        providerConversionRuleIdempotentCreateInputSchema.safeParse(payload).success,
      ).toBe(true);
    }
  });

  it("reads US$ and € amounts as well as R$", () => {
    expect(moneyToCents("US$ 250")).toBe(25_000);
    expect(moneyToCents("€ 99,90")).toBe(9_990);
    expect(moneyToCents("R$ 1.397,00")).toBe(139_700);
    expect(moneyToCents("$12.5")).toBe(1_250);
  });
});

describe("rule edit: moeda", () => {
  const valued = (currency: string | null) => {
    const rule = providerRule({
      id: "rule_valued",
      name: "Venda",
      origin: "automation_umbler",
      triggerType: "provider_automation",
      eventName: "Purchase",
      connectionId: "conn_umbler",
      channelIds: ["ch_01"],
      phrases: [],
    });
    return {
      ...rule,
      conversionRule: {
        ...rule.conversionRule,
        defaultValueCents: 9_900,
        defaultCurrency: currency,
      },
    };
  };

  it("offers the currency on valued rules, but not on catalogs or events without value", () => {
    expect(ruleEditCapabilities(valued(null), "automation_umbler").currency).toBe(true);
    expect(ruleEditCapabilities(valued(null), "automation_payt").currency).toBe(true);
    expect(ruleEditCapabilities(valued(null), "structured_catalog").currency).toBe(false);
    expect(
      ruleEditCapabilities(
        providerRule({ id: "r", origin: "message_phrase", eventName: "QualifiedLead" }),
        "message_phrase",
      ).currency,
    ).toBe(false);
  });

  it("shows the stored currency and 'Padrão do workspace' for a rule without one", () => {
    expect(ruleEditDraft(valued("EUR"), "automation_umbler").currency).toBe("EUR");
    expect(ruleEditDraft(valued(null), "automation_umbler").currency).toBe("");
    expect(ruleEditDraft(valued("GBP"), "automation_umbler").currency).toBe("");
  });

  it("sends nothing when the currency was not touched, so a stored one never changes", () => {
    for (const stored of [null, "USD"]) {
      const rule = valued(stored);
      const result = buildRuleUpdatePayload(
        rule,
        { ...ruleEditDraft(rule, "automation_umbler"), name: "Venda (novo)" },
        context,
      );
      expect(result).toEqual({ ok: true, value: { name: "Venda (novo)" } });
    }
  });

  it("sends the new currency, or null to go back to inheriting the workspace's", () => {
    const rule = valued("USD");
    const base = ruleEditDraft(rule, "automation_umbler");

    expect(buildRuleUpdatePayload(rule, { ...base, currency: "EUR" }, context)).toEqual({
      ok: true,
      value: { defaultCurrency: "EUR" },
    });
    expect(buildRuleUpdatePayload(rule, { ...base, currency: "" }, context)).toEqual({
      ok: true,
      value: { defaultCurrency: null },
    });
  });

  it("does not invent BRL when a rule without currency gets a new value", () => {
    const rule = valued(null);
    const result = buildRuleUpdatePayload(
      rule,
      { ...ruleEditDraft(rule, "automation_umbler"), averageValue: "150,00" },
      context,
    );

    expect(result).toEqual({ ok: true, value: { defaultValueCents: 15_000 } });
  });
});

describe("campos de moeda", () => {
  function Controlled({ initial = "" as RuleCurrencyChoice }) {
    const [value, setValue] = useState<RuleCurrencyChoice>(initial);
    return createElement(
      "div",
      null,
      createElement(RuleCurrencySelect, { value, onChange: setValue }),
      createElement("output", { "data-testid": "value" }, value || "(herda)"),
    );
  }

  it("labels the first option with the workspace currency and offers BRL, USD and EUR", () => {
    render(
      createElement(
        WorkspaceCurrencyProvider,
        { currency: "EUR" },
        createElement(Controlled),
      ),
    );

    const select = screen.getByLabelText(/^Moeda/) as HTMLSelectElement;
    expect(
      Array.from(select.options).map((option) => [option.value, option.textContent]),
    ).toEqual([
      ["", "Padrão do workspace (EUR)"],
      ["BRL", "Real (R$)"],
      ["USD", "Dólar americano (US$)"],
      ["EUR", "Euro (€)"],
    ]);
    expect(screen.getByText("Usada quando a venda não informa a moeda.")).toBeTruthy();

    fireEvent.change(select, { target: { value: "USD" } });
    expect(screen.getByTestId("value").textContent).toBe("USD");
    fireEvent.change(select, { target: { value: "" } });
    expect(screen.getByTestId("value").textContent).toBe("(herda)");
  });

  it("falls back to BRL without a provider and ignores unsupported codes", () => {
    render(createElement(Controlled));
    expect(
      (screen.getByLabelText(/^Moeda/) as HTMLSelectElement).options[0]!.textContent,
    ).toBe("Padrão do workspace (BRL)");
    expect(workspaceDefaultCurrencyLabel("USD")).toBe("Padrão do workspace (USD)");
    expect(ruleCurrencyChoice("usd")).toBe("USD");
    expect(ruleCurrencyChoice("GBP")).toBe("");
    expect(ruleCurrencyChoice(null)).toBe("");
  });

  it("explains what the currency means in each origin", () => {
    expect(ruleCurrencyHint("automation_payt")).toContain("A moeda da venda vence");
    expect(ruleCurrencyHint("structured_catalog")).toBe("Moeda dos preços do catálogo.");
    expect(ruleCurrencyHint("message_phrase")).toBe("Moeda do valor enviado à Meta.");
  });

  it("keeps a stored CRM currency outside the list selectable", () => {
    render(
      createElement(CrmCurrencySelect, {
        value: "gbp",
        onChange: () => undefined,
        emptyLabel: "Sem moeda",
      }),
    );

    const select = screen.getByLabelText(/^Moeda/) as HTMLSelectElement;
    expect(select.value).toBe("GBP");
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "",
      "BRL",
      "USD",
      "EUR",
      "GBP",
    ]);
    expect(within(select).getByRole("option", { name: "Sem moeda" })).toBeTruthy();
    // A API recusa salvar um código fora da lista (Fase 5.1).
    expect(
      within(select).getByRole("option", {
        name: "GBP (não aceita mais: escolha BRL, USD ou EUR)",
      }),
    ).toBeTruthy();
  });

  it("previews the fixed value in the currency of the rule, else the workspace's", () => {
    function Preview({ currency }: { currency?: string }) {
      return createElement(
        WorkspaceCurrencyProvider,
        { currency: "USD" },
        createElement(MessagePhraseFields, {
          eventName: "Purchase",
          averageValue: "250,00",
          contentName: "",
          primaryPhrase: "pagamento",
          variationPhrases: "",
          exampleMessage: "",
          valueMode: "fixed",
          messageAuthorScope: "team",
          currency,
          onChange: () => undefined,
        }),
      );
    }

    const { unmount } = render(createElement(Preview));
    expect(screen.getByText("Valor fixo enviado em toda conversão: US$ 250,00")).toBeTruthy();
    unmount();
    render(createElement(Preview, { currency: "EUR" }));
    expect(screen.getByText("Valor fixo enviado em toda conversão: € 250,00")).toBeTruthy();
  });
});
