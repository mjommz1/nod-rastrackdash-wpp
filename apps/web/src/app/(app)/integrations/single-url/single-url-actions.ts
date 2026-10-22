"use server";

import {
  integrationEndpointCreateInputSchema,
  integrationEndpointResultSchema,
  integrationEndpointRoutingResultSchema,
  providerConversionRuleSchema,
  providerConversionRuleUpdateInputSchema,
  type IntegrationEndpointDto,
  type IntegrationEndpointRoutingResultDto,
} from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import { licenseLockedMessageFor } from "../../../../lib/license-locked-message";
import { isApiRequestError, serverApiFetch } from "../../../../lib/server-api";
import {
  singleUrlForbiddenMessage,
  singleUrlUnavailableMessage,
} from "./single-url-copy";

/**
 * Ações da Fase 5.3: URL única da Payt, URLs por evento do Unnichat e da
 * Umbler, "Tentar de novo" e a desativação da URL antiga de uma regra.
 *
 * A URL com a chave volta só nas respostas de criar, mostrar e girar, e só
 * para o componente que pediu: nada aqui registra a URL em log, cookie ou
 * endereço do navegador. A API grava quem pediu para mostrar.
 */
export type SingleUrlActionResult = {
  ok: boolean;
  message: string;
  /** A API recusou com 423: a licença está bloqueada e nada foi alterado. */
  licenseLocked?: boolean;
  endpoint?: IntegrationEndpointDto;
  routing?: IntegrationEndpointRoutingResultDto;
  /** "Desativar/Reativar URL antiga": o estado da URL antiga depois da ação. */
  publicUrlDisabledAt?: string | null;
};

function refresh() {
  try {
    revalidatePath("/integrations");
    revalidatePath("/conversions");
  } catch {
    // O cliente atualiza a tela por conta própria.
  }
}

function failure(error: unknown, fallback: string): SingleUrlActionResult {
  const locked = licenseLockedMessageFor(error);
  if (locked) return { ok: false, licenseLocked: true, message: locked };
  const status = isApiRequestError(error) ? error.status : null;
  if (status === 401) {
    return { ok: false, message: "Sua sessão expirou. Entre de novo." };
  }
  if (status === 403) {
    return { ok: false, message: singleUrlForbiddenMessage };
  }
  if (status === 409 && error instanceof Error && error.message) {
    return { ok: false, message: error.message };
  }
  return { ok: false, message: fallback };
}

function text(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeId(value: string | null): string | null {
  return value && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : null;
}

export async function ensureIntegrationEndpointAction(
  formData: FormData,
): Promise<SingleUrlActionResult> {
  const eventName = text(formData, "eventName");
  const input = integrationEndpointCreateInputSchema.safeParse({
    provider: text(formData, "provider"),
    ...(eventName ? { eventName } : {}),
  });
  if (!input.success) {
    return { ok: false, message: "Escolha a plataforma e o evento." };
  }
  try {
    const response = await serverApiFetch<unknown>("/integrations/endpoints", {
      method: "POST",
      body: JSON.stringify(input.data),
    });
    const parsed = integrationEndpointResultSchema.safeParse(response);
    if (!parsed.success) {
      return { ok: false, message: singleUrlUnavailableMessage };
    }
    refresh();
    return {
      ok: true,
      endpoint: parsed.data.endpoint,
      message: "URL pronta. Copie e cole na plataforma.",
    };
  } catch (error) {
    return failure(error, singleUrlUnavailableMessage);
  }
}

/** "Mostrar URL": a API registra quem exibiu a URL com a chave. */
export async function revealIntegrationEndpointAction(
  formData: FormData,
): Promise<SingleUrlActionResult> {
  const endpointId = safeId(text(formData, "endpointId"));
  if (!endpointId) return { ok: false, message: singleUrlUnavailableMessage };
  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/endpoints/${encodeURIComponent(endpointId)}/reveal`,
      { method: "POST" },
    );
    const parsed = integrationEndpointResultSchema.safeParse(response);
    if (!parsed.success) {
      return { ok: false, message: singleUrlUnavailableMessage };
    }
    return {
      ok: true,
      endpoint: parsed.data.endpoint,
      message: "URL exibida. Esta consulta ficou registrada.",
    };
  } catch (error) {
    return failure(error, singleUrlUnavailableMessage);
  }
}

export async function rotateIntegrationEndpointAction(
  formData: FormData,
): Promise<SingleUrlActionResult> {
  const endpointId = safeId(text(formData, "endpointId"));
  if (!endpointId) return { ok: false, message: singleUrlUnavailableMessage };
  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/endpoints/${encodeURIComponent(endpointId)}/rotate`,
      { method: "POST" },
    );
    const parsed = integrationEndpointResultSchema.safeParse(response);
    if (!parsed.success) {
      return { ok: false, message: singleUrlUnavailableMessage };
    }
    refresh();
    return {
      ok: true,
      endpoint: parsed.data.endpoint,
      message:
        "Nova URL gerada. A anterior parou de funcionar: cole a nova na plataforma.",
    };
  } catch (error) {
    return failure(error, singleUrlUnavailableMessage);
  }
}

export async function removeIntegrationEndpointAction(
  formData: FormData,
): Promise<SingleUrlActionResult> {
  const endpointId = safeId(text(formData, "endpointId"));
  if (!endpointId) return { ok: false, message: singleUrlUnavailableMessage };
  try {
    await serverApiFetch<unknown>(
      `/integrations/endpoints/${encodeURIComponent(endpointId)}`,
      { method: "DELETE" },
    );
    refresh();
    return { ok: true, message: "URL removida." };
  } catch (error) {
    return failure(error, singleUrlUnavailableMessage);
  }
}

export async function retryIntegrationEventAction(
  formData: FormData,
): Promise<SingleUrlActionResult> {
  const eventId = safeId(text(formData, "eventId"));
  if (!eventId) return { ok: false, message: singleUrlUnavailableMessage };
  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/endpoints/events/${encodeURIComponent(eventId)}/retry`,
      { method: "POST" },
    );
    const parsed = integrationEndpointRoutingResultSchema.safeParse(response);
    if (!parsed.success) {
      return { ok: false, message: singleUrlUnavailableMessage };
    }
    refresh();
    return {
      ok: true,
      routing: parsed.data,
      message:
        parsed.data.status === "routed"
          ? "Entregue à regra do número de origem."
          : "Ainda sem atribuição. Confira o motivo e as regras.",
    };
  } catch (error) {
    return failure(error, singleUrlUnavailableMessage);
  }
}

/**
 * "Desativar URL antiga" (exige a confirmação) e "Reativar URL antiga" de uma
 * regra: PATCH da própria regra. A regra continua recebendo pela URL nova.
 */
export async function setRulePublicUrlAction(
  formData: FormData,
): Promise<SingleUrlActionResult> {
  const ruleId = safeId(text(formData, "ruleId"));
  const disabled = text(formData, "disabled");
  if (!ruleId || (disabled !== "true" && disabled !== "false")) {
    return { ok: false, message: singleUrlUnavailableMessage };
  }
  const disabling = disabled === "true";
  // O servidor exige confirmPublicUrlDisable: true ao desativar. A tela só
  // chega aqui depois da confirmação do usuário.
  const input = providerConversionRuleUpdateInputSchema.safeParse(
    disabling
      ? { publicUrlDisabled: true, confirmPublicUrlDisable: true }
      : { publicUrlDisabled: false },
  );
  if (!input.success) {
    return { ok: false, message: singleUrlUnavailableMessage };
  }
  try {
    const response = await serverApiFetch<unknown>(
      `/conversion-rules/providers/${encodeURIComponent(ruleId)}`,
      { method: "PATCH", body: JSON.stringify(input.data) },
    );
    const parsed = providerConversionRuleSchema.safeParse(response);
    if (!parsed.success || parsed.data.id !== ruleId) {
      return {
        ok: false,
        message:
          "Não deu para confirmar a alteração. Atualize a página e confira o estado da URL antiga.",
      };
    }
    refresh();
    return {
      ok: true,
      publicUrlDisabledAt: parsed.data.endpoint?.publicUrlDisabledAt ?? null,
      message: disabling
        ? "URL antiga desativada. A regra continua recebendo pela URL nova."
        : "URL antiga reativada.",
    };
  } catch (error) {
    return failure(error, singleUrlUnavailableMessage);
  }
}
