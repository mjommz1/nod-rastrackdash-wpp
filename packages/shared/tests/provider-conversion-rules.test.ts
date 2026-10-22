import { describe, expect, it } from "vitest";
import {
  conversionRuleCreateInputSchema,
  inboundWebhookDeliveryPurposeSchema,
  providerConversionAutomationAuditSchema,
  providerConversionAutomationPayloadSchema,
  providerConversionAutomationReprocessBatchInputSchema,
  providerConversionAutomationReprocessBatchResultSchema,
  providerConversionRuleAdaptInputSchema,
  providerConversionRuleCreateInputSchema,
  providerConversionRuleExecutionAuditSchema,
  providerConversionRuleUpdateInputSchema,
  purchaseReviewListQuerySchema,
  readMessagePhraseConfig,
  structuredCatalogTestMessageInputSchema,
  structuredCatalogTestMessageResultSchema,
} from "../src";

const channelScope = {
  name: "Conversoes Umbler",
  connectionId: "connection_1",
  channelIds: ["channel_1"],
};

const messageScope = {
  ...channelScope,
  triggerPhrases: ["Dados para confirmar o pedido"],
  messageAuthorScope: "both" as const,
};

const trampolineCatalog = {
  name: "Catalogo de camas elasticas",
  productName: "Cama elastica",
  currency: "brl",
  attributes: [
    { key: "tamanho", label: "Tamanho" },
    { key: "modelo", label: "Modelo" },
  ],
  variants: [
    { attributeValues: ["4,90", "Nacional"], valueCents: 359700 },
    { attributeValues: ["4,27", "Nacional"], valueCents: 299700 },
    { attributeValues: ["3,05", "Nacional"], valueCents: 199700 },
    { attributeValues: ["2,44", "Nacional"], valueCents: 159700 },
    { attributeValues: ["3,05", "Europa"], valueCents: 179700 },
    { attributeValues: ["2,44", "Europa"], valueCents: 139700 },
  ],
};

describe("provider conversion rule contracts", () => {
  it("validates technical Meta delivery evidence in execution audits", () => {
    const audit = providerConversionRuleExecutionAuditSchema.parse({
      providerRuleId: "provider_rule_1",
      eventName: "InitiateCheckout",
      summary: {
        total: 1,
        observed: 0,
        eligible: 0,
        materialized: 1,
        duplicate: 0,
        blocked: 0,
        failed: 0,
      },
      items: [
        {
          executionId: "execution_1",
          sourceDeliveryId: "delivery_1",
          occurredAt: "2026-07-22T15:00:00.000Z",
          status: "materialized",
          reasonCode: null,
          matchedTriggerPhrase: null,
          channel: null,
          leadId: "lead_1",
          leadName: "Cliente IC",
          phoneDisplay: "+5511999990000",
          valueCents: 19900,
          currency: "BRL",
          conversionEventLogId: "conversion_1",
          purchaseReviewId: null,
          attemptCount: 1,
          processedAt: "2026-07-22T15:00:01.000Z",
          technicalDelivery: {
            state: "failed_permanent",
            retryable: false,
            reasonCode: "MetaCapiSendError",
            updatedAt: "2026-07-22T15:00:02.000Z",
          },
          lastProductionFailure: {
            code: "provider_conversion_delivery_failed",
            failedAt: "2026-07-22T15:00:02.000Z",
          },
        },
      ],
      pagination: { page: 1, pageSize: 25, totalItems: 1, totalPages: 1 },
    });

    expect(audit.items[0]?.technicalDelivery?.state).toBe("failed_permanent");
  });

  it("defaults purchase review lists to the actionable queue", () => {
    expect(purchaseReviewListQuerySchema.parse({})).toMatchObject({
      view: "actionable",
      page: 1,
      pageSize: 25,
    });
    expect(
      purchaseReviewListQuerySchema.parse({ view: "history" }).view,
    ).toBe("history");
  });

  it("accepts only an observation-safe channel scope when adapting a legacy rule", () => {
    const parsed = providerConversionRuleAdaptInputSchema.parse({
      connectionId: "connection_1",
      channelIds: ["channel_1"],
      triggerPhrases: ["Aviso de compra"],
      messageAuthorScope: "team",
    });

    expect(parsed).toEqual({
      connectionId: "connection_1",
      channelIds: ["channel_1"],
      triggerPhrases: ["Aviso de compra"],
      messageAuthorScope: "team",
    });
    expect(
      providerConversionRuleAdaptInputSchema.safeParse({
        ...parsed,
        channelIds: [],
      }).success,
    ).toBe(false);
  });

  it("keeps provider triggers out of the legacy conversion rule endpoint", () => {
    expect(
      conversionRuleCreateInputSchema.safeParse({
        name: "Compra Umbler",
        triggerType: "provider_automation",
        triggerValue: "automation",
        eventName: "Purchase",
        active: true,
      }).success,
    ).toBe(false);
  });

  it("accepts a QualifiedLead automation without a monetary value", () => {
    const parsed = providerConversionRuleCreateInputSchema.parse({
      ...channelScope,
      triggerType: "provider_automation",
      eventName: "QualifiedLead",
    });

    expect(parsed).toMatchObject({
      mode: "observation",
      eventName: "QualifiedLead",
    });
    expect("defaultValueCents" in parsed).toBe(false);
  });

  it("requires a positive average value for Purchase automation", () => {
    expect(
      providerConversionRuleCreateInputSchema.safeParse({
        ...channelScope,
        triggerType: "provider_automation",
        eventName: "Purchase",
        defaultValueCents: 0,
      }).success,
    ).toBe(false);

    const parsed = providerConversionRuleCreateInputSchema.parse({
      ...channelScope,
      triggerType: "provider_automation",
      eventName: "Purchase",
      defaultValueCents: 250000,
    });

    // Sem moeda = herdar a "Moeda das conversoes" do workspace.
    expect(parsed).toMatchObject({ defaultValueCents: 250000 });
    expect(parsed.defaultCurrency ?? null).toBeNull();
  });

  it("accepts InitiateCheckout message_phrase with fixed value (U1)", () => {
    const parsed = providerConversionRuleCreateInputSchema.parse({
      ...messageScope,
      triggerType: "message_phrase",
      eventName: "InitiateCheckout",
      triggerPhrases: ["iniciou checkout"],
      defaultValueCents: 25000,
      defaultCurrency: "BRL",
      defaultContentName: "Checkout medio",
    });

    expect(parsed).toMatchObject({
      triggerType: "message_phrase",
      eventName: "InitiateCheckout",
      defaultValueCents: 25000,
      defaultCurrency: "BRL",
      mode: "observation",
    });

    expect(
      providerConversionRuleCreateInputSchema.safeParse({
        ...messageScope,
        triggerType: "message_phrase",
        eventName: "InitiateCheckout",
        // missing defaultValueCents
      }).success,
    ).toBe(false);
  });

  it("defaults message_phrase rules to a fixed average value", () => {
    const parsed = providerConversionRuleCreateInputSchema.parse({
      ...messageScope,
      triggerType: "message_phrase",
      eventName: "Purchase",
      triggerPhrases: ["Aviso de compra"],
      defaultValueCents: 99900,
    });

    expect(parsed).toMatchObject({
      valueMode: "fixed",
      defaultValueCents: 99900,
    });
    expect(parsed.defaultCurrency ?? null).toBeNull();
  });

  it("accepts message_extracted checkout rules with an example and no fixed value", () => {
    const parsed = providerConversionRuleCreateInputSchema.parse({
      ...messageScope,
      triggerType: "message_phrase",
      eventName: "InitiateCheckout",
      triggerPhrases: ["link de pagamento"],
      valueMode: "message_extracted",
      exampleMessage: "Segue o link de pagamento de R$ 250,00",
    });

    expect(parsed).toMatchObject({
      valueMode: "message_extracted",
      exampleMessage: "Segue o link de pagamento de R$ 250,00",
    });
    expect(parsed.defaultCurrency ?? null).toBeNull();
    expect(parsed).not.toHaveProperty("defaultValueCents", 0);
  });

  it("keeps a fallback average value available for message_extracted rules", () => {
    const parsed = providerConversionRuleCreateInputSchema.parse({
      ...messageScope,
      triggerType: "message_phrase",
      eventName: "Purchase",
      triggerPhrases: ["Aviso de compra"],
      valueMode: "message_extracted",
      defaultValueCents: 25000,
    });

    expect(parsed).toMatchObject({
      valueMode: "message_extracted",
      defaultValueCents: 25000,
    });
  });

  it("rejects fixed message_phrase rules without an average value", () => {
    expect(
      providerConversionRuleCreateInputSchema.safeParse({
        ...messageScope,
        triggerType: "message_phrase",
        eventName: "InitiateCheckout",
        triggerPhrases: ["iniciou checkout"],
        valueMode: "fixed",
      }).success,
    ).toBe(false);
  });

  it("reads the persisted message_phrase config and falls back to fixed", () => {
    expect(
      readMessagePhraseConfig({
        kind: "message_phrase_config_v1",
        valueMode: "message_extracted",
        exampleMessage: "Total: R$ 250,00",
      }),
    ).toMatchObject({
      valueMode: "message_extracted",
      exampleMessage: "Total: R$ 250,00",
    });

    for (const legacy of [null, undefined, [{ id: "sku_1", quantity: 1 }]]) {
      expect(readMessagePhraseConfig(legacy)).toEqual({
        kind: "message_phrase_config_v1",
        valueMode: "fixed",
        exampleMessage: null,
      });
    }
  });

  it("allows updates to switch the message_phrase value pipeline", () => {
    expect(
      providerConversionRuleUpdateInputSchema.parse({
        valueMode: "message_extracted",
        exampleMessage: "Pagamento de R$ 250,00 confirmado",
      }),
    ).toMatchObject({
      valueMode: "message_extracted",
      exampleMessage: "Pagamento de R$ 250,00 confirmado",
    });
  });

  it("accepts the approved two-attribute trampoline catalog", () => {
    const parsed = providerConversionRuleCreateInputSchema.parse({
      ...messageScope,
      triggerType: "structured_catalog",
      eventName: "Purchase",
      catalog: trampolineCatalog,
    });

    expect(parsed.catalog.currency).toBe("BRL");
    expect(parsed.catalog.variants).toHaveLength(6);
    expect(parsed.catalog.variants[0]).toMatchObject({
      attributeValues: ["4,90", "Nacional"],
      valueCents: 359700,
    });
  });

  it("rejects incomplete, duplicate, and non-Purchase catalogs", () => {
    expect(
      providerConversionRuleCreateInputSchema.safeParse({
        ...messageScope,
        triggerType: "structured_catalog",
        eventName: "Purchase",
        catalog: {
          ...trampolineCatalog,
          variants: [{ attributeValues: ["4,90"], valueCents: 359700 }],
        },
      }).success,
    ).toBe(false);

    expect(
      providerConversionRuleCreateInputSchema.safeParse({
        ...messageScope,
        triggerType: "structured_catalog",
        eventName: "Purchase",
        catalog: {
          ...trampolineCatalog,
          attributes: [
            { key: "modelo", label: "Modelo" },
            { key: "modelo", label: "Modelo alternativo" },
          ],
        },
      }).success,
    ).toBe(false);

    expect(
      providerConversionRuleCreateInputSchema.safeParse({
        ...messageScope,
        triggerType: "structured_catalog",
        eventName: "QualifiedLead",
        catalog: trampolineCatalog,
      }).success,
    ).toBe(false);
  });

  it("distinguishes regular observation intake from conversion automation", () => {
    expect(
      inboundWebhookDeliveryPurposeSchema.parse("message_observation"),
    ).toBe("message_observation");
    expect(
      inboundWebhookDeliveryPurposeSchema.parse("conversion_automation"),
    ).toBe("conversion_automation");
    expect(() =>
      inboundWebhookDeliveryPurposeSchema.parse("conversion"),
    ).toThrow();
  });

  it("validates event-level automation audit without exposing an implicit latest event", () => {
    const audit = providerConversionAutomationAuditSchema.parse({
      providerRuleId: "provider_rule_1",
      summary: {
        total: 2,
        observed: 1,
        blocked: 1,
        queued: 0,
        materialized: 0,
        failed: 0,
        invalid: 0,
        recoverable: 2,
      },
      items: [
        {
          deliveryId: "delivery_older_valid",
          executionId: "execution_older_valid",
          receivedAt: "2026-07-22T15:37:00.000Z",
          lastReceivedAt: "2026-07-22T15:37:00.000Z",
          providerEventType: "lead_qualificado",
          eventName: "QualifiedLead",
          automation: "lead_qualificado",
          status: "observed",
          reasonCode: "automation_matched_observation",
          attemptCount: 1,
          executionAttemptCount: 0,
          channel: {
            id: "channel_1",
            name: "Comercial",
            connectedPhone: "+5511999999999",
          },
          leadResolved: true,
          payloadAvailable: true,
          payloadExpiresAt: "2026-07-29T15:37:00.000Z",
          reprocessable: true,
        },
        {
          deliveryId: "delivery_newer_blocked",
          executionId: "execution_newer_blocked",
          receivedAt: "2026-07-22T16:37:00.000Z",
          lastReceivedAt: "2026-07-22T16:37:00.000Z",
          providerEventType: "lead_qualificado",
          eventName: "QualifiedLead",
          automation: "lead_qualificado",
          status: "blocked",
          reasonCode: "automation_paid_lead_missing",
          attemptCount: 1,
          executionAttemptCount: 1,
          channel: null,
          leadResolved: false,
          payloadAvailable: true,
          payloadExpiresAt: "2026-07-29T16:37:00.000Z",
          reprocessable: true,
        },
      ],
    });

    expect(audit.items.map((item) => item.deliveryId)).toEqual([
      "delivery_older_valid",
      "delivery_newer_blocked",
    ]);
  });

  it("requires explicit confirmation for selected callback replay batches", () => {
    expect(
      providerConversionAutomationReprocessBatchInputSchema.safeParse({
        confirmation: "REPROCESSAR_CALLBACKS_SELECIONADOS",
        deliveryIds: ["delivery_1", "delivery_2"],
      }).success,
    ).toBe(true);
    expect(
      providerConversionAutomationReprocessBatchInputSchema.safeParse({
        confirmation: "REPROCESSAR_TUDO",
        deliveryIds: ["delivery_1"],
      }).success,
    ).toBe(false);

    expect(
      providerConversionAutomationReprocessBatchResultSchema.parse({
        providerRuleId: "provider_rule_1",
        requested: 2,
        queued: 1,
        blocked: 1,
        skipped: 0,
        items: [
          {
            deliveryId: "delivery_1",
            executionId: "execution_1",
            status: "queued",
            reasonCode: "automation_manual_reprocess_approved",
            message: "Callback encaminhado para a fila da Meta",
          },
          {
            deliveryId: "delivery_2",
            executionId: "execution_2",
            status: "blocked",
            reasonCode: "automation_paid_lead_missing",
            message: "Lead pago nao localizado",
          },
        ],
      }).requested,
    ).toBe(2);
  });

  it("keeps raw automation payload behind a scoped audit response", () => {
    const result = providerConversionAutomationPayloadSchema.parse({
      providerRuleId: "provider_rule_1",
      deliveryId: "delivery_1",
      receivedAt: "2026-07-22T15:37:00.000Z",
      payloadExpiresAt: "2026-07-29T15:37:00.000Z",
      payload: automationPayloadFixture(),
    });

    expect(result.payload).toMatchObject({
      schema: "wpptrack.umbler.automation.v1",
    });
  });

  it("validates side-effect-free structured catalog test messages", () => {
    expect(
      structuredCatalogTestMessageInputSchema.parse({
        messageText: "Tamanho: 4,90\nModelo: Nacional\n3.597,00",
      }),
    ).toMatchObject({ messageText: expect.stringContaining("Nacional") });

    expect(
      structuredCatalogTestMessageResultSchema.parse({
        matched: true,
        reasonCode: "matched",
        classification: "recognized",
        matchedTriggerPhrase: "Dados para confirmar o pedido",
        parsedAttributes: [
          { key: "tamanho", label: "Tamanho", value: "4,90" },
          { key: "modelo", label: "Modelo", value: "Nacional" },
        ],
        items: [
          {
            position: 1,
            quantity: 1,
            parsedAttributes: [
              { key: "tamanho", label: "Tamanho", value: "4,90" },
              { key: "modelo", label: "Modelo", value: "Nacional" },
            ],
            catalogVariantId: "variant_1",
            unitValueCents: 359700,
            subtotalValueCents: 359700,
            contentName: "Cama elastica | Tamanho: 4,90 | Modelo: Nacional",
            reasonCode: "matched",
          },
        ],
        parsedValueCents: 359700,
        calculatedValueCents: 359700,
        observedPaymentValueCents: 359700,
        catalogVariantId: "variant_1",
        contentName: "Cama elastica | Tamanho: 4,90 | Modelo: Nacional",
        currency: "BRL",
      }),
    ).toMatchObject({ matched: true, parsedValueCents: 359700 });
  });

  it("aceita lead qualificado por mensagem sem valor", () => {
    const parsed = providerConversionRuleCreateInputSchema.parse({
      ...messageScope,
      triggerType: "message_phrase",
      eventName: "QualifiedLead",
      exampleMessage: "Vou te passar os valores do procedimento",
    });

    expect(parsed).toMatchObject({
      triggerType: "message_phrase",
      eventName: "QualifiedLead",
      mode: "observation",
      valueMode: "fixed",
    });
    expect("defaultValueCents" in parsed).toBe(false);
    expect("defaultCurrency" in parsed).toBe(false);
  });

  it("recusa valor em evento que nao carrega valor", () => {
    expect(
      providerConversionRuleCreateInputSchema.safeParse({
        ...messageScope,
        triggerType: "message_phrase",
        eventName: "QualifiedLead",
        defaultValueCents: 19900,
      }).success,
    ).toBe(false);

    expect(
      providerConversionRuleCreateInputSchema.safeParse({
        ...channelScope,
        triggerType: "provider_automation",
        eventName: "OrderShipped",
        defaultValueCents: 19900,
      }).success,
    ).toBe(false);
  });

  it("recusa extrair valor da mensagem em evento sem valor", () => {
    expect(
      providerConversionRuleCreateInputSchema.safeParse({
        ...messageScope,
        triggerType: "message_phrase",
        eventName: "QualifiedLead",
        valueMode: "message_extracted",
      }).success,
    ).toBe(false);
  });

  it("aceita valor opcional em AddToCart por mensagem", () => {
    const semValor = providerConversionRuleCreateInputSchema.parse({
      ...messageScope,
      triggerType: "message_phrase",
      eventName: "AddToCart",
    });
    expect(semValor).toMatchObject({ eventName: "AddToCart" });
    expect(semValor.defaultCurrency ?? null).toBeNull();

    const comValor = providerConversionRuleCreateInputSchema.parse({
      ...messageScope,
      triggerType: "message_phrase",
      eventName: "AddToCart",
      defaultValueCents: 12900,
    });
    expect(comValor).toMatchObject({ defaultValueCents: 12900 });
  });

  it("aceita AddToCart por tag com valor medio", () => {
    const parsed = providerConversionRuleCreateInputSchema.parse({
      ...channelScope,
      triggerType: "provider_automation",
      eventName: "AddToCart",
      defaultValueCents: 12900,
    });

    expect(parsed).toMatchObject({
      triggerType: "provider_automation",
      eventName: "AddToCart",
      defaultValueCents: 12900,
    });
    expect(parsed.defaultCurrency ?? null).toBeNull();
  });

  it("mantem a moeda escolhida na regra e aceita null = herdar o workspace", () => {
    const usd = providerConversionRuleCreateInputSchema.parse({
      ...channelScope,
      triggerType: "provider_automation",
      eventName: "Purchase",
      defaultValueCents: 9900,
      defaultCurrency: "usd",
    });
    expect(usd).toMatchObject({ defaultCurrency: "USD" });

    const inherit = providerConversionRuleCreateInputSchema.parse({
      ...channelScope,
      triggerType: "provider_automation",
      eventName: "Purchase",
      defaultValueCents: 9900,
      defaultCurrency: null,
    });
    expect(inherit.defaultCurrency).toBeNull();
  });

  it("aceita pedido enviado por tag sem nenhum campo de valor", () => {
    const parsed = providerConversionRuleCreateInputSchema.parse({
      ...channelScope,
      triggerType: "provider_automation",
      eventName: "OrderShipped",
    });

    expect(parsed).toMatchObject({ eventName: "OrderShipped" });
    expect("defaultValueCents" in parsed).toBe(false);
    expect("defaultCurrency" in parsed).toBe(false);
  });

  it("mantem o catalogo estruturado restrito a compra", () => {
    expect(
      providerConversionRuleCreateInputSchema.safeParse({
        ...messageScope,
        triggerType: "structured_catalog",
        eventName: "AddToCart",
        catalog: trampolineCatalog,
      }).success,
    ).toBe(false);
  });
});

function automationPayloadFixture() {
  return {
    schema: "wpptrack.umbler.automation.v1",
    source: "umbler_tag_automation",
    automation: "lead_qualificado",
    contact: { phone: "+5511999999999" },
    conversation: { id: "conversation_1" },
  };
}
