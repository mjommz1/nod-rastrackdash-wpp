import { describe, expect, it } from "vitest";

import {
  buildMetaCapiPayload,
  isMetaLeadId,
} from "../../src/conversion-events/meta-capi-payload.builder";

// Emenda Implatec (Lead Ads): lead de formulário instantâneo entra no fluxo com
// o lead_id da Meta gravado em ctwaClid. O construtor é um só para os dois
// caminhos (envio direto e revisão aprovada), então cobrir aqui cobre ambos.

describe("isMetaLeadId", () => {
  it("reconhece só numérico de 15 a 17 dígitos", () => {
    expect(isMetaLeadId("1793385175278503")).toBe(true); // 16 dígitos (real)
    expect(isMetaLeadId("123456789012345")).toBe(true); // 15
    expect(isMetaLeadId("12345678901234567")).toBe(true); // 17
    expect(isMetaLeadId(" 1793385175278503 ")).toBe(true);
    expect(isMetaLeadId("12345678901234")).toBe(false); // 14
    expect(isMetaLeadId("123456789012345678")).toBe(false); // 18
    expect(isMetaLeadId("AfkqX3Sz-0w3-PE-dVb")).toBe(false); // ctwa_clid real
    expect(isMetaLeadId("")).toBe(false);
    expect(isMetaLeadId(null)).toBe(false);
    expect(isMetaLeadId(undefined)).toBe(false);
  });
});

describe("buildMetaCapiPayload com lead_id de formulário", () => {
  const base = {
    eventTime: new Date(1_700_000_000_000),
    eventId: "evt-1",
    phoneHash: "hash",
    pageId: "480153918517717",
    adId: "ad-9",
  };

  it("sai no formato de CRM: system_generated + user_data.lead_id numérico", () => {
    const payload = buildMetaCapiPayload({
      ...base,
      eventName: "Purchase",
      ctwaClid: "1793385175278503",
      valueCents: 2_350_000,
      currency: "BRL",
    });
    const event = payload.data[0]!;
    expect(event.action_source).toBe("system_generated");
    expect(event).not.toHaveProperty("messaging_channel");
    expect(event.user_data).toEqual({ lead_id: 1793385175278503 });
    expect(event.custom_data).toMatchObject({
      lead_event_source: "RastrackDash",
      event_source: "crm",
      value: 23500,
      currency: "BRL",
    });
    expect(event.custom_data).not.toHaveProperty("ad_id");
    expect(event.event_time).toBe(1_700_000_000);
    expect(event.event_id).toBe("evt-1");
  });

  it("mantém os defaults de catálogo e a moeda padrão nos eventos de pedido", () => {
    const payload = buildMetaCapiPayload({
      ...base,
      eventName: "InitiateCheckout",
      ctwaClid: "1793385175278503",
      valueCents: 1_450_000,
      currency: null,
    });
    const event = payload.data[0]!;
    expect(event.action_source).toBe("system_generated");
    expect(event.custom_data).toMatchObject({
      value: 14500,
      currency: "BRL",
      order_id: "evt-1",
      content_type: "product",
      num_items: 1,
    });
  });

  it("sem valor, não inventa value nem currency", () => {
    const payload = buildMetaCapiPayload({
      ...base,
      eventName: "QualifiedLead",
      ctwaClid: "1793385175278503",
    });
    const event = payload.data[0]!;
    expect(event.action_source).toBe("system_generated");
    expect(event.custom_data).not.toHaveProperty("value");
    expect(event.custom_data).not.toHaveProperty("currency");
    expect(event.custom_data).toMatchObject({ event_source: "crm" });
  });

  it("lead_id acima do inteiro seguro vai como string, sem perder dígitos", () => {
    const payload = buildMetaCapiPayload({
      ...base,
      eventName: "QualifiedLead",
      ctwaClid: "99999999999999999", // 17 dígitos > 2^53
    });
    expect(payload.data[0]!.user_data).toEqual({ lead_id: "99999999999999999" });
    expect(JSON.stringify(payload)).toContain('"lead_id":"99999999999999999"');
  });

  it("preserva test_event_code", () => {
    const payload = buildMetaCapiPayload({
      ...base,
      eventName: "QualifiedLead",
      ctwaClid: "1793385175278503",
      testEventCode: "TEST123",
    });
    expect(payload.test_event_code).toBe("TEST123");
  });
});

describe("buildMetaCapiPayload com ctwa_clid de WhatsApp (caminho atual, intacto)", () => {
  it("continua business_messaging com ph, ctwa_clid, page_id e ad_id", () => {
    const payload = buildMetaCapiPayload({
      eventName: "Purchase",
      eventTime: new Date(1_700_000_000_000),
      eventId: "e",
      phoneHash: "h",
      ctwaClid: "AfkqX3Sz-0w3-PE-dVb",
      pageId: "p",
      adId: "123",
      valueCents: 500,
      currency: "BRL",
    });
    const event = payload.data[0]!;
    expect(event.action_source).toBe("business_messaging");
    expect(event).toMatchObject({ messaging_channel: "whatsapp" });
    expect(event.user_data).toEqual({
      ph: ["h"],
      ctwa_clid: "AfkqX3Sz-0w3-PE-dVb",
      page_id: "p",
    });
    expect(event.custom_data).toMatchObject({ ad_id: "123", value: 5, currency: "BRL" });
    expect(event.custom_data).not.toHaveProperty("event_source");
  });

  it("um ctwa_clid curto e numérico (menos de 15 dígitos) não vira lead_id", () => {
    const payload = buildMetaCapiPayload({
      eventName: "QualifiedLead",
      eventTime: new Date(1_700_000_000_000),
      eventId: "e",
      phoneHash: "h",
      ctwaClid: "12345678",
      pageId: "p",
      adId: "123",
    });
    expect(payload.data[0]!.action_source).toBe("business_messaging");
  });
});
