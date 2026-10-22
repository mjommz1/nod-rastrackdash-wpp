import { z } from "zod";
import { conversionEventNameSchema } from "./conversion-events";
import { paytSaleEventNames } from "./conversion-rules";

/**
 * Fase 5.3 — URL única por plataforma e URLs por evento.
 *
 * - Plataforma de venda (Payt): UMA URL por workspace; o evento vem de cada
 *   postback (compra aprovada, Pix/boleto gerado, carrinho abandonado).
 * - Automação (Unnichat, Umbler): UMA URL por evento, válida para todos os
 *   números do workspace.
 *
 * O roteador descobre o número de chegada do lead e entrega o callback à
 * regra dona (a específica do número vence a de todos os números), que segue
 * o mesmo processamento da URL antiga da regra.
 */
export const integrationEndpointProviders = [
  "payt",
  "unnichat",
  "umbler",
] as const;
export const integrationEndpointProviderSchema = z.enum(
  integrationEndpointProviders,
);

export const integrationEndpointKinds = [
  "sales_platform",
  "automation_event",
] as const;
export const integrationEndpointKindSchema = z.enum(integrationEndpointKinds);

/** Eventos que cada plataforma de URL por evento sabe enviar. */
export const integrationEndpointAutomationEvents = {
  unnichat: [
    "QualifiedLead",
    "Purchase",
    "InitiateCheckout",
    "AddToCart",
    "CartAbandoned",
    "ViewContent",
  ],
  // O contrato wpptrack.umbler.automation.v1 só conhece estas duas automações.
  umbler: ["QualifiedLead", "Purchase"],
} as const;

export function integrationEndpointKindFor(
  provider: z.infer<typeof integrationEndpointProviderSchema>,
): z.infer<typeof integrationEndpointKindSchema> {
  return provider === "payt" ? "sales_platform" : "automation_event";
}

/** Eventos suportados por uma URL (Payt: os que o postback pode virar). */
export function integrationEndpointSupportedEvents(
  provider: z.infer<typeof integrationEndpointProviderSchema>,
): readonly string[] {
  return provider === "payt"
    ? paytSaleEventNames
    : integrationEndpointAutomationEvents[provider];
}

/** POST /integrations/endpoints — gera (ou devolve) a URL viva. */
export const integrationEndpointCreateInputSchema = z
  .object({
    provider: integrationEndpointProviderSchema,
    eventName: conversionEventNameSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.provider === "payt") {
      if (input.eventName) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A Payt usa uma única URL; o evento vem de cada venda",
          path: ["eventName"],
        });
      }
      return;
    }
    if (
      !input.eventName ||
      !integrationEndpointSupportedEvents(input.provider).includes(
        input.eventName,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Escolha um evento suportado por esta plataforma",
        path: ["eventName"],
      });
    }
  });

export const integrationEndpointStatsSchema = z.object({
  received: z.number().int().nonnegative(),
  routed: z.number().int().nonnegative(),
  /** Inclui os recibos ainda "pending" (roteamento não terminou). */
  unattributed: z.number().int().nonnegative(),
  ignored: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
});

export const integrationEndpointSchema = z.object({
  id: z.string().min(1),
  provider: integrationEndpointProviderSchema,
  kind: integrationEndpointKindSchema,
  eventName: conversionEventNameSchema.nullable(),
  /**
   * URL completa com o token. Nunca vem na listagem: só nas respostas de
   * criar, "Mostrar URL" e girar (gestores de integração, com auditoria).
   */
  url: z.string().url().nullable(),
  secretVersion: z.number().int().positive(),
  parserCertified: z.boolean(),
  lastDeliveryAt: z.string().datetime().nullable(),
  lastRoutedAt: z.string().datetime().nullable(),
  rotatedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  stats: integrationEndpointStatsSchema,
});

/** Regra que ainda tem a URL antiga (por regra/número). */
export const integrationLegacyUrlSchema = z.object({
  providerRuleId: z.string().min(1),
  ruleName: z.string(),
  eventName: conversionEventNameSchema,
  provider: integrationEndpointProviderSchema,
  scope: z.enum(["all_numbers", "specific_numbers"]),
  channelIds: z.array(z.string()),
  /** Último recebimento pela URL antiga (os roteados pela nova não contam). */
  lastDeliveryAt: z.string().datetime().nullable(),
  publicUrlDisabledAt: z.string().datetime().nullable(),
});

export const integrationEndpointListSchema = z.object({
  /** Falso quando a instalação desligou webhooks/regras de conversão. */
  enabled: z.boolean(),
  canManage: z.boolean(),
  endpoints: z.array(integrationEndpointSchema),
  legacyUrls: z.array(integrationLegacyUrlSchema),
});

export const integrationEndpointResultSchema = z.object({
  endpoint: integrationEndpointSchema,
});

export const integrationDetectedProductSchema = z.object({
  provider: integrationEndpointProviderSchema,
  productCode: z.string().nullable(),
  productName: z.string().nullable(),
  offerCode: z.string().nullable(),
  offerName: z.string().nullable(),
  lastSeenAt: z.string().datetime(),
});

export const integrationDetectedProductListSchema = z.object({
  products: z.array(integrationDetectedProductSchema),
});

/**
 * Motivos de uma venda/evento que não virou conversão, com texto simples.
 * A chave fica gravada no recibo; o texto pode mudar sem migration.
 */
export const integrationUnattributedReasons = {
  no_active_rule_for_event: "Nenhuma regra ativa para este evento",
  product_without_rule: "Produto sem regra",
  buyer_not_whatsapp_lead: "Comprador não é lead do WhatsApp",
  buyer_ambiguous: "Mais de um lead com este telefone",
  buyer_without_ad_origin: "O lead não veio de um anúncio",
  origin_channel_unresolved: "Não deu para saber por qual número o lead chegou",
  no_rule_for_number: "Nenhuma regra para o número de chegada do lead",
  conversation_without_ad: "Conversa sem anúncio de origem",
  contact_without_conversation:
    "Contato sem conversa recebida em nenhum número",
  contact_multiple_numbers: "Ambíguo: o contato falou com mais de um número",
  routing_pending: "Recebido; ainda não foi possível atribuir (tente de novo)",
  event_mismatch: "O evento enviado não é o desta URL",
  rule_unavailable: "A regra escolhida não está mais ativa",
  rule_declined:
    "A regra do número não converteu (filtro, outro número, lead ou bloqueio; veja os eventos recebidos da regra)",
} as const;
export type IntegrationUnattributedReasonDto =
  keyof typeof integrationUnattributedReasons;

export function integrationUnattributedReasonLabel(
  reasonCode: string | null | undefined,
): string {
  return (
    integrationUnattributedReasons[
      reasonCode as IntegrationUnattributedReasonDto
    ] ?? "Evento não atribuído"
  );
}

export const integrationEndpointEventStatuses = [
  "pending",
  "routed",
  "unattributed",
  "ignored",
  "invalid",
] as const;
export const integrationEndpointEventStatusSchema = z.enum(
  integrationEndpointEventStatuses,
);

export const integrationUnattributedEventSchema = z.object({
  id: z.string().min(1),
  provider: integrationEndpointProviderSchema,
  eventName: conversionEventNameSchema.nullable(),
  productCode: z.string().nullable(),
  productName: z.string().nullable(),
  offerCode: z.string().nullable(),
  valueCents: z.number().int().nullable(),
  currency: z.string().nullable(),
  reasonCode: z.string().nullable(),
  reasonLabel: z.string(),
  attemptCount: z.number().int().positive(),
  firstReceivedAt: z.string().datetime(),
  lastReceivedAt: z.string().datetime(),
  /** Corpo ainda guardado: "Tentar de novo" pode rotear outra vez. */
  retryable: z.boolean(),
  /** rule_declined: o motivo que a própria regra deu (código técnico). */
  ruleReasonCode: z.string().nullable().optional(),
});

export const integrationUnattributedEventListSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(integrationUnattributedEventSchema),
});

/** Resposta de "Tentar de novo". */
export const integrationEndpointRoutingResultSchema = z.object({
  eventId: z.string().min(1),
  status: integrationEndpointEventStatusSchema,
  reasonCode: z.string().nullable(),
  providerRuleId: z.string().nullable(),
  deliveryId: z.string().nullable(),
});

export type IntegrationEndpointProviderDto = z.infer<
  typeof integrationEndpointProviderSchema
>;
export type IntegrationEndpointKindDto = z.infer<
  typeof integrationEndpointKindSchema
>;
export type IntegrationEndpointCreateInputDto = z.infer<
  typeof integrationEndpointCreateInputSchema
>;
export type IntegrationEndpointDto = z.infer<typeof integrationEndpointSchema>;
export type IntegrationEndpointStatsDto = z.infer<
  typeof integrationEndpointStatsSchema
>;
export type IntegrationLegacyUrlDto = z.infer<
  typeof integrationLegacyUrlSchema
>;
export type IntegrationEndpointListDto = z.infer<
  typeof integrationEndpointListSchema
>;
export type IntegrationEndpointResultDto = z.infer<
  typeof integrationEndpointResultSchema
>;
export type IntegrationDetectedProductDto = z.infer<
  typeof integrationDetectedProductSchema
>;
export type IntegrationDetectedProductListDto = z.infer<
  typeof integrationDetectedProductListSchema
>;
export type IntegrationUnattributedEventDto = z.infer<
  typeof integrationUnattributedEventSchema
>;
export type IntegrationUnattributedEventListDto = z.infer<
  typeof integrationUnattributedEventListSchema
>;
export type IntegrationEndpointRoutingResultDto = z.infer<
  typeof integrationEndpointRoutingResultSchema
>;
export type IntegrationEndpointEventStatusDto = z.infer<
  typeof integrationEndpointEventStatusSchema
>;
