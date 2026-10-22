"use client";

import type {
  IntegrationDetectedProductDto,
  IntegrationEndpointDto,
  ProviderConversionRuleCapabilitiesDto,
  ProviderConversionRuleDto,
  ProviderConversionRuleOriginDto,
} from "@wpptrack/shared";
import { formatMoney } from "@wpptrack/shared";
import { Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  RuleCurrencySelect,
  useWorkspaceCurrency,
} from "../../../components/workspace-currency";
import { ProviderCatalogTestConsole } from "../settings/provider-catalog-test-console";
import { ruleEventLabelForOrigin } from "./event-copy";
import type { ProviderConversionRuleActionResult } from "./actions";
import { contactMessageProviders, ruleOriginDefinition } from "./conversion-origins";
import type { ConversionConnection, ConversionNumber } from "./conversion-rules-view";
import type { ComingSoonNumber } from "./conversions-data";
import { conversionsLicenseLockedNote } from "./license-lock";
import { MessagePhraseFields } from "./message-phrase-fields";
import { ruleCurrencyHint, ScopeStep, ValueFields } from "./new-rule-flow";
import { ReceivedEvents } from "./received-events";
import {
  buildRuleUpdatePayload,
  ruleEditCapabilities,
  ruleEditDraft,
  type RuleEditDraft,
} from "./rule-edit";
import { RuleEndpoint } from "./rule-endpoint";
import {
  ProductFilterPicker,
  type SingleUrlActions,
} from "../integrations/single-url/single-url-panels";

type RuleAction = (formData: FormData) => Promise<ProviderConversionRuleActionResult>;

export type RuleManageActions = {
  update: RuleAction;
  remove: RuleAction;
  rotateEndpoint: RuleAction;
  loadReceivedEvents: RuleAction;
  loadReceivedPayload: RuleAction;
  reprocessReceivedEvents: RuleAction;
  testCatalogMessage: RuleAction;
};

export type RuleManageTab = "edit" | "endpoint" | "received" | "catalog-test";

const automationOrigins: readonly ProviderConversionRuleOriginDto[] = [
  "automation_umbler",
  "automation_unnichat",
  "automation_payt",
];

/**
 * Tabs a rule offers (the edit tab always exists). "Eventos recebidos"
 * (data received, reprocess) is only for people who manage integrations.
 */
export function ruleManageTabs(
  origin: ProviderConversionRuleOriginDto,
  rule: Pick<ProviderConversionRuleDto, "catalog">,
  canManage = true,
): Array<{ id: RuleManageTab; label: string }> {
  const tabs: Array<{ id: RuleManageTab; label: string }> = [
    { id: "edit", label: "Editar" },
  ];
  if (automationOrigins.includes(origin)) {
    tabs.push({ id: "endpoint", label: "Endereço e configuração" });
    if (canManage) tabs.push({ id: "received", label: "Eventos recebidos" });
  }
  if (origin === "structured_catalog" && rule.catalog) {
    tabs.push({ id: "catalog-test", label: "Testar pedido" });
  }
  return tabs;
}

export const unseenUrlWarning =
  "O novo endereço só aparece agora e o anterior já parou de funcionar. Copie e cole na plataforma antes de sair daqui.";

export function deleteConfirmText(origin: ProviderConversionRuleOriginDto): string {
  return automationOrigins.includes(origin)
    ? "A regra para de reconhecer conversões na hora e o endereço dela deixa de funcionar. O histórico continua salvo. Não dá para desfazer."
    : "A regra para de reconhecer conversões na hora. O histórico continua salvo. Não dá para desfazer.";
}

/**
 * "Gerenciar" of one provider rule on the Conversions screen: edit (name,
 * reach, phrases, labels, value, catalog spellings), address and setup of
 * automations, received events with reprocess, catalog test and delete.
 */
export function RuleManage({
  rule,
  origin,
  numbers,
  connections,
  capabilities,
  comingSoonNumbers = [],
  canManage,
  licenseLocked = false,
  actions,
  initialTab = "edit",
  freshUrl = null,
  onFreshUrl,
  onDismissFreshUrl,
  onSaved,
  onRemoved,
  onChanged,
  integrationEndpoints = [],
  paytProducts = [],
  singleUrlActions,
}: {
  /** Fase 5.3: URLs únicas/por evento do workspace (sem a chave). */
  integrationEndpoints?: IntegrationEndpointDto[];
  /** Fase 5.3: produtos vistos nas vendas da Payt (filtro de produto). */
  paytProducts?: IntegrationDetectedProductDto[];
  singleUrlActions?: SingleUrlActions;
  rule: ProviderConversionRuleDto;
  origin: ProviderConversionRuleOriginDto;
  numbers: ConversionNumber[];
  connections: ConversionConnection[];
  capabilities: ProviderConversionRuleCapabilitiesDto | null;
  comingSoonNumbers?: ComingSoonNumber[];
  canManage: boolean;
  /** Licença bloqueada: as escritas ficam desabilitadas (a leitura continua). */
  licenseLocked?: boolean;
  actions: RuleManageActions;
  initialTab?: RuleManageTab;
  /**
   * New automation address of this rule not yet confirmed as copied. Held by
   * the screen (it survives tab switches, refreshes and remounts).
   */
  freshUrl?: string | null;
  onFreshUrl?: (url: string) => void;
  /** The operator said "Já copiei". */
  onDismissFreshUrl?: () => void;
  /** Edit saved: the screen closes the modal and refreshes. */
  onSaved: (message: string) => void;
  onRemoved: (message: string) => void;
  /** Something changed without closing (new address, reprocess). */
  onChanged?: () => void;
}) {
  const tabs = useMemo(
    () => ruleManageTabs(origin, rule, canManage),
    [origin, rule, canManage],
  );
  const [tab, setTab] = useState<RuleManageTab>(
    freshUrl
      ? "endpoint"
      : tabs.some((item) => item.id === initialTab)
        ? initialTab
        : "edit",
  );
  // Leaving the address tab while a new URL is unseen asks first.
  const [pendingLeave, setPendingLeave] = useState<RuleManageTab | "delete" | null>(
    null,
  );

  function leaveTo(next: RuleManageTab | "delete") {
    if (freshUrl && tab === "endpoint" && next !== "endpoint") {
      setPendingLeave(next);
      return;
    }
    go(next);
  }

  function go(next: RuleManageTab | "delete") {
    setPendingLeave(null);
    if (next === "delete") {
      setDeleting(true);
      return;
    }
    setTab(next);
  }
  const [deleting, setDeleting] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const name = rule.conversionRule.name;

  async function remove() {
    if (deletePending) return;
    setDeletePending(true);
    setDeleteError(null);
    const formData = new FormData();
    formData.set("ruleId", rule.id);
    try {
      const result = await actions.remove(formData);
      if (result.ok) {
        onRemoved(`“${name}” foi excluída. O histórico dela continua salvo.`);
        return;
      }
      setDeleteError(result.message);
    } catch {
      setDeleteError(
        "Não deu para confirmar a exclusão. Atualize a página para conferir.",
      );
    }
    setDeletePending(false);
  }

  if (deleting) {
    return (
      <div className="conversion-confirm conversion-delete-confirm">
        <p>
          <strong>Excluir “{name}”?</strong>
        </p>
        <p>{deleteConfirmText(origin)}</p>
        {deleteError ? (
          <p className="action-note warn" role="alert">
            {deleteError}
          </p>
        ) : null}
        <div className="conversion-flow-actions">
          <button
            className="button"
            type="button"
            onClick={() => {
              setDeleting(false);
              setDeleteError(null);
            }}
            disabled={deletePending}
          >
            Cancelar
          </button>
          <button
            className="button danger"
            type="button"
            onClick={() => void remove()}
            disabled={deletePending}
            data-pending={deletePending ? "true" : undefined}
          >
            <Trash2 size={15} aria-hidden="true" />
            {deletePending ? "Excluindo..." : "Excluir regra"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="conversion-manage">
      <div className="conversion-manage-bar">
        <div className="conversion-segmented" role="tablist" aria-label="Seções da regra">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`conversion-manage-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`conversion-manage-panel-${item.id}`}
              className={tab === item.id ? "is-active" : undefined}
              onClick={() => leaveTo(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {canManage ? (
          <button
            className="button ghost compact-button conversion-delete-button"
            type="button"
            onClick={() => leaveTo("delete")}
            disabled={licenseLocked}
          >
            <Trash2 size={14} aria-hidden="true" />
            Excluir regra
          </button>
        ) : null}
      </div>

      {canManage && licenseLocked ? (
        <p className="action-note warn" role="status">
          {conversionsLicenseLockedNote}
        </p>
      ) : null}

      {pendingLeave ? (
        <div className="conversion-inline-confirm" role="alert">
          <p>{unseenUrlWarning}</p>
          <div className="conversion-flow-actions">
            <button className="button" type="button" onClick={() => setPendingLeave(null)}>
              Voltar ao endereço
            </button>
            <button
              className="button primary"
              type="button"
              onClick={() => {
                const next = pendingLeave;
                onDismissFreshUrl?.();
                go(next);
              }}
            >
              Já copiei, continuar
            </button>
          </div>
        </div>
      ) : null}

      <div
        role="tabpanel"
        id={`conversion-manage-panel-${tab}`}
        aria-labelledby={`conversion-manage-tab-${tab}`}
      >
        {tab === "edit" ? (
          <RuleEditForm
            rule={rule}
            origin={origin}
            numbers={numbers}
            connections={connections}
            capabilities={capabilities}
            comingSoonNumbers={comingSoonNumbers}
            canManage={canManage}
            licenseLocked={licenseLocked}
            updateAction={actions.update}
            onSaved={onSaved}
            paytProducts={paytProducts}
          />
        ) : null}
        {tab === "endpoint" ? (
          <RuleEndpoint
            rule={rule}
            origin={origin}
            canManage={canManage && !licenseLocked}
            rotateAction={actions.rotateEndpoint}
            freshUrl={freshUrl}
            capabilities={capabilities}
            onRotated={(url) => {
              onFreshUrl?.(url);
              onChanged?.();
            }}
            onDismiss={() => onDismissFreshUrl?.()}
            singleUrlActions={singleUrlActions}
            urlsCanManage={canManage}
            licenseLocked={licenseLocked}
            integrationEndpoint={
              integrationEndpoints.find(
                (endpoint) =>
                  (origin === "automation_payt" &&
                    endpoint.provider === "payt") ||
                  (origin === "automation_unnichat" &&
                    endpoint.provider === "unnichat" &&
                    endpoint.eventName === rule.conversionRule.eventName) ||
                  (origin === "automation_umbler" &&
                    endpoint.provider === "umbler" &&
                    endpoint.eventName === rule.conversionRule.eventName),
              ) ?? null
            }
          />
        ) : null}
        {tab === "received" ? (
          <ReceivedEvents
            ruleId={rule.id}
            origin={origin}
            mode={rule.mode}
            canManage={canManage && !licenseLocked}
            loadAction={actions.loadReceivedEvents}
            loadPayloadAction={actions.loadReceivedPayload}
            reprocessAction={actions.reprocessReceivedEvents}
          />
        ) : null}
        {tab === "catalog-test" ? (
          <div className="conversion-catalog-test">
            <p className="action-note">
              Cole uma mensagem de pedido como ela chega no WhatsApp. O teste
              mostra o que seria reconhecido, sem enviar nada à Meta.
            </p>
            <ProviderCatalogTestConsole
              ruleId={rule.id}
              testMessageAction={actions.testCatalogMessage}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RuleEditForm({
  rule,
  origin,
  numbers,
  connections,
  capabilities,
  comingSoonNumbers,
  canManage,
  licenseLocked,
  updateAction,
  onSaved,
  paytProducts = [],
}: {
  paytProducts?: IntegrationDetectedProductDto[];
  rule: ProviderConversionRuleDto;
  origin: ProviderConversionRuleOriginDto;
  numbers: ConversionNumber[];
  connections: ConversionConnection[];
  capabilities: ProviderConversionRuleCapabilitiesDto | null;
  comingSoonNumbers: ComingSoonNumber[];
  canManage: boolean;
  licenseLocked: boolean;
  updateAction: RuleAction;
  onSaved: (message: string) => void;
}) {
  const [draft, setDraft] = useState<RuleEditDraft>(() => ruleEditDraft(rule, origin));
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const editCaps = ruleEditCapabilities(rule, origin);
  const definition = ruleOriginDefinition(origin);
  const workspaceCurrency = useWorkspaceCurrency();
  const context = { numbers, connections, capabilities, workspaceCurrency };
  const disabled = !canManage || pending || licenseLocked;

  function patch(update: Partial<RuleEditDraft>) {
    setError(null);
    setInfo(null);
    setDraft((current) => ({ ...current, ...update }));
  }

  async function save() {
    if (pending || !canManage) return;
    const built = buildRuleUpdatePayload(rule, draft, context);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    if (Object.keys(built.value).length === 0) {
      setInfo("Nada mudou: não há o que salvar.");
      return;
    }
    setPending(true);
    setError(null);
    const formData = new FormData();
    formData.set("ruleId", rule.id);
    formData.set("payload", JSON.stringify(built.value));
    try {
      const result = await updateAction(formData);
      if (result.ok) {
        onSaved(`Alterações salvas em “${draft.name.trim()}”.`);
        return;
      }
      setError(result.message);
    } catch {
      setError("Não deu para confirmar se as alterações foram salvas. Atualize a página para conferir.");
    }
    setPending(false);
  }

  return (
    <form
      className="conversion-flow provider-conversion-builder conversion-edit"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset className="conversion-flow-fieldset" disabled={disabled}>
        <legend>Regra</legend>
        <label className="conversion-field">
          <span className="field-label">Nome da regra</span>
          <input
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            maxLength={120}
            required
          />
        </label>
        <dl className="conversion-flow-summary">
          <div>
            <dt>Origem</dt>
            <dd>{definition.label}</dd>
          </div>
          <div>
            <dt>Evento</dt>
            <dd>{ruleEventLabelForOrigin(origin, rule.conversionRule.eventName)}</dd>
          </div>
        </dl>
        <p className="action-note">
          Para trocar a origem ou o evento, crie uma regra nova e exclua esta.
        </p>
      </fieldset>

      <ScopeStep
        draft={draft}
        numbers={numbers}
        connections={connections}
        capabilities={capabilities}
        comingSoonNumbers={comingSoonNumbers}
        onChange={patch}
        disabled={disabled}
        connectionLocked
        legend="Números"
      />

      {editCaps.productFilter ? (
        <fieldset className="conversion-flow-fieldset" disabled={disabled}>
          <legend>Produtos</legend>
          <ProductFilterPicker
            products={paytProducts}
            selected={draft.productCodes}
            onChange={(productCodes) => patch({ productCodes })}
            disabled={disabled}
          />
          <p className="action-note">
            O valor de cada venda vem da própria Payt.
          </p>
        </fieldset>
      ) : null}

      {editCaps.messageValue ? (
        <fieldset className="conversion-flow-fieldset" disabled={disabled}>
          <legend>Frases e valor</legend>
          <MessagePhraseFields
            eventName={rule.conversionRule.eventName}
            averageValue={draft.averageValue}
            contentName={draft.contentName}
            primaryPhrase={draft.primaryPhrase}
            variationPhrases={draft.variationPhrases}
            exampleMessage={draft.exampleMessage}
            valueMode={draft.valueMode}
            messageAuthorScope={draft.messageAuthorScope}
            contactAvailable={numbers.some((number) =>
              contactMessageProviders(capabilities).includes(number.provider),
            )}
            currency={draft.currency}
            onChange={(update) => patch(update)}
          />
        </fieldset>
      ) : null}

      {origin === "structured_catalog" ? (
        <fieldset className="conversion-flow-fieldset" disabled={disabled}>
          <legend>Pedido pelo catálogo</legend>
          <label className="conversion-field">
            <span className="field-label">Frase que abre o pedido</span>
            <input
              value={draft.primaryPhrase}
              onChange={(event) => patch({ primaryPhrase: event.target.value })}
              maxLength={240}
            />
          </label>
          <label className="conversion-field">
            <span className="field-label">Outras frases (opcional, uma por linha)</span>
            <textarea
              value={draft.variationPhrases}
              onChange={(event) => patch({ variationPhrases: event.target.value })}
              rows={2}
            />
          </label>
          <label className="conversion-field">
            <span className="field-label">Quem pode enviar</span>
            <select
              value={draft.messageAuthorScope}
              onChange={(event) =>
                patch({
                  messageAuthorScope: event.target.value as RuleEditDraft["messageAuthorScope"],
                })
              }
            >
              <option value="team">Equipe ou robô</option>
              <option value="contact">Só o contato (só na Umbler)</option>
              <option value="both">Equipe, robô ou contato</option>
            </select>
          </label>
          {rule.catalog ? (
            <CatalogAliases rule={rule} draft={draft} onChange={patch} />
          ) : null}
        </fieldset>
      ) : null}

      {editCaps.labels ? (
        <fieldset className="conversion-flow-fieldset" disabled={disabled}>
          <legend>Etiquetas</legend>
          <LabelList labels={draft.labels} onChange={(labels) => patch({ labels })} />
          <small className="action-note">
            Escreva cada nome igual ao da etiqueta no WhatsApp. Vale em todos os
            números da regra que tiverem uma etiqueta com esse nome.
          </small>
        </fieldset>
      ) : null}

      {editCaps.labelsReadOnly ? (
        <fieldset className="conversion-flow-fieldset">
          <legend>Etiquetas</legend>
          <ul className="conversion-label-list is-readonly" role="list">
            {rule.triggerPhrases.map((label) => (
              <li key={label}>
                <span className="status-chip neutral">{label}</span>
              </li>
            ))}
          </ul>
          <small className="action-note">
            Esta regra reconhece as etiquetas pelo código delas no WhatsApp desta
            conexão, por isso não dá para trocá-las aqui. Para usar outras
            etiquetas, crie uma regra nova e exclua esta.
          </small>
        </fieldset>
      ) : null}

      {editCaps.value ? (
        <fieldset className="conversion-flow-fieldset" disabled={disabled}>
          <legend>Valor enviado à Meta</legend>
          <ValueFields draft={draft} onChange={patch} />
        </fieldset>
      ) : null}

      {editCaps.currency ? (
        <fieldset className="conversion-flow-fieldset" disabled={disabled}>
          <legend>Moeda</legend>
          <RuleCurrencySelect
            value={draft.currency}
            onChange={(currency) => patch({ currency })}
            hint={ruleCurrencyHint(origin)}
          />
        </fieldset>
      ) : null}

      {error ? (
        <p className="action-note warn conversion-flow-error" role="alert">
          {error}
        </p>
      ) : null}
      {info ? (
        <p className="action-note" role="status">
          {info}
        </p>
      ) : null}

      {canManage && licenseLocked ? (
        <p className="action-note warn" role="status">
          {conversionsLicenseLockedNote}
        </p>
      ) : null}

      {canManage ? (
        <div className="conversion-flow-actions">
          <button
            className="button primary"
            type="submit"
            disabled={pending || licenseLocked}
            data-pending={pending ? "true" : undefined}
          >
            {pending ? "Salvando..." : "Salvar alterações"}
          </button>
        </div>
      ) : (
        <p className="action-note">Você pode ver esta regra, mas não alterar.</p>
      )}
    </form>
  );
}

function CatalogAliases({
  rule,
  draft,
  onChange,
}: {
  rule: ProviderConversionRuleDto;
  draft: RuleEditDraft;
  onChange: (update: Partial<RuleEditDraft>) => void;
}) {
  const catalog = rule.catalog!;

  return (
    <div className="conversion-catalog-aliases">
      <p className="action-note">
        Catálogo “{catalog.name}” ({catalog.productName}). Opções e preços ficam
        como estão para não mudar o histórico; aqui você cadastra outros jeitos
        de escrever cada opção (separados por vírgula).
      </p>
      <ul className="conversion-catalog-alias-list" role="list">
        {catalog.variants.map((variant) => (
          <li key={variant.id}>
            <strong>
              {variant.attributeValues.join(" / ")} ·{" "}
              {formatMoney(variant.valueCents, catalog.currency)}
            </strong>
            {catalog.attributes.map((attribute, index) => (
              <label className="conversion-field" key={attribute.id}>
                <span className="field-label">
                  Outros jeitos de escrever “{variant.attributeValues[index]}”
                </span>
                <input
                  value={draft.aliases[variant.id]?.[index] ?? ""}
                  placeholder="Ex.: P, pequeno"
                  onChange={(event) => {
                    const current = draft.aliases[variant.id] ?? catalog.attributes.map(() => "");
                    onChange({
                      aliases: {
                        ...draft.aliases,
                        [variant.id]: current.map((value, position) =>
                          position === index ? event.target.value : value,
                        ),
                      },
                    });
                  }}
                />
              </label>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LabelList({
  labels,
  onChange,
}: {
  labels: string[];
  onChange: (labels: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const name = draft.trim();
    if (!name) return;
    if (!labels.some((label) => label.trim().toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) {
      onChange([...labels, name]);
    }
    setDraft("");
  }

  return (
    <div className="conversion-label-editor">
      {labels.length > 0 ? (
        <ul className="conversion-label-list" role="list" aria-label="Etiquetas da regra">
          {labels.map((label, index) => (
            <li key={`${label}-${index}`}>
              <input
                aria-label={`Etiqueta ${index + 1}`}
                value={label}
                maxLength={240}
                onChange={(event) =>
                  onChange(
                    labels.map((item, position) =>
                      position === index ? event.target.value : item,
                    ),
                  )
                }
              />
              <button
                className="icon-button"
                type="button"
                aria-label={`Remover etiqueta ${label || index + 1}`}
                onClick={() => onChange(labels.filter((_, position) => position !== index))}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="action-note warn">Nenhuma etiqueta: adicione ao menos uma.</p>
      )}
      <div className="conversion-label-add">
        <input
          aria-label="Nova etiqueta"
          value={draft}
          maxLength={240}
          placeholder="Ex.: Venda fechada"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <button className="button ghost compact-button" type="button" onClick={add}>
          <Plus size={14} aria-hidden="true" />
          Adicionar etiqueta
        </button>
      </div>
    </div>
  );
}
