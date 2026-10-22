import { describe, expect, it } from "vitest";
import {
  mergeTriggerPhrases,
  parseMoneyToCents,
  previewMessagePhrase,
} from "../src/app/(app)/conversions/message-phrase-fields";
import {
  buildUmblerAutomationPayloadExample,
  umblerAutomationKeyForEvent,
} from "../src/app/(app)/conversions/umbler-automation-payload";

describe("message phrase preview", () => {
  it("matches the normalized phrase and uses the fixed value", () => {
    expect(
      previewMessagePhrase({
        triggerPhrases: mergeTriggerPhrases("Vou te passar os valores", "segue o orçamento"),
        exampleMessage: "Perfeito! VOU TE PASSAR OS VALORES agora.",
        valueMode: "fixed",
        averageValue: "250,00",
      }),
    ).toEqual({
      matchedPhrase: "Vou te passar os valores",
      valueCents: 25_000,
      valueSource: "fixed",
      ambiguousValue: false,
    });
  });

  it("extracts a single value from the message and refuses two different ones", () => {
    const base = {
      triggerPhrases: "pagamento confirmado",
      valueMode: "message_extracted" as const,
      averageValue: "",
    };

    expect(
      previewMessagePhrase({
        ...base,
        exampleMessage: "Pagamento confirmado no valor de R$ 1.397,00",
      }),
    ).toMatchObject({ valueCents: 139_700, valueSource: "message" });
    expect(
      previewMessagePhrase({
        ...base,
        exampleMessage: "Pagamento confirmado: R$ 100,00 e R$ 200,00",
      }),
    ).toMatchObject({ ambiguousValue: true, valueCents: null });
    expect(
      previewMessagePhrase({
        ...base,
        averageValue: "99,90",
        exampleMessage: "Pagamento confirmado",
      }),
    ).toMatchObject({ valueCents: 9_990, valueSource: "fallback" });
  });

  it("parses money in Brazilian and plain formats", () => {
    expect(parseMoneyToCents("1.397,00")).toBe(139_700);
    expect(parseMoneyToCents("R$ 250")).toBe(25_000);
    expect(parseMoneyToCents("250.5")).toBe(25_050);
    expect(parseMoneyToCents("0")).toBeNull();
    expect(parseMoneyToCents("abc")).toBeNull();
  });
});

describe("Umbler automation body", () => {
  it("only knows the two events the callback parser accepts", () => {
    expect(umblerAutomationKeyForEvent("QualifiedLead")).toBe("lead_qualificado");
    expect(umblerAutomationKeyForEvent("Purchase")).toBe("compra_aprovada");
    expect(umblerAutomationKeyForEvent("ViewContent")).toBeNull();
    expect(buildUmblerAutomationPayloadExample("compra_aprovada")).toMatchObject({
      schema: "wpptrack.umbler.automation.v1",
      automation: "compra_aprovada",
    });
  });
});
