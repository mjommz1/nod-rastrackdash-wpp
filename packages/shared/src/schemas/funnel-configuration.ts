import { z } from "zod";

import {
  conversionEventNameSchema,
  type ConversionEventNameDto
} from "./conversion-events";

export const conversionEventDisplayLabels: Record<ConversionEventNameDto, string> = {
  AddToCart: "Adicionado ao carrinho",
  CartAbandoned: "Carrinho abandonado",
  InitiateCheckout: "Checkout iniciado",
  LeadSubmitted: "Leads novos",
  OrderCanceled: "Pedido cancelado",
  OrderCreated: "Pedido criado",
  OrderDelivered: "Pedido entregue",
  OrderReturned: "Pedido devolvido",
  OrderShipped: "Pedido enviado",
  Purchase: "Compras",
  QualifiedLead: "Lead qualificado",
  RatingProvided: "Avaliacao recebida",
  ReviewProvided: "Comentario recebido",
  ViewContent: "Conteudo visualizado"
};

export function conversionEventDisplayLabel(eventName: string): string {
  return conversionEventNameSchema.safeParse(eventName).success
    ? conversionEventDisplayLabels[eventName as ConversionEventNameDto]
    : eventName;
}

export const funnelStageConfigurationSchema = z.object({
  eventName: conversionEventNameSchema,
  label: z.string().trim().min(2).max(80),
  position: z.number().int().positive(),
  visible: z.boolean(),
  defaultValueCents: z.number().int().positive().nullable().optional(),
  defaultCurrency: z.string().trim().length(3).nullable().optional(),
  defaultContentName: z.string().trim().min(1).max(180).nullable().optional()
});

export const funnelConfigurationSchema = z.object({
  stages: z.array(funnelStageConfigurationSchema).max(conversionEventNameSchema.options.length)
});

export const funnelConfigurationUpdateInputSchema = funnelConfigurationSchema.superRefine(
  (input, context) => {
    const eventNames = new Set<string>();

    input.stages.forEach((stage, index) => {
      if (eventNames.has(stage.eventName)) {
        context.addIssue({
          code: "custom",
          message: "Cada evento pode aparecer apenas uma vez no funil",
          path: ["stages", index, "eventName"]
        });
      }

      eventNames.add(stage.eventName);
    });
  }
);

export type FunnelStageConfigurationDto = z.infer<
  typeof funnelStageConfigurationSchema
>;
export type FunnelConfigurationDto = z.infer<typeof funnelConfigurationSchema>;
export type FunnelConfigurationUpdateInputDto = z.infer<
  typeof funnelConfigurationUpdateInputSchema
>;
