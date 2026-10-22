"use client";

import type {
  ConversionEventNameDto,
  IntegrationDetectedProductDto,
  IntegrationEndpointDto,
  IntegrationUnattributedEventListDto,
  LegacyConversionRuleDto,
  ProviderConversionRuleCapabilitiesDto,
  ProviderConversionRuleDto,
  ProviderConversionRuleOriginDto,
  ProviderConversionRuleUnifyCandidateDto,
} from "@wpptrack/shared";
import {
  ArrowUpRight,
  History,
  Pause,
  Play,
  Plus,
  Send,
  Settings2,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "../../../components/modal";
import { PresentationMask } from "../../../components/presentation-mask";
import type {
  ConversionScreenActionResult,
  ProviderConversionRuleActionResult,
} from "./actions";
import { ruleEventFilterLabel } from "./event-copy";
import {
  ruleOriginDefinition,
  type RuleOriginId,
} from "./conversion-origins";
import {
  activeFilterCount,
  emptyRuleFilters,
  filterRuleRows,
  ineligibleNumbers,
  type ConversionConnection,
  type ConversionNumber,
  type ConversionRuleRow,
  type RuleFilters,
  type RuleStatusFilter,
} from "./conversion-rules-view";
import type { ComingSoonNumber } from "./conversions-data";
import { conversionsLicenseLockedNote } from "./license-lock";
import { NumbersWithoutRules } from "./numbers-without-rules";
import {
  UnattributedSalesList,
  type SingleUrlActions,
} from "../integrations/single-url/single-url-panels";
import { LegacyRules, type LegacyRuleActions } from "./legacy-rules";
import { NewRuleFlow } from "./new-rule-flow";
import { RuleExecutions } from "./rule-executions";
import {
  RuleManage,
  ruleManageTabs,
  unseenUrlWarning,
  type RuleManageActions,
  type RuleManageTab,
} from "./rule-manage";
import { RuleLogo } from "./rule-logo";
import { UnifyBanner, UnifyReviewModal } from "./unify-review";

type ScreenAction = (formData: FormData) => Promise<ConversionScreenActionResult>;
type RuleAction = (formData: FormData) => Promise<ProviderConversionRuleActionResult>;

export type ConversionsScreenProps = {
  rows: ConversionRuleRow[];
  numbers: ConversionNumber[];
  connections: ConversionConnection[];
  offeredOrigins: RuleOriginId[];
  /** null: a API de capacidades não respondeu; “Nova regra” fica desligada. */
  capabilities: ProviderConversionRuleCapabilitiesDto | null;
  comingSoonNumbers?: ComingSoonNumber[];
  /** Licença bloqueada: toda escrita fica desabilitada. */
  licenseLocked?: boolean;
  unifyGroups: ProviderConversionRuleUnifyCandidateDto[];
  canManage: boolean;
  rulesState: "real" | "error" | "disabled";
  numbersPartial: boolean;
  crmVisible: boolean;
  crmError: boolean;
  initialOrigin?: RuleOriginId | null;
  createAction: ScreenAction;
  confirmCreateAction: ScreenAction;
  unifyAction: ScreenAction;
  updateRuleAction: RuleAction;
  loadExecutionsAction: RuleAction;
  /** Full provider rules (edit form needs phrases, value, catalog...). */
  providerRules?: ProviderConversionRuleDto[];
  legacyRules?: LegacyConversionRuleDto[];
  legacyRulesState?: "real" | "error";
  ruleActions?: Omit<RuleManageActions, "update">;
  legacyActions?: LegacyRuleActions;
  /** Fase 5.3: URL única/por evento, produtos e vendas sem atribuição. */
  singleUrl?: ConversionsSingleUrl;
};

export type ConversionsSingleUrl = {
  endpoints: IntegrationEndpointDto[];
  paytProducts: IntegrationDetectedProductDto[];
  paytUnattributed: IntegrationUnattributedEventListDto | null;
  actions: SingleUrlActions;
};

type ManageTarget = {
  row: ConversionRuleRow;
  /** Rule as it was when opened: kept if a refresh drops it from the list. */
  rule: ProviderConversionRuleDto;
  tab: RuleManageTab;
};

/** New automation address not yet confirmed as copied (shown only once). */
type FreshEndpoint = { ruleId: string; webhookUrl: string };

type Notice = { tone: "success" | "warn"; message: string };

type PendingConfirm = {
  row: ConversionRuleRow;
  title: string;
  body: string;
  confirmLabel: string;
  patch: { mode?: "observation" | "production"; active?: boolean };
};

const statusTone: Record<ConversionRuleRow["status"], string> = {
  production: "",
  observation: " neutral",
  paused: " warn",
  unified: " neutral",
};

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  });
}

export function ConversionsScreen({
  rows,
  numbers,
  connections,
  offeredOrigins,
  capabilities,
  comingSoonNumbers = [],
  licenseLocked = false,
  unifyGroups,
  canManage,
  rulesState,
  numbersPartial,
  crmVisible,
  crmError,
  initialOrigin = null,
  createAction,
  confirmCreateAction,
  unifyAction,
  updateRuleAction,
  loadExecutionsAction,
  providerRules = [],
  legacyRules = [],
  legacyRulesState = "real",
  ruleActions,
  legacyActions,
  singleUrl,
}: ConversionsScreenProps) {
  const router = useRouter();
  const [filters, setFilters] = useState<RuleFilters>(emptyRuleFilters);
  const [newRuleOpen, setNewRuleOpen] = useState(
    Boolean(canManage && initialOrigin),
  );
  const [flowKey, setFlowKey] = useState(0);
  const [flowBusy, setFlowBusy] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [unifyGroup, setUnifyGroup] =
    useState<ProviderConversionRuleUnifyCandidateDto | null>(null);
  const [executionsRow, setExecutionsRow] = useState<ConversionRuleRow | null>(
    null,
  );
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [manage, setManage] = useState<ManageTarget | null>(null);
  const rulesById = useMemo(
    () => new Map(providerRules.map((rule) => [rule.id, rule])),
    [providerRules],
  );
  const manageRule = manage ? (rulesById.get(manage.row.id) ?? manage.rule) : null;
  const [freshEndpoint, setFreshEndpoint] = useState<FreshEndpoint | null>(null);
  const [closeGuard, setCloseGuard] = useState(false);
  const freshUrl =
    manage && freshEndpoint?.ruleId === manage.row.id ? freshEndpoint.webhookUrl : null;

  // The old address is already invalid: leaving the page now would lose the
  // only copy of the new one.
  useEffect(() => {
    if (!freshEndpoint) return;
    const keepPage = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", keepPage);
    return () => window.removeEventListener("beforeunload", keepPage);
  }, [freshEndpoint]);

  function closeManage() {
    if (freshUrl) {
      setCloseGuard(true);
      return;
    }
    setCloseGuard(false);
    setManage(null);
  }
  const manageActions: RuleManageActions | null = ruleActions
    ? { ...ruleActions, update: updateRuleAction }
    : null;
  const [confirmPending, setConfirmPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const visibleRows = useMemo(() => filterRuleRows(rows, filters), [rows, filters]);
  const filterCount = activeFilterCount(filters);
  const origins = useMemo(
    () => [...new Set(rows.map((row) => row.origin))],
    [rows],
  );
  const eventFilterOptions = useMemo(() => {
    const originsByEvent = new Map<string, string[]>();
    for (const row of rows) {
      originsByEvent.set(row.eventName, [
        ...(originsByEvent.get(row.eventName) ?? []),
        row.origin,
      ]);
    }
    return [...originsByEvent.entries()]
      .map(([eventName, eventOrigins]) => ({
        eventName: eventName as ConversionEventNameDto,
        label: ruleEventFilterLabel(eventName, eventOrigins),
      }))
      .sort((left, right) => left.label.localeCompare(right.label, "pt-BR"));
  }, [rows]);
  const liveCount = rows.filter((row) => row.status === "production").length;
  const observationCount = rows.filter((row) => row.status === "observation").length;

  function openNewRule() {
    openNewRuleReset();
    setFlowKey((key) => key + 1);
    setNewRuleOpen(true);
  }

  function openNewRuleReset() {
    setCloseBlocked(false);
  }

  function closeNewRule() {
    // An unconfirmed create keeps its exact request in the flow: closing
    // would lose it and invite a duplicate. Confirm it first.
    if (flowBusy) {
      setCloseBlocked(true);
      return;
    }
    setCloseBlocked(false);
    setNewRuleOpen(false);
    router.refresh();
  }

  async function runConfirm() {
    if (!confirm || confirmPending) return;
    setConfirmPending(true);
    const formData = new FormData();
    formData.set("ruleId", confirm.row.id);
    formData.set("payload", JSON.stringify(confirm.patch));
    try {
      const result = await updateRuleAction(formData);
      setNotice({
        tone: result.ok ? "success" : "warn",
        message: result.ok ? confirmSuccess(confirm) : result.message,
      });
      if (result.ok) router.refresh();
    } catch {
      setNotice({
        tone: "warn",
        message: "Não deu para confirmar a mudança. Atualize a página para conferir.",
      });
    } finally {
      setConfirmPending(false);
      setConfirm(null);
    }
  }

  return (
    <div className="conversions-screen">
      <div className="conversions-toolbar">
        <div className="conversions-summary" aria-live="polite">
          <span className="status-chip">
            {liveCount} com envio automático
          </span>
          <span className="status-chip neutral">
            {observationCount} em observação
          </span>
          <span className="conversions-summary-total">
            {rows.length} {rows.length === 1 ? "regra" : "regras"} no total
          </span>
        </div>
        {canManage ? (
          <button
            className="button primary"
            type="button"
            onClick={openNewRule}
            aria-haspopup="dialog"
            disabled={rulesState !== "real" || !capabilities || licenseLocked}
          >
            <Plus size={16} aria-hidden="true" />
            Nova regra
          </button>
        ) : null}
      </div>

      {notice ? (
        <div
          className={`feedback-banner ${notice.tone}`}
          role="status"
        >
          <span>{notice.message}</span>
        </div>
      ) : null}

      {rulesState !== "real" ? (
        <div className="feedback-banner warn" role="alert">
          <strong>
            {rulesState === "disabled"
              ? "Regras de conversão desligadas nesta instalação"
              : "Não foi possível carregar as regras agora"}
          </strong>
          <span>
            {rulesState === "disabled"
              ? "Ligue INBOUND_WEBHOOKS_ENABLED e INBOUND_CONVERSION_RULES_ENABLED no .env da API (veja docs/setup/environment.md); depois as regras aparecem aqui."
              : "Atualize a página em alguns instantes. Nenhuma regra foi alterada."}
          </span>
        </div>
      ) : null}

      {canManage && licenseLocked ? (
        <p className="action-note warn" role="status">
          {conversionsLicenseLockedNote}
        </p>
      ) : null}

      {rulesState === "real" && !capabilities ? (
        <p className="action-note warn" role="status">
          Não deu para confirmar quais origens de regra estão disponíveis agora.
          A lista continua valendo; atualize a página para criar uma regra nova.
        </p>
      ) : null}

      <UnifyBanner
        groups={unifyGroups}
        canManage={canManage && !licenseLocked}
        onReview={setUnifyGroup}
      />

      <form
        className="conversions-filters provider-conversion-builder"
        aria-label="Filtrar regras"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          <span className="field-label">Origem</span>
          <select
            value={filters.origin}
            onChange={(event) =>
              setFilters({ ...filters, origin: event.target.value as RuleFilters["origin"] })
            }
          >
            <option value="all">Todas</option>
            {origins.map((origin) => (
              <option key={origin} value={origin}>
                {ruleOriginDefinition(origin).label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Número</span>
          <select
            value={filters.numberId}
            onChange={(event) => setFilters({ ...filters, numberId: event.target.value })}
            data-presentation-sensitive-field="true"
          >
            <option value="all">Todos</option>
            {numbers.map((number) => (
              <option key={number.id} value={number.id}>
                {number.label === number.connectionName
                  ? number.label
                  : `${number.label} (${number.connectionName})`}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Evento</span>
          <select
            value={filters.eventName}
            onChange={(event) => setFilters({ ...filters, eventName: event.target.value })}
          >
            <option value="all">Todos</option>
            {eventFilterOptions.map((option) => (
              <option key={option.eventName} value={option.eventName}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Status</span>
          <select
            value={filters.status}
            onChange={(event) =>
              setFilters({ ...filters, status: event.target.value as RuleStatusFilter })
            }
          >
            <option value="all">Todos</option>
            <option value="production">Envio automático</option>
            <option value="observation">Observação</option>
            <option value="paused">Pausadas</option>
            <option value="unified">Unificadas</option>
          </select>
        </label>
        {filterCount > 0 ? (
          <button
            className="button ghost"
            type="button"
            onClick={() => setFilters(emptyRuleFilters)}
          >
            Limpar filtros
          </button>
        ) : null}
      </form>

      <NumbersWithoutRules
        comingSoon={comingSoonNumbers}
        webhookOnly={ineligibleNumbers(numbers, capabilities)}
      />

      {numbersPartial ? (
        <p className="action-note warn">
          Não deu para ler os números de alguma conexão agora. Os nomes de
          alguns números podem aparecer como “número removido”.
        </p>
      ) : null}

      <section className="conversions-list-section" aria-labelledby="conversions-list-title">
        <h2 id="conversions-list-title" className="sr-only">
          Regras de conversão
        </h2>
        {rows.length === 0 && rulesState === "real" ? (
          <div className="conversions-empty">
            <strong>Nenhuma regra ainda</strong>
            <p className="muted">
              Uma regra diz quando uma conversa vira conversão na Meta: uma
              frase, uma etiqueta, uma compra ou uma etapa do CRM.
            </p>
            {canManage ? (
              <button className="button primary" type="button" onClick={openNewRule}>
                <Plus size={16} aria-hidden="true" />
                Criar a primeira regra
              </button>
            ) : null}
          </div>
        ) : visibleRows.length === 0 && rows.length > 0 ? (
          <div className="conversions-empty">
            <strong>Nenhuma regra com estes filtros</strong>
            <button
              className="button"
              type="button"
              onClick={() => setFilters(emptyRuleFilters)}
            >
              Limpar filtros
            </button>
          </div>
        ) : visibleRows.length > 0 ? (
          <>
            <div className="conversion-rule-head" aria-hidden="true">
              <span>Regra</span>
              <span>Evento</span>
              <span>Alcance</span>
              <span>Status</span>
              <span />
            </div>
            <ul className="conversion-rule-list" role="list">
              {visibleRows.map((row) => (
                <li key={row.key} className="conversion-rule-row" data-origin={row.origin}>
                  <RuleRow
                    row={row}
                    canManage={canManage}
                    licenseLocked={licenseLocked}
                    manageTabs={
                      manageActions && rulesById.has(row.id)
                        ? ruleManageTabs(
                            row.origin as ProviderConversionRuleOriginDto,
                            rulesById.get(row.id)!,
                            canManage,
                          ).map((tab) => tab.id)
                        : []
                    }
                    onExecutions={() => setExecutionsRow(row)}
                    onManage={(tab) => {
                      const rule = rulesById.get(row.id);
                      if (rule) setManage({ row, rule, tab });
                    }}
                    onConfirm={setConfirm}
                  />
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {!crmVisible ? (
          <p className="action-note">
            As regras de CRM (Kommo, Pipedrive) aparecem só para o responsável da
            conta, que também as edita em Integrações, na aba CRM.
          </p>
        ) : crmError ? (
          <p className="action-note warn">
            Não deu para ler as regras de algum CRM agora.
          </p>
        ) : null}
      </section>

      {singleUrl &&
      singleUrl.paytUnattributed &&
      singleUrl.paytUnattributed.total > 0 ? (
        <section
          className="conversions-list-section conversions-unattributed"
          aria-labelledby="conversions-unattributed-title"
        >
          <h2 id="conversions-unattributed-title">Vendas sem atribuição</h2>
          <UnattributedSalesList
            list={singleUrl.paytUnattributed}
            canManage={canManage}
            licenseLocked={licenseLocked}
            retry={singleUrl.actions.retry}
          />
        </section>
      ) : null}

      {legacyActions ? (
        <LegacyRules
          rules={legacyRules}
          state={legacyRulesState}
          numbers={numbers}
          capabilities={capabilities}
          canManage={canManage}
          licenseLocked={licenseLocked}
          actions={legacyActions}
        />
      ) : null}

      <Modal
        open={newRuleOpen}
        onClose={closeNewRule}
        title="Nova regra"
        description="Origem, evento, alcance e detalhes. Toda regra começa em observação."
        size="wide"
        id="conversion-new-rule"
      >
        {newRuleOpen && closeBlocked && flowBusy ? (
          <p className="action-note warn conversion-close-blocked" role="alert">
            Este pedido ainda não foi confirmado. Use “Conferir e concluir”
            antes de fechar: repetir o mesmo pedido nunca duplica a regra.
          </p>
        ) : null}
        {newRuleOpen ? (
          <NewRuleFlow
            key={flowKey}
            offeredOrigins={offeredOrigins}
            initialOrigin={flowKey === 0 ? initialOrigin : null}
            numbers={numbers}
            connections={connections}
            capabilities={capabilities}
            comingSoonNumbers={comingSoonNumbers}
            licenseLocked={licenseLocked}
            createAction={createAction}
            confirmAction={confirmCreateAction}
            paytProducts={singleUrl?.paytProducts}
            integrationEndpoints={singleUrl?.endpoints}
            singleUrlActions={singleUrl?.actions}
            onBusyChange={setFlowBusy}
            onFinished={() => {
              setCloseBlocked(false);
              setNewRuleOpen(false);
              router.refresh();
            }}
          />
        ) : null}
      </Modal>

      <UnifyReviewModal
        key={unifyGroup?.key ?? "none"}
        group={unifyGroup}
        numbers={numbers}
        unifyAction={unifyAction}
        onClose={() => setUnifyGroup(null)}
        onDone={() => {
          setUnifyGroup(null);
          router.refresh();
        }}
      />

      <Modal
        open={executionsRow !== null}
        onClose={() => setExecutionsRow(null)}
        title="Últimas execuções"
        description={executionsRow?.name}
        size="wide"
      >
        {executionsRow ? (
          <RuleExecutions
            ruleId={executionsRow.id}
            loadAction={loadExecutionsAction}
            purchaseReviewHref={
              executionsRow.eventName === "Purchase"
                ? `/events/purchase-reviews?providerRuleId=${encodeURIComponent(executionsRow.id)}`
                : null
            }
          />
        ) : null}
      </Modal>

      <Modal
        open={manage !== null}
        onClose={closeManage}
        title={manage ? `Gerenciar “${manage.row.name}”` : "Gerenciar regra"}
        description={
          manage ? `${manage.row.originLabel} · ${manage.row.eventLabel}` : undefined
        }
        size="wide"
        id="conversion-manage-rule"
      >
        {closeGuard && freshUrl ? (
          <div className="conversion-inline-confirm conversion-close-blocked" role="alert">
            <p>{unseenUrlWarning}</p>
            <div className="conversion-flow-actions">
              <button className="button" type="button" onClick={() => setCloseGuard(false)}>
                Voltar e copiar
              </button>
              <button
                className="button primary"
                type="button"
                onClick={() => {
                  setFreshEndpoint(null);
                  setCloseGuard(false);
                  setManage(null);
                }}
              >
                Já copiei, fechar
              </button>
            </div>
          </div>
        ) : null}
        {manage && manageRule && manageActions ? (
          <RuleManage
            key={manage.row.id}
            rule={manageRule}
            origin={manage.row.origin as ProviderConversionRuleOriginDto}
            numbers={numbers}
            connections={connections}
            capabilities={capabilities}
            comingSoonNumbers={comingSoonNumbers}
            canManage={canManage}
            licenseLocked={licenseLocked}
            actions={manageActions}
            integrationEndpoints={singleUrl?.endpoints}
            paytProducts={singleUrl?.paytProducts}
            singleUrlActions={singleUrl?.actions}
            initialTab={manage.tab}
            freshUrl={freshUrl}
            onFreshUrl={(webhookUrl) => setFreshEndpoint({ ruleId: manage.row.id, webhookUrl })}
            onDismissFreshUrl={() => {
              setFreshEndpoint(null);
              setCloseGuard(false);
            }}
            onSaved={(message) => {
              setManage(null);
              setNotice({ tone: "success", message });
              router.refresh();
            }}
            onRemoved={(message) => {
              setManage(null);
              setNotice({ tone: "success", message });
              router.refresh();
            }}
            onChanged={() => router.refresh()}
          />
        ) : null}
      </Modal>

      <Modal
        open={confirm !== null}
        onClose={() => (confirmPending ? undefined : setConfirm(null))}
        title={confirm?.title ?? ""}
        description={confirm?.row.name}
      >
        {confirm ? (
          <div className="conversion-confirm">
            <p>{confirm.body}</p>
            <div className="conversion-flow-actions">
              <button
                className="button"
                type="button"
                onClick={() => setConfirm(null)}
                disabled={confirmPending}
              >
                Cancelar
              </button>
              <button
                className="button primary"
                type="button"
                onClick={() => void runConfirm()}
                disabled={confirmPending}
                data-pending={confirmPending ? "true" : undefined}
              >
                {confirmPending ? "Salvando..." : confirm.confirmLabel}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function confirmSuccess(confirm: PendingConfirm): string {
  if (confirm.patch.mode === "production") {
    return `“${confirm.row.name}” agora envia o evento para a Meta automaticamente.`;
  }
  if (confirm.patch.mode === "observation") {
    return `“${confirm.row.name}” voltou para observação: nada é enviado à Meta.`;
  }
  return confirm.patch.active
    ? `“${confirm.row.name}” voltou a reconhecer conversas, em observação.`
    : `“${confirm.row.name}” foi pausada.`;
}

function RuleRow({
  row,
  canManage,
  licenseLocked,
  manageTabs,
  onExecutions,
  onManage,
  onConfirm,
}: {
  row: ConversionRuleRow;
  canManage: boolean;
  licenseLocked: boolean;
  /** Tabs of "Gerenciar" (empty: the rule cannot be managed here). */
  manageTabs: RuleManageTab[];
  onExecutions: () => void;
  onManage: (tab: RuleManageTab) => void;
  onConfirm: (confirm: PendingConfirm) => void;
}) {
  return (
    <article className="conversion-rule" aria-label={row.name}>
      <div className="conversion-rule-main">
        <RuleLogo logo={row.logo} origin={row.origin} />
        <div className="conversion-rule-identity">
          <span className="conversion-rule-origin">
            {row.originLabel}
            {row.platformLabel && row.platformLabel !== row.originLabel ? (
              <> · {row.platformLabel}</>
            ) : null}
          </span>
          <strong>{row.name}</strong>
          {row.triggerDetail ? (
            <small className="conversion-rule-trigger">{row.triggerDetail}</small>
          ) : null}
        </div>
      </div>

      <div className="conversion-rule-cell" data-label="Evento">
        <span className="conversion-rule-cell-label">Evento</span>
        <span>
          {row.eventLabel}
          {row.eventBeta ? (
            <>
              {" "}
              <span className="status-chip neutral conversion-beta-chip">beta</span>
            </>
          ) : null}
        </span>
      </div>

      <div className="conversion-rule-cell" data-label="Alcance">
        <span className="conversion-rule-cell-label">Alcance</span>
        <span className={row.scope === "all_numbers" ? "conversion-scope-all" : undefined}>
          {row.scope === "specific_numbers" ? (
            <PresentationMask placeholder="Números ocultos">{row.scopeLabel}</PresentationMask>
          ) : (
            row.scopeLabel
          )}
        </span>
      </div>

      <div className="conversion-rule-cell" data-label="Status">
        <span className="conversion-rule-cell-label">Status</span>
        <span className={`status-chip${statusTone[row.status]}`}>{row.statusLabel}</span>
        {row.lastExecution ? (
          <small className="conversion-rule-last">
            Última: {row.lastExecution.label} em{" "}
            <time dateTime={row.lastExecution.occurredAt}>
              {formatDateTime(row.lastExecution.occurredAt)}
            </time>
          </small>
        ) : row.kind === "provider" ? (
          <small className="conversion-rule-last">Ainda sem execuções</small>
        ) : null}
      </div>

      <div className="conversion-rule-actions">
        {row.kind === "crm" && row.manageHref ? (
          <Link className="button ghost compact-button" href={row.manageHref}>
            Gerenciar no Hub
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        ) : null}
        {row.kind === "provider" ? (
          <button
            className="button ghost compact-button"
            type="button"
            onClick={onExecutions}
            aria-haspopup="dialog"
            aria-label={`Ver execuções de ${row.name}`}
          >
            <History size={14} aria-hidden="true" />
            Execuções
          </button>
        ) : null}
        {row.kind === "provider" && manageTabs.includes("received") ? (
          <button
            className="button ghost compact-button"
            type="button"
            onClick={() => onManage("received")}
            aria-haspopup="dialog"
            aria-label={`Ver eventos recebidos de ${row.name}`}
          >
            Eventos recebidos
          </button>
        ) : null}
        {row.kind === "provider" && manageTabs.length > 0 ? (
          <button
            className="button ghost compact-button"
            type="button"
            onClick={() => onManage("edit")}
            aria-haspopup="dialog"
            aria-label={`Gerenciar ${row.name}`}
          >
            <Settings2 size={14} aria-hidden="true" />
            {canManage ? "Gerenciar" : "Detalhes"}
          </button>
        ) : null}
        {row.kind === "provider" && canManage ? (
          <RuleStateButtons row={row} onConfirm={onConfirm} disabled={licenseLocked} />
        ) : null}
      </div>

      {row.warnings.length > 0 ? (
        <ul className="conversion-rule-notes conversion-rule-warnings" role="list">
          {row.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {row.notes.length > 0 ? (
        <ul className="conversion-rule-notes" role="list">
          {row.notes.map((note) => (
            <li key={note}>
              <PresentationMask placeholder="Detalhe oculto">{note}</PresentationMask>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function RuleStateButtons({
  row,
  onConfirm,
  disabled,
}: {
  row: ConversionRuleRow;
  onConfirm: (confirm: PendingConfirm) => void;
  disabled: boolean;
}) {
  if (!row.active) {
    return (
      <button
        className="button ghost compact-button"
        type="button"
        disabled={disabled}
        aria-label={`Retomar observação de ${row.name}`}
        onClick={() =>
          onConfirm({
            row,
            title: "Retomar observação",
            body:
              row.status === "unified"
                ? "Esta regra foi unificada. Ela volta a reconhecer conversas nos números dela, no lugar da regra para todos os números, em observação: nada é enviado à Meta até você ativar o envio."
                : "A regra volta a reconhecer conversas em observação: nada é enviado à Meta até você ativar o envio automático de novo.",
            confirmLabel: "Retomar observação",
            patch: { active: true },
          })
        }
      >
        <Play size={14} aria-hidden="true" />
        Retomar observação
      </button>
    );
  }

  return (
    <>
      {row.mode === "production" ? (
        <button
          className="button ghost compact-button"
          type="button"
          disabled={disabled}
          aria-label={`Voltar ${row.name} para observação`}
          onClick={() =>
            onConfirm({
              row,
              title: "Voltar para observação",
              body: "A regra continua reconhecendo as conversas, mas nada é enviado à Meta.",
              confirmLabel: "Voltar para observação",
              patch: { mode: "observation" },
            })
          }
        >
          <Undo2 size={14} aria-hidden="true" />
          Observar
        </button>
      ) : (
        <button
          className="button ghost compact-button"
          type="button"
          disabled={disabled}
          aria-label={`Ativar envio automático de ${row.name}`}
          onClick={() =>
            onConfirm({
              row,
              title: "Ativar envio automático",
              body: "Cada conversão reconhecida por esta regra passa a ser enviada para a Meta, pelo destino de cada número.",
              confirmLabel: "Ativar envio",
              patch: { mode: "production" },
            })
          }
        >
          <Send size={14} aria-hidden="true" />
          Ativar envio
        </button>
      )}
      <button
        className="button ghost compact-button"
        type="button"
        disabled={disabled}
        aria-label={`Pausar ${row.name}`}
        onClick={() =>
          onConfirm({
            row,
            title: "Pausar regra",
            body: "A regra para de reconhecer conversas até você reativar. O histórico continua salvo.",
            confirmLabel: "Pausar",
            patch: { active: false },
          })
        }
      >
        <Pause size={14} aria-hidden="true" />
        Pausar
      </button>
    </>
  );
}
