import type {
  InboundWebhookCapabilitiesDto,
  InboundWebhookChannelDto,
  InboundWebhookConnectionDto,
  InboundWebhookConnectionOverviewDto,
  InboundWebhookProviderDto,
  IntegrationHealthSummaryDto,
  IntegrationPipelineOverviewDto,
  MetaAssetsDto,
  MetaConnectionCapabilitiesDto,
  MetaConnectionDto,
  MetaManualConfigurationDto,
  ProviderConversionRuleDto,
  CurrentWorkspaceDto,
  WhatsappConnectionDto,
} from "@wpptrack/shared";
import Link from "next/link";
import { metaAssetsSchema, whatsappConnectionsSchema } from "@wpptrack/shared";
import { Activity } from "lucide-react";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Fragment } from "react";
import { SubmitButton } from "../../../components/submit-button";
import { PresentationMask } from "../../../components/presentation-mask";
import { displayTimeZone } from "../../../lib/date-time";
import {
  isLicenseLockedError,
  serverApiFetch,
} from "../../../lib/server-api";
import { getCurrentWorkspace } from "../../../lib/current-workspace";
import {
  fetchLicenseStatus,
  licenseLockReason,
} from "../../../lib/license-status";
import { KommoCrmManager } from "../settings/kommo-crm-manager";
import { PipedriveCrmManager } from "../settings/pipedrive-crm-manager";
import {
  listKommoConnectionsAction,
  type KommoConnectionDetailDto,
} from "./kommo-actions";
import {
  listPipedriveConnectionsAction,
  type PipedriveConnectionDetailDto,
} from "./pipedrive-actions";
import {
  ensureIntegrationEndpointAction,
  removeIntegrationEndpointAction,
  retryIntegrationEventAction,
  revealIntegrationEndpointAction,
  rotateIntegrationEndpointAction,
  setRulePublicUrlAction,
} from "./single-url/single-url-actions";
import { legacyUrlsFor } from "./single-url/single-url-copy";
import { loadSingleUrlData } from "./single-url/single-url-data";
import {
  AutomationEventUrlsPanel,
  PaytSingleUrlPanel,
  type SingleUrlActions,
} from "./single-url/single-url-panels";
import { buildIntegrationCards } from "./hub/integration-cards";
import { integrationsHubInitialState } from "./hub/initial-state";
import { IntegrationsHub } from "./hub/integrations-hub";
import type { IntegrationProviderId } from "./hub/integration-registry";
import { MetaConversionDestinationForm } from "./meta-conversion-destination-form";
import {
  createInboundWebhookChannelAction,
  createInboundWebhookConnectionAction,
  removeInboundWebhookConnectionAction,
  rotateInboundWebhookSecretAction,
  saveInboundWebhookChannelRoutesAction,
  setInboundWebhookChannelStatusAction,
  setInboundWebhookConnectionStatusAction,
} from "./inbound-webhook-actions";
import {
  InboundWebhookPanel,
  type InboundWebhookConnectionView,
} from "./inbound-webhook-panel";
import {
  createWhatsappConnectionAction,
  deleteWhatsappConnectionAction,
  loadWhatsappConnectionForEditAction,
  rotateWhatsappWebhookTokenAction,
  testWhatsappConnectionAction,
  updateWhatsappConnectionAction,
} from "./whatsapp-provider-actions";
import {
  WhatsappProviderPanel,
  type WhatsappProviderId,
} from "./whatsapp-provider-panel";
import {
  completeMetaPalmupConnectAction,
  createMetaManualConnectionAction,
  createMetaManualCredentialAction,
  createMetaOAuthAdvancedConnectionAction,
  disconnectMetaOAuthAction,
  discoverMetaManualAssetsAction,
  discoverMetaOAuthAdvancedAssetsAction,
  getMetaManualAdRoutingAction,
  getMetaOAuthAdvancedAdRoutingAction,
  prepareMetaOAuthAdvancedCredentialAction,
  removeMetaManualConnectionAction,
  removeMetaOAuthAdvancedConnectionAction,
  rotateMetaManualCredentialAction,
  setMetaManualAccountDestinationAction,
  setMetaManualAdDestinationAction,
  setMetaManualConnectionStatusAction,
  setMetaOAuthAdvancedAccountDestinationAction,
  setMetaOAuthAdvancedAdDestinationAction,
  setMetaOAuthAdvancedConnectionStatusAction,
  setMetaOAuthAdvancedRoutingAction,
  startMetaPalmupConnectAction,
  testMetaManualConnectionAction,
  testMetaOAuthAdvancedConnectionAction,
  syncMetaManualHistoryAction,
} from "./meta-manual-actions";
import { MetaManualConnectionPanel } from "./meta-manual-connection-panel";
import {
  metaAssetsRefreshSucceeded,
  resolveMetaStatus,
} from "./meta-connection-state";
import { MetaReportingAccountsForm } from "./meta-reporting-accounts-form";
import { WorkspaceCurrencyProvider } from "../../../components/workspace-currency";
import { getWorkspaceCurrencySettings } from "../../../lib/currency-settings";

type ResourceResult<T> = {
  data: T;
  state: "real" | "empty" | "error";
};

type IntegrationsSearchParams = {
  aba?: string;
  abrir?: string;
  meta?: string;
  notice?: string;
};

type IntegrationsPageProps = {
  searchParams?: Promise<IntegrationsSearchParams>;
};

type AccountUserSummary = { id: string };

type PageNotice = {
  tone: "success" | "warn";
  title: string;
  message: string;
};

type LegacyWhatsappInstance = {
  id: string;
  name: string;
  provider: string;
  billingStatus: string;
  providerInstanceId: string | null;
  checkoutUrl: string | null;
  createdAt: string;
};

async function getHealth(): Promise<
  ResourceResult<IntegrationHealthSummaryDto | null>
> {
  try {
    const health = await serverApiFetch<IntegrationHealthSummaryDto>(
      "/integrations/health",
    );

    return {
      data: health,
      state: health.providers.length > 0 ? "real" : "empty",
    };
  } catch {
    return {
      data: null,
      state: "error",
    };
  }
}

async function getIntegrationPipeline(): Promise<
  ResourceResult<IntegrationPipelineOverviewDto | null>
> {
  try {
    const pipeline = await serverApiFetch<IntegrationPipelineOverviewDto>(
      "/integrations/pipeline",
    );

    return {
      data: pipeline,
      state: pipeline.stages.length > 0 ? "real" : "empty",
    };
  } catch {
    return {
      data: null,
      state: "error",
    };
  }
}

async function getCurrentWorkspaceResource(): Promise<
  ResourceResult<CurrentWorkspaceDto | null>
> {
  try {
    return {
      data: await getCurrentWorkspace(),
      state: "real",
    };
  } catch {
    return {
      data: null,
      state: "error",
    };
  }
}

async function getMetaConnection(): Promise<
  ResourceResult<MetaConnectionDto | null>
> {
  try {
    return {
      data: await serverApiFetch<MetaConnectionDto>(
        "/integrations/meta/connection",
      ),
      state: "real",
    };
  } catch {
    return {
      data: null,
      state: "error",
    };
  }
}

async function getMetaAssets(): Promise<ResourceResult<MetaAssetsDto | null>> {
  try {
    const response = await serverApiFetch<unknown>("/integrations/meta/assets");
    const parsed = metaAssetsSchema.safeParse(response);

    if (!parsed.success) {
      return { data: null, state: "error" };
    }

    return {
      data: parsed.data,
      state: "real",
    };
  } catch {
    return {
      data: null,
      state: "error",
    };
  }
}

async function getLegacyWhatsappInstances(): Promise<
  ResourceResult<LegacyWhatsappInstance[]>
> {
  try {
    const instances = await serverApiFetch<LegacyWhatsappInstance[]>(
      "/integrations/whatsapp/instances",
    );
    return {
      data: instances,
      state: instances.length > 0 ? "real" : "empty",
    };
  } catch {
    return { data: [], state: "error" };
  }
}

async function getMetaCapabilities(): Promise<
  ResourceResult<MetaConnectionCapabilitiesDto>
> {
  try {
    return {
      data: await serverApiFetch<MetaConnectionCapabilitiesDto>(
        "/integrations/meta/capabilities",
      ),
      state: "real",
    };
  } catch {
    return {
      data: {
        enabledModes: [],
        oauthEnabled: false,
        manualEnabled: false,
      },
      state: "error",
    };
  }
}

async function getMetaManualConfiguration(): Promise<
  ResourceResult<MetaManualConfigurationDto | null>
> {
  try {
    return {
      data: await serverApiFetch<MetaManualConfigurationDto>(
        "/integrations/meta/manual",
      ),
      state: "real",
    };
  } catch {
    return { data: null, state: "error" };
  }
}

async function getMetaOAuthAdvancedConfiguration(): Promise<
  ResourceResult<MetaManualConfigurationDto | null>
> {
  try {
    return {
      data: await serverApiFetch<MetaManualConfigurationDto>(
        "/integrations/meta/oauth/advanced",
      ),
      state: "real",
    };
  } catch {
    return { data: null, state: "error" };
  }
}

type InboundWebhookPageData = {
  capabilities: InboundWebhookCapabilitiesDto;
  connections: InboundWebhookConnectionView[];
  providerRules: ProviderConversionRuleDto[];
  providerRulesEnabled: boolean;
};

async function getInboundWebhookData(): Promise<
  ResourceResult<InboundWebhookPageData | null>
> {
  try {
    const [capabilities, connections, providerRulesResult] = await Promise.all([
      serverApiFetch<InboundWebhookCapabilitiesDto>(
        "/integrations/inbound-webhooks/capabilities",
      ),
      serverApiFetch<InboundWebhookConnectionDto[]>(
        "/integrations/inbound-webhooks",
      ),
      serverApiFetch<ProviderConversionRuleDto[]>(
        "/conversion-rules/providers",
      ).then(
        (providerRules) => ({ enabled: true as const, providerRules }),
        () => ({ enabled: false as const, providerRules: [] }),
      ),
    ]);
    let detailError = false;
    const views = await Promise.all(
      connections.map(async (connection) => {
        const [overviewResult, channelsResult] = await Promise.allSettled([
          serverApiFetch<InboundWebhookConnectionOverviewDto>(
            `/integrations/inbound-webhooks/${encodeURIComponent(connection.id)}/overview`,
          ),
          serverApiFetch<InboundWebhookChannelDto[]>(
            `/integrations/inbound-webhooks/${encodeURIComponent(connection.id)}/channels`,
          ),
        ]);

        if (
          overviewResult.status === "rejected" ||
          channelsResult.status === "rejected"
        ) {
          detailError = true;
        }

        return {
          overview:
            overviewResult.status === "fulfilled"
              ? overviewResult.value
              : {
                  connection,
                  counters: {
                    eligibleRouted: 0,
                    eligibleUnresolved: 0,
                    ignoredNoCtwa: 0,
                    duplicate: 0,
                    invalid: 0,
                  },
                },
          channels:
            channelsResult.status === "fulfilled" ? channelsResult.value : [],
          detailState:
            overviewResult.status === "fulfilled" &&
            channelsResult.status === "fulfilled"
              ? ("real" as const)
              : ("error" as const),
        };
      }),
    );

    return {
      data: {
        capabilities,
        connections: views,
        providerRules: providerRulesResult.providerRules,
        providerRulesEnabled: providerRulesResult.enabled,
      },
      state: detailError ? "error" : connections.length > 0 ? "real" : "empty",
    };
  } catch {
    return {
      data: null,
      state: "error",
    };
  }
}

async function getWhatsappConnections(): Promise<
  ResourceResult<WhatsappConnectionDto[]>
> {
  try {
    const connections = await serverApiFetch<unknown>(
      "/integrations/whatsapp-connections",
    );
    const parsed = whatsappConnectionsSchema.safeParse(connections);
    if (!parsed.success) {
      return { data: [], state: "error" };
    }
    return {
      data: parsed.data.filter(
        (connection) => connection.status !== "suspended",
      ),
      state: "real",
    };
  } catch {
    return { data: [], state: "error" };
  }
}

async function getAccountUser(): Promise<AccountUserSummary | null> {
  try {
    const account = await serverApiFetch<{ user?: { id?: unknown } }>(
      "/auth/me",
    );

    return typeof account.user?.id === "string"
      ? { id: account.user.id }
      : null;
  } catch {
    return null;
  }
}

type KommoSettingsResult = {
  connections: KommoConnectionDetailDto[];
  // "forbidden"/"error" must never collapse into "empty": that would render
  // the "no connections yet" create form on top of a load failure, inviting
  // a duplicate connection against an account that may already have one.
  state: "real" | "empty" | "error" | "forbidden";
};

async function getKommoSettings(
  workspaceId: string | null,
  enabled: boolean,
): Promise<KommoSettingsResult> {
  if (!workspaceId || !enabled) {
    return { connections: [], state: "empty" };
  }

  try {
    const result = await listKommoConnectionsAction(workspaceId);

    if (result.ok) {
      return {
        connections: result.connections,
        state: result.connections.length > 0 ? "real" : "empty",
      };
    }

    return {
      connections: [],
      state: result.reason === "unauthorized" ? "forbidden" : "error",
    };
  } catch {
    return { connections: [], state: "error" };
  }
}

type PipedriveSettingsResult = {
  connections: PipedriveConnectionDetailDto[];
  // Same rule as Kommo: a failed load never collapses into "empty".
  state: "real" | "empty" | "error" | "forbidden";
};

async function getPipedriveSettings(
  workspaceId: string | null,
  enabled: boolean,
): Promise<PipedriveSettingsResult> {
  if (!workspaceId || !enabled) {
    return { connections: [], state: "empty" };
  }

  try {
    const result = await listPipedriveConnectionsAction(workspaceId);

    if (result.ok) {
      return {
        connections: result.connections,
        state: result.connections.length > 0 ? "real" : "empty",
      };
    }

    return {
      connections: [],
      state: result.reason === "unauthorized" ? "forbidden" : "error",
    };
  } catch {
    return { connections: [], state: "error" };
  }
}

async function refreshMetaAssets(formData: FormData) {
  "use server";

  const businessId = nullableFormText(formData, "businessId");
  let target = "/integrations?notice=meta-assets-refresh-error";

  try {
    const assets = await serverApiFetch<MetaAssetsDto>(
      "/integrations/meta/assets/refresh",
      {
        method: "POST",
        body: JSON.stringify({ businessId }),
      },
    );

    if (!metaAssetsRefreshSucceeded(assets)) {
      throw new Error("MetaAssetsRefreshNotConnected");
    }

    revalidatePath("/integrations");
    target = "/integrations?notice=meta-assets-refreshed";
  } catch (error) {
    target = isLicenseLockedError(error)
      ? "/integrations?notice=meta-license-locked"
      : "/integrations?notice=meta-assets-refresh-error";
  }

  redirect(target);
}

async function saveMetaConversionDestination(formData: FormData) {
  "use server";

  const businessId = formText(formData, "businessId");
  const pixelId = formText(formData, "pixelId");
  const pixelName = formText(formData, "pixelName");
  const pageId = formText(formData, "pageId");
  const pageName = formText(formData, "pageName");

  if (!businessId || !pixelId || !pixelName || !pageId || !pageName) {
    redirect("/integrations?notice=meta-destination-missing");
  }

  let target = "/integrations?notice=meta-destination-error";

  try {
    await serverApiFetch("/integrations/meta/conversion-destination", {
      method: "PUT",
      body: JSON.stringify({
        pixelId,
        pixelName,
        pageId,
        pageName,
      }),
    });
    revalidatePath("/integrations");
    target = "/integrations?notice=meta-destination-saved";
  } catch (error) {
    target = isLicenseLockedError(error)
      ? "/integrations?notice=meta-license-locked"
      : "/integrations?notice=meta-destination-error";
  }

  redirect(target);
}

async function loadMetaBusinessDestinationAssets(
  businessId: string,
): Promise<Pick<MetaAssetsDto, "pixels" | "pages">> {
  "use server";

  const normalizedBusinessId = businessId.trim();

  if (!normalizedBusinessId) {
    return { pixels: [], pages: [] };
  }

  try {
    const assets = await serverApiFetch<MetaAssetsDto>(
      "/integrations/meta/assets/refresh",
      {
        method: "POST",
        body: JSON.stringify({ businessId: normalizedBusinessId }),
      },
    );
    return {
      pixels: assets.pixels,
      pages: assets.pages ?? [],
    };
  } catch {
    return { pixels: [], pages: [] };
  }
}

async function saveMetaReportingAccount(formData: FormData) {
  "use server";

  const businessId = formText(formData, "businessId");
  const businessName = formText(formData, "businessName");
  const adAccountId = formText(formData, "adAccountId");
  const adAccountName = formText(formData, "adAccountName");
  const currency = nullableFormText(formData, "currency");
  const timezoneName = nullableFormText(formData, "timezoneName");

  if (!businessId || !businessName || !adAccountId || !adAccountName) {
    redirect("/integrations?notice=meta-reporting-missing");
  }

  let target = "/integrations?notice=meta-reporting-error";

  try {
    await serverApiFetch("/integrations/meta/reporting-accounts", {
      method: "POST",
      body: JSON.stringify({
        businessId,
        businessName,
        adAccountId,
        adAccountName,
        currency,
        timezoneName,
      }),
    });
    revalidatePath("/integrations");
    target = "/integrations?notice=meta-reporting-saved";
  } catch (error) {
    target = isLicenseLockedError(error)
      ? "/integrations?notice=meta-license-locked"
      : "/integrations?notice=meta-reporting-error";
  }

  redirect(target);
}

async function loadMetaBusinessReportingAssets(
  businessId: string,
): Promise<Pick<MetaAssetsDto, "adAccounts">> {
  "use server";

  const normalizedBusinessId = businessId.trim();

  if (!normalizedBusinessId) {
    return { adAccounts: [] };
  }

  try {
    const assets = await serverApiFetch<MetaAssetsDto>(
      "/integrations/meta/assets/refresh",
      {
        method: "POST",
        body: JSON.stringify({ businessId: normalizedBusinessId }),
      },
    );
    return {
      adAccounts: assets.adAccounts,
    };
  } catch {
    return { adAccounts: [] };
  }
}

async function setMetaReportingAccountStatus(formData: FormData) {
  "use server";

  const id = formText(formData, "id");
  const active = formText(formData, "active") === "true";

  if (!id) {
    redirect("/integrations?notice=meta-reporting-status-error");
  }

  let target = "/integrations?notice=meta-reporting-status-error";

  try {
    await serverApiFetch(
      `/integrations/meta/reporting-accounts/${encodeURIComponent(id)}/status`,
      {
        method: "PUT",
        body: JSON.stringify({ active }),
      },
    );
    revalidatePath("/integrations");
    target = "/integrations?notice=meta-reporting-status-saved";
  } catch (error) {
    target = isLicenseLockedError(error)
      ? "/integrations?notice=meta-license-locked"
      : "/integrations?notice=meta-reporting-status-error";
  }

  redirect(target);
}

function money(cents: number | null | undefined) {
  if (!cents) {
    return "Aguardando preco";
  }

  return (cents / 100).toLocaleString("pt-BR", {
    currency: "BRL",
    style: "currency",
  });
}

function providerTitle(provider: string) {
  const titles: Record<string, string> = {
    // F5.2: health summary now reports the WhatsappProviderRegistry id
    // "uazapi_byo" instead of "uazapi" — keep the old key too in case an
    // older API build is still serving traffic during a rolling deploy.
    uazapi_byo: "WhatsApp (Uazapi BYO)",
    nod_api: "WhatsApp (NOD API / PalmUP)",
    waha: "WhatsApp (WAHA)",
    zapi: "WhatsApp (Z-API)",
    uazapi: "WhatsApp / NOD API",
    meta: "Meta OAuth",
    asaas: "Asaas",
  };

  return titles[provider] ?? "Provedor desconhecido";
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    connected: "Configurado",
    disconnected: "Configurar",
    not_connected: "Nao conectado",
    error: "Erro",
    pending_payment: "Aguardando ativação",
    active: "Ativa",
    needs_reconnect: "Reconectar",
    not_configured: "Nao configurado",
    pending: "Aguardando",
    qr_required: "QR pendente",
    syncing: "Sincronizando",
    completed: "Sincronizado",
    failed: "Falha na sincronizacao",
    configured: "Configurado",
    needs_configuration: "Configurar",
  };

  return labels[status] ?? "Status desconhecido";
}

function sourceSyncLabel(value: string | null | undefined) {
  if (!value) {
    return "Aguardando primeira sincronizacao";
  }

  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: displayTimeZone,
  });
}

function formText(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function nullableFormText(formData: FormData, key: string): string | null {
  const value = formText(formData, key);

  return value || null;
}

function integrationsNotice(
  searchParams: IntegrationsSearchParams,
): PageNotice | null {
  const notice = searchParams.notice;
  const meta = searchParams.meta;

  if (meta === "connected") {
    return {
      tone: "success",
      title: "Meta conectada",
      message:
        "A conexao foi salva. Selecione BM, Pixel, pagina e contas de relatorio.",
    };
  }

  if (meta === "error") {
    return {
      tone: "warn",
      title: "Falha ao conectar Meta",
      message:
        "Tente conectar novamente ou revise o retorno do OAuth no diagnostico.",
    };
  }

  const notices: Record<string, PageNotice> = {
    "meta-destination-saved": {
      tone: "success",
      title: "Destino salvo",
      message:
        "Pixel e pagina principal foram salvos para o envio de conversoes.",
    },
    "meta-destination-error": {
      tone: "warn",
      title: "Destino nao salvo",
      message: "Nao foi possivel salvar Pixel e pagina agora. Tente novamente.",
    },
    "meta-destination-missing": {
      tone: "warn",
      title: "Destino incompleto",
      message: "Selecione BM, Pixel e pagina antes de salvar.",
    },
    "meta-assets-refreshed": {
      tone: "success",
      title: "Ativos Meta atualizados",
      message:
        "BMs, contas, Pixels e paginas foram salvos para carregamento rapido.",
    },
    "meta-assets-refresh-error": {
      tone: "warn",
      title: "Ativos nao atualizados",
      message:
        "Nao foi possivel sincronizar ativos Meta agora. Tente novamente.",
    },
    "meta-reporting-saved": {
      tone: "success",
      title: "Conta adicionada",
      message: "A conta de anuncio foi adicionada aos relatorios.",
    },
    "meta-reporting-error": {
      tone: "warn",
      title: "Conta nao adicionada",
      message: "Nao foi possivel adicionar a conta aos relatorios agora.",
    },
    "meta-reporting-missing": {
      tone: "warn",
      title: "Conta incompleta",
      message: "Selecione BM e conta de anuncio antes de adicionar.",
    },
    "meta-reporting-status-saved": {
      tone: "success",
      title: "Status atualizado",
      message: "A conta de anuncio foi atualizada nos relatorios.",
    },
    "meta-reporting-status-error": {
      tone: "warn",
      title: "Status nao atualizado",
      message: "Nao foi possivel alterar o status da conta agora.",
    },
    "meta-license-locked": {
      tone: "warn",
      title: "Licença bloqueada",
      message:
        "Alterações estão indisponíveis enquanto a licença estiver bloqueada. Verifique /backoffice/license.",
    },
  };

  return notice ? (notices[notice] ?? null) : null;
}

function metaConnectionTitle(
  status?: MetaAssetsDto["status"] | MetaConnectionDto["status"],
) {
  if (status === "connected") {
    return "Meta conectado";
  }

  if (status === "needs_reconnect") {
    return "Meta precisa reconectar";
  }

  if (status === "error") {
    return "Meta com erro";
  }

  if (status && status !== "not_connected") {
    return "Meta com status desconhecido";
  }

  return "Meta nao conectado";
}

function metaAssetsDetail(
  metaAssets: MetaAssetsDto | null,
  state: ResourceResult<MetaAssetsDto | null>["state"],
) {
  if (!metaAssets) {
    return state === "error"
      ? "Nao foi possivel ler os ativos Meta agora."
      : "Conecte a conta Meta para carregar os ativos.";
  }

  if (metaAssets.status === "not_connected") {
    return "Conecte a conta Meta para carregar BMs, contas de anuncio e Pixels.";
  }

  if (metaAssets.syncError) {
    return metaAssets.syncError;
  }

  if (
    metaAssets.lastSyncedAt &&
    metaAssets.status === "connected" &&
    metaAssets.businesses.length === 0
  ) {
    return "A Meta nao retornou nenhum BM para este usuario. Confirme o acesso ao Business Manager e conecte novamente.";
  }

  if (
    metaAssets.lastSyncedAt &&
    metaAssets.businesses.length > 0 &&
    metaAssets.adAccounts.length === 0 &&
    metaAssets.pixels.length === 0 &&
    (metaAssets.pages ?? []).length === 0
  ) {
    return "Os BMs foram carregados, mas o BM selecionado nao retornou conta de anuncio, Pixel ou Pagina. Selecione outro BM ou revise as permissoes Meta.";
  }

  if (
    metaAssets.businesses.length === 0 &&
    metaAssets.adAccounts.length === 0 &&
    metaAssets.pixels.length === 0
  ) {
    return "Conta conectada. Clique em Atualizar ativos Meta para buscar BMs, contas, Pixels e paginas.";
  }

  return "Ativos disponiveis para selecionar no proximo passo do fluxo operacional.";
}

function metaLastSyncedAt(metaAssets: MetaAssetsDto | null) {
  if (!metaAssets?.lastSyncedAt) {
    return "Ativos ainda nao sincronizados neste workspace.";
  }

  return `Ativos atualizados em ${new Date(
    metaAssets.lastSyncedAt,
  ).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  })}.`;
}

function pipelineWidth(value: number, maxValue: number) {
  if (maxValue <= 0 || value <= 0) {
    return "0%";
  }

  return `${Math.max(8, Math.round((value / maxValue) * 100))}%`;
}

export default async function IntegrationsPage({
  searchParams,
}: IntegrationsPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const pageNotice = integrationsNotice(resolvedSearchParams);
  const [
    healthResult,
    metaConnectionResult,
    metaAssetsResult,
    pipelineResult,
    workspaceResult,
    metaCapabilitiesResult,
    accountUser,
    licenseStatus,
  ] = await Promise.all([
    getHealth(),
    getMetaConnection(),
    getMetaAssets(),
    getIntegrationPipeline(),
    getCurrentWorkspaceResource(),
    getMetaCapabilities(),
    getAccountUser(),
    fetchLicenseStatus(),
  ]);
  const usesExternalWhatsapp =
    pipelineResult.data?.whatsappSource?.mode === "external";
  const health = healthResult.data;
  const metaConnection = metaConnectionResult.data;
  const metaAssets = metaAssetsResult.data;
  const metaCapabilities = metaCapabilitiesResult.data;
  const legacyMetaConnected = metaConnection?.status === "connected";
  const oauthEnabled =
    metaCapabilitiesResult.state === "real" && metaCapabilities.oauthEnabled;
  const manualEnabled =
    metaCapabilitiesResult.state === "real" && metaCapabilities.manualEnabled;
  const oauthConnected = legacyMetaConnected && oauthEnabled;
  const workspace = workspaceResult.data;
  const isPlatformSupport = workspace?.accessMode === "platform_support";
  const isPlatformOwnerSupport = Boolean(
    isPlatformSupport && workspace?.platformRole === "platform_owner",
  );
  // The Kommo routes are owner-only on the API (members get 403), so the UI
  // only loads them for owners with integration permission.
  const canManageKommo = Boolean(
    workspace &&
      workspace.role === "owner" &&
      workspace.permissions?.canManageIntegrations &&
      (!isPlatformSupport || isPlatformOwnerSupport),
  );
  const kommoViewerId = accountUser?.id ?? null;
  const [
    metaManualResult,
    inboundWebhookResult,
    whatsappConnectionsResult,
    legacyWhatsappInstancesResult,
    kommoSettings,
    pipedriveSettings,
    singleUrlData,
  ] = await Promise.all([
    oauthConnected
      ? getMetaOAuthAdvancedConfiguration()
      : manualEnabled
        ? getMetaManualConfiguration()
        : Promise.resolve({ data: null, state: "empty" } as const),
    getInboundWebhookData(),
    getWhatsappConnections(),
    getLegacyWhatsappInstances(),
    getKommoSettings(
      workspace?.id ?? null,
      canManageKommo && Boolean(kommoViewerId),
    ),
    // Pipedrive routes share the owner-only guard of Kommo.
    getPipedriveSettings(
      workspace?.id ?? null,
      canManageKommo && Boolean(kommoViewerId),
    ),
    // Fase 5.3: cada leitura falha sozinha (uma API antiga não derruba a tela).
    loadSingleUrlData(),
  ]);
  const licenseLocked = Boolean(
    licenseStatus && licenseLockReason(licenseStatus) !== null,
  );
  const inboundWebhookData = inboundWebhookResult.data;
  const pipeline = pipelineResult.data;
  const isPlatformOperator = Boolean(workspace?.platformRole);
  const workspacePermissionsUnavailable = workspaceResult.state === "error";
  const canManageIntegrations = Boolean(
    workspace?.permissions?.canManageIntegrations,
  );
  const maxPipelineValue = Math.max(
    ...(pipeline?.stages ?? []).map((stage) => stage.value),
    0,
  );
  const hasIntegrationError = [
    healthResult.state,
    metaConnectionResult.state,
    metaAssetsResult.state,
    pipelineResult.state,
    workspaceResult.state,
    metaCapabilitiesResult.state,
    ...(oauthConnected || manualEnabled ? [metaManualResult.state] : []),
    ...(inboundWebhookData?.capabilities.enabled
      ? [inboundWebhookResult.state]
      : []),
  ].includes("error");

  const metaStatus = resolveMetaStatus(
    metaConnection?.status,
    metaAssets?.status,
  );
  const activeReportingAccounts = (metaAssets?.reportingAccounts ?? []).filter(
    (account) => account.active,
  ).length;
  const manualActiveConnections =
    metaManualResult.data?.businessConnections.filter(
      (connection) => connection.status === "active",
    ).length ?? 0;
  const manualActiveReportingAccounts =
    metaManualResult.data?.reportingAccounts.filter((account) => account.active)
      .length ?? 0;
  const manualConfigured = manualActiveConnections > 0;
  const oauthAdvancedEnabled = Boolean(
    oauthConnected && metaManualResult.data?.advancedRoutingEnabled,
  );
  const metaRefreshBusinessId =
    metaAssets?.selection?.businessId &&
    metaAssets.businesses.some(
      (business) => business.id === metaAssets.selection?.businessId,
    )
      ? metaAssets.selection.businessId
      : (metaAssets?.businesses?.[0]?.id ?? "");
  const integrations =
    health?.providers.map((item) => ({
      title: providerTitle(item.provider),
      status: statusLabel(item.status),
      tone: item.status === "connected" ? "" : "warn",
      description:
        item.message ??
        "Credenciais encontradas. Proxima etapa depende do fluxo operacional do provedor.",
      detail: `Verificado em ${new Date(item.checkedAt).toLocaleTimeString(
        "pt-BR",
        {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: displayTimeZone,
        },
      )}`,
    })) ?? [];
  const metaStatusLabel =
    metaAssetsResult.state === "error" && metaConnectionResult.state === "error"
      ? "API indisponivel"
      : manualConfigured && metaManualResult.data?.connectionMode === "manual"
        ? "Conectado por token"
        : oauthAdvancedEnabled
          ? "OAuth com destinos por BM"
          : metaStatus
            ? statusLabel(metaStatus)
            : "Meta nao conectado";
  const inboundConnectionCount =
    inboundWebhookData?.connections.filter(
      ({ overview }) => overview.connection.status !== "paused",
    ).length ?? 0;
  const legacyWhatsappInstances = legacyWhatsappInstancesResult.data;
  const inboundConnections = inboundWebhookData?.connections ?? [];
  const allInboundChannels = inboundConnections.flatMap(
    ({ channels }) => channels,
  );
  const inboundConnectionsFor = (provider: string) =>
    inboundConnections.filter(
      ({ overview }) => overview.connection.provider === provider,
    );
  const apiUnavailableForMeta =
    metaAssetsResult.state === "error" &&
    metaConnectionResult.state === "error";
  const metaConnected = !apiUnavailableForMeta && (manualConfigured || metaStatus === "connected");
  const metaNeedsAttention =
    apiUnavailableForMeta ||
    metaStatus === "needs_reconnect" ||
    metaStatus === "error";
  const metaCardLabel = apiUnavailableForMeta
    ? "Não foi possível verificar"
    : metaStatus === "needs_reconnect"
      ? "Reconectar"
      : metaStatus === "error"
        ? "Com erro"
        : metaConnected
          ? "Conectada"
          : "Disponível";
  // Kommo is owner-only on the API: for everyone else the card says so
  // instead of looking like an empty, connectable CRM.
  const kommoCardLoadState =
    workspace && !canManageKommo
      ? ("forbidden" as const)
      : kommoSettings.state;
  const pipedriveCardLoadState =
    workspace && !canManageKommo
      ? ("forbidden" as const)
      : pipedriveSettings.state;

  // Payt has no connection: its rules live in Conversões.
  const paytRules = (inboundWebhookData?.providerRules ?? []).filter(
    (rule) => rule.automationSource === "payt",
  );

  // Fase 5.3: URL única (Payt) e URLs por evento (Unnichat e Umbler).
  const singleUrlEnabled = Boolean(singleUrlData.endpoints?.enabled);
  const singleUrlEndpoints = singleUrlData.endpoints?.endpoints ?? [];
  const singleUrlLegacy = singleUrlData.endpoints?.legacyUrls ?? [];
  // A API é a fonte da permissão (membros só leem); a sessão confirma.
  const canManageSingleUrl =
    canManageIntegrations && (singleUrlData.endpoints?.canManage ?? true);
  const singleUrlActions: SingleUrlActions = {
    ensure: ensureIntegrationEndpointAction,
    reveal: revealIntegrationEndpointAction,
    rotate: rotateIntegrationEndpointAction,
    remove: removeIntegrationEndpointAction,
    retry: retryIntegrationEventAction,
    setPublicUrl: setRulePublicUrlAction,
  };
  const paytIntegrationUrl =
    singleUrlEndpoints.find((endpoint) => endpoint.provider === "payt") ??
    null;
  const ruleEventsFor = (origin: string) => [
    ...new Set(
      (inboundWebhookData?.providerRules ?? [])
        .filter(
          (rule) =>
            (rule.origin === origin ||
              (origin === "automation_payt" &&
                rule.automationSource === "payt")) &&
            rule.conversionRule.active,
        )
        .map((rule) => rule.conversionRule.eventName),
    ),
  ];
  const singleUrlNumberNames = Object.fromEntries(
    inboundConnections
      .flatMap(({ channels }) => channels)
      .map((channel) => [
        channel.id,
        channel.channelName ?? channel.connectedPhone ?? "Número",
      ]),
  );

  const cards = buildIntegrationCards({
    inbound: inboundWebhookData
      ? {
          enabled: inboundWebhookData.capabilities.enabled,
          providers: inboundWebhookData.capabilities.providers,
          connections: inboundConnections.map(({ overview }) => ({
            provider: overview.connection.provider,
            status: overview.connection.status,
          })),
        }
      : null,
    whatsapp: {
      loaded: whatsappConnectionsResult.state !== "error",
      connections: whatsappConnectionsResult.data.map((connection) => ({
        provider: connection.provider,
        status: connection.status,
      })),
      legacyUazapiInstances: usesExternalWhatsapp
        ? 0
        : legacyWhatsappInstances.length + inboundConnectionsFor("uazapi").length,
    },
    payt: {
      loaded:
        Boolean(inboundWebhookData) && inboundWebhookData!.providerRulesEnabled,
      ruleCount: paytRules.length,
      activeRuleCount: paytRules.filter((rule) => rule.conversionRule.active)
        .length,
      integrationUrl: Boolean(paytIntegrationUrl),
    },
    crm: {
      kommo: {
        loadState: kommoCardLoadState,
        statuses: kommoSettings.connections.map((connection) => connection.status),
      },
      pipedrive: {
        loadState: pipedriveCardLoadState,
        statuses: pipedriveSettings.connections.map(
          (connection) => connection.status,
        ),
      },
    },
    meta: {
      connected: metaConnected,
      needsAttention: metaNeedsAttention,
      statusLabel: metaCardLabel,
    },
  });
  const initialHubState = integrationsHubInitialState(resolvedSearchParams);

  const rulesLink = {
    label: "Regras de conversão",
    href: "/conversions",
  };

  function whatsappProviderPanel(
    provider: WhatsappProviderId,
    allowCreate = true,
  ) {
    return (
      <WhatsappProviderPanel
        provider={provider}
        allowCreate={allowCreate}
        connections={whatsappConnectionsResult.data}
        canManage={canManageIntegrations}
        createAction={createWhatsappConnectionAction}
        testAction={testWhatsappConnectionAction}
        rotateAction={rotateWhatsappWebhookTokenAction}
        editAction={updateWhatsappConnectionAction}
        loadEditAction={loadWhatsappConnectionForEditAction}
        deleteAction={deleteWhatsappConnectionAction}
        licenseLocked={licenseLocked}
      />
    );
  }

  function inboundPanel(
    provider: InboundWebhookProviderDto,
    options: { allowCreate?: boolean; scopeDescription?: string } = {},
  ) {
    if (!inboundWebhookData) {
      return (
        <p className="feedback-banner warn" role="status">
          Não foi possível carregar as conexões agora. Atualize a página em
          instantes.
        </p>
      );
    }

    return (
      <InboundWebhookPanel
        provider={provider}
        allowCreate={options.allowCreate}
        scopeDescription={options.scopeDescription}
        canRecover={Boolean(
          workspace?.role === "owner" && workspace?.accessMode === "member",
        )}
        capabilities={inboundWebhookData.capabilities}
        connections={inboundWebhookData.connections}
        providerRules={inboundWebhookData.providerRules}
        providerRulesEnabled={inboundWebhookData.providerRulesEnabled}
        metaConfiguration={metaManualResult.data}
        canManage={canManageIntegrations}
        createAction={createInboundWebhookConnectionAction}
        rotateSecretAction={rotateInboundWebhookSecretAction}
        setConnectionStatusAction={setInboundWebhookConnectionStatusAction}
        removeConnectionAction={removeInboundWebhookConnectionAction}
        createChannelAction={createInboundWebhookChannelAction}
        setChannelStatusAction={setInboundWebhookChannelStatusAction}
        saveRoutesAction={saveInboundWebhookChannelRoutesAction}
        licenseLocked={licenseLocked}
      />
    );
  }

  const hasWhatsappNumber = inboundConnections.length > 0;
  const automationUrlsPanel = (provider: "unnichat" | "umbler") =>
    singleUrlEnabled ? (
      <div className="integration-modal-stack">
        <AutomationEventUrlsPanel
          provider={provider}
          endpoints={singleUrlEndpoints.filter(
            (endpoint) => endpoint.provider === provider,
          )}
          unattributed={singleUrlData.unattributed[provider]}
          legacyUrls={legacyUrlsFor(singleUrlLegacy, provider)}
          ruleEvents={ruleEventsFor(`automation_${provider}`)}
          canManage={canManageSingleUrl}
          licenseLocked={licenseLocked}
          actions={singleUrlActions}
          numberNames={singleUrlNumberNames}
        />
        {inboundPanel(provider)}
      </div>
    ) : (
      inboundPanel(provider)
    );
  const paytRulesBlock = (
    <div className="integration-modal-note">
      <strong>Regras de venda</strong>
      <p className="muted">
        Crie uma regra por evento (compra aprovada, Pix/boleto gerado,
        carrinho abandonado), para todos os números ou só para alguns, e, se
        quiser, só para certos produtos. A venda segue para a regra do número
        por onde o comprador chegou.
      </p>
      {hasWhatsappNumber ? (
        <Link
          className="button primary"
          href={
            paytRules.length > 0
              ? "/conversions"
              : "/conversions?nova=automation_payt"
          }
        >
          {paytRules.length > 0
            ? "Gerenciar regras da Payt"
            : "Criar regra de venda da Payt"}
        </Link>
      ) : (
        <>
          <p className="muted">
            Antes, conecte um número de WhatsApp para saber de qual anúncio veio
            cada comprador.
          </p>
          <a className="button" href="#integracao-whatsapp">
            Ir para WhatsApp
          </a>
        </>
      )}
    </div>
  );
  const paytPanel = singleUrlEnabled ? (
    <div className="integration-modal-stack">
      <PaytSingleUrlPanel
        endpoint={paytIntegrationUrl}
        products={singleUrlData.paytProducts}
        unattributed={singleUrlData.unattributed.payt}
        legacyUrls={legacyUrlsFor(singleUrlLegacy, "payt")}
        ruleEvents={ruleEventsFor("automation_payt")}
        canManage={canManageSingleUrl}
        licenseLocked={licenseLocked}
        actions={singleUrlActions}
        numberNames={singleUrlNumberNames}
      />
      {paytRulesBlock}
    </div>
  ) : (
    <div className="integration-modal-stack">
      <div className="integration-modal-note">
        <strong>
          {paytRules.length > 0
            ? `${paytRules.length} ${paytRules.length === 1 ? "regra de venda configurada" : "regras de venda configuradas"}`
            : "Como funciona"}
        </strong>
        <p className="muted">
          A Payt não tem conexão própria. Ela funciona por regra em Conversões:
          cada regra gera uma URL de postback, que você cola na Payt. Quando o
          comprador é um lead que chegou pelo WhatsApp, a venda vai para a Meta
          como conversão do anúncio de origem.
        </p>
        <ol className="integration-steps">
          <li>
            Em Conversões, crie uma regra de venda da Payt (compra aprovada,
            Pix/boleto gerado ou carrinho abandonado).
          </li>
          <li>
            Copie a URL gerada e cole na Payt, em Postback. Ela aparece uma
            única vez.
          </li>
          <li>
            A regra começa em observação; ative o envio quando conferir as
            primeiras vendas.
          </li>
        </ol>
        {hasWhatsappNumber ? (
          <Link
            className="button primary"
            href={
              paytRules.length > 0
                ? "/conversions"
                : "/conversions?nova=automation_payt"
            }
          >
            {paytRules.length > 0
              ? "Gerenciar regras da Payt"
              : "Criar regra de venda da Payt"}
          </Link>
        ) : (
          <>
            <p className="muted">
              Antes, conecte um número de WhatsApp para saber de qual anúncio
              veio cada comprador.
            </p>
            <a className="button" href="#integracao-whatsapp">
              Ir para WhatsApp
            </a>
          </>
        )}
      </div>
    </div>
  );

  const uazapiPanel = (
    <div className="integration-modal-stack">
      {whatsappProviderPanel("uazapi_byo")}
      {!usesExternalWhatsapp ? (
        <div className="surface-panel whatsapp-instance-panel">
          <span className="eyebrow">Instância por variável de ambiente</span>
          <h2>Instancia Uazapi (BYO)</h2>
          <p className="muted">
            Esta edicao tambem le uma instancia Uazapi configurada por variavel
            de ambiente (UAZAPI_BASE_URL/UAZAPI_TOKEN). Nao ha marketplace de
            instancias nem cobranca dentro do painel.
          </p>
          <div className="metric-grid compact">
            <div className="metric-card">
              <span className="micro-label">Status Uazapi</span>
              <strong>
                {statusLabel(
                  health?.providers.find(
                    (item) => item.provider === "uazapi_byo",
                  )?.status ?? "not_configured",
                )}
              </strong>
            </div>
            <div className="metric-card">
              <span className="micro-label">Webhooks recebidos</span>
              <strong>
                {inboundConnectionCount > 0
                  ? `${inboundConnectionCount} webhook${inboundConnectionCount === 1 ? "" : "s"}`
                  : "Nenhum webhook ativo"}
              </strong>
            </div>
          </div>
          {legacyWhatsappInstancesResult.state === "error" ? (
            <p className="muted">Nao foi possivel carregar instancias.</p>
          ) : legacyWhatsappInstances.length > 0 ? (
            <div className="inbound-connection-list">
              {legacyWhatsappInstances.map((instance) => (
                <div className="inbound-connection-body" key={instance.id}>
                  <strong>{instance.name}</strong>
                  <span>{instance.providerInstanceId ?? instance.id}</span>
                  <span>{statusLabel(instance.billingStatus)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {inboundConnectionsFor("uazapi").length > 0
        ? inboundPanel("uazapi", {
            allowCreate: false,
            scopeDescription:
              "Conexoes recebidas da Uazapi: confira os numeros e escolha quais canais enviam conversoes.",
          })
        : null}
    </div>
  );

  const crmUnavailableNote = (crmName: string) => (
    <div className="integration-modal-note">
      <strong>Não foi possível carregar o {crmName}</strong>
      <p className="muted">
        Não foi possível confirmar a sua conta agora. Atualize a página em
        instantes.
      </p>
    </div>
  );
  const crmOwnerOnlyNote = (
    <div className="integration-modal-note">
      <strong>Somente o dono da conta conecta CRMs</strong>
      <p className="muted">
        Peça ao dono da conta para conectar ou alterar o CRM. Depois de
        conectado, as conversões passam a valer para todos os números.
      </p>
    </div>
  );

  const metaPanel = (
    <div className="integration-modal-stack integration-meta-domain">
          {oauthEnabled ? (
            <div className="connection-callout integration-meta-oauth">
              <div>
                <span className="micro-label">Login social Facebook</span>
                <strong>
                  {metaStatus === "not_connected"
                    ? "Conectar conta Meta"
                    : metaConnectionTitle(metaStatus)}
                </strong>
                <p className="muted">
                  Use o OAuth oficial para autorizar BM, contas de anuncio e
                  Pixels. O token nasce no backend e fica criptografado.
                </p>
              </div>
              {canManageIntegrations || workspacePermissionsUnavailable ? (
                <div className="meta-connection-actions">
                  {canManageIntegrations ? (
                    <form action={refreshMetaAssets}>
                      <input
                        type="hidden"
                        name="businessId"
                        value={metaRefreshBusinessId}
                      />
                      <SubmitButton
                        disabled={metaStatus !== "connected"}
                        pendingLabel="Atualizando..."
                        statusText="Buscando ativos no Meta e salvando snapshot."
                      >
                        Atualizar ativos Meta
                      </SubmitButton>
                    </form>
                  ) : (
                    <span className="action-note warn">
                      Permissoes temporariamente indisponiveis. A API validara a
                      acao ao continuar.
                    </span>
                  )}
                </div>
              ) : (
                <span className="event-chip warn">
                  {workspacePermissionsUnavailable
                    ? "permissoes indisponiveis"
                    : "sem permissao"}
                </span>
              )}
            </div>
          ) : manualEnabled ? (
            <div className="connection-callout integration-meta-manual">
              <div>
                <span className="micro-label">Conexao manual Meta</span>
                <strong>Configure a estrutura Meta manualmente</strong>
                <p className="muted">
                  Use o App ID e o token permanente do usuario do sistema.
                  Depois informe manualmente o BM, Pixel, Pagina e conta de
                  anuncios.
                </p>
              </div>
            </div>
          ) : (
            <div className="connection-callout integration-meta-unavailable">
              <div>
                <span className="micro-label">
                  Configuracao Meta indisponivel
                </span>
                <strong>Nao foi possivel confirmar os modos de conexao</strong>
                <p className="muted">
                  Tente novamente quando a configuracao da Meta estiver
                  disponivel.
                </p>
              </div>
            </div>
          )}
          {legacyMetaConnected && workspacePermissionsUnavailable ? (
            <div className="connection-callout">
              <div>
                <span className="micro-label">Conta Meta</span>
                <strong>Trocar conta Meta</strong>
                <p className="muted">
                  Aguarde a confirmacao das permissoes para trocar a conta. A
                  API validara a acao antes de qualquer alteracao.
                </p>
              </div>
            </div>
          ) : null}
          <MetaManualConnectionPanel
            workspaceId={metaConnection?.workspaceId ?? workspace?.id ?? ""}
            capabilities={metaCapabilities}
            initialConfiguration={metaManualResult.data}
            legacyConnected={oauthConnected}
            canManage={canManageIntegrations}
            disconnectOAuthAction={disconnectMetaOAuthAction}
            prepareOAuthCredentialAction={
              prepareMetaOAuthAdvancedCredentialAction
            }
            createCredentialAction={createMetaManualCredentialAction}
            discoverAssetsAction={
              oauthConnected
                ? discoverMetaOAuthAdvancedAssetsAction
                : discoverMetaManualAssetsAction
            }
            createConnectionAction={
              oauthConnected
                ? createMetaOAuthAdvancedConnectionAction
                : createMetaManualConnectionAction
            }
            rotateCredentialAction={rotateMetaManualCredentialAction}
            setConnectionStatusAction={
              oauthConnected
                ? setMetaOAuthAdvancedConnectionStatusAction
                : setMetaManualConnectionStatusAction
            }
            testConnectionAction={
              oauthConnected
                ? testMetaOAuthAdvancedConnectionAction
                : testMetaManualConnectionAction
            }
            removeConnectionAction={
              oauthConnected
                ? removeMetaOAuthAdvancedConnectionAction
                : removeMetaManualConnectionAction
            }
            syncHistoryAction={syncMetaManualHistoryAction}
            setAccountDestinationAction={
              oauthConnected
                ? setMetaOAuthAdvancedAccountDestinationAction
                : setMetaManualAccountDestinationAction
            }
            loadAdRoutingAction={
              oauthConnected
                ? getMetaOAuthAdvancedAdRoutingAction
                : getMetaManualAdRoutingAction
            }
            setAdDestinationAction={
              oauthConnected
                ? setMetaOAuthAdvancedAdDestinationAction
                : setMetaManualAdDestinationAction
            }
            setOAuthRoutingAction={setMetaOAuthAdvancedRoutingAction}
            canConnectPalmup={
              canManageIntegrations && workspace?.role === "owner"
            }
            startPalmupConnectAction={startMetaPalmupConnectAction}
            completePalmupConnectAction={completeMetaPalmupConnectAction}
          />
          <div className="metric-grid compact integration-meta-metrics">
            <div className="metric-card">
              <span className="micro-label">Status</span>
              <strong>{metaStatusLabel}</strong>
            </div>
            <div className="metric-card">
              <span className="micro-label">Destino CAPI</span>
              <strong>
                {manualConfigured &&
                metaManualResult.data?.connectionMode === "manual"
                  ? `${metaManualResult.data?.destinations.length ?? 0} configurado(s)`
                  : oauthAdvancedEnabled
                    ? `${metaManualResult.data?.destinations.length ?? 0} por BM`
                    : metaAssets?.conversionDestination
                      ? statusLabel(metaAssets.conversionDestination.status)
                      : "Nao configurado"}
              </strong>
            </div>
            <div className="metric-card">
              <span className="micro-label">Contas em relatorios</span>
              <strong>
                {manualConfigured
                  ? manualActiveReportingAccounts
                  : activeReportingAccounts}
              </strong>
            </div>
          </div>
          {!manualConfigured ? (
            <>
              <p className="muted">
                {metaAssetsDetail(metaAssets, metaAssetsResult.state)}
              </p>
              <p className="muted">{metaLastSyncedAt(metaAssets)}</p>
            </>
          ) : null}
          {metaAssets &&
          (oauthConnected ||
            (!manualEnabled && metaCapabilitiesResult.state !== "error")) ? (
            <>
              <div className="meta-config-section">
                <div>
                  <span className="eyebrow">
                    {oauthAdvancedEnabled
                      ? "Rota de retorno"
                      : "Destino de conversao"}
                  </span>
                  <h2>
                    {oauthAdvancedEnabled
                      ? "Pixel e Pagina do destino principal"
                      : "Pixel e Pagina Facebook principal"}
                  </h2>
                </div>
                <div className="metric-grid compact">
                  <div className="metric-card">
                    <span className="micro-label">Pixel CAPI</span>
                    <strong>
                      <PresentationMask placeholder="Pixel oculto">
                        {metaAssets.conversionDestination?.pixelName ??
                          "Sem Pixel"}
                      </PresentationMask>
                    </strong>
                  </div>
                  <div className="metric-card">
                    <span className="micro-label">
                      Pagina Facebook principal
                    </span>
                    <strong>
                      <PresentationMask placeholder="Pagina oculta">
                        {metaAssets.conversionDestination?.pageName ??
                          "Sem Pagina"}
                      </PresentationMask>
                    </strong>
                  </div>
                  <div className="metric-card">
                    <span className="micro-label">Status destino</span>
                    <strong>
                      {metaAssets.conversionDestination
                        ? statusLabel(metaAssets.conversionDestination.status)
                        : "Nao configurado"}
                    </strong>
                  </div>
                </div>
                {canManageIntegrations && !oauthAdvancedEnabled ? (
                  <MetaConversionDestinationForm
                    assets={metaAssets}
                    action={saveMetaConversionDestination}
                    loadBusinessAssetsAction={loadMetaBusinessDestinationAssets}
                  />
                ) : !oauthAdvancedEnabled ? (
                  <p className="muted">
                    {workspacePermissionsUnavailable
                      ? "Nao foi possivel confirmar as permissoes agora."
                      : "Sem permissao para alterar destino Meta"}
                  </p>
                ) : (
                  <p className="muted">
                    O roteamento por BM esta ativo. Este destino volta a ser
                    usado somente ao escolher Usar destino principal.
                  </p>
                )}
              </div>

              {!oauthAdvancedEnabled ? (
                <div className="meta-config-section">
                  <div>
                    <span className="eyebrow">Contas para relatorios</span>
                    <h2>Contas Meta sincronizadas nos relatorios</h2>
                  </div>
                  {canManageIntegrations ? (
                    <MetaReportingAccountsForm
                      assets={metaAssets}
                      action={saveMetaReportingAccount}
                      loadBusinessAssetsAction={loadMetaBusinessReportingAssets}
                      statusAction={setMetaReportingAccountStatus}
                    />
                  ) : (
                    <p className="muted">
                      {workspacePermissionsUnavailable
                        ? "Nao foi possivel confirmar as permissoes agora."
                        : "Sem permissao para alterar contas de relatorio"}
                    </p>
                  )}
                </div>
              ) : null}
            </>
          ) : null}
          <p className="muted integration-domain-note">
            {oauthAdvancedEnabled
              ? "A conexao Meta fica protegida no backend. Cada conta ativa usa o Pixel e a Pagina vinculados a sua BM."
              : "A conexao Meta fica protegida no backend. Esta tela mostra apenas o destino principal e as contas ativas usadas nos relatorios."}
          </p>
    </div>
  );

  // WAHA, Z-API and NOD API are "Em breve": no new connections, but a workspace
  // that already has one keeps managing it (existing data is never hidden).
  const comingSoonPanels: Partial<Record<IntegrationProviderId, ReactNode>> =
    {};
  for (const provider of ["waha", "zapi", "nod_api"] as const) {
    if (
      whatsappConnectionsResult.data.some(
        (connection) => connection.provider === provider,
      )
    ) {
      comingSoonPanels[provider] = whatsappProviderPanel(provider, false);
    }
  }

  const panels: Partial<Record<IntegrationProviderId, ReactNode>> = {
    uazapi_byo: uazapiPanel,
    ...comingSoonPanels,
    meta_cloud: inboundPanel("meta_cloud"),
    umbler: automationUrlsPanel("umbler"),
    gupshup: inboundPanel("gupshup"),
    data_crazy: inboundPanel("data_crazy"),
    unnichat: automationUrlsPanel("unnichat"),
    payt: paytPanel,
    meta: metaPanel,
    kommo:
      workspace && kommoViewerId && canManageKommo ? (
        <div className="integration-modal-stack">
          <KommoCrmManager
            workspaceId={workspace.id}
            viewerId={kommoViewerId}
            connections={kommoSettings.connections}
            loadState={kommoSettings.state}
            allChannels={allInboundChannels}
            canManage={canManageKommo}
            licenseLocked={licenseLocked}
          />
        </div>
      ) : canManageKommo || !workspace ? (
        crmUnavailableNote("Kommo")
      ) : (
        crmOwnerOnlyNote
      ),
    pipedrive:
      workspace && kommoViewerId && canManageKommo ? (
        <div className="integration-modal-stack">
          <PipedriveCrmManager
            workspaceId={workspace.id}
            viewerId={kommoViewerId}
            connections={pipedriveSettings.connections}
            loadState={pipedriveSettings.state}
            allChannels={allInboundChannels}
            canManage={canManageKommo}
            licenseLocked={licenseLocked}
          />
        </div>
      ) : canManageKommo || !workspace ? (
        crmUnavailableNote("Pipedrive")
      ) : (
        crmOwnerOnlyNote
      ),
  };

  // Each panel is rendered inside a Modal next to other children; a keyed
  // Fragment per provider keeps React from warning about an unkeyed list.
  const keyedPanels: typeof panels = Object.fromEntries(
    Object.entries(panels).map(([provider, panel]) => [
      provider,
      <Fragment key={provider}>{panel}</Fragment>,
    ]),
  );

  const inboundErrorBanner =
    inboundWebhookResult.state === "error" ? (
      <div className="feedback-banner warn" role="status">
        <strong>Algumas conexões não carregaram</strong>
        <span>
          Parte das informações está indisponível agora. Atualize a página em
          instantes.
        </span>
      </div>
    ) : null;

  const whatsappIntro = (
    <>
      {inboundErrorBanner}
      {usesExternalWhatsapp ? (
        <div className="surface-panel whatsapp-instance-panel">
          <span className="eyebrow">Integracao externa MySQL</span>
          <h2>Dados recebidos por integracao externa do MySQL</h2>
          <p className="muted">
            Esta fonte e monitorada pelo conector externo; nao ha instancia ou
            cobranca para configurar neste painel.
          </p>
          <div className="metric-grid compact">
            <div className="metric-card">
              <span className="micro-label">Ultima sincronizacao</span>
              <strong>
                {sourceSyncLabel(pipeline?.whatsappSource?.lastSyncCompletedAt)}
              </strong>
            </div>
            <div className="metric-card">
              <span className="micro-label">Status</span>
              <strong>
                {statusLabel(
                  pipeline?.whatsappSource?.lastSyncStatus ?? "pending",
                )}
              </strong>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );

  // Formulários de regra oferecem "Padrão do workspace (X)" e as moedas padrão
  // dos CRMs. Lido por último para manter a ordem das requisições anteriores.
  const currencySettings = await getWorkspaceCurrencySettings();

  return (
    <WorkspaceCurrencyProvider currency={currencySettings?.conversionCurrency}>
    <section className="page-stack page-standard integrations-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Integracoes</span>
          <h1>Central de integracoes</h1>
          <p>
            {usesExternalWhatsapp
              ? "Acompanhe a origem das conversas, as contas Meta, o CRM e o caminho dos eventos desta conta."
              : "Conecte seus numeros de WhatsApp, plataformas de atendimento, CRM e a conta de anuncios. Clique em um card para conectar ou gerenciar."}
          </p>
        </div>
        {isPlatformOperator ? (
          <div className="header-actions">
            <span
              className={`status-chip${hasIntegrationError ? " warn" : ""}`}
            >
              {hasIntegrationError ? "API indisponivel" : "API conectada"}
            </span>
            <span className="status-chip">
              {integrations.length} provedores
            </span>
          </div>
        ) : null}
      </header>

      {workspacePermissionsUnavailable ? (
        <div className="feedback-banner warn" role="alert">
          <strong>Permissoes temporariamente indisponiveis</strong>
          <span>
            Nao foi possivel confirmar as permissoes agora. A API validara a
            acao ao continuar.
          </span>
          <a className="button" href="/integrations">
            Tentar novamente
          </a>
        </div>
      ) : null}

      {isPlatformOperator ? (
        <details className="integration-technical-health">
          <summary>
            <span>
              <Activity size={17} aria-hidden="true" />
              Saude tecnica dos provedores
            </span>
            <small>{integrations.length} provedores monitorados</small>
          </summary>
          <div className="integration-grid">
            {integrations.length > 0 ? (
              integrations.map((item) => (
                <article className="integration-card" key={item.title}>
                  <span
                    className={`status-chip${item.tone ? ` ${item.tone}` : ""}`}
                  >
                    {item.status}
                  </span>
                  <div>
                    <span className="micro-label">{item.title}</span>
                    <strong>{item.detail}</strong>
                  </div>
                  <p className="muted">{item.description}</p>
                  <button className="button" type="button">
                    Ver diagnostico
                  </button>
                </article>
              ))
            ) : (
              <article className="integration-card">
                <span className="status-chip warn">
                  {healthResult.state === "error"
                    ? "API indisponivel"
                    : "Sem provedores"}
                </span>
                <div>
                  <span className="micro-label">Integracoes</span>
                  <strong>
                    {healthResult.state === "error"
                      ? "Nao foi possivel carregar integracoes"
                      : "Nenhuma integracao retornada"}
                  </strong>
                </div>
                <p className="muted">
                  A lista sera preenchida somente com provedores retornados pelo
                  backend.
                </p>
              </article>
            )}
          </div>
        </details>
      ) : null}

      <IntegrationsHub
        cards={cards}
        panels={keyedPanels}
        quickLinks={{
          uazapi_byo: [rulesLink],
          nod_api: [rulesLink],
          waha: [rulesLink],
          zapi: [rulesLink],
          meta_cloud: [rulesLink],
          umbler: [rulesLink],
          gupshup: [rulesLink],
          data_crazy: [rulesLink],
          unnichat: [rulesLink],
          payt: [rulesLink],
        }}
        tabIntro={{
          whatsapp: whatsappIntro,
          attendance: inboundErrorBanner,
          crm: !workspace || canManageKommo ? undefined : crmOwnerOnlyNote,
        }}
        initialTab={initialHubState.tab}
        initialProvider={initialHubState.provider}
        notice={
          pageNotice ? (
            <div className={`feedback-banner ${pageNotice.tone}`} role="status">
              <strong>{pageNotice.title}</strong>
              <span>{pageNotice.message}</span>
            </div>
          ) : null
        }
        noticeProvider={initialHubState.provider}
      />

      <section
        className="integration-domain-section integration-flow-domain"
        id="integracao-fluxo"
        aria-labelledby="integration-flow-title"
      >
        <header className="integration-domain-heading">
          <div>
            <span className="eyebrow">Pipeline de sinal</span>
            <h2 id="integration-flow-title">
              Do clique no anuncio ao evento enviado
            </h2>
            <p>
              {pipeline
                ? `${pipeline.rangeLabel} com dados reais do workspace.`
                : "Nao foi possivel carregar o pipeline operacional agora."}
            </p>
          </div>
          <span className="status-chip">
            {pipeline?.stages.length
              ? `${pipeline.stages.length} etapas`
              : "Sem eventos"}
          </span>
        </header>
        <div className="integration-domain-content integration-flow-content">
          <p className="muted integration-flow-note">
            {pipeline
              ? `${pipeline.rangeLabel} com dados reais do workspace.`
              : "Nao foi possivel carregar o pipeline operacional agora."}
          </p>
          <div className="funnel-row" aria-label="Pipeline das integracoes">
            {pipeline?.stages.length ? (
              pipeline.stages.map((stage) => (
                <div className="funnel-step" key={stage.key}>
                  <span>{stage.label}</span>
                  <strong>{stage.value}</strong>
                  <p>{stage.detail}</p>
                  <div className="signal-bar">
                    <i
                      style={{
                        width: pipelineWidth(stage.value, maxPipelineValue),
                      }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <div className="funnel-step">
                <span>Pipeline</span>
                <strong>
                  {pipelineResult.state === "error"
                    ? "API indisponivel"
                    : "Aguardando eventos reais"}
                </strong>
                <div className="signal-bar">
                  <i style={{ width: "0%" }} />
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </section>
    </WorkspaceCurrencyProvider>
  );
}
