"use client";

import type {
  InboundWebhookCapabilitiesDto,
  InboundWebhookChannelDto,
  InboundWebhookConnectionOverviewDto,
  InboundWebhookProviderDto,
  MetaManualConfigurationDto,
  ProviderConversionRuleDto,
} from "@wpptrack/shared";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  Copy,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState } from "react";
import { PresentationMask } from "../../../components/presentation-mask";
import { displayTimeZone } from "../../../lib/date-time";
import type {
  InboundWebhookActionResult,
  InboundWebhookOneTimeSecret,
} from "./inbound-webhook-actions";
import { InboundWebhookRouteEditor } from "./inbound-webhook-route-editor";
import { InboundWebhookRoutingMode } from "./inbound-webhook-routing-mode";
import { InboundRecoveryPanel } from "./inbound-recovery-panel";
import {
  adUnavailableLabel,
  ctwaDestinationReasonLabel,
  unnichatRouteNotConfiguredLabel,
  unnichatRoutingSourceLabel,
} from "./inbound-webhook-labels";
import { UnnichatEntrySetupPanel } from "./unnichat-setup";

type InboundWebhookAction = (
  formData: FormData,
) => Promise<InboundWebhookActionResult>;

export type InboundWebhookConnectionView = {
  overview: InboundWebhookConnectionOverviewDto;
  channels: InboundWebhookChannelDto[];
  detailState?: "real" | "error";
};

export type InboundWebhookPanelProps = {
  capabilities: InboundWebhookCapabilitiesDto;
  connections: InboundWebhookConnectionView[];
  providerRules: ProviderConversionRuleDto[];
  providerRulesEnabled: boolean;
  metaConfiguration: MetaManualConfigurationDto | null;
  canManage: boolean;
  canRecover?: boolean;
  createAction: InboundWebhookAction;
  rotateSecretAction: InboundWebhookAction;
  setConnectionStatusAction: InboundWebhookAction;
  removeConnectionAction: InboundWebhookAction;
  createChannelAction: InboundWebhookAction;
  setChannelStatusAction: InboundWebhookAction;
  saveRoutesAction: InboundWebhookAction;
  /**
   * Scopes the panel to one platform (Integrations hub modal): only its
   * connections are listed and the create form is fixed to it.
   */
  provider?: InboundWebhookProviderDto;
  /** False hides the create form (e.g. connections bridged from Uazapi). */
  allowCreate?: boolean;
  /** Whether the create form starts open (default: when nothing exists). */
  defaultCreateOpen?: boolean;
  /** Replaces the scoped heading's helper text. */
  scopeDescription?: string;
  /**
   * Client-side hint only (the API stays the authority with HTTP 423): while
   * the license is locked every write control is disabled.
   */
  licenseLocked?: boolean;
};

type PanelNotice = {
  tone: "success" | "error";
  message: string;
};

export function inboundWebhookProviderLabel(provider: string): string {
  const labels: Record<string, string> = {
    data_crazy: "Data Crazy",
    gupshup: "Gupshup",
    meta_cloud: "Meta WhatsApp (Cloud API)",
    umbler: "Umbler Talk",
    unnichat: "Unnichat",
    uazapi: "Uazapi",
  };

  return labels[provider] ?? provider;
}

const inboundPasteInstructions: Record<string, string> = {
  data_crazy:
    "No Data Crazy, crie uma automacao de mensagem recebida com requisicao HTTP POST (JSON) e cole esta URL.",
  gupshup: "Cole esta URL no painel/webhook da Gupshup.",
  meta_cloud:
    "Cole URL e token em App Meta → Configurar webhooks → Verificar e salvar.",
  umbler: "Cole esta URL no painel/webhook da Umbler Talk.",
  unnichat:
    "Cole esta URL na chamada HTTP do fluxo do Unnichat que recebe a conversa do anúncio.",
};

export function inboundPasteInstruction(provider: string): string {
  return (
    inboundPasteInstructions[provider] ??
    `Cole esta URL no painel/webhook da ${inboundWebhookProviderLabel(provider)}.`
  );
}

// Data Crazy nao aceita cadastro manual de numero: o canal nasce do primeiro
// webhook recebido (a API bloqueia o canal provisorio para esse provider).
// Unnichat tambem nao: o numero do cliente e informado ao criar a conexao.
function allowsManualChannelRegistration(provider: string): boolean {
  return (
    provider !== "uazapi" && provider !== "data_crazy" && provider !== "unnichat"
  );
}

// Texto do formulário de criação da conexão, por provedor.
function createDescription(provider: string, allowCreate: boolean): string {
  if (provider === "unnichat") {
    return "Dê um nome e informe o número de WhatsApp atendido pelo Unnichat. A conexão já nasce presa a esse número; só conversas vindas de anúncio (CTWA) viram lead.";
  }

  return allowCreate
    ? "Dê um nome e gere a URL desta conexão. Só mensagens vindas de anúncio (CTWA) viram lead."
    : "Confira as conexões e escolha quais canais enviam conversões.";
}

export function InboundWebhookPanel({
  capabilities,
  connections: allConnections,
  providerRules,
  providerRulesEnabled,
  metaConfiguration,
  canManage,
  canRecover = false,
  createAction,
  rotateSecretAction,
  setConnectionStatusAction,
  removeConnectionAction,
  createChannelAction,
  setChannelStatusAction,
  saveRoutesAction,
  provider: scopedProvider,
  allowCreate = true,
  defaultCreateOpen,
  scopeDescription,
  licenseLocked = false,
}: InboundWebhookPanelProps) {
  const router = useRouter();
  const connections = scopedProvider
    ? allConnections.filter(
        ({ overview }) => overview.connection.provider === scopedProvider,
      )
    : allConnections;
  const [createOpen, setCreateOpen] = useState(
    defaultCreateOpen ?? connections.length === 0,
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<PanelNotice | null>(null);
  const [oneTimeSecret, setOneTimeSecret] =
    useState<InboundWebhookOneTimeSecret | null>(null);
  const [copied, setCopied] = useState(false);
  const [pickedProvider, setPickedProvider] = useState<string | null>(null);
  const creatableProviders = allowCreate
    ? capabilities.providers.filter(
        (provider) =>
          provider.creationEnabled &&
          (!scopedProvider || provider.provider === scopedProvider),
      )
    : [];
  const canCreate =
    canManage && capabilities.enabled && creatableProviders.length > 0;
  const selectedCreateProvider =
    scopedProvider ??
    (creatableProviders.some((item) => item.provider === pickedProvider)
      ? pickedProvider
      : (creatableProviders[0]?.provider ?? null));
  // Inside a hub modal the form is the main content while nothing exists
  // yet: no inner "close" next to the modal's own X.
  const showCreateToggle =
    canCreate && !(scopedProvider && createOpen && connections.length === 0);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (pendingAction) {
      return;
    }

    const form = event.currentTarget;
    setPendingAction("create");
    setNotice(null);
    const result = await createAction(new FormData(form));
    applyResult(result);

    if (result.ok && result.oneTimeSecret) {
      form.reset();
      setOneTimeSecret(result.oneTimeSecret);
      setCopied(false);
      setCreateOpen(false);
      router.refresh();
    }

    setPendingAction(null);
  }

  async function runConnectionAction(
    key: string,
    action: InboundWebhookAction,
    values: Record<string, string>,
  ) {
    if (pendingAction) {
      return;
    }

    const formData = new FormData();
    for (const [name, value] of Object.entries(values)) {
      formData.set(name, value);
    }

    setPendingAction(key);
    setNotice(null);
    const result = await action(formData);
    applyResult(result);

    if (result.ok) {
      if (result.oneTimeSecret) {
        setOneTimeSecret(result.oneTimeSecret);
        setCopied(false);
      }
      router.refresh();
    }

    setPendingAction(null);
  }

  function onRoutesUpdated(result: InboundWebhookActionResult) {
    applyResult(result);
    if (result.ok) {
      router.refresh();
    }
  }

  function applyResult(result: InboundWebhookActionResult) {
    setNotice({
      tone: result.ok ? "success" : "error",
      message: result.message,
    });
  }

  async function copyWebhookUrl() {
    if (!oneTimeSecret) {
      return;
    }

    try {
      await navigator.clipboard.writeText(oneTimeSecret.webhookUrl);
      setCopied(true);
      setNotice({
        tone: "success",
        message: `URL copiada. ${inboundPasteInstruction(oneTimeSecret.provider)}`,
      });
    } catch {
      setNotice({
        tone: "error",
        message: "Nao foi possivel copiar automaticamente. Selecione a URL.",
      });
    }
  }

  async function copyVerifyToken() {
    if (!oneTimeSecret) {
      return;
    }

    try {
      await navigator.clipboard.writeText(oneTimeSecret.verifyToken ?? "");
      setNotice({
        tone: "success",
        message: "Token de verificacao copiado.",
      });
    } catch {
      setNotice({
        tone: "error",
        message: "Nao foi possivel copiar automaticamente. Selecione o token.",
      });
    }
  }

  return (
    <section className="surface-panel inbound-webhook-panel">
      <div className="inbound-webhook-heading">
        {scopedProvider ? (
          <div>
            <span className="eyebrow">Conexões</span>
            <h2>
              {connections.length > 0
                ? `Suas conexões ${inboundWebhookProviderLabel(scopedProvider)}`
                : `Conectar ${inboundWebhookProviderLabel(scopedProvider)}`}
            </h2>
            <p className="muted">
              {scopeDescription ??
                createDescription(scopedProvider, allowCreate)}
            </p>
          </div>
        ) : (
          <div>
            <span className="eyebrow">Fontes de mensagens</span>
            <h2>Webhooks de entrada</h2>
            <p className="muted">
              Configure Umbler Talk, Gupshup, Data Crazy ou Meta WhatsApp (Cloud
              API). Cada conexao gera uma URL propria; so mensagens vindas de
              anuncio (CTWA) viram lead.
            </p>
          </div>
        )}
        {showCreateToggle ? (
          <button
            className="button"
            type="button"
            onClick={() => setCreateOpen((current) => !current)}
            aria-expanded={createOpen}
          >
            {createOpen ? (
              <X size={16} aria-hidden="true" />
            ) : (
              <Plus size={16} aria-hidden="true" />
            )}
            {createOpen
              ? scopedProvider
                ? "Cancelar"
                : "Fechar"
              : "Adicionar conexão"}
          </button>
        ) : canCreate ? null : (
          <span className="status-chip">
            {!capabilities.enabled
              ? "Indisponivel"
              : canManage && !allowCreate
                ? "Gerenciar"
                : "Somente leitura"}
          </span>
        )}
      </div>

      <fieldset className="license-lock-scope" disabled={licenseLocked}>
      {licenseLocked && canManage ? (
        <p className="action-note warn" role="status">
          Licença bloqueada: criar, alterar e remover conexões está
          indisponível. Verifique /backoffice/license.
        </p>
      ) : null}
      {createOpen && canCreate ? (
        <form
          className={`inbound-webhook-create${selectedCreateProvider === "unnichat" ? " has-phone" : ""}`}
          onSubmit={handleCreate}
        >
          {scopedProvider ? (
            <input type="hidden" name="provider" value={scopedProvider} />
          ) : (
            <label>
              <span className="field-label">Plataforma</span>
              <select
                name="provider"
                value={selectedCreateProvider ?? ""}
                onChange={(event) => setPickedProvider(event.target.value)}
                disabled={
                  pendingAction === "create" || creatableProviders.length === 0
                }
              >
                {creatableProviders.map((provider) => (
                  <option key={provider.provider} value={provider.provider}>
                    {inboundWebhookProviderLabel(provider.provider)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span className="field-label">Nome da conexão</span>
            <input
              name="displayName"
              minLength={2}
              maxLength={120}
              placeholder="Ex.: Comercial - unidade 1"
              required
              disabled={pendingAction === "create"}
            />
          </label>
          {selectedCreateProvider === "unnichat" ? (
            <label>
              <span className="field-label">Número de WhatsApp do cliente</span>
              <input
                name="connectedPhone"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                minLength={8}
                maxLength={32}
                placeholder="Ex.: +55 11 99999-0001"
                required
                aria-describedby="unnichat-whatsapp-help"
                disabled={pendingAction === "create"}
              />
              <span id="unnichat-whatsapp-help" className="field-help muted">
                É o número atendido pelo Unnichat (o seu), com DDI e DDD. Nunca
                o telefone do lead. Para dois números, crie duas conexões.
              </span>
            </label>
          ) : null}
          <button
            className="button primary"
            type="submit"
            disabled={
              licenseLocked ||
              pendingAction === "create" ||
              creatableProviders.length === 0
            }
          >
            <Webhook size={16} aria-hidden="true" />
            {pendingAction === "create" ? "Criando..." : "Gerar webhook"}
          </button>
        </form>
      ) : null}

      {oneTimeSecret ? (
        <InboundWebhookOneTimeSecretPanel
          secret={oneTimeSecret}
          urlCopied={copied}
          onCopyUrl={copyWebhookUrl}
          onCopyVerifyToken={copyVerifyToken}
          onDismiss={() => setOneTimeSecret(null)}
        />
      ) : null}
      {oneTimeSecret?.provider === "unnichat" ? (
        <UnnichatEntrySetupPanel />
      ) : null}

      {notice ? (
        <div
          className={`feedback-banner ${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <span>{notice.message}</span>
        </div>
      ) : null}

      <div className="inbound-connection-list">
        {connections.length === 0 ? (
          <div className="inbound-empty-state">
            <Webhook size={20} aria-hidden="true" />
            <div>
              <strong>Nenhum webhook configurado</strong>
              <p className="muted">
                Crie uma conexão para receber o primeiro payload de teste.
              </p>
            </div>
          </div>
        ) : (
          connections.map(({ overview, channels, detailState }) => {
            const connection = overview.connection;
            const connectionPending = pendingAction?.includes(connection.id);

            return (
              <details className="inbound-connection" key={connection.id}>
                <summary>
                  <div className="inbound-connection-identity">
                    <span
                      className={`status-dot ${connection.status !== "paused" ? "active" : ""}`}
                      aria-hidden="true"
                    />
                    <div>
                      <strong>
                        <PresentationMask placeholder="Conexao WhatsApp">
                          {connection.displayName}
                        </PresentationMask>
                      </strong>
                      <span>
                        {inboundWebhookProviderLabel(connection.provider)} -{" "}
                        {connectionStatusLabel(connection.status)}
                      </span>
                    </div>
                  </div>
                  <div className="inbound-connection-health">
                    <span className="inbound-connection-signal">
                      {overview.counters.eligibleRouted} roteados
                    </span>
                    {overview.counters.eligibleUnresolved > 0 ? (
                      <span className="inbound-connection-signal warn">
                        {overview.counters.eligibleUnresolved} pendentes
                      </span>
                    ) : null}
                    <span>{channels.length} canal(is)</span>
                    <span>
                      Última entrega:{" "}
                      {formatDateTime(connection.lastDeliveryAt)}
                    </span>
                  </div>
                </summary>

                <div className="inbound-connection-body">
                  {connection.status === "production" ? (
                    <div className="feedback-banner success" role="status">
                      <Send size={16} aria-hidden="true" />
                      <span>
                        Envio automatico ativo somente nos canais habilitados.
                      </span>
                    </div>
                  ) : null}
                  {detailState === "error" ? (
                    <p className="action-note warn">
                      Parte dos dados desta conexao esta temporariamente
                      indisponivel.
                    </p>
                  ) : null}
                  <div className="inbound-counter-grid">
                    <ObservationCounter
                      label="CTWA roteado"
                      value={overview.counters.eligibleRouted}
                      tone="success"
                    />
                    <ObservationCounter
                      label="CTWA pendente"
                      value={overview.counters.eligibleUnresolved}
                      tone="warn"
                    />
                    <ObservationCounter
                      label="Sem CTWA"
                      value={overview.counters.ignoredNoCtwa}
                    />
                    <ObservationCounter
                      label="Duplicados"
                      value={overview.counters.duplicate}
                    />
                    <ObservationCounter
                      label="Invalidos"
                      value={overview.counters.invalid}
                      tone="error"
                    />
                  </div>

                  {connection.provider === "meta_cloud" ? <p>Canal habilitado recebe eventos; a conexao precisa de envios automaticos ativos para enviar novos CTWAs. CTWA roteado nao significa enviado. Ativar envios automaticos nao recupera o historico.</p> : null}
                  {canManage ? (
                    <div className="inbound-connection-actions">
                      {connection.status === "observation" &&
                      capabilities.productionEnabled ? (
                        <button
                          className="button primary"
                          type="button"
                          disabled={Boolean(connectionPending)}
                          onClick={() => {
                            if (
                              window.confirm(
                                "Ativar o envio automatico? Apenas canais habilitados e com rota valida enviarao novos eventos.",
                              )
                            ) {
                              void runConnectionAction(
                                `production-${connection.id}`,
                                setConnectionStatusAction,
                                {
                                  connectionId: connection.id,
                                  status: "production",
                                },
                              );
                            }
                          }}
                        >
                          <Send size={15} aria-hidden="true" />
                          Ativar envios automaticos
                        </button>
                      ) : null}
                      {connection.status === "production" ? (
                        <button
                          className="button"
                          type="button"
                          disabled={Boolean(connectionPending)}
                          onClick={() => {
                            if (
                              window.confirm(
                                "Voltar para observacao? Novas mensagens continuarao registradas, mas nao gerarao conversoes automaticas.",
                              )
                            ) {
                              void runConnectionAction(
                                `observation-${connection.id}`,
                                setConnectionStatusAction,
                                {
                                  connectionId: connection.id,
                                  status: "observation",
                                },
                              );
                            }
                          }}
                        >
                          <Pause size={15} aria-hidden="true" />
                          Voltar para observacao
                        </button>
                      ) : null}
                      <button
                        className="button"
                        type="button"
                        disabled={Boolean(connectionPending)}
                        onClick={() =>
                          runConnectionAction(
                            `status-${connection.id}`,
                            setConnectionStatusAction,
                            {
                              connectionId: connection.id,
                              status:
                                connection.status === "paused"
                                  ? "observation"
                                  : "paused",
                            },
                          )
                        }
                      >
                        {connection.status === "paused" ? (
                          <Play size={15} aria-hidden="true" />
                        ) : (
                          <Pause size={15} aria-hidden="true" />
                        )}
                        {connection.status === "paused"
                          ? "Retomar observacao"
                          : "Pausar conexão"}
                      </button>
                      <button
                        className="button"
                        type="button"
                        disabled={Boolean(connectionPending)}
                        onClick={() => {
                          if (
                            window.confirm(
                              "Gerar uma nova URL invalida a URL atual. Continuar?",
                            )
                          ) {
                            void runConnectionAction(
                              `rotate-${connection.id}`,
                              rotateSecretAction,
                              { connectionId: connection.id },
                            );
                          }
                        }}
                      >
                        <RefreshCw size={15} aria-hidden="true" />
                        Gerar nova URL
                      </button>
                      <button
                        className="button danger"
                        type="button"
                        disabled={Boolean(connectionPending)}
                        onClick={() => {
                          if (
                            window.confirm(
                              "Remover a conexao? O historico observado sera preservado.",
                            )
                          ) {
                            void runConnectionAction(
                              `remove-${connection.id}`,
                              removeConnectionAction,
                              { connectionId: connection.id },
                            );
                          }
                        }}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                        Remover
                      </button>
                    </div>
                  ) : null}

                  <div className="inbound-channel-list">
                    <div className="inbound-channel-heading">
                      <span>Canal</span>
                      <span>Numero conectado</span>
                      <span>Prontidao</span>
                      <span>Ultimo evento</span>
                    </div>
                    {canManage &&
                    allowsManualChannelRegistration(connection.provider) ? (
                      <ChannelCreateForm
                        connectionId={connection.id}
                        pending={
                          pendingAction === `create-channel-${connection.id}`
                        }
                        onCreate={(values) =>
                          runConnectionAction(
                            `create-channel-${connection.id}`,
                            createChannelAction,
                            values,
                          )
                        }
                      />
                    ) : null}
                    {channels.length === 0 ? (
                      <p className="muted inbound-channel-empty">
                        {connection.provider === "data_crazy"
                          ? "O canal aparece sozinho quando o primeiro webhook do Data Crazy chegar. Envie uma mensagem de teste para liberar as regras."
                          : connection.provider === "unnichat"
                            ? "Esta conexão ainda não tem o número do cliente. Remova-a e crie de novo informando o número de WhatsApp atendido pelo Unnichat."
                            : "Nenhum canal cadastrado ainda. Cadastre o número conectado para liberar as regras de conversão antes do primeiro lead chegar."}
                      </p>
                    ) : (
                      channels.map((channel) => {
                        const readiness = channel.readiness;

                        return (
                          <details className="inbound-channel" key={channel.id}>
                            <summary>
                              <strong>
                                <PresentationMask placeholder="Canal oculto">
                                  {channel.channelName ?? "Canal sem nome"}
                                </PresentationMask>
                              </strong>
                              <span>
                                <PresentationMask placeholder="Numero oculto">
                                  {channel.connectedPhone}
                                </PresentationMask>
                              </span>
                              <div className="inbound-readiness-summary">
                                <span
                                  className={`event-chip ${readinessChipTone(readiness.state)}`}
                                >
                                  {readinessStateLabel(readiness.state)}
                                </span>
                                <small>
                                  Canal {channelStatusLabel(channel.status)}
                                </small>
                              </div>
                              <span>{formatDateTime(channel.lastSeenAt)}</span>
                            </summary>
                            <div className="inbound-channel-body">
                              <ChannelReadiness readiness={readiness} />
                              {canManage ? (
                                <div className="inbound-channel-actions">
                                  <button
                                    className="button"
                                    type="button"
                                    disabled={Boolean(
                                      pendingAction?.includes(channel.id),
                                    )}
                                    onClick={() => {
                                      const activating =
                                        channel.status !== "active";

                                      if (
                                        activating &&
                                        connection.status === "production" &&
                                        !window.confirm(
                                          "Ativar o envio deste canal? Novos CTWA com rota valida poderao ser enviados automaticamente.",
                                        )
                                      ) {
                                        return;
                                      }

                                      void runConnectionAction(
                                        `channel-${channel.id}`,
                                        setChannelStatusAction,
                                        {
                                          channelId: channel.id,
                                          status:
                                            channel.status === "active"
                                              ? "paused"
                                              : "active",
                                        },
                                      );
                                    }}
                                  >
                                    {channel.status === "active" ? (
                                      <Pause size={15} aria-hidden="true" />
                                    ) : (
                                      <Play size={15} aria-hidden="true" />
                                    )}
                                    {channel.status === "active"
                                      ? "Pausar envio"
                                      : "Ativar envio"}
                                  </button>
                                </div>
                              ) : null}
                              {canRecover && connection.provider === "meta_cloud" ? <InboundRecoveryPanel connectionId={connection.id} channelId={channel.id} connectionName={connection.displayName} /> : null}
                              {connection.provider === "unnichat" ? (
                                <InboundWebhookRoutingMode
                                  channel={channel}
                                  metaConfiguration={metaConfiguration}
                                  canManage={canManage}
                                  saveAction={saveRoutesAction}
                                  onUpdated={onRoutesUpdated}
                                />
                              ) : (
                                <InboundWebhookRouteEditor
                                  channel={channel}
                                  metaConfiguration={metaConfiguration}
                                  canManage={canManage}
                                  saveAction={saveRoutesAction}
                                  onUpdated={onRoutesUpdated}
                                />
                              )}
                            </div>
                          </details>
                        );
                      })
                    )}
                  </div>

                  {connection.provider === "umbler" ||
                  connection.provider === "unnichat" ? (
                    <section className="provider-conversion-summary">
                      <div className="provider-conversion-summary-icon">
                        <Settings2 size={18} aria-hidden="true" />
                      </div>
                      <div className="provider-conversion-summary-copy">
                        <span className="eyebrow">Gatilhos de conversao</span>
                        <strong>
                          {
                            providerRules.filter(
                              (rule) => rule.connectionId === connection.id,
                            ).length
                          }{" "}
                          regra(s) nesta conexao
                        </strong>
                        <span>
                          Crie e revise as regras na tela Conversões.
                        </span>
                      </div>
                      <span
                        className={`event-chip ${
                          providerRulesEnabled ? "success" : "warn"
                        }`}
                      >
                        {providerRulesEnabled
                          ? "Regras disponíveis"
                          : "Regras indisponiveis"}
                      </span>
                      <Link
                        className="button"
                        href="/conversions"
                      >
                        <Settings2 size={15} aria-hidden="true" />
                        Abrir Conversões
                      </Link>
                    </section>
                  ) : null}
                </div>
              </details>
            );
          })
        )}
      </div>
      </fieldset>
    </section>
  );
}

export function InboundWebhookOneTimeSecretPanel({
  secret,
  urlCopied,
  onCopyUrl,
  onCopyVerifyToken,
  onDismiss,
}: {
  secret: InboundWebhookOneTimeSecret;
  urlCopied: boolean;
  onCopyUrl: () => void;
  onCopyVerifyToken: () => void;
  onDismiss: () => void;
}) {
  const providerLabel = inboundWebhookProviderLabel(secret.provider);
  const providerPreposition = secret.provider === "data_crazy" || secret.provider === "unnichat" ? "no" : "na";
  const showVerifyToken = secret.provider === "meta_cloud";

  return (
    <div
      className="inbound-webhook-secret"
      data-presentation-sensitive-action="true"
    >
      <div className="inbound-webhook-secret-heading">
        <div>
          <span className="micro-label">
            {showVerifyToken
              ? "URL e token exibidos uma única vez"
              : "URL exibida uma única vez"}
          </span>
          <strong>
            Cadastre este webhook {providerPreposition} {providerLabel} agora
          </strong>
          <p className="muted">{inboundPasteInstruction(secret.provider)}</p>
        </div>
        <button
          className="icon-button"
          type="button"
          title={showVerifyToken ? "Ocultar URL e token" : "Ocultar URL"}
          aria-label={showVerifyToken ? "Ocultar URL e token" : "Ocultar URL"}
          onClick={onDismiss}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="inbound-webhook-secret-field">
        <span className="micro-label">URL de callback</span>
        <div className="inbound-webhook-secret-field-row">
          <input
            readOnly
            value={secret.webhookUrl}
            aria-label={`URL privada do webhook ${providerLabel}`}
            data-presentation-sensitive-field="true"
          />
          <button className="button" type="button" onClick={onCopyUrl}>
            {urlCopied ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <Copy size={16} aria-hidden="true" />
            )}
            {urlCopied ? "Copiada" : "Copiar URL"}
          </button>
        </div>
      </div>

      {showVerifyToken ? (
        <div className="inbound-webhook-secret-field">
          <span className="micro-label">
            Verify token (token de verificacao)
          </span>
          <div className="inbound-webhook-secret-field-row">
            <input
              readOnly
              value={secret.verifyToken ?? ""}
              aria-label="Token de verificacao Meta"
              data-presentation-sensitive-field="true"
            />
            <button
              className="button"
              type="button"
              onClick={onCopyVerifyToken}
            >
              <Copy size={16} aria-hidden="true" />
              Copiar token
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChannelCreateForm({
  connectionId,
  pending,
  onCreate,
}: {
  connectionId: string;
  pending: boolean;
  onCreate: (values: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [connectedPhone, setConnectedPhone] = useState("");
  const [channelName, setChannelName] = useState("");

  if (!open) {
    return (
      <button
        className="button inbound-channel-create-toggle"
        type="button"
        onClick={() => setOpen(true)}
      >
        <Plus size={15} aria-hidden="true" />
        Cadastrar canal/numero
      </button>
    );
  }

  return (
    <form
      className="inbound-channel-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate({ connectionId, connectedPhone, channelName });
        setConnectedPhone("");
        setChannelName("");
        setOpen(false);
      }}
    >
      <label>
        <span className="field-label">Numero conectado</span>
        <input
          value={connectedPhone}
          onChange={(event) => setConnectedPhone(event.target.value)}
          placeholder="Ex.: (11) 99999-8888"
          inputMode="tel"
          minLength={8}
          maxLength={32}
          required
          disabled={pending}
        />
      </label>
      <label>
        <span className="field-label">Nome do canal (opcional)</span>
        <input
          value={channelName}
          onChange={(event) => setChannelName(event.target.value)}
          maxLength={160}
          placeholder="Ex.: Comercial - unidade 1"
          disabled={pending}
        />
      </label>
      <button className="button primary" type="submit" disabled={pending}>
        <Plus size={15} aria-hidden="true" />
        {pending ? "Cadastrando..." : "Cadastrar canal"}
      </button>
      <button
        className="button"
        type="button"
        onClick={() => setOpen(false)}
        disabled={pending}
      >
        Cancelar
      </button>
    </form>
  );
}

function ObservationCounter({
  label,
  tone = "",
  value,
}: {
  label: string;
  tone?: "" | "success" | "warn" | "error";
  value: number;
}) {
  return (
    <div className={`inbound-counter${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ChannelReadiness({
  readiness,
}: {
  readiness: InboundWebhookChannelDto["readiness"];
}) {
  const ready = readiness.state === "ready" || readiness.state === "complete";
  const destination = readiness.routingSource
    ? readiness.ctwaDestinationReadiness
    : undefined;

  return (
    <section
      className="inbound-readiness"
      aria-label="Prontidao operacional do canal"
    >
      <div className="inbound-readiness-heading">
        <div className="inbound-readiness-title">
          {ready ? (
            <ShieldCheck className="success" size={18} aria-hidden="true" />
          ) : (
            <AlertTriangle className="warn" size={18} aria-hidden="true" />
          )}
          <div>
            <span className="micro-label">Prontidão do canal</span>
            <strong>{readinessStateLabel(readiness.state)}</strong>
          </div>
        </div>
        {readiness.nextPayloadExpiresAt ? (
          <span className="inbound-readiness-expiry">
            Próxima expiração:{" "}
            <strong>{formatDateTime(readiness.nextPayloadExpiresAt)}</strong>
          </span>
        ) : null}
      </div>

      <div className="inbound-readiness-metrics">
        <ReadinessMetric
          label="Rotas válidas"
          value={`${readiness.validRouteCount}/${readiness.routeCount}`}
        />
        <ReadinessMetric label="CTWA observados" value={readiness.totalCtwa} />
        <ReadinessMetric
          label="Roteados preservados"
          value={readiness.retainedRoutedCtwa}
          tone={readiness.retainedRoutedCtwa > 0 ? "success" : ""}
        />
        <ReadinessMetric
          label="CTWA pendentes"
          value={readiness.unresolvedCtwa}
          tone={readiness.unresolvedCtwa > 0 ? "warn" : ""}
        />
      </div>

      {readiness.routingSource ? (
        <p className="muted inbound-readiness-routing">
          Roteamento Meta:{" "}
          <strong>
            {unnichatRoutingSourceLabel(readiness.routingSource)}
          </strong>
        </p>
      ) : null}
      {destination?.status === "verified" ? (
        <p className="inbound-readiness-clear inbound-readiness-destination">
          <Check size={14} aria-hidden="true" /> Destino Meta verificado: um
          único par de página e pixel para a conversa sem ID do anúncio.
        </p>
      ) : null}
      {destination?.status === "not_ready" ? (
        <p className="action-note warn inbound-readiness-destination">
          {ctwaDestinationReasonLabel(destination.reason)}
        </p>
      ) : null}

      {readiness.blockers.length > 0 ? (
        <ul className="inbound-readiness-blockers">
          {readiness.blockers.map((blocker) => (
            <li key={blocker}>{readinessBlockerLabel(blocker, readiness)}</li>
          ))}
        </ul>
      ) : (
        <p className="inbound-readiness-clear">
          Rota e payload preservado prontos para a revisao operacional.
        </p>
      )}
      <p className="muted">
        A prontidão da rota não ativa envios: a conexão ainda exige parser
        certificado e produção habilitada. CTWA anteriores à ativação não são
        enviados automaticamente.
      </p>

      {readiness.alreadyMaterializedCtwa > 0 ? (
        <p className="muted inbound-readiness-materialized">
          {readiness.alreadyMaterializedCtwa} CTWA ja materializado(s).
        </p>
      ) : null}
    </section>
  );
}

function ReadinessMetric({
  label,
  tone = "",
  value,
}: {
  label: string;
  tone?: "" | "success" | "warn";
  value: number | string;
}) {
  return (
    <div className={`inbound-readiness-metric${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function readinessStateLabel(
  state: InboundWebhookChannelDto["readiness"]["state"],
) {
  const labels = {
    waiting: "Aguardando CTWA",
    blocked: "Bloqueado",
    partial: "Prontidao parcial",
    ready: "Rota pronta",
    complete: "Concluido",
  } as const;

  return labels[state];
}

function readinessChipTone(
  state: InboundWebhookChannelDto["readiness"]["state"],
) {
  if (state === "ready" || state === "complete") {
    return "";
  }

  return state === "blocked" ? "bad" : "warn";
}

function readinessBlockerLabel(
  blocker: InboundWebhookChannelDto["readiness"]["blockers"][number],
  readiness: InboundWebhookChannelDto["readiness"],
) {
  const labels = {
    connection_paused: "A conexao de webhook esta pausada.",
    channel_paused: "Este canal esta pausado.",
    route_not_configured: readiness.routingSource
      ? unnichatRouteNotConfiguredLabel(readiness)
      : "Configure ao menos uma rota Meta para este canal.",
    route_not_valid: "Existe uma rota Meta que precisa ser validada novamente.",
    ctwa_not_observed: "Nenhum CTWA foi observado neste canal.",
    ctwa_unresolved: readiness.unresolvedCtwa === 1
      ? "1 CTWA aguarda uma rota Meta exata."
      : `${readiness.unresolvedCtwa} CTWA aguardam uma rota Meta exata.`,
    ctwa_ad_unavailable: adUnavailableLabel(readiness.adUnavailableCtwa ?? 0),
    payload_unavailable: `${readiness.payloadUnavailableCtwa} CTWA não possuem mais payload disponível.`,
    payload_expiring_soon:
      "O payload preservado mais proximo expira em menos de 48 horas.",
  } as const;

  return labels[blocker];
}

function channelStatusLabel(status: InboundWebhookChannelDto["status"]) {
  if (status === "active") {
    return "habilitado";
  }

  if (status === "paused") {
    return "pausado";
  }

  return "descoberto";
}

function connectionStatusLabel(
  status: InboundWebhookConnectionOverviewDto["connection"]["status"],
) {
  if (status === "production") {
    return "Envio automatico";
  }

  if (status === "observation") {
    return "Observando";
  }

  return "Pausada";
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "Ainda não recebida";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Data indisponivel";
  }

  return date.toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: displayTimeZone,
  });
}
