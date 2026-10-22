"use client";

import type {
  ConversionEventNameDto,
  InboundWebhookChannelDto,
} from "@wpptrack/shared";
import {
  conversionEventCarriesValue,
  conversionEventDisplayLabels,
  conversionEventNameSchema,
  conversionEventValuePolicy,
  formatMoney,
  pipedriveChannelBindingMessages,
  pipedriveConnectionCreateInputSchema,
  pipedriveConversionRuleCreateInputSchema,
} from "@wpptrack/shared";
import {
  Check,
  Copy,
  Database,
  Eye,
  KeyRound,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { Fragment, useEffect, useRef, useState } from "react";
import { PresentationMask } from "../../../components/presentation-mask";
import {
  CrmCurrencySelect,
  useWorkspaceCurrency,
} from "../../../components/workspace-currency";
import {
  crmChannelOptionsFor,
  type CrmChannelOption,
} from "../../../lib/crm-channel-options";
import { displayTimeZone } from "../../../lib/date-time";
import type {
  PipedriveActionResult,
  PipedriveCapabilitiesDto,
  PipedriveCapabilitiesResult,
  PipedriveConnectionDetailDto,
  PipedriveConnectionGetResult,
  PipedriveConnectionListResult,
  PipedriveConnectionSnapshotDto,
  PipedriveConversionRuleDto,
  PipedriveEventDto,
  PipedriveEventResultDto,
  PipedriveEventRetryResult,
  PipedriveEventsResult,
  PipedrivePipelineDto,
  PipedriveRuleActionResult,
} from "../integrations/pipedrive-actions";

type ConnectionAction = (formData: FormData) => Promise<PipedriveActionResult>;
type RuleAction = (formData: FormData) => Promise<PipedriveRuleActionResult>;
type ListConnectionsAction = (
  workspaceId: string,
) => Promise<PipedriveConnectionListResult>;
type GetConnectionAction = (
  workspaceId: string,
  connectionId: string,
) => Promise<PipedriveConnectionGetResult>;
type ListEventsAction = (
  workspaceId: string,
  connectionId: string,
) => Promise<PipedriveEventsResult>;
type GetCapabilitiesAction = (
  workspaceId: string,
  connectionId: string,
) => Promise<PipedriveCapabilitiesResult>;
type RetryEventAction = (
  formData: FormData,
) => Promise<PipedriveEventRetryResult>;

type AnyResult = {
  ok: boolean;
  message: string;
  authFailure?: "unauthorized";
  /** HTTP 423: refused by the license guard before any write ran. */
  licenseLocked?: boolean;
  outcomeUnknown?: boolean;
};

export type PipedriveConnectionsLoadState =
  | "real"
  | "empty"
  | "error"
  | "forbidden";

export type PipedriveConversionPanelProps = {
  unsettledOperations?: { creation: boolean; connectionIds: Set<string> };
  workspaceId: string;
  connections: PipedriveConnectionDetailDto[];
  loadState: PipedriveConnectionsLoadState;
  allChannels: InboundWebhookChannelDto[];
  canManage: boolean;
  /** Client-side hint only: the server stays the authority (HTTP 423). */
  licenseLocked?: boolean;
  createConnectionAction: ConnectionAction;
  replaceCredentialAction: ConnectionAction;
  setStatusAction: ConnectionAction;
  setChannelBindingsAction: ConnectionAction;
  refreshCatalogAction: ConnectionAction;
  deleteConnectionAction: ConnectionAction;
  rotateWebhookAction: ConnectionAction;
  revokeWebhookAction: ConnectionAction;
  listConnectionsAction?: ListConnectionsAction;
  getConnectionAction: GetConnectionAction;
  getCapabilitiesAction: GetCapabilitiesAction;
  createRuleAction: RuleAction;
  updateRuleAction: RuleAction;
  deleteRuleAction: RuleAction;
  listEventsAction: ListEventsAction;
  retryEventAction: RetryEventAction;
};

type Notice = { tone: "success" | "error"; message: string };

type OneTimeSecret = {
  workspaceId: string;
  connectionId: string;
  identity: string;
  webhookUrl: string;
  rotatedAt: string;
};

/**
 * Shown whenever an action's own promise rejects (network blip between the
 * browser and the Next.js server) instead of resolving with a structured
 * result. Never echoes the raw error.
 */
const TRANSPORT_ERROR_MESSAGE =
  "Não foi possível concluir a ação. Verifique sua conexão/sessão e tente novamente.";
const SESSION_MESSAGE =
  "Sua sessão expirou ou não tem permissão para esta ação. Atualize a página.";
const LICENSE_LOCKED_RULE_FORM_NOTE =
  "Licença bloqueada: esta regra não pode ser salva agora. Verifique /backoffice/license.";
const LICENSE_LOCKED_NOTE =
  "Licença bloqueada: criar, editar, pausar, gerar URL ou ativar envio está indisponível. Você ainda pode consultar conexões, regras e eventos.";
const MAX_FIXED_VALUE_CENTS = 2_147_483_647;

/** One authorizable WhatsApp number of the workspace (any provider); shared
 * with Kommo (lib/crm-channel-options). */
type RouteOption = CrmChannelOption;

const conversionEventOptions = conversionEventNameSchema.options;

function eventLabel(eventName: ConversionEventNameDto): string {
  return conversionEventDisplayLabels[eventName];
}

function valuePolicyHint(eventName: ConversionEventNameDto): string {
  const policy = conversionEventValuePolicy(eventName);
  if (policy === "none") {
    return "Este evento não carrega valor: nenhum valor, moeda ou produto é configurado.";
  }
  if (policy === "required") {
    return "Este evento exige valor positivo e moeda configurada. Sem isso o movimento é ignorado.";
  }
  return "Valor opcional. Um valor positivo só é aceito com moeda configurada; sem valor, o movimento segue sem valor.";
}

type CapabilitiesView =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; capabilities: PipedriveCapabilitiesDto }
  | { phase: "missing" }
  | { phase: "unavailable" }
  | { phase: "unauthorized" };

type RequirementState = "ok" | "missing" | "server";
type ReadinessItem = { code: string; label: string; state: RequirementState };

const DEFAULT_REQUIREMENTS = [
  "verified_account",
  "fresh_catalog",
  "configured_webhook",
  "authorized_certified_channel",
  "existing_lead_attribution",
];

const requirementLabels: Record<string, string> = {
  verified_account: "Conta Pipedrive verificada e credencial saudável",
  fresh_catalog: "Catálogo atualizado",
  configured_webhook: "URL de webhook gerada",
  authorized_certified_channel:
    "Canal de WhatsApp autorizado e com destino Meta configurado",
  existing_lead_attribution:
    "Lead de WhatsApp já existente vindo de anúncio (conferido a cada movimento)",
};

function requirementState(
  code: string,
  connection: PipedriveConnectionDetailDto,
): RequirementState {
  switch (code) {
    case "verified_account":
      return connection.verifiedAccountId && connection.credentialHealthy
        ? "ok"
        : "missing";
    case "fresh_catalog":
      return connection.catalogState === "fresh" ? "ok" : "missing";
    case "configured_webhook":
      return connection.webhook
        ? connection.webhook.configured
          ? "ok"
          : "missing"
        : "server";
    case "authorized_certified_channel":
      return connection.allowedChannelRouteIds.length > 0 ? "ok" : "missing";
    default:
      return "server";
  }
}

function readinessFor(
  connection: PipedriveConnectionDetailDto,
  capabilities: CapabilitiesView,
): ReadinessItem[] {
  const codes =
    capabilities.phase === "ready" &&
    capabilities.capabilities.activationRequirements.length > 0
      ? capabilities.capabilities.activationRequirements
      : DEFAULT_REQUIREMENTS;
  return codes.map((code) => ({
    code,
    label: requirementLabels[code] ?? `Requisito: ${code}`,
    state: requirementState(code, connection),
  }));
}

const deliveryStatusText: Record<
  string,
  { label: string; tone: string; detail: string }
> = {
  materialized: {
    label: "Conversão registrada",
    tone: "neutral",
    detail: "o envio à Meta ainda não foi iniciado",
  },
  publication_pending: {
    label: "Aguardando envio",
    tone: "neutral",
    detail: "ainda não enviado à Meta",
  },
  queued: {
    label: "Na fila de envio",
    tone: "neutral",
    detail: "ainda não confirmado pela Meta",
  },
  sent: { label: "Enviado", tone: "success", detail: "envio registrado como concluído" },
  revoked: {
    label: "Não enviado",
    tone: "warn",
    detail: "a autorização foi revogada antes do envio",
  },
  publication_failed: {
    label: "Envio não realizado",
    tone: "warn",
    detail: "não enviado à Meta",
  },
  delivery_unknown: {
    label: "Resultado desconhecido",
    tone: "warn",
    detail: "não será reenviado para evitar conversão duplicada",
  },
  unrecognized: {
    label: "Estado de envio não reconhecido",
    tone: "warn",
    detail: "nada foi assumido como enviado",
  },
};

function shortConversionId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}...` : id;
}

function connectionStatusLabel(
  status: PipedriveConnectionDetailDto["status"],
): string {
  if (status === "active") return "Ativa";
  if (status === "paused") return "Pausada";
  return "Bloqueada";
}

function connectionStatusTone(
  status: PipedriveConnectionDetailDto["status"],
): string {
  if (status === "active") return "success";
  if (status === "paused") return "neutral";
  return "warn";
}

function catalogStateLabel(
  state: PipedriveConnectionDetailDto["catalogState"],
): string {
  if (state === "fresh") return "Catálogo atualizado";
  if (state === "stale") return "Catálogo desatualizado";
  if (state === "error") return "Falha ao atualizar catálogo";
  return "Catálogo não carregado";
}

function catalogStateTone(
  state: PipedriveConnectionDetailDto["catalogState"],
): string {
  if (state === "fresh") return "success";
  if (state === "stale" || state === "error") return "warn";
  return "neutral";
}

const errorCodePattern = /^[a-z0-9_]{1,64}$/;

/**
 * Closed dictionary: only codes the backend itself defines are translated;
 * anything else is shown as an opaque, pattern-checked code and never as text.
 */
const errorCodeText: Record<string, string> = {
  pipedrive_unauthorized:
    "O Pipedrive recusou a credencial. Substitua o token da conexão.",
  pipedrive_rate_limited:
    "O Pipedrive limitou as requisições. Aguarde e atualize o catálogo depois.",
  pipedrive_transport:
    "Falha de comunicação com o Pipedrive. Tente novamente em instantes.",
  pipedrive_timeout: "O Pipedrive demorou demais para responder.",
  pipedrive_invalid_response:
    "O Pipedrive retornou uma resposta inesperada.",
  pipedrive_account_mismatch:
    "O token pertence a outra conta Pipedrive. Substitua a credencial pela correta.",
  pipedrive_persistence_failed:
    "Falha ao salvar no servidor. Tente novamente mais tarde.",
  pipedrive_encryption_key_invalid:
    "A instalação ainda não está configurada para guardar credenciais Pipedrive. Fale com o suporte.",
  credential_decrypt_failed:
    "A credencial salva não pode ser lida. Substitua o token da conexão.",
  pipedrive_payload_invalid: "Aviso do Pipedrive em formato não reconhecido.",
  pipedrive_identity_or_timestamp_invalid:
    "Aviso de outra conta Pipedrive ou com horário inválido.",
  not_deal_change: "Aviso que não é alteração de negócio; ignorado.",
  no_relevant_change:
    "Alteração sem mudança de etapa nem de status (ex.: campo personalizado); ignorada.",
  no_stage_change: "Sem mudança de etapa.",
  deal_lost_no_conversion: "Negócio perdido: registrado, sem conversão.",
  won_not_selected: "Negócio ganho sem regra de Compra neste funil.",
  pipeline_unavailable: "Funil indisponível no catálogo atual.",
  stage_not_selected: "Etapa sem regra configurada.",
  stage_unavailable: "Etapa indisponível no catálogo atual.",
  catalog_stale: "Catálogo desatualizado; atualize-o.",
  person_missing: "Negócio sem pessoa vinculada.",
  person_identity_mismatch: "Pessoa do negócio não confere.",
  phone_missing: "Pessoa sem telefone.",
  phone_ambiguous: "Telefones ambíguos; não foi possível identificar o lead.",
  workspace_lead_not_found: "Nenhum lead de WhatsApp existente com esse telefone.",
  lead_channel_route_ambiguous: "Mais de uma rota autorizada para a instância do lead.",
  lead_channel_route_unauthorized: "Canal do lead não autorizado nesta conexão.",
  out_of_order: "Movimento mais antigo que outro já recebido.",
  lead_channel_or_attribution_unproven:
    "Lead sem origem de anúncio comprovada; nada foi enviado.",
  lead_destination_unproven:
    "Anúncio do lead sem destino Meta configurado; nada foi enviado.",
  lead_destination_mismatch:
    "Destino Meta do anúncio diferente do canal autorizado; nada foi enviado.",
  pipedrive_production_disabled:
    "Envio automático desativado neste ambiente; mantido apenas como observado.",
  ordering_ambiguous: "Movimentos conflitantes no mesmo instante.",
  rule_value_invalid: "Valor da regra inválido.",
  event_price_missing_or_nonpositive:
    "Valor do negócio ausente ou não positivo para este evento.",
  event_currency_not_configured: "Regra sem moeda configurada.",
  event_currency_mismatch: "Moeda do negócio diferente da moeda da regra.",
  event_currency_unsupported:
    "Negócio em moeda fora de BRL, USD ou EUR: nada foi enviado à Meta.",
  connection_fence_changed:
    "A conexão mudou durante o processamento (credencial ou URL do webhook).",
  attempts_exhausted:
    "Tentativas esgotadas. Não é reprocessado automaticamente.",
  lease_lost: "Processamento interrompido.",
  production_activation_fence:
    "Movimento anterior à ativação do envio automático: mantido apenas como observado.",
  channel_activation_fence:
    "Movimento anterior à autorização do canal: mantido apenas como observado.",
  pipedrive_materialization_incomplete:
    "A conversão não foi registrada por completo; nada foi enviado.",
  pipedrive_semantic_identity_conflict:
    "Conflito de identidade da conversão; nada foi enviado.",
  pipedrive_processing_lease_lost: "Processamento interrompido antes de concluir.",
  pipedrive_delivery_unknown:
    "O resultado do envio à Meta é desconhecido; não será reenviado.",
  publication_authorization_revoked:
    "A autorização de envio foi revogada; nada foi enviado.",
  sender_not_ready: "O canal ainda não está pronto para envio; nada foi enviado.",
  conversion_enqueue_failed:
    "Falha ao enfileirar a conversão; nada foi enviado.",
};

function describeErrorCode(code: string | null): string | null {
  if (!code) return null;
  if (Object.hasOwn(errorCodeText, code)) return errorCodeText[code];
  return errorCodePattern.test(code) ? `Código: ${code}` : "Código desconhecido";
}

/** Reasons the backend marks a connection as needing the operator's action. */
function connectionHealthHint(
  connection: PipedriveConnectionDetailDto,
): string | null {
  if (connection.status === "blocked") {
    return (
      describeErrorCode(connection.lastErrorCode) ??
      "Conexão bloqueada. Substitua a credencial para tentar novamente."
    );
  }
  if (!connection.credentialHealthy) {
    return (
      describeErrorCode(connection.lastErrorCode) ??
      "A credencial não está saudável. Substitua o token da conexão."
    );
  }
  if (connection.catalogState === "error" || connection.catalogState === "stale") {
    return connection.lastErrorCode
      ? describeErrorCode(connection.lastErrorCode)
      : "Atualize o catálogo antes de criar ou revisar regras.";
  }
  return null;
}

function routeOptionsFor(channels: InboundWebhookChannelDto[]): RouteOption[] {
  return crmChannelOptionsFor(channels, pipedriveChannelBindingMessages);
}

function resolveRouteLabels(
  channels: InboundWebhookChannelDto[],
  routeIds: string[],
): string[] {
  const options = routeOptionsFor(channels);
  return routeIds.map(
    (routeId) =>
      options.find((option) => option.routeId === routeId)?.label ??
      "Canal não localizado",
  );
}

function parseMoneyToCents(value: string): number | null {
  const raw = value.trim();
  if (!raw) return null;
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(raw)) {
    return null;
  }

  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);

  return cents > 0 && cents <= MAX_FIXED_VALUE_CENTS ? cents : null;
}

function moneyLabel(valueCents: number | null, currency: string | null): string {
  if (valueCents == null) return "Valor não informado";
  if (!currency || !/^[A-Za-z]{3}$/.test(currency)) {
    return `${(valueCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })} (moeda não informada)`;
  }

  return formatMoney(valueCents, currency);
}

function formatDateTime(value: string | null): string {
  if (!value) return "Nunca";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data indisponível";

  return date.toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: displayTimeZone,
  });
}

function connectionIdentity(connection: PipedriveConnectionDetailDto): string {
  return JSON.stringify([
    connection.workspaceId,
    connection.id,
    connection.verifiedAccountId,
    connection.accountOrigin,
    connection.accountSubdomain,
  ]);
}

function webhookSummary(connection: PipedriveConnectionDetailDto): string | null {
  const webhook = connection.webhook;
  if (!webhook) return null;
  if (!webhook.configured) return "Webhook: URL ainda não gerada";
  return `Webhook (versão ${webhook.version}): URL gerada em ${formatDateTime(webhook.rotatedAt)} / último recebimento: ${formatDateTime(webhook.lastReceivedAt)}`;
}

function ruleValueSummary(rule: PipedriveConversionRuleDto): string {
  if (!conversionEventCarriesValue(rule.eventName)) return "sem valor";
  if (rule.valueMode === "fixed") {
    return `valor fixo ${moneyLabel(rule.fixedValueCents, rule.currency)}`;
  }
  return rule.currency
    ? `valor do negócio em ${rule.currency}`
    : "valor do negócio (sem moeda configurada: segue sem valor)";
}

/**
 * Pipedrive opt-in CRM origin. Every rule defaults to observation (records
 * what WOULD match, sends nothing). Production is an explicit, confirmed
 * opt-in gated by the server capabilities; the UI never reports an event as
 * sent unless the backend delivery status says so.
 */
export function PipedriveConversionPanel({
  unsettledOperations,
  workspaceId,
  connections,
  loadState,
  allChannels,
  canManage,
  licenseLocked = false,
  createConnectionAction,
  replaceCredentialAction,
  setStatusAction,
  setChannelBindingsAction,
  refreshCatalogAction,
  deleteConnectionAction,
  rotateWebhookAction,
  revokeWebhookAction,
  getConnectionAction,
  getCapabilitiesAction,
  listConnectionsAction,
  createRuleAction,
  updateRuleAction,
  deleteRuleAction,
  listEventsAction,
  retryEventAction,
}: PipedriveConversionPanelProps) {
  const router = useRouter();
  const localUnsettled = useRef({ creation: false, connectionIds: new Set<string>() });
  const unsettled = unsettledOperations ?? localUnsettled.current;
  const [connectOpen, setConnectOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [secrets, setSecrets] = useState<Record<string, OneTimeSecret>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [authFailureDetected, setAuthFailureDetected] = useState(false);
  const [serverLicenseLocked, setServerLicenseLocked] = useState(false);
  const [createdConnections, setCreatedConnections] = useState<
    PipedriveConnectionDetailDto[]
  >([]);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [reconciledList, setReconciledList] = useState<
    PipedriveConnectionDetailDto[] | null
  >(null);
  const [creationUnresolved, setCreationUnresolved] = useState(unsettled.creation);
  const creationBlockedRef = useRef(unsettled.creation);
  const serverConnections = reconciledList ?? connections;
  const visibleConnections = [
    ...createdConnections.filter(
      (created) => !serverConnections.some((item) => item.id === created.id),
    ),
    ...serverConnections,
  ].filter((item) => !deletedIds.includes(item.id));

  useEffect(() => {
    setReconciledList(null);
    setCreatedConnections((current) =>
      current.filter((created) => !connections.some((item) => item.id === created.id)),
    );
  }, [connections]);

  const routeOptions = routeOptionsFor(allChannels);
  // A failed/unauthorized load must never be presented as "no connections".
  const loadFailed = loadState === "error" || loadState === "forbidden";
  const locked = licenseLocked || serverLicenseLocked;
  // Panel-wide losses: computed at render time so the secret disappears in the
  // SAME render that detects the loss, not one tick later.
  const secretsMustStayHidden =
    loadFailed || !canManage || authFailureDetected || creationUnresolved;
  const shownSecrets = secretsMustStayHidden
    ? []
    : Object.values(secrets).filter((secret) => {
        if (secret.workspaceId !== workspaceId) return false;
        const live = serverConnections.find((item) => item.id === secret.connectionId)
          ?? createdConnections.find((item) => item.id === secret.connectionId);
        return Boolean(live) &&
          !deletedIds.includes(secret.connectionId) &&
          connectionIdentity(live as PipedriveConnectionDetailDto) === secret.identity;
      });

  useEffect(() => {
    if (secretsMustStayHidden || Object.keys(secrets).length === 0) {
      if (Object.keys(secrets).length > 0) setSecrets({});
      setCopiedId(null);
    }
  }, [secretsMustStayHidden, secrets]);

  function applyResult(result: AnyResult) {
    setNotice({ tone: result.ok ? "success" : "error", message: result.message });
    if (result.licenseLocked) setServerLicenseLocked(true);
    if (result.authFailure === "unauthorized") {
      setAuthFailureDetected(true);
    }
  }

  function showSecret(secret: OneTimeSecret) {
    setSecrets((current) => ({ ...current, [secret.connectionId]: secret }));
    setCopiedId(null);
  }

  function clearSecret(connectionId: string) {
    setSecrets((current) => {
      if (!(connectionId in current)) return current;
      const next = { ...current };
      delete next[connectionId];
      return next;
    });
  }

  async function copyUrl(secret: OneTimeSecret) {
    try {
      await navigator.clipboard.writeText(secret.webhookUrl);
      setCopiedId(secret.connectionId);
    } catch {
      setCopiedId(null);
      setNotice({
        tone: "error",
        message: "Não foi possível copiar automaticamente. Selecione a URL e copie manualmente.",
      });
    }
  }

  async function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || creationBlockedRef.current || !canManage || loadFailed || authFailureDetected || locked) return;

    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = {
      displayName: String(data.get("displayName") ?? "").trim(),
      accountOrigin: String(data.get("accountOrigin") ?? "").trim(),
      apiToken: String(data.get("apiToken") ?? "").trim(),
      allowedChannelRouteIds: data.getAll("allowedChannelRouteIds").map(String),
    };
    const parsed = pipedriveConnectionCreateInputSchema.safeParse(payload);

    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? "");
      const labels: Record<string, string> = {
        displayName: "Nome da conexão (2 a 120 caracteres)",
        accountOrigin: "Origem da conta (https://empresa.pipedrive.com, sem caminho)",
        apiToken: "Token de API (16 a 4096 caracteres)",
      };
      setNotice({
        tone: "error",
        message: labels[field]
          ? `Revise o campo: ${labels[field]}.`
          : "Revise os dados informados e tente novamente.",
      });
      return;
    }

    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("payload", JSON.stringify(parsed.data));

    setPending("connect");
    setNotice(null);
    try {
      const result = await createConnectionAction(formData);
      applyResult(result);

      if (result.ok) {
        form.reset();
        setConnectOpen(false);
        if (result.connection) {
          const created: PipedriveConnectionDetailDto = { ...result.connection, rules: [] };
          setCreatedConnections((current) => [...current, created]);
        }
      } else {
        await reconcileCreation(Boolean(result.outcomeUnknown));
      }
      router.refresh();
    } catch {
      applyResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE });
      await reconcileCreation(true);
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function reconcileCreation(unknownExecution: boolean) {
    // A failed create (e.g. catalog failure after the credential was saved)
    // may have persisted a connection. Never allow a blind second POST until
    // the real list has been read; an unknown outcome stays blocked this mount.
    unsettled.creation = true;
    creationBlockedRef.current = true;
    setCreationUnresolved(true);
    if (!listConnectionsAction) return;
    try {
      const result = await listConnectionsAction(workspaceId);
      if (result.ok) {
        setReconciledList(result.connections);
        if (!unknownExecution) {
          unsettled.creation = false;
          creationBlockedRef.current = false;
          setCreationUnresolved(false);
        }
      } else if (result.reason === "unauthorized") {
        setAuthFailureDetected(true);
      }
    } catch {
      /* Remain blocked; never surface upstream detail. */
    }
  }

  const formDisabled =
    pending === "connect" || creationUnresolved || authFailureDetected || locked;

  return (
    <section className="provider-conversion-panel pipedrive-conversion-panel">
      <header className="provider-conversion-heading">
        <div>
          <span className="eyebrow">Movimentação no CRM</span>
          <h3>Pipedrive CRM</h3>
          <p className="muted">
            Escolha qual etapa do funil (ou o negócio ganho) vira cada evento
            de conversão. Toda regra começa em observação: registra o
            movimento e não envia nada. Com o envio automático (ativado por
            você, com confirmação) o evento segue para a Meta.
          </p>
        </div>
        <div className="provider-conversion-heading-actions">
          {loadFailed || visibleConnections.length > 0 ? (
            <span className="event-chip neutral">
              {loadFailed
                ? "Indisponível"
                : visibleConnections.length === 1
                  ? "1 conexão"
                  : `${visibleConnections.length} conexões`}
            </span>
          ) : null}
          {canManage && !loadFailed ? (
            <button
              className="button"
              type="button"
              onClick={() => setConnectOpen((current) => !current)}
              aria-expanded={connectOpen}
              disabled={locked}
            >
              {connectOpen ? (
                <X size={15} aria-hidden="true" />
              ) : (
                <Plus size={15} aria-hidden="true" />
              )}
              {connectOpen ? "Fechar" : "Nova conexão"}
            </button>
          ) : null}
        </div>
      </header>

      {loadFailed ? (
        <div className="feedback-banner error" role="alert">
          <span>
            {loadState === "forbidden"
              ? "Sua sessão não tem permissão para gerenciar conexões Pipedrive, ou expirou. Atualize a página."
              : "Não foi possível carregar as conexões Pipedrive. Tente novamente."}
          </span>
          <button
            className="button subtle"
            type="button"
            onClick={() => router.refresh()}
          >
            Tentar novamente
          </button>
        </div>
      ) : null}

      {canManage && locked ? (
        <p className="action-note warn" role="status">
          {LICENSE_LOCKED_NOTE}
        </p>
      ) : null}

      {shownSecrets.map((secret) => {
        const owner = visibleConnections.find((item) => item.id === secret.connectionId);
        return (
          <div
            className="provider-conversion-secret-group"
            key={secret.connectionId}
          >
            <div
              className="provider-conversion-secret"
              data-presentation-sensitive-action="true"
            >
              <div>
                <span className="micro-label">URL exibida uma única vez</span>
                <strong>Webhook Pipedrive{owner ? ` - ${owner.displayName}` : ""}</strong>
              </div>
              <input
                readOnly
                value={secret.webhookUrl}
                aria-label={`URL do webhook Pipedrive${owner ? ` de ${owner.displayName}` : ""}`}
                data-presentation-sensitive-field="true"
              />
              <button className="button" type="button" onClick={() => void copyUrl(secret)}>
                {copiedId === secret.connectionId ? (
                  <Check size={15} aria-hidden="true" />
                ) : (
                  <Copy size={15} aria-hidden="true" />
                )}
                {copiedId === secret.connectionId ? "Copiada" : "Copiar URL"}
              </button>
              <button
                className="icon-button"
                type="button"
                title="Ocultar"
                aria-label="Ocultar URL"
                onClick={() => clearSecret(secret.connectionId)}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>
            <p className="action-note">
              Gerada em {formatDateTime(secret.rotatedAt)}. Na Pipedrive, em
              Webhooks, crie um webhook para negócio alterado (objeto: deal,
              ação: change) e cole essa URL completa; a autenticação já está na
              URL. Ela
              não é guardada nem exibida de novo: se perder, gere outra (a
              anterior deixa de funcionar).
            </p>
          </div>
        );
      })}

      {notice ? (
        <div
          className={`feedback-banner ${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <span>{notice.message}</span>
        </div>
      ) : null}

      {authFailureDetected ? (
        <p className="action-note" role="status">
          Sua sessão não é mais válida. Atualize a página para continuar; URLs de
          webhook exibidas foram ocultadas.
        </p>
      ) : null}

      {creationUnresolved ? (
        <p className="action-note" role="status">
          Resultado da criação não confirmado. Uma nova tentativa fica bloqueada
          para evitar conexões duplicadas; confira a lista e atualize a página.
        </p>
      ) : null}

      {connectOpen && canManage && !loadFailed ? (
        <form className="provider-conversion-builder" onSubmit={handleConnect}>
          <div className="provider-conversion-base-fields">
            <label>
              <span className="field-label">Nome da conexão</span>
              <input
                name="displayName"
                minLength={2}
                maxLength={120}
                placeholder="Ex.: Pipedrive principal"
                disabled={formDisabled}
                required
              />
            </label>
            <label>
              <span className="field-label">Origem da conta Pipedrive</span>
              <input
                name="accountOrigin"
                placeholder="https://suaempresa.pipedrive.com"
                disabled={formDisabled}
                required
              />
            </label>
            <label>
              <span className="field-label">Token de API</span>
              <input
                name="apiToken"
                type="password"
                autoComplete="off"
                minLength={16}
                placeholder="Token pessoal de API do Pipedrive"
                disabled={formDisabled}
                required
              />
            </label>
          </div>

          <RouteSelector
            name="allowedChannelRouteIds"
            options={routeOptions}
            disabled={formDisabled}
          />

          <p className="action-note">
            O token fica apenas no servidor e nunca é reexibido. Depois de
            conectar, gere a URL do webhook no cartão da conexão.
          </p>

          <div className="provider-conversion-builder-footer">
            <button className="button primary" type="submit" disabled={formDisabled}>
              <Check size={15} aria-hidden="true" />
              {pending === "connect" ? "Conectando..." : "Conectar Pipedrive"}
            </button>
          </div>
        </form>
      ) : null}

      {loadFailed ? null : visibleConnections.length === 0 ? (
        <div className="provider-conversion-empty">
          <Database size={18} aria-hidden="true" />
          <span>
            Nenhuma conexão Pipedrive. Conecte uma conta para configurar regras
            por etapa do funil.
          </span>
        </div>
      ) : (
        <div className="provider-conversion-rule-list">
          {visibleConnections.map((connection) => (
            <PipedriveConnectionCard
              key={connection.id}
              unsettledOperations={unsettled}
              locallyCreated={createdConnections.some((created) => created.id === connection.id)}
              workspaceId={workspaceId}
              connection={connection}
              routeOptions={routeOptions}
              allChannels={allChannels}
              canManage={canManage}
              licenseLocked={locked}
              pending={pending}
              setPending={setPending}
              onResult={applyResult}
              onShowSecret={showSecret}
              onClearSecret={clearSecret}
              onDeleted={(id) => {
                setDeletedIds((current) => [...current, id]);
                clearSecret(id);
              }}
              onRefresh={() => router.refresh()}
              replaceCredentialAction={replaceCredentialAction}
              setStatusAction={setStatusAction}
              setChannelBindingsAction={setChannelBindingsAction}
              refreshCatalogAction={refreshCatalogAction}
              deleteConnectionAction={deleteConnectionAction}
              rotateWebhookAction={rotateWebhookAction}
              revokeWebhookAction={revokeWebhookAction}
              getConnectionAction={getConnectionAction}
              getCapabilitiesAction={getCapabilitiesAction}
              createRuleAction={createRuleAction}
              updateRuleAction={updateRuleAction}
              deleteRuleAction={deleteRuleAction}
              listEventsAction={listEventsAction}
              retryEventAction={retryEventAction}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RouteSelector({
  name,
  options,
  selected,
  onToggle,
  disabled,
}: {
  name: string;
  options: RouteOption[];
  selected?: string[];
  onToggle?: (routeId: string) => void;
  disabled?: boolean;
}) {
  const controlled = selected !== undefined && onToggle !== undefined;
  // A saved route can vanish from the workspace channels entirely; it must
  // stay explicitly removable instead of being silently resent.
  const missingSelectedIds = controlled
    ? selected!.filter(
        (routeId) => !options.some((option) => option.routeId === routeId),
      )
    : [];

  return (
    <fieldset className="provider-conversion-channels">
      <legend className="field-label">Canais autorizados</legend>
      {options.length === 0 && missingSelectedIds.length === 0 ? (
        <small className="action-note">
          Nenhum número de WhatsApp foi encontrado neste workspace ainda.
        </small>
      ) : (
        <div>
          {options.map((option) => {
            const isSelected = controlled ? selected!.includes(option.routeId) : false;
            const isDisabled = disabled || (!option.eligible && !isSelected);

            return (
              <label key={option.routeId} title={option.statusDetail}>
                <input
                  type="checkbox"
                  name={controlled ? undefined : name}
                  value={option.routeId}
                  disabled={isDisabled}
                  {...(controlled
                    ? {
                        checked: isSelected,
                        onChange: () => onToggle!(option.routeId),
                      }
                    : { defaultChecked: option.preselect })}
                />
                <span>
                  <PresentationMask placeholder="Canal oculto">
                    {option.label}
                  </PresentationMask>
                  {!option.eligible ? " (indisponível)" : ""}
                  {!option.eligible && option.reason ? (
                    <small className="action-note"> {option.reason}</small>
                  ) : null}
                </span>
              </label>
            );
          })}
          {missingSelectedIds.map((routeId) => (
            <label
              key={routeId}
              title="Canal ou rota não encontrado nos canais do workspace"
            >
              <input
                type="checkbox"
                checked
                disabled={disabled}
                onChange={() => onToggle!(routeId)}
              />
              <span>Canal removido (indisponível)</span>
            </label>
          ))}
        </div>
      )}
      <small className="action-note">
        O Pipedrive é apenas o CRM: escolha quais números de WhatsApp deste
        workspace (de qualquer provedor) podem ter seus leads associados por
        telefone. O número precisa estar ativo e com destino Meta
        verificado. Sem número autorizado, nenhum movimento é associado.
      </small>
    </fieldset>
  );
}

function PipedriveConnectionCard({
  locallyCreated,
  unsettledOperations,
  workspaceId,
  connection,
  routeOptions,
  allChannels,
  canManage,
  licenseLocked,
  pending,
  setPending,
  onResult,
  onShowSecret,
  onClearSecret,
  onDeleted,
  onRefresh,
  replaceCredentialAction,
  setStatusAction,
  setChannelBindingsAction,
  refreshCatalogAction,
  deleteConnectionAction,
  rotateWebhookAction,
  revokeWebhookAction,
  getConnectionAction,
  getCapabilitiesAction,
  createRuleAction,
  updateRuleAction,
  deleteRuleAction,
  listEventsAction,
  retryEventAction,
}: {
  locallyCreated: boolean;
  unsettledOperations: { creation: boolean; connectionIds: Set<string> };
  workspaceId: string;
  connection: PipedriveConnectionDetailDto;
  routeOptions: RouteOption[];
  allChannels: InboundWebhookChannelDto[];
  canManage: boolean;
  licenseLocked: boolean;
  pending: string | null;
  setPending: (value: string | null) => void;
  onResult: (result: AnyResult) => void;
  onShowSecret: (secret: OneTimeSecret) => void;
  onClearSecret: (connectionId: string) => void;
  onDeleted: (connectionId: string) => void;
  onRefresh: () => void;
  replaceCredentialAction: ConnectionAction;
  setStatusAction: ConnectionAction;
  setChannelBindingsAction: ConnectionAction;
  refreshCatalogAction: ConnectionAction;
  deleteConnectionAction: ConnectionAction;
  rotateWebhookAction: ConnectionAction;
  revokeWebhookAction: ConnectionAction;
  getConnectionAction: GetConnectionAction;
  getCapabilitiesAction: GetCapabilitiesAction;
  createRuleAction: RuleAction;
  updateRuleAction: RuleAction;
  deleteRuleAction: RuleAction;
  listEventsAction: ListEventsAction;
  retryEventAction: RetryEventAction;
}) {
  // Local operation/read epochs order client requests only. Connection
  // updatedAt does not version rules, so props after a local write are a
  // signal for an explicit scoped read, never proof of aggregate freshness.
  const [canonical, setCanonical] = useState(connection);
  const canonicalRef = useRef(connection);
  const [certainty, setCertainty] = useState<"confirmed" | "uncertain">("confirmed");
  const epochRef = useRef(locallyCreated ? 1 : 0);
  const readEpochRef = useRef(0);
  const retiredSnapshots = useRef(new Set<string>());
  const retiredIdentities = useRef(new Set<string>());
  const queuedProp = useRef<PipedriveConnectionDetailDto | null>(null);
  const [operationUnsettled, setOperationUnsettled] = useState(
    unsettledOperations.connectionIds.has(connection.id),
  );
  const operationUnsettledRef = useRef(
    unsettledOperations.connectionIds.has(connection.id),
  );

  function reportResult(result: AnyResult) {
    if (result.outcomeUnknown) {
      // The request may still be running or already committed: lock this
      // connection's mutations (also across close/reopen) and hide the secret.
      unsettledOperations.connectionIds.add(connection.id);
      operationUnsettledRef.current = true;
      setOperationUnsettled(true);
      onClearSecret(connection.id);
    }
    onResult(result);
  }

  function retireCurrent(next: PipedriveConnectionDetailDto) {
    if (JSON.stringify(next) !== JSON.stringify(canonicalRef.current)) {
      retiredSnapshots.current.add(JSON.stringify(canonicalRef.current));
    }
    if (connectionIdentity(next) !== connectionIdentity(canonicalRef.current)) {
      retiredIdentities.current.add(connectionIdentity(canonicalRef.current));
    }
  }

  function adoptCanonical(next: PipedriveConnectionDetailDto, confirmed = true) {
    retireCurrent(next);
    const identityChanged =
      connectionIdentity(next) !== connectionIdentity(canonicalRef.current);
    canonicalRef.current = next;
    setCanonical(next);
    setEditedRouteIds(next.allowedChannelRouteIds);
    setCertainty(confirmed && !queuedProp.current ? "confirmed" : "uncertain");
    if (identityChanged) onClearSecret(next.id);
  }

  /**
   * Connection-level mutations return connection + catalog but never rules.
   * Rules are carried over; if the verified account/origin changed (the
   * backend clears bindings and deactivates rules then), the aggregate is
   * re-read instead of trusting the carried rules.
   */
  async function consumeSnapshot(
    snapshot: PipedriveConnectionSnapshotDto,
    myEpoch: number,
  ) {
    const next: PipedriveConnectionDetailDto = {
      ...snapshot,
      rules: canonicalRef.current.rules,
    };
    const identityChanged =
      connectionIdentity(next) !== connectionIdentity(canonicalRef.current);
    adoptCanonical(next, !identityChanged);
    if (identityChanged) await reconcileFromServer(myEpoch);
  }

  function bumpEpoch(): number {
    epochRef.current += 1;
    return epochRef.current;
  }

  function mergeRuleIntoCanonical(rule: PipedriveConversionRuleDto) {
    retiredSnapshots.current.add(JSON.stringify(canonicalRef.current));
    canonicalRef.current = {
      ...canonicalRef.current,
      rules: canonicalRef.current.rules.some((item) => item.id === rule.id)
        ? canonicalRef.current.rules.map((item) => (item.id === rule.id ? rule : item))
        : [...canonicalRef.current.rules, rule],
    };
    setCanonical(canonicalRef.current);
    setCertainty(queuedProp.current ? "uncertain" : "confirmed");
  }

  function removeRuleFromCanonical(ruleId: string) {
    retiredSnapshots.current.add(JSON.stringify(canonicalRef.current));
    canonicalRef.current = {
      ...canonicalRef.current,
      rules: canonicalRef.current.rules.filter((item) => item.id !== ruleId),
    };
    setCanonical(canonicalRef.current);
    setCertainty(queuedProp.current ? "uncertain" : "confirmed");
  }

  const seenPropFingerprints = useRef(new Set([JSON.stringify(connection)]));
  useEffect(() => {
    const fingerprint = JSON.stringify(connection);
    if (!seenPropFingerprints.current.has(fingerprint)) {
      seenPropFingerprints.current.add(fingerprint);
      if (epochRef.current === 0) {
        adoptCanonical(connection);
        return;
      }
      // Novel content is not necessarily newer: keep it provisional and let an
      // explicit read decide. A same-identity refresh never hides the secret.
      if (connectionIdentity(connection) !== connectionIdentity(canonicalRef.current)) {
        onClearSecret(connection.id);
      }
      if (
        connection.updatedAt >= canonicalRef.current.updatedAt &&
        !retiredSnapshots.current.has(fingerprint) &&
        (!retiredIdentities.current.has(connectionIdentity(connection)) ||
          connection.updatedAt > canonicalRef.current.updatedAt)
      ) {
        queuedProp.current = connection;
      }
    }
    if (!pending && queuedProp.current) {
      const next = queuedProp.current;
      queuedProp.current = null;
      adoptCanonical(next, false);
      epochRef.current += 1;
      void reconcileFromServer(epochRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, pending]);

  async function reconcileFromServer(myEpoch: number) {
    const myReadEpoch = ++readEpochRef.current;
    if (epochRef.current === myEpoch) setCertainty("uncertain");
    let result;
    try {
      result = await getConnectionAction(workspaceId, canonicalRef.current.id);
    } catch {
      if (epochRef.current === myEpoch && readEpochRef.current === myReadEpoch) {
        setCertainty("uncertain");
      }
      return;
    }
    // A newer local operation or read owns the truth now; this response is
    // out-of-order and is discarded outright.
    if (epochRef.current !== myEpoch || readEpochRef.current !== myReadEpoch) return;
    if (result.ok) {
      const known = canonicalRef.current;
      const olderRevision =
        result.connection.mutationRevision !== undefined &&
        known.mutationRevision !== undefined &&
        result.connection.mutationRevision < known.mutationRevision;
      if (
        olderRevision ||
        result.connection.updatedAt < known.updatedAt ||
        (JSON.stringify(result.connection) !== JSON.stringify(known) &&
          retiredSnapshots.current.has(JSON.stringify(result.connection))) ||
        (connectionIdentity(result.connection) !== connectionIdentity(known) &&
          retiredIdentities.current.has(connectionIdentity(result.connection)) &&
          result.connection.updatedAt <= known.updatedAt)
      ) {
        return;
      }
      adoptCanonical(result.connection);
    } else if (result.reason === "not_found") {
      // A scoped 404 is proof of absence: the unknown operation (e.g. a lost
      // delete) is settled and nothing remains to lock.
      const absentId = canonicalRef.current.id;
      unsettledOperations.connectionIds.delete(absentId);
      operationUnsettledRef.current = false;
      setOperationUnsettled(false);
      onResult({
        ok: true,
        message: "Confirmado: esta conexão não existe mais no servidor.",
      });
      onDeleted(absentId);
      onRefresh();
    } else {
      setCertainty("uncertain");
      if (result.reason === "unauthorized") {
        reportResult({ ok: false, message: SESSION_MESSAGE, authFailure: "unauthorized" });
      } else if (result.reason === "inconsistent") {
        onResult({
          ok: false,
          message:
            "A conexão mudou durante a leitura e o estado não pode ser confirmado agora. Tente confirmar de novo.",
        });
      }
    }
  }

  const [credentialOpen, setCredentialOpen] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [createRuleOpen, setCreateRuleOpen] = useState(false);
  const [editedRouteIds, setEditedRouteIds] = useState<string[]>(
    connection.allowedChannelRouteIds,
  );
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const credentialFormRef = useRef<HTMLFormElement>(null);
  const [capsState, setCapsState] = useState<{
    identity: string;
    view: CapabilitiesView;
  }>({ identity: "", view: { phase: "idle" } });
  const capsSeq = useRef(0);
  const [productionDraft, setProductionDraft] = useState<{
    payload: Record<string, unknown>;
    identity: string;
    revision: number | null;
  } | null>(null);

  const capsView: CapabilitiesView =
    capsState.identity === connectionIdentity(canonical)
      ? capsState.view
      : { phase: "idle" };

  /** Environment gates only, re-read every time a production confirm opens. */
  async function loadCapabilities() {
    const seq = ++capsSeq.current;
    const identity = connectionIdentity(canonicalRef.current);
    const connectionId = canonicalRef.current.id;
    setCapsState({ identity, view: { phase: "loading" } });
    const finish = (view: CapabilitiesView) => {
      if (seq === capsSeq.current) setCapsState({ identity, view });
    };
    try {
      const result = await getCapabilitiesAction(workspaceId, connectionId);
      if (result.ok) {
        finish({ phase: "ready", capabilities: result.capabilities });
      } else if (result.reason === "unauthorized") {
        finish({ phase: "unauthorized" });
        if (seq === capsSeq.current) {
          reportResult({ ok: false, message: SESSION_MESSAGE, authFailure: "unauthorized" });
        }
      } else if (result.reason === "missing") {
        finish({ phase: "missing" });
      } else {
        finish({ phase: "unavailable" });
        if (result.reason === "not_found" && seq === capsSeq.current) {
          await reconcileFromServer(epochRef.current);
        }
      }
    } catch {
      finish({ phase: "unavailable" });
    }
  }

  const readiness = readinessFor(canonical, capsView);

  const refreshKey = `refresh-${canonical.id}`;
  const statusKey = `status-${canonical.id}`;
  const rotateKey = `rotate-${canonical.id}`;
  const revokeKey = `revoke-${canonical.id}`;
  const deleteKey = `delete-${canonical.id}`;
  const credentialKey = `credential-${canonical.id}`;
  const channelsKey = `channels-${canonical.id}`;
  const createRuleKey = `create-rule-${canonical.id}`;
  const createProductionKey = `create-production-${canonical.id}`;

  const pipelines = canonical.pipelines;
  const stateUnresolved = certainty === "uncertain";
  const canActivate = canonical.credentialHealthy && Boolean(canonical.verifiedAccountId);
  const blocked = canonical.status === "blocked";
  const healthHint = connectionHealthHint(canonical);

  function baseFormData(): FormData {
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("connectionId", canonicalRef.current.id);
    return formData;
  }

  async function runConnectionMutation(
    key: string,
    action: ConnectionAction,
    formData: FormData,
    afterOk?: () => void,
  ) {
    if (pending || operationUnsettledRef.current || licenseLockedRef.current) return;
    const myEpoch = bumpEpoch();

    setConfirmingKey(null);
    setPending(key);
    // The write may commit and then lose its response: a reported failure is
    // never proof of rollback, so state is inconclusive until read.
    setCertainty("uncertain");
    try {
      const result = await action(formData);
      reportResult(result);
      if (result.ok) afterOk?.();
      if (epochRef.current !== myEpoch) return;
      if (result.ok && result.connection) {
        await consumeSnapshot(result.connection, myEpoch);
      } else {
        await reconcileFromServer(myEpoch);
      }
    } catch {
      reportResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE, outcomeUnknown: true });
      if (epochRef.current === myEpoch) await reconcileFromServer(myEpoch);
    } finally {
      setPending(null);
    }
  }

  async function refreshCatalog() {
    await runConnectionMutation(refreshKey, refreshCatalogAction, baseFormData());
  }

  async function runStatusChange(status: "active" | "paused") {
    if (stateUnresolved) return;
    const formData = baseFormData();
    formData.set("status", status);
    await runConnectionMutation(statusKey, setStatusAction, formData);
  }

  function toggleStatus() {
    if (pending || operationUnsettledRef.current || licenseLockedRef.current || stateUnresolved || blocked) return;
    if (canonical.status === "active") {
      setConfirmingKey(statusKey);
      return;
    }
    void runStatusChange("active");
  }

  async function rotateWebhook() {
    if (pending || operationUnsettledRef.current || licenseLockedRef.current) return;
    const identityAtStart = connectionIdentity(canonicalRef.current);
    const myEpoch = bumpEpoch();
    setConfirmingKey(null);
    // The previous URL dies the moment rotation commits server-side, so it
    // must never keep looking current while this request is in flight.
    onClearSecret(canonicalRef.current.id);
    setPending(rotateKey);
    try {
      const result = await rotateWebhookAction(baseFormData());
      reportResult(result);
      if (
        result.ok &&
        result.oneTimeWebhook &&
        connectionIdentity(canonicalRef.current) === identityAtStart
      ) {
        onShowSecret({
          workspaceId,
          connectionId: canonicalRef.current.id,
          identity: identityAtStart,
          webhookUrl: result.oneTimeWebhook.webhookUrl,
          rotatedAt: result.oneTimeWebhook.rotatedAt,
        });
      }
      // Webhook metadata (version, rotation time) changed server-side: re-read
      // it. The read never touches the one-time URL held in memory, and it must
      // not hold the card busy: a newer operation supersedes it via the epoch.
      if (epochRef.current === myEpoch && !result.outcomeUnknown) {
        void reconcileFromServer(myEpoch);
      }
    } catch {
      reportResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE, outcomeUnknown: true });
    } finally {
      setPending(null);
    }
  }

  async function revokeWebhook() {
    if (pending || operationUnsettledRef.current || licenseLockedRef.current) return;
    const myEpoch = bumpEpoch();
    setConfirmingKey(null);
    onClearSecret(canonicalRef.current.id);
    setPending(revokeKey);
    try {
      const result = await revokeWebhookAction(baseFormData());
      reportResult(result);
      if (epochRef.current === myEpoch && !result.outcomeUnknown) {
        void reconcileFromServer(myEpoch);
      }
    } catch {
      reportResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE, outcomeUnknown: true });
    } finally {
      setPending(null);
    }
  }

  async function deleteConnection() {
    if (pending || operationUnsettledRef.current || licenseLockedRef.current) return;
    const myEpoch = bumpEpoch();
    setConfirmingKey(null);
    setPending(deleteKey);
    try {
      const result = await deleteConnectionAction(baseFormData());
      reportResult(result);
      if (result.ok && result.deleted) {
        onDeleted(canonicalRef.current.id);
        onRefresh();
      } else if (result.outcomeUnknown && epochRef.current === myEpoch) {
        await reconcileFromServer(myEpoch);
      }
    } catch {
      reportResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE, outcomeUnknown: true });
      onRefresh();
    } finally {
      setPending(null);
    }
  }

  function handleCredentialSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || operationUnsettledRef.current || licenseLockedRef.current) return;

    const data = new FormData(event.currentTarget);
    const accountOrigin = String(data.get("accountOrigin") ?? "").trim();
    const apiToken = String(data.get("apiToken") ?? "").trim();

    if (apiToken.length < 16) {
      onResult({ ok: false, message: "Informe o novo token de API (mínimo 16 caracteres)." });
      return;
    }

    const formData = baseFormData();
    formData.set(
      "payload",
      JSON.stringify({ apiToken, ...(accountOrigin ? { accountOrigin } : {}) }),
    );
    void runConnectionMutation(credentialKey, replaceCredentialAction, formData, () => {
      credentialFormRef.current?.reset();
      setCredentialOpen(false);
    });
  }

  async function saveChannelBindings() {
    if (stateUnresolved) return;
    const formData = baseFormData();
    formData.set("payload", JSON.stringify({ allowedChannelRouteIds: editedRouteIds }));
    await runConnectionMutation(channelsKey, setChannelBindingsAction, formData, () =>
      setChannelsOpen(false),
    );
  }

  async function submitCreateRule(payload: Record<string, unknown>) {
    if (!canManage || pending || operationUnsettledRef.current || licenseLockedRef.current || stateUnresolved) return;
    const myEpoch = bumpEpoch();
    const formData = baseFormData();
    formData.set("payload", JSON.stringify(payload));

    setConfirmingKey(null);
    setProductionDraft(null);
    setPending(createRuleKey);
    setCertainty("uncertain");
    try {
      const result = await createRuleAction(formData);
      reportResult(result);
      if (epochRef.current !== myEpoch) return;
      if (result.ok && result.rule) {
        setCreateRuleOpen(false);
        mergeRuleIntoCanonical(result.rule);
      } else {
        await reconcileFromServer(myEpoch);
      }
    } catch {
      reportResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE, outcomeUnknown: true });
      if (epochRef.current === myEpoch) await reconcileFromServer(myEpoch);
    } finally {
      setPending(null);
    }
  }

  function handleCreateRuleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || pending || operationUnsettledRef.current || licenseLockedRef.current || stateUnresolved) return;

    const built = buildRulePayload(new FormData(event.currentTarget), { isUpdate: false });
    if (!built.ok) {
      onResult({ ok: false, message: built.message });
      return;
    }
    const validation = validateMergedRuleCandidate(undefined, built.payload);
    if (!validation.ok) {
      onResult({ ok: false, message: validation.message });
      return;
    }
    if (built.payload.mode === "production") {
      // Production is never sent from a plain submit: review and confirm first.
      setProductionDraft({
        payload: built.payload,
        identity: connectionIdentity(canonicalRef.current),
        revision: canonicalRef.current.mutationRevision ?? null,
      });
      setConfirmingKey(createProductionKey);
      void loadCapabilities();
      return;
    }
    void submitCreateRule(built.payload);
  }

  const authorizedLabels = resolveRouteLabels(allChannels, canonical.allowedChannelRouteIds);
  const unsettledLock = operationUnsettled;
  // A request without final answer or a license lock both stop every write.
  const locked = unsettledLock || licenseLocked;
  const licenseLockedRef = useRef(licenseLocked);
  licenseLockedRef.current = licenseLocked;
  const productionActiveCount = canonical.rules.filter(
    (rule) => rule.mode === "production" && rule.active,
  ).length;
  const webhookLine = webhookSummary(canonical);
  const draftStale =
    productionDraft !== null &&
    (productionDraft.identity !== connectionIdentity(canonical) ||
      productionDraft.revision !== (canonical.mutationRevision ?? null));

  return (
    <article className="provider-conversion-rule pipedrive-connection-card">
      <div className="provider-conversion-rule-main">
        <div className="provider-conversion-rule-icon">
          <Database size={17} aria-hidden="true" />
        </div>
        <div className="provider-conversion-rule-copy">
          <div className="provider-conversion-rule-title pipedrive-title-row">
            <strong>{canonical.displayName}</strong>
            <span className={`event-chip ${connectionStatusTone(canonical.status)}`}>
              {connectionStatusLabel(canonical.status)}
            </span>
            <span
              className={`event-chip ${stateUnresolved ? "warn" : catalogStateTone(canonical.catalogState)}`}
            >
              {stateUnresolved
                ? "Estado não confirmado"
                : unsettledLock
                  ? "Estado lido; ação não concluída"
                  : catalogStateLabel(canonical.catalogState)}
            </span>
            <span
              className={`event-chip ${productionActiveCount > 0 ? "success" : "neutral"}`}
            >
              {productionActiveCount > 0
                ? `Envio automático em ${productionActiveCount} regra(s)`
                : "Observação (padrão)"}
            </span>
            {!canonical.credentialHealthy ? (
              <span className="event-chip warn">Credencial inválida</span>
            ) : null}
          </div>
          <span>
            {canonical.accountSubdomain
              ? `Subdomínio verificado: ${canonical.accountSubdomain}`
              : "Conta ainda não verificada"}
          </span>
          <small>
            Catálogo atualizado em {formatDateTime(canonical.catalogRefreshedAt)}
          </small>
          {webhookLine ? <small>{webhookLine}</small> : null}
          {canonical.mutationRevision !== undefined ? (
            <small>
              Versão {canonical.mutationRevision} da configuração
              {canonical.revisionFenced === false
                ? " (pode estar desatualizada; atualize a página)"
                : ""}
            </small>
          ) : null}
        </div>
      </div>

      {healthHint ? (
        <p className="action-note" role="status">
          {healthHint}
        </p>
      ) : null}

      {canManage ? (
        <div className="provider-conversion-rule-actions">
          <button
            className="icon-button"
            type="button"
            title={canonical.status === "active" ? "Pausar conexão" : "Retomar conexão"}
            aria-label={
              canonical.status === "active"
                ? `Pausar conexão ${canonical.displayName}`
                : `Retomar conexão ${canonical.displayName}`
            }
            disabled={
              Boolean(pending) || locked || stateUnresolved || blocked ||
              (canonical.status === "paused" && !canActivate)
            }
            onClick={toggleStatus}
          >
            {canonical.status === "active" ? (
              <Pause size={15} aria-hidden="true" />
            ) : (
              <Play size={15} aria-hidden="true" />
            )}
          </button>
          <button
            className="icon-button"
            type="button"
            title="Atualizar catálogo"
            aria-label={`Atualizar catálogo de ${canonical.displayName}`}
            disabled={Boolean(pending) || locked}
            onClick={() => void refreshCatalog()}
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          <button
            className="icon-button"
            type="button"
            title="Gerar URL do webhook"
            aria-label={`Gerar URL do webhook de ${canonical.displayName}`}
            disabled={Boolean(pending) || locked}
            onClick={() => setConfirmingKey(rotateKey)}
          >
            <KeyRound size={15} aria-hidden="true" />
          </button>
          <button
            className="icon-button danger"
            type="button"
            title="Remover conexão"
            aria-label={`Remover conexão ${canonical.displayName}`}
            disabled={Boolean(pending) || locked}
            onClick={() => setConfirmingKey(deleteKey)}
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {canManage && canonical.status === "paused" && !canActivate ? (
        <p className="action-note">
          Retome apenas depois de substituir a credencial: a conta ainda não foi
          verificada ou a credencial atual está inválida.
        </p>
      ) : null}

      {canManage && blocked ? (
        <p className="action-note">
          Conexão bloqueada: substitua a credencial para voltar a operar.
        </p>
      ) : null}

      {canManage && (stateUnresolved || unsettledLock) ? (
        <button
          className="button subtle"
          type="button"
          disabled={Boolean(pending)}
          onClick={async () => {
            if (pending) return;
            setPending(`read-${canonical.id}`);
            try {
              await reconcileFromServer(bumpEpoch());
            } finally {
              setPending(null);
            }
          }}
        >
          Confirmar estado atual
        </button>
      ) : null}

      {unsettledLock ? (
        <p className="action-note" role="status">
          Requisição sem resposta final. O estado lido pode mudar; novas
          alterações ficam bloqueadas para evitar repetir uma ação ainda em
          andamento. Atualize a página para destravar depois de conferir.
        </p>
      ) : null}

      {canManage && stateUnresolved && !unsettledLock ? (
        <p className="action-note" role="status">
          Não foi possível confirmar o estado atual desta conexão após a última
          ação. Edições ficam bloqueadas até confirmar.
        </p>
      ) : null}

      {canManage && confirmingKey === statusKey ? (
        <InlineConfirm
          message="Pausar a conexão Pipedrive? Novos movimentos de etapa deixam de ser processados (observados ou enviados) até retomar."
          confirmLabel="Pausar conexão"
          tone="danger"
          disabled={Boolean(pending) || locked}
          onCancel={() => setConfirmingKey(null)}
          onConfirm={() => void runStatusChange("paused")}
        />
      ) : null}

      {canManage && confirmingKey === rotateKey ? (
        <InlineConfirm
          message="Gerar uma nova URL de webhook invalida qualquer URL anterior desta conexão: o Pipedrive para de ser aceito até você colar a nova. A URL aparece uma única vez."
          confirmLabel="Gerar nova URL"
          tone="primary"
          disabled={Boolean(pending) || locked}
          onCancel={() => setConfirmingKey(null)}
          onConfirm={() => void rotateWebhook()}
          extra={
            <button
              className="button subtle"
              type="button"
              disabled={Boolean(pending) || locked}
              onClick={() => setConfirmingKey(revokeKey)}
            >
              Revogar URL atual
            </button>
          }
        />
      ) : null}

      {canManage && confirmingKey === revokeKey ? (
        <InlineConfirm
          message="Revogar a URL do webhook? O Pipedrive deixa de ser aceito até gerar uma nova URL."
          confirmLabel="Revogar URL"
          tone="danger"
          disabled={Boolean(pending) || locked}
          onCancel={() => setConfirmingKey(null)}
          onConfirm={() => void revokeWebhook()}
        />
      ) : null}

      {canManage && confirmingKey === deleteKey ? (
        <InlineConfirm
          message="Remover esta conexão? Credencial, catálogo, regras e URL de webhook deixam de existir. Conexões que já têm eventos auditados não podem ser removidas: pause-as."
          confirmLabel="Remover conexão"
          tone="danger"
          disabled={Boolean(pending) || locked}
          onCancel={() => setConfirmingKey(null)}
          onConfirm={() => void deleteConnection()}
        />
      ) : null}

      <details
        className="provider-conversion-rule-scope"
        open={channelsOpen}
        onToggle={(event) => setChannelsOpen(event.currentTarget.open)}
      >
        <summary>
          <span>Canais autorizados</span>
          <strong>
            {authorizedLabels.length > 0
              ? authorizedLabels.join(", ")
              : "Nenhum canal autorizado"}
          </strong>
        </summary>
        {canManage ? (
          <>
            <RouteSelector
              name="allowedChannelRouteIds"
              options={routeOptions}
              selected={editedRouteIds}
              onToggle={(routeId) =>
                setEditedRouteIds((current) =>
                  current.includes(routeId)
                    ? current.filter((id) => id !== routeId)
                    : [...current, routeId],
                )
              }
              disabled={pending === channelsKey || stateUnresolved || locked}
            />
            <div className="provider-conversion-builder-footer">
              {stateUnresolved ? (
                <small className="action-note">
                  Estado não confirmado após a última ação; confirme o estado
                  antes de salvar canais.
                </small>
              ) : null}
              <button
                className="button primary"
                type="button"
                disabled={pending === channelsKey || stateUnresolved || locked}
                onClick={() => void saveChannelBindings()}
              >
                <Check size={15} aria-hidden="true" />
                {pending === channelsKey ? "Salvando..." : "Salvar canais"}
              </button>
            </div>
          </>
        ) : null}
      </details>

      {canManage ? (
        <details
          className="provider-conversion-rule-scope"
          open={credentialOpen}
          onToggle={(event) => setCredentialOpen(event.currentTarget.open)}
        >
          <summary>
            <span>Substituir credenciais</span>
            <strong>
              <Pencil size={13} aria-hidden="true" /> Token de API
            </strong>
          </summary>
          <form
            className="provider-conversion-builder"
            ref={credentialFormRef}
            onSubmit={handleCredentialSubmit}
          >
            <p className="action-note">
              O token atual nunca é reexibido. Informe um novo token para
              substituir a credencial; a origem só precisa ser preenchida se
              mudou. Trocar de conta apaga catálogo, canais e desativa as
              regras.
            </p>
            <div className="provider-conversion-base-fields">
              <label>
                <span className="field-label">Nova origem (opcional)</span>
                <input
                  name="accountOrigin"
                  placeholder="https://suaempresa.pipedrive.com"
                  disabled={pending === credentialKey || locked}
                />
              </label>
              <label>
                <span className="field-label">Novo token de API</span>
                <input
                  name="apiToken"
                  type="password"
                  autoComplete="off"
                  minLength={16}
                  disabled={pending === credentialKey || locked}
                  required
                />
              </label>
            </div>
            <div className="provider-conversion-builder-footer">
              <button
                className="button primary"
                type="submit"
                disabled={pending === credentialKey || locked}
              >
                <Check size={15} aria-hidden="true" />
                {pending === credentialKey ? "Salvando..." : "Substituir token"}
              </button>
            </div>
          </form>
        </details>
      ) : null}

      <div className="provider-conversion-rule-list">
        {canManage ? (
          <div className="provider-conversion-heading-actions">
            {pipelines.length === 0 ? (
              <small className="action-note">
                Atualize o catálogo para carregar pipelines e etapas antes de
                criar uma regra.
              </small>
            ) : (
              <button
                className="button subtle"
                type="button"
                onClick={() => {
                  setCreateRuleOpen((current) => !current);
                  setProductionDraft(null);
                  setConfirmingKey((key) => (key === createProductionKey ? null : key));
                }}
                aria-expanded={createRuleOpen}
                disabled={locked && !createRuleOpen}
              >
                {createRuleOpen ? (
                  <X size={15} aria-hidden="true" />
                ) : (
                  <Plus size={15} aria-hidden="true" />
                )}
                {createRuleOpen ? "Fechar" : "Nova regra"}
              </button>
            )}
          </div>
        ) : null}

        {createRuleOpen && canManage ? (
          <PipedriveRuleForm
            key={connectionIdentity(canonical)}
            pending={pending === createRuleKey}
            blocked={unsettledLock || stateUnresolved}
            licenseLocked={licenseLocked}
            pipelines={pipelines}
            onSubmit={handleCreateRuleSubmit}
          />
        ) : null}

        {createRuleOpen && canManage && productionDraft && confirmingKey === createProductionKey ? (
          <>
            <InlineConfirm
              message={`Criar a regra "${String(productionDraft.payload.name)}" já com envio automático ativo? Novos movimentos enviam o evento ${eventLabel(productionDraft.payload.eventName as ConversionEventNameDto)} para a Meta. Negócios sem lead de WhatsApp reconhecido continuam apenas observados.`}
              confirmLabel="Criar com envio automático"
              tone="primary"
              disabled={
                Boolean(pending) ||
                locked ||
                stateUnresolved ||
                draftStale ||
                !productionAllowed(capsView, readiness)
              }
              onCancel={() => {
                setConfirmingKey(null);
                setProductionDraft(null);
              }}
              onConfirm={() => void submitCreateRule(productionDraft.payload)}
            />
            <ProductionGate
              capsView={capsView}
              readiness={readiness}
              onRecheck={() => void loadCapabilities()}
              stale={draftStale}
            />
          </>
        ) : null}

        {canonical.rules.length === 0 ? (
          <div className="provider-conversion-empty">
            <Database size={18} aria-hidden="true" />
            <span>Nenhuma regra cadastrada ainda para esta conexão Pipedrive.</span>
          </div>
        ) : (
          canonical.rules.map((rule) => (
            <PipedriveRuleListItem
              key={rule.id}
              workspaceId={workspaceId}
              connectionId={canonical.id}
              rule={rule}
              pipelines={pipelines}
              canManage={canManage}
              pending={pending}
              setPending={setPending}
              mutationsBlocked={locked || stateUnresolved}
              licenseLocked={licenseLocked}
              capsView={capsView}
              readiness={readiness}
              loadCapabilities={loadCapabilities}
              updateRuleAction={updateRuleAction}
              deleteRuleAction={deleteRuleAction}
              onResult={reportResult}
              onRuleUpdated={mergeRuleIntoCanonical}
              onRuleRemoved={removeRuleFromCanonical}
              bumpEpoch={bumpEpoch}
              markUncertain={() => setCertainty("uncertain")}
              reconcileFromServer={reconcileFromServer}
              currentEpoch={() => epochRef.current}
            />
          ))
        )}
      </div>

      <PipedriveEventsSection
        workspaceId={workspaceId}
        connectionId={canonical.id}
        rules={canonical.rules}
        canManage={canManage}
        licenseLocked={locked}
        listEventsAction={listEventsAction}
        retryEventAction={retryEventAction}
        onResult={onResult}
      />

      <p className="action-note">
        Um movimento só é associado quando a pessoa do negócio tem telefone
        igual ao de um lead de WhatsApp que já existe neste workspace, em um canal
        autorizado; nenhum lead é criado. Mudanças só de campos personalizados
        são ignoradas e negócio perdido não gera conversão. Regras em
        observação não enviam nada; com envio automático o resultado de cada
        envio aparece em Eventos recebidos e só é mostrado como enviado quando
        confirmado. Histórico anterior não é reenviado.
      </p>
    </article>
  );
}

function productionAllowed(
  capsView: CapabilitiesView,
  readiness: ReadinessItem[],
): boolean {
  return (
    capsView.phase === "ready" &&
    capsView.capabilities.productionEnabled &&
    readiness.every((item) => item.state !== "missing")
  );
}

function ProductionGate({
  capsView,
  readiness,
  onRecheck,
  stale,
}: {
  capsView: CapabilitiesView;
  readiness: ReadinessItem[];
  onRecheck: () => void;
  stale?: boolean;
}) {
  return (
    <div className="pipedrive-production-gate" data-phase={capsView.phase}>
      {capsView.phase === "idle" || capsView.phase === "loading" ? (
        <small role="status">
          Verificando se o envio automático está disponível...
        </small>
      ) : null}
      {capsView.phase === "ready" && !capsView.capabilities.productionEnabled ? (
        <small role="alert">
          Envio automático desativado nesta instalação. Nada será enviado até
          ser habilitado; a regra continua em observação.
        </small>
      ) : null}
      {capsView.phase === "ready" && capsView.capabilities.productionEnabled ? (
        <small role="status">
          Envio automático disponível nesta instalação.
          {!capsView.capabilities.historicalReplay
            ? " Movimentos anteriores à ativação não são reenviados."
            : ""}
          {!capsView.capabilities.unknownDeliveryRetry
            ? " Um envio de resultado desconhecido nunca é reenviado."
            : ""}
        </small>
      ) : null}
      {capsView.phase === "missing" ? (
        <small role="alert">
          Não foi possível confirmar se o envio automático está disponível. A
          ativação fica indisponível; a regra continua em observação.
        </small>
      ) : null}
      {capsView.phase === "unavailable" ? (
        <small role="alert">
          Não foi possível verificar o envio automático agora.
          Nada foi alterado.
        </small>
      ) : null}
      {capsView.phase === "unauthorized" ? (
        <small role="alert">{SESSION_MESSAGE}</small>
      ) : null}
      {stale ? (
        <small role="alert">
          A conexão mudou desde que você abriu esta confirmação. Cancele e
          revise de novo.
        </small>
      ) : null}
      <ul className="pipedrive-readiness" aria-label="Requisitos para o envio automático">
        {readiness.map((item) => (
          <li key={item.code} data-state={item.state}>
            <span
              className={`event-chip ${item.state === "ok" ? "success" : item.state === "missing" ? "warn" : "neutral"}`}
            >
              {item.state === "ok"
                ? "Atendido"
                : item.state === "missing"
                  ? "Pendente"
                  : "Conferido a cada movimento"}
            </span>
            <span className="pipedrive-readiness-label">{item.label}</span>
          </li>
        ))}
      </ul>
      {capsView.phase === "idle" ||
      capsView.phase === "unavailable" ||
      capsView.phase === "missing" ? (
        <button className="button subtle" type="button" onClick={onRecheck}>
          Verificar de novo
        </button>
      ) : null}
    </div>
  );
}

function InlineConfirm({
  message,
  confirmLabel,
  tone,
  disabled,
  onCancel,
  onConfirm,
  extra,
}: {
  message: string;
  confirmLabel: string;
  tone: "primary" | "danger";
  disabled: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="provider-conversion-inline-confirm" role="alert">
      <span>{message}</span>
      <button className="button subtle" type="button" onClick={onCancel}>
        Cancelar
      </button>
      {extra}
      <button
        className={`button ${tone}`}
        type="button"
        disabled={disabled}
        onClick={onConfirm}
      >
        {confirmLabel}
      </button>
    </div>
  );
}

const retryableErrorCodes = new Set([
  "pipedrive_transport",
  "pipedrive_timeout",
  "pipedrive_rate_limited",
  "pipedrive_encryption_key_invalid",
]);
const EVENTS_COLLAPSED_COUNT = 20;

function eventStatusLabel(status: string): { label: string; tone: string } {
  switch (status) {
    case "received":
      return { label: "Recebido", tone: "neutral" };
    case "processing":
      return { label: "Processando", tone: "neutral" };
    case "observed":
      return { label: "Observado", tone: "success" };
    case "materialized":
      return { label: "Conversão registrada", tone: "neutral" };
    case "duplicate":
      return { label: "Duplicado", tone: "neutral" };
    case "ignored":
      return { label: "Ignorado", tone: "neutral" };
    case "failed":
      return { label: "Falhou", tone: "warn" };
    default:
      return { label: "Status desconhecido", tone: "neutral" };
  }
}

function deliveryOutcome(
  result: PipedriveEventResultDto,
): { label: string; tone: string; detail: string } | null {
  const status = result.deliveryStatus;
  if (status) {
    return deliveryStatusText[status] ?? deliveryStatusText.unrecognized;
  }
  if (result.status === "materialized" || result.conversionEventLogId) {
    return deliveryStatusText.materialized;
  }
  return null;
}

type EventsPhase = "idle" | "loading" | "ready" | "error" | "unauthorized" | "invalid";

// Canonical materialization evidence: once any result carries it, a conversion
// already exists downstream, so the event is never offered for reprocessing.
// "duplicate" is included conservatively: it points at an existing conversion.
function hasCanonicalMaterialization(result: PipedriveEventResultDto): boolean {
  return (
    result.status === "materialized" ||
    result.status === "duplicate" ||
    Boolean(result.conversionEventLogId) ||
    result.deliveryStatus != null
  );
}

function isEventMaterialized(item: PipedriveEventDto): boolean {
  return item.results.some(hasCanonicalMaterialization);
}

function isEventRetryable(item: PipedriveEventDto): boolean {
  return (
    item.status === "failed" &&
    item.errorCode !== null &&
    retryableErrorCodes.has(item.errorCode) &&
    !isEventMaterialized(item)
  );
}

// Binds a confirmation to the exact event state it was opened for.
function eventSignature(item: PipedriveEventDto): string {
  return JSON.stringify([
    item.status,
    item.errorCode,
    item.attempts,
    item.nextAttemptAt,
    item.results.map((result) => [
      result.ruleId,
      result.status,
      result.conversionEventLogId,
      result.deliveryStatus,
    ]),
  ]);
}

type RetryConfirmation = { id: string; signature: string };

function confirmationHolds(
  confirmation: RetryConfirmation | null,
  events: PipedriveEventDto[],
): confirmation is RetryConfirmation {
  if (!confirmation) return false;
  const current = events.find((candidate) => candidate.id === confirmation.id);
  return (
    current !== undefined &&
    isEventRetryable(current) &&
    eventSignature(current) === confirmation.signature
  );
}

function PipedriveEventsSection({
  workspaceId,
  connectionId,
  rules,
  canManage,
  licenseLocked,
  listEventsAction,
  retryEventAction,
  onResult,
}: {
  workspaceId: string;
  connectionId: string;
  rules: PipedriveConversionRuleDto[];
  canManage: boolean;
  licenseLocked: boolean;
  listEventsAction: ListEventsAction;
  retryEventAction: RetryEventAction;
  onResult: (result: AnyResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<EventsPhase>("idle");
  const [events, setEvents] = useState<PipedriveEventDto[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [confirmation, setConfirmationState] = useState<RetryConfirmation | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [lockedIds, setLockedIds] = useState<string[]>([]);
  const lockedRef = useRef(new Set<string>());
  const loadSeq = useRef(0);
  // Refs always hold the latest state, so a handler created by an older render
  // revalidates against current data instead of its stale closure.
  const eventsRef = useRef<PipedriveEventDto[]>([]);
  const phaseRef = useRef<EventsPhase>("idle");
  const confirmationRef = useRef<RetryConfirmation | null>(null);
  const retryingRef = useRef(false);
  const canManageRef = useRef(canManage);
  canManageRef.current = canManage;
  const licenseLockedRef = useRef(licenseLocked);
  licenseLockedRef.current = licenseLocked;

  function changePhase(next: EventsPhase) {
    phaseRef.current = next;
    setPhase(next);
  }

  function setConfirmation(next: RetryConfirmation | null) {
    confirmationRef.current = next;
    setConfirmationState(next);
  }

  useEffect(() => {
    if (!canManage) setConfirmation(null);
  }, [canManage]);

  async function load() {
    const seq = ++loadSeq.current;
    changePhase("loading");
    try {
      const result = await listEventsAction(workspaceId, connectionId);
      if (seq !== loadSeq.current) return;
      if (result.ok) {
        eventsRef.current = result.events;
        setEvents(result.events);
        if (!confirmationHolds(confirmationRef.current, result.events)) setConfirmation(null);
        changePhase("ready");
      } else if (result.reason === "unauthorized") {
        setConfirmation(null);
        changePhase("unauthorized");
        onResult({ ok: false, message: SESSION_MESSAGE, authFailure: "unauthorized" });
      } else {
        setConfirmation(null);
        changePhase(result.reason === "invalid_response" ? "invalid" : "error");
      }
    } catch {
      if (seq === loadSeq.current) {
        setConfirmation(null);
        changePhase("error");
      }
    }
  }

  async function retry(eventId: string) {
    if (retryingRef.current || lockedRef.current.has(eventId)) return;
    if (
      !canManageRef.current ||
      licenseLockedRef.current ||
      phaseRef.current !== "ready" ||
      confirmationRef.current?.id !== eventId ||
      !confirmationHolds(confirmationRef.current, eventsRef.current)
    ) {
      setConfirmation(null);
      return;
    }
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("connectionId", connectionId);
    formData.set("eventId", eventId);

    setConfirmation(null);
    retryingRef.current = true;
    setRetryingId(eventId);
    try {
      const result = await retryEventAction(formData);
      onResult(result);
      if (result.outcomeUnknown) {
        lockedRef.current.add(eventId);
        setLockedIds([...lockedRef.current]);
      }
      if (result.authFailure !== "unauthorized") await load();
    } catch {
      lockedRef.current.add(eventId);
      setLockedIds([...lockedRef.current]);
      onResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE, outcomeUnknown: true });
      await load();
    } finally {
      retryingRef.current = false;
      setRetryingId(null);
    }
  }

  const visibleEvents = showAll ? events : events.slice(0, EVENTS_COLLAPSED_COUNT);
  const sectionDisabled = phase === "unauthorized";

  return (
    <details
      className="provider-conversion-rule-scope"
      open={open}
      onToggle={(event) => {
        const nowOpen = event.currentTarget.open;
        setOpen(nowOpen);
        if (nowOpen && phase === "idle") void load();
      }}
    >
      <summary>
        <span>Eventos recebidos</span>
        <strong>Últimos 100, somente leitura</strong>
      </summary>

      <div className="provider-conversion-heading-actions">
        <button
          className="button subtle"
          type="button"
          disabled={phase === "loading" || Boolean(retryingId)}
          onClick={() => void load()}
        >
          <RefreshCw size={15} aria-hidden="true" />
          Atualizar eventos
        </button>
      </div>

      {phase === "loading" ? (
        <p className="action-note" role="status">Carregando eventos...</p>
      ) : null}
      {phase === "error" || phase === "invalid" ? (
        <div className="feedback-banner error" role="alert">
          <span>
            {phase === "invalid"
              ? "A API retornou eventos em formato inesperado. Nada foi exibido."
              : "Não foi possível carregar os eventos. Tente novamente."}
          </span>
          <button className="button subtle" type="button" onClick={() => void load()}>
            Tentar novamente
          </button>
        </div>
      ) : null}
      {sectionDisabled ? (
        <div className="feedback-banner error" role="alert">
          <span>Sessão sem permissão para ver eventos. Atualize a página.</span>
        </div>
      ) : null}
      {phase === "ready" && events.length === 0 ? (
        <div className="provider-conversion-empty">
          <Database size={18} aria-hidden="true" />
          <span>
            Nenhum evento recebido ainda. Depois de colar a URL do webhook no
            Pipedrive, os movimentos de etapa aparecem aqui.
          </span>
        </div>
      ) : null}

      {phase === "ready" && events.length > 0 ? (
        <ul className="provider-conversion-rule-list" aria-label="Eventos recebidos">
          {visibleEvents.map((item) => {
            const status = eventStatusLabel(item.status);
            const locked = lockedIds.includes(item.id);
            const deliveryBlocksRetry = item.results.some(
              (result) =>
                result.deliveryStatus === "delivery_unknown" ||
                result.deliveryStatus === "unrecognized",
            );
            const materialized = isEventMaterialized(item);
            const retryable = isEventRetryable(item);
            const confirming =
              canManage &&
              phase === "ready" &&
              confirmation?.id === item.id &&
              confirmationHolds(confirmation, events);
            return (
              <li className="provider-conversion-rule" key={item.id}>
                <div className="provider-conversion-rule-copy">
                  <div className="provider-conversion-rule-title pipedrive-title-row">
                    <strong>{formatDateTime(item.occurredAt)}</strong>
                    <span className={`event-chip ${status.tone}`}>{status.label}</span>
                    <small>{item.attempts} tentativa(s)</small>
                  </div>
                  {item.errorCode ? <small>{describeErrorCode(item.errorCode)}</small> : null}
                  {item.nextAttemptAt && item.status !== "observed" ? (
                    <small>Próxima tentativa: {formatDateTime(item.nextAttemptAt)}</small>
                  ) : null}
                  {item.results.map((result) => {
                    const rule = rules.find((candidate) => candidate.id === result.ruleId);
                    const resultStatus = eventStatusLabel(result.status);
                    const delivery = deliveryOutcome(result);
                    return (
                      <Fragment key={`${result.ruleId}-${result.eventName}`}>
                        <small>
                          {rule?.name ?? "Regra removida"} / {eventLabel(result.eventName)}:{" "}
                          {resultStatus.label}
                          {result.valueCents != null
                            ? ` (${moneyLabel(result.valueCents, result.currency)})`
                            : ""}
                          {result.errorCode ? ` - ${describeErrorCode(result.errorCode)}` : ""}
                        </small>
                        {delivery ? (
                          <small
                            className="pipedrive-delivery"
                            data-delivery-status={result.deliveryStatus ?? "materialized"}
                          >
                            <span className={`event-chip ${delivery.tone}`}>
                              {delivery.label}
                            </span>{" "}
                            {delivery.detail}
                            {result.conversionEventLogId ? (
                              <>
                                {" "}
                                / Conversão{" "}
                                <span title={result.conversionEventLogId}>
                                  {shortConversionId(result.conversionEventLogId)}
                                </span>
                              </>
                            ) : null}
                            {result.deliveryErrorCode
                              ? ` - ${describeErrorCode(result.deliveryErrorCode)}`
                              : ""}
                          </small>
                        ) : null}
                      </Fragment>
                    );
                  })}
                  {deliveryBlocksRetry ? (
                    <small className="action-note">
                      O envio desta conversão tem resultado desconhecido: ele
                      nunca é reenviado nem reprocessado por aqui.
                    </small>
                  ) : materialized && item.status === "failed" ? (
                    <small className="action-note">
                      Este evento já tem conversão registrada: ele não é
                      reprocessado por aqui e nada é reenviado a partir desta
                      lista.
                    </small>
                  ) : null}
                  {item.status === "failed" && item.errorCode === "attempts_exhausted" ? (
                    <small className="action-note">
                      Corrija a causa e aguarde um novo movimento no Pipedrive.
                    </small>
                  ) : null}
                  {item.status === "failed" &&
                  !retryable &&
                  !materialized &&
                  item.errorCode !== "attempts_exhausted" ? (
                    <small className="action-note">
                      Esta falha não pode ser reprocessada; revise credencial,
                      catálogo e canais.
                    </small>
                  ) : null}
                  {locked ? (
                    <small className="action-note" role="status">
                      Reprocessamento sem resposta final; atualize a lista antes
                      de tentar de novo.
                    </small>
                  ) : null}
                </div>
                {canManage && retryable ? (
                  <div className="provider-conversion-rule-actions">
                    <button
                      className="button subtle"
                      type="button"
                      aria-label={`Reprocessar evento de ${formatDateTime(item.occurredAt)}`}
                      disabled={Boolean(retryingId) || locked || licenseLocked}
                      onClick={() =>
                        setConfirmation({ id: item.id, signature: eventSignature(item) })
                      }
                    >
                      <RefreshCw size={15} aria-hidden="true" />
                      Reprocessar
                    </button>
                  </div>
                ) : null}
                {confirming ? (
                  <InlineConfirm
                    message="Reprocessar este evento? Ele volta para a fila de processamento. Apenas eventos sem conversão registrada podem ser reprocessados; um envio já registrado nunca é reenviado."
                    confirmLabel="Reprocessar evento"
                    tone="primary"
                    disabled={Boolean(retryingId) || locked || licenseLocked}
                    onCancel={() => setConfirmation(null)}
                    onConfirm={() => void retry(item.id)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {phase === "ready" && events.length > EVENTS_COLLAPSED_COUNT ? (
        <button
          className="button subtle"
          type="button"
          onClick={() => setShowAll((current) => !current)}
        >
          {showAll ? "Mostrar menos" : `Ver todos (${events.length})`}
        </button>
      ) : null}
    </details>
  );
}

/** Form-only sentinel for the won-deal option of a pipeline (never sent). */
const WON_STAGE_VALUE = "__deal_won__";

type BuiltRule =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * The update schema is a strict `.partial()`: an omitted key means "leave
 * unchanged" (the API merges the PATCH onto the stored rule), while
 * `fixedValueCents`/`currency`/`contentName` accept an explicit `null` to
 * clear. On update an emptied field is therefore sent as `null`.
 */
function buildRulePayload(
  data: FormData,
  options: { isUpdate: boolean },
): BuiltRule {
  const { isUpdate } = options;
  const name = String(data.get("name") ?? "").trim();
  const stageValue = String(data.get("stage") ?? "");
  const separator = stageValue.indexOf("::");
  const pipelineId = separator > 0 ? stageValue.slice(0, separator) : "";
  const stageId = separator > 0 ? stageValue.slice(separator + 2) : "";
  // "Negócio ganho" of a pipeline: always Compra with the deal value/currency.
  const won = stageId === WON_STAGE_VALUE;
  const eventName = won ? "Purchase" : String(data.get("eventName") ?? "");
  const valueMode = String(data.get("valueMode") ?? "deal");
  const currency = String(data.get("currency") ?? "").trim();
  const contentName = String(data.get("contentName") ?? "").trim();
  const fixedValueAmount = String(data.get("fixedValueAmount") ?? "").trim();

  const parsedEvent = conversionEventNameSchema.safeParse(eventName);
  if (!name || !pipelineId || !stageId || !parsedEvent.success) {
    return { ok: false, message: "Revise os dados informados e tente novamente." };
  }
  if (valueMode !== "deal" && valueMode !== "fixed") {
    return { ok: false, message: "Revise os dados informados e tente novamente." };
  }
  if (currency && !/^[A-Za-z]{3}$/.test(currency)) {
    return { ok: false, message: "A moeda deve ter 3 letras (ex.: BRL)." };
  }

  const carriesValue = conversionEventCarriesValue(parsedEvent.data);
  const fixedValueCents =
    carriesValue && valueMode === "fixed" ? parseMoneyToCents(fixedValueAmount) : null;

  if (carriesValue && valueMode === "fixed" && !fixedValueCents) {
    return {
      ok: false,
      message: "Informe um valor fixo positivo válido (ex.: 199,90).",
    };
  }

  const payload: Record<string, unknown> = {
    name,
    trigger: won ? "deal_won" : "stage_change",
    pipelineId,
    stageId: won ? null : stageId,
    eventName: parsedEvent.data,
    valueMode: carriesValue ? valueMode : "deal",
  };

  if (!isUpdate) {
    payload.mode = String(data.get("mode") ?? "") === "production" ? "production" : "observation";
  }

  if (carriesValue && valueMode === "fixed") payload.fixedValueCents = fixedValueCents;
  else if (isUpdate) payload.fixedValueCents = null;

  if (carriesValue && currency) payload.currency = currency.toUpperCase();
  else if (isUpdate) payload.currency = null;

  if (carriesValue && contentName) payload.contentName = contentName;
  else if (isUpdate) payload.contentName = null;

  return { ok: true, payload };
}

/**
 * Mirrors the API's update merge (stored rule spread with the proposed
 * partial) and validates the candidate through the REAL shared create schema,
 * so only issues the backend would also reject are raised. Only the schema's
 * own custom (Portuguese) issue messages are shown.
 */
function validateMergedRuleCandidate(
  current: PipedriveConversionRuleDto | undefined,
  proposed: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  const candidate = current
    ? {
        name: current.name,
        trigger: current.trigger,
        pipelineId: current.pipelineId,
        stageId: current.stageId,
        eventName: current.eventName,
        mode: current.mode,
        active: current.active,
        valueMode: current.valueMode,
        fixedValueCents: current.fixedValueCents,
        currency: current.currency,
        contentName: current.contentName,
        ...proposed,
      }
    : proposed;

  const result = pipedriveConversionRuleCreateInputSchema.safeParse(candidate);
  if (result.success) return { ok: true };

  const custom = result.error.issues.find((issue) => issue.code === "custom");
  return {
    ok: false,
    message: custom?.message ?? "Revise os dados informados e tente novamente.",
  };
}

function PipedriveRuleForm({
  pending,
  blocked = false,
  licenseLocked = false,
  pipelines,
  onSubmit,
  initial,
}: {
  /** This form's own save is in flight. */
  pending: boolean;
  /** Writes stopped for another reason (unsettled request, unconfirmed state). */
  blocked?: boolean;
  /** License locked (known or after a 423): nothing here can be saved. */
  licenseLocked?: boolean;
  pipelines: PipedrivePipelineDto[];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  initial?: PipedriveConversionRuleDto;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [stage, setStage] = useState(
    initial
      ? `${initial.pipelineId}::${initial.trigger === "deal_won" ? WON_STAGE_VALUE : initial.stageId}`
      : "",
  );
  const [eventName, setEventName] = useState<ConversionEventNameDto>(
    initial?.eventName ?? "QualifiedLead",
  );
  const [valueMode, setValueMode] = useState<"deal" | "fixed">(
    initial?.valueMode ?? "deal",
  );
  const [fixedValueAmount, setFixedValueAmount] = useState(
    initial?.fixedValueCents != null
      ? (initial.fixedValueCents / 100).toFixed(2).replace(".", ",")
      : "",
  );
  const workspaceCurrency = useWorkspaceCurrency();
  // Regra nova começa na "Moeda das conversões" do workspace; ao editar, a
  // moeda gravada continua. null = regra nova ainda sem escolha: usa a moeda
  // do workspace, menos em "Negócio ganho", que traz a moeda do próprio
  // negócio (uma moeda na regra só adicionaria a conferência de divergência).
  const [currencyChoice, setCurrency] = useState<string | null>(
    initial ? (initial.currency ?? "") : null,
  );
  const [contentName, setContentName] = useState(initial?.contentName ?? "");
  const [mode, setMode] = useState<"observation" | "production">("observation");
  const wonSelected = stage.endsWith(`::${WON_STAGE_VALUE}`);
  const currency = currencyChoice ?? (wonSelected ? "" : workspaceCurrency);
  const effectiveEvent: ConversionEventNameDto = wonSelected
    ? "Purchase"
    : eventName;
  const carriesValue = conversionEventCarriesValue(effectiveEvent);
  const policy = conversionEventValuePolicy(effectiveEvent);
  // Won deals carry their own currency; the field is optional for them.
  const currencyRequired =
    valueMode === "fixed" || (policy === "required" && !wonSelected);

  function selectEventName(next: ConversionEventNameDto) {
    setEventName(next);
    if (!conversionEventCarriesValue(next)) {
      setValueMode("deal");
      setFixedValueAmount("");
      setCurrency(null);
      setContentName("");
    }
  }

  const inert = pending || blocked || licenseLocked;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (inert) {
      event.preventDefault();
      return;
    }
    onSubmit(event);
  }

  const stageStillInCatalog = pipelines.some(
    (pipeline) =>
      `${pipeline.id}::${WON_STAGE_VALUE}` === stage ||
      pipeline.stages.some((item) => `${pipeline.id}::${item.id}` === stage),
  );

  return (
    <form className="provider-conversion-builder" onSubmit={handleSubmit}>
      <div className="provider-conversion-base-fields pipedrive-rule-fields">
        <label>
          <span className="field-label">Nome da regra</span>
          <input
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            minLength={2}
            maxLength={120}
            placeholder="Ex.: Lead qualificado"
            disabled={inert}
            required
          />
        </label>
        <label>
          <span className="field-label">Funil e etapa no Pipedrive</span>
          <select
            name="stage"
            value={stage}
            onChange={(event) => setStage(event.target.value)}
            disabled={inert}
            required
          >
            <option value="" disabled>
              Selecione uma etapa
            </option>
            {initial && stage && !stageStillInCatalog ? (
              <option value={stage} disabled>
                Etapa atual (indisponível no catálogo)
              </option>
            ) : null}
            {pipelines.map((pipeline) => (
              <optgroup key={pipeline.id} label={pipeline.name}>
                {pipeline.stages.map((item) => (
                  <option key={item.id} value={`${pipeline.id}::${item.id}`}>
                    {item.name}
                  </option>
                ))}
                <option value={`${pipeline.id}::${WON_STAGE_VALUE}`}>
                  Negócio ganho (Compra com o valor)
                </option>
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Evento da conversão</span>
          <select
            name="eventName"
            value={effectiveEvent}
            onChange={(event) =>
              selectEventName(event.target.value as ConversionEventNameDto)
            }
            disabled={inert || wonSelected}
          >
            {conversionEventOptions.map((option) => (
              <option key={option} value={option}>
                {eventLabel(option)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="action-note">
        {wonSelected
          ? "Quando um negócio deste funil for marcado como ganho, envia Compra com o valor e a moeda do negócio. Negócio perdido não gera conversão."
          : "A regra vale quando o negócio entra na etapa escolhida, não pelo nome do negócio."}{" "}
        {initial
          ? initial.mode === "production"
            ? "Esta regra está com envio automático: alterações valem para os próximos movimentos."
            : "Esta regra está em observação: nada é enviado à Meta."
          : mode === "production"
            ? "Com envio automático, cada movimento envia o evento para a Meta. Você confirma antes de criar."
            : "Em observação, a regra apenas registra o movimento: nada é enviado à Meta."}
      </p>
      {!initial ? (
        <fieldset className="provider-conversion-value-modes">
          <legend className="field-label">Modo da regra</legend>
          <div>
            <label>
              <input
                type="radio"
                name="mode"
                value="observation"
                checked={mode === "observation"}
                onChange={() => setMode("observation")}
                disabled={inert}
              />
              <span>Observação (padrão): nada é enviado</span>
            </label>
            <label>
              <input
                type="radio"
                name="mode"
                value="production"
                checked={mode === "production"}
                onChange={() => setMode("production")}
                disabled={inert}
              />
              <span>Envio automático: envia o evento para a Meta</span>
            </label>
          </div>
        </fieldset>
      ) : null}
      <p className="action-note">
        {wonSelected
          ? "O valor e a moeda vêm do negócio ganho no Pipedrive (ou use um valor fixo)."
          : valuePolicyHint(effectiveEvent)}
      </p>

      {carriesValue ? (
        <>
          <fieldset className="provider-conversion-value-modes">
            <legend className="field-label">Valor</legend>
            <div>
              <label>
                <input
                  type="radio"
                  name="valueMode"
                  value="deal"
                  checked={valueMode === "deal"}
                  onChange={() => setValueMode("deal")}
                  disabled={inert}
                />
                <span>Valor do negócio no Pipedrive</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="valueMode"
                  value="fixed"
                  checked={valueMode === "fixed"}
                  onChange={() => setValueMode("fixed")}
                  disabled={inert}
                />
                <span>Valor fixo</span>
              </label>
            </div>
          </fieldset>

          {valueMode === "fixed" ? (
            <div className="provider-conversion-base-fields">
              <label>
                <span className="field-label">Valor fixo (positivo)</span>
                <input
                  name="fixedValueAmount"
                  value={fixedValueAmount}
                  onChange={(event) => setFixedValueAmount(event.target.value)}
                  inputMode="decimal"
                  placeholder="Ex.: 199,90"
                  disabled={inert}
                  required
                />
              </label>
            </div>
          ) : null}

          <div className="provider-conversion-base-fields">
            <CrmCurrencySelect
              label={`Moeda${currencyRequired ? " - obrigatória" : wonSelected ? " - opcional, usa a do negócio" : ""}`}
              value={currency}
              onChange={setCurrency}
              required={currencyRequired}
              emptyLabel={
                wonSelected ? "Usar a moeda do negócio" : "Sem moeda"
              }
              disabled={inert}
            />
            <label>
              <span className="field-label">Produto (opcional)</span>
              <input
                name="contentName"
                value={contentName}
                onChange={(event) => setContentName(event.target.value)}
                maxLength={180}
                placeholder="Ex.: Plano anual"
                disabled={inert}
              />
            </label>
          </div>
          {valueMode === "deal" ? (
            <p className="action-note">
              Se a moeda do negócio for diferente da configurada, o movimento é
              ignorado: não há conversão cambial. Negócio sem moeda usa a da
              regra ou a do workspace; negócio em moeda fora de BRL, USD ou EUR
              é ignorado.
            </p>
          ) : null}
        </>
      ) : null}

      {licenseLocked ? (
        <p className="action-note warn" role="status">
          {LICENSE_LOCKED_RULE_FORM_NOTE}
        </p>
      ) : null}

      <div className="provider-conversion-builder-footer">
        <span className="action-note">
          Crie uma regra por etapa (e uma de negócio ganho por funil); todos
          os funis da conta aparecem acima.
        </span>
        <button className="button primary" type="submit" disabled={inert}>
          <Check size={15} aria-hidden="true" />
          {pending
            ? "Salvando..."
            : initial
              ? "Salvar regra"
              : mode === "production"
                ? "Revisar e ativar envio automático"
                : "Criar regra"}
        </button>
      </div>
    </form>
  );
}

function PipedriveRuleListItem({
  workspaceId,
  connectionId,
  rule,
  pipelines,
  canManage,
  pending,
  setPending,
  mutationsBlocked,
  licenseLocked,
  capsView,
  readiness,
  loadCapabilities,
  updateRuleAction,
  deleteRuleAction,
  onResult,
  onRuleUpdated,
  onRuleRemoved,
  bumpEpoch,
  markUncertain,
  reconcileFromServer,
  currentEpoch,
}: {
  workspaceId: string;
  connectionId: string;
  rule: PipedriveConversionRuleDto;
  pipelines: PipedrivePipelineDto[];
  canManage: boolean;
  pending: string | null;
  setPending: (value: string | null) => void;
  mutationsBlocked: boolean;
  licenseLocked: boolean;
  capsView: CapabilitiesView;
  readiness: ReadinessItem[];
  loadCapabilities: () => Promise<void>;
  updateRuleAction: RuleAction;
  deleteRuleAction: RuleAction;
  onResult: (result: AnyResult) => void;
  onRuleUpdated: (rule: PipedriveConversionRuleDto) => void;
  onRuleRemoved: (ruleId: string) => void;
  bumpEpoch: () => number;
  markUncertain: () => void;
  reconcileFromServer: (myEpoch: number) => Promise<void>;
  currentEpoch: () => number;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [productionConfirm, setProductionConfirm] = useState<{
    kind: "activate" | "resume";
    updatedAt: string;
  } | null>(null);
  const editKey = `edit-rule-${rule.id}`;
  const toggleKey = `toggle-rule-${rule.id}`;
  const deleteKey = `delete-rule-${rule.id}`;
  const modeKey = `mode-rule-${rule.id}`;
  const productionKey = `production-rule-${rule.id}`;

  const pipeline = pipelines.find((item) => item.id === rule.pipelineId);
  const wonRule = rule.trigger === "deal_won";
  const stage = wonRule
    ? { id: WON_STAGE_VALUE, name: "Negócio ganho", sort: null }
    : pipeline?.stages.find((item) => item.id === rule.stageId);
  const isProduction = rule.mode === "production";
  // The confirm belongs to the exact rule version it was opened on: any newer
  // canonical rule (reconciled, edited elsewhere) closes it instead of acting.
  const productionConfirmValid =
    productionConfirm !== null &&
    productionConfirm.updatedAt === rule.updatedAt &&
    (productionConfirm.kind === "activate"
      ? !isProduction && rule.active
      : isProduction && !rule.active);

  function openProductionConfirm(kind: "activate" | "resume") {
    if (pending || mutationsBlocked) return;
    setConfirmingDelete(false);
    setProductionConfirm({ kind, updatedAt: rule.updatedAt });
    void loadCapabilities();
  }

  async function confirmProduction() {
    if (!productionConfirm || !productionConfirmValid) return;
    if (!productionAllowed(capsView, readiness)) return;
    const payload =
      productionConfirm.kind === "activate" ? { mode: "production" } : { active: true };
    setProductionConfirm(null);
    await submitPartial(productionKey, payload);
  }

  // A rule write is atomic server-side, but a reported failure can still follow
  // a commit whose response was lost, so the whole connection is marked
  // uncertain before awaiting and unknown outcomes are resolved with a GET.
  async function submitPartial(key: string, payload: Record<string, unknown>) {
    if (pending || mutationsBlocked) return undefined;
    const myEpoch = bumpEpoch();
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("connectionId", connectionId);
    formData.set("ruleId", rule.id);
    formData.set("payload", JSON.stringify(payload));

    setPending(key);
    markUncertain();
    try {
      const result = await updateRuleAction(formData);
      onResult(result);
      if (currentEpoch() !== myEpoch) return result;
      if (result.ok && result.rule) onRuleUpdated(result.rule);
      else await reconcileFromServer(myEpoch);
      return result;
    } catch {
      const result: PipedriveRuleActionResult = {
        ok: false,
        message: TRANSPORT_ERROR_MESSAGE,
        outcomeUnknown: true,
      };
      onResult(result);
      if (currentEpoch() === myEpoch) await reconcileFromServer(myEpoch);
      return result;
    } finally {
      setPending(null);
    }
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || mutationsBlocked) return;

    const built = buildRulePayload(new FormData(event.currentTarget), { isUpdate: true });
    if (!built.ok) {
      onResult({ ok: false, message: built.message });
      return;
    }
    const validation = validateMergedRuleCandidate(rule, built.payload);
    if (!validation.ok) {
      onResult({ ok: false, message: validation.message });
      return;
    }

    const result = await submitPartial(editKey, built.payload);
    if (result?.ok) setEditOpen(false);
  }

  async function removeRule() {
    if (pending || mutationsBlocked) return;
    const myEpoch = bumpEpoch();
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("connectionId", connectionId);
    formData.set("ruleId", rule.id);

    setConfirmingDelete(false);
    setPending(deleteKey);
    markUncertain();
    try {
      const result = await deleteRuleAction(formData);
      onResult(result);
      if (currentEpoch() !== myEpoch) return;
      if (result.ok) onRuleRemoved(rule.id);
      else await reconcileFromServer(myEpoch);
    } catch {
      onResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE, outcomeUnknown: true });
      if (currentEpoch() === myEpoch) await reconcileFromServer(myEpoch);
    } finally {
      setPending(null);
    }
  }

  return (
    <article className="provider-conversion-rule">
      <div className="provider-conversion-rule-main">
        <div className="provider-conversion-rule-icon">
          <Database size={17} aria-hidden="true" />
        </div>
        <div className="provider-conversion-rule-copy">
          <div className="provider-conversion-rule-title pipedrive-title-row">
            <strong>{rule.name}</strong>
            <span className="event-chip neutral">{eventLabel(rule.eventName)}</span>
            <span className={`event-chip ${rule.active ? "success" : "warn"}`}>
              {!rule.active ? "Pausada" : isProduction ? "Envio automático" : "Observando"}
            </span>
          </div>
          <span>
            {pipeline?.name ?? "Funil não encontrado"} /{" "}
            {stage?.name ?? "Etapa não encontrada"}
            {!stage ? " (indisponível no catálogo atual)" : ""}
          </span>
          {conversionEventCarriesValue(rule.eventName) ? (
            <small>
              {rule.valueMode === "fixed"
                ? `Valor fixo: ${moneyLabel(rule.fixedValueCents, rule.currency)}`
                : `Valor do negócio no Pipedrive${rule.currency ? ` (${rule.currency})` : " (sem moeda configurada)"}`}
              {rule.contentName ? ` / Produto: ${rule.contentName}` : ""}
            </small>
          ) : (
            <small>Evento sem valor</small>
          )}
          {isProduction && rule.active ? (
            <small>
              {rule.productionActivatedAt
                ? `Envio automático ativo desde ${formatDateTime(rule.productionActivatedAt)}`
                : "Envio automático ativo (data de ativação não informada)"}
            </small>
          ) : null}
          {isProduction && !rule.active ? (
            <small>
              Configurada com envio automático, mas pausada: nada é enviado. Retomar
              pede confirmação.
            </small>
          ) : null}
        </div>
      </div>

      {canManage ? (
        <div className="provider-conversion-rule-actions">
          {rule.active ? (
            <button
              className="icon-button"
              type="button"
              title={isProduction ? "Voltar para observação" : "Ativar envio automático"}
              aria-label={
                isProduction
                  ? `Voltar para observação a regra ${rule.name}`
                  : `Ativar envio automático da regra ${rule.name}`
              }
              disabled={mutationsBlocked || Boolean(pending)}
              onClick={() => {
                if (isProduction) {
                  void submitPartial(modeKey, { mode: "observation" });
                  return;
                }
                openProductionConfirm("activate");
              }}
            >
              {isProduction ? (
                <Eye size={15} aria-hidden="true" />
              ) : (
                <Send size={15} aria-hidden="true" />
              )}
            </button>
          ) : null}
          <button
            className="icon-button"
            type="button"
            title={
              rule.active
                ? "Pausar regra"
                : isProduction
                  ? "Retomar envio automático"
                  : "Retomar observação"
            }
            aria-label={
              rule.active
                ? `Pausar regra ${rule.name}`
                : isProduction
                  ? `Retomar regra ${rule.name} com envio automático`
                  : `Retomar regra ${rule.name}`
            }
            disabled={mutationsBlocked || Boolean(pending)}
            onClick={() => {
              if (!rule.active && isProduction) {
                openProductionConfirm("resume");
                return;
              }
              void submitPartial(toggleKey, { active: !rule.active });
            }}
          >
            {rule.active ? (
              <Pause size={15} aria-hidden="true" />
            ) : (
              <Play size={15} aria-hidden="true" />
            )}
          </button>
          <button
            className="icon-button danger"
            type="button"
            title="Remover regra"
            aria-label={`Remover regra ${rule.name}`}
            disabled={mutationsBlocked || Boolean(pending)}
            onClick={() => {
              setProductionConfirm(null);
              setConfirmingDelete(true);
            }}
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {canManage && productionConfirm && productionConfirmValid ? (
        <>
          <InlineConfirm
            message={`${productionConfirm.kind === "activate" ? "Ativar envio automático" : "Retomar envio automático"} para "${rule.name}"? Novos movimentos (${stage?.name ?? "etapa selecionada"}) enviam o evento ${eventLabel(rule.eventName)} (${ruleValueSummary(rule)}) para a Meta. Movimentos anteriores continuam apenas observados.`}
            confirmLabel={
              productionConfirm.kind === "activate" ? "Ativar envio automático" : "Retomar envio automático"
            }
            tone="primary"
            disabled={
              mutationsBlocked || Boolean(pending) || !productionAllowed(capsView, readiness)
            }
            onCancel={() => setProductionConfirm(null)}
            onConfirm={() => void confirmProduction()}
          />
          <ProductionGate
            capsView={capsView}
            readiness={readiness}
            onRecheck={() => void loadCapabilities()}
          />
        </>
      ) : null}

      {canManage && confirmingDelete ? (
        <InlineConfirm
          message="Remover esta regra? Esta ação não pode ser desfeita; o histórico já observado é preservado."
          confirmLabel="Remover"
          tone="danger"
          disabled={mutationsBlocked || Boolean(pending)}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void removeRule()}
        />
      ) : null}

      {canManage ? (
        <details
          className="provider-conversion-rule-scope"
          open={editOpen}
          onToggle={(event) => setEditOpen(event.currentTarget.open)}
        >
          <summary>
            <span>Editar regra</span>
            <strong>
              <Pencil size={13} aria-hidden="true" /> {rule.name}
            </strong>
          </summary>
          {/* Keyed on open-state + the rule's own version so a reopened editor
              never submits a stale draft over a newer canonical rule. */}
          <PipedriveRuleForm
            key={`${rule.id}-${rule.updatedAt}-${editOpen}`}
            pending={pending === editKey}
            blocked={mutationsBlocked}
            licenseLocked={licenseLocked}
            pipelines={pipelines}
            onSubmit={handleEditSubmit}
            initial={rule}
          />
        </details>
      ) : null}
    </article>
  );
}
