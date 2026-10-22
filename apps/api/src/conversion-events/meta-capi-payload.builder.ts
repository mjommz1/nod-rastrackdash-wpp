import {
  DEFAULT_CURRENCY_CODE,
  conversionEventMetadata,
  normalizeCurrencyCode,
  type ConversionEventCustomDataDto,
  type ConversionEventNameDto
} from "@wpptrack/shared";

export type MetaCapiPayloadInput = {
  eventName: ConversionEventNameDto;
  eventTime: Date;
  eventId: string;
  phoneHash: string;
  ctwaClid: string;
  pageId: string;
  /** null only on the authorized CTWA page/pixel path (no known ad). */
  adId: string | null;
  valueCents?: number | null;
  currency?: string | null;
  contentName?: string | null;
  customData?: ConversionEventCustomDataDto | null;
  testEventCode?: string | null;
};

export type MetaCapiPayload = {
  data: Array<{
    event_name: string;
    event_time: number;
    event_id: string;
    action_source: "business_messaging";
    messaging_channel: "whatsapp";
    user_data: {
      ph: string[];
      ctwa_clid: string;
      page_id: string;
    };
    custom_data: ConversionEventCustomDataDto;
  }>;
  test_event_code?: string;
};

export function buildMetaCapiPayload(
  input: MetaCapiPayloadInput
): MetaCapiPayload {
  const baseCustomData = input.customData ?? {};
  const catalogDefaults = buildCatalogCustomDataDefaults(
    input.eventName,
    input.eventId,
    baseCustomData,
    input.valueCents,
  );
  const customData: ConversionEventCustomDataDto = {
    ...baseCustomData,
    ...catalogDefaults,
    ...(input.adId ? { ad_id: input.adId } : {}),
    ...(typeof input.valueCents === "number"
      ? { value: input.valueCents / 100 }
      : {}),
    // A Meta precisa da moeda de todo valor: valor nunca vai sem moeda e só
    // BRL/USD/EUR saem daqui. Eventos gravados antes da moeda configurável só
    // ficavam sem moeda quando eram BRL (o padrão histórico). Um código fora
    // da lista é barrado antes, em preflightMetaCapiEvent (UnsupportedCurrency).
    ...(typeof input.valueCents === "number"
      ? {
          currency:
            normalizeCurrencyCode(input.currency) ?? DEFAULT_CURRENCY_CODE,
        }
      : normalizeCurrencyCode(input.currency)
        ? { currency: normalizeCurrencyCode(input.currency)! }
        : {}),
    ...(input.contentName ? { content_name: input.contentName } : {})
  };
  // Never forward a caller-provided ad_id when the event has no ad.
  if (!input.adId) delete customData.ad_id;

  return {
    data: [
      {
        event_name: input.eventName,
        event_time: Math.floor(input.eventTime.getTime() / 1000),
        event_id: input.eventId,
        action_source: "business_messaging",
        messaging_channel: "whatsapp",
        user_data: {
          ph: [input.phoneHash],
          ctwa_clid: input.ctwaClid,
          page_id: input.pageId
        },
        custom_data: customData
      }
    ],
    ...(input.testEventCode ? { test_event_code: input.testEventCode } : {})
  };
}

/**
 * O catalogo decide quais eventos carregam order_id e contents. Antes so
 * "Purchase" recebia esses defaults, o que fazia InitiateCheckout (e todos os
 * eventos de pedido) chegarem a Meta sem order_id, content_type e num_items.
 */
function buildCatalogCustomDataDefaults(
  eventName: ConversionEventNameDto,
  eventId: string,
  customData: ConversionEventCustomDataDto,
  valueCents?: number | null,
): Partial<ConversionEventCustomDataDto> {
  const metadata = conversionEventMetadata(eventName);
  const defaults: Partial<ConversionEventCustomDataDto> = {};

  if (metadata.hasOrderId && !customData.order_id) {
    defaults.order_id = eventId;
  }

  if (!metadata.hasItems) {
    return defaults;
  }

  const contents = customData.contents?.length
    ? customData.contents
    : [
        {
          id: eventId,
          quantity: 1,
          ...(typeof valueCents === "number"
            ? { item_price: valueCents / 100 }
            : {}),
        },
      ];

  if (!customData.contents?.length) {
    defaults.contents = contents;
  }

  if (!customData.content_type) {
    defaults.content_type = "product";
  }

  if (customData.num_items == null) {
    defaults.num_items = contents.reduce(
      (total, item) => total + (item.quantity ?? 1),
      0
    );
  }

  return defaults;
}
