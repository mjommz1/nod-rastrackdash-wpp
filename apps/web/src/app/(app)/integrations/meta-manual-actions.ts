"use server";

import type {
  MetaManualAssetDiscoveryDto,
  MetaManualConfigurationDto,
  MetaManualConnectionTestResultDto,
  MetaOAuthDisconnectResultDto,
  MetaReportingAccountAdRoutingDto,
} from "@wpptrack/shared";
import { metaManualAssetDiscoverySchema } from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import { isApiRequestError, serverApiFetch } from "../../../lib/server-api";
import type { InitialManualMetaSyncPeriod } from "./meta-manual-sync-period";

export type MetaManualActionResult = {
  ok: boolean;
  message: string;
  discovery?: MetaManualAssetDiscoveryDto;
  configuration?: MetaManualConfigurationDto;
  testResult?: MetaManualConnectionTestResultDto;
  adRouting?: MetaReportingAccountAdRoutingDto;
  palmupPairing?: MetaPalmupPairing;
  palmupUnconfigured?: boolean;
};

// Only what the browser needs to open the PalmUP login and finish later.
// The challenge stays inside authorizeUrl; the token never leaves the API.
export type MetaPalmupPairing = {
  pairingId: string;
  authorizeUrl: string;
};

const PALMUP_PAIRING_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export async function disconnectMetaOAuthAction(
  workspaceId: string,
  confirmation: string,
): Promise<MetaManualActionResult> {
  try {
    await serverApiFetch<MetaOAuthDisconnectResultDto>(
      "/integrations/meta/oauth/disconnect",
      {
        method: "POST",
        body: JSON.stringify({
          expectedWorkspaceId: workspaceId,
          confirmation,
        }),
      },
    );

    revalidatePath("/integrations");
    return {
      ok: true,
      message:
        "OAuth desconectado deste workspace. Agora configure o token permanente.",
    };
  } catch (error) {
    return failure(error, "Nao foi possivel desconectar a conta Meta.");
  }
}

export async function createMetaManualCredentialAction(
  formData: FormData,
): Promise<MetaManualActionResult> {
  try {
    const discovery = await serverApiFetch<MetaManualAssetDiscoveryDto>(
      "/integrations/meta/manual/credentials",
      {
        method: "POST",
        body: JSON.stringify({
          label: requiredFormText(formData, "label"),
          accessToken: requiredFormText(formData, "accessToken"),
        }),
      },
    );

    revalidatePath("/integrations");
    return {
      ok: true,
      message:
        discovery.businesses.length > 0
          ? "Token validado e protegido. Agora escolha a estrutura Meta."
          : "Token validado e protegido. A Meta nao listou as BMs; informe o ID da estrutura.",
      discovery,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel validar este token na Meta.");
  }
}

export async function startMetaPalmupConnectAction(): Promise<MetaManualActionResult> {
  try {
    const started = await serverApiFetch<{
      pairingId?: unknown;
      authorizeUrl?: unknown;
    }>("/integrations/meta/manual/palmup-connect/start", {
      method: "POST",
      body: "{}",
    });
    const pairingId =
      typeof started.pairingId === "string" &&
      PALMUP_PAIRING_ID_PATTERN.test(started.pairingId)
        ? started.pairingId
        : null;
    const authorizeUrl = httpsUrlOrNull(started.authorizeUrl);

    if (!pairingId || !authorizeUrl) {
      return {
        ok: false,
        message: "Nao foi possivel iniciar o login social PalmUP.",
      };
    }

    return {
      ok: true,
      message:
        "Autorize a Meta na aba da PalmUP e volte aqui para concluir a conexao.",
      palmupPairing: { pairingId, authorizeUrl },
    };
  } catch (error) {
    // 503 means PALMUP_META_BROKER_URL is empty on the API; the token path stays available.
    if (isApiRequestError(error) && error.status === 503) {
      return {
        ok: false,
        message:
          "Login social PalmUP nao configurado neste servidor. Use o token permanente.",
        palmupUnconfigured: true,
      };
    }

    return failure(error, "Nao foi possivel iniciar o login social PalmUP.");
  }
}

export async function completeMetaPalmupConnectAction(
  pairingId: string,
): Promise<MetaManualActionResult> {
  if (!PALMUP_PAIRING_ID_PATTERN.test(pairingId)) {
    return {
      ok: false,
      message: "Conexao PalmUP invalida. Inicie novamente.",
    };
  }

  try {
    const response = await serverApiFetch<unknown>(
      "/integrations/meta/manual/palmup-connect/complete",
      {
        method: "POST",
        body: JSON.stringify({ pairingId }),
      },
    );
    revalidatePath("/integrations");
    // Parsing strips any field outside the safe discovery DTO before it reaches the browser.
    const parsed = metaManualAssetDiscoverySchema.safeParse(response);

    if (!parsed.success) {
      return {
        ok: false,
        message:
          "Meta conectada, mas a resposta nao pode ser exibida. Recarregue a pagina e escolha o token salvo.",
      };
    }

    const discovery = parsed.data as MetaManualAssetDiscoveryDto;

    return {
      ok: true,
      message:
        discovery.businesses.length > 0
          ? "Meta conectada pela PalmUP e token protegido. Agora escolha a estrutura Meta."
          : "Meta conectada pela PalmUP e token protegido. A Meta nao listou as BMs; informe o ID da estrutura.",
      discovery,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel concluir o login social PalmUP.");
  }
}

export async function discoverMetaManualAssetsAction(
  credentialId: string,
  businessId?: string | null,
): Promise<MetaManualActionResult> {
  try {
    const query = businessId
      ? `?businessId=${encodeURIComponent(businessId)}`
      : "";
    const discovery = await serverApiFetch<MetaManualAssetDiscoveryDto>(
      `/integrations/meta/manual/credentials/${encodeURIComponent(credentialId)}/assets${query}`,
    );

    return {
      ok: true,
      message: "Ativos acessiveis carregados.",
      discovery,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel consultar os ativos deste token.");
  }
}

export async function createMetaManualConnectionAction(
  formData: FormData,
): Promise<MetaManualActionResult> {
  try {
    const destinationMode = requiredFormText(formData, "destinationMode");
    const destination =
      destinationMode === "existing"
        ? {
            existingDestinationId: requiredFormText(
              formData,
              "existingDestinationId",
            ),
          }
        : {
            label: optionalFormText(formData, "destinationLabel") ?? undefined,
            ownerBusinessManagerId:
              optionalFormText(formData, "ownerBusinessManagerId") ?? null,
            pixelId: requiredFormText(formData, "pixelId"),
            pageId: requiredFormText(formData, "pageId"),
          };
    const configuration = await serverApiFetch<MetaManualConfigurationDto>(
      "/integrations/meta/manual/connections",
      {
        method: "POST",
        body: JSON.stringify({
          credentialId: requiredFormText(formData, "credentialId"),
          businessManagerId: requiredFormText(formData, "businessManagerId"),
          businessManagerName: requiredFormText(
            formData,
            "businessManagerName",
          ),
          adAccountIds: formData
            .getAll("adAccountIds")
            .map(String)
            .filter(Boolean),
          accountSelectionMode:
            optionalFormText(formData, "accountSelectionMode") ?? "merge",
          destination,
        }),
      },
    );

    const initialPeriod = await getInitialManualMetaSyncPeriod();
    let syncQueued = true;

    try {
      await serverApiFetch(
        `/reports/meta/sync?since=${initialPeriod.since}&until=${initialPeriod.until}`,
        { method: "POST" },
      );
    } catch {
      syncQueued = false;
    }

    revalidatePath("/integrations");
    revalidatePath("/reports");
    return {
      ok: true,
      message: syncQueued
        ? `Estrutura ativada. A importacao inicial de ${initialPeriod.since} a ${initialPeriod.until} foi enfileirada.`
        : "Estrutura ativada, mas o historico nao entrou na fila. Use Sincronizar Meta em Relatorios.",
      configuration,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel ativar esta estrutura Meta.");
  }
}

export async function rotateMetaManualCredentialAction(
  credentialId: string,
  formData: FormData,
): Promise<MetaManualActionResult> {
  try {
    const configuration = await serverApiFetch<MetaManualConfigurationDto>(
      `/integrations/meta/manual/credentials/${encodeURIComponent(credentialId)}/rotate`,
      {
        method: "PUT",
        body: JSON.stringify({
          accessToken: requiredFormText(formData, "accessToken"),
        }),
      },
    );

    revalidatePath("/integrations");
    return {
      ok: true,
      message: "Token substituido depois da validacao completa.",
      configuration,
    };
  } catch (error) {
    return failure(
      error,
      "O novo token nao acessa toda a estrutura desta conexao.",
    );
  }
}

export async function setMetaManualConnectionStatusAction(
  connectionId: string,
  status: "active" | "paused",
): Promise<MetaManualActionResult> {
  try {
    const configuration = await serverApiFetch<MetaManualConfigurationDto>(
      `/integrations/meta/manual/connections/${encodeURIComponent(connectionId)}/status`,
      {
        method: "PUT",
        body: JSON.stringify({ status }),
      },
    );

    revalidatePath("/integrations");
    return {
      ok: true,
      message:
        status === "paused"
          ? "Conexao pausada. As outras BMs continuam ativas."
          : "Conexao reativada.",
      configuration,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel alterar esta conexao.");
  }
}

export async function testMetaManualConnectionAction(
  connectionId: string,
): Promise<MetaManualActionResult> {
  try {
    const testResult = await serverApiFetch<MetaManualConnectionTestResultDto>(
      `/integrations/meta/manual/connections/${encodeURIComponent(connectionId)}/test`,
      { method: "POST", body: "{}" },
    );

    revalidatePath("/integrations");
    return {
      ok: true,
      message: testResult.message,
      testResult,
    };
  } catch (error) {
    return failure(error, "A conexao nao passou na validacao da Meta.");
  }
}

export async function removeMetaManualConnectionAction(
  connectionId: string,
  businessManagerId: string,
): Promise<MetaManualActionResult> {
  try {
    const configuration = await serverApiFetch<MetaManualConfigurationDto>(
      `/integrations/meta/manual/connections/${encodeURIComponent(connectionId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ businessManagerId }),
      },
    );

    revalidatePath("/integrations");
    revalidatePath("/reports");
    return {
      ok: true,
      message:
        "Estrutura removida. O historico foi preservado e as contas deixaram de sincronizar.",
      configuration,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel remover esta estrutura Meta.");
  }
}

export async function syncMetaManualHistoryAction(): Promise<MetaManualActionResult> {
  try {
    const period = await getInitialManualMetaSyncPeriod();
    await serverApiFetch(
      `/reports/meta/sync?since=${period.since}&until=${period.until}`,
      { method: "POST" },
    );

    revalidatePath("/integrations");
    revalidatePath("/reports");
    return {
      ok: true,
      message: `Importacao de ${period.since} a ${period.until} enfileirada. O andamento aparece em cada conta.`,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel enfileirar o historico da Meta.");
  }
}

export async function setMetaManualAccountDestinationAction(
  reportingAccountId: string,
  conversionDestinationId: string | null,
  conversionDestinationIds: string[],
): Promise<MetaManualActionResult> {
  try {
    const configuration = await serverApiFetch<MetaManualConfigurationDto>(
      `/integrations/meta/manual/reporting-accounts/${encodeURIComponent(reportingAccountId)}/destination`,
      {
        method: "PUT",
        body: JSON.stringify({
          conversionDestinationId,
          conversionDestinationIds,
        }),
      },
    );

    revalidatePath("/integrations");
    return {
      ok: true,
      message:
        conversionDestinationIds.length > 1
          ? `${conversionDestinationIds.length} destinos autorizados. Revise o roteamento por anuncio.`
          : conversionDestinationId
            ? "Destino especifico aplicado a esta conta."
            : "A conta voltou a usar o destino padrao da BM.",
      configuration,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel alterar o destino desta conta.");
  }
}

export async function getMetaManualAdRoutingAction(
  reportingAccountId: string,
): Promise<MetaManualActionResult> {
  try {
    const adRouting = await serverApiFetch<MetaReportingAccountAdRoutingDto>(
      `/integrations/meta/manual/reporting-accounts/${encodeURIComponent(reportingAccountId)}/ad-routing`,
    );

    return {
      ok: true,
      message: "Roteamento dos anuncios carregado.",
      adRouting,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel carregar os anuncios desta conta.");
  }
}

export async function setMetaManualAdDestinationAction(
  reportingAccountId: string,
  adId: string,
  conversionDestinationId: string | null,
): Promise<MetaManualActionResult> {
  try {
    const adRouting = await serverApiFetch<MetaReportingAccountAdRoutingDto>(
      `/integrations/meta/manual/reporting-accounts/${encodeURIComponent(reportingAccountId)}/ads/${encodeURIComponent(adId)}/destination`,
      {
        method: "PUT",
        body: JSON.stringify({ conversionDestinationId }),
      },
    );

    revalidatePath("/integrations");
    return {
      ok: true,
      message: conversionDestinationId
        ? "Destino manual aplicado ao anuncio."
        : "Excecao removida; a descoberta automatica voltou a valer.",
      adRouting,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel alterar o destino deste anuncio.");
  }
}

export async function prepareMetaOAuthAdvancedCredentialAction(): Promise<MetaManualActionResult> {
  try {
    const discovery = await serverApiFetch<MetaManualAssetDiscoveryDto>(
      "/integrations/meta/oauth/advanced/credential",
      { method: "POST", body: "{}" },
    );

    revalidatePath("/integrations");
    return {
      ok: true,
      message:
        "Login social validado. Agora vincule cada BM as suas contas, Pixel e Pagina.",
      discovery,
    };
  } catch (error) {
    return failure(
      error,
      "Nao foi possivel preparar o login social para destinos por BM.",
    );
  }
}

export async function discoverMetaOAuthAdvancedAssetsAction(
  credentialId: string,
  businessId?: string | null,
): Promise<MetaManualActionResult> {
  try {
    const query = businessId
      ? `?businessId=${encodeURIComponent(businessId)}`
      : "";
    const discovery = await serverApiFetch<MetaManualAssetDiscoveryDto>(
      `/integrations/meta/oauth/advanced/credentials/${encodeURIComponent(credentialId)}/assets${query}`,
    );

    return {
      ok: true,
      message: "Ativos do login social carregados.",
      discovery,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel consultar os ativos desta conta.");
  }
}

export async function createMetaOAuthAdvancedConnectionAction(
  formData: FormData,
): Promise<MetaManualActionResult> {
  try {
    const configuration = await serverApiFetch<MetaManualConfigurationDto>(
      "/integrations/meta/oauth/advanced/connections",
      {
        method: "POST",
        body: JSON.stringify(metaBusinessConnectionPayload(formData)),
      },
    );

    revalidatePath("/integrations");
    return {
      ok: true,
      message: configuration.advancedRoutingEnabled
        ? "Estrutura atualizada e pronta para esta BM."
        : "Estrutura salva para revisao. A rota atual continua sem alteracoes.",
      configuration,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel salvar esta estrutura OAuth.");
  }
}

export async function setMetaOAuthAdvancedConnectionStatusAction(
  connectionId: string,
  status: "active" | "paused",
): Promise<MetaManualActionResult> {
  try {
    const configuration = await serverApiFetch<MetaManualConfigurationDto>(
      `/integrations/meta/oauth/advanced/connections/${encodeURIComponent(connectionId)}/status`,
      {
        method: "PUT",
        body: JSON.stringify({ status }),
      },
    );

    revalidatePath("/integrations");
    return {
      ok: true,
      message:
        status === "paused"
          ? "BM pausada. As outras estruturas continuam ativas."
          : "BM reativada.",
      configuration,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel alterar esta estrutura OAuth.");
  }
}

export async function testMetaOAuthAdvancedConnectionAction(
  connectionId: string,
): Promise<MetaManualActionResult> {
  try {
    const testResult = await serverApiFetch<MetaManualConnectionTestResultDto>(
      `/integrations/meta/oauth/advanced/connections/${encodeURIComponent(connectionId)}/test`,
      { method: "POST", body: "{}" },
    );

    revalidatePath("/integrations");
    return {
      ok: true,
      message: testResult.message,
      testResult,
    };
  } catch (error) {
    return failure(error, "A estrutura nao passou na validacao da Meta.");
  }
}

export async function removeMetaOAuthAdvancedConnectionAction(
  connectionId: string,
  businessManagerId: string,
): Promise<MetaManualActionResult> {
  try {
    const configuration = await serverApiFetch<MetaManualConfigurationDto>(
      `/integrations/meta/oauth/advanced/connections/${encodeURIComponent(connectionId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ businessManagerId }),
      },
    );

    revalidatePath("/integrations");
    revalidatePath("/reports");
    return {
      ok: true,
      message:
        "Vinculo removido. O destino principal e o historico foram preservados.",
      configuration,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel remover este vinculo OAuth.");
  }
}

export async function setMetaOAuthAdvancedAccountDestinationAction(
  reportingAccountId: string,
  conversionDestinationId: string | null,
  conversionDestinationIds: string[],
): Promise<MetaManualActionResult> {
  try {
    const configuration = await serverApiFetch<MetaManualConfigurationDto>(
      `/integrations/meta/oauth/advanced/reporting-accounts/${encodeURIComponent(reportingAccountId)}/destination`,
      {
        method: "PUT",
        body: JSON.stringify({
          conversionDestinationId,
          conversionDestinationIds,
        }),
      },
    );

    revalidatePath("/integrations");
    return {
      ok: true,
      message:
        conversionDestinationIds.length > 1
          ? `${conversionDestinationIds.length} destinos autorizados. Revise o roteamento por anuncio.`
          : conversionDestinationId
            ? "Destino especifico aplicado a esta conta."
            : "A conta voltou a usar o destino padrao da BM.",
      configuration,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel alterar o destino desta conta.");
  }
}

export async function getMetaOAuthAdvancedAdRoutingAction(
  reportingAccountId: string,
): Promise<MetaManualActionResult> {
  try {
    const adRouting = await serverApiFetch<MetaReportingAccountAdRoutingDto>(
      `/integrations/meta/oauth/advanced/reporting-accounts/${encodeURIComponent(reportingAccountId)}/ad-routing`,
    );

    return {
      ok: true,
      message: "Roteamento dos anuncios carregado.",
      adRouting,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel carregar os anuncios desta conta.");
  }
}

export async function setMetaOAuthAdvancedAdDestinationAction(
  reportingAccountId: string,
  adId: string,
  conversionDestinationId: string | null,
): Promise<MetaManualActionResult> {
  try {
    const adRouting = await serverApiFetch<MetaReportingAccountAdRoutingDto>(
      `/integrations/meta/oauth/advanced/reporting-accounts/${encodeURIComponent(reportingAccountId)}/ads/${encodeURIComponent(adId)}/destination`,
      {
        method: "PUT",
        body: JSON.stringify({ conversionDestinationId }),
      },
    );

    revalidatePath("/integrations");
    return {
      ok: true,
      message: conversionDestinationId
        ? "Destino manual aplicado ao anuncio."
        : "Excecao removida; a descoberta automatica voltou a valer.",
      adRouting,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel alterar o destino deste anuncio.");
  }
}

export async function setMetaOAuthAdvancedRoutingAction(
  enabled: boolean,
): Promise<MetaManualActionResult> {
  try {
    const configuration = await serverApiFetch<MetaManualConfigurationDto>(
      "/integrations/meta/oauth/advanced/routing",
      {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      },
    );
    let syncQueued = true;

    if (enabled) {
      try {
        const period = await getInitialManualMetaSyncPeriod();
        await serverApiFetch(
          `/reports/meta/sync?since=${period.since}&until=${period.until}`,
          { method: "POST" },
        );
      } catch {
        syncQueued = false;
      }
    }

    revalidatePath("/integrations");
    revalidatePath("/reports");
    return {
      ok: true,
      message: enabled
        ? syncQueued
          ? "Roteamento por BM ativado. A importacao inicial foi enfileirada."
          : "Roteamento por BM ativado. Sincronize os relatorios manualmente."
        : "Roteamento avancado desativado. O destino principal voltou a valer.",
      configuration,
    };
  } catch (error) {
    return failure(error, "Nao foi possivel alterar o roteamento OAuth.");
  }
}

async function getInitialManualMetaSyncPeriod(): Promise<InitialManualMetaSyncPeriod> {
  return serverApiFetch<InitialManualMetaSyncPeriod>(
    "/reports/meta/initial-sync-period",
  );
}

function metaBusinessConnectionPayload(formData: FormData) {
  const destinationMode = requiredFormText(formData, "destinationMode");
  const destination =
    destinationMode === "existing"
      ? {
          existingDestinationId: requiredFormText(
            formData,
            "existingDestinationId",
          ),
        }
      : {
          label: optionalFormText(formData, "destinationLabel") ?? undefined,
          ownerBusinessManagerId:
            optionalFormText(formData, "ownerBusinessManagerId") ?? null,
          pixelId: requiredFormText(formData, "pixelId"),
          pageId: requiredFormText(formData, "pageId"),
        };

  return {
    credentialId: requiredFormText(formData, "credentialId"),
    businessManagerId: requiredFormText(formData, "businessManagerId"),
    businessManagerName: requiredFormText(formData, "businessManagerName"),
    adAccountIds: formData.getAll("adAccountIds").map(String).filter(Boolean),
    accountSelectionMode:
      optionalFormText(formData, "accountSelectionMode") ?? "merge",
    destination,
  };
}

function requiredFormText(formData: FormData, key: string): string {
  const value = optionalFormText(formData, key);

  if (!value) {
    throw new Error(`Campo obrigatorio ausente: ${key}`);
  }

  return value;
}

function optionalFormText(formData: FormData, key: string): string | null {
  const value = formData.get(key);

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function httpsUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function failure(error: unknown, fallback: string): MetaManualActionResult {
  return {
    ok: false,
    message:
      isApiRequestError(error) && error.message.trim()
        ? error.message
        : fallback,
  };
}
