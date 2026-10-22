import {
  effectiveAccountCurrency,
  type AdAccountCurrencyListDto,
  type CurrencyCode,
  type MetaReportingAccountDto,
  type WorkspaceCurrencySettingsDto,
} from "@wpptrack/shared";
import { serverApiFetch } from "./server-api";

/** GET /workspaces/current/currency; null quando indisponível (nunca trava a página). */
export async function getWorkspaceCurrencySettings(): Promise<WorkspaceCurrencySettingsDto | null> {
  try {
    const settings = await serverApiFetch<WorkspaceCurrencySettingsDto>(
      "/workspaces/current/currency",
    );

    return settings && typeof settings.conversionCurrency === "string"
      ? settings
      : null;
  } catch {
    return null;
  }
}

/** GET /workspaces/current/currency/ad-accounts; null quando indisponível. */
export async function getAdAccountCurrencies(): Promise<AdAccountCurrencyListDto | null> {
  try {
    const list = await serverApiFetch<AdAccountCurrencyListDto>(
      "/workspaces/current/currency/ad-accounts",
    );

    return list && Array.isArray(list.accounts) ? list : null;
  } catch {
    return null;
  }
}

/**
 * Moeda efetiva por conta de anúncio da Meta (correção manual, depois a moeda
 * da Meta, depois BRL). Usa as configurações de moeda quando carregaram; senão,
 * a moeda que a Meta informou nas contas.
 */
export function adAccountCurrencyMap(
  reportingAccounts: Pick<MetaReportingAccountDto, "adAccountId" | "currency">[],
  currencies: AdAccountCurrencyListDto | null,
): Record<string, CurrencyCode> {
  const map: Record<string, CurrencyCode> = {};

  for (const account of reportingAccounts) {
    map[account.adAccountId] = effectiveAccountCurrency(account);
  }

  for (const account of currencies?.accounts ?? []) {
    map[account.adAccountId] = account.effectiveCurrency;
  }

  return map;
}
