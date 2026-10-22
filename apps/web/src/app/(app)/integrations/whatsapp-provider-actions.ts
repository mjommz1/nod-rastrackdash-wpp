"use server";

import {
  whatsappConnectionCreateInputSchema,
  whatsappConnectionEditInputSchema,
  whatsappConnectionEditMetadataSchema,
  whatsappConnectionTestResultSchema,
  whatsappConnectionWebhookTokenRotateResultSchema,
} from "@wpptrack/shared";
import type { WhatsappConnectionEditMetadataDto } from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import { licenseLockedMessageFor } from "../../../lib/license-locked-message";
import { serverApiFetch } from "../../../lib/server-api";

export type WhatsappReceiverSecret = {
  webhookUrl: string;
};

export type WhatsappProviderActionResult = {
  ok: boolean;
  message: string;
  connectionId?: string;
  receiverSecret?: WhatsappReceiverSecret;
};

export type WhatsappConnectionEditData = WhatsappConnectionEditMetadataDto;

export type WhatsappConnectionEditResult =
  | { ok: true; data: WhatsappConnectionEditData }
  | { ok: false; message: string };

type ProviderId = "uazapi_byo" | "nod_api" | "waha" | "zapi";

const integrationsPath = "/integrations";

export async function createWhatsappConnectionAction(
  formData: FormData,
): Promise<WhatsappProviderActionResult> {
  const input = whatsappConnectionCreateInputSchema.safeParse(
    connectionInput(formData),
  );

  if (!input.success) {
    return failure("Revise os dados da conexao e tente novamente.");
  }

  try {
    const connection = await serverApiFetch<{ id: string }>(
      "/integrations/whatsapp-connections",
      { method: "POST", body: JSON.stringify(input.data) },
    );
    revalidatePath(integrationsPath);
    return {
      ok: true,
      message: "Conexao salva. Use Testar antes de configurar o receiver.",
      connectionId: connection.id,
    };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Nao foi possivel salvar a conexao WhatsApp.");
  }
}

export async function testWhatsappConnectionAction(
  formData: FormData,
): Promise<WhatsappProviderActionResult> {
  const connectionId = formText(formData, "connectionId");
  if (!connectionId) return failure("Conexao WhatsApp invalida.");

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/whatsapp-connections/${encodeURIComponent(connectionId)}/test`,
      { method: "POST", body: "{}" },
    );
    const result = whatsappConnectionTestResultSchema.safeParse(response);
    if (!result.success || result.data.connectionId !== connectionId) {
      return failure("Nao foi possivel testar a conexao WhatsApp.");
    }

    revalidatePath(integrationsPath);
    return {
      ok: result.data.status === "connected",
      message:
        result.data.message ??
        (result.data.status === "connected"
          ? "Conexao testada com sucesso."
          : `Teste concluido com status ${result.data.status}.`),
      connectionId,
    };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Nao foi possivel testar a conexao WhatsApp.");
  }
}

export async function rotateWhatsappWebhookTokenAction(
  formData: FormData,
): Promise<WhatsappProviderActionResult> {
  const connectionId = formText(formData, "connectionId");
  if (!connectionId) return failure("Conexao WhatsApp invalida.");

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/whatsapp-connections/${encodeURIComponent(connectionId)}/rotate-webhook-token`,
      { method: "POST", body: "{}" },
    );
    const result =
      whatsappConnectionWebhookTokenRotateResultSchema.safeParse(response);
    if (!result.success || result.data.connection.id !== connectionId) {
      return failure("Nao foi possivel gerar o receiver desta conexao.");
    }

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        "Receiver rotacionado. Copie a URL completa agora; ela nao sera exibida novamente.",
      connectionId,
      receiverSecret: {
        webhookUrl: `${result.data.webhookEndpoint}?token=${encodeURIComponent(result.data.webhookToken)}`,
      },
    };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Nao foi possivel gerar o receiver desta conexao.");
  }
}

export async function deleteWhatsappConnectionAction(
  formData: FormData,
): Promise<WhatsappProviderActionResult> {
  const connectionId = formText(formData, "connectionId");
  if (!connectionId) return failure("Conexao WhatsApp invalida.");

  try {
    await serverApiFetch(
      `/integrations/whatsapp-connections/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" },
    );
    revalidatePath(integrationsPath);
    return { ok: true, message: "Conexao excluida.", connectionId };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Nao foi possivel excluir a conexao WhatsApp.");
  }
}

export async function loadWhatsappConnectionForEditAction(
  connectionId: string,
): Promise<WhatsappConnectionEditResult> {
  const id = connectionId.trim();
  if (!id) {
    return { ok: false, message: "Conexao WhatsApp invalida." };
  }

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/whatsapp-connections/${encodeURIComponent(id)}/edit`,
    );
    const result = whatsappConnectionEditMetadataSchema.safeParse(response);
    if (!result.success || result.data.id !== id) {
      return {
        ok: false,
        message: "Nao foi possivel carregar os dados da conexao.",
      };
    }
    return { ok: true, data: result.data };
  } catch {
    return {
      ok: false,
      message: "Nao foi possivel carregar os dados da conexao.",
    };
  }
}

export async function updateWhatsappConnectionAction(
  formData: FormData,
): Promise<WhatsappProviderActionResult> {
  const connectionId = formText(formData, "connectionId");
  const provider = formText(formData, "provider");
  if (!connectionId || !isProviderId(provider)) {
    return failure("Conexao WhatsApp invalida.");
  }

  const input = whatsappConnectionEditInputSchema.safeParse(
    editConnectionInput(provider, formData),
  );
  if (!input.success) {
    return failure("Revise os dados da conexao e tente novamente.");
  }

  try {
    await serverApiFetch(
      `/integrations/whatsapp-connections/${encodeURIComponent(connectionId)}/edit`,
      { method: "PATCH", body: JSON.stringify(input.data) },
    );
    revalidatePath(integrationsPath);
    return { ok: true, message: "Conexao atualizada.", connectionId };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Nao foi possivel atualizar a conexao WhatsApp.");
  }
}

function editConnectionInput(
  provider: ProviderId,
  formData: FormData,
): unknown {
  const name = formText(formData, "name");
  const displayName = formText(formData, "displayName") ?? null;
  const secret = formText(formData, "secret");

  switch (provider) {
    case "uazapi_byo":
      return {
        provider,
        name,
        displayName,
        credentials: {
          baseUrl: formText(formData, "baseUrl"),
          instanceId: formText(formData, "instanceId"),
          token: secret,
        },
      };
    case "waha":
      return {
        provider,
        name,
        displayName,
        credentials: {
          baseUrl: formText(formData, "baseUrl"),
          session: formText(formData, "session"),
          apiKey: secret,
        },
      };
    case "zapi":
      return {
        provider,
        name,
        displayName,
        credentials: {
          baseUrl: formText(formData, "baseUrl"),
          instanceId: formText(formData, "instanceId"),
          token: secret,
        },
      };
    case "nod_api":
      return {
        provider,
        name,
        displayName,
        credentials: {
          instanceId: formText(formData, "instanceId"),
          instanceToken: secret,
        },
      };
  }
}

function isProviderId(value: string | undefined): value is ProviderId {
  return (
    value === "uazapi_byo" ||
    value === "waha" ||
    value === "zapi" ||
    value === "nod_api"
  );
}

function connectionInput(formData: FormData): unknown {
  const provider = formText(formData, "provider");
  const name = formText(formData, "name");
  const displayName = formText(formData, "displayName") ?? undefined;

  switch (provider) {
    case "uazapi_byo":
      return {
        provider,
        name,
        displayName,
        credentials: {
          baseUrl: formText(formData, "baseUrl"),
          token: formText(formData, "token"),
          instanceId: formText(formData, "instanceId") ?? undefined,
        },
      };
    case "waha":
      return {
        provider,
        name,
        displayName,
        credentials: {
          baseUrl: formText(formData, "baseUrl"),
          apiKey: formText(formData, "apiKey"),
          session: formText(formData, "session") ?? undefined,
        },
      };
    case "zapi":
      return {
        provider,
        name,
        displayName,
        credentials: {
          baseUrl: formText(formData, "baseUrl"),
          instanceId: formText(formData, "instanceId"),
          token: formText(formData, "token"),
        },
      };
    case "nod_api":
      return {
        provider,
        name,
        displayName,
        credentials: {
          instanceId: formText(formData, "instanceId"),
          instanceToken: formText(formData, "instanceToken"),
        },
      };
    default:
      return { provider, name, displayName };
  }
}

function formText(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function failure(message: string): WhatsappProviderActionResult {
  return { ok: false, message };
}
