"use client";

// Provenance: adapted from the read-only kommo-webhook-url-session worktree
// (settings/kommo-conversion-panel.tsx). Changes for the student edition:
// credentials-only connection form, license/owner gating, one-time URL kept for
// the same-account session (no clearing on unrelated mutations), final-handler
// rechecks for every production confirmation, accessible confirmation dialogs
// and a connection-scoped webhook audit that stays readable under a license lock.

import type {
  ConversionEventNameDto,
  InboundWebhookChannelDto,
} from "@wpptrack/shared";
import {
  conversionEventCarriesValue,
  conversionEventDisplayLabels,
  conversionEventNameSchema,
  conversionEventRequiresValue,
  formatMoney,
  kommoChannelBindingMessages,
  kommoConnectionChannelBindingsInputSchema,
  kommoConnectionCreateInputSchema,
  kommoConnectionCredentialReplaceInputSchema,
  kommoConversionRuleCreateInputSchema,
  kommoConversionRuleUpdateInputSchema,
} from "@wpptrack/shared";
import {
  Check,
  Copy,
  Database,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
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
  KommoActionResult,
  KommoConnectionDetailDto,
  KommoConnectionGetResult,
  KommoConnectionListResult,
  KommoConnectionPipelineRowDto,
  KommoEventsResult,
  KommoRuleActionResult,
} from "../integrations/kommo-actions";
import { KommoAuditPanel } from "./kommo-audit-panel";

type ConnectionAction = (formData: FormData) => Promise<KommoActionResult>;
type RuleAction = (formData: FormData) => Promise<KommoRuleActionResult>;
type ListConnectionsAction = (workspaceId: string) => Promise<KommoConnectionListResult>;
type ListEventsAction = (
  workspaceId: string,
  connectionId: string,
  cursor?: string,
) => Promise<KommoEventsResult>;

type GetConnectionAction = (
  workspaceId: string,
  connectionId: string,
) => Promise<KommoConnectionGetResult>;

export type KommoConnectionsLoadState = "real" | "empty" | "error" | "forbidden";

export type KommoUnsettledOperations = {
  creation: boolean;
  connectionIds: Set<string>;
};

export type KommoConversionPanelProps = {
  unsettledOperations?: KommoUnsettledOperations;
  workspaceId: string;
  connections: KommoConnectionDetailDto[];
  loadState: KommoConnectionsLoadState;
  allChannels: InboundWebhookChannelDto[];
  /** Workspace owner (or platform support) with integration permission. */
  canManage: boolean;
  /** Client-side hint only: the server stays the authority (HTTP 423). */
  licenseLocked?: boolean;
  createConnectionAction: ConnectionAction;
  replaceCredentialAction: ConnectionAction;
  setStatusAction: ConnectionAction;
  setChannelBindingsAction: ConnectionAction;
  rotateWebhookAction: ConnectionAction;
  refreshCatalogAction: ConnectionAction;
  listConnectionsAction?: ListConnectionsAction;
  getConnectionAction: GetConnectionAction;
  createRuleAction: RuleAction;
  updateRuleAction: RuleAction;
  deleteRuleAction: RuleAction;
  listEventsAction: ListEventsAction;
};

type Notice = { tone: "success" | "error"; message: string };

type SecretApi = {
  /** Current guard value; a result may only show a secret if it is unchanged. */
  ticket: () => number;
  show: (url: string, connection: KommoConnectionDetailDto | null, ticket: number) => void;
  /** Drops the visible secret AND invalidates every in-flight result. */
  invalidate: () => void;
};

/**
 * Shown whenever an action's own promise rejects (network blip between the
 * browser and the Next.js server, a dropped session boundary, etc.). Kept
 * generic on purpose: never echo the raw error.
 */
const TRANSPORT_ERROR_MESSAGE =
  "Não foi possível concluir a ação. Verifique sua conexão/sessão e tente novamente.";
const INVALID_FORM_MESSAGE = "Revise os dados informados e tente novamente.";
const STALE_APPROVAL_MESSAGE =
  "O estado mudou depois que você abriu esta confirmação. Revise e confirme novamente.";
const LICENSE_LOCKED_NOTE =
  "Licença bloqueada: criar, editar, pausar ou ativar envio está indisponível. A auditoria continua disponível para consulta.";
const SESSION_LOST_MESSAGE =
  "Sua sessão expirou ou você não tem permissão para esta ação.";

/** One authorizable WhatsApp number of the workspace (any provider); shared
 * with Pipedrive (lib/crm-channel-options). */
type RouteOption = CrmChannelOption;

const conversionEventOptions = conversionEventNameSchema.options;

function eventLabel(eventName: ConversionEventNameDto): string {
  return conversionEventDisplayLabels[eventName];
}

function connectionStatusLabel(
  status: KommoConnectionDetailDto["status"],
): string {
  if (status === "active") return "Ativa";
  if (status === "paused") return "Pausada";
  return "Bloqueada";
}

function connectionStatusTone(
  status: KommoConnectionDetailDto["status"],
): string {
  if (status === "active") return "success";
  if (status === "paused") return "neutral";
  return "warn";
}

function catalogStateLabel(
  state: KommoConnectionDetailDto["catalogState"],
): string {
  if (state === "fresh") return "Catálogo atualizado";
  if (state === "stale") return "Catálogo desatualizado";
  if (state === "error") return "Falha ao atualizar catálogo";
  return "Catálogo não carregado";
}

function catalogStateTone(
  state: KommoConnectionDetailDto["catalogState"],
): string {
  if (state === "fresh") return "success";
  if (state === "stale" || state === "error") return "warn";
  return "neutral";
}

function routeOptionsFor(channels: InboundWebhookChannelDto[]): RouteOption[] {
  return crmChannelOptionsFor(channels, kommoChannelBindingMessages);
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

function groupPipelines(pipelines: KommoConnectionPipelineRowDto[]): {
  id: string;
  name: string;
  statuses: { id: string; name: string; available: boolean }[];
}[] {
  const groups = new Map<
    string,
    { id: string; name: string; statuses: { id: string; name: string; available: boolean }[] }
  >();

  for (const row of pipelines) {
    const group = groups.get(row.id) ?? { id: row.id, name: row.name, statuses: [] };
    group.statuses.push({
      id: row.status.id,
      name: row.status.name,
      available: row.available,
    });
    groups.set(row.id, group);
  }

  return [...groups.values()];
}

export function parseMoneyToCents(value: string): number | null {
  const raw = value.trim();
  if (!raw) return null;

  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw;
  const amount = Number(normalized);

  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
}

function moneyLabel(valueCents: number | null, currency: string | null): string {
  if (valueCents == null) return "Valor não informado";

  return formatMoney(valueCents, currency);
}

function formatDateTime(value: string | null): string {
  if (!value) return "nunca";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "data indisponível";

  return date.toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: displayTimeZone,
  });
}

function connectionIdentity(connection: KommoConnectionDetailDto): string {
  return JSON.stringify([
    connection.workspaceId,
    connection.id,
    connection.verifiedAccountId,
    connection.accountOrigin,
    connection.accountSubdomain,
  ]);
}

type ConfirmContext = { key: string; epoch: number; fingerprint: string };

/**
 * Inline confirmation exposed as a non-modal alertdialog: focus moves to the
 * cancel button on open, Escape cancels, and focus returns to the element that
 * opened it.
 */
function ConfirmBox({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>("[data-confirm-cancel]")?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    }
  }

  return (
    <div
      ref={ref}
      className="provider-conversion-inline-confirm"
      role="alertdialog"
      aria-labelledby={titleId}
      onKeyDown={handleKeyDown}
    >
      <span id={titleId}>{title}</span>
      {children}
    </div>
  );
}

/**
 * Kommo é um gatilho de conversão opt-in (mudança de estágio no CRM) que liga
 * cada conexão a canais/rotas já autorizados. Só um negócio Kommo ligado a um
 * lead que já existe no WppTrack converte; o resto fica apenas na auditoria.
 * Salvar uma regra ou receber o webhook da Kommo (202) nunca confirma entrega
 * ao Meta.
 */
export function KommoConversionPanel({
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
  rotateWebhookAction,
  refreshCatalogAction,
  getConnectionAction,
  listConnectionsAction,
  createRuleAction,
  updateRuleAction,
  deleteRuleAction,
  listEventsAction,
}: KommoConversionPanelProps) {
  const router = useRouter();
  const localUnsettled = useRef<KommoUnsettledOperations>({
    creation: false,
    connectionIds: new Set<string>(),
  });
  const unsettled = unsettledOperations ?? localUnsettled.current;
  const [connectOpen, setConnectOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [oneTimeWebhookUrl, setOneTimeWebhookUrl] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const webhookInputRef = useRef<HTMLInputElement>(null);
  const secretGuardRef = useRef(0);
  // Sticky for the rest of this mount once any mutation reports a structured
  // auth failure — a session that expired mid-action does not get trusted
  // again without a full reload.
  const [authFailureDetected, setAuthFailureDetected] = useState(false);
  // The server answered 423 to a write: the server is the authority.
  const [serverLicenseLocked, setServerLicenseLocked] = useState(false);
  const [createdConnections, setCreatedConnections] = useState<KommoConnectionDetailDto[]>([]);
  const [reconciledList, setReconciledList] = useState<KommoConnectionDetailDto[] | null>(null);
  const [creationUnresolved, setCreationUnresolved] = useState(unsettled.creation);
  const creationBlockedRef = useRef(unsettled.creation);
  const connectInFlightRef = useRef(false);
  const [secretConnection, setSecretConnection] = useState<KommoConnectionDetailDto | null>(null);
  const serverConnections = reconciledList ?? connections;
  const visibleConnections = [
    ...createdConnections.filter(
      (created) => !serverConnections.some((item) => item.id === created.id),
    ),
    ...serverConnections,
  ];
  useEffect(() => {
    setReconciledList(null);
    setCreatedConnections((current) =>
      current.filter((created) => !connections.some((item) => item.id === created.id)),
    );
  }, [connections]);
  const secretIdentityChanged =
    secretConnection !== null &&
    visibleConnections.some(
      (item) =>
        item.id === secretConnection.id &&
        connectionIdentity(item) !== connectionIdentity(secretConnection),
    );
  const routeOptions = routeOptionsFor(allChannels);
  // A failed/unauthorized load must never be presented as "no connections
  // yet": that would invite creating a duplicate connection blindly.
  const loadFailed = loadState === "error" || loadState === "forbidden";
  const locked = licenseLocked || serverLicenseLocked;
  const canMutate = canManage && !locked && !loadFailed && !authFailureDetected;
  const canMutateRef = useRef(canMutate);
  canMutateRef.current = canMutate;
  // Computed at render time: any one of these must hide a previously shown
  // credential-derived secret in the SAME render that detects it.
  const secretMustStayHidden =
    loadFailed ||
    !canManage ||
    authFailureDetected ||
    creationUnresolved ||
    secretIdentityChanged;

  useEffect(() => {
    if (secretMustStayHidden) {
      secretGuardRef.current += 1;
      setOneTimeWebhookUrl(null);
      setSecretConnection(null);
      setCopiedUrl(false);
    }
  }, [secretMustStayHidden]);

  const secretApi: SecretApi = {
    ticket: () => secretGuardRef.current,
    show: (url, connection, ticket) => {
      if (ticket !== secretGuardRef.current) return;
      setOneTimeWebhookUrl(url);
      setCopiedUrl(false);
      if (connection) setSecretConnection(connection);
    },
    invalidate: () => {
      secretGuardRef.current += 1;
      setOneTimeWebhookUrl(null);
      setCopiedUrl(false);
    },
  };

  function applyResult(result: KommoActionResult | KommoRuleActionResult) {
    setNotice({ tone: result.ok ? "success" : "error", message: result.message });
    if (result.licenseLocked) setServerLicenseLocked(true);
    if (result.authFailure === "unauthorized") {
      secretApi.invalidate();
      setAuthFailureDetected(true);
    }
  }

  async function copyUrl() {
    const value = oneTimeWebhookUrl;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedUrl(true);
      setNotice({ tone: "success", message: "URL do webhook copiada." });
    } catch {
      setCopiedUrl(false);
      webhookInputRef.current?.focus();
      webhookInputRef.current?.select();
      setNotice({
        tone: "error",
        message:
          "Não foi possível copiar automaticamente. A URL está selecionada: copie manualmente.",
      });
    }
  }

  async function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      pending ||
      connectInFlightRef.current ||
      creationBlockedRef.current ||
      !canMutateRef.current
    ) {
      return;
    }

    const form = event.currentTarget;
    const built = buildConnectionPayload(new FormData(form));

    if (!built.ok) {
      setNotice({ tone: "error", message: built.message });
      return;
    }

    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("payload", JSON.stringify(built.payload));

    const ticket = secretApi.ticket();
    connectInFlightRef.current = true;
    setPending("connect");
    setNotice(null);
    try {
      const result = await createConnectionAction(formData);
      applyResult(result);

      if (result.ok) {
        form.reset();
        setConnectOpen(false);
        if (result.connection) {
          const createdConnection = result.connection;
          setCreatedConnections((current) => [...current, createdConnection]);
        }
        if (result.oneTimeWebhook) {
          secretApi.show(
            result.oneTimeWebhook.webhookUrl,
            result.connection ?? null,
            ticket,
          );
        }
      } else if (result.authFailure || result.outcomeUnknown) {
        // Never keep a raw token in the DOM after a permission failure or an
        // unknown outcome.
        form.reset();
      }
      if (!result.ok) await reconcileCreation(Boolean(result.outcomeUnknown));
      router.refresh();
    } catch {
      applyResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE });
      form.reset();
      await reconcileCreation(true);
      router.refresh();
    } finally {
      connectInFlightRef.current = false;
      setPending(null);
    }
  }

  async function reconcileCreation(unknownExecution: boolean) {
    // A deterministic refusal (validation, 423, auth) wrote nothing.
    if (!unknownExecution) return;
    unsettled.creation = true;
    creationBlockedRef.current = true;
    secretApi.invalidate();
    setCreationUnresolved(true);
    // A lost POST response may still be running. Even a successful empty
    // list cannot authorize another POST without a completion/idempotency
    // contract. Display a valid list, but keep creation blocked this mount.
    if (!listConnectionsAction) return;
    try {
      const result = await listConnectionsAction(workspaceId);
      if (result.ok) setReconciledList(result.connections);
      else if (result.reason === "unauthorized") setAuthFailureDetected(true);
    } catch {
      /* Remain blocked; never surface upstream detail. */
    }
  }

  const connectDisabled =
    pending === "connect" || creationUnresolved || authFailureDetected || locked;

  return (
    <section className="provider-conversion-panel kommo-conversion-panel">
      <header className="provider-conversion-heading">
        <div>
          <span className="eyebrow">Mudança de estágio no CRM</span>
          <h3>Kommo CRM</h3>
          <p className="muted">
            Gatilho opcional: dispare conversões quando um negócio existente muda de
            estágio na Kommo. Só fica ativo para quem conectar a conta.
          </p>
        </div>
        <div className="provider-conversion-heading-actions">
          <span className="event-chip neutral">
            {loadFailed
              ? "Indisponível"
              : `${visibleConnections.length} ${visibleConnections.length === 1 ? "conexão" : "conexões"}`}
          </span>
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
              {connectOpen ? "Fechar" : "Conectar Kommo"}
            </button>
          ) : null}
        </div>
      </header>

      {!canManage && !loadFailed ? (
        <p className="action-note" role="status">
          Somente o proprietário do workspace gerencia a integração Kommo.
        </p>
      ) : null}

      {canManage && locked ? (
        <p className="action-note warn" role="status">
          {LICENSE_LOCKED_NOTE}
        </p>
      ) : null}

      {loadFailed ? (
        <div className="feedback-banner error" role="alert">
          <span>
            {loadState === "forbidden"
              ? "Sua sessão não tem permissão para ver as conexões Kommo (somente o proprietário do workspace), ou expirou. Atualize a página."
              : "Não foi possível carregar as conexões Kommo. Tente novamente."}
          </span>
          <button className="button subtle" type="button" onClick={() => router.refresh()}>
            Tentar novamente
          </button>
        </div>
      ) : null}

      {oneTimeWebhookUrl && !secretMustStayHidden ? (
        <div className="provider-conversion-secret-group">
          <div
            className="provider-conversion-secret"
            data-presentation-sensitive-action="true"
          >
            <div>
              <span className="micro-label">URL visível nesta sessão</span>
              <strong>Webhook Kommo</strong>
            </div>
            <input
              ref={webhookInputRef}
              readOnly
              value={oneTimeWebhookUrl}
              aria-label="URL do webhook Kommo"
              data-presentation-sensitive-field="true"
            />
            <button className="button" type="button" onClick={() => void copyUrl()}>
              {copiedUrl ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <Copy size={15} aria-hidden="true" />
              )}
              {copiedUrl ? "Copiada" : "Copiar URL"}
            </button>
            <button
              className="icon-button"
              type="button"
              title="Ocultar"
              aria-label="Ocultar URL"
              onClick={() => {
                setOneTimeWebhookUrl(null);
                setCopiedUrl(false);
              }}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <p className="action-note">
            Cole essa URL completa no webhook de mudança de estágio da Kommo
            (Configurações {">"} Webhooks). A autenticação já vai embutida na URL; não
            há header ou token separado. Ela fica visível enquanto esta página
            permanecer aberta: ao ocultar ou recarregar, só é possível gerar uma nova
            URL (a anterior deixa de funcionar).
          </p>
        </div>
      ) : null}

      <div aria-live="polite" role="status" className="sr-only" data-testid="kommo-live-region">
        {notice?.tone === "success" ? notice.message : ""}
      </div>
      {notice ? (
        <div
          className={`feedback-banner ${notice.tone}`}
          role={notice.tone === "error" ? "alert" : undefined}
        >
          <span>{notice.message}</span>
        </div>
      ) : null}

      {creationUnresolved ? (
        <p className="action-note" role="status">
          Resultado da criação não confirmado. Uma nova tentativa fica bloqueada para
          evitar conexões duplicadas; recarregue a página para conferir a lista.
        </p>
      ) : null}

      {connectOpen && canManage && !loadFailed ? (
        <form
          className="provider-conversion-builder"
          onSubmit={handleConnect}
          aria-label="Conectar conta Kommo"
        >
          <div className="provider-conversion-base-fields">
            <label>
              <span className="field-label">Endereço da conta Kommo</span>
              <input
                name="accountOrigin"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://suaempresa.kommo.com"
                disabled={connectDisabled}
                required
              />
            </label>
            <label>
              <span className="field-label">Token de acesso de longa duração</span>
              <input
                name="accessToken"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Token gerado na integração privada da Kommo"
                disabled={connectDisabled}
                required
              />
            </label>
          </div>

          <p className="action-note">
            Basta o endereço e o token. Ao conectar, o catálogo de pipelines e estágios
            é carregado automaticamente e você recebe a URL do webhook para colar na
            Kommo. Os canais autorizados são escolhidos depois, na conexão.
          </p>

          <div className="provider-conversion-builder-footer">
            <button className="button primary" type="submit" disabled={connectDisabled}>
              <Check size={15} aria-hidden="true" />
              {pending === "connect" ? "Conectando…" : "Conectar Kommo"}
            </button>
          </div>
        </form>
      ) : null}

      {loadFailed || (!canManage && visibleConnections.length === 0) ? null : visibleConnections.length === 0 ? (
        <div className="provider-conversion-empty">
          <Database size={18} aria-hidden="true" />
          <span>
            Nenhuma conexão Kommo ainda. Conecte a conta para liberar o gatilho de
            mudança de estágio.
          </span>
        </div>
      ) : (
        <div className="provider-conversion-rule-list">
          {visibleConnections.map((connection) => (
            <KommoConnectionCard
              key={connection.id}
              unsettledOperations={unsettled}
              locallyCreated={createdConnections.some((created) => created.id === connection.id)}
              workspaceId={workspaceId}
              connection={connection}
              routeOptions={routeOptions}
              allChannels={allChannels}
              canManage={canMutate}
              authLost={authFailureDetected}
              licenseLocked={locked}
              ownerView={canManage}
              pending={pending}
              setPending={setPending}
              onResult={applyResult}
              secret={secretApi}
              onRefresh={() => router.refresh()}
              replaceCredentialAction={replaceCredentialAction}
              setStatusAction={setStatusAction}
              setChannelBindingsAction={setChannelBindingsAction}
              rotateWebhookAction={rotateWebhookAction}
              refreshCatalogAction={refreshCatalogAction}
              getConnectionAction={getConnectionAction}
              createRuleAction={createRuleAction}
              updateRuleAction={updateRuleAction}
              deleteRuleAction={deleteRuleAction}
              listEventsAction={listEventsAction}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function buildConnectionPayload(
  data: FormData,
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string } {
  const accountOrigin = String(data.get("accountOrigin") ?? "").trim();
  const accessToken = String(data.get("accessToken") ?? "").trim();

  if (!accountOrigin || !accessToken) {
    return { ok: false, message: INVALID_FORM_MESSAGE };
  }

  let subdomain = "";
  try {
    subdomain = new URL(accountOrigin).hostname.split(".")[0] ?? "";
  } catch {
    subdomain = "";
  }

  const payload = {
    displayName: `Kommo ${subdomain || "CRM"}`,
    accountOrigin,
    accessToken,
    allowedChannelRouteIds: [] as string[],
  };
  const parsed = kommoConnectionCreateInputSchema.safeParse(payload);

  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === "accessToken") {
      return {
        ok: false,
        message: "Informe o token de acesso completo (mínimo de 16 caracteres).",
      };
    }
    if (field === "accountOrigin") {
      return {
        ok: false,
        message:
          "Informe apenas o endereço HTTPS da conta Kommo, por exemplo https://suaempresa.kommo.com.",
      };
    }
    return { ok: false, message: INVALID_FORM_MESSAGE };
  }

  return { ok: true, payload: parsed.data };
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
  // A route this connection was authorized for can vanish entirely from
  // allChannels. Surface it as its own always-removable entry so "Salvar
  // canais" never keeps silently resending an id that resolves to nothing.
  const missingSelectedIds = controlled
    ? selected!.filter((routeId) => !options.some((option) => option.routeId === routeId))
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
            // A route already saved must stay removable even after it stops
            // being eligible — only a *new* ineligible route is locked out.
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
                  <PresentationMask placeholder="Canal oculto">{option.label}</PresentationMask>
                  {!option.eligible ? " (indisponível)" : ""}
                  {!option.eligible && option.reason ? (
                    <small className="action-note"> {option.reason}</small>
                  ) : null}
                </span>
              </label>
            );
          })}
          {missingSelectedIds.map((routeId) => (
            <label key={routeId} title="Canal ou rota não encontrado nos canais do workspace">
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
        O Kommo é apenas o CRM: escolha quais números de WhatsApp deste
        workspace (de qualquer provedor) podem ter seus leads associados por
        telefone. O número precisa estar ativo e com destino Meta verificado.
        Sem número autorizado, nenhum movimento é associado.
      </small>
    </fieldset>
  );
}

function KommoConnectionCard({
  locallyCreated,
  unsettledOperations,
  workspaceId,
  connection,
  routeOptions,
  allChannels,
  canManage,
  authLost,
  licenseLocked,
  ownerView,
  pending,
  setPending,
  onResult,
  secret,
  onRefresh,
  replaceCredentialAction,
  setStatusAction,
  setChannelBindingsAction,
  rotateWebhookAction,
  refreshCatalogAction,
  createRuleAction,
  updateRuleAction,
  deleteRuleAction,
  getConnectionAction,
  listEventsAction,
}: {
  locallyCreated: boolean;
  unsettledOperations: KommoUnsettledOperations;
  workspaceId: string;
  connection: KommoConnectionDetailDto;
  routeOptions: RouteOption[];
  allChannels: InboundWebhookChannelDto[];
  canManage: boolean;
  authLost: boolean;
  licenseLocked: boolean;
  ownerView: boolean;
  pending: string | null;
  setPending: (value: string | null) => void;
  onResult: (result: KommoActionResult | KommoRuleActionResult) => void;
  secret: SecretApi;
  onRefresh: () => void;
  replaceCredentialAction: ConnectionAction;
  setStatusAction: ConnectionAction;
  setChannelBindingsAction: ConnectionAction;
  rotateWebhookAction: ConnectionAction;
  refreshCatalogAction: ConnectionAction;
  getConnectionAction: GetConnectionAction;
  createRuleAction: RuleAction;
  updateRuleAction: RuleAction;
  deleteRuleAction: RuleAction;
  listEventsAction: ListEventsAction;
}) {
  void onRefresh;
  // Local operation and read epochs order client requests only. Parent
  // updatedAt does not version rules. Props after a local write are signals
  // for an explicit scoped read, never proof of aggregate freshness.
  const [canonical, setCanonical] = useState(connection);
  const canonicalRef = useRef(connection);
  const [certainty, setCertaintyState] = useState<"confirmed" | "uncertain">("confirmed");
  const certaintyRef = useRef<"confirmed" | "uncertain">("confirmed");
  const epochRef = useRef(locallyCreated ? 1 : 0);
  const readEpochRef = useRef(0);
  const retiredSnapshots = useRef(new Set<string>());
  const retiredIdentities = useRef(new Set<string>());
  const queuedProp = useRef<KommoConnectionDetailDto | null>(null);
  const [operationUnsettled, setOperationUnsettled] = useState(
    unsettledOperations.connectionIds.has(connection.id),
  );
  const operationUnsettledRef = useRef(unsettledOperations.connectionIds.has(connection.id));
  const canManageRef = useRef(canManage);
  canManageRef.current = canManage;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  function setCertainty(next: "confirmed" | "uncertain") {
    certaintyRef.current = next;
    setCertaintyState(next);
  }

  function reportResult(result: KommoActionResult | KommoRuleActionResult) {
    if (result.outcomeUnknown) {
      unsettledOperations.connectionIds.add(connection.id);
      operationUnsettledRef.current = true;
      setOperationUnsettled(true);
      secret.invalidate();
    }
    onResult(result);
  }

  function retireCurrent(next: KommoConnectionDetailDto) {
    if (JSON.stringify(next) !== JSON.stringify(canonicalRef.current)) {
      retiredSnapshots.current.add(JSON.stringify(canonicalRef.current));
    }
    if (connectionIdentity(next) !== connectionIdentity(canonicalRef.current)) {
      retiredIdentities.current.add(connectionIdentity(canonicalRef.current));
    }
  }

  function adoptCanonical(next: KommoConnectionDetailDto, confirmed = true) {
    retireCurrent(next);
    const accountChanged = connectionIdentity(next) !== connectionIdentity(canonicalRef.current);
    canonicalRef.current = next;
    setCanonical(next);
    setEditedRouteIds(next.allowedChannelRouteIds);
    setCertainty(confirmed && !queuedProp.current ? "confirmed" : "uncertain");
    if (accountChanged) secret.invalidate();
  }

  /** Call at the START of every mutation attempt, before any await. */
  function bumpEpoch(): number {
    epochRef.current += 1;
    return epochRef.current;
  }

  // Backs a passive reconciliation triggered merely by receiving an external
  // prop. It never hides a visible secret: only a real identity change does.
  function bumpEpochForPassiveReconciliation(): number {
    epochRef.current += 1;
    return epochRef.current;
  }

  function mergeRuleIntoCanonical(rule: KommoConnectionDetailDto["rules"][number]) {
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
      // Novel content is not necessarily newer. Keep genuine external changes
      // visible provisionally, but do not clear uncertainty with it. A
      // same-account refresh must never hide an already-shown secret; only an
      // actual account/workspace identity change may.
      if (connectionIdentity(connection) !== connectionIdentity(canonicalRef.current)) {
        secret.invalidate();
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
      void reconcileFromServer(bumpEpochForPassiveReconciliation());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, pending]);

  async function reconcileFromServer(myEpoch: number) {
    const myReadEpoch = ++readEpochRef.current;
    // Inconclusive from the moment reconciliation is needed — BEFORE awaiting
    // the read. A pending GET must never leave a stale "Catálogo atualizado".
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
    // A newer local operation started while this GET was in flight: this
    // response is superseded/out-of-order and is discarded outright.
    if (epochRef.current !== myEpoch || readEpochRef.current !== myReadEpoch) return;
    if (result.ok) {
      // Reject known contradictions even at equal timestamps.
      if (
        result.connection.updatedAt < canonicalRef.current.updatedAt ||
        (JSON.stringify(result.connection) !== JSON.stringify(canonicalRef.current) &&
          retiredSnapshots.current.has(JSON.stringify(result.connection))) ||
        (connectionIdentity(result.connection) !== connectionIdentity(canonicalRef.current) &&
          retiredIdentities.current.has(connectionIdentity(result.connection)) &&
          result.connection.updatedAt <= canonicalRef.current.updatedAt)
      ) {
        return;
      }
      adoptCanonical(result.connection);
    } else {
      setCertainty("uncertain");
      if (result.reason === "unauthorized") {
        reportResult({ ok: false, message: SESSION_LOST_MESSAGE, authFailure: "unauthorized" });
        secret.invalidate();
      }
    }
  }

  const [credentialOpen, setCredentialOpen] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [createRuleOpen, setCreateRuleOpen] = useState(false);
  const [editedRouteIds, setEditedRouteIds] = useState<string[]>(connection.allowedChannelRouteIds);
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const confirmContext = useRef<ConfirmContext | null>(null);
  const [pendingCreatePayload, setPendingCreatePayload] = useState<Record<string, unknown> | null>(
    null,
  );
  const [pendingCredentialPayload, setPendingCredentialPayload] =
    useState<Record<string, unknown> | null>(null);
  const credentialFormRef = useRef<HTMLFormElement>(null);

  const refreshKey = `refresh-${canonical.id}`;
  const statusKey = `status-${canonical.id}`;
  const resumeConnectionKey = `resume-connection-${canonical.id}`;
  const catalogConfirmKey = `catalog-confirm-${canonical.id}`;
  const rotateKey = `rotate-${canonical.id}`;
  const credentialKey = `credential-${canonical.id}`;
  const credentialConfirmKey = `credential-confirm-${canonical.id}`;
  const channelsKey = `channels-${canonical.id}`;
  const createRuleKey = `create-rule-${canonical.id}`;
  const createRuleConfirmKey = `create-rule-confirm-${canonical.id}`;

  const pipelineGroups = groupPipelines(canonical.pipelines);
  const stateUnresolved = certainty === "uncertain";

  /** Opens a confirmation bound to the permission/state/epoch it was shown under. */
  function openConfirm(key: string) {
    confirmContext.current = {
      key,
      epoch: epochRef.current,
      fingerprint: JSON.stringify(canonicalRef.current),
    };
    setConfirmingKey(key);
  }

  function closeConfirm() {
    confirmContext.current = null;
    setConfirmingKey(null);
  }

  /** Final-handler recheck: identity, permission, license, uncertainty, epoch. */
  function confirmStillValid(key: string): boolean {
    const context = confirmContext.current;
    return Boolean(
      context &&
        context.key === key &&
        context.epoch === epochRef.current &&
        context.fingerprint === JSON.stringify(canonicalRef.current) &&
        canManageRef.current &&
        !pendingRef.current &&
        !operationUnsettledRef.current &&
        certaintyRef.current === "confirmed",
    );
  }

  function runConfirmed(key: string, run: () => void) {
    if (!confirmStillValid(key)) {
      closeConfirm();
      setPendingCreatePayload(null);
      setPendingCredentialPayload(null);
      onResult({ ok: false, message: STALE_APPROVAL_MESSAGE });
      return;
    }
    run();
  }

  // A confirmation belongs to the state it was opened against. A later read
  // that restores certainty cannot restore consent to that draft.
  useEffect(() => {
    if (confirmingKey && !confirmStillValid(confirmingKey)) {
      closeConfirm();
      setPendingCreatePayload(null);
      setPendingCredentialPayload(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonical, canManage, operationUnsettled, stateUnresolved, confirmingKey]);

  // An audit read answered 401/403: route it through the parent's sticky
  // auth-loss handler, then retire consent and in-flight reads of this card.
  function handleAuditUnauthorized() {
    bumpEpoch();
    closeConfirm();
    setPendingCreatePayload(null);
    setPendingCredentialPayload(null);
    reportResult({ ok: false, message: SESSION_LOST_MESSAGE, authFailure: "unauthorized" });
    secret.invalidate();
  }

  const canActivate = canonical.credentialHealthy && canonical.verifiedAccountId;
  // Dispatch requires status+health+catalog freshness together AND the rule
  // active+production. Resume, credential replace or a plain catalog refresh
  // can make every dormant production rule dispatch again with no separate
  // rule-level action, so those paths get the same conservative confirmation.
  // Uncertainty also counts as "not dispatching".
  const liveProductionRuleCount = canonical.rules.filter(
    (rule) => rule.active && rule.mode === "production",
  ).length;
  const connectionDispatching =
    certainty === "confirmed" &&
    !operationUnsettled &&
    canonical.status === "active" &&
    canActivate &&
    canonical.catalogState === "fresh";
  const resumeWouldDispatch = liveProductionRuleCount > 0 && !connectionDispatching;

  function handleRefreshCatalogClick() {
    if (pending || operationUnsettledRef.current || !canManageRef.current) return;
    if (resumeWouldDispatch) {
      openConfirm(catalogConfirmKey);
      return;
    }
    void refreshCatalog();
  }

  async function refreshCatalog() {
    if (pending || operationUnsettledRef.current || !canManageRef.current) return;
    const myEpoch = bumpEpoch();
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("connectionId", canonicalRef.current.id);

    closeConfirm();
    setPending(refreshKey);
    // Non-atomic server-side: inconclusive from the moment we start.
    setCertainty("uncertain");
    try {
      const result = await refreshCatalogAction(formData);
      reportResult(result);
      if (epochRef.current !== myEpoch) return;
      if (result.ok && result.connection) {
        adoptCanonical(result.connection);
      } else {
        await reconcileFromServer(myEpoch);
      }
    } catch {
      if (epochRef.current !== myEpoch) return;
      reportResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE, outcomeUnknown: true });
      await reconcileFromServer(myEpoch);
    } finally {
      setPending(null);
    }
  }

  async function toggleStatus() {
    if (pending || operationUnsettledRef.current || !canManageRef.current) return;
    const activating = canonical.status === "paused";
    if (!activating) {
      openConfirm(statusKey);
      return;
    }
    // Resuming a connection that still has production rules dispatches them
    // again immediately — a production-enable path that needs the same gate.
    if (resumeWouldDispatch) {
      openConfirm(resumeConnectionKey);
      return;
    }

    await runStatusChange("active");
  }

  async function runStatusChange(status: "active" | "paused") {
    if (pending || operationUnsettledRef.current || stateUnresolved || !canManageRef.current) {
      return;
    }
    const myEpoch = bumpEpoch();
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("connectionId", canonicalRef.current.id);
    formData.set("status", status);

    closeConfirm();
    setPending(statusKey);
    // A reported failure never safely means nothing was persisted: the request
    // can commit and then lose its response. Resolve via an explicit GET.
    setCertainty("uncertain");
    try {
      const result = await setStatusAction(formData);
      reportResult(result);
      if (epochRef.current !== myEpoch) return;
      if (result.ok && result.connection) {
        adoptCanonical(result.connection);
      } else {
        await reconcileFromServer(myEpoch);
      }
    } catch {
      if (epochRef.current !== myEpoch) return;
      reportResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE, outcomeUnknown: true });
      await reconcileFromServer(myEpoch);
    } finally {
      setPending(null);
    }
  }

  async function rotateWebhook() {
    if (pending || operationUnsettledRef.current || !canManageRef.current) return;
    const myEpoch = bumpEpoch();
    setCertainty("uncertain");
    closeConfirm();
    // The moment rotation succeeds server-side the old URL is dead, even if
    // this request then fails to resolve cleanly: it must never look current.
    secret.invalidate();
    const ticket = secret.ticket();
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("connectionId", canonicalRef.current.id);

    setPending(rotateKey);
    try {
      const result = await rotateWebhookAction(formData);
      reportResult(result);
      if (epochRef.current !== myEpoch) return;
      if (result.ok && result.oneTimeWebhook) {
        setCertainty("confirmed");
        secret.show(result.oneTimeWebhook.webhookUrl, canonicalRef.current, ticket);
      } else {
        await reconcileFromServer(myEpoch);
      }
    } catch {
      reportResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE, outcomeUnknown: true });
      await reconcileFromServer(myEpoch);
    } finally {
      setPending(null);
    }
  }

  function handleCredentialSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      pending ||
      operationUnsettledRef.current ||
      !canManageRef.current ||
      confirmingKey === credentialConfirmKey
    ) {
      return;
    }

    const data = new FormData(event.currentTarget);
    const accountOrigin = String(data.get("accountOrigin") ?? "").trim();
    const accessToken = String(data.get("accessToken") ?? "").trim();

    if (!accessToken) {
      onResult({ ok: false, message: "Informe o novo token de acesso." });
      return;
    }

    const parsed = kommoConnectionCredentialReplaceInputSchema.safeParse({
      accessToken,
      ...(accountOrigin ? { accountOrigin } : {}),
    });
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      onResult({
        ok: false,
        message:
          field === "accessToken"
            ? "Informe o token de acesso completo (mínimo de 16 caracteres)."
            : "Informe apenas o endereço HTTPS da conta Kommo, por exemplo https://suaempresa.kommo.com.",
      });
      return;
    }
    const payload = parsed.data as Record<string, unknown>;

    // replaceCredential leaves existing production rules untouched, so they
    // come back online the instant health recovers. Gate that possibility.
    if (resumeWouldDispatch) {
      setPendingCredentialPayload(payload);
      openConfirm(credentialConfirmKey);
      return;
    }

    void submitCredential(payload);
  }

  async function submitCredential(payload: Record<string, unknown>) {
    if (pending || operationUnsettledRef.current || !canManageRef.current) return;
    const myEpoch = bumpEpoch();
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("connectionId", canonicalRef.current.id);
    formData.set("payload", JSON.stringify(payload));

    closeConfirm();
    setPending(credentialKey);
    // replaceCredential commits its own transaction BEFORE refreshing the
    // catalog, which can fail afterward: the write may already be underway.
    setCertainty("uncertain");
    try {
      const result = await replaceCredentialAction(formData);
      reportResult(result);
      if (result.ok || result.authFailure || result.outcomeUnknown) {
        credentialFormRef.current?.reset();
      }
      if (result.ok) {
        setCredentialOpen(false);
        setPendingCredentialPayload(null);
      }
      if (epochRef.current !== myEpoch) return;
      if (result.ok && result.connection) {
        adoptCanonical(result.connection);
      } else {
        await reconcileFromServer(myEpoch);
      }
    } catch {
      credentialFormRef.current?.reset();
      if (epochRef.current !== myEpoch) return;
      reportResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE, outcomeUnknown: true });
      await reconcileFromServer(myEpoch);
    } finally {
      setPending(null);
    }
  }

  async function saveChannelBindings() {
    if (pending || operationUnsettledRef.current || stateUnresolved || !canManageRef.current) {
      return;
    }
    const parsed = kommoConnectionChannelBindingsInputSchema.safeParse({
      allowedChannelRouteIds: editedRouteIds,
    });
    if (!parsed.success) {
      onResult({ ok: false, message: INVALID_FORM_MESSAGE });
      return;
    }
    const myEpoch = bumpEpoch();
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("connectionId", canonicalRef.current.id);
    formData.set("payload", JSON.stringify(parsed.data));

    setPending(channelsKey);
    setCertainty("uncertain");
    try {
      const result = await setChannelBindingsAction(formData);
      reportResult(result);
      if (epochRef.current !== myEpoch) return;
      if (result.ok) {
        setChannelsOpen(false);
        if (result.connection) {
          adoptCanonical(result.connection);
        } else {
          await reconcileFromServer(myEpoch);
        }
      } else {
        await reconcileFromServer(myEpoch);
      }
    } catch {
      if (epochRef.current !== myEpoch) return;
      reportResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE, outcomeUnknown: true });
      await reconcileFromServer(myEpoch);
    } finally {
      setPending(null);
    }
  }

  function handleCreateRuleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !canManageRef.current ||
      pending ||
      operationUnsettledRef.current ||
      confirmingKey === createRuleConfirmKey
    ) {
      return;
    }

    const payload = buildRulePayload(new FormData(event.currentTarget), { isUpdate: false });

    if (!payload) {
      onResult({ ok: false, message: INVALID_FORM_MESSAGE });
      return;
    }

    const validation = validateMergedRuleCandidate(undefined, payload);
    if (!validation.ok) {
      onResult({ ok: false, message: validation.message });
      return;
    }

    // EVERY path into production — including creation — needs an explicit
    // confirmation; this issues zero mutations until the user confirms.
    if (payload.mode === "production") {
      if (stateUnresolved) {
        onResult({
          ok: false,
          message:
            "Estado da conexão não confirmado; aguarde a confirmação antes de ativar envio.",
        });
        return;
      }
      setPendingCreatePayload(payload);
      openConfirm(createRuleConfirmKey);
      return;
    }

    void submitCreateRule(payload);
  }

  async function submitCreateRule(payload: Record<string, unknown>) {
    if (!canManageRef.current || pending || operationUnsettledRef.current) return;
    const myEpoch = bumpEpoch();
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("connectionId", canonicalRef.current.id);
    formData.set("payload", JSON.stringify(payload));

    closeConfirm();
    setPending(createRuleKey);
    setCertainty("uncertain");
    try {
      const result = await createRuleAction(formData);
      reportResult(result);
      if (epochRef.current !== myEpoch) return;
      if (result.ok) {
        setCreateRuleOpen(false);
        setPendingCreatePayload(null);
        // The create result has a `.rule`, never a `.connection`.
        if (result.rule) {
          mergeRuleIntoCanonical(result.rule);
        } else {
          await reconcileFromServer(myEpoch);
        }
      } else {
        await reconcileFromServer(myEpoch);
      }
    } catch {
      if (epochRef.current !== myEpoch) return;
      reportResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE, outcomeUnknown: true });
      await reconcileFromServer(myEpoch);
    } finally {
      setPending(null);
    }
  }

  const authorizedLabels = resolveRouteLabels(allChannels, canonical.allowedChannelRouteIds);

  return (
    <article className="provider-conversion-rule kommo-connection-card">
      <div className="provider-conversion-rule-main">
        <div className="provider-conversion-rule-icon">
          <Database size={17} aria-hidden="true" />
        </div>
        <div className="provider-conversion-rule-copy">
          <div className="provider-conversion-rule-title">
            <strong>{canonical.displayName}</strong>
            <span className={`event-chip ${connectionStatusTone(canonical.status)}`}>
              {connectionStatusLabel(canonical.status)}
            </span>
            <span
              className={`event-chip ${stateUnresolved ? "warn" : catalogStateTone(canonical.catalogState)}`}
            >
              {stateUnresolved
                ? "Estado não confirmado"
                : operationUnsettled
                  ? "Estado lido; ação não concluída"
                  : catalogStateLabel(canonical.catalogState)}
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
            {canonical.lastErrorCode ? ` · último erro: ${canonical.lastErrorCode}` : ""}
          </small>
        </div>
      </div>

      {canManage ? (
        <div className="provider-conversion-rule-actions">
          <button
            className="icon-button"
            type="button"
            title={canonical.status === "paused" ? "Retomar conexão" : "Pausar conexão"}
            aria-label={
              canonical.status === "paused"
                ? `Retomar conexão ${canonical.displayName}`
                : `Pausar conexão ${canonical.displayName}`
            }
            disabled={
              Boolean(pending) ||
              operationUnsettled ||
              stateUnresolved ||
              (canonical.status === "paused" && !canActivate)
            }
            onClick={() => void toggleStatus()}
          >
            {canonical.status === "paused" ? (
              <Play size={15} aria-hidden="true" />
            ) : (
              <Pause size={15} aria-hidden="true" />
            )}
          </button>
          <button
            className="icon-button"
            type="button"
            title="Atualizar catálogo"
            aria-label={`Atualizar catálogo de ${canonical.displayName}`}
            disabled={Boolean(pending) || operationUnsettled}
            onClick={handleRefreshCatalogClick}
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          <button
            className="icon-button"
            type="button"
            title="Gerar nova URL do webhook"
            aria-label={`Gerar nova URL do webhook de ${canonical.displayName}`}
            disabled={Boolean(pending) || operationUnsettled}
            onClick={() => openConfirm(rotateKey)}
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {ownerView && licenseLocked ? (
        <p className="action-note warn">{LICENSE_LOCKED_NOTE}</p>
      ) : null}

      {canManage && canonical.status === "paused" && !canActivate ? (
        <p className="action-note">
          Retome apenas depois de substituir a credencial: a conta ainda não foi
          verificada ou a credencial atual está inválida.
        </p>
      ) : null}

      {canManage && (stateUnresolved || operationUnsettled) ? (
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

      {operationUnsettled ? (
        <p className="action-note" role="status">
          Requisição sem resposta final. O estado lido pode mudar; novas alterações
          ficam bloqueadas para evitar repetir uma ação ainda em andamento. Recarregue
          a página depois de conferir o resultado.
        </p>
      ) : null}

      {canManage && stateUnresolved ? (
        <p className="action-note" role="status">
          Não foi possível confirmar o estado atual desta conexão após a última ação.
          Edições e ações de retomada ficam bloqueadas até confirmar.
        </p>
      ) : null}

      {canManage && confirmingKey === statusKey ? (
        <ConfirmBox
          title="Pausar a conexão Kommo? Novas mudanças de estágio param de gerar conversões até retomar."
          onCancel={closeConfirm}
        >
          <button className="button subtle" type="button" data-confirm-cancel onClick={closeConfirm}>
            Cancelar
          </button>
          <button
            className="button danger"
            type="button"
            disabled={Boolean(pending) || operationUnsettled}
            onClick={() => runConfirmed(statusKey, () => void runStatusChange("paused"))}
          >
            Pausar conexão
          </button>
        </ConfirmBox>
      ) : null}

      {canManage && confirmingKey === resumeConnectionKey ? (
        <ConfirmBox
          title={`Retomar esta conexão? ${liveProductionRuleCount} regra(s) já configurada(s) em produção volta(m) a enviar automaticamente para negócios com lead previamente reconhecido.`}
          onCancel={closeConfirm}
        >
          <button className="button subtle" type="button" data-confirm-cancel onClick={closeConfirm}>
            Cancelar
          </button>
          <button
            className="button primary"
            type="button"
            disabled={Boolean(pending) || operationUnsettled}
            onClick={() => runConfirmed(resumeConnectionKey, () => void runStatusChange("active"))}
          >
            Retomar envio automático
          </button>
        </ConfirmBox>
      ) : null}

      {canManage && confirmingKey === catalogConfirmKey ? (
        <ConfirmBox
          title={`Atualizar o catálogo pode restaurar a credencial e o catálogo como saudáveis e reativar imediatamente o envio automático de ${liveProductionRuleCount} regra(s) já configurada(s) em produção nesta conexão.`}
          onCancel={closeConfirm}
        >
          <button className="button subtle" type="button" data-confirm-cancel onClick={closeConfirm}>
            Cancelar
          </button>
          <button
            className="button primary"
            type="button"
            disabled={Boolean(pending) || operationUnsettled}
            onClick={() => runConfirmed(catalogConfirmKey, () => void refreshCatalog())}
          >
            Atualizar e ativar envio
          </button>
        </ConfirmBox>
      ) : null}

      {canManage && confirmingKey === rotateKey ? (
        <ConfirmBox
          title="A URL atual deste webhook para de funcionar. Você precisará colar a nova URL na Kommo."
          onCancel={closeConfirm}
        >
          <button className="button subtle" type="button" data-confirm-cancel onClick={closeConfirm}>
            Cancelar
          </button>
          <button
            className="button primary"
            type="button"
            disabled={Boolean(pending) || operationUnsettled}
            onClick={() => runConfirmed(rotateKey, () => void rotateWebhook())}
          >
            Gerar nova URL
          </button>
        </ConfirmBox>
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
              disabled={pending === channelsKey || stateUnresolved || operationUnsettled}
            />
            <div className="provider-conversion-builder-footer">
              {stateUnresolved ? (
                <small className="action-note">
                  Estado não confirmado após a última ação; atualize o catálogo ou
                  aguarde a confirmação antes de salvar canais.
                </small>
              ) : null}
              <button
                className="button primary"
                type="button"
                disabled={pending === channelsKey || stateUnresolved || operationUnsettled}
                onClick={() => void saveChannelBindings()}
              >
                <Check size={15} aria-hidden="true" />
                {pending === channelsKey ? "Salvando…" : "Salvar canais"}
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
              <Pencil size={13} aria-hidden="true" /> Token de acesso
            </strong>
          </summary>
          <form
            className="provider-conversion-builder"
            ref={credentialFormRef}
            onSubmit={handleCredentialSubmit}
            aria-label="Substituir credenciais da Kommo"
          >
            <p className="action-note">
              O token atual nunca é reexibido. Informe um novo token para substituir a
              credencial; o endereço só precisa ser preenchido se mudou.
            </p>
            <div className="provider-conversion-base-fields">
              <label>
                <span className="field-label">Novo endereço (opcional)</span>
                <input
                  name="accountOrigin"
                  placeholder="https://suaempresa.kommo.com"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending === credentialKey || operationUnsettled}
                />
              </label>
              <label>
                <span className="field-label">Novo token de acesso</span>
                <input
                  name="accessToken"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending === credentialKey || operationUnsettled}
                  required
                />
              </label>
            </div>
            <div className="provider-conversion-builder-footer">
              <button
                className="button primary"
                type="submit"
                disabled={
                  pending === credentialKey ||
                  operationUnsettled ||
                  confirmingKey === credentialConfirmKey
                }
              >
                <Check size={15} aria-hidden="true" />
                {pending === credentialKey ? "Salvando…" : "Substituir token"}
              </button>
            </div>
          </form>
          {confirmingKey === credentialConfirmKey ? (
            <ConfirmBox
              title={`Substituir a credencial pode reativar imediatamente o envio automático de ${liveProductionRuleCount} regra(s) já configurada(s) em produção nesta conexão.`}
              onCancel={() => {
                closeConfirm();
                setPendingCredentialPayload(null);
              }}
            >
              <button
                className="button subtle"
                type="button"
                data-confirm-cancel
                onClick={() => {
                  closeConfirm();
                  setPendingCredentialPayload(null);
                }}
              >
                Cancelar
              </button>
              <button
                className="button primary"
                type="button"
                disabled={Boolean(pending) || operationUnsettled || !pendingCredentialPayload}
                onClick={() =>
                  runConfirmed(credentialConfirmKey, () => {
                    if (pendingCredentialPayload) void submitCredential(pendingCredentialPayload);
                  })
                }
              >
                Substituir e ativar envio
              </button>
            </ConfirmBox>
          ) : null}
        </details>
      ) : null}

      <div className="provider-conversion-rule-list">
        {canManage ? (
          <div className="provider-conversion-heading-actions">
            {pipelineGroups.length === 0 ? (
              <small className="action-note">
                Atualize o catálogo para carregar pipelines e estágios antes de criar
                uma regra.
              </small>
            ) : (
              <button
                className="button subtle"
                type="button"
                onClick={() => setCreateRuleOpen((current) => !current)}
                aria-expanded={createRuleOpen}
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
          <>
            <KommoRuleForm
              key={connectionIdentity(canonical)}
              pending={
                operationUnsettled ||
                pending === createRuleKey ||
                confirmingKey === createRuleConfirmKey
              }
              pipelineGroups={pipelineGroups}
              onSubmit={handleCreateRuleSubmit}
            />
            {confirmingKey === createRuleConfirmKey ? (
              <ConfirmBox
                title={
                  pendingCreatePayload
                    ? "Criar esta regra já com envio automático ativo? Negócios sem lead previamente reconhecido continuam apenas na auditoria."
                    : "O estado da conexão mudou. Cancele e revise a regra antes de confirmar novamente."
                }
                onCancel={() => {
                  closeConfirm();
                  setPendingCreatePayload(null);
                }}
              >
                <button
                  className="button subtle"
                  type="button"
                  data-confirm-cancel
                  onClick={() => {
                    closeConfirm();
                    setPendingCreatePayload(null);
                  }}
                >
                  Cancelar
                </button>
                <button
                  className="button primary"
                  type="button"
                  disabled={!pendingCreatePayload || Boolean(pending) || operationUnsettled}
                  onClick={() =>
                    runConfirmed(createRuleConfirmKey, () => {
                      if (pendingCreatePayload) void submitCreateRule(pendingCreatePayload);
                    })
                  }
                >
                  Criar e ativar envio
                </button>
              </ConfirmBox>
            ) : null}
          </>
        ) : null}

        {canonical.rules.length === 0 ? (
          <div className="provider-conversion-empty">
            <Database size={18} aria-hidden="true" />
            <span>Nenhuma regra cadastrada ainda para esta conexão Kommo.</span>
          </div>
        ) : (
          canonical.rules.map((rule) => (
            <KommoRuleListItem
              key={rule.id}
              workspaceId={workspaceId}
              connectionId={canonical.id}
              rule={rule}
              pipelineGroups={pipelineGroups}
              canManage={canManage}
              pending={pending}
              setPending={setPending}
              connectionUncertain={stateUnresolved || operationUnsettled}
              connectionDispatching={Boolean(connectionDispatching)}
              mutationsBlocked={operationUnsettled}
              updateRuleAction={updateRuleAction}
              deleteRuleAction={deleteRuleAction}
              onResult={reportResult}
              onRuleUpdated={mergeRuleIntoCanonical}
              onRuleRemoved={removeRuleFromCanonical}
              bumpEpoch={bumpEpoch}
              markUncertain={() => setCertainty("uncertain")}
              reconcileFromServer={reconcileFromServer}
              currentEpoch={() => epochRef.current}
              guards={() => ({
                allowed:
                  canManageRef.current &&
                  !operationUnsettledRef.current &&
                  certaintyRef.current === "confirmed",
                fingerprint: JSON.stringify(canonicalRef.current),
              })}
            />
          ))
        )}
      </div>

      <details
        className="provider-conversion-rule-scope"
        open={auditOpen}
        onToggle={(event) => setAuditOpen(event.currentTarget.open)}
      >
        <summary>
          <span>Auditoria de webhooks</span>
          <strong>Eventos recebidos da Kommo</strong>
        </summary>
        {auditOpen ? (
          <KommoAuditPanel
            workspaceId={workspaceId}
            connectionId={canonical.id}
            connectionLabel={canonical.displayName}
            pipelines={canonical.pipelines}
            licenseLocked={licenseLocked}
            listEventsAction={listEventsAction}
            authorityLost={authLost}
            onUnauthorized={handleAuditUnauthorized}
          />
        ) : null}
      </details>

      <p className="action-note">
        Só negócios já vinculados a um lead existente no WppTrack (telefone reconhecido
        e atribuição de anúncio válida) geram conversão; os demais ficam apenas na
        auditoria. Regras em observação não enviam nada ao Meta. Salvar uma regra não
        envia nada, e o aceite (202) do webhook da Kommo só significa que o evento
        entrou para processamento: confirme o resultado na auditoria.
      </p>
    </article>
  );
}

/**
 * `kommoConversionRuleUpdateInputSchema` is a `.partial()`: an omitted key means
 * "leave unchanged" server-side, while `currency`/`contentName`/`fixedValueCents`
 * accept an explicit `null` to clear them. On update an emptied field must be
 * sent as `null` or the clear is a no-op against the merge.
 */
function buildRulePayload(
  data: FormData,
  options: { isUpdate: boolean } = { isUpdate: false },
): Record<string, unknown> | null {
  const { isUpdate } = options;
  const name = String(data.get("name") ?? "").trim();
  const stageValue = String(data.get("stage") ?? "");
  const [pipelineId, statusId] = stageValue.split("::");
  const eventName = String(data.get("eventName") ?? "");
  const mode = String(data.get("mode") ?? "observation");
  const valueMode = String(data.get("valueMode") ?? "lead_price");
  const currency = String(data.get("currency") ?? "").trim();
  const contentName = String(data.get("contentName") ?? "").trim();
  const fixedValueAmount = String(data.get("fixedValueAmount") ?? "").trim();

  if (!name || !pipelineId || !statusId || !eventName) {
    return null;
  }

  const carriesValue = conversionEventCarriesValue(eventName as ConversionEventNameDto);
  const fixedValueCents =
    carriesValue && valueMode === "fixed" ? parseMoneyToCents(fixedValueAmount) : null;

  if (carriesValue && valueMode === "fixed" && !fixedValueCents) {
    return null;
  }

  const payload: Record<string, unknown> = {
    name,
    pipelineId,
    statusId,
    eventName,
    valueMode: carriesValue ? valueMode : "lead_price",
  };

  if (!isUpdate) {
    payload.mode = mode;
  }

  if (carriesValue && valueMode === "fixed") {
    payload.fixedValueCents = fixedValueCents;
  } else if (isUpdate) {
    payload.fixedValueCents = null;
  }

  if (carriesValue && currency) {
    payload.currency = currency.toUpperCase();
  } else if (isUpdate) {
    payload.currency = null;
  }

  if (carriesValue && contentName) {
    payload.contentName = contentName;
  } else if (isUpdate) {
    payload.contentName = null;
  }

  return payload;
}

const ruleIssueMessages: Record<string, string> = {
  currency: "Escolha a moeda (Real, Dólar ou Euro).",
  fixedValueCents: "Informe o valor fixo.",
  valueMode: "Este evento não aceita configuração de valor.",
  name: "O nome da regra precisa ter entre 2 e 120 caracteres.",
  contentName: "O produto precisa ter entre 1 e 180 caracteres.",
};

/**
 * Mirrors apps/api's updateRule merge (current row spread with the proposed
 * partial on top), then validates that candidate through the exported shared
 * schemas — the same ones the backend re-validates against.
 */
function validateMergedRuleCandidate(
  current: KommoConnectionDetailDto["rules"][number] | undefined,
  proposed: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  const candidate = current
    ? {
        name: current.name,
        pipelineId: current.pipelineId,
        statusId: current.statusId,
        eventName: current.eventName,
        mode: current.mode,
        active: current.active,
        valueMode: current.valueMode,
        fixedValueCents: current.fixedValueCents,
        currency: current.currency ?? undefined,
        contentName: current.contentName,
        ...proposed,
      }
    : proposed;

  if (current) {
    const partial = kommoConversionRuleUpdateInputSchema.safeParse(proposed);
    if (!partial.success) return { ok: false, message: INVALID_FORM_MESSAGE };
  }

  const result = kommoConversionRuleCreateInputSchema.safeParse(candidate);
  if (result.success) return { ok: true };

  const firstIssue = result.error.issues[0];
  const field = String(firstIssue?.path[0] ?? "");
  return {
    ok: false,
    message: ruleIssueMessages[field] ?? INVALID_FORM_MESSAGE,
  };
}

function KommoRuleForm({
  pending,
  pipelineGroups,
  onSubmit,
  initial,
}: {
  pending: boolean;
  pipelineGroups: ReturnType<typeof groupPipelines>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  initial?: KommoConnectionDetailDto["rules"][number];
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [stage, setStage] = useState(initial ? `${initial.pipelineId}::${initial.statusId}` : "");
  const [eventName, setEventName] = useState<ConversionEventNameDto>(
    initial?.eventName ?? "QualifiedLead",
  );
  const [valueMode, setValueMode] = useState<"lead_price" | "fixed">(
    initial?.valueMode ?? "lead_price",
  );
  const [fixedValueAmount, setFixedValueAmount] = useState(
    initial?.fixedValueCents != null
      ? (initial.fixedValueCents / 100).toFixed(2).replace(".", ",")
      : "",
  );
  const workspaceCurrency = useWorkspaceCurrency();
  // Regra nova começa na "Moeda das conversões" do workspace; ao editar, a
  // moeda gravada continua.
  const [currency, setCurrency] = useState(
    initial ? (initial.currency ?? "") : workspaceCurrency,
  );
  const [contentName, setContentName] = useState(initial?.contentName ?? "");
  const carriesValue = conversionEventCarriesValue(eventName);
  const currencyRequired =
    carriesValue &&
    (valueMode === "fixed" || conversionEventRequiresValue(eventName));

  function selectEventName(next: ConversionEventNameDto) {
    setEventName(next);
    if (!conversionEventCarriesValue(next)) {
      setValueMode("lead_price");
      setFixedValueAmount("");
      setCurrency("");
      setContentName("");
    } else if (!currency) {
      setCurrency(workspaceCurrency);
    }
  }

  return (
    <form
      className="provider-conversion-builder"
      onSubmit={onSubmit}
      aria-label={initial ? `Editar regra ${initial.name}` : "Nova regra Kommo"}
    >
      <div className="provider-conversion-base-fields">
        <label>
          <span className="field-label">Nome da regra</span>
          <input
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            minLength={2}
            maxLength={120}
            placeholder="Ex.: Negociação ganha"
            disabled={pending}
            required
          />
        </label>
        <label>
          <span className="field-label">Pipeline e estágio na Kommo</span>
          <select
            name="stage"
            value={stage}
            onChange={(event) => setStage(event.target.value)}
            disabled={pending}
            required
          >
            <option value="" disabled>
              Selecione um estágio
            </option>
            {pipelineGroups.map((pipeline) => (
              <optgroup key={pipeline.id} label={pipeline.name}>
                {pipeline.statuses.map((status) => (
                  <option
                    key={status.id}
                    value={`${pipeline.id}::${status.id}`}
                    disabled={!status.available}
                  >
                    {status.name}
                    {status.available ? "" : " (indisponível)"}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Conversão disparada</span>
          <select
            name="eventName"
            value={eventName}
            onChange={(event) => selectEventName(event.target.value as ConversionEventNameDto)}
            disabled={pending}
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
        O casamento é feito pelo pipeline e estágio escolhidos, não pelo nome do negócio.
      </p>

      {!initial ? (
        <label className="provider-conversion-initial-mode">
          <span className="field-label">Modo inicial</span>
          <select name="mode" defaultValue="observation" disabled={pending}>
            <option value="observation">Observar primeiro (nada é enviado ao Meta)</option>
            <option value="production">Ativar envio agora (produção)</option>
          </select>
          <small className="action-note">
            Em observação a regra só registra o que aconteceria, sem criar nem enviar
            conversão. O envio só ocorre quando o negócio tiver um lead previamente
            reconhecido.
          </small>
        </label>
      ) : null}

      {carriesValue ? (
        <>
          <fieldset className="provider-conversion-value-modes">
            <legend className="field-label">Valor</legend>
            <div>
              <label>
                <input
                  type="radio"
                  name="valueMode"
                  value="lead_price"
                  checked={valueMode === "lead_price"}
                  onChange={() => setValueMode("lead_price")}
                  disabled={pending}
                />
                <span>Preço do negócio na Kommo</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="valueMode"
                  value="fixed"
                  checked={valueMode === "fixed"}
                  onChange={() => setValueMode("fixed")}
                  disabled={pending}
                />
                <span>Valor fixo</span>
              </label>
            </div>
          </fieldset>

          {valueMode === "fixed" ? (
            <div className="provider-conversion-base-fields">
              <label>
                <span className="field-label">Valor fixo</span>
                <input
                  name="fixedValueAmount"
                  value={fixedValueAmount}
                  onChange={(event) => setFixedValueAmount(event.target.value)}
                  inputMode="decimal"
                  placeholder="Ex.: 199,90"
                  disabled={pending}
                  required
                />
              </label>
            </div>
          ) : null}

          <div className="provider-conversion-base-fields">
            {/* Sempre enviada. Regra sem moeda válida usa, no envio, a
                "Moeda das conversões" do workspace. */}
            <CrmCurrencySelect
              label={`Moeda${currencyRequired ? " — obrigatória" : ""}`}
              value={currency}
              onChange={setCurrency}
              required={currencyRequired}
              emptyLabel={currencyRequired ? "Selecione a moeda" : "Sem moeda"}
              disabled={pending}
            />
            <label>
              <span className="field-label">Produto (opcional)</span>
              <input
                name="contentName"
                value={contentName}
                onChange={(event) => setContentName(event.target.value)}
                maxLength={180}
                placeholder="Ex.: Plano anual"
                disabled={pending}
              />
            </label>
          </div>
        </>
      ) : null}

      <div className="provider-conversion-builder-footer">
        <span className="action-note">
          A regra só vale para o estágio informado; crie quantas regras forem
          necessárias.
        </span>
        <button className="button primary" type="submit" disabled={pending}>
          <Check size={15} aria-hidden="true" />
          {pending ? "Salvando…" : initial ? "Salvar regra" : "Criar regra"}
        </button>
      </div>
    </form>
  );
}

function KommoRuleListItem({
  workspaceId,
  connectionId,
  rule,
  pipelineGroups,
  canManage,
  pending,
  setPending,
  connectionUncertain,
  connectionDispatching,
  mutationsBlocked,
  updateRuleAction,
  deleteRuleAction,
  onResult,
  onRuleUpdated,
  onRuleRemoved,
  bumpEpoch,
  markUncertain,
  reconcileFromServer,
  currentEpoch,
  guards,
}: {
  workspaceId: string;
  connectionId: string;
  rule: KommoConnectionDetailDto["rules"][number];
  pipelineGroups: ReturnType<typeof groupPipelines>;
  canManage: boolean;
  pending: string | null;
  setPending: (value: string | null) => void;
  connectionUncertain: boolean;
  connectionDispatching: boolean;
  mutationsBlocked: boolean;
  updateRuleAction: RuleAction;
  deleteRuleAction: RuleAction;
  onResult: (result: KommoRuleActionResult) => void;
  onRuleUpdated: (rule: KommoConnectionDetailDto["rules"][number]) => void;
  onRuleRemoved: (ruleId: string) => void;
  bumpEpoch: () => number;
  markUncertain: () => void;
  reconcileFromServer: (myEpoch: number) => Promise<void>;
  currentEpoch: () => number;
  guards: () => { allowed: boolean; fingerprint: string };
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [confirming, setConfirming] = useState<
    "activate" | "delete" | "resume-production" | null
  >(null);
  const confirmContext = useRef<{ epoch: number; fingerprint: string } | null>(null);
  const editKey = `edit-rule-${rule.id}`;
  const toggleKey = `toggle-rule-${rule.id}`;
  const modeKey = `mode-rule-${rule.id}`;
  const deleteKey = `delete-rule-${rule.id}`;

  const pipeline = pipelineGroups.find((group) => group.id === rule.pipelineId);
  const status = pipeline?.statuses.find((item) => item.id === rule.statusId);

  function openConfirm(kind: "activate" | "delete" | "resume-production") {
    confirmContext.current = { epoch: currentEpoch(), fingerprint: guards().fingerprint };
    setConfirming(kind);
  }

  function closeConfirm() {
    confirmContext.current = null;
    setConfirming(null);
  }

  /** Final-handler recheck, shared by every confirmation of this rule. */
  function approvalStillValid(): boolean {
    const context = confirmContext.current;
    const current = guards();
    return Boolean(
      context &&
        current.allowed &&
        !pending &&
        context.epoch === currentEpoch() &&
        context.fingerprint === current.fingerprint,
    );
  }

  function confirmedRun(run: () => void) {
    if (!approvalStillValid()) {
      closeConfirm();
      onResult({ ok: false, message: STALE_APPROVAL_MESSAGE });
      return;
    }
    run();
  }

  useEffect(() => {
    if (confirming && !approvalStillValid()) closeConfirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming, canManage, connectionUncertain, mutationsBlocked, rule]);

  async function submitPartial(key: string, payload: Record<string, unknown>) {
    if (pending || mutationsBlocked || !guards().allowed) return;
    const parsed = kommoConversionRuleUpdateInputSchema.safeParse(payload);
    if (!parsed.success) {
      onResult({ ok: false, message: INVALID_FORM_MESSAGE });
      return;
    }
    const myEpoch = bumpEpoch();
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("connectionId", connectionId);
    formData.set("ruleId", rule.id);
    formData.set("payload", JSON.stringify(parsed.data));

    closeConfirm();
    setPending(key);
    markUncertain();
    try {
      const result = await updateRuleAction(formData);
      onResult(result);
      if (currentEpoch() !== myEpoch) return result;
      if (result.ok && result.rule) {
        onRuleUpdated(result.rule);
      } else {
        await reconcileFromServer(myEpoch);
      }
      return result;
    } catch {
      const result: KommoRuleActionResult = {
        ok: false,
        message: TRANSPORT_ERROR_MESSAGE,
        outcomeUnknown: true,
      };
      onResult(result);
      if (currentEpoch() === myEpoch) {
        await reconcileFromServer(myEpoch);
      }
      return result;
    } finally {
      setPending(null);
    }
  }

  const resumingIntoProduction = !rule.active && rule.mode === "production";
  const resumeLabel = resumingIntoProduction ? "Retomar envio automático" : "Retomar observação";

  async function toggleActive() {
    if (pending || mutationsBlocked || !guards().allowed) return;
    // Resuming a production rule dispatches live sends again immediately.
    // Blocked outright while the connection is uncertain.
    if (resumingIntoProduction) {
      if (productionTransitionBlocked) return;
      openConfirm("resume-production");
      return;
    }
    await submitPartial(toggleKey, { active: !rule.active });
  }

  async function activateProduction() {
    if (pending || mutationsBlocked || productionTransitionBlocked) return;
    await submitPartial(modeKey, { mode: "production" });
  }

  async function backToObservation() {
    if (pending || mutationsBlocked) return;
    await submitPartial(modeKey, { mode: "observation" });
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || mutationsBlocked || !guards().allowed) return;

    const payload = buildRulePayload(new FormData(event.currentTarget), { isUpdate: true });

    if (!payload) {
      onResult({ ok: false, message: INVALID_FORM_MESSAGE });
      return;
    }

    const validation = validateMergedRuleCandidate(rule, payload);
    if (!validation.ok) {
      onResult({ ok: false, message: validation.message });
      return;
    }

    const result = await submitPartial(editKey, payload);
    if (result?.ok) setEditOpen(false);
  }

  async function removeRule() {
    if (pending || mutationsBlocked || !guards().allowed) return;
    const myEpoch = bumpEpoch();
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("connectionId", connectionId);
    formData.set("ruleId", rule.id);

    closeConfirm();
    setPending(deleteKey);
    markUncertain();
    try {
      const result = await deleteRuleAction(formData);
      onResult(result);
      if (currentEpoch() !== myEpoch) return;
      if (result.ok) {
        onRuleRemoved(rule.id);
      } else {
        await reconcileFromServer(myEpoch);
      }
    } catch {
      onResult({ ok: false, message: TRANSPORT_ERROR_MESSAGE, outcomeUnknown: true });
      if (currentEpoch() === myEpoch) {
        await reconcileFromServer(myEpoch);
      }
    } finally {
      setPending(null);
    }
  }

  const activating = rule.mode !== "production";
  // The connection's own health/status/catalog is uncertain: production
  // transitions cannot be reasoned about safely, so they are blocked outright.
  const productionTransitionBlocked = connectionUncertain;
  const ruleChip = !rule.active
    ? { tone: "warn", label: "Pausada" }
    : rule.mode === "production"
      ? connectionDispatching
        ? { tone: "success", label: "Envio ativo (produção)" }
        : { tone: "warn", label: "Produção em espera (conexão não está enviando)" }
      : { tone: "neutral", label: "Observação (nada é enviado)" };

  return (
    <article className="provider-conversion-rule">
      <div className="provider-conversion-rule-main">
        <div className="provider-conversion-rule-icon">
          <Database size={17} aria-hidden="true" />
        </div>
        <div className="provider-conversion-rule-copy">
          <div className="provider-conversion-rule-title">
            <strong>{rule.name}</strong>
            <span className="event-chip neutral">{eventLabel(rule.eventName)}</span>
            <span className={`event-chip ${ruleChip.tone}`}>{ruleChip.label}</span>
          </div>
          <span>
            {pipeline?.name ?? "Pipeline não encontrado"} /{" "}
            {status?.name ?? "Estágio não encontrado"}
            {status && !status.available ? " (indisponível no catálogo)" : ""}
          </span>
          <small>
            {rule.valueMode === "fixed"
              ? `Valor fixo: ${moneyLabel(rule.fixedValueCents, rule.currency)}`
              : `Preço do negócio na Kommo${rule.currency ? ` (${rule.currency})` : ""}`}
          </small>
        </div>
      </div>

      {canManage ? (
        <div className="provider-conversion-rule-actions">
          {rule.active ? (
            <button
              className="icon-button"
              type="button"
              title={
                productionTransitionBlocked && activating
                  ? "Estado da conexão não confirmado; aguarde a confirmação"
                  : rule.mode === "production"
                    ? "Voltar para observação"
                    : "Ativar envio automático"
              }
              aria-label={
                rule.mode === "production"
                  ? `Voltar para observação: ${rule.name}`
                  : `Ativar envio automático: ${rule.name}`
              }
              disabled={
                mutationsBlocked ||
                Boolean(pending) ||
                (productionTransitionBlocked && activating)
              }
              onClick={() => {
                if (activating) {
                  openConfirm("activate");
                  return;
                }
                void backToObservation();
              }}
            >
              {rule.mode === "production" ? (
                <Pause size={15} aria-hidden="true" />
              ) : (
                <Play size={15} aria-hidden="true" />
              )}
            </button>
          ) : null}
          <button
            className="icon-button"
            type="button"
            title={
              productionTransitionBlocked && resumingIntoProduction
                ? "Estado da conexão não confirmado; aguarde a confirmação"
                : rule.active
                  ? "Pausar regra"
                  : resumeLabel
            }
            aria-label={rule.active ? `Pausar regra ${rule.name}` : `${resumeLabel} ${rule.name}`}
            disabled={
              mutationsBlocked ||
              Boolean(pending) ||
              (productionTransitionBlocked && resumingIntoProduction)
            }
            onClick={() => void toggleActive()}
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
            onClick={() => openConfirm("delete")}
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {canManage && confirming === "activate" ? (
        <ConfirmBox
          title="Ativar o envio automático desta regra? Negócios sem lead previamente reconhecido continuam apenas na auditoria."
          onCancel={closeConfirm}
        >
          <button className="button subtle" type="button" data-confirm-cancel onClick={closeConfirm}>
            Cancelar
          </button>
          <button
            className="button primary"
            type="button"
            disabled={mutationsBlocked || Boolean(pending)}
            onClick={() => confirmedRun(() => void activateProduction())}
          >
            Ativar envio
          </button>
        </ConfirmBox>
      ) : null}

      {canManage && confirming === "resume-production" ? (
        <ConfirmBox
          title="Retomar esta regra? O envio automático já estava ativo antes da pausa e volta a valer imediatamente para negócios com lead previamente reconhecido."
          onCancel={closeConfirm}
        >
          <button className="button subtle" type="button" data-confirm-cancel onClick={closeConfirm}>
            Cancelar
          </button>
          <button
            className="button primary"
            type="button"
            disabled={mutationsBlocked || Boolean(pending)}
            onClick={() =>
              confirmedRun(() => {
                if (!productionTransitionBlocked) {
                  void submitPartial(toggleKey, { active: true });
                }
              })
            }
          >
            Retomar envio automático
          </button>
        </ConfirmBox>
      ) : null}

      {canManage && confirming === "delete" ? (
        <ConfirmBox
          title="Remover esta regra? Esta ação não pode ser desfeita."
          onCancel={closeConfirm}
        >
          <button className="button subtle" type="button" data-confirm-cancel onClick={closeConfirm}>
            Cancelar
          </button>
          <button
            className="button danger"
            type="button"
            disabled={mutationsBlocked || Boolean(pending)}
            onClick={() => confirmedRun(() => void removeRule())}
          >
            Remover
          </button>
        </ConfirmBox>
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
          {/* Keyed on open-state + the rule's version so the form never submits
              a stale draft over a newer canonical value. */}
          <KommoRuleForm
            key={`${rule.id}-${rule.updatedAt}-${editOpen}`}
            pending={pending === editKey || mutationsBlocked}
            pipelineGroups={pipelineGroups}
            onSubmit={handleEditSubmit}
            initial={rule}
          />
        </details>
      ) : null}
    </article>
  );
}
