import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePaytAutomationV1,
  parsePaytSaleEventV1,
  paytSaleEventNameOf,
} from "../../src/inbound-webhooks/providers/payt/payt-automation-v1.parser";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(__dirname, "fixtures", name), "utf8"),
  ) as Record<string, unknown>;
}

const paid = fixture("order-paid.sanitized.json");
const waiting = fixture("order-nonpaid.sanitized.json");

describe("Payt sale event v1 parser (Fase 4a: event from the payload)", () => {
  it("maps a paid order to Purchase with product and offer codes", () => {
    const parsed = parsePaytSaleEventV1(paid);
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        eventName: "Purchase",
        automation: "purchase_paid",
        providerStatus: "paid",
        orderRef: "PAYTS2",
        accountRef: "455QA2",
        valueCents: 233331,
        product: { code: "4O9J39", name: "Produto Agrupado" },
        // link https://payt.site/YoMCA71 -> offer code of the checkout link
        offer: { code: "YOMCA71", name: "Checkout teste" },
      },
    });
    if (!parsed.ok) throw new Error("expected ok");
    // Main product, the grouped items and the offer; never order bumps.
    expect(parsed.value.productCodes).toEqual([
      "4O9J39",
      "R28BKV",
      "45PK73",
      "YOMCA71",
    ]);
    expect(parsed.value.productCodes).not.toContain("R6DAPD");
  });

  it("maps waiting_payment to InitiateCheckout with the transaction value", () => {
    expect(parsePaytSaleEventV1(waiting)).toMatchObject({
      ok: true,
      value: {
        eventName: "InitiateCheckout",
        automation: "checkout_waiting_payment",
        providerStatus: "waiting_payment",
        orderRef: "PAYTS2",
        valueCents: 233331,
        currency: null,
      },
    });
  });

  it("maps an abandoned cart (type or status lost_cart) to CartAbandoned keyed by the cart", () => {
    const { transaction_id: _transaction, transaction: _tx, ...cart } = paid;
    for (const variant of [
      { ...cart, type: "lost_cart", status: "lost_cart" },
      { ...cart, type: "order", status: "abandoned_cart" },
      { ...cart, type: "order", status: "cart_abandoned" },
    ]) {
      const parsed = parsePaytSaleEventV1(variant);
      expect(parsed).toMatchObject({
        ok: true,
        value: {
          eventName: "CartAbandoned",
          automation: "cart_abandoned",
          orderRef: "26DM9XD",
          // No transaction: the product price x quantity is the cart value.
          valueCents: 133299,
        },
      });
    }
  });

  it("lets status=paid win over any abandoned-cart marker in the type", () => {
    expect(
      parsePaytSaleEventV1({ ...paid, type: "lost_cart", status: "paid" }),
    ).toMatchObject({ ok: true, value: { eventName: "Purchase" } });
    expect(
      parsePaytSaleEventV1({ ...waiting, type: "lost_cart" }),
    ).toMatchObject({ ok: true, value: { eventName: "InitiateCheckout" } });
    expect(paytSaleEventNameOf({ ...paid, type: "lost_cart" })).toBe("Purchase");
    expect(paytSaleEventNameOf({ status: "lost_cart" })).toBe("CartAbandoned");
    expect(paytSaleEventNameOf("garbage")).toBeNull();
  });

  it("keeps an abandoned cart without any price valid (value is optional)", () => {
    const { transaction_id: _t, transaction: _tx, product, ...cart } = paid;
    const parsed = parsePaytSaleEventV1({
      ...cart,
      product: { ...(product as object), price: undefined },
      status: "lost_cart",
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: { eventName: "CartAbandoned", valueCents: null },
    });
  });

  it("ignores statuses that are not a supported event", () => {
    for (const status of ["canceled", "refunded", "chargeback", "expired"]) {
      expect(parsePaytSaleEventV1({ ...paid, status })).toEqual({
        ok: false,
        errorCode: "payt_sale_v1_status_not_supported",
        providerStatus: status,
      });
    }
  });

  it("requires value for Purchase and InitiateCheckout", () => {
    const noValue = {
      ...waiting,
      product: undefined,
      transaction: { payment_status: "waiting_payment" },
    };
    expect(parsePaytSaleEventV1(noValue)).toEqual({
      ok: false,
      errorCode: "payt_automation_v1_invalid_payload",
    });
  });

  it("keeps the Purchase rule contract Purchase-only", () => {
    expect(parsePaytAutomationV1(waiting)).toEqual({
      ok: false,
      errorCode: "payt_automation_v1_not_purchase",
    });
    expect(
      parsePaytAutomationV1({ ...paid, status: "lost_cart", seller_id: "" }),
    ).toEqual({ ok: false, errorCode: "payt_automation_v1_not_purchase" });
    expect(parsePaytAutomationV1(paid)).toMatchObject({
      ok: true,
      value: { eventName: "Purchase" },
    });
  });
});
