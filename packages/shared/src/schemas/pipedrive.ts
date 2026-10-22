import { z } from "zod";
import { ruleCurrencyInputSchema } from "../currency";
import {
  crmChannelBindingFailures,
  crmChannelBindingMessagesFor,
  type CrmChannelBindingFailure,
} from "./crm-channels";
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
        /^[a-z0-9-]+\.pipedrive\.com$/i.test(url.hostname)
      );
    } catch {
      return false;
    }
  }, "Informe apenas o endereço HTTPS da empresa no Pipedrive (https://<empresa>.pipedrive.com)");

/**
 * Exact message of the workspace-scoped Pipedrive connection 404
 * (code pipedrive_connection_not_found). The web client has no machine-readable
 * error code, so it recognizes the scoped absence by this text.
 */
export const PIPEDRIVE_CONNECTION_NOT_FOUND_MESSAGE =
  "Conexão Pipedrive não encontrada";

export const pipedriveConnectionStatuses = [
  "active",
  "paused",
  "blocked",
] as const;
export const pipedriveConnectionStatusSchema = z.enum(
  pipedriveConnectionStatuses,
);
export const pipedriveCatalogStates = [
  "empty",
  "fresh",
  "stale",
  "error",
] as const;
export const pipedriveCatalogStateSchema = z.enum(pipedriveCatalogStates);
export const pipedriveRuleModes = ["observation", "production"] as const;
export const pipedriveRuleModeSchema = z.enum(pipedriveRuleModes);
export const pipedriveValueModes = ["deal", "fixed"] as const;
export const pipedriveValueModeSchema = z.enum(pipedriveValueModes);
/**
 * What moves a rule. `stage_change`: the deal entered the rule's stage.
 * `deal_won`: the deal status changed to won in the rule's pipeline; it sends
 * Purchase with the deal value/currency. A lost deal never converts.
 */
export const pipedriveRuleTriggers = ["stage_change", "deal_won"] as const;
export const pipedriveRuleTriggerSchema = z.enum(pipedriveRuleTriggers);

/**
 * Why a WhatsApp number cannot be authorized for a Pipedrive connection.
 * Pipedrive is only a CRM: an authorized entry is any production WhatsApp
 * number of the workspace (any provider), identified by its valid route id or,
 * when the number inherits the workspace Meta destination, by its channel id.
 * Messages are customer-facing, fixed strings (the web maps them exactly).
 */
export const pipedriveChannelBindingFailures = crmChannelBindingFailures;
export type PipedriveChannelBindingFailure = CrmChannelBindingFailure;
export const pipedriveChannelBindingMessages: Record<
  PipedriveChannelBindingFailure,
  string
> = crmChannelBindingMessagesFor("Pipedrive");

export const pipedriveConnectionCreateInputSchema = z
  .object({
    displayName: z.string().trim().min(2).max(120),
    accountOrigin: originSchema,
    apiToken: z.string().trim().min(16).max(4096),
    allowedChannelRouteIds: z
      .array(idSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length)
      .default([]),
  })
  .strict();
export const pipedriveConnectionCredentialReplaceInputSchema = z
  .object({
    accountOrigin: originSchema.optional(),
    apiToken: z.string().trim().min(16).max(4096),
  })
  .strict();
export const pipedriveConnectionChannelBindingsInputSchema = z
  .object({
    allowedChannelRouteIds: z
      .array(idSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export const pipedriveConnectionStatusUpdateInputSchema = z
  .object({ status: z.enum(["active", "paused"]) })
  .strict();

export const pipedrivePipelineStageSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(255),
  sort: z.number().int().nullable(),
});
export const pipedrivePipelineSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(255),
  sort: z.number().int().nullable(),
  stages: z.array(pipedrivePipelineStageSchema),
});

export const pipedriveConnectionSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  displayName: z.string().min(1),
  status: pipedriveConnectionStatusSchema,
  verifiedAccountId: idSchema.nullable(),
  accountSubdomain: z.string().nullable(),
  accountOrigin: z.string().url(),
  allowedChannelRouteIds: z.array(idSchema),
  credentialHealthy: z.boolean(),
  catalogState: pipedriveCatalogStateSchema,
  catalogRefreshedAt: z.string().datetime().nullable(),
  lastErrorCode: z.string().nullable(),
  mutationRevision: z.number().int().nonnegative().optional(),
  webhook: z
    .object({
      configured: z.boolean(),
      version: z.number().int().nonnegative(),
      rotatedAt: z.string().datetime().nullable(),
      lastReceivedAt: z.string().datetime().nullable(),
    })
    .optional(),
  counts: z
    .object({
      pipelines: z.number().int().nonnegative(),
      rules: z.number().int().nonnegative(),
    })
    .optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const ruleValueFields = z.object({
  valueMode: pipedriveValueModeSchema.default("deal"),
  fixedValueCents: z.number().int().positive().nullable().optional(),
  currency: currencySchema.nullable().optional(),
  contentName: z.string().trim().min(1).max(180).nullable().optional(),
});
const pipedriveConversionRuleBaseSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    trigger: pipedriveRuleTriggerSchema.default("stage_change"),
    pipelineId: idSchema,
    stageId: idSchema.nullable().optional(),
    eventName: conversionEventNameSchema,
    mode: pipedriveRuleModeSchema.default("observation"),
    active: z.boolean().default(true),
  })
  .merge(ruleValueFields)
  .strict();
export const pipedriveConversionRuleCreateInputSchema =
  pipedriveConversionRuleBaseSchema.superRefine((input, context) => {
    if (input.trigger === "stage_change" && !input.stageId)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Escolha a etapa",
        path: ["stageId"],
      });
    if (input.trigger === "deal_won") {
      if (input.stageId != null)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Negócio ganho não usa etapa",
          path: ["stageId"],
        });
      if (input.eventName !== "Purchase")
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Negócio ganho envia Compra (Purchase)",
          path: ["eventName"],
        });
    }
    if (!conversionEventCarriesValue(input.eventName)) {
      if (
        input.valueMode !== "deal" ||
        input.fixedValueCents != null ||
        input.currency ||
        input.contentName != null
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Este evento não aceita configuração de valor",
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
    // A won deal carries its own currency; a stage rule must name one.
    if (
      conversionEventRequiresValue(input.eventName) &&
      input.valueMode === "deal" &&
      input.trigger !== "deal_won" &&
      !input.currency
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Informe a moeda do valor do negócio",
        path: ["currency"],
      });
  });
export const pipedriveConversionRuleUpdateInputSchema =
  pipedriveConversionRuleBaseSchema
    .partial()
    .strict()
    .refine(
      (input) => Object.keys(input).length > 0,
      "Informe ao menos um campo",
    );
export const pipedriveConversionRuleSchema = z.object({
  id: idSchema,
  connectionId: idSchema,
  name: z.string(),
  trigger: pipedriveRuleTriggerSchema.default("stage_change"),
  pipelineId: idSchema,
  stageId: idSchema.nullable(),
  eventName: conversionEventNameSchema,
  mode: pipedriveRuleModeSchema,
  productionActivatedAt: z.string().datetime().nullable().optional(),
  valueMode: pipedriveValueModeSchema,
  fixedValueCents: z.number().int().nullable(),
  currency: z.string().nullable(),
  contentName: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PipedriveConnectionCreateInputDto = z.infer<
  typeof pipedriveConnectionCreateInputSchema
>;
export type PipedriveConnectionCredentialReplaceInputDto = z.infer<
  typeof pipedriveConnectionCredentialReplaceInputSchema
>;
/** Request shape: defaulted fields (trigger, mode, valueMode, active) optional. */
export type PipedriveConversionRuleCreateInputDto = z.input<
  typeof pipedriveConversionRuleCreateInputSchema
>;
export type PipedriveConversionRuleUpdateInputDto = z.infer<
  typeof pipedriveConversionRuleUpdateInputSchema
>;
export type PipedriveConnectionDto = z.infer<typeof pipedriveConnectionSchema>;
export type PipedriveRuleTriggerDto = z.infer<typeof pipedriveRuleTriggerSchema>;
