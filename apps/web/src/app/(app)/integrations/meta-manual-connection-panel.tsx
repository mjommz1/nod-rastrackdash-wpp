"use client";

import type {
  MetaConnectionCapabilitiesDto,
  MetaManualAssetDiscoveryDto,
  MetaManualConfigurationDto,
  MetaReportingAccountAdRoutingDto,
} from "@wpptrack/shared";
import { META_OAUTH_DISCONNECT_CONFIRMATION } from "@wpptrack/shared";
import {
  Building2,
  Check,
  ChevronDown,
  CircleCheck,
  Database,
  ExternalLink,
  History,
  KeyRound,
  Link2,
  LogIn,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Unplug,
  X,
} from "lucide-react";
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import { SearchableSelect } from "../../../components/searchable-select";
import { PresentationMask } from "../../../components/presentation-mask";
import type {
  MetaManualActionResult,
  MetaPalmupPairing,
} from "./meta-manual-actions";

type SetupMode = "quick" | "advanced";
type DestinationMode = "discovered" | "direct" | "existing";
type AccountDestinationDraft = {
  allowedIds: string[];
  defaultId: string;
};
type AdRoutingFilter = "pending" | "resolved" | "all";
type ReportingAccountConfiguration =
  MetaManualConfigurationDto["reportingAccounts"][number];
type AdDestinationRoute = MetaReportingAccountAdRoutingDto["ads"][number];
type AdDestinationRouteGroup = {
  key: string;
  pageId: string | null;
  pixelId: string | null;
  ads: AdDestinationRoute[];
};

function persistedAccountDestinationIds(
  account: ReportingAccountConfiguration,
): string[] {
  const configuredIds = Array.isArray(account.conversionDestinationIds)
    ? account.conversionDestinationIds
    : [];

  return [
    ...new Set(
      configuredIds.length > 0
        ? configuredIds
        : account.conversionDestinationId
          ? [account.conversionDestinationId]
          : [],
    ),
  ];
}

function accountDestinationDraft(
  account: ReportingAccountConfiguration,
  businessDefaultId: string | null,
): AccountDestinationDraft {
  const persistedIds = persistedAccountDestinationIds(account);
  const allowedIds = [
    ...new Set(
      persistedIds.length > 0
        ? persistedIds
        : businessDefaultId
          ? [businessDefaultId]
          : [],
    ),
  ];
  const defaultId =
    account.conversionDestinationId &&
    allowedIds.includes(account.conversionDestinationId)
      ? account.conversionDestinationId
      : businessDefaultId && allowedIds.includes(businessDefaultId)
        ? businessDefaultId
        : (allowedIds[0] ?? "");

  return { allowedIds, defaultId };
}

function adDestinationDraftKey(accountId: string, adId: string): string {
  return `${accountId}:${adId}`;
}

function groupAdDestinationRoutes(
  ads: AdDestinationRoute[],
): AdDestinationRouteGroup[] {
  const groups = new Map<string, AdDestinationRouteGroup>();

  for (const ad of ads) {
    const key = ad.detectedPageId ?? "page-unidentified";
    const current = groups.get(key) ?? {
      key,
      pageId: ad.detectedPageId,
      pixelId: ad.detectedPixelId,
      ads: [],
    };

    current.ads.push(ad);
    current.pixelId ??= ad.detectedPixelId;
    groups.set(key, current);
  }

  return [...groups.values()].sort((left, right) => {
    const leftPending = left.ads.filter(
      (ad) => ad.routeStatus !== "assigned",
    ).length;
    const rightPending = right.ads.filter(
      (ad) => ad.routeStatus !== "assigned",
    ).length;

    return rightPending - leftPending || left.key.localeCompare(right.key);
  });
}

export function parseMetaAdAccountIds(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => (/^\d+$/.test(item) ? `act_${item}` : item))
        .map((item) => item.replace(/^act_/i, "act_"))
        .filter((item) => /^act_\d+$/i.test(item)),
    ),
  ];
}

type MetaManualConnectionPanelProps = {
  workspaceId: string;
  capabilities: MetaConnectionCapabilitiesDto;
  initialConfiguration: MetaManualConfigurationDto | null;
  legacyConnected: boolean;
  canManage: boolean;
  disconnectOAuthAction: (
    workspaceId: string,
    confirmation: string,
  ) => Promise<MetaManualActionResult>;
  prepareOAuthCredentialAction: () => Promise<MetaManualActionResult>;
  createCredentialAction: (
    formData: FormData,
  ) => Promise<MetaManualActionResult>;
  discoverAssetsAction: (
    credentialId: string,
    businessId?: string | null,
  ) => Promise<MetaManualActionResult>;
  createConnectionAction: (
    formData: FormData,
  ) => Promise<MetaManualActionResult>;
  rotateCredentialAction: (
    credentialId: string,
    formData: FormData,
  ) => Promise<MetaManualActionResult>;
  setConnectionStatusAction: (
    connectionId: string,
    status: "active" | "paused",
  ) => Promise<MetaManualActionResult>;
  testConnectionAction: (
    connectionId: string,
  ) => Promise<MetaManualActionResult>;
  removeConnectionAction: (
    connectionId: string,
    businessManagerId: string,
  ) => Promise<MetaManualActionResult>;
  syncHistoryAction: () => Promise<MetaManualActionResult>;
  setAccountDestinationAction: (
    reportingAccountId: string,
    conversionDestinationId: string | null,
    conversionDestinationIds: string[],
  ) => Promise<MetaManualActionResult>;
  loadAdRoutingAction: (
    reportingAccountId: string,
  ) => Promise<MetaManualActionResult>;
  setAdDestinationAction: (
    reportingAccountId: string,
    adId: string,
    conversionDestinationId: string | null,
  ) => Promise<MetaManualActionResult>;
  setOAuthRoutingAction: (enabled: boolean) => Promise<MetaManualActionResult>;
  // The API only accepts the PalmUP social login from workspace owners.
  canConnectPalmup?: boolean;
  startPalmupConnectAction?: () => Promise<MetaManualActionResult>;
  completePalmupConnectAction?: (
    pairingId: string,
  ) => Promise<MetaManualActionResult>;
};

type LegacyOAuthMigrationCardProps = {
  workspaceId: string;
  canManage: boolean;
  disconnectOAuthAction: MetaManualConnectionPanelProps["disconnectOAuthAction"];
};

function LegacyOAuthMigrationCard({
  workspaceId,
  canManage,
  disconnectOAuthAction,
}: LegacyOAuthMigrationCardProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = confirmation === META_OAUTH_DISCONNECT_CONFIRMATION;

  function closeDialog() {
    if (pending) {
      return;
    }

    dialogRef.current?.close();
    setConfirmation("");
    setError(null);
  }

  async function handleDisconnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!confirmed || pending) {
      return;
    }

    setPending(true);
    setError(null);
    const result = await disconnectOAuthAction(workspaceId, confirmation);

    if (result.ok) {
      dialogRef.current?.close();
      window.location.reload();
      return;
    }

    setError(result.message);
    setPending(false);
  }

  return (
    <>
      <div className="meta-manual-entry locked">
        <div className="meta-manual-entry-icon" aria-hidden="true">
          <ShieldCheck size={18} />
        </div>
        <div>
          <span className="micro-label">Conexao alternativa</span>
          <strong>Token permanente</strong>
          <p className="muted">
            O OAuth continua ativo ate uma desconexao confirmada neste
            workspace. O historico permanece preservado durante a troca.
          </p>
        </div>
        {canManage ? (
          <button
            className="button danger"
            type="button"
            onClick={() => dialogRef.current?.showModal()}
          >
            <Unplug size={16} aria-hidden="true" />
            Desconectar OAuth
          </button>
        ) : (
          <span className="event-chip">OAuth preservado</span>
        )}
      </div>

      <dialog
        className="meta-action-dialog meta-oauth-disconnect-dialog"
        ref={dialogRef}
        onCancel={(event) => {
          if (pending) {
            event.preventDefault();
            return;
          }

          closeDialog();
        }}
      >
        <div className="meta-action-dialog-header">
          <div>
            <span className="micro-label">Troca de conexao</span>
            <h3>Desconectar a Meta deste workspace?</h3>
          </div>
          <button
            className="meta-dialog-close"
            type="button"
            aria-label="Fechar confirmacao"
            title="Fechar"
            onClick={closeDialog}
            disabled={pending}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>

        <form className="meta-action-form" onSubmit={handleDisconnect}>
          <div className="meta-disconnect-warning">
            <TriangleAlert size={20} aria-hidden="true" />
            <div>
              <strong>Reporting e CAPI serao interrompidos</strong>
              <p>
                O envio volta somente depois que o token permanente, a BM, as
                contas e o destino forem validados.
              </p>
            </div>
          </div>

          <ul className="meta-disconnect-preserved">
            <li>Eventos, campanhas e auditorias ja registrados permanecem.</li>
            <li>Snapshots, contas e destinos salvos nao serao apagados.</li>
            <li>Outros workspaces e a autorizacao no Facebook nao mudam.</li>
          </ul>

          <label
            className="field-label"
            htmlFor="meta-oauth-disconnect-confirmation"
          >
            Digite <strong>{META_OAUTH_DISCONNECT_CONFIRMATION}</strong> para
            confirmar
          </label>
          <input
            id="meta-oauth-disconnect-confirmation"
            autoComplete="off"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={pending}
          />

          {error ? (
            <div className="feedback-banner error" role="alert">
              <span>{error}</span>
            </div>
          ) : null}

          <div className="meta-action-dialog-footer">
            <button
              className="button"
              type="button"
              onClick={closeDialog}
              disabled={pending}
            >
              Cancelar
            </button>
            <button
              className="button danger"
              type="submit"
              disabled={!confirmed || pending}
            >
              <Unplug size={16} aria-hidden="true" />
              {pending ? "Desconectando..." : "Desconectar e usar token"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

export function MetaManualConnectionPanel({
  workspaceId,
  capabilities,
  initialConfiguration,
  legacyConnected,
  canManage,
  disconnectOAuthAction,
  prepareOAuthCredentialAction,
  createCredentialAction,
  discoverAssetsAction,
  createConnectionAction,
  rotateCredentialAction,
  setConnectionStatusAction,
  testConnectionAction,
  removeConnectionAction,
  syncHistoryAction,
  setAccountDestinationAction,
  loadAdRoutingAction,
  setAdDestinationAction,
  setOAuthRoutingAction,
  canConnectPalmup = false,
  startPalmupConnectAction,
  completePalmupConnectAction,
}: MetaManualConnectionPanelProps) {
  const [configuration, setConfiguration] = useState(initialConfiguration);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupMode, setSetupMode] = useState<SetupMode>("quick");
  const [discovery, setDiscovery] =
    useState<MetaManualAssetDiscoveryDto | null>(null);
  const [credentialId, setCredentialId] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [businessLookupId, setBusinessLookupId] = useState("");
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [directAccountIds, setDirectAccountIds] = useState("");
  const [destinationMode, setDestinationMode] =
    useState<DestinationMode>("discovered");
  const [pixelId, setPixelId] = useState("");
  const [pageId, setPageId] = useState("");
  const [existingDestinationId, setExistingDestinationId] = useState("");
  const [directPixelId, setDirectPixelId] = useState("");
  const [directPageId, setDirectPageId] = useState("");
  const [ownerBusinessManagerId, setOwnerBusinessManagerId] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [palmupPairing, setPalmupPairing] =
    useState<MetaPalmupPairing | null>(null);
  const [palmupUnconfigured, setPalmupUnconfigured] = useState(false);
  const [rotatingCredentialId, setRotatingCredentialId] = useState<
    string | null
  >(null);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(
    null,
  );
  const [removingConnectionId, setRemovingConnectionId] = useState<
    string | null
  >(null);
  const [removalConfirmation, setRemovalConfirmation] = useState("");
  const [accountDestinationDrafts, setAccountDestinationDrafts] = useState<
    Record<string, AccountDestinationDraft>
  >({});
  const [adRoutingByAccount, setAdRoutingByAccount] = useState<
    Record<string, MetaReportingAccountAdRoutingDto>
  >({});
  const [adDestinationDrafts, setAdDestinationDrafts] = useState<
    Record<string, string>
  >({});
  const [adRoutingSearches, setAdRoutingSearches] = useState<
    Record<string, string>
  >({});
  const [adRoutingFilters, setAdRoutingFilters] = useState<
    Record<string, AdRoutingFilter>
  >({});
  const [expandedAdRoutingAccountId, setExpandedAdRoutingAccountId] = useState<
    string | null
  >(null);
  const credentialFormRef = useRef<HTMLFormElement>(null);
  const rotateFormRef = useRef<HTMLFormElement>(null);
  const removeDialogRef = useRef<HTMLDialogElement>(null);

  const selectedBusiness = discovery?.businesses.find(
    (business) => business.id === businessId,
  );
  const selectedCredential = configuration?.credentials.find(
    (credential) => credential.id === credentialId,
  );
  const selectedPixel = discovery?.pixels.find((pixel) => pixel.id === pixelId);
  const selectedPage = discovery?.pages.find((page) => page.id === pageId);
  const selectedExistingDestination = configuration?.destinations.find(
    (destination) => destination.id === existingDestinationId,
  );
  const discoveredAccountIds = new Set(
    discovery?.adAccounts.map((account) => account.id) ?? [],
  );
  const selectedDirectAccountIds = selectedAccountIds.filter(
    (accountId) => !discoveredAccountIds.has(accountId),
  );
  const showBusinessLookup = Boolean(
    credentialId &&
    ((discovery?.businesses.length ?? 0) === 0 || setupMode === "advanced"),
  );
  const showAccountLookup = Boolean(
    businessId &&
    ((discovery?.adAccounts.length ?? 0) === 0 || setupMode === "advanced"),
  );
  const destinationReady =
    destinationMode === "existing"
      ? Boolean(existingDestinationId)
      : destinationMode === "direct"
        ? Boolean(directPixelId.trim() && directPageId.trim())
        : Boolean(pixelId && pageId);
  const readyToActivate = Boolean(
    credentialId &&
    businessId &&
    selectedAccountIds.length > 0 &&
    destinationReady,
  );
  const removingConnection = configuration?.businessConnections.find(
    (connection) => connection.id === removingConnectionId,
  );
  const oauthMode = legacyConnected;
  const configuredBusinessCount =
    configuration?.businessConnections.length ?? 0;
  const configuredAccountCount =
    configuration?.reportingAccounts.filter((account) => account.active)
      .length ?? 0;
  const configuredDestinationCount = configuration?.destinations.length ?? 0;
  const palmupVisible = Boolean(
    canConnectPalmup &&
    canManage &&
    !oauthMode &&
    startPalmupConnectAction &&
    completePalmupConnectAction,
  );
  const palmupReady = palmupVisible && !palmupUnconfigured;

  if (!capabilities.manualEnabled && !oauthMode) {
    return null;
  }

  async function handleCredentialSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPendingAction("credential");
    setNotice(null);
    const result = await createCredentialAction(
      new FormData(event.currentTarget),
    );

    if (result.ok && result.discovery) {
      applyDiscovery(result.discovery);
      setBusinessLookupId("");
      setDirectAccountIds("");
      credentialFormRef.current?.reset();
      await refreshConfigurationFromServerState(result);
    }

    showResult(result);
    setPendingAction(null);
  }

  async function handleOAuthCredentialPreparation() {
    setPendingAction("credential");
    setNotice(null);
    const result = await prepareOAuthCredentialAction();

    if (result.ok && result.discovery) {
      applyDiscovery(result.discovery);
      setSetupMode("advanced");
      await refreshConfigurationFromServerState(result);
    }

    showResult(result);
    setPendingAction(null);
  }

  async function handlePalmupStart() {
    if (!startPalmupConnectAction) {
      return;
    }

    setPendingAction("palmup");
    setNotice(null);
    const result = await startPalmupConnectAction();
    setPalmupPairing(result.ok ? (result.palmupPairing ?? null) : null);
    setPalmupUnconfigured(Boolean(result.palmupUnconfigured));
    showResult(result);
    setPendingAction(null);
  }

  async function handlePalmupComplete() {
    if (!completePalmupConnectAction || !palmupPairing) {
      return;
    }

    setPendingAction("palmup");
    setNotice(null);
    const result = await completePalmupConnectAction(palmupPairing.pairingId);
    // The API consumes the pairing on every attempt; a retry needs a new start.
    setPalmupPairing(null);

    if (result.ok && result.discovery) {
      applyDiscovery(result.discovery);
      setBusinessLookupId("");
      setDirectAccountIds("");
      await refreshConfigurationFromServerState(result);
    }

    showResult(result);
    setPendingAction(null);
  }

  function startPalmupConnection() {
    startNewConnection();
    void handlePalmupStart();
  }

  async function handleCredentialSelection(nextCredentialId: string) {
    setCredentialId(nextCredentialId);
    setBusinessId("");
    setBusinessLookupId("");
    setSelectedAccountIds([]);
    setDirectAccountIds("");
    setDiscovery(null);

    if (!nextCredentialId) {
      return;
    }

    setPendingAction("assets");
    const result = await discoverAssetsAction(nextCredentialId, null);

    if (result.ok && result.discovery) {
      applyDiscovery(result.discovery);
    }

    showResult(result);
    setPendingAction(null);
  }

  async function handleBusinessSelection(nextBusinessId: string) {
    setBusinessId(nextBusinessId);
    setSelectedAccountIds([]);
    setDirectAccountIds("");
    setPixelId("");
    setPageId("");

    if (!credentialId || !nextBusinessId) {
      return;
    }

    setPendingAction("assets");
    const result = await discoverAssetsAction(credentialId, nextBusinessId);

    if (result.ok && result.discovery) {
      applyDiscovery(result.discovery, nextBusinessId);
    }

    showResult(result);
    setPendingAction(null);
  }

  async function handleBusinessLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextBusinessId = businessLookupId.trim();

    if (!credentialId || !nextBusinessId) {
      setNotice({
        tone: "error",
        message: "Informe o ID da BM que pertence a este token.",
      });
      return;
    }

    setPendingAction("assets");
    setNotice(null);
    const result = await discoverAssetsAction(credentialId, nextBusinessId);

    if (result.ok && result.discovery) {
      applyDiscovery(result.discovery, nextBusinessId);
      setBusinessLookupId("");
    }

    showResult(result);
    setPendingAction(null);
  }

  function handleDirectAccounts(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accountIds = parseMetaAdAccountIds(directAccountIds);

    if (accountIds.length === 0) {
      setNotice({
        tone: "error",
        message: "Informe ao menos uma conta no formato act_123 ou 123.",
      });
      return;
    }

    setSelectedAccountIds((current) => [
      ...new Set([...current, ...accountIds]),
    ]);
    setDirectAccountIds("");
    setNotice({
      tone: "success",
      message:
        "IDs adicionados. O acesso a cada conta sera validado antes da ativacao.",
    });
  }

  async function handleConnectionSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!readyToActivate || !selectedBusiness) {
      setNotice({
        tone: "error",
        message: "Revise BM, contas e destino antes de ativar.",
      });
      return;
    }

    const formData = new FormData();
    formData.set("credentialId", credentialId);
    formData.set("businessManagerId", businessId);
    formData.set("businessManagerName", selectedBusiness.name);
    formData.set(
      "accountSelectionMode",
      editingConnectionId ? "replace" : "merge",
    );
    selectedAccountIds.forEach((id) => formData.append("adAccountIds", id));
    formData.set(
      "destinationMode",
      destinationMode === "existing" ? "existing" : "new",
    );

    if (destinationMode === "existing") {
      formData.set("existingDestinationId", existingDestinationId);
    } else {
      formData.set(
        "pixelId",
        destinationMode === "direct" ? directPixelId.trim() : pixelId,
      );
      formData.set(
        "pageId",
        destinationMode === "direct" ? directPageId.trim() : pageId,
      );
      formData.set(
        "destinationLabel",
        destinationMode === "direct"
          ? "Destino informado por ID"
          : `${selectedPixel?.name ?? "Pixel"} / ${selectedPage?.name ?? "Pagina"}`,
      );

      if (ownerBusinessManagerId.trim()) {
        formData.set("ownerBusinessManagerId", ownerBusinessManagerId.trim());
      }
    }

    setPendingAction("activate");
    setNotice(null);
    const result = await createConnectionAction(formData);

    if (result.ok && result.configuration) {
      setConfiguration(result.configuration);
      resetSetup();
    }

    showResult(result);
    setPendingAction(null);
  }

  async function handleConnectionTest(connectionId: string) {
    setPendingAction(`test:${connectionId}`);
    const result = await testConnectionAction(connectionId);
    showResult(result);
    setPendingAction(null);
  }

  async function handleHistorySync() {
    setPendingAction("history");
    setNotice(null);
    const result = await syncHistoryAction();
    showResult(result);
    setPendingAction(null);
  }

  async function handleOAuthRouting(enabled: boolean) {
    const confirmation = enabled
      ? "Ativar o roteamento por BM? Relatorios e novos eventos passarao a usar os vinculos revisados."
      : "Voltar ao destino principal? Os vinculos ficarao salvos para uma nova ativacao.";

    if (!window.confirm(confirmation)) {
      return;
    }

    setPendingAction("routing");
    setNotice(null);
    const result = await setOAuthRoutingAction(enabled);

    if (result.ok && result.configuration) {
      setConfiguration(result.configuration);
    }

    showResult(result);
    setPendingAction(null);
  }

  async function handleEditConnection(connectionId: string) {
    const connection = configuration?.businessConnections.find(
      (item) => item.id === connectionId,
    );

    if (!connection) {
      return;
    }

    const connectionAccounts =
      configuration?.reportingAccounts.filter(
        (account) =>
          account.businessConnectionId === connection.id && account.active,
      ) ?? [];

    setSetupOpen(true);
    setSetupMode("advanced");
    setPendingAction(`edit:${connectionId}`);
    setNotice(null);
    const result = await discoverAssetsAction(
      connection.credentialId,
      connection.businessManagerId,
    );

    if (result.ok && result.discovery) {
      setDiscovery(result.discovery);
      setCredentialId(connection.credentialId);
      setBusinessId(connection.businessManagerId);
      setBusinessLookupId("");
      setSelectedAccountIds(
        connectionAccounts.map((account) => account.adAccountId),
      );
      setDirectAccountIds("");
      setDestinationMode("existing");
      setExistingDestinationId(connection.defaultConversionDestinationId ?? "");
      setEditingConnectionId(connection.id);
      setNotice({
        tone: "success",
        message: "Estrutura carregada. Revise e salve as alteracoes.",
      });
    } else {
      showResult(result);
    }

    setPendingAction(null);
  }

  async function handleRemoveConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const connection = configuration?.businessConnections.find(
      (item) => item.id === removingConnectionId,
    );

    if (
      !connection ||
      removalConfirmation.trim() !== connection.businessManagerId
    ) {
      return;
    }

    setPendingAction(`remove:${connection.id}`);
    const result = await removeConnectionAction(
      connection.id,
      removalConfirmation.trim(),
    );

    if (result.ok && result.configuration) {
      setConfiguration(result.configuration);
      removeDialogRef.current?.close();
      setRemovingConnectionId(null);
      setRemovalConfirmation("");

      if (editingConnectionId === connection.id) {
        resetSetup();
      }
    }

    showResult(result);
    setPendingAction(null);
  }

  function openRemovalDialog(connectionId: string) {
    setRemovingConnectionId(connectionId);
    setRemovalConfirmation("");
    removeDialogRef.current?.showModal();
  }

  function closeRemovalDialog() {
    if (pendingAction?.startsWith("remove:")) {
      return;
    }

    removeDialogRef.current?.close();
    setRemovingConnectionId(null);
    setRemovalConfirmation("");
  }

  async function handleConnectionStatus(
    connectionId: string,
    status: "active" | "paused",
  ) {
    const confirmation =
      status === "paused"
        ? "Pausar esta BM? Somente as contas desta conexao deixarao de sincronizar e enviar eventos."
        : "Reativar esta BM com o token e o destino atuais?";

    if (!window.confirm(confirmation)) {
      return;
    }

    setPendingAction(`status:${connectionId}`);
    const result = await setConnectionStatusAction(connectionId, status);

    if (result.ok && result.configuration) {
      setConfiguration(result.configuration);
    }

    showResult(result);
    setPendingAction(null);
  }

  async function handleRotateCredential(
    event: FormEvent<HTMLFormElement>,
    targetCredentialId: string,
  ) {
    event.preventDefault();

    if (
      !window.confirm(
        "Substituir o token desta credencial? A troca so sera aplicada se toda a estrutura continuar acessivel.",
      )
    ) {
      return;
    }

    setPendingAction(`rotate:${targetCredentialId}`);
    const result = await rotateCredentialAction(
      targetCredentialId,
      new FormData(event.currentTarget),
    );

    if (result.ok && result.configuration) {
      setConfiguration(result.configuration);
      setRotatingCredentialId(null);
      rotateFormRef.current?.reset();
    }

    showResult(result);
    setPendingAction(null);
  }

  async function handleAccountDestination(
    account: ReportingAccountConfiguration,
    businessDefaultId: string | null,
  ) {
    const accountId = account.id;
    const draft =
      accountDestinationDrafts[accountId] ??
      accountDestinationDraft(account, businessDefaultId);
    setPendingAction(`destination:${accountId}`);
    const result = await setAccountDestinationAction(
      accountId,
      draft.defaultId || null,
      draft.allowedIds,
    );

    if (result.ok && result.configuration) {
      setConfiguration(result.configuration);
      setAdRoutingByAccount((current) => {
        const next = { ...current };
        delete next[accountId];
        return next;
      });
      setExpandedAdRoutingAccountId((current) =>
        current === accountId ? null : current,
      );
    }

    showResult(result);
    setPendingAction(null);
  }

  async function handleAdRouting(accountId: string) {
    if (expandedAdRoutingAccountId === accountId) {
      setExpandedAdRoutingAccountId(null);
      return;
    }

    setExpandedAdRoutingAccountId(accountId);

    if (adRoutingByAccount[accountId]) {
      return;
    }

    setPendingAction(`ad-routing:${accountId}`);
    const result = await loadAdRoutingAction(accountId);

    if (result.ok && result.adRouting) {
      setAdRoutingByAccount((current) => ({
        ...current,
        [accountId]: result.adRouting!,
      }));
      setAdDestinationDrafts((current) => ({
        ...current,
        ...Object.fromEntries(
          result.adRouting!.ads.map((ad) => [
            adDestinationDraftKey(accountId, ad.adId),
            ad.assignmentSource === "manual"
              ? (ad.conversionDestinationId ?? "")
              : "",
          ]),
        ),
      }));
    } else {
      setExpandedAdRoutingAccountId(null);
      showResult(result);
    }

    setPendingAction(null);
  }

  async function handleAdDestination(accountId: string, adId: string) {
    const key = adDestinationDraftKey(accountId, adId);
    const destinationId = adDestinationDrafts[key] ?? "";
    setPendingAction(`ad-destination:${key}`);
    const result = await setAdDestinationAction(
      accountId,
      adId,
      destinationId || null,
    );

    if (result.ok && result.adRouting) {
      setAdRoutingByAccount((current) => ({
        ...current,
        [accountId]: result.adRouting!,
      }));
      setAdDestinationDrafts((current) => ({
        ...current,
        ...Object.fromEntries(
          result.adRouting!.ads.map((ad) => [
            adDestinationDraftKey(accountId, ad.adId),
            ad.assignmentSource === "manual"
              ? (ad.conversionDestinationId ?? "")
              : "",
          ]),
        ),
      }));
    }

    showResult(result);
    setPendingAction(null);
  }

  function applyDiscovery(
    nextDiscovery: MetaManualAssetDiscoveryDto,
    forcedBusinessId?: string,
  ) {
    const nextBusinessId =
      forcedBusinessId ?? nextDiscovery.selectedBusinessId ?? "";
    setDiscovery(nextDiscovery);
    setCredentialId(nextDiscovery.credential.id);
    setBusinessId(nextBusinessId);
    setSelectedAccountIds([]);
    setDirectAccountIds("");
    setPixelId(nextDiscovery.pixels[0]?.id ?? "");
    setPageId(nextDiscovery.pages[0]?.id ?? "");
    setDestinationMode(
      nextDiscovery.pixels.length > 0 && nextDiscovery.pages.length > 0
        ? "discovered"
        : "direct",
    );
  }

  function showResult(result: MetaManualActionResult) {
    setNotice({
      tone: result.ok ? "success" : "error",
      message: result.message,
    });
  }

  async function refreshConfigurationFromServerState(
    result: MetaManualActionResult,
  ) {
    if (result.configuration) {
      setConfiguration(result.configuration);
      return;
    }

    if (result.discovery) {
      const credential = result.discovery.credential;
      setConfiguration((current) => ({
        workspaceId: credential.workspaceId,
        connectionMode:
          current?.connectionMode ?? (legacyConnected ? "oauth" : "manual"),
        advancedRoutingEnabled: current?.advancedRoutingEnabled ?? false,
        unmappedActiveAccountCount: current?.unmappedActiveAccountCount ?? 0,
        credentials: [
          ...(current?.credentials.filter(
            (item) => item.id !== credential.id,
          ) ?? []),
          credential,
        ],
        businessConnections: current?.businessConnections ?? [],
        destinations: current?.destinations ?? [],
        reportingAccounts: current?.reportingAccounts ?? [],
      }));
    }
  }

  function resetSetup() {
    setSetupOpen(false);
    setDiscovery(null);
    setCredentialId("");
    setBusinessId("");
    setBusinessLookupId("");
    setSelectedAccountIds([]);
    setDirectAccountIds("");
    setDestinationMode("discovered");
    setPixelId("");
    setPageId("");
    setExistingDestinationId("");
    setDirectPixelId("");
    setDirectPageId("");
    setOwnerBusinessManagerId("");
    setEditingConnectionId(null);
  }

  function startNewConnection() {
    resetSetup();
    setPalmupPairing(null);
    setSetupOpen(true);
    setSetupMode("quick");
    setNotice(null);
  }

  function renderPalmupConnect() {
    if (!palmupVisible) {
      return null;
    }

    if (!palmupReady) {
      return (
        <div className="meta-palmup-connect">
          <button className="button" type="button" disabled>
            <LogIn size={16} aria-hidden="true" />
            Conectar Meta (PalmUP)
          </button>
          <p className="action-note">
            Login social PalmUP nao configurado neste servidor. Defina
            PALMUP_META_BROKER_URL na API ou use o token permanente abaixo.
          </p>
        </div>
      );
    }

    if (palmupPairing) {
      return (
        <div className="meta-palmup-connect">
          <div className="meta-palmup-connect-actions">
            <a
              className="button"
              href={palmupPairing.authorizeUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={16} aria-hidden="true" />
              Abrir login da Meta
            </a>
            <button
              className="button secondary"
              type="button"
              disabled={pendingAction !== null}
              onClick={() => void handlePalmupComplete()}
            >
              <ShieldCheck size={16} aria-hidden="true" />
              {pendingAction === "palmup"
                ? "Concluindo..."
                : "Ja autorizei, concluir"}
            </button>
            <button
              className="button ghost"
              type="button"
              disabled={pendingAction !== null}
              onClick={() => setPalmupPairing(null)}
            >
              Cancelar
            </button>
          </div>
          <p className="action-note">
            Autorize na aba da PalmUP e volte aqui. O pedido expira em cerca de
            10 minutos e o token fica protegido na API, sem aparecer nesta tela.
          </p>
        </div>
      );
    }

    return (
      <div className="meta-palmup-connect">
        <button
          className="button"
          type="button"
          disabled={pendingAction !== null}
          onClick={() => void handlePalmupStart()}
        >
          <LogIn size={16} aria-hidden="true" />
          {pendingAction === "palmup"
            ? "Preparando..."
            : "Conectar Meta (PalmUP)"}
        </button>
        <p className="action-note">
          Entre com o Facebook pelo app da PalmUP, sem criar um app Meta
          proprio. Prefere token permanente? Cole abaixo.
        </p>
      </div>
    );
  }

  function renderConfiguredConnections(showNewConnection: boolean) {
    if ((configuration?.businessConnections.length ?? 0) === 0) {
      return null;
    }

    return (
      <div className="meta-advanced-list">
        <div className="meta-advanced-list-heading">
          <div>
            <span className="eyebrow">Estruturas configuradas</span>
            <h3>
              {oauthMode ? "BMs e destinos OAuth" : "Tokens, BMs e destinos"}
            </h3>
          </div>
          {showNewConnection && canManage ? (
            <div className="meta-advanced-list-actions">
              {!oauthMode || configuration?.advancedRoutingEnabled ? (
                <button
                  className="button secondary"
                  type="button"
                  disabled={pendingAction !== null}
                  onClick={() => void handleHistorySync()}
                >
                  <History size={16} />
                  {pendingAction === "history"
                    ? "Enfileirando..."
                    : "Importar historico inicial"}
                </button>
              ) : null}
              {palmupReady ? (
                <button
                  className="button secondary"
                  type="button"
                  disabled={pendingAction !== null}
                  onClick={startPalmupConnection}
                >
                  <LogIn size={16} /> Conectar Meta (PalmUP)
                </button>
              ) : null}
              <button
                className="button secondary"
                type="button"
                onClick={startNewConnection}
              >
                <Plus size={16} /> Nova conexao
              </button>
            </div>
          ) : null}
        </div>
        {configuration?.businessConnections.map((connection) => {
          const credential = configuration.credentials.find(
            (item) => item.id === connection.credentialId,
          );
          const destination = configuration.destinations.find(
            (item) => item.id === connection.defaultConversionDestinationId,
          );
          const connectionAccounts = configuration.reportingAccounts.filter(
            (account) => account.businessConnectionId === connection.id,
          );
          const activeConnectionAccounts = connectionAccounts.filter(
            (account) => account.active,
          );
          const connectionDestinationIds = new Set(
            [
              connection.defaultConversionDestinationId,
              ...activeConnectionAccounts.flatMap((account) =>
                persistedAccountDestinationIds(account),
              ),
            ].filter((id): id is string => Boolean(id)),
          );
          const connectionDestinations = configuration.destinations.filter(
            (item) =>
              (item.id ? connectionDestinationIds.has(item.id) : false) ||
              item.ownerBusinessManagerId === connection.businessManagerId,
          );

          return (
            <article className="meta-connection-row" key={connection.id}>
              <div className="meta-connection-row-head">
                <div>
                  <span
                    className={`event-chip${connection.status === "active" ? "" : " warn"}`}
                  >
                    {statusLabel(connection.status)}
                  </span>
                  <strong>
                    <PresentationMask placeholder="Business Manager oculto">
                      {connection.businessManagerName}
                    </PresentationMask>
                  </strong>
                  <span>
                    <PresentationMask placeholder="ID oculto">
                      {connection.businessManagerId}
                    </PresentationMask>
                  </span>
                </div>
                {canManage ? (
                  <div className="meta-connection-row-actions">
                    <button
                      className="icon-button"
                      type="button"
                      title="Editar estrutura"
                      aria-label={`Editar ${connection.businessManagerName}`}
                      disabled={pendingAction !== null}
                      onClick={() => void handleEditConnection(connection.id)}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      title="Testar conexao"
                      aria-label={`Testar ${connection.businessManagerName}`}
                      disabled={pendingAction !== null}
                      onClick={() => void handleConnectionTest(connection.id)}
                    >
                      <RefreshCw size={16} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      title={
                        connection.status === "paused"
                          ? "Reativar conexao"
                          : "Pausar conexao"
                      }
                      aria-label={
                        connection.status === "paused"
                          ? `Reativar ${connection.businessManagerName}`
                          : `Pausar ${connection.businessManagerName}`
                      }
                      disabled={pendingAction !== null}
                      onClick={() =>
                        void handleConnectionStatus(
                          connection.id,
                          connection.status === "paused" ? "active" : "paused",
                        )
                      }
                    >
                      {connection.status === "paused" ? (
                        <Play size={16} />
                      ) : (
                        <Pause size={16} />
                      )}
                    </button>
                    {!oauthMode ? (
                      <button
                        className="icon-button"
                        type="button"
                        title="Trocar token"
                        aria-label={`Trocar token de ${connection.businessManagerName}`}
                        disabled={!credential || pendingAction !== null}
                        onClick={() =>
                          setRotatingCredentialId(credential?.id ?? null)
                        }
                      >
                        <KeyRound size={16} />
                      </button>
                    ) : null}
                    <button
                      className="icon-button danger"
                      type="button"
                      title="Remover estrutura"
                      aria-label={`Remover ${connection.businessManagerName}`}
                      disabled={pendingAction !== null}
                      onClick={() => openRemovalDialog(connection.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="meta-connection-facts">
                <span>
                  <small>Credencial</small>
                  <strong>
                    <PresentationMask placeholder="Credencial oculta">
                      {credential?.label ?? "Indisponivel"}
                    </PresentationMask>
                  </strong>
                </span>
                <span>
                  <small>Token</small>
                  <strong>
                    <PresentationMask placeholder="Token protegido">
                      {credential
                        ? `final ${credential.tokenLast4}`
                        : "Indisponivel"}
                    </PresentationMask>
                  </strong>
                </span>
                <span>
                  <small>Destino padrao</small>
                  <strong>
                    <PresentationMask placeholder="Destino oculto">
                      {destination?.label ??
                        destination?.pixelName ??
                        "Nao configurado"}
                    </PresentationMask>
                  </strong>
                </span>
                <span>
                  <small>Contas</small>
                  <strong>
                    {connection.activeReportingAccountCount}/
                    {connection.reportingAccountCount} ativas
                  </strong>
                </span>
              </div>

              {!oauthMode && rotatingCredentialId === credential?.id ? (
                <form
                  ref={rotateFormRef}
                  className="meta-rotate-form"
                  onSubmit={(event) =>
                    void handleRotateCredential(event, credential.id)
                  }
                >
                  <input
                    name="accessToken"
                    type="password"
                    minLength={20}
                    autoComplete="off"
                    placeholder="Novo token permanente"
                    required
                  />
                  <button
                    className="button secondary"
                    type="submit"
                    disabled={pendingAction !== null}
                  >
                    {pendingAction === `rotate:${credential.id}`
                      ? "Validando..."
                      : "Validar troca"}
                  </button>
                  <button
                    className="button ghost"
                    type="button"
                    onClick={() => setRotatingCredentialId(null)}
                  >
                    Cancelar
                  </button>
                </form>
              ) : null}

              {activeConnectionAccounts.length > 0 ? (
                <section className="meta-account-routing">
                  <div className="meta-account-routing-heading">
                    <span>
                      <small>Contas e destinos</small>
                      <strong>
                        {activeConnectionAccounts.length} vinculo(s) ativo(s)
                      </strong>
                    </span>
                    <span className="event-chip">
                      {connectionDestinations.length} destino(s) salvo(s)
                    </span>
                  </div>
                  <div className="meta-account-routing-list">
                    {activeConnectionAccounts.map((account) => {
                      const persistedDraft = accountDestinationDraft(
                        account,
                        connection.defaultConversionDestinationId,
                      );
                      const draft =
                        accountDestinationDrafts[account.id] ?? persistedDraft;
                      const allowedDestinations =
                        configuration.destinations.filter(
                          (item) =>
                            Boolean(item.id) &&
                            draft.allowedIds.includes(item.id ?? ""),
                        );
                      const savedDestinationIds =
                        persistedAccountDestinationIds(account);
                      const persistedDestinationIds =
                        savedDestinationIds.length > 0
                          ? savedDestinationIds
                          : persistedDraft.allowedIds;
                      const persistedDestinations =
                        configuration.destinations.filter(
                          (item) =>
                            Boolean(item.id) &&
                            persistedDestinationIds.includes(item.id ?? ""),
                        );
                      const adRouting = adRoutingByAccount[account.id];
                      const search = (adRoutingSearches[account.id] ?? "")
                        .trim()
                        .toLocaleLowerCase("pt-BR");
                      const routingFilter =
                        adRoutingFilters[account.id] ?? "pending";
                      const visibleAds =
                        adRouting?.ads.filter((ad) => {
                          const matchesFilter =
                            routingFilter === "all" ||
                            (routingFilter === "resolved"
                              ? ad.routeStatus === "assigned"
                              : ad.routeStatus !== "assigned");
                          const matchesSearch =
                            !search ||
                            ad.adName
                              .toLocaleLowerCase("pt-BR")
                              .includes(search) ||
                            ad.adId.toLocaleLowerCase("pt-BR").includes(search);

                          return matchesFilter && matchesSearch;
                        }) ?? [];
                      const adRouteGroups =
                        groupAdDestinationRoutes(visibleAds);
                      const resolvedAdCount =
                        adRouting?.ads.filter(
                          (ad) => ad.routeStatus === "assigned",
                        ).length ?? 0;
                      const pendingAdCount =
                        (adRouting?.ads.length ?? 0) - resolvedAdCount;

                      return (
                        <div
                          className={
                            account.syncStatus === "error" ? "error" : ""
                          }
                          key={account.id}
                        >
                          <span className="meta-account-routing-account">
                            <small>Conta de anuncios</small>
                            <strong>
                              <PresentationMask placeholder="Conta de anuncios oculta">
                                {account.adAccountName}
                              </PresentationMask>
                            </strong>
                            <small>
                              <PresentationMask placeholder="ID oculto">
                                {account.adAccountId}
                              </PresentationMask>
                            </small>
                          </span>
                          <span className="meta-account-routing-asset">
                            <small>Pixels / Datasets</small>
                            <strong>
                              <PresentationMask placeholder="Pixel oculto">
                                {persistedDestinations.length > 1
                                  ? `${new Set(persistedDestinations.map((item) => item.pixelId)).size} vinculados`
                                  : (persistedDestinations[0]?.pixelName ??
                                    "Nao configurado")}
                              </PresentationMask>
                            </strong>
                            <small>
                              {persistedDestinations.length > 1 ? (
                                `${persistedDestinations.length} destinos permitidos`
                              ) : (
                                <PresentationMask placeholder="ID oculto">
                                  {persistedDestinations[0]?.pixelId ?? "-"}
                                </PresentationMask>
                              )}
                            </small>
                          </span>
                          <span className="meta-account-routing-asset">
                            <small>Paginas</small>
                            <strong>
                              <PresentationMask placeholder="Pagina oculta">
                                {persistedDestinations.length > 1
                                  ? `${new Set(persistedDestinations.map((item) => item.pageId)).size} vinculadas`
                                  : (persistedDestinations[0]?.pageName ??
                                    "Nao configurada")}
                              </PresentationMask>
                            </strong>
                            <small>
                              {persistedDestinations.length > 1 ? (
                                "Roteamento definido por anuncio"
                              ) : (
                                <PresentationMask placeholder="ID oculto">
                                  {persistedDestinations[0]?.pageId ?? "-"}
                                </PresentationMask>
                              )}
                            </small>
                          </span>
                          <span className="meta-account-routing-health">
                            <small>Sincronizacao</small>
                            <span className="event-chip">
                              {syncStatusLabel(account.syncStatus)}
                            </span>
                            <small>{accountSyncDetail(account)}</small>
                          </span>
                          <div className="meta-account-destination-summary">
                            <span className="meta-account-destination-summary-head">
                              <small>Rotas automaticas por Pagina</small>
                              <strong>
                                {persistedDestinations.length} par(es){" "}
                                Pagina/Pixel
                              </strong>
                            </span>
                            <div>
                              {persistedDestinations.length > 0 ? (
                                persistedDestinations.map((item) => (
                                  <span
                                    className="meta-account-destination-pair"
                                    key={
                                      item.id ??
                                      `${item.pixelId}:${item.pageId}`
                                    }
                                  >
                                    <strong>
                                      <PresentationMask placeholder="Pagina oculta">
                                        {item.pageName ?? item.pageId}
                                      </PresentationMask>
                                    </strong>
                                    <small>
                                      <PresentationMask placeholder="Pixel oculto">
                                        {item.pixelName ?? item.pixelId}
                                      </PresentationMask>
                                    </small>
                                  </span>
                                ))
                              ) : (
                                <span className="muted">
                                  Nenhuma rota de Pagina configurada.
                                </span>
                              )}
                            </div>
                          </div>
                          {canManage ? (
                            <div className="meta-account-routing-control">
                              <small>Destinos da conta</small>
                              <details className="meta-account-destination-picker">
                                <summary>
                                  <span>
                                    {draft.allowedIds.length} selecionado(s)
                                  </span>
                                  <ChevronDown size={15} aria-hidden="true" />
                                </summary>
                                <div>
                                  <fieldset>
                                    <legend>Pixels e paginas permitidos</legend>
                                    {configuration.destinations.map((item) => {
                                      const itemId = item.id ?? "";
                                      const checked =
                                        draft.allowedIds.includes(itemId);

                                      return (
                                        <label
                                          key={
                                            item.id ??
                                            `${item.pixelId}:${item.pageId}`
                                          }
                                        >
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            disabled={
                                              !itemId || pendingAction !== null
                                            }
                                            onChange={(event) => {
                                              const nextAllowedIds = event
                                                .currentTarget.checked
                                                ? [
                                                    ...new Set([
                                                      ...draft.allowedIds,
                                                      itemId,
                                                    ]),
                                                  ]
                                                : draft.allowedIds.filter(
                                                    (destinationId) =>
                                                      destinationId !== itemId,
                                                  );
                                              const nextDefaultId =
                                                nextAllowedIds.includes(
                                                  draft.defaultId,
                                                )
                                                  ? draft.defaultId
                                                  : (nextAllowedIds[0] ?? "");

                                              setAccountDestinationDrafts(
                                                (current) => ({
                                                  ...current,
                                                  [account.id]: {
                                                    allowedIds: nextAllowedIds,
                                                    defaultId: nextDefaultId,
                                                  },
                                                }),
                                              );
                                            }}
                                          />
                                          <span>
                                            <strong>
                                              {item.label ??
                                                item.pixelName ??
                                                item.pixelId}
                                            </strong>
                                            <small>
                                              {item.pixelName ?? item.pixelId} /{" "}
                                              {item.pageName ?? item.pageId}
                                            </small>
                                          </span>
                                        </label>
                                      );
                                    })}
                                  </fieldset>
                                  <label htmlFor={`destination-${account.id}`}>
                                    Destino padrao da conta
                                  </label>
                                  <select
                                    id={`destination-${account.id}`}
                                    aria-label={`Destino padrao de ${account.adAccountName}`}
                                    value={draft.defaultId}
                                    disabled={
                                      draft.allowedIds.length === 0 ||
                                      pendingAction !== null
                                    }
                                    onChange={(event) => {
                                      const defaultId =
                                        event.currentTarget.value;

                                      setAccountDestinationDrafts(
                                        (current) => ({
                                          ...current,
                                          [account.id]: {
                                            ...draft,
                                            defaultId,
                                          },
                                        }),
                                      );
                                    }}
                                    data-presentation-sensitive-field="true"
                                  >
                                    {allowedDestinations.map((item) => (
                                      <option
                                        key={item.id}
                                        value={item.id ?? ""}
                                      >
                                        {item.label ??
                                          item.pixelName ??
                                          item.pixelId}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    className="button secondary"
                                    type="button"
                                    disabled={
                                      draft.allowedIds.length === 0 ||
                                      pendingAction !== null
                                    }
                                    onClick={() =>
                                      void handleAccountDestination(
                                        account,
                                        connection.defaultConversionDestinationId,
                                      )
                                    }
                                  >
                                    <Save size={15} aria-hidden="true" />
                                    {pendingAction ===
                                    `destination:${account.id}`
                                      ? "Salvando..."
                                      : "Salvar destinos"}
                                  </button>
                                </div>
                              </details>
                              {persistedDestinationIds.length > 0 ? (
                                <button
                                  className="button ghost"
                                  type="button"
                                  disabled={pendingAction !== null}
                                  onClick={() =>
                                    void handleAdRouting(account.id)
                                  }
                                >
                                  <Link2 size={15} aria-hidden="true" />
                                  {pendingAction === `ad-routing:${account.id}`
                                    ? "Carregando..."
                                    : expandedAdRoutingAccountId === account.id
                                      ? "Fechar auditoria"
                                      : "Auditar roteamento"}
                                </button>
                              ) : null}
                            </div>
                          ) : null}

                          {expandedAdRoutingAccountId === account.id ? (
                            <section className="meta-ad-routing-editor">
                              <div className="meta-ad-routing-editor-head">
                                <span>
                                  <small>Roteamento fino</small>
                                  <strong>Anuncios desta conta</strong>
                                </span>
                                {adRouting ? (
                                  <span className="event-chip">
                                    {adRouting.ads.length} anuncio(s)
                                  </span>
                                ) : null}
                              </div>

                              {adRouting ? (
                                <>
                                  <div className="meta-ad-routing-toolbar">
                                    <input
                                      type="search"
                                      value={
                                        adRoutingSearches[account.id] ?? ""
                                      }
                                      onChange={(event) => {
                                        const searchValue =
                                          event.currentTarget.value;

                                        setAdRoutingSearches((current) => ({
                                          ...current,
                                          [account.id]: searchValue,
                                        }));
                                      }}
                                      placeholder="Buscar anuncio por nome ou ID"
                                      aria-label={`Buscar anuncios de ${account.adAccountName}`}
                                      data-presentation-sensitive-field="true"
                                    />
                                    <div
                                      className="segmented-control compact meta-ad-routing-filter"
                                      aria-label="Filtrar auditoria de anuncios"
                                    >
                                      <button
                                        className={
                                          routingFilter === "pending"
                                            ? "active"
                                            : ""
                                        }
                                        type="button"
                                        aria-pressed={
                                          routingFilter === "pending"
                                        }
                                        onClick={() =>
                                          setAdRoutingFilters((current) => ({
                                            ...current,
                                            [account.id]: "pending",
                                          }))
                                        }
                                      >
                                        Pendentes {pendingAdCount}
                                      </button>
                                      <button
                                        className={
                                          routingFilter === "resolved"
                                            ? "active"
                                            : ""
                                        }
                                        type="button"
                                        aria-pressed={
                                          routingFilter === "resolved"
                                        }
                                        onClick={() =>
                                          setAdRoutingFilters((current) => ({
                                            ...current,
                                            [account.id]: "resolved",
                                          }))
                                        }
                                      >
                                        Resolvidos {resolvedAdCount}
                                      </button>
                                      <button
                                        className={
                                          routingFilter === "all"
                                            ? "active"
                                            : ""
                                        }
                                        type="button"
                                        aria-pressed={routingFilter === "all"}
                                        onClick={() =>
                                          setAdRoutingFilters((current) => ({
                                            ...current,
                                            [account.id]: "all",
                                          }))
                                        }
                                      >
                                        Todos {adRouting.ads.length}
                                      </button>
                                    </div>
                                  </div>
                                  <p className="meta-ad-routing-guidance">
                                    A Pagina do anuncio define o Pixel e o
                                    destino automaticamente. Abra um grupo
                                    apenas para revisar ou criar uma excecao.
                                  </p>
                                  <div className="meta-ad-routing-groups">
                                    {adRouteGroups.length > 0 ? (
                                      adRouteGroups.map((group) => {
                                        const groupDestination =
                                          persistedDestinations.find(
                                            (item) =>
                                              item.pageId === group.pageId,
                                          );
                                        const groupResolvedCount =
                                          group.ads.filter(
                                            (ad) =>
                                              ad.routeStatus === "assigned",
                                          ).length;
                                        const groupPendingCount =
                                          group.ads.length - groupResolvedCount;

                                        return (
                                          <details
                                            className="meta-ad-routing-group"
                                            key={group.key}
                                          >
                                            <summary>
                                              <span className="meta-ad-routing-group-icon">
                                                <Link2
                                                  size={16}
                                                  aria-hidden="true"
                                                />
                                              </span>
                                              <span>
                                                <small>Pagina detectada</small>
                                                <strong>
                                                  <PresentationMask placeholder="Pagina oculta">
                                                    {groupDestination?.pageName ??
                                                      group.pageId ??
                                                      "Pagina nao identificada"}
                                                  </PresentationMask>
                                                </strong>
                                                <small>
                                                  <PresentationMask placeholder="ID oculto">
                                                    {group.pageId ??
                                                      "Sem ID de Pagina"}
                                                  </PresentationMask>
                                                </small>
                                              </span>
                                              <span>
                                                <small>Pixel / Destino</small>
                                                <strong>
                                                  {groupDestination?.label ??
                                                    groupDestination?.pixelName ??
                                                    (group.pixelId
                                                      ? `Pixel ${group.pixelId}`
                                                      : "Destino pendente")}
                                                </strong>
                                                <small>
                                                  {groupDestination
                                                    ? "Regra automatica da Pagina"
                                                    : "Configure o par Pagina/Pixel"}
                                                </small>
                                              </span>
                                              <span className="meta-ad-routing-group-status">
                                                <span className="event-chip">
                                                  {group.ads.length} anuncio(s)
                                                </span>
                                                {groupPendingCount > 0 ? (
                                                  <span className="event-chip warning">
                                                    {groupPendingCount}{" "}
                                                    pendente(s)
                                                  </span>
                                                ) : (
                                                  <span className="event-chip success">
                                                    Todos resolvidos
                                                  </span>
                                                )}
                                              </span>
                                              <ChevronDown
                                                size={16}
                                                aria-hidden="true"
                                              />
                                            </summary>
                                            <div className="meta-ad-routing-list">
                                              {group.ads.map((ad) => {
                                                const selectedManualId =
                                                  adDestinationDrafts[
                                                    adDestinationDraftKey(
                                                      account.id,
                                                      ad.adId,
                                                    )
                                                  ] ?? "";
                                                const assignedDestination =
                                                  configuration.destinations.find(
                                                    (item) =>
                                                      item.id ===
                                                      ad.conversionDestinationId,
                                                  );

                                                return (
                                                  <div key={ad.adId}>
                                                    <span>
                                                      <strong>
                                                        <PresentationMask placeholder="Anuncio oculto">
                                                          {ad.adName}
                                                        </PresentationMask>
                                                      </strong>
                                                      <small>
                                                        <PresentationMask placeholder="ID oculto">
                                                          {ad.adId}
                                                        </PresentationMask>
                                                      </small>
                                                    </span>
                                                    <span>
                                                      <small>
                                                        Destino atual
                                                      </small>
                                                      <strong>
                                                        {assignedDestination?.label ??
                                                          assignedDestination?.pixelName ??
                                                          adRouteStatusLabel(
                                                            ad.routeStatus,
                                                          )}
                                                      </strong>
                                                      <small>
                                                        {ad.assignmentSource ===
                                                        "manual"
                                                          ? "Excecao manual"
                                                          : ad.assignmentSource ===
                                                              "automatic"
                                                            ? "Regra automatica da Pagina"
                                                            : adRouteStatusLabel(
                                                                ad.routeStatus,
                                                              )}
                                                      </small>
                                                    </span>
                                                    <span className="meta-ad-routing-control">
                                                      <select
                                                        aria-label={`Destino manual de ${ad.adName}`}
                                                        value={selectedManualId}
                                                        disabled={
                                                          pendingAction !== null
                                                        }
                                                        onChange={(event) => {
                                                          const destinationId =
                                                            event.currentTarget
                                                              .value;

                                                          setAdDestinationDrafts(
                                                            (current) => ({
                                                              ...current,
                                                              [adDestinationDraftKey(
                                                                account.id,
                                                                ad.adId,
                                                              )]:
                                                                destinationId,
                                                            }),
                                                          );
                                                        }}
                                                        data-presentation-sensitive-field="true"
                                                      >
                                                        <option value="">
                                                          Usar regra da Pagina
                                                        </option>
                                                        {persistedDestinations.map(
                                                          (item) => (
                                                            <option
                                                              key={item.id}
                                                              value={
                                                                item.id ?? ""
                                                              }
                                                            >
                                                              {item.label ??
                                                                item.pixelName ??
                                                                item.pixelId}
                                                            </option>
                                                          ),
                                                        )}
                                                      </select>
                                                      <button
                                                        className="icon-button"
                                                        type="button"
                                                        title="Salvar excecao do anuncio"
                                                        aria-label={`Salvar destino de ${ad.adName}`}
                                                        disabled={
                                                          pendingAction !== null
                                                        }
                                                        onClick={() =>
                                                          void handleAdDestination(
                                                            account.id,
                                                            ad.adId,
                                                          )
                                                        }
                                                      >
                                                        <Save
                                                          size={15}
                                                          aria-hidden="true"
                                                        />
                                                      </button>
                                                    </span>
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          </details>
                                        );
                                      })
                                    ) : routingFilter === "pending" &&
                                      pendingAdCount === 0 ? (
                                      <div className="meta-ad-routing-complete">
                                        <CircleCheck
                                          size={18}
                                          aria-hidden="true"
                                        />
                                        <span>
                                          <strong>
                                            Todos os anuncios foram roteados
                                            automaticamente
                                          </strong>
                                          <small>
                                            Nenhuma decisao manual e necessaria
                                            nesta conta.
                                          </small>
                                        </span>
                                      </div>
                                    ) : (
                                      <p className="muted">
                                        Nenhum anuncio corresponde a este
                                        filtro.
                                      </p>
                                    )}
                                  </div>
                                </>
                              ) : (
                                <p className="muted">Carregando anuncios...</p>
                              )}
                            </section>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {connectionDestinations.length > 0 ? (
                <details className="meta-destination-inventory">
                  <summary>
                    <span>
                      Destinos salvos nesta BM
                      <small>
                        Pixel/Dataset e Pagina preservados para reutilizacao
                      </small>
                    </span>
                    <span>
                      {connectionDestinations.length}
                      <ChevronDown size={15} aria-hidden="true" />
                    </span>
                  </summary>
                  <div>
                    {connectionDestinations.map((item) => (
                      <div key={item.id ?? `${item.pixelId}:${item.pageId}`}>
                        <span>
                          <small>Destino</small>
                          <strong>
                            <PresentationMask placeholder="Destino oculto">
                              {item.label ?? "Destino Meta"}
                            </PresentationMask>
                          </strong>
                        </span>
                        <span>
                          <small>Pixel / Dataset</small>
                          <strong>
                            <PresentationMask placeholder="Pixel oculto">
                              {item.pixelName ?? item.pixelId}
                            </PresentationMask>
                          </strong>
                          <small>
                            <PresentationMask placeholder="ID oculto">
                              {item.pixelId}
                            </PresentationMask>
                          </small>
                        </span>
                        <span>
                          <small>Pagina</small>
                          <strong>
                            <PresentationMask placeholder="Pagina oculta">
                              {item.pageName ?? item.pageId}
                            </PresentationMask>
                          </strong>
                          <small>
                            <PresentationMask placeholder="ID oculto">
                              {item.pageId}
                            </PresentationMask>
                          </small>
                        </span>
                        <span className="event-chip">
                          {statusLabel(item.status)}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </article>
          );
        })}
      </div>
    );
  }

  function renderOAuthRoutingControl() {
    if (!oauthMode || (configuration?.businessConnections.length ?? 0) === 0) {
      return null;
    }

    const enabled = Boolean(configuration?.advancedRoutingEnabled);
    const unmapped = configuration?.unmappedActiveAccountCount ?? 0;
    const connectionsById = new Map(
      configuration?.businessConnections.map((connection) => [
        connection.id,
        connection,
      ]) ?? [],
    );
    const destinationsById = new Map(
      configuration?.destinations.flatMap((destination) =>
        destination.id ? [[destination.id, destination] as const] : [],
      ) ?? [],
    );
    const activeConnections =
      configuration?.businessConnections.filter(
        (connection) => connection.status === "active",
      ) ?? [];
    const structuresReady =
      activeConnections.length > 0 &&
      activeConnections.every((connection) => {
        const destination = connection.defaultConversionDestinationId
          ? destinationsById.get(connection.defaultConversionDestinationId)
          : null;

        return (
          connection.activeReportingAccountCount > 0 &&
          destination?.status === "configured"
        );
      }) &&
      (configuration?.reportingAccounts ?? [])
        .filter((account) => account.active)
        .every((account) => {
          const connection = account.businessConnectionId
            ? connectionsById.get(account.businessConnectionId)
            : null;
          const destinationId =
            account.conversionDestinationId ??
            connection?.defaultConversionDestinationId;

          return (
            connection?.status === "active" &&
            Boolean(
              destinationId &&
              destinationsById.get(destinationId)?.status === "configured",
            )
          );
        });
    const canActivate = unmapped === 0 && structuresReady;

    return (
      <div className={`meta-manual-notice ${enabled ? "success" : "warn"}`}>
        {enabled ? <CircleCheck size={16} /> : <ShieldCheck size={16} />}
        <span>
          <strong>
            {enabled
              ? "Roteamento por BM ativo"
              : "Estruturas salvas sem alterar a rota atual"}
          </strong>
          <small>
            {enabled
              ? "Cada conta usa o destino da sua BM ou a excecao configurada."
              : unmapped > 0
                ? `${unmapped} conta(s) ativa(s) ainda precisam ser vinculadas ou desativadas.`
                : !structuresReady
                  ? "Revalide as BMs e confirme contas e destinos antes da ativacao."
                  : "A revisao esta completa. O destino principal continua valendo ate a ativacao."}
          </small>
        </span>
        {canManage ? (
          <button
            className={`button ${enabled ? "secondary" : ""}`}
            type="button"
            disabled={pendingAction !== null || (!enabled && !canActivate)}
            onClick={() => void handleOAuthRouting(!enabled)}
          >
            <Link2 size={16} />
            {pendingAction === "routing"
              ? "Aplicando..."
              : enabled
                ? "Usar destino principal"
                : "Ativar roteamento por BM"}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <div className="meta-manual-panel">
        <button
          className="meta-manual-entry"
          type="button"
          onClick={() => setSetupOpen((current) => !current)}
          aria-expanded={setupOpen}
          disabled={!canManage}
        >
          <span className="meta-manual-entry-icon" aria-hidden="true">
            {oauthMode ? <Building2 size={18} /> : <KeyRound size={18} />}
          </span>
          <span className="meta-manual-entry-copy">
            <span className="micro-label">
              {oauthMode
                ? "Configuracao avancada OAuth"
                : "Outra forma de conectar"}
            </span>
            <strong>
              {oauthMode
                ? "Vincular Pixel e Pagina por BM"
                : "Usar token permanente"}
            </strong>
            <span className="muted">
              {oauthMode
                ? "Associe cada BM e suas contas ao destino de conversao correto."
                : palmupReady
                  ? "Entre com o Facebook pela PalmUP ou cole o token de usuario do sistema."
                  : "Para estruturas operadas por token de usuario do sistema."}
            </span>
          </span>
          <span className="meta-manual-entry-action">
            {configuredBusinessCount}{" "}
            {configuredBusinessCount === 1 ? "BM" : "BMs"}
            <span aria-hidden="true">·</span>
            {configuredAccountCount}{" "}
            {configuredAccountCount === 1 ? "conta" : "contas"}
            <span aria-hidden="true">·</span>
            {configuredDestinationCount}{" "}
            {configuredDestinationCount === 1 ? "destino" : "destinos"}
            <ChevronDown size={16} />
          </span>
        </button>

        {setupOpen ? (
          <div className="meta-manual-workspace">
            <div className="meta-manual-toolbar">
              <div>
                <span className="eyebrow">
                  {oauthMode
                    ? "Login social com multiplos destinos"
                    : "Conexao por token"}
                </span>
                <h3>
                  {editingConnectionId
                    ? "Editar estrutura Meta"
                    : oauthMode
                      ? "Configurar destinos por BM"
                      : "Configurar estrutura Meta"}
                </h3>
              </div>
              <div
                className="segmented-control"
                aria-label="Tipo de configuracao"
              >
                <button
                  type="button"
                  className={setupMode === "quick" ? "active" : ""}
                  aria-pressed={setupMode === "quick"}
                  onClick={() => setSetupMode("quick")}
                >
                  Rapida
                </button>
                <button
                  type="button"
                  className={setupMode === "advanced" ? "active" : ""}
                  aria-pressed={setupMode === "advanced"}
                  onClick={() => setSetupMode("advanced")}
                >
                  Avancada
                </button>
              </div>
            </div>

            <ol className="meta-setup-steps" aria-label="Etapas da conexao">
              <SetupStep
                active={!credentialId}
                done={Boolean(credentialId)}
                label={oauthMode ? "OAuth" : "Token"}
              />
              <SetupStep
                active={Boolean(credentialId && !businessId)}
                done={Boolean(businessId)}
                label="BM"
              />
              <SetupStep
                active={Boolean(businessId && selectedAccountIds.length === 0)}
                done={selectedAccountIds.length > 0}
                label="Contas"
              />
              <SetupStep
                active={selectedAccountIds.length > 0 && !destinationReady}
                done={destinationReady}
                label="Destino"
              />
              <SetupStep
                active={readyToActivate}
                done={false}
                label="Revisao"
              />
            </ol>

            <div className="meta-setup-grid">
              <section className="meta-setup-section">
                <div className="meta-setup-heading">
                  <KeyRound size={17} />
                  <div>
                    <span className="micro-label">1. Credencial</span>
                    <strong>
                      {oauthMode
                        ? "Login social conectado"
                        : "Token permanente"}
                    </strong>
                  </div>
                </div>
                {(configuration?.credentials.length ?? 0) > 0 ? (
                  <SearchableSelect
                    name="credentialId"
                    value={credentialId}
                    options={(configuration?.credentials ?? []).map((item) => ({
                      value: item.id,
                      label: item.label,
                      description: `final ${item.tokenLast4} | ${statusLabel(item.status)}`,
                    }))}
                    onValueChange={handleCredentialSelection}
                    ariaLabel="Credencial Meta"
                    placeholder={
                      oauthMode
                        ? "Escolher autorizacao OAuth"
                        : "Escolher token salvo"
                    }
                    presentationPlaceholder="Credencial oculta"
                    disabled={pendingAction !== null}
                    sensitive
                  />
                ) : null}
                {oauthMode ? (
                  <button
                    className="button secondary"
                    type="button"
                    disabled={pendingAction !== null}
                    onClick={() => void handleOAuthCredentialPreparation()}
                  >
                    <ShieldCheck size={16} />
                    {pendingAction === "credential"
                      ? "Validando..."
                      : (configuration?.credentials.length ?? 0) > 0
                        ? "Atualizar autorizacao"
                        : "Usar autorizacao OAuth"}
                  </button>
                ) : (
                  <>
                  {renderPalmupConnect()}
                  <form
                    ref={credentialFormRef}
                    className="meta-token-form"
                    onSubmit={handleCredentialSubmit}
                  >
                    <label>
                      <span>Nome da credencial</span>
                      <input
                        name="label"
                        type="text"
                        minLength={2}
                        maxLength={80}
                        placeholder="Ex.: Token BM principal"
                        required
                        data-presentation-sensitive-field="true"
                      />
                    </label>
                    <label>
                      <span>Token do usuario do sistema</span>
                      <input
                        name="accessToken"
                        type="password"
                        minLength={20}
                        autoComplete="off"
                        placeholder="Cole o token permanente"
                        required
                        data-presentation-sensitive-field="true"
                      />
                    </label>
                    <button
                      className="button secondary"
                      type="submit"
                      disabled={pendingAction !== null}
                    >
                      <ShieldCheck size={16} />
                      {pendingAction === "credential"
                        ? "Validando..."
                        : "Validar e proteger"}
                    </button>
                  </form>
                  </>
                )}
                <p className="action-note">
                  {oauthMode
                    ? "A autorizacao atual e reutilizada sem exibir o token. Salvar BMs nao altera a rota ate a ativacao final."
                    : "Depois de salvo, o token nao pode ser visualizado. Uma troca exige informar o novo token e validar novamente toda a conexao."}
                </p>
              </section>

              <section className="meta-setup-section">
                <div className="meta-setup-heading">
                  <Building2 size={17} />
                  <div>
                    <span className="micro-label">2. Estrutura anunciante</span>
                    <strong>BM e contas de anuncio</strong>
                  </div>
                </div>
                <SearchableSelect
                  name="businessManagerId"
                  value={businessId}
                  options={(discovery?.businesses ?? []).map((business) => ({
                    value: business.id,
                    label: business.name,
                    description: business.id,
                  }))}
                  onValueChange={handleBusinessSelection}
                  ariaLabel="Business Manager"
                  placeholder="Escolher BM"
                  presentationPlaceholder="BM oculto"
                  disabled={!credentialId || pendingAction !== null}
                  sensitive
                />
                {showBusinessLookup ? (
                  <div className="meta-direct-asset-entry">
                    <div>
                      <span className="micro-label">BM nao enumerada</span>
                      <p className="muted">
                        {oauthMode
                          ? "Informe o ID da BM acessivel pela autorizacao Meta."
                          : "Informe o ID da BM vinculada ao usuario do sistema."}
                      </p>
                    </div>
                    <form
                      className="meta-inline-id-form"
                      onSubmit={handleBusinessLookup}
                    >
                      <label>
                        <span>ID da BM</span>
                        <input
                          value={businessLookupId}
                          onChange={(event) =>
                            setBusinessLookupId(event.currentTarget.value)
                          }
                          placeholder="Ex.: 123456789012345"
                          inputMode="numeric"
                          disabled={pendingAction !== null}
                          data-presentation-sensitive-field="true"
                        />
                      </label>
                      <button
                        className="button secondary"
                        type="submit"
                        disabled={
                          !businessLookupId.trim() || pendingAction !== null
                        }
                      >
                        <RefreshCw size={15} aria-hidden="true" />
                        {pendingAction === "assets"
                          ? "Validando..."
                          : "Validar BM"}
                      </button>
                    </form>
                  </div>
                ) : null}
                <div className="meta-account-picker">
                  {(discovery?.adAccounts ?? []).length > 0 ? (
                    discovery?.adAccounts.map((account) => {
                      const checked = selectedAccountIds.includes(account.id);
                      return (
                        <label
                          key={account.id}
                          className={checked ? "selected" : ""}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setSelectedAccountIds((current) =>
                                current.includes(account.id)
                                  ? current.filter((id) => id !== account.id)
                                  : [...current, account.id],
                              )
                            }
                          />
                          <span>
                            <strong>
                              <PresentationMask placeholder="Conta de anuncios oculta">
                                {account.name}
                              </PresentationMask>
                            </strong>
                            <small>
                              <PresentationMask placeholder="ID oculto">
                                {account.id}
                              </PresentationMask>
                            </small>
                          </span>
                          {checked ? <Check size={16} /> : null}
                        </label>
                      );
                    })
                  ) : (
                    <p className="muted">
                      {pendingAction === "assets"
                        ? "Consultando ativos..."
                        : businessId
                          ? "A Meta nao listou contas para esta BM. Informe os IDs abaixo."
                          : oauthMode
                            ? "Escolha a autorizacao e uma BM para carregar as contas."
                            : "Escolha um token e uma BM para carregar as contas."}
                    </p>
                  )}
                </div>
                {selectedDirectAccountIds.length > 0 ? (
                  <div
                    className="meta-direct-account-list"
                    aria-label="Contas informadas por ID"
                  >
                    {selectedDirectAccountIds.map((accountId) => (
                      <div key={accountId}>
                        <span>
                          <strong>Conta informada</strong>
                          <small>
                            <PresentationMask placeholder="ID oculto">
                              {accountId}
                            </PresentationMask>
                          </small>
                        </span>
                        <button
                          type="button"
                          aria-label={`Remover ${accountId}`}
                          title="Remover conta"
                          onClick={() =>
                            setSelectedAccountIds((current) =>
                              current.filter((id) => id !== accountId),
                            )
                          }
                        >
                          <X size={15} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {showAccountLookup ? (
                  <form
                    className="meta-direct-account-form"
                    onSubmit={handleDirectAccounts}
                  >
                    <label>
                      <span>IDs das contas de anuncio</span>
                      <textarea
                        value={directAccountIds}
                        onChange={(event) =>
                          setDirectAccountIds(event.currentTarget.value)
                        }
                        placeholder="act_1234567890, act_9876543210"
                        rows={2}
                        disabled={pendingAction !== null}
                        data-presentation-sensitive-field="true"
                      />
                    </label>
                    <button
                      className="button secondary"
                      type="submit"
                      disabled={
                        !directAccountIds.trim() || pendingAction !== null
                      }
                    >
                      <Plus size={15} aria-hidden="true" />
                      Adicionar IDs
                    </button>
                  </form>
                ) : null}
              </section>

              <section className="meta-setup-section meta-setup-destination">
                <div className="meta-setup-heading">
                  <Database size={17} />
                  <div>
                    <span className="micro-label">3. Destino CAPI</span>
                    <strong>Pixel/Dataset e Pagina</strong>
                  </div>
                </div>
                {setupMode === "advanced" ? (
                  <div
                    className="segmented-control compact"
                    aria-label="Origem do destino"
                  >
                    <button
                      type="button"
                      className={
                        destinationMode === "discovered" ? "active" : ""
                      }
                      onClick={() => setDestinationMode("discovered")}
                    >
                      Ativos encontrados
                    </button>
                    <button
                      type="button"
                      className={destinationMode === "direct" ? "active" : ""}
                      onClick={() => setDestinationMode("direct")}
                    >
                      Informar IDs
                    </button>
                    {(configuration?.destinations.length ?? 0) > 0 ? (
                      <button
                        type="button"
                        className={
                          destinationMode === "existing" ? "active" : ""
                        }
                        onClick={() => setDestinationMode("existing")}
                      >
                        Reutilizar destino
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {destinationMode === "existing" ? (
                  <SearchableSelect
                    name="existingDestinationId"
                    value={existingDestinationId}
                    options={(configuration?.destinations ?? [])
                      .map((item) => ({
                        value: item.id ?? "",
                        label: item.label ?? item.pixelName ?? "Destino Meta",
                        description: `${item.pixelId} / ${item.pageId}`,
                      }))
                      .filter((item) => Boolean(item.value))}
                    onValueChange={setExistingDestinationId}
                    ariaLabel="Destino compartilhado"
                    placeholder="Escolher destino validado"
                    presentationPlaceholder="Destino oculto"
                    sensitive
                  />
                ) : destinationMode === "direct" ? (
                  <div className="meta-direct-destination-grid">
                    <label>
                      <span>ID do Pixel/Dataset</span>
                      <input
                        value={directPixelId}
                        onChange={(event) =>
                          setDirectPixelId(event.currentTarget.value)
                        }
                        placeholder="Ex.: 1234567890"
                        data-presentation-sensitive-field="true"
                      />
                    </label>
                    <label>
                      <span>ID da Pagina Facebook</span>
                      <input
                        value={directPageId}
                        onChange={(event) =>
                          setDirectPageId(event.currentTarget.value)
                        }
                        placeholder="Ex.: 9876543210"
                        data-presentation-sensitive-field="true"
                      />
                    </label>
                    <label>
                      <span>BM proprietaria dos ativos</span>
                      <input
                        value={ownerBusinessManagerId}
                        onChange={(event) =>
                          setOwnerBusinessManagerId(event.currentTarget.value)
                        }
                        placeholder="Opcional para ativos compartilhados"
                        data-presentation-sensitive-field="true"
                      />
                    </label>
                  </div>
                ) : (
                  <div className="meta-discovered-destination-grid">
                    <SearchableSelect
                      name="pixelId"
                      value={pixelId}
                      options={(discovery?.pixels ?? []).map((pixel) => ({
                        value: pixel.id,
                        label: pixel.name,
                        description: pixel.id,
                      }))}
                      onValueChange={setPixelId}
                      ariaLabel="Pixel ou Dataset"
                      placeholder="Escolher Pixel/Dataset"
                      presentationPlaceholder="Pixel oculto"
                      disabled={!businessId}
                      sensitive
                    />
                    <SearchableSelect
                      name="pageId"
                      value={pageId}
                      options={(discovery?.pages ?? []).map((page) => ({
                        value: page.id,
                        label: page.name,
                        description: page.id,
                      }))}
                      onValueChange={setPageId}
                      ariaLabel="Pagina Facebook"
                      placeholder="Escolher Pagina"
                      presentationPlaceholder="Pagina oculta"
                      disabled={!businessId}
                      sensitive
                    />
                  </div>
                )}
              </section>

              <section className="meta-setup-section meta-setup-review">
                <div className="meta-setup-heading">
                  <CircleCheck size={17} />
                  <div>
                    <span className="micro-label">4. Revisao</span>
                    <strong>Ativar conexao</strong>
                  </div>
                </div>
                <dl className="meta-review-list">
                  <div>
                    <dt>Token</dt>
                    <dd>
                      <PresentationMask placeholder="Credencial oculta">
                        {selectedCredential?.label ??
                          discovery?.credential.label ??
                          "Pendente"}
                      </PresentationMask>
                    </dd>
                  </div>
                  <div>
                    <dt>BM</dt>
                    <dd>
                      <PresentationMask placeholder="Business Manager oculto">
                        {selectedBusiness?.name ?? "Pendente"}
                      </PresentationMask>
                    </dd>
                  </div>
                  <div>
                    <dt>Contas</dt>
                    <dd>{selectedAccountIds.length || "Pendente"}</dd>
                  </div>
                  <div>
                    <dt>Destino</dt>
                    <dd>
                      <PresentationMask placeholder="Destino oculto">
                        {destinationMode === "existing"
                          ? (selectedExistingDestination?.label ?? "Pendente")
                          : destinationMode === "direct"
                            ? directPixelId && directPageId
                              ? `${directPixelId} / ${directPageId}`
                              : "Pendente"
                            : selectedPixel && selectedPage
                              ? `${selectedPixel.name} / ${selectedPage.name}`
                              : "Pendente"}
                      </PresentationMask>
                    </dd>
                  </div>
                </dl>
                <form onSubmit={handleConnectionSubmit}>
                  <button
                    className="button"
                    type="submit"
                    disabled={!readyToActivate || pendingAction !== null}
                  >
                    <Link2 size={16} />
                    {pendingAction === "activate"
                      ? editingConnectionId
                        ? "Salvando alteracoes..."
                        : "Validando estrutura..."
                      : editingConnectionId
                        ? "Salvar alteracoes"
                        : "Validar e ativar"}
                  </button>
                </form>
              </section>
            </div>

            {notice ? (
              <div
                className={`meta-manual-notice ${notice.tone}`}
                role="status"
                aria-live="polite"
              >
                {notice.tone === "success" ? <CircleCheck size={16} /> : null}
                <span>{notice.message}</span>
              </div>
            ) : null}

            {setupMode === "advanced"
              ? renderConfiguredConnections(false)
              : null}
          </div>
        ) : null}
        {!setupOpen && notice ? (
          <div
            className={`meta-manual-notice ${notice.tone}`}
            role="status"
            aria-live="polite"
          >
            {notice.tone === "success" ? <CircleCheck size={16} /> : null}
            <span>{notice.message}</span>
          </div>
        ) : null}
        {!setupOpen && (configuration?.businessConnections.length ?? 0) > 0 ? (
          <details className="meta-configured-structures">
            <summary>
              <span
                className="meta-configured-structures-icon"
                aria-hidden="true"
              >
                <Database size={17} />
              </span>
              <span>
                <span className="micro-label">Estruturas salvas</span>
                <strong>
                  {oauthMode
                    ? "BMs, contas e destinos OAuth"
                    : "Tokens, BMs e destinos"}
                </strong>
                <small>
                  {configuredBusinessCount}{" "}
                  {configuredBusinessCount === 1 ? "BM" : "BMs"},{" "}
                  {configuredAccountCount}{" "}
                  {configuredAccountCount === 1
                    ? "conta ativa"
                    : "contas ativas"}{" "}
                  e {configuredDestinationCount}{" "}
                  {configuredDestinationCount === 1 ? "destino" : "destinos"}
                </small>
              </span>
              <span className="meta-configured-structures-action">
                Ver estruturas
                <ChevronDown size={16} aria-hidden="true" />
              </span>
            </summary>
            <div className="meta-configured-structures-body">
              {renderConfiguredConnections(true)}
            </div>
          </details>
        ) : null}
        {renderOAuthRoutingControl()}

        <dialog
          className="meta-action-dialog meta-remove-connection-dialog"
          ref={removeDialogRef}
          onCancel={(event) => {
            if (pendingAction?.startsWith("remove:")) {
              event.preventDefault();
              return;
            }

            closeRemovalDialog();
          }}
        >
          <div className="meta-action-dialog-header">
            <div>
              <span className="micro-label">Remover estrutura Meta</span>
              <h3>
                <PresentationMask placeholder="Business Manager oculto">
                  {removingConnection?.businessManagerName ?? "Conexao"}
                </PresentationMask>
              </h3>
            </div>
            <button
              className="meta-dialog-close"
              type="button"
              aria-label="Fechar confirmacao"
              title="Fechar"
              onClick={closeRemovalDialog}
              disabled={pendingAction?.startsWith("remove:")}
            >
              <X size={17} aria-hidden="true" />
            </button>
          </div>
          <form className="meta-action-form" onSubmit={handleRemoveConnection}>
            <div className="meta-disconnect-warning">
              <TriangleAlert size={20} aria-hidden="true" />
              <div>
                <strong>Esta BM deixara de sincronizar</strong>
                <p>
                  As contas serao desativadas. Relatorios, eventos e auditorias
                  historicos permanecem preservados.
                </p>
              </div>
            </div>
            <label className="field-label" htmlFor="meta-remove-confirmation">
              Digite o ID{" "}
              <strong>
                <PresentationMask placeholder="oculto">
                  {removingConnection?.businessManagerId}
                </PresentationMask>
              </strong>
            </label>
            <input
              id="meta-remove-confirmation"
              autoComplete="off"
              value={removalConfirmation}
              onChange={(event) =>
                setRemovalConfirmation(event.currentTarget.value)
              }
              disabled={pendingAction?.startsWith("remove:")}
              data-presentation-sensitive-field="true"
            />
            <div className="meta-action-dialog-footer">
              <button
                className="button"
                type="button"
                onClick={closeRemovalDialog}
                disabled={pendingAction?.startsWith("remove:")}
              >
                Cancelar
              </button>
              <button
                className="button danger"
                type="submit"
                disabled={
                  !removingConnection ||
                  removalConfirmation.trim() !==
                    removingConnection.businessManagerId ||
                  pendingAction !== null
                }
              >
                <Trash2 size={16} aria-hidden="true" />
                {pendingAction?.startsWith("remove:")
                  ? "Removendo..."
                  : "Remover estrutura"}
              </button>
            </div>
          </form>
        </dialog>
      </div>
      {oauthMode && capabilities.manualEnabled ? (
        <LegacyOAuthMigrationCard
          workspaceId={workspaceId}
          canManage={canManage}
          disconnectOAuthAction={disconnectOAuthAction}
        />
      ) : null}
    </>
  );
}

function SetupStep({
  active,
  done,
  label,
}: {
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <li className={`${active ? "active" : ""}${done ? " done" : ""}`}>
      <span>{done ? <Check size={12} /> : null}</span>
      {label}
    </li>
  );
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    active: "Ativa",
    configured: "Configurado",
    pending: "Pendente",
    paused: "Pausada",
    validation_required: "Requer validacao",
    token_expired: "Token expirado",
    missing_permission: "Permissao ausente",
    destination_invalid: "Destino invalido",
    expired: "Expirado",
    revoked: "Revogado",
    error: "Erro",
  };

  return labels[status] ?? status;
}

function syncStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "Aguardando",
    syncing: "Sincronizando",
    synced: "Sincronizada",
    error: "Falhou",
  };

  return labels[status] ?? status;
}

function adRouteStatusLabel(status: string) {
  const labels: Record<string, string> = {
    assigned: "Destino resolvido",
    ambiguous: "Multiplas correspondencias",
    unresolved: "Destino pendente",
  };

  return labels[status] ?? status;
}

function accountSyncDetail(
  account: MetaManualConfigurationDto["reportingAccounts"][number],
) {
  if (account.syncError) {
    return account.syncError;
  }

  if (account.lastSyncSince && account.lastSyncUntil) {
    return `Periodo importado: ${account.lastSyncSince} a ${account.lastSyncUntil}`;
  }

  if (account.syncStatus === "syncing") {
    return "Importacao em andamento";
  }

  return "Aguardando a primeira importacao de Insights";
}
