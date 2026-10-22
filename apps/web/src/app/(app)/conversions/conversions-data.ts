import type {
  CurrentWorkspaceDto,
  InboundWebhookChannelDto,
  InboundWebhookConnectionDto,
  LegacyConversionRuleDto,
  ProviderConversionRuleCapabilitiesDto,
  ProviderConversionRuleDto,
  ProviderConversionRuleUnifyCandidatesDto,
  WhatsappConnectionDto,
} from "@wpptrack/shared";
import {
  legacyConversionRuleListSchema,
  providerConversionRuleCapabilitiesSchema,
  providerConversionRuleUnifyCandidatesSchema,
  whatsappConnectionsSchema,
} from "@wpptrack/shared";
import { getCurrentWorkspace } from "../../../lib/current-workspace";
import { fetchLicenseStatus, licenseLockReason } from "../../../lib/license-status";
import { serverApiFetch } from "../../../lib/server-api";
import {
  listKommoConnectionsAction,
  type KommoConnectionDetailDto,
} from "../integrations/kommo-actions";
import {
  listPipedriveConnectionsAction,
  type PipedriveConnectionDetailDto,
} from "../integrations/pipedrive-actions";
import {
  toConversionNumbers,
  type ConversionConnection,
  type ConversionNumber,
} from "./conversion-rules-view";

/**
 * Leituras do servidor da tela Conversões. Cada leitura degrada sozinha: uma
 * falha no CRM, nos candidatos do Unificar ou nas regras antigas nunca esconde
 * as regras por provedor.
 */
export type ConversionsData = {
  workspace: CurrentWorkspaceDto | null;
  canManage: boolean;
  /** Licença bloqueada: a API recusa escritas (423); os controles ficam desabilitados. */
  licenseLocked: boolean;
  /** As regras por provedor não puderam ser lidas (API desligada ou falhando). */
  rulesState: "real" | "error" | "disabled";
  providerRules: ProviderConversionRuleDto[];
  /**
   * Regras antigas (palavra-chave ou etiqueta de antes das conexões):
   * continuam funcionando e são gerenciadas aqui.
   */
  legacyRules: LegacyConversionRuleDto[];
  legacyRulesState: "real" | "error";
  numbers: ConversionNumber[];
  connections: ConversionConnection[];
  /** Números de WAHA, Z-API e NOD API: ainda não participam das regras. */
  comingSoonNumbers: ComingSoonNumber[];
  /** Alguma conexão teve os números ilegíveis. */
  numbersPartial: boolean;
  /** null: a API de capacidades não respondeu (nada é oferecido em "Nova regra"). */
  capabilities: ProviderConversionRuleCapabilitiesDto | null;
  unifyGroups: ProviderConversionRuleUnifyCandidatesDto["groups"];
  kommo: KommoConnectionDetailDto[];
  pipedrive: PipedriveConnectionDetailDto[];
  /** As regras do CRM são só do responsável da conta: a lista avisa, não esconde calada. */
  crmVisible: boolean;
  crmError: boolean;
};

export type ComingSoonNumber = {
  id: string;
  provider: string;
  label: string;
  phone: string | null;
};

async function settle<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/** As rotas do Kommo e do Pipedrive só respondem ao responsável da conta (membros recebem 403). */
export function canViewWorkspaceCrm(
  workspace: CurrentWorkspaceDto | null,
): boolean {
  if (!workspace) return false;
  const isPlatformSupport = workspace.accessMode === "platform_support";
  const isPlatformOwnerSupport =
    isPlatformSupport && workspace.platformRole === "platform_owner";

  return (
    workspace.role === "owner" &&
    Boolean(workspace.permissions?.canManageIntegrations) &&
    (!isPlatformSupport || isPlatformOwnerSupport)
  );
}

export async function loadConversionsData(): Promise<ConversionsData> {
  const workspace = await settle(getCurrentWorkspace());
  const canManage = Boolean(workspace?.permissions?.canManageIntegrations);
  const crmVisible = canViewWorkspaceCrm(workspace);

  const [
    rulesResult,
    connections,
    capabilitiesRaw,
    legacyRaw,
    whatsappRaw,
    kommoResult,
    pipedriveResult,
    licenseStatus,
  ] = await Promise.all([
    serverApiFetch<ProviderConversionRuleDto[]>(
      "/conversion-rules/providers",
    ).then(
      (rules) => ({ state: "real" as const, rules }),
      (error: unknown) => ({
        state:
          (error as { status?: number } | null)?.status === 503
            ? ("disabled" as const)
            : ("error" as const),
        rules: [] as ProviderConversionRuleDto[],
      }),
    ),
    settle(
      serverApiFetch<InboundWebhookConnectionDto[]>(
        "/integrations/inbound-webhooks",
      ),
    ),
    settle(serverApiFetch<unknown>("/conversion-rules/providers/capabilities")),
    settle(serverApiFetch<unknown>("/conversion-rules/legacy")),
    settle(serverApiFetch<unknown>("/integrations/whatsapp-connections")),
    crmVisible && workspace
      ? settle(listKommoConnectionsAction(workspace.id))
      : Promise.resolve(null),
    crmVisible && workspace
      ? settle(listPipedriveConnectionsAction(workspace.id))
      : Promise.resolve(null),
    fetchLicenseStatus(),
  ]);

  const liveConnections = connections ?? [];
  let numbersPartial = connections === null;
  const withChannels = await Promise.all(
    liveConnections.map(async (connection) => {
      const channels = await settle(
        serverApiFetch<InboundWebhookChannelDto[]>(
          `/integrations/inbound-webhooks/${encodeURIComponent(connection.id)}/channels`,
        ),
      );
      if (channels === null) numbersPartial = true;
      return { connection, channels: channels ?? [] };
    }),
  );

  const parsedCapabilities =
    providerConversionRuleCapabilitiesSchema.safeParse(capabilitiesRaw);
  const capabilities = parsedCapabilities.success
    ? parsedCapabilities.data
    : null;

  // "Unificar" é só de quem gerencia integrações; a leitura nunca bloqueia a lista.
  const candidates =
    canManage && capabilities
      ? await settle(
          serverApiFetch<unknown>("/conversion-rules/providers/unify-candidates"),
        )
      : null;
  const parsedCandidates =
    providerConversionRuleUnifyCandidatesSchema.safeParse(candidates);

  const parsedLegacy = legacyConversionRuleListSchema.safeParse(legacyRaw);
  const unsupported = new Set(capabilities?.unsupportedWhatsappProviders ?? []);
  const parsedWhatsapp = whatsappConnectionsSchema.safeParse(whatsappRaw);
  const comingSoonNumbers: ComingSoonNumber[] = parsedWhatsapp.success
    ? parsedWhatsapp.data
        .filter(
          (connection: WhatsappConnectionDto) =>
            unsupported.has(connection.provider) &&
            connection.status !== "suspended",
        )
        .map((connection: WhatsappConnectionDto) => ({
          id: connection.id,
          provider: connection.provider,
          label: connection.displayName ?? connection.name,
          phone: connection.connectedPhone ?? null,
        }))
    : [];

  return {
    workspace,
    canManage,
    licenseLocked: Boolean(
      licenseStatus && licenseLockReason(licenseStatus) !== null,
    ),
    rulesState: rulesResult.state,
    providerRules: rulesResult.rules,
    legacyRules:
      rulesResult.state === "real" && parsedLegacy.success
        ? parsedLegacy.data
        : [],
    legacyRulesState:
      rulesResult.state === "real" && !parsedLegacy.success ? "error" : "real",
    numbers: toConversionNumbers(withChannels),
    connections: liveConnections.map((connection) => ({
      id: connection.id,
      provider: connection.provider,
      displayName: connection.displayName,
      status: connection.status,
    })),
    comingSoonNumbers,
    numbersPartial,
    capabilities,
    unifyGroups: parsedCandidates.success ? parsedCandidates.data.groups : [],
    kommo: kommoResult?.ok ? kommoResult.connections : [],
    pipedrive: pipedriveResult?.ok ? pipedriveResult.connections : [],
    crmVisible,
    crmError:
      crmVisible &&
      (kommoResult === null ||
        !kommoResult.ok ||
        pipedriveResult === null ||
        !pipedriveResult.ok),
  };
}
