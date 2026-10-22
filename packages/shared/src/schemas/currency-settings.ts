import { z } from "zod";
import { currencyCodeSchema, supportedCurrencyCodes } from "../currency";

/**
 * Configurações -> Moeda (workspace atual da sessão).
 * GET   /workspaces/current/currency                   qualquer membro
 * PATCH /workspaces/current/currency                   dono/admin, auditado, 423 com licença bloqueada
 * GET   /workspaces/current/currency/ad-accounts       qualquer membro
 * PATCH /workspaces/current/currency/ad-accounts/:id   dono/admin, auditado, 423 com licença bloqueada
 */
export const workspaceCurrencySettingsSchema = z.object({
  workspaceId: z.string().min(1),
  /** "Moeda das conversões": padrão quando a venda e a regra não informam moeda. */
  conversionCurrency: currencyCodeSchema,
  supportedCurrencies: z.array(currencyCodeSchema),
  canManage: z.boolean(),
});

export const workspaceCurrencyUpdateInputSchema = z
  .object({
    conversionCurrency: currencyCodeSchema,
  })
  .strict();

export const adAccountCurrencySchema = z.object({
  /** MetaReportingAccount.id (use este id no PATCH; o adAccountId também é aceito). */
  id: z.string().min(1),
  adAccountId: z.string().min(1),
  adAccountName: z.string(),
  businessId: z.string().min(1),
  businessName: z.string(),
  active: z.boolean(),
  /** Moeda informada pela Meta (qualquer código ISO, ou null). */
  detectedCurrency: z.string().nullable(),
  /** false quando a Meta informa uma moeda fora de BRL/USD/EUR. */
  detectedCurrencySupported: z.boolean(),
  currencyOverride: currencyCodeSchema.nullable(),
  /** Correção ?? moeda da Meta (se suportada) ?? BRL. */
  effectiveCurrency: currencyCodeSchema,
});

export const adAccountCurrencyListSchema = z.object({
  accounts: z.array(adAccountCurrencySchema),
  /** Moedas efetivas distintas entre as contas ativas. */
  currencies: z.array(currencyCodeSchema),
  canManage: z.boolean(),
});

export const adAccountCurrencyOverrideInputSchema = z
  .object({
    /** null remove a correção manual (volta a usar a moeda da Meta). */
    currencyOverride: currencyCodeSchema.nullable(),
  })
  .strict();

const currencyLabels: Record<(typeof supportedCurrencyCodes)[number], string> = {
  BRL: "Real (R$)",
  USD: "Dólar americano (US$)",
  EUR: "Euro (€)",
};

export const supportedCurrencyOptions = supportedCurrencyCodes.map((code) => ({
  code,
  label: currencyLabels[code],
}));

export type WorkspaceCurrencySettingsDto = z.infer<
  typeof workspaceCurrencySettingsSchema
>;
export type WorkspaceCurrencyUpdateInputDto = z.infer<
  typeof workspaceCurrencyUpdateInputSchema
>;
export type AdAccountCurrencyDto = z.infer<typeof adAccountCurrencySchema>;
export type AdAccountCurrencyListDto = z.infer<
  typeof adAccountCurrencyListSchema
>;
export type AdAccountCurrencyOverrideInputDto = z.infer<
  typeof adAccountCurrencyOverrideInputSchema
>;
