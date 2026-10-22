import { normalizeCurrencyCode, type CurrencyCode } from "@wpptrack/shared";
import { normalizePhoneIdentity } from "../../../common/phone/phone-identity";
import { boundedString } from "../inbound-webhook-delivery-identity";

export const PAYT_AUTOMATION_V1_PARSER_VERSION = "automation-v1";

/**
 * Standard business-messaging events a Payt postback can become (Fase 4a).
 * The event comes from the payload status/type, never from the URL.
 */
export const PAYT_SALE_EVENT_NAMES = [
  "Purchase",
  "InitiateCheckout",
  "CartAbandoned",
] as const;
export type PaytSaleEventName = (typeof PAYT_SALE_EVENT_NAMES)[number];

export type PaytSaleAutomation =
  | "purchase_paid"
  | "checkout_waiting_payment"
  | "cart_abandoned";

const automationByEvent: Record<PaytSaleEventName, PaytSaleAutomation> = {
  Purchase: "purchase_paid",
  InitiateCheckout: "checkout_waiting_payment",
  CartAbandoned: "cart_abandoned",
};

/** Product and offer (checkout link) of the sale; codes only identify. */
export type PaytSaleProduct = { code: string; name: string | null };

export type ParsedPaytAutomationV1 = {
  provider: "payt";
  automation: PaytSaleAutomation;
  eventName: PaytSaleEventName;
  /** Status as sent by Payt (lowercase), kept for the receipt only. */
  providerStatus?: string | null;
  phone: string;
  phoneCandidates: string[];
  occurredAt: Date;
  externalExecutionKey: string;
  /** Always present for Purchase/InitiateCheckout; optional on CartAbandoned. */
  valueCents: number | null;
  /**
   * Currency the sale itself declares (BRL/USD/EUR), or null when the
   * postback carries none (Payt normally sends none): the conversion then
   * uses the rule currency, the workspace "Moeda das conversoes", then BRL.
   */
  currency: CurrencyCode | null;
  test: boolean;
  /** Verified fixture keys, never integration_key. In-memory only. */
  accountRef: string;
  orderRef: string;
  product?: PaytSaleProduct | null;
  offer?: PaytSaleProduct | null;
  /** Normalized (uppercase) product/offer codes of the sale. */
  productCodes?: string[];
};

export type PaytAutomationV1ParseResult =
  | { ok: true; value: ParsedPaytAutomationV1 }
  | {
      ok: false;
      errorCode:
        | "payt_automation_v1_not_purchase"
        | "payt_automation_v1_invalid_payload"
        | "payt_purchase_identity_missing"
        | "payt_currency_unsupported";
    };

export type PaytSaleEventV1ParseResult =
  | { ok: true; value: ParsedPaytAutomationV1 }
  | {
      ok: false;
      errorCode:
        | "payt_sale_v1_status_not_supported"
        | "payt_automation_v1_invalid_payload"
        | "payt_purchase_identity_missing"
        | "payt_currency_unsupported";
      providerStatus?: string | null;
    };

const cartAbandonedMarkers = new Set([
  "lost_cart",
  "abandoned_cart",
  "cart_abandoned",
  "abandoned",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrap(payload: unknown): Record<string, unknown> | null {
  const direct = asRecord(payload);
  if (direct) return direct;

  // n8n's webhook test/export envelope is an array with the original body.
  if (!Array.isArray(payload) || payload.length !== 1) return null;
  const envelope = asRecord(payload[0]);
  return envelope ? asRecord(envelope.body) : null;
}

function unwrapSafe(payload: unknown): Record<string, unknown> | null {
  try {
    return unwrap(payload);
  } catch {
    return null;
  }
}

function parseTimestamp(value: unknown): Date | null {
  const timestamp = boundedString(value, 80);
  if (!timestamp) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(
    timestamp,
  )
    ? `${timestamp.replace(" ", "T")}Z`
    : timestamp;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

function lower(value: unknown, max: number): string | null {
  return boundedString(value, max)?.toLocaleLowerCase("en-US") ?? null;
}

/**
 * Moeda que a venda declara (a da transação vale antes da do pedido). null =
 * a venda não declara moeda (o normal na Payt): decide a regra ou o
 * workspace. Moeda declarada fora de BRL/USD/EUR vira "unsupported": a venda
 * é recusada com motivo (payt_currency_unsupported), porque o valor nunca
 * pode sair à Meta numa moeda que não é a dele.
 */
function paytCurrency(
  order: Record<string, unknown>,
  transaction: Record<string, unknown> | null,
): CurrencyCode | null | "unsupported" {
  for (const value of [transaction?.currency, order.currency]) {
    const declared =
      typeof value === "string" && value.trim() ? value.trim() : null;
    if (!declared) continue;
    return normalizeCurrencyCode(boundedString(declared, 10)) ?? "unsupported";
  }
  return null;
}

function positiveCents(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : null;
}

/**
 * Sale value of a Payt transaction, in cents: the price WITHOUT card
 * installment interest (`price_without_installments`, which already sums the
 * product and its order bumps). `total_price` includes the interest of an
 * installment plan (e.g. 12x R$ 24,80 = R$ 297,60 for a R$ 247,00 sale) and
 * is only the fallback for a postback that does not carry the field.
 */
export function paytTransactionValueCents(
  transaction: Record<string, unknown> | null | undefined,
): number | null {
  return (
    positiveCents(transaction?.price_without_installments) ??
    positiveCents(transaction?.total_price)
  );
}

/** Marker of a Payt sale whose value was corrected to drop installment interest. */
export const PAYT_VALUE_CORRECTION_REASON = "payt_price_without_installments";

/**
 * Value the parser used BEFORE `price_without_installments` was preferred
 * (`transaction.total_price`, with interest). Only for compatibility with
 * decisions frozen before that change and for the value backfill.
 */
export function paytLegacyTotalPriceCents(payload: unknown): number | null {
  try {
    const order = unwrap(payload);
    return order ? positiveCents(asRecord(order.transaction)?.total_price) : null;
  } catch {
    return null;
  }
}

const productCodePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u;

/**
 * Product/offer codes of the sale, uppercased. Kept on the parsed value for
 * the receipt and compared with the rule product filter (Fase 5.3).
 */
export function normalizeProductCode(value: unknown): string | null {
  const code = boundedString(value, 80);
  return code && productCodePattern.test(code)
    ? code.toLocaleUpperCase("en-US")
    : null;
}

function productOf(record: Record<string, unknown> | null): PaytSaleProduct | null {
  if (!record) return null;
  const code = normalizeProductCode(record.code);
  if (!code) return null;
  return { code, name: boundedString(record.name, 200) };
}

/**
 * Offer = checkout link. Payt links look like https://payt.site/YoMCA71; the
 * last path segment is the link code shown in the Payt panel.
 */
function offerOf(link: Record<string, unknown> | null): PaytSaleProduct | null {
  if (!link) return null;
  const explicit = normalizeProductCode(link.code);
  let code = explicit;
  if (!code) {
    const url = boundedString(link.url, 500);
    if (url) {
      try {
        const segments = new URL(url).pathname.split("/").filter(Boolean);
        code = normalizeProductCode(segments.at(-1));
      } catch {
        code = null;
      }
    }
  }
  return code ? { code, name: boundedString(link.title, 200) } : null;
}

export function paytPhoneCandidates(phone: unknown): string[] {
  const received = normalizePhoneIdentity(
    typeof phone === "string" ? phone : undefined,
  );
  if (!received) return [];

  // Payt commonly sends a national BR number. Preserve it as received first,
  // then also try its E.164 equivalent without assuming a value for other forms.
  const prefixed =
    (received.length === 10 || received.length === 11) &&
    !received.startsWith("55")
      ? `55${received}`
      : null;
  return prefixed ? [received, prefixed] : [received];
}

function saleEventName(
  order: Record<string, unknown>,
  transaction: Record<string, unknown> | null,
): PaytSaleEventName | null {
  const status = lower(order.status, 40);
  const type = lower(order.type, 80);
  const paymentStatus = transaction
    ? lower(transaction.payment_status, 40)
    : null;
  const hasPaymentStatus =
    transaction !== null &&
    Object.prototype.hasOwnProperty.call(transaction, "payment_status");

  // A paid order always wins: the abandoned-cart markers are read only from
  // the status (a "lost_cart" type later paid is a Purchase).
  const isPaidPurchase =
    status === "paid" && (!hasPaymentStatus || paymentStatus === "paid");
  const isCodConfirmedPurchase =
    type === "cash_on_delivery" && status === "order_confirmed";
  if (isPaidPurchase || isCodConfirmedPurchase) return "Purchase";
  if (status !== null && cartAbandonedMarkers.has(status)) {
    return "CartAbandoned";
  }
  if (status === "waiting_payment") return "InitiateCheckout";
  return null;
}

/**
 * Event of a Payt postback WITHOUT validating identity, phone or value:
 * lets a rule ignore another event before judging the payload (a waiting
 * payment without phone is "not this rule", never an invalid purchase).
 */
export function paytSaleEventNameOf(payload: unknown): PaytSaleEventName | null {
  try {
    const order = unwrap(payload);
    return order ? saleEventName(order, asRecord(order.transaction)) : null;
  } catch {
    return null;
  }
}

/**
 * Every Payt postback the platform maps to a standard event: paid order →
 * Purchase, order waiting payment (pix/boleto generated) → InitiateCheckout,
 * abandoned cart → CartAbandoned. Any other status (canceled, refunded,
 * chargeback, ...) is not supported and must be ignored, never an error.
 */
export function parsePaytSaleEventV1(
  payload: unknown,
): PaytSaleEventV1ParseResult {
  try {
    const order = unwrap(payload);
    if (!order) {
      return { ok: false, errorCode: "payt_automation_v1_invalid_payload" };
    }
    const transaction = asRecord(order.transaction);
    const customer = asRecord(order.customer);
    const providerStatus = lower(order.status, 40) ?? lower(order.type, 80);
    const eventName = saleEventName(order, transaction);
    if (!eventName) {
      return {
        ok: false,
        errorCode: "payt_sale_v1_status_not_supported",
        providerStatus,
      };
    }

    const transactionId = boundedString(order.transaction_id, 255);
    const cartId = boundedString(order.cart_id, 255);
    // A paid order always carries its transaction; a checkout or abandoned
    // cart may only have the cart identifier.
    const orderRef =
      eventName === "Purchase" ? transactionId : (transactionId ?? cartId);
    const accountRef = boundedString(order.seller_id, 255);
    if (
      !orderRef ||
      !accountRef ||
      orderRef.includes("\0") ||
      accountRef.includes("\0")
    ) {
      return { ok: false, errorCode: "payt_purchase_identity_missing" };
    }
    const phoneCandidates = paytPhoneCandidates(customer?.phone);
    const productRecord = asRecord(order.product);
    const product = productOf(productRecord);
    const productQuantity =
      typeof productRecord?.quantity === "number" &&
      Number.isSafeInteger(productRecord.quantity) &&
      productRecord.quantity > 0
        ? productRecord.quantity
        : 1;
    const productPrice = positiveCents(productRecord?.price);
    const valueCents =
      paytTransactionValueCents(transaction) ??
      (eventName === "Purchase" || productPrice === null
        ? null
        : productPrice * productQuantity);
    const occurredAt = parseTimestamp(
      eventName === "Purchase"
        ? (transaction?.paid_at ??
            transaction?.updated_at ??
            order.updated_at ??
            order.started_at)
        : (transaction?.created_at ??
            transaction?.updated_at ??
            order.updated_at ??
            order.started_at),
    );
    if (
      phoneCandidates.length === 0 ||
      !occurredAt ||
      (eventName !== "CartAbandoned" && valueCents === null)
    ) {
      return { ok: false, errorCode: "payt_automation_v1_invalid_payload" };
    }

    const currency = paytCurrency(order, transaction);
    if (currency === "unsupported") {
      return { ok: false, errorCode: "payt_currency_unsupported" };
    }

    const offer = offerOf(asRecord(order.link));
    const itemCodes = Array.isArray(productRecord?.items)
      ? productRecord.items
          .map((item) => normalizeProductCode(asRecord(item)?.code))
          .filter((code): code is string => Boolean(code))
      : [];
    const productCodes = [
      ...new Set(
        [product?.code, ...itemCodes, offer?.code].filter(
          (code): code is string => Boolean(code),
        ),
      ),
    ];

    return {
      ok: true,
      value: {
        provider: "payt",
        automation: automationByEvent[eventName],
        eventName,
        providerStatus,
        phone: phoneCandidates[0]!,
        phoneCandidates,
        occurredAt,
        externalExecutionKey: orderRef,
        orderRef,
        accountRef,
        valueCents,
        currency,
        test: order.test === true,
        product,
        offer,
        productCodes,
      },
    };
  } catch {
    return { ok: false, errorCode: "payt_automation_v1_invalid_payload" };
  }
}

/**
 * Purchase-only contract, exactly as validated in the SaaS: a Purchase rule
 * reads only approved purchases (paid or cash-on-delivery confirmed).
 */
export function parsePaytAutomationV1(
  payload: unknown,
): PaytAutomationV1ParseResult {
  // Non-purchase postbacks stay "not a purchase" whatever else they lack.
  if (unwrapSafe(payload) && paytSaleEventNameOf(payload) !== "Purchase") {
    return { ok: false, errorCode: "payt_automation_v1_not_purchase" };
  }
  const parsed = parsePaytSaleEventV1(payload);
  if (!parsed.ok) {
    return parsed.errorCode === "payt_sale_v1_status_not_supported"
      ? { ok: false, errorCode: "payt_automation_v1_not_purchase" }
      : { ok: false, errorCode: parsed.errorCode };
  }
  if (parsed.value.eventName !== "Purchase") {
    return { ok: false, errorCode: "payt_automation_v1_not_purchase" };
  }
  return parsed;
}

/**
 * Fase 5.3: whether a rule product filter accepts the sale. An empty filter
 * accepts every product (the behaviour of every rule created before it);
 * otherwise one of the sale product/offer codes must be in the filter,
 * compared case-insensitively.
 */
export function paytProductFilterMatches(
  filterCodes: readonly string[] | null | undefined,
  saleCodes: readonly string[],
): boolean {
  const filter = (filterCodes ?? [])
    .map((code) => normalizeProductCode(code))
    .filter((code): code is string => Boolean(code));
  if (filter.length === 0) return true;
  const sale = new Set(
    saleCodes.map((code) => code.toLocaleUpperCase("en-US")),
  );
  return filter.some((code) => sale.has(code));
}
