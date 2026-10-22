import { z } from "zod";
import { ruleCurrencyInputSchema } from "../currency";
import {
  conversionEventCarriesValue,
  conversionEventRequiresValue,
} from "./conversion-event-catalog";
import {
  conversionEventItemSchema,
  conversionEventNameSchema,
} from "./conversion-events";

export const legacyConversionTriggerTypes = [
  "keyword",
  "whatsapp_label",
] as const;
export const providerConversionTriggerTypes = [
  "provider_automation",
  "message_phrase",
  "structured_catalog",
] as const;
export const conversionTriggerTypes = [
  ...legacyConversionTriggerTypes,
  ...providerConversionTriggerTypes,
] as const;

/**
 * Estado tecnico de entrega de uma execucao de regra. Vive aqui (e nao em
 * provider-conversion-decisions) porque a auditoria da regra tambem precisa
 * dele e aquele modulo ja depende deste.
 */
export const providerConversionTechnicalDeliveryStates = [
  "observed",
  "queued",
  "sent",
  "blocked_configuration",
  "failed_retryable",
  "failed_permanent",
] as const;

export const providerConversionTechnicalDeliveryStateSchema = z.enum(
  providerConversionTechnicalDeliveryStates,
);

export const legacyConversionTriggerTypeSchema = z.enum(
  legacyConversionTriggerTypes,
);
export const providerConversionTriggerTypeSchema = z.enum(
  providerConversionTriggerTypes,
);
export const conversionTriggerTypeSchema = z.enum(conversionTriggerTypes);

export const conversionMatchModeSchema = z.enum(["contains", "exact"]);

export const providerConversionRuleModes = [
  "observation",
  "production",
] as const;
export const providerConversionRuleModeSchema = z.enum(
  providerConversionRuleModes,
);

/**
 * Plataforma externa que chama a URL da automacao. Ausente (null) mantem o
 * comportamento original, em que o proprio provedor WhatsApp (Umbler) envia o
 * callback. "payt" marca uma regra de venda vinda da Payt (Fase 4a): o valor
 * de cada venda chega em centavos no payload.
 */
export const providerConversionAutomationSources = ["payt"] as const;
export const providerConversionAutomationSourceSchema = z.enum(
  providerConversionAutomationSources,
);

/**
 * Fase 4a: eventos padrao que um postback da Payt pode virar. O evento vem do
 * status do payload: pago -> Purchase, aguardando pagamento (Pix/boleto
 * gerado) -> InitiateCheckout, carrinho abandonado -> CartAbandoned.
 */
export const paytSaleEventNames = [
  "Purchase",
  "InitiateCheckout",
  "CartAbandoned",
] as const;
/** Eventos ainda em beta na Payt (a tela mostra o selo "beta"). */
export const paytBetaSaleEventNames = ["CartAbandoned"] as const;

/** Fase 5.3: código de produto/oferta de uma plataforma de venda. */
export const saleProductCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u, "Código de produto inválido");

/**
 * Fase 5.3: filtro opcional de produto da regra (só Payt). Vazio = qualquer
 * produto. Os códigos são comparados sem caixa (gravados em maiúsculas).
 */
export const saleProductFilterCodesSchema = z
  .array(saleProductCodeSchema)
  .max(50)
  .transform((codes) => [
    ...new Set(codes.map((code) => code.toLocaleUpperCase("en-US"))),
  ]);

/**
 * Alcance da regra. "specific_numbers" (padrao historico) usa os numeros
 * escolhidos; "all_numbers" vale para todo numero do workspace que suporte a
 * origem da regra, inclusive numeros conectados depois. Uma regra especifica
 * com a mesma origem e o mesmo evento substitui a global naquele numero.
 */
export const providerConversionRuleScopes = [
  "all_numbers",
  "specific_numbers",
] as const;
export const providerConversionRuleScopeSchema = z.enum(
  providerConversionRuleScopes,
);

/**
 * Origem normalizada de uma regra (usada na precedencia e no "Unificar").
 * whatsapp_label = etiqueta do WhatsApp (Uazapi); automation_umbler = callback
 * assinado da automacao Umbler; automation_payt = postback de venda da Payt;
 * automation_unnichat = fluxo do Unnichat chamando a URL da regra (Fase 4b).
 * As automacoes por URL ficam sempre ligadas a uma conexao.
 */
export const providerConversionRuleOrigins = [
  "message_phrase",
  "structured_catalog",
  "whatsapp_label",
  "automation_umbler",
  "automation_payt",
  "automation_unnichat",
] as const;
export const providerConversionRuleOriginSchema = z.enum(
  providerConversionRuleOrigins,
);

/** Texto de UI: a regra especifica DESLIGA a global naquele numero. */
export const providerConversionRuleGlobalPrecedence =
  "specific_rule_replaces_global_on_number" as const;

export const providerConversionMessageAuthorScopes = [
  "team",
  "contact",
  "both",
] as const;
export const providerConversionMessageAuthorScopeSchema = z.enum(
  providerConversionMessageAuthorScopes,
);

export const messagePhraseValueModes = ["fixed", "message_extracted"] as const;
export const messagePhraseValueModeSchema = z.enum(messagePhraseValueModes);

/**
 * message_phrase rules reuse ConversionRule.defaultItems (Json?) to persist the
 * value pipeline. Catalog and legacy rules keep storing product item arrays, so
 * the object shape below is the only accepted message_phrase payload.
 */
export const messagePhraseConfigKind = "message_phrase_config_v1";

export const messagePhraseConfigSchema = z.object({
  kind: z.literal(messagePhraseConfigKind),
  valueMode: messagePhraseValueModeSchema,
  exampleMessage: z.string().max(2_000).nullable(),
});

/** Rules created before U2 have `defaultItems` null or an item array: fixed value. */
export function readMessagePhraseConfig(
  value: unknown,
): z.infer<typeof messagePhraseConfigSchema> {
  const parsed = messagePhraseConfigSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : {
        kind: messagePhraseConfigKind,
        valueMode: "fixed",
        exampleMessage: null,
      };
}

export const providerConversionExecutionStatuses = [
  "observed",
  "eligible",
  "materialized",
  "duplicate",
  "blocked",
  "failed",
] as const;
export const providerConversionExecutionStatusSchema = z.enum(
  providerConversionExecutionStatuses,
);

const idSchema = z.string().trim().min(1).max(255);
const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());
const catalogTextSchema = z.string().trim().min(1).max(180);
const messageTriggerPhraseSchema = z.string().trim().min(3).max(240);
const catalogAttributeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9_]*$/);

export const conversionRuleCreateInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  triggerType: legacyConversionTriggerTypeSchema,
  triggerValue: z.string().trim().min(1).max(180),
  matchMode: conversionMatchModeSchema.default("contains"),
  eventName: conversionEventNameSchema,
  // Legacy field. New conversion sending uses the workspace MetaConversionDestination.
  pixelId: z.string().trim().min(1).max(80).nullable().optional(),
  defaultValueCents: z.number().int().positive().nullable().optional(),
  // Só BRL/USD/EUR; null = herdar a "Moeda das conversões" do workspace.
  defaultCurrency: ruleCurrencyInputSchema.nullable().optional(),
  defaultContentName: z.string().trim().min(1).max(180).nullable().optional(),
  defaultItems: z.array(conversionEventItemSchema).nullable().optional(),
  active: z.boolean().default(true),
});

export const conversionRuleUpdateInputSchema = conversionRuleCreateInputSchema
  .partial()
  .refine((input) => Object.keys(input).length > 0, {
    message: "Informe ao menos um campo para atualizar",
  });

export const conversionRuleSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  triggerType: conversionTriggerTypeSchema,
  triggerValue: z.string().min(1),
  matchMode: conversionMatchModeSchema,
  eventName: conversionEventNameSchema,
  // Legacy field. New conversion sending uses the workspace MetaConversionDestination.
  pixelId: z.string().nullable(),
  defaultValueCents: z.number().int().positive().nullable().optional(),
  defaultCurrency: z.string().trim().min(3).max(3).nullable().optional(),
  defaultContentName: z.string().trim().min(1).max(180).nullable().optional(),
  defaultItems: z.array(conversionEventItemSchema).nullable().optional(),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const conversionTriggerEvaluationInputSchema = z.object({
  messageText: z.string().trim().optional(),
  labels: z.array(z.string().trim().min(1)).default([]),
});

export const providerConversionCatalogAttributeInputSchema = z.object({
  key: catalogAttributeKeySchema,
  label: catalogTextSchema,
});

export const providerConversionCatalogVariantInputSchema = z.object({
  attributeValues: z.array(catalogTextSchema).min(1).max(2),
  aliases: z.array(z.array(catalogTextSchema).max(20)).max(2).default([]),
  valueCents: z.number().int().positive(),
  contentName: catalogTextSchema.nullable().optional(),
});

export const providerConversionCatalogInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    productName: catalogTextSchema,
    currency: ruleCurrencyInputSchema.default("BRL"),
    attributes: z
      .array(providerConversionCatalogAttributeInputSchema)
      .min(1)
      .max(2),
    variants: z
      .array(providerConversionCatalogVariantInputSchema)
      .min(1)
      .max(500),
  })
  .superRefine((catalog, context) => {
    const attributeKeys = new Set<string>();

    catalog.attributes.forEach((attribute, index) => {
      if (attributeKeys.has(attribute.key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Cada atributo do catalogo deve ter uma chave unica",
          path: ["attributes", index, "key"],
        });
      }
      attributeKeys.add(attribute.key);
    });

    catalog.variants.forEach((variant, index) => {
      if (variant.attributeValues.length !== catalog.attributes.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A variante deve informar um valor para cada atributo",
          path: ["variants", index, "attributeValues"],
        });
      }

      if (variant.aliases.length > catalog.attributes.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Os aliases devem acompanhar os atributos do catalogo",
          path: ["variants", index, "aliases"],
        });
      }
    });
  });

const uniqueChannelIdsSchema = z
  .array(idSchema)
  .max(100)
  .refine((channelIds) => new Set(channelIds).size === channelIds.length, {
    message: "Cada canal deve ser informado uma unica vez",
  });

const providerConversionRuleBaseSchema = z.object({
  name: z.string().trim().min(2).max(120),
  // Opcional apenas para regras de mensagem/catalogo/etiqueta que abrangem
  // numeros de varias conexoes (ou todos os numeros). A automacao Umbler
  // continua exigindo a conexao que recebe o callback.
  connectionId: idSchema.optional(),
  // Ausente = "specific_numbers" (comportamento historico).
  scope: providerConversionRuleScopeSchema.optional(),
  // Vazio somente quando scope = "all_numbers".
  channelIds: uniqueChannelIdsSchema.default([]),
  mode: providerConversionRuleModeSchema.default("observation"),
});

const providerConversionRuleBaseShape = providerConversionRuleBaseSchema.shape;

type ScopedRuleInput = {
  scope?: z.infer<typeof providerConversionRuleScopeSchema>;
  channelIds?: string[];
};

/** "Todos os numeros" nao recebe canais; "Numeros especificos" exige ao menos um. */
function refineRuleScopeChannels(
  input: ScopedRuleInput,
  context: z.RefinementCtx,
): void {
  const channelCount = input.channelIds?.length ?? 0;
  if (input.scope === "all_numbers") {
    if (channelCount > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Regras para todos os numeros nao recebem canais",
        path: ["channelIds"],
      });
    }
    return;
  }
  if (channelCount === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Selecione ao menos um numero",
      path: ["channelIds"],
    });
  }
}

const providerConversionMessageRuleShape = {
  triggerPhrases: z
    .array(messageTriggerPhraseSchema)
    .min(1)
    .max(20)
    .refine(
      (phrases) =>
        new Set(phrases.map((phrase) => phrase.toLocaleLowerCase("pt-BR")))
          .size === phrases.length,
      { message: "Cada frase gatilho deve ser informada uma unica vez" },
    ),
  messageAuthorScope: providerConversionMessageAuthorScopeSchema,
};

const messagePhraseExampleSchema = z.string().trim().max(2_000);

type ValuedRuleInput = {
  eventName: z.infer<typeof conversionEventNameSchema>;
  valueMode?: z.infer<typeof messagePhraseValueModeSchema>;
  defaultValueCents?: number | null;
  defaultCurrency?: string | null;
  defaultContentName?: string | null;
};

/**
 * O evento decide o que pode ser configurado: eventos sem valor
 * (QualifiedLead, OrderShipped, ...) recusam qualquer campo monetario e
 * recusam extrair valor da mensagem; Purchase e InitiateCheckout exigem um
 * valor medio quando o modo e "fixed".
 */
function refineEventValueFields(
  input: ValuedRuleInput,
  context: z.RefinementCtx,
): void {
  if (!conversionEventCarriesValue(input.eventName)) {
    if (input.defaultValueCents != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Este evento nao envia valor monetario",
        path: ["defaultValueCents"],
      });
    }
    if (input.defaultContentName != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Este evento nao envia produto",
        path: ["defaultContentName"],
      });
    }
    if (input.valueMode === "message_extracted") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Este evento nao extrai valor da mensagem",
        path: ["valueMode"],
      });
    }
    return;
  }

  if (
    conversionEventRequiresValue(input.eventName) &&
    input.valueMode !== "message_extracted" &&
    !input.defaultValueCents
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Informe o valor medio para regras com valor fixo",
      path: ["defaultValueCents"],
    });
  }
}

/**
 * Eventos sem valor saem do parse sem nenhuma chave monetaria. Eventos com
 * valor mantem a moeda informada; sem moeda (ausente ou null) a regra fica
 * com moeda nula = "usar a Moeda das conversoes do workspace" (resolvida no
 * envio: venda -> regra -> workspace -> BRL). Regras ja gravadas com moeda
 * nao mudam. Manter os campos ausentes (em vez de nulos) em eventos sem valor
 * e o que impede o servico de gravar valor fantasma.
 *
 * O transform nao mexe em valueMode: o refine acima ja recusa
 * "message_extracted" em evento sem valor, e o default do proprio campo
 * garante "fixed".
 */
function normalizeEventValueFields<Input extends ValuedRuleInput>(
  input: Input,
): Input {
  if (conversionEventCarriesValue(input.eventName)) {
    return input;
  }

  const {
    defaultValueCents: _valueCents,
    defaultCurrency: _currency,
    defaultContentName: _contentName,
    ...rest
  } = input;

  return rest as Input;
}

const eventValueShape = {
  // Required when valueMode is "fixed"; optional fallback when extracting.
  defaultValueCents: z.number().int().positive().nullable().optional(),
  // Só BRL/USD/EUR; null/ausente = herdar a "Moeda das conversões" do workspace.
  defaultCurrency: ruleCurrencyInputSchema.nullable().optional(),
  defaultContentName: catalogTextSchema.nullable().optional(),
};

export const providerConversionRuleAdaptInputSchema = z.object({
  connectionId: idSchema,
  channelIds: uniqueChannelIdsSchema.pipe(z.array(idSchema).min(1)),
  triggerPhrases: providerConversionMessageRuleShape.triggerPhrases,
  messageAuthorScope: providerConversionMessageRuleShape.messageAuthorScope,
});

const providerAutomationCreateSchema = z
  .object({
    ...providerConversionRuleBaseShape,
    // Umbler callbacks select the automation server-side and leave this
    // empty. UAZAPI uses these as the WhatsApp label names to match.
    triggerPhrases:
      providerConversionMessageRuleShape.triggerPhrases.optional(),
    triggerLabels: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(240),
          name: messageTriggerPhraseSchema,
        }),
      )
      .min(1)
      .max(50)
      .optional(),
    ...eventValueShape,
    triggerType: z.literal("provider_automation"),
    eventName: conversionEventNameSchema,
    // Fase 4a: "payt" = regra de venda da Payt (URL propria da regra).
    automationSource: providerConversionAutomationSourceSchema.optional(),
    // Fase 5.3: só plataformas de venda (Payt). Vazio = todos os produtos.
    productFilterCodes: saleProductFilterCodesSchema.optional(),
    // Fase 5.3: false = a regra recebe só pela URL única da integração (a URL
    // própria da regra nasce desativada). Ausente = comportamento histórico.
    perRuleUrl: z.boolean().optional(),
  })
  .superRefine((input, context) => {
    refineRuleScopeChannels(input, context);
    if (input.automationSource !== "payt") {
      refineEventValueFields(input, context);
      if (input.productFilterCodes && input.productFilterCodes.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Filtro de produto só existe para plataformas de venda",
          path: ["productFilterCodes"],
        });
      }
      return;
    }
    // A Payt traz o valor real de cada venda; o evento vem do status.
    if (!(paytSaleEventNames as readonly string[]).includes(input.eventName)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A Payt envia compra aprovada, Pix/boleto gerado ou carrinho abandonado",
        path: ["eventName"],
      });
    }
    if (input.triggerPhrases || input.triggerLabels) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A automação da Payt não usa etiquetas",
        path: ["triggerPhrases"],
      });
    }
  })
  .transform(normalizeEventValueFields);

const messagePhraseCreateSchema = z
  .object({
    ...providerConversionRuleBaseShape,
    ...providerConversionMessageRuleShape,
    ...eventValueShape,
    triggerType: z.literal("message_phrase"),
    eventName: conversionEventNameSchema,
    valueMode: messagePhraseValueModeSchema.default("fixed"),
    exampleMessage: messagePhraseExampleSchema.nullable().optional(),
  })
  .superRefine((input, context) => {
    refineRuleScopeChannels(input, context);
    refineEventValueFields(input, context);
  })
  .transform(normalizeEventValueFields);

const structuredCatalogCreateSchema = z
  .object({
    ...providerConversionRuleBaseShape,
    ...providerConversionMessageRuleShape,
    triggerType: z.literal("structured_catalog"),
    eventName: z.literal("Purchase"),
    catalog: providerConversionCatalogInputSchema,
  })
  .superRefine(refineRuleScopeChannels);

export const providerConversionRuleCreateInputSchema = z.union([
  providerAutomationCreateSchema,
  messagePhraseCreateSchema,
  structuredCatalogCreateSchema,
]);

/** Chave aleatoria (nao secreta) da tentativa; os bytes exatos sao a identidade. */
export const providerRuleCreateRequestKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/);

// Requisicoes com chave nao podem descartar campos desconhecidos antes do
// hash. Percorre os formatos de entrada antes dos transforms (inclui catalogo).
function rejectUnknownCreateFields(
  input: unknown,
  schema: z.ZodTypeAny,
  context: z.RefinementCtx,
  path: (string | number)[] = [],
): void {
  if (schema instanceof z.ZodEffects)
    return rejectUnknownCreateFields(input, schema.innerType(), context, path);
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    return rejectUnknownCreateFields(
      input,
      schema._def.innerType,
      context,
      path,
    );
  }
  if (schema instanceof z.ZodArray && Array.isArray(input)) {
    input.forEach((value, index) =>
      rejectUnknownCreateFields(value, schema.element, context, [
        ...path,
        index,
      ]),
    );
  } else if (
    schema instanceof z.ZodObject &&
    input &&
    typeof input === "object" &&
    !Array.isArray(input)
  ) {
    for (const [key, value] of Object.entries(input)) {
      if (!Object.prototype.hasOwnProperty.call(schema.shape, key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Campo nao permitido",
          path: [...path, key],
        });
      } else {
        rejectUnknownCreateFields(value, schema.shape[key], context, [
          ...path,
          key,
        ]);
      }
    }
  }
}

/**
 * Criacao idempotente (header Idempotency-Key): mesmo contrato da criacao
 * comum, mas recusa campos desconhecidos para o hash da intencao ser exato.
 */
export const providerConversionRuleIdempotentCreateInputSchema = z
  .unknown()
  .superRefine((input, context) => {
    const triggerType =
      input && typeof input === "object" && "triggerType" in input
        ? input.triggerType
        : null;
    const schema =
      triggerType === "provider_automation"
        ? providerAutomationCreateSchema
        : triggerType === "message_phrase"
          ? messagePhraseCreateSchema
          : structuredCatalogCreateSchema;
    rejectUnknownCreateFields(input, schema, context);
  })
  .pipe(providerConversionRuleCreateInputSchema);

export const providerConversionRuleUpdateInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    // Trocar para "all_numbers" remove os numeros escolhidos; voltar para
    // "specific_numbers" exige channelIds (de qualquer conexao do workspace).
    scope: providerConversionRuleScopeSchema.optional(),
    channelIds: uniqueChannelIdsSchema
      .pipe(z.array(idSchema).min(1))
      .optional(),
    mode: providerConversionRuleModeSchema.optional(),
    defaultValueCents: z.number().int().positive().nullable().optional(),
    defaultCurrency: ruleCurrencyInputSchema.nullable().optional(),
    defaultContentName: catalogTextSchema.nullable().optional(),
    valueMode: messagePhraseValueModeSchema.optional(),
    exampleMessage: messagePhraseExampleSchema.nullable().optional(),
    triggerPhrases: z
      .array(messageTriggerPhraseSchema)
      .min(1)
      .max(20)
      .optional(),
    triggerLabels: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(240),
          name: messageTriggerPhraseSchema,
        }),
      )
      .min(1)
      .max(50)
      .optional(),
    messageAuthorScope: providerConversionMessageAuthorScopeSchema.optional(),
    catalog: providerConversionCatalogInputSchema.optional(),
    active: z.boolean().optional(),
    // Fase 5.3: só regras de plataforma de venda (Payt). [] = todos.
    productFilterCodes: saleProductFilterCodesSchema.optional(),
    // Fase 5.3, "Desativar URL antiga": true fecha a URL própria da regra
    // (ela continua recebendo pela URL única); false reabre. Desativar exige
    // confirmPublicUrlDisable: true, porque a plataforma pode ainda postar ali.
    publicUrlDisabled: z.boolean().optional(),
    confirmPublicUrlDisable: z.literal(true).optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: "Informe ao menos um campo para atualizar",
  })
  .refine((input) => !(input.scope === "all_numbers" && input.channelIds), {
    message: "Regras para todos os numeros nao recebem canais",
    path: ["channelIds"],
  })
  .refine(
    (input) =>
      input.publicUrlDisabled !== true ||
      input.confirmPublicUrlDisable === true,
    {
      message:
        "Confirme a desativação: o que a plataforma ainda mandar para a URL antiga deixa de ser recebido",
      path: ["confirmPublicUrlDisable"],
    },
  )
  .refine(
    (input) =>
      input.confirmPublicUrlDisable === undefined ||
      input.publicUrlDisabled === true,
    {
      message: "A confirmação só acompanha a desativação da URL antiga",
      path: ["confirmPublicUrlDisable"],
    },
  );

export const providerConversionEndpointSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  providerRuleId: idSchema,
  secretVersion: z.number().int().positive(),
  lastDeliveryAt: z.string().datetime().nullable(),
  lastSuccessfulParseAt: z.string().datetime().nullable(),
  rotatedAt: z.string().datetime().nullable(),
  removedAt: z.string().datetime().nullable(),
  // Fase 5.3: "Desativar URL antiga" (opcional para respostas anteriores).
  publicUrlDisabledAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const providerConversionEndpointSecretResultSchema = z.object({
  endpoint: providerConversionEndpointSchema,
  webhookUrl: z.string().url(),
});

export const providerConversionCatalogAttributeSchema =
  providerConversionCatalogAttributeInputSchema.extend({
    id: idSchema,
    position: z.number().int().min(1).max(2),
  });

export const providerConversionCatalogVariantSchema =
  providerConversionCatalogVariantInputSchema.extend({
    id: idSchema,
    normalizedKey: z.string().min(1).max(500),
    active: z.boolean(),
  });

export const providerConversionCatalogSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  productName: z.string().min(1),
  currency: z.string().length(3),
  active: z.boolean(),
  attributes: z.array(providerConversionCatalogAttributeSchema).min(1).max(2),
  variants: z.array(providerConversionCatalogVariantSchema),
});

export const structuredCatalogMatchReasonCodes = [
  "matched",
  "rule_inactive",
  "catalog_inactive",
  "trigger_missing",
  "empty_template",
  "awaiting_data",
  "missing_attribute",
  "incomplete_item",
  "ambiguous_attribute",
  "unknown_combination",
  "ambiguous_variant",
  "invalid_quantity",
  "missing_price",
  "ambiguous_price",
  "price_mismatch",
] as const;

export const structuredCatalogMatchReasonCodeSchema = z.enum(
  structuredCatalogMatchReasonCodes,
);

export const structuredCatalogTestMessageInputSchema = z.object({
  messageText: z.string().trim().min(1).max(8_192),
});

export const structuredCatalogParsedAttributeSchema = z.object({
  key: catalogAttributeKeySchema,
  label: catalogTextSchema,
  value: catalogTextSchema,
});

export const structuredCatalogParsedItemSchema = z.object({
  position: z.number().int().positive(),
  quantity: z.number().int().positive().max(100),
  parsedAttributes: z.array(structuredCatalogParsedAttributeSchema).max(2),
  catalogVariantId: idSchema.nullable(),
  unitValueCents: z.number().int().positive().nullable(),
  subtotalValueCents: z.number().int().positive().nullable(),
  contentName: catalogTextSchema.nullable(),
  reasonCode: structuredCatalogMatchReasonCodeSchema,
});

export const structuredCatalogMatchClassificationSchema = z.enum([
  "recognized",
  "awaiting_data",
  "review_required",
  "ignored",
]);

export const structuredCatalogTestMessageResultSchema = z.object({
  matched: z.boolean(),
  reasonCode: structuredCatalogMatchReasonCodeSchema,
  classification: structuredCatalogMatchClassificationSchema,
  matchedTriggerPhrase: messageTriggerPhraseSchema.nullable(),
  parsedAttributes: z.array(structuredCatalogParsedAttributeSchema).max(2),
  items: z.array(structuredCatalogParsedItemSchema).max(100),
  parsedValueCents: z.number().int().positive().nullable(),
  calculatedValueCents: z.number().int().positive().nullable(),
  observedPaymentValueCents: z.number().int().positive().nullable(),
  catalogVariantId: idSchema.nullable(),
  contentName: catalogTextSchema.nullable(),
  currency: currencySchema.nullable(),
});

export const providerConversionExecutionSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  providerRuleId: idSchema,
  sourceDeliveryId: idSchema,
  channelId: idSchema.nullable(),
  externalExecutionKey: z.string().min(1).max(500),
  occurredAt: z.string().datetime(),
  status: providerConversionExecutionStatusSchema,
  reasonCode: z.string().min(1).max(120).nullable(),
  matchedCatalogVariantId: idSchema.nullable(),
  valueCents: z.number().int().positive().nullable(),
  currency: z.string().length(3).nullable(),
  leadId: idSchema.nullable(),
  conversionEventLogId: idSchema.nullable(),
  attemptCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * Telefone cuja regra global roda num canal que ainda esta em observacao
 * (conexao fora de producao) enquanto outro canal do mesmo telefone esta em
 * producao: a tela avisa ("a regra so observa este numero").
 */
const observationCanonicalChannelsSchema = z.array(
  z.object({
    canonicalChannelId: idSchema,
    productionChannelIds: z.array(idSchema).min(1),
  }),
);

export const providerConversionRuleSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  conversionRule: conversionRuleSchema,
  // Null: regra de mensagem/catalogo/etiqueta sem vinculo com uma conexao.
  connectionId: idSchema.nullable(),
  mode: providerConversionRuleModeSchema,
  parserReleaseId: idSchema.nullable(),
  productionActivatedAt: z.string().datetime().nullable(),
  // Campos do alcance: opcionais para aceitar respostas anteriores a eles
  // (ausente = "specific_numbers", efetivo = channelIds).
  scope: providerConversionRuleScopeSchema.optional(),
  origin: providerConversionRuleOriginSchema.nullable().optional(),
  // Numeros escolhidos (vazio em "all_numbers").
  channelIds: z.array(idSchema),
  // Numeros em que a regra e avaliada agora: os escolhidos, ou todo numero
  // compativel do workspace menos os substituidos/duplicados.
  effectiveChannelIds: z.array(idSchema).optional(),
  // Somente "all_numbers": numeros em que uma regra especifica da mesma
  // origem e do mesmo evento substitui esta regra ("Substituida em X").
  overriddenChannelIds: z.array(idSchema).optional(),
  // Somente "all_numbers": para cada numero substituido, as regras
  // especificas que valem nele.
  overriddenBy: z
    .array(
      z.object({
        channelId: idSchema,
        providerRuleIds: z.array(idSchema),
      }),
    )
    .optional(),
  // Somente "all_numbers": numeros cujo telefone ja e avaliado por outro
  // canal (mesmo telefone em dois provedores/instancias): a regra roda uma
  // vez por telefone.
  duplicatePhoneChannelIds: z.array(idSchema).optional(),
  observationCanonicalChannels: observationCanonicalChannelsSchema.optional(),
  globalPrecedence: z
    .literal(providerConversionRuleGlobalPrecedence)
    .optional(),
  // Regra global que substituiu esta via "Unificar" (historico preservado).
  unifiedIntoRuleId: idSchema.nullable().optional(),
  triggerPhrases: z.array(messageTriggerPhraseSchema),
  messageAuthorScope: providerConversionMessageAuthorScopeSchema.nullable(),
  // message_phrase value pipeline; "fixed" for every other trigger type.
  valueMode: messagePhraseValueModeSchema.default("fixed"),
  exampleMessage: z.string().max(2_000).nullable().default(null),
  // Fase 4a: plataforma que chama a URL da regra (opcional para respostas
  // anteriores ao campo).
  automationSource: providerConversionAutomationSourceSchema
    .nullable()
    .optional(),
  // Fase 5.3: códigos de produto aceitos pela regra (vazio = todos).
  productFilterCodes: z.array(z.string()).optional(),
  endpoint: providerConversionEndpointSchema.nullable(),
  catalog: providerConversionCatalogSchema.nullable(),
  lastExecution: providerConversionExecutionSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const providerConversionRuleListSchema = z.array(
  providerConversionRuleSchema,
);

export const providerConversionRuleCreateResultSchema = z.object({
  rule: providerConversionRuleSchema,
  webhookUrl: z.string().url().nullable(),
});

/** Recibo sem snapshot da regra, sem credencial de endpoint e sem payload. */
export const providerRuleCreateReceiptSchema = z
  .object({
    ruleId: idSchema,
    connectionId: idSchema.nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

// Sem a chave, o contrato antigo de criacao continua igual.
export const providerConversionRuleIdempotentCreateResultSchema =
  z.discriminatedUnion("outcome", [
    z
      .object({
        outcome: z.literal("created"),
        receipt: providerRuleCreateReceiptSchema,
        rule: providerConversionRuleSchema,
        webhookUrl: z.string().url().nullable(),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("replayed"),
        receipt: providerRuleCreateReceiptSchema,
      })
      .strict(),
  ]);

export const providerRuleCreateReceiptLookupResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("found"),
        receipt: providerRuleCreateReceiptSchema,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("absent"),
        code: z.literal("provider_rule_create_receipt_absent"),
      })
      .strict(),
  ],
);

/** "Unificar": regras iguais em varios numeros viram uma regra global. */
export const providerConversionRuleUnifyCandidateSchema = z.object({
  // Assinatura estavel do grupo (origem + evento + gatilho + valor + modo).
  key: z.string().min(1).max(128),
  origin: providerConversionRuleOriginSchema,
  eventName: conversionEventNameSchema,
  mode: providerConversionRuleModeSchema,
  name: z.string().min(1),
  triggerPhrases: z.array(z.string()),
  ruleIds: z.array(idSchema).min(2),
  // Numeros hoje cobertos pelas regras do grupo.
  channelIds: z.array(idSchema),
  // Numeros compativeis que passariam a ser cobertos pela regra global.
  newlyCoveredChannelIds: z.array(idSchema),
  // Numeros em que outra regra especifica (fora do grupo) continuara valendo.
  overriddenChannelIds: z.array(idSchema),
  // Numeros cujo telefone ja seria avaliado por outro canal.
  duplicatePhoneChannelIds: z.array(idSchema).optional(),
  observationCanonicalChannels: observationCanonicalChannelsSchema.optional(),
  // Regra global identica ja existente, que sera reaproveitada.
  existingGlobalRuleId: idSchema.nullable(),
});

export const providerConversionRuleUnifyCandidatesSchema = z.object({
  groups: z.array(providerConversionRuleUnifyCandidateSchema),
});

export const providerConversionRuleUnifyInputSchema = z.object({
  ruleIds: z
    .array(idSchema)
    .min(2)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Cada regra deve ser informada uma unica vez",
    }),
  name: z.string().trim().min(2).max(120).optional(),
});

export const providerConversionRuleUnifyResultSchema = z.object({
  // created: nova regra global; reused_existing: regra global identica ja
  // existia; replayed: estas regras ja tinham sido unificadas (idempotente).
  outcome: z.enum(["created", "reused_existing", "replayed"]),
  rule: providerConversionRuleSchema,
  deactivatedRuleIds: z.array(idSchema),
  newlyCoveredChannelIds: z.array(idSchema),
});

/**
 * Provedores de numero (InboundWebhookConnection.provider) em que cada origem
 * e avaliada nesta edicao. WAHA, Z-API e NOD API ainda nao entram em regras
 * (nem globais nem especificas): aparecem em unsupportedWhatsappProviders.
 */
export const providerConversionRuleOriginCapabilitySchema = z.object({
  origin: providerConversionRuleOriginSchema,
  scopes: z.array(providerConversionRuleScopeSchema),
  channelProviders: z.array(z.string().min(1)),
  // Somente message_phrase: provedores por autor da mensagem.
  authorChannelProviders: z
    .object({
      team: z.array(z.string().min(1)),
      contact: z.array(z.string().min(1)),
    })
    .nullable(),
  // Alcance: true = os números da regra ficam limitados à conexão que recebe
  // o callback (Umbler). A Payt é false: os números podem ser de qualquer
  // conexão de WhatsApp do workspace.
  connectionBound: z.boolean(),
  // true: a regra precisa de uma conexão de WhatsApp ao ser criada (âncora do
  // endereço assinado): Umbler e Payt. Ausente em respostas antigas = false.
  requiresConnection: z.boolean().optional(),
  // whatsapp_label: "Todos os numeros" e numeros de conexoes diferentes casam
  // a etiqueta pelo nome (ids de etiqueta valem so dentro de uma instancia).
  labelMatch: z.enum(["id_or_name", "name_across_instances"]).nullable(),
  // Origens que podem ser unificadas.
  unifiable: z.boolean(),
  // Eventos que a origem reconhece (ausente = todo o catalogo).
  eventNames: z.array(conversionEventNameSchema).optional(),
  // Eventos ainda em beta nessa origem (selo "beta" na tela).
  betaEventNames: z.array(conversionEventNameSchema).optional(),
});

export const providerConversionRuleCapabilitiesSchema = z.object({
  // Sempre true nesta edicao (sem variavel de ambiente). Mantido para a tela.
  workspaceScopeEnabled: z.literal(true),
  globalPrecedence: z.literal(providerConversionRuleGlobalPrecedence),
  origins: z.array(providerConversionRuleOriginCapabilitySchema),
  unsupportedWhatsappProviders: z.array(z.string().min(1)),
});

/**
 * Regra antiga (palavra-chave ou etiqueta sem configuracao de provedor),
 * listada em Conversoes como "Regra antiga". Pausar e editar valor usam
 * PATCH /conversion-rules/:id; "conectar a numeros" usa
 * POST /conversion-rules/providers/adapt/:ruleId quando adaptable = true.
 */
export const legacyConversionRuleSchema = conversionRuleSchema.extend({
  kind: z.literal("legacy"),
  adaptable: z.boolean(),
  // Motivo quando adaptable = false (texto para o aluno).
  adaptBlockedReason: z
    .enum(["not_keyword_purchase", "missing_value"])
    .nullable(),
});
export const legacyConversionRuleListSchema = z.array(
  legacyConversionRuleSchema,
);

export const providerConversionAutomationReprocessResultSchema = z.object({
  executionId: idSchema,
  sourceDeliveryId: idSchema,
  queueStatus: z.enum(["queued", "existing"]),
});

export const providerConversionAutomationAuditStatusSchema = z.enum([
  "observed",
  "eligible",
  "materialized",
  "duplicate",
  "blocked",
  "failed",
  "ignored",
  "invalid_payload",
]);

export const providerConversionAutomationAuditItemSchema = z.object({
  deliveryId: idSchema,
  executionId: idSchema.nullable(),
  receivedAt: z.string().datetime(),
  lastReceivedAt: z.string().datetime(),
  providerEventType: z.string().trim().min(1).max(120).nullable(),
  eventName: conversionEventNameSchema.nullable(),
  automation: z.string().trim().min(1).max(120).nullable(),
  status: providerConversionAutomationAuditStatusSchema,
  reasonCode: z.string().trim().min(1).max(160).nullable(),
  attemptCount: z.number().int().positive(),
  executionAttemptCount: z.number().int().nonnegative(),
  channel: z
    .object({
      id: idSchema,
      name: z.string().trim().min(1).max(160).nullable(),
      connectedPhone: z.string().trim().min(1).max(32),
    })
    .nullable(),
  leadResolved: z.boolean(),
  payloadAvailable: z.boolean(),
  payloadExpiresAt: z.string().datetime(),
  reprocessable: z.boolean(),
});

export const providerConversionAutomationAuditSchema = z.object({
  providerRuleId: idSchema,
  summary: z.object({
    total: z.number().int().nonnegative(),
    observed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    materialized: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    recoverable: z.number().int().nonnegative(),
  }),
  items: z.array(providerConversionAutomationAuditItemSchema).max(100),
});

/**
 * Auditoria por execucao da regra, independente de PurchaseReview. Regras que
 * nao materializam compra (InitiateCheckout, QualifiedLead, ...) so existem
 * como ProviderConversionRuleExecution; este contrato e o que o painel mostra
 * para elas.
 */
export const providerConversionRuleExecutionAuditItemSchema = z.object({
  executionId: idSchema,
  sourceDeliveryId: idSchema,
  occurredAt: z.string().datetime(),
  status: providerConversionExecutionStatusSchema,
  reasonCode: z.string().trim().min(1).max(160).nullable(),
  matchedTriggerPhrase: z.string().trim().min(1).max(240).nullable(),
  channel: z
    .object({
      id: idSchema,
      name: z.string().trim().min(1).max(160).nullable(),
      connectedPhone: z.string().trim().min(1).max(32),
    })
    .nullable(),
  leadId: idSchema.nullable(),
  leadName: z.string().trim().min(1).max(180).nullable(),
  phoneDisplay: z.string().trim().min(1).max(40).nullable(),
  valueCents: z.number().int().positive().nullable(),
  currency: currencySchema.nullable(),
  conversionEventLogId: idSchema.nullable(),
  purchaseReviewId: idSchema.nullable(),
  attemptCount: z.number().int().nonnegative(),
  processedAt: z.string().datetime().nullable(),
  /**
   * Estado tecnico da entrega gravado pela producao. Sem ele o painel so sabia
   * dizer "Falhou" e nao conseguia distinguir uma falha transitoria (que a fila
   * ainda vai tentar de novo) de uma permanente (que exige acao do operador).
   */
  technicalDelivery: z
    .object({
      state: providerConversionTechnicalDeliveryStateSchema,
      retryable: z.boolean(),
      reasonCode: z.string().trim().min(1).max(160).nullable(),
      updatedAt: z.string().datetime().nullable(),
    })
    .nullable(),
  /** Codigo bruto da ultima falha de producao, para diagnostico do operador. */
  lastProductionFailure: z
    .object({
      code: z.string().trim().min(1).max(160),
      failedAt: z.string().datetime().nullable(),
    })
    .nullable(),
});

export const providerConversionRuleExecutionAuditSchema = z.object({
  providerRuleId: idSchema,
  eventName: conversionEventNameSchema,
  summary: z.object({
    total: z.number().int().nonnegative(),
    observed: z.number().int().nonnegative(),
    eligible: z.number().int().nonnegative(),
    materialized: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  items: z.array(providerConversionRuleExecutionAuditItemSchema).max(50),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    totalItems: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
});

export const providerConversionRuleExecutionAuditQuerySchema = z.object({
  status: providerConversionExecutionStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(25),
});

export const providerConversionAutomationPayloadSchema = z.object({
  providerRuleId: idSchema,
  deliveryId: idSchema,
  receivedAt: z.string().datetime(),
  payloadExpiresAt: z.string().datetime(),
  payload: z.record(z.unknown()),
});

export const providerConversionAutomationReprocessBatchInputSchema = z.object({
  confirmation: z.literal("REPROCESSAR_CALLBACKS_SELECIONADOS"),
  deliveryIds: z.array(idSchema).min(1).max(50),
});

export const providerConversionAutomationReprocessBatchItemSchema = z.object({
  deliveryId: idSchema,
  executionId: idSchema.nullable(),
  // "observed": reavaliado com a regra em observacao (nunca enviado).
  status: z.enum([
    "queued",
    "existing",
    "eligible",
    "blocked",
    "skipped",
    "observed",
  ]),
  reasonCode: z.string().trim().min(1).max(160).nullable(),
  message: z.string().trim().min(1).max(500),
});

export const providerConversionAutomationReprocessBatchResultSchema = z.object({
  providerRuleId: idSchema,
  requested: z.number().int().positive().max(50),
  queued: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative().optional(),
  items: z.array(providerConversionAutomationReprocessBatchItemSchema).max(50),
});

export const purchaseReviewStatuses = [
  "recognized",
  "awaiting_data",
  "review_required",
  "approved",
  "sent",
  "duplicate",
  "rejected",
  "failed",
  "corrected_after_send",
] as const;
export const purchaseReviewStatusSchema = z.enum(purchaseReviewStatuses);

export const purchaseReviewViews = ["actionable", "history", "all"] as const;
export const purchaseReviewViewSchema = z.enum(purchaseReviewViews);

export const purchaseReviewSourceTypes = [
  "provider_message",
  "provider_automation",
] as const;
export const purchaseReviewSourceTypeSchema = z.enum(purchaseReviewSourceTypes);

export const purchaseReviewItemSchema = z.object({
  id: idSchema,
  position: z.number().int().positive(),
  catalogVariantId: idSchema.nullable(),
  attributeValues: z.array(catalogTextSchema).max(2),
  quantity: z.number().int().positive().max(100),
  unitValueCents: z.number().int().positive().nullable(),
  subtotalValueCents: z.number().int().positive().nullable(),
  contentName: catalogTextSchema.nullable(),
});

export const purchaseReviewSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  providerRuleId: idSchema,
  ruleName: z.string().min(1),
  sourceDeliveryId: idSchema,
  channelId: idSchema.nullable(),
  channelName: z.string().nullable(),
  occurredAt: z.string().datetime(),
  sourceType: purchaseReviewSourceTypeSchema,
  messageAuthorType: z.string().nullable(),
  matchedTriggerPhrase: z.string().nullable(),
  status: purchaseReviewStatusSchema,
  classificationCode: z.string().min(1).max(120),
  reasonCode: z.string().max(160).nullable(),
  leadId: idSchema.nullable(),
  leadName: z.string().nullable(),
  phoneDisplay: z.string().nullable(),
  items: z.array(purchaseReviewItemSchema),
  calculatedValueCents: z.number().int().positive().nullable(),
  effectiveValueCents: z.number().int().positive().nullable(),
  observedPaymentValueCents: z.number().int().positive().nullable(),
  currency: currencySchema,
  conversionEventLogId: idSchema.nullable(),
  decisionReason: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const purchaseReviewListQuerySchema = z.object({
  view: purchaseReviewViewSchema.default("actionable"),
  status: purchaseReviewStatusSchema.optional(),
  providerRuleId: idSchema.optional(),
  channelId: idSchema.optional(),
  since: z.string().date().optional(),
  until: z.string().date().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const purchaseReviewListSchema = z.object({
  reviews: z.array(purchaseReviewSchema),
  pendingCount: z.number().int().nonnegative(),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    totalItems: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
});

export const purchaseReviewLineItemInputSchema = z.object({
  catalogVariantId: idSchema,
  quantity: z.number().int().positive().max(100),
});

export const purchaseReviewItemsUpdateInputSchema = z.object({
  items: z.array(purchaseReviewLineItemInputSchema).min(1).max(100),
  reason: z.string().trim().min(3).max(500),
});

export const purchaseReviewDecisionInputSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const purchaseReviewCorrectionInputSchema =
  purchaseReviewItemsUpdateInputSchema;

export const conversionRuleListSchema = z.array(conversionRuleSchema);

export type ConversionTriggerTypeDto = z.infer<
  typeof conversionTriggerTypeSchema
>;
export type ConversionMatchModeDto = z.infer<typeof conversionMatchModeSchema>;
export type ConversionRuleCreateInputDto = z.infer<
  typeof conversionRuleCreateInputSchema
>;
export type ConversionRuleUpdateInputDto = z.infer<
  typeof conversionRuleUpdateInputSchema
>;
export type ConversionRuleDto = z.infer<typeof conversionRuleSchema>;
export type ConversionTriggerEvaluationInputDto = z.infer<
  typeof conversionTriggerEvaluationInputSchema
>;
export type LegacyConversionTriggerTypeDto = z.infer<
  typeof legacyConversionTriggerTypeSchema
>;
export type ProviderConversionTriggerTypeDto = z.infer<
  typeof providerConversionTriggerTypeSchema
>;
export type ProviderConversionRuleModeDto = z.infer<
  typeof providerConversionRuleModeSchema
>;
export type ProviderConversionAutomationSourceDto = z.infer<
  typeof providerConversionAutomationSourceSchema
>;
export type ProviderConversionMessageAuthorScopeDto = z.infer<
  typeof providerConversionMessageAuthorScopeSchema
>;
export type MessagePhraseValueModeDto = z.infer<
  typeof messagePhraseValueModeSchema
>;
export type MessagePhraseConfigDto = z.infer<typeof messagePhraseConfigSchema>;
export type ProviderConversionExecutionStatusDto = z.infer<
  typeof providerConversionExecutionStatusSchema
>;
export type ProviderConversionCatalogInputDto = z.infer<
  typeof providerConversionCatalogInputSchema
>;
export type ProviderConversionRuleCreateInputDto = z.infer<
  typeof providerConversionRuleCreateInputSchema
>;
export type ProviderConversionRuleAdaptInputDto = z.infer<
  typeof providerConversionRuleAdaptInputSchema
>;
export type ProviderConversionRuleUpdateInputDto = z.infer<
  typeof providerConversionRuleUpdateInputSchema
>;
export type ProviderConversionEndpointDto = z.infer<
  typeof providerConversionEndpointSchema
>;
export type ProviderConversionEndpointSecretResultDto = z.infer<
  typeof providerConversionEndpointSecretResultSchema
>;
export type ProviderConversionCatalogDto = z.infer<
  typeof providerConversionCatalogSchema
>;
export type StructuredCatalogMatchReasonCodeDto = z.infer<
  typeof structuredCatalogMatchReasonCodeSchema
>;
export type StructuredCatalogTestMessageInputDto = z.infer<
  typeof structuredCatalogTestMessageInputSchema
>;
export type StructuredCatalogTestMessageResultDto = z.infer<
  typeof structuredCatalogTestMessageResultSchema
>;
export type ProviderConversionRuleDto = z.infer<
  typeof providerConversionRuleSchema
>;
export type ProviderConversionRuleScopeDto = z.infer<
  typeof providerConversionRuleScopeSchema
>;
export type ProviderConversionRuleOriginDto = z.infer<
  typeof providerConversionRuleOriginSchema
>;
export type ProviderRuleCreateReceiptDto = z.infer<
  typeof providerRuleCreateReceiptSchema
>;
export type ProviderConversionRuleIdempotentCreateResultDto = z.infer<
  typeof providerConversionRuleIdempotentCreateResultSchema
>;
export type ProviderRuleCreateReceiptLookupResultDto = z.infer<
  typeof providerRuleCreateReceiptLookupResultSchema
>;
export type ProviderConversionRuleUnifyCandidateDto = z.infer<
  typeof providerConversionRuleUnifyCandidateSchema
>;
export type ProviderConversionRuleUnifyCandidatesDto = z.infer<
  typeof providerConversionRuleUnifyCandidatesSchema
>;
export type ProviderConversionRuleUnifyInputDto = z.infer<
  typeof providerConversionRuleUnifyInputSchema
>;
export type ProviderConversionRuleUnifyResultDto = z.infer<
  typeof providerConversionRuleUnifyResultSchema
>;
export type ProviderConversionRuleOriginCapabilityDto = z.infer<
  typeof providerConversionRuleOriginCapabilitySchema
>;
export type ProviderConversionRuleCapabilitiesDto = z.infer<
  typeof providerConversionRuleCapabilitiesSchema
>;
export type LegacyConversionRuleDto = z.infer<typeof legacyConversionRuleSchema>;
export type ProviderConversionRuleCreateResultDto = z.infer<
  typeof providerConversionRuleCreateResultSchema
>;
export type ProviderConversionAutomationReprocessResultDto = z.infer<
  typeof providerConversionAutomationReprocessResultSchema
>;
export type ProviderConversionAutomationAuditStatusDto = z.infer<
  typeof providerConversionAutomationAuditStatusSchema
>;
export type ProviderConversionAutomationAuditItemDto = z.infer<
  typeof providerConversionAutomationAuditItemSchema
>;
export type ProviderConversionAutomationAuditDto = z.infer<
  typeof providerConversionAutomationAuditSchema
>;
export type ProviderConversionAutomationPayloadDto = z.infer<
  typeof providerConversionAutomationPayloadSchema
>;
export type ProviderConversionAutomationReprocessBatchInputDto = z.infer<
  typeof providerConversionAutomationReprocessBatchInputSchema
>;
export type ProviderConversionAutomationReprocessBatchItemDto = z.infer<
  typeof providerConversionAutomationReprocessBatchItemSchema
>;
export type ProviderConversionAutomationReprocessBatchResultDto = z.infer<
  typeof providerConversionAutomationReprocessBatchResultSchema
>;
export type ProviderConversionExecutionDto = z.infer<
  typeof providerConversionExecutionSchema
>;
export type ProviderConversionRuleExecutionAuditItemDto = z.infer<
  typeof providerConversionRuleExecutionAuditItemSchema
>;
export type ProviderConversionRuleExecutionAuditDto = z.infer<
  typeof providerConversionRuleExecutionAuditSchema
>;
export type ProviderConversionRuleExecutionAuditQueryDto = z.infer<
  typeof providerConversionRuleExecutionAuditQuerySchema
>;
export type StructuredCatalogParsedItemDto = z.infer<
  typeof structuredCatalogParsedItemSchema
>;
export type PurchaseReviewStatusDto = z.infer<
  typeof purchaseReviewStatusSchema
>;
export type PurchaseReviewViewDto = z.infer<typeof purchaseReviewViewSchema>;
export type PurchaseReviewDto = z.infer<typeof purchaseReviewSchema>;
export type PurchaseReviewListQueryDto = z.infer<
  typeof purchaseReviewListQuerySchema
>;
export type PurchaseReviewListDto = z.infer<typeof purchaseReviewListSchema>;
export type PurchaseReviewItemsUpdateInputDto = z.infer<
  typeof purchaseReviewItemsUpdateInputSchema
>;
export type PurchaseReviewDecisionInputDto = z.infer<
  typeof purchaseReviewDecisionInputSchema
>;
export type PurchaseReviewCorrectionInputDto = z.infer<
  typeof purchaseReviewCorrectionInputSchema
>;
