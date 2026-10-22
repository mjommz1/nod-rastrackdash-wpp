import {
  normalizeCurrencyCode,
  type ConversionEventCustomDataDto,
  type ConversionEventNameDto,
} from "@wpptrack/shared";
import type { AuthorizedPagePixelCtwaDestination } from "../inbound-webhooks/authorized-ctwa-destination";
import {
  buildMetaCapiPayload,
  type MetaCapiPayload,
} from "./meta-capi-payload.builder";

type MetaCapiEnv = Record<string, string | undefined>;
type Fetcher = typeof fetch;

type DispatchOptions = {
  beforeDispatch?: () => void;
  signal?: AbortSignal;
};

function bounded<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("meta_dispatch_deadline"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export type MetaCapiSendEventErrorCode =
  | "MissingMetaDestination"
  | "MissingAccessToken"
  | "MissingPhoneHash"
  | "MissingCtwaClid"
  | "MissingAdId"
  | "MetaEventTimeExpired"
  | "UnsupportedCurrency"
  | "MetaCapiRejected"
  | "MetaCapiNetworkError"
  | "MetaCapiDeliveryUnknown"
  | null;

export type MetaCapiSendEventInput = {
  /**
   * CTWA lead with ctwa_clid and no known ad: the authorized page/pixel. The
   * ad id becomes optional (only an optional hint); ctwa_clid stays mandatory.
   */
  pagePixelDestination?: AuthorizedPagePixelCtwaDestination;
  accessToken?: string | null;
  pixelId: string | null;
  pageId: string | null;
  eventName: ConversionEventNameDto;
  dedupeKey: string;
  phoneHash: string | null;
  adId: string | null;
  ctwaClid: string | null;
  valueCents?: number | null;
  currency?: string | null;
  contentName?: string | null;
  customData?: ConversionEventCustomDataDto | null;
  eventTime?: Date | null;
  testEventCode?: string | null;
};

export type MetaCapiSendEventResult = {
  status: "not_configured" | "sent" | "error";
  requestPayload: MetaCapiPayload | null;
  responseSummary: Record<string, unknown> | null;
  errorMessage: string | null;
  errorCode: MetaCapiSendEventErrorCode;
  deliveryOutcome?: "unknown";
};

export class MetaCapiAdapter {
  constructor(
    private readonly env: MetaCapiEnv = process.env,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async sendEvent(
    input: MetaCapiSendEventInput,
    dispatch: DispatchOptions = {},
  ): Promise<MetaCapiSendEventResult> {
    // The CTWA page/pixel path only uses the token resolved for its business
    // connection, never the environment fallback token.
    const accessToken = (
      input.accessToken === undefined && !input.pagePixelDestination
        ? this.env.META_CAPI_ACCESS_TOKEN
        : input.accessToken
    )?.trim();
    const pixelId = input.pixelId?.trim() ?? null;
    const pageId = input.pageId?.trim() ?? null;
    const phoneHash = input.phoneHash?.trim() ?? null;
    const ctwaClid = input.ctwaClid?.trim() ?? null;
    const adId = input.adId?.trim() ?? null;

    const rejected = preflightMetaCapiEvent({ ...input, accessToken });
    if (rejected) return rejected;

    const version = this.env.META_GRAPH_API_VERSION ?? "v21.0";
    const url = new URL(
      `https://graph.facebook.com/${version}/${pixelId}/events`,
    );
    url.searchParams.set("access_token", accessToken!);
    const requestPayload = buildMetaCapiPayload({
      eventName: input.eventName,
      eventTime: input.eventTime ?? new Date(),
      eventId: input.dedupeKey,
      phoneHash: phoneHash!,
      ctwaClid: ctwaClid!,
      pageId: pageId!,
      adId: adId || null,
      valueCents: input.valueCents ?? null,
      currency: input.currency ?? null,
      contentName: input.contentName ?? null,
      customData: input.customData ?? null,
      testEventCode: input.testEventCode ?? null,
    });

    let response: Response | undefined;
    let payload: unknown;
    let dispatched = false;
    try {
      const request: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestPayload),
        ...(dispatch.signal ? { signal: dispatch.signal } : {}),
      };
      dispatch.signal?.throwIfAborted();
      dispatch.beforeDispatch?.();
      dispatched = true;
      response = await bounded(
        this.fetcher(url.toString(), request),
        dispatch.signal,
      );
      // A received non-2xx is an explicit rejection even if its body is not JSON.
      if (!response.ok) {
        return {
          status: "error",
          requestPayload,
          responseSummary: { httpStatus: response.status },
          errorMessage: "Meta CAPI request failed",
          errorCode: "MetaCapiRejected",
        };
      }
      payload = await bounded(response.json(), dispatch.signal);
    } catch {
      // As in the SaaS: a CTWA page/pixel event whose final authorization
      // (credential expiry/deadline) failed before the POST was never sent.
      if (input.pagePixelDestination && !dispatched)
        return notConfigured(
          "MissingMetaDestination",
          "CTWA authorization unavailable before dispatch",
        );
      return {
        status: "error",
        requestPayload,
        responseSummary: null,
        errorMessage: response?.ok
          ? "Meta CAPI delivery acknowledgement unavailable"
          : "Meta CAPI network request failed",
        errorCode: response?.ok
          ? "MetaCapiDeliveryUnknown"
          : "MetaCapiNetworkError",
        deliveryOutcome: "unknown",
      };
    }

    // This adapter sends exactly one event. HTTP success alone is inconclusive.
    // Meta's EventResponse defines int events_received, list[str] messages and
    // string fbtrace_id. Never persist arbitrary provider bodies/messages (PII).
    const ack =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    if (
      !ack ||
      "error" in ack ||
      !Number.isInteger(ack.events_received) ||
      ack.events_received !== 1 ||
      !Array.isArray(ack.messages) ||
      !ack.messages.every((m) => typeof m === "string") ||
      typeof ack.fbtrace_id !== "string" ||
      !ack.fbtrace_id.trim() ||
      ack.fbtrace_id.length > 256
    ) {
      return {
        status: "error",
        requestPayload,
        responseSummary: {
          httpStatus: response.status,
          acknowledgement: "invalid",
        },
        errorMessage: "Meta CAPI delivery acknowledgement unavailable",
        errorCode: "MetaCapiDeliveryUnknown",
        deliveryOutcome: "unknown",
      };
    }

    return {
      status: "sent",
      requestPayload,
      responseSummary: {
        events_received: 1,
        messageCount: ack.messages.length,
      },
      errorMessage: null,
      errorCode: null,
    };
  }
}

/** A configuration rejection here happens before any provider dispatch. */
export function preflightMetaCapiEvent(
  input: MetaCapiSendEventInput,
): MetaCapiSendEventResult | null {
  const accessToken = input.accessToken?.trim();
  const pixelId = input.pixelId?.trim();
  const pageId = input.pageId?.trim();
  const phoneHash = input.phoneHash?.trim();
  const ctwaClid = input.ctwaClid?.trim();
  const adId = input.adId?.trim();
  if (!accessToken) {
    return notConfigured(
      "MissingAccessToken",
      "Meta CAPI access token not configured",
    );
  }

  const pagePixel = input.pagePixelDestination;
  if (
    pagePixel &&
    (pagePixel.kind !== "authorized_ctwa_destination" ||
      pagePixel.deliveryKind !== "page_pixel" ||
      !pagePixel.pixelId?.trim() ||
      !pagePixel.pageId?.trim() ||
      pagePixel.pixelId !== pixelId ||
      pagePixel.pageId !== pageId)
  )
    return notConfigured(
      "MissingMetaDestination",
      "CTWA page/pixel intent mismatch",
    );
  if (
    pagePixel &&
    (!input.eventTime ||
      !Number.isFinite(input.eventTime.getTime()) ||
      input.eventTime.getTime() > Date.now() ||
      Date.now() - input.eventTime.getTime() > 7 * 86400000)
  )
    return notConfigured(
      "MetaEventTimeExpired",
      "CTWA destination requires a real event time within seven days",
    );

  if (!pixelId || !pageId) {
    return notConfigured(
      "MissingMetaDestination",
      "Meta CAPI pixel id or page id not configured",
    );
  }

  if (!phoneHash) {
    return notConfigured(
      "MissingPhoneHash",
      "Meta CAPI phone hash not available",
    );
  }

  if (!ctwaClid) {
    return notConfigured(
      "MissingCtwaClid",
      "Meta CAPI ctwa_clid not available",
    );
  }

  // ctwa_clid is checked above for every path. Only the authorized CTWA
  // page/pixel path may travel without an ad id.
  if (!adId && !pagePixel) {
    return notConfigured("MissingAdId", "Meta CAPI ad id not available");
  }

  // Só BRL/USD/EUR vão à Meta: valor com moeda fora da lista (evento gravado
  // antes da Fase 5.1) fica bloqueado com motivo, nunca sai com outra moeda.
  const currency = input.currency?.trim();
  if (
    typeof input.valueCents === "number" &&
    currency &&
    !normalizeCurrencyCode(currency)
  ) {
    return notConfigured(
      "UnsupportedCurrency",
      `Moeda ${currency.toUpperCase()} fora de BRL, USD ou EUR: nada foi enviado à Meta`,
    );
  }

  return null;
}

function notConfigured(
  errorCode: Exclude<
    MetaCapiSendEventErrorCode,
    | "MetaCapiRejected"
    | "MetaCapiNetworkError"
    | "MetaCapiDeliveryUnknown"
    | null
  >,
  errorMessage: string,
): MetaCapiSendEventResult {
  return {
    status: "not_configured",
    requestPayload: null,
    responseSummary: null,
    errorMessage,
    errorCode,
  };
}
