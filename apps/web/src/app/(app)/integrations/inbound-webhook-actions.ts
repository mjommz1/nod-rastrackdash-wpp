"use server";

import {
  inboundWebhookChannelCreateInputSchema,
  inboundWebhookChannelRoutesUpdateInputSchema,
  inboundWebhookChannelStatusUpdateInputSchema,
  inboundWebhookConnectionCreateInputSchema,
  inboundWebhookConnectionCreateResultSchema,
  inboundWebhookConnectionRotateSecretResultSchema,
  inboundWebhookConnectionStatusUpdateInputSchema,
  type InboundWebhookChannelRoutesUpdateInputDto,
  type InboundWebhookProviderDto,
} from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import { licenseLockedMessageFor } from "../../../lib/license-locked-message";
import { serverApiFetch } from "../../../lib/server-api";

export type InboundWebhookOneTimeSecret = {
  connectionId: string;
  provider: InboundWebhookProviderDto;
  webhookUrl: string;
  verifyToken?: string;
};

export type InboundWebhookActionResult = {
  ok: boolean;
  message: string;
  oneTimeSecret?: InboundWebhookOneTimeSecret;
};

const integrationsPath = "/integrations";
const invalidFormMessage = "Revise os dados informados e tente novamente.";
const connectionStatusOperationalErrors = new Set([
  "Configure META_APP_SECRET do seu proprio app Meta no ambiente da API antes de enviar. Nao use o segredo PalmUP nem cole segredos no chat.",
  "Certifique o parser antes de ativar o envio automatico. Esta versao da integracao nao e nativa validada ou foi retirada.",
  "Ative ao menos um canal validado antes da producao",
  "Certifique o parser antes de ativar o envio automatico",
  "Controle de vagas dos canais externos indisponivel",
  "Envio automatico de webhooks ainda nao esta habilitado",
  "Finalize o replay em andamento antes de ativar a producao",
  "Todas as vagas do pacote estao ocupadas",
  "Todo canal ativo precisa de uma rota Meta valida",
  "Workspace sem contrato com acesso ativo",
]);
const connectionCreateOperationalErrors = new Set([
  "Conexões Unnichat exigem o número de WhatsApp do cliente",
]);
const providerObservationUnavailableApiMessage =
  "Versao de observacao do provedor indisponivel";

function providerObservationUnavailableMessage(provider: string): string {
  const name = provider === "unnichat" ? "O Unnichat" : "Este provedor";

  return `${name} ainda não está liberado nesta instalação: rode as migrations da API e tente de novo.`;
}
const channelStatusOperationalErrors = new Set([
  "Configure a Meta deste número (página e pixel do workspace ou rotas próprias) antes de ativar o canal",
  "Configure uma rota Meta valida antes de ativar o canal",
  "Controle de vagas dos canais externos indisponivel",
  "Todas as vagas do pacote estao ocupadas",
  "Workspace sem contrato com acesso ativo",
]);

function oneTimeSecretForProvider(input: {
  connectionId: string;
  provider: InboundWebhookProviderDto;
  webhookUrl: string;
  secret: string;
}): InboundWebhookOneTimeSecret {
  const credential = {
    connectionId: input.connectionId,
    provider: input.provider,
    webhookUrl: input.webhookUrl,
  };

  return input.provider === "meta_cloud"
    ? { ...credential, verifyToken: input.secret }
    : credential;
}

export async function createInboundWebhookConnectionAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const provider = formText(formData, "provider");
  // Unnichat: o webhook de entrada não traz o canal, então a conexão nasce
  // com o número de WhatsApp do cliente (nunca o telefone do lead).
  const input = inboundWebhookConnectionCreateInputSchema.safeParse(
    provider === "unnichat"
      ? {
          provider,
          displayName: formText(formData, "displayName"),
          connectedPhone: formText(formData, "connectedPhone"),
        }
      : { provider, displayName: formText(formData, "displayName") },
  );

  if (!input.success) {
    return failure(
      provider === "unnichat" && formText(formData, "displayName")
        ? "Informe o número de WhatsApp do cliente atendido pelo Unnichat, com DDI e DDD."
        : invalidFormMessage,
    );
  }

  try {
    const response = await serverApiFetch<unknown>(
      "/integrations/inbound-webhooks",
      {
        method: "POST",
        body: JSON.stringify(input.data),
      },
    );
    const result =
      inboundWebhookConnectionCreateResultSchema.safeParse(response);

    if (!result.success) {
      return failure("Não foi possível criar a conexão de webhook.");
    }

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        "Conexao de webhook criada. Copie a URL agora; ela nao sera exibida novamente.",
      oneTimeSecret: oneTimeSecretForProvider({
        connectionId: result.data.connection.id,
        provider: result.data.connection.provider,
        webhookUrl: result.data.webhookUrl,
        secret: result.data.secret,
      }),
    };
  } catch (error) {
    if (
      !licenseLockedMessageFor(error) &&
      error instanceof Error &&
      error.message.trim() === providerObservationUnavailableApiMessage
    ) {
      return failure(
        providerObservationUnavailableMessage(String(input.data.provider)),
      );
    }

    return failure(
      knownOperationalError(error, connectionCreateOperationalErrors) ??
        "Não foi possível criar a conexão de webhook.",
    );
  }
}

export async function rotateInboundWebhookSecretAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const connectionId = formId(formData, "connectionId");

  if (!connectionId) {
    return failure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/${encodeURIComponent(connectionId)}/rotate-secret`,
      {
        method: "POST",
        body: "{}",
      },
    );
    const result =
      inboundWebhookConnectionRotateSecretResultSchema.safeParse(response);

    if (!result.success || result.data.connectionId !== connectionId) {
      return failure("Nao foi possivel rotacionar o segredo desta conexao.");
    }

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        "Segredo rotacionado. Copie a nova URL agora; ela nao sera exibida novamente.",
      oneTimeSecret: oneTimeSecretForProvider({
        connectionId: result.data.connectionId,
        provider: result.data.provider,
        webhookUrl: result.data.webhookUrl,
        secret: result.data.secret,
      }),
    };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Nao foi possivel rotacionar o segredo desta conexao.");
  }
}

export async function setInboundWebhookConnectionStatusAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const connectionId = formId(formData, "connectionId");
  const input = inboundWebhookConnectionStatusUpdateInputSchema.safeParse({
    status: formText(formData, "status"),
  });

  if (!connectionId || !input.success) {
    return failure(invalidFormMessage);
  }

  try {
    await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/${encodeURIComponent(connectionId)}/status`,
      {
        method: "PUT",
        body: JSON.stringify(input.data),
      },
    );

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        input.data.status === "paused"
          ? "Conexao pausada. Novas entregas nao serao processadas."
          : input.data.status === "production"
            ? "Envio automatico ativado nos canais habilitados."
            : "Conexao mantida em modo de observacao.",
    };
  } catch (error) {
    return failure(
      knownOperationalError(error, connectionStatusOperationalErrors) ??
        "Nao foi possivel alterar o status desta conexao.",
    );
  }
}

export async function removeInboundWebhookConnectionAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const connectionId = formId(formData, "connectionId");

  if (!connectionId) {
    return failure(invalidFormMessage);
  }

  try {
    await deleteApiResource(
      `/integrations/inbound-webhooks/${encodeURIComponent(connectionId)}`,
    );

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message: "Conexao removida. O historico de observacao foi preservado.",
    };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Nao foi possivel remover esta conexao.");
  }
}

export async function createInboundWebhookChannelAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const connectionId = formId(formData, "connectionId");
  const input = inboundWebhookChannelCreateInputSchema.safeParse({
    connectedPhone: formText(formData, "connectedPhone"),
    channelName: formText(formData, "channelName"),
  });

  if (!connectionId || !input.success) {
    return failure(invalidFormMessage);
  }

  try {
    await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/${encodeURIComponent(connectionId)}/channels`,
      {
        method: "POST",
        body: JSON.stringify(input.data),
      },
    );

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        "Canal cadastrado. Ja e possivel criar regras de conversao para ele antes de qualquer mensagem chegar.",
    };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Nao foi possivel cadastrar o canal.");
  }
}

export async function setInboundWebhookChannelStatusAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const channelId = formId(formData, "channelId");
  const input = inboundWebhookChannelStatusUpdateInputSchema.safeParse({
    status: formText(formData, "status"),
  });

  if (!channelId || !input.success) {
    return failure(invalidFormMessage);
  }

  try {
    await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/channels/${encodeURIComponent(channelId)}/status`,
      {
        method: "PUT",
        body: JSON.stringify(input.data),
      },
    );

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message:
        input.data.status === "paused"
          ? "Canal pausado. Os demais canais continuam inalterados."
          : "Canal habilitado para envio quando a conexao estiver em producao.",
    };
  } catch (error) {
    return failure(
      knownOperationalError(error, channelStatusOperationalErrors) ??
        "Nao foi possivel alterar o status deste canal.",
    );
  }
}

export async function saveInboundWebhookChannelRoutesAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const channelId = formId(formData, "channelId");
  const input = channelRoutesInput(formData);

  if (!channelId || !input) {
    return failure(invalidFormMessage);
  }

  try {
    await serverApiFetch<unknown>(
      `/integrations/inbound-webhooks/channels/${encodeURIComponent(channelId)}/routes`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
    );

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message: "Rotas do canal salvas e validadas.",
    };
  } catch (error) {
    return failure(
      knownRouteError(error) ?? "Nao foi possivel salvar as rotas deste canal.",
    );
  }
}

export async function removeInboundWebhookChannelRouteAction(
  formData: FormData,
): Promise<InboundWebhookActionResult> {
  const channelId = formId(formData, "channelId");
  const routeId = formId(formData, "routeId");

  if (!channelId || !routeId) {
    return failure(invalidFormMessage);
  }

  try {
    await deleteApiResource(
      `/integrations/inbound-webhooks/channels/${encodeURIComponent(channelId)}/routes/${encodeURIComponent(routeId)}`,
    );

    revalidatePath(integrationsPath);
    return {
      ok: true,
      message: "Rota removida do canal.",
    };
  } catch (error) {
    return failure(licenseLockedMessageFor(error) ?? "Nao foi possivel remover esta rota.");
  }
}

function formText(formData: FormData, key: string): string | null {
  const value = formData.get(key);

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formId(formData: FormData, key: string): string | null {
  const value = formText(formData, key);

  if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return null;
  }

  return value;
}

function channelRoutesInput(
  formData: FormData,
): InboundWebhookChannelRoutesUpdateInputDto | null {
  const value = formText(formData, "routes");
  const routingMode = formText(formData, "routingMode");

  if (!value || value.length > 100_000) {
    return null;
  }

  try {
    // O modo só existe para o Unnichat: os demais provedores não o enviam
    // (a API recusa o campo).
    const input = inboundWebhookChannelRoutesUpdateInputSchema.safeParse({
      routes: JSON.parse(value),
      ...(routingMode ? { routingMode } : {}),
    });

    if (
      !input.success ||
      (input.data.routingMode === "inherit_workspace" &&
        input.data.routes.length > 0)
    ) {
      return null;
    }

    return input.data;
  } catch {
    return null;
  }
}

// Recusas 409 do modo de roteamento (Unnichat) em português claro.
const routeConflictMessages: ReadonlyArray<readonly [string, string]> = [
  [
    "Modo de herança disponível apenas para Unnichat",
    "O modo “Herdar do workspace” existe só para números do Unnichat.",
  ],
  [
    "Informe o modo de roteamento",
    "Escolha o modo de roteamento deste número (Herdar do workspace ou Configurar neste número) e salve.",
  ],
  [
    "Herança não aceita rotas locais",
    "No modo “Herdar do workspace” o número não tem rotas próprias. Remova as rotas ou escolha “Configurar neste número”.",
  ],
  [
    "Informe routingMode channel_override",
    "Para salvar rotas próprias, escolha “Configurar neste número”.",
  ],
];

function knownRouteError(error: unknown): string | null {
  const licenseMessage = licenseLockedMessageFor(error);

  if (licenseMessage) {
    return licenseMessage;
  }

  if (!(error instanceof Error)) {
    return null;
  }

  const message = error.message.trim();

  return (
    routeConflictMessages.find(([prefix]) => message.startsWith(prefix))?.[1] ??
    null
  );
}

async function deleteApiResource(path: string): Promise<void> {
  await serverApiFetch<void>(path, { method: "DELETE" });
}

function failure(message: string): InboundWebhookActionResult {
  return { ok: false, message };
}

function knownOperationalError(
  error: unknown,
  allowedMessages: ReadonlySet<string>,
): string | null {
  const licenseMessage = licenseLockedMessageFor(error);

  if (licenseMessage) {
    return licenseMessage;
  }

  if (!(error instanceof Error)) {
    return null;
  }

  const message = error.message.trim();

  return allowedMessages.has(message) ? message : null;
}
