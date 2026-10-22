import { z } from "zod";
import { ruleCurrencyInputSchema } from "../currency";
import {
  conversionEventCarriesValue,
  conversionEventRequiresValue,
} from "./conversion-event-catalog";
import { conversionEventNameSchema } from "./conversion-events";

const idSchema = z.string().trim().min(1).max(255);
// Moeda da regra: só BRL/USD/EUR (Fase 5.1).
const currencySchema = ruleCurrencyInputSchema;
const originSchema = z
  .string()
  .trim()
  .max(255)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        /^[a-z0-9-]+\.kommo\.com$/i.test(url.hostname)
      );
    } catch {
      return false;
    }
  }, "Informe apenas a origem HTTPS da conta Kommo");

export const kommoConnectionStatuses = ["active", "paused", "blocked"] as const;
export const kommoConnectionStatusSchema = z.enum(kommoConnectionStatuses);
export const kommoCatalogStates = ["empty", "fresh", "stale", "error"] as const;
export const kommoCatalogStateSchema = z.enum(kommoCatalogStates);
export const kommoRuleModes = ["observation", "production"] as const;
export const kommoRuleModeSchema = z.enum(kommoRuleModes);
export const kommoValueModes = ["lead_price", "fixed"] as const;
export const kommoValueModeSchema = z.enum(kommoValueModes);

export const kommoConnectionCreateInputSchema = z
  .object({
    displayName: z.string().trim().min(2).max(120),
    accountOrigin: originSchema,
    accessToken: z.string().trim().min(16).max(4096),
    allowedChannelRouteIds: z
      .array(idSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length)
      .default([]),
  })
  .strict();
export const kommoConnectionCredentialReplaceInputSchema = z
  .object({
    accountOrigin: originSchema.optional(),
    accessToken: z.string().trim().min(16).max(4096),
  })
  .strict();
export const kommoConnectionChannelBindingsInputSchema = z
  .object({
    allowedChannelRouteIds: z
      .array(idSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export const kommoConnectionStatusUpdateInputSchema = z
  .object({ status: z.enum(["active", "paused"]) })
  .strict();

export const kommoPipelineStatusSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(255),
  type: z.string().trim().max(80).nullable(),
});
export const kommoPipelineSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(255),
  sort: z.number().int().nullable(),
  statuses: z.array(kommoPipelineStatusSchema),
});

export const kommoConnectionSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  displayName: z.string().min(1),
  status: kommoConnectionStatusSchema,
  verifiedAccountId: idSchema.nullable(),
  accountSubdomain: z.string().nullable(),
  accountOrigin: z.string().url(),
  allowedChannelRouteIds: z.array(idSchema),
  credentialHealthy: z.boolean(),
  catalogState: kommoCatalogStateSchema,
  catalogRefreshedAt: z.string().datetime().nullable(),
  lastErrorCode: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const ruleValueFields = z.object({
  valueMode: kommoValueModeSchema.default("lead_price"),
  fixedValueCents: z.number().int().positive().nullable().optional(),
  currency: currencySchema.nullable().optional(),
  contentName: z.string().trim().min(1).max(180).nullable().optional(),
});
const kommoConversionRuleBaseSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    pipelineId: idSchema,
    statusId: idSchema,
    eventName: conversionEventNameSchema,
    mode: kommoRuleModeSchema.default("observation"),
    active: z.boolean().default(true),
  })
  .merge(ruleValueFields)
  .strict();
export const kommoConversionRuleCreateInputSchema =
  kommoConversionRuleBaseSchema.superRefine((input, context) => {
    if (!conversionEventCarriesValue(input.eventName)) {
      if (
        input.valueMode !== "lead_price" ||
        input.fixedValueCents != null ||
        input.currency ||
        input.contentName != null
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Este evento nao aceita configuracao de valor",
          path: ["valueMode"],
        });
    } else if (input.valueMode === "fixed") {
      if (!input.fixedValueCents)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Informe o valor fixo",
          path: ["fixedValueCents"],
        });
      if (!input.currency)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Informe a moeda do valor fixo",
          path: ["currency"],
        });
    }
    if (
      conversionEventRequiresValue(input.eventName) &&
      input.valueMode === "lead_price" &&
      !input.currency
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Informe a moeda do preco do lead",
        path: ["currency"],
      });
  });
export const kommoConversionRuleUpdateInputSchema =
  kommoConversionRuleBaseSchema
    .partial()
    .strict()
    .refine(
      (input) => Object.keys(input).length > 0,
      "Informe ao menos um campo",
    );
export const kommoConversionRuleSchema = z.object({
  id: idSchema,
  connectionId: idSchema,
  name: z.string(),
  pipelineId: idSchema,
  statusId: idSchema,
  eventName: conversionEventNameSchema,
  mode: kommoRuleModeSchema,
  valueMode: kommoValueModeSchema,
  fixedValueCents: z.number().int().nullable(),
  currency: z.string().nullable(),
  contentName: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type KommoConnectionCreateInputDto = z.infer<
  typeof kommoConnectionCreateInputSchema
>;
export type KommoConnectionCredentialReplaceInputDto = z.infer<
  typeof kommoConnectionCredentialReplaceInputSchema
>;
export type KommoConversionRuleCreateInputDto = z.infer<
  typeof kommoConversionRuleCreateInputSchema
>;
export type KommoConversionRuleUpdateInputDto = z.infer<
  typeof kommoConversionRuleUpdateInputSchema
>;
export type KommoConnectionDto = z.infer<typeof kommoConnectionSchema>;
