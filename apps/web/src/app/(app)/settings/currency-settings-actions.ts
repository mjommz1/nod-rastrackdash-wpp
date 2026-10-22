"use server";

import { normalizeCurrencyCode } from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import type { BackofficeActionState } from "../../../components/backoffice-action-form";
import { licenseLockedMessageFor } from "../../../lib/license-locked-message";
import { isApiRequestError, serverApiFetch } from "../../../lib/server-api";

function actionState(
  status: BackofficeActionState["status"],
  message: string,
): BackofficeActionState {
  return { status, message, nonce: Date.now() };
}

/** Dinheiro mudou: toda tela que formata valor lê a moeda nova. */
function revalidateCurrencyScreens() {
  for (const path of ["/settings", "/conversions", "/integrations"]) {
    revalidatePath(path);
  }
}

function errorMessage(error: unknown, fallback: string): string {
  const locked = licenseLockedMessageFor(error);

  if (locked) {
    return locked;
  }

  if (isApiRequestError(error) && error.status === 403) {
    return "Sem permissão para alterar a moeda deste workspace.";
  }

  return fallback;
}

/** PATCH /workspaces/current/currency ("Moeda das conversões"). */
export async function saveConversionCurrencyAction(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  const conversionCurrency = normalizeCurrencyCode(
    formData.get("conversionCurrency"),
  );

  if (!conversionCurrency) {
    return actionState("error", "Escolha Real, Dólar ou Euro.");
  }

  try {
    await serverApiFetch("/workspaces/current/currency", {
      method: "PATCH",
      body: JSON.stringify({ conversionCurrency }),
    });
    revalidateCurrencyScreens();

    return actionState("success", "Moeda das conversões atualizada.");
  } catch (error) {
    return actionState(
      "error",
      errorMessage(error, "Não foi possível salvar a moeda das conversões."),
    );
  }
}

/**
 * PATCH /workspaces/current/currency/ad-accounts/:id. Escolha vazia remove a
 * correção manual (volta a usar a moeda informada pela Meta).
 */
export async function saveAdAccountCurrencyAction(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  const accountId = String(formData.get("accountId") ?? "").trim();
  const rawOverride = String(formData.get("currencyOverride") ?? "").trim();
  const currencyOverride = rawOverride
    ? normalizeCurrencyCode(rawOverride)
    : null;

  if (!accountId || accountId.length > 255) {
    return actionState("error", "Conta de anúncio não identificada.");
  }

  if (rawOverride && !currencyOverride) {
    return actionState("error", "Escolha Real, Dólar ou Euro.");
  }

  try {
    await serverApiFetch(
      `/workspaces/current/currency/ad-accounts/${encodeURIComponent(accountId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ currencyOverride }),
      },
    );
    revalidateCurrencyScreens();

    return actionState(
      "success",
      currencyOverride
        ? `Conta corrigida para ${currencyOverride}.`
        : "Conta voltou a usar a moeda da Meta.",
    );
  } catch (error) {
    return actionState(
      "error",
      errorMessage(error, "Não foi possível salvar a moeda da conta."),
    );
  }
}
