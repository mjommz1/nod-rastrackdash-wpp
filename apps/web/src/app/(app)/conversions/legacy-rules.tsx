"use client";

import type {
  ConversionEventNameDto,
  LegacyConversionRuleDto,
  ProviderConversionRuleCapabilitiesDto,
} from "@wpptrack/shared";
import { formatMoney } from "@wpptrack/shared";
import { Link2, Pause, Pencil, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal } from "../../../components/modal";
import {
  RuleCurrencySelect,
  ruleCurrencyChoice,
} from "../../../components/workspace-currency";
import { PresentationMask } from "../../../components/presentation-mask";
import type {
  ConversionScreenActionResult,
  ProviderConversionRuleActionResult,
} from "./actions";
import { ruleEventLabel } from "./event-copy";
import { contactMessageProviders, originChannelProviders } from "./conversion-origins";
import type { ConversionNumber } from "./conversion-rules-view";
import { conversionsLicenseLockedNote } from "./license-lock";
import { parseLines } from "./rule-draft";

type LegacyUpdateAction = (formData: FormData) => Promise<ConversionScreenActionResult>;
type AdaptAction = (formData: FormData) => Promise<ProviderConversionRuleActionResult>;

export type LegacyRuleActions = {
  update: LegacyUpdateAction;
  adapt: AdaptAction;
};

/** Events whose old rules carry product and value. */
const valuedEvents = new Set<ConversionEventNameDto>(["Purchase", "OrderCreated"]);

/** Números onde a API avalia regras de frase (a regra antiga vira “Frase na conversa”). */
export function adaptableNumbers(
  numbers: readonly ConversionNumber[],
  capabilities: ProviderConversionRuleCapabilitiesDto | null,
): ConversionNumber[] {
  const providers = originChannelProviders("message_phrase", capabilities);
  return numbers.filter((number) => providers.includes(number.provider));
}

/** Pode conectar aos números: a API diz que dá (adaptable) e há número que lê mensagens. */
export function legacyRuleCanAdapt(
  rule: Pick<LegacyConversionRuleDto, "adaptable">,
  numbers: readonly ConversionNumber[],
  capabilities: ProviderConversionRuleCapabilitiesDto | null = null,
): boolean {
  return rule.adaptable && adaptableNumbers(numbers, capabilities).length > 0;
}

export const legacyBlockedReasonCopy: Record<
  NonNullable<LegacyConversionRuleDto["adaptBlockedReason"]>,
  string
> = {
  not_keyword_purchase:
    "Só regras de compra por palavra podem ser conectadas aos números.",
  missing_value: "Informe produto e valor para poder conectar aos números.",
};

function moneyLabel(valueCents: number | null | undefined, currency?: string | null): string {
  if (valueCents == null) return "Sem valor";
  return formatMoney(valueCents, currency);
}

function moneyInput(valueCents: number | null | undefined): string {
  return valueCents == null ? "" : (valueCents / 100).toFixed(2).replace(".", ",");
}

type Notice = { tone: "success" | "warn"; message: string };

/**
 * Old keyword/label rules (before connections), moved here from Settings.
 * They keep working; here they can be paused, have product and value
 * edited, or be connected to numbers (becoming a "Frase na conversa" rule,
 * in observation, with their history).
 */
export function LegacyRules({
  rules,
  state,
  numbers,
  capabilities = null,
  canManage,
  licenseLocked = false,
  actions,
}: {
  rules: LegacyConversionRuleDto[];
  state: "real" | "error";
  numbers: ConversionNumber[];
  capabilities?: ProviderConversionRuleCapabilitiesDto | null;
  canManage: boolean;
  licenseLocked?: boolean;
  actions: LegacyRuleActions;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [valueRule, setValueRule] = useState<LegacyConversionRuleDto | null>(null);
  const [adaptRule, setAdaptRule] = useState<LegacyConversionRuleDto | null>(null);

  if (state === "error") {
    return (
      <p className="action-note warn conversion-legacy-error">
        Não deu para ler as regras antigas agora. Elas continuam funcionando.
      </p>
    );
  }
  if (rules.length === 0) return null;

  async function toggle(rule: LegacyConversionRuleDto) {
    if (pendingId) return;
    setPendingId(rule.id);
    const formData = new FormData();
    formData.set("ruleId", rule.id);
    formData.set("intent", "status");
    formData.set("active", String(!rule.active));
    try {
      const result = await actions.update(formData);
      setNotice({ tone: result.ok ? "success" : "warn", message: result.message });
      if (result.ok) router.refresh();
    } catch {
      setNotice({
        tone: "warn",
        message: "Não deu para confirmar a mudança. Atualize a página para conferir.",
      });
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="conversion-legacy" aria-labelledby="conversion-legacy-title">
      <header className="conversion-legacy-head">
        <div>
          <h2 id="conversion-legacy-title">Regras antigas</h2>
          <p className="muted">
            Criadas antes de os números serem conectados. Continuam funcionando;
            conecte-as aos seus números para ver execuções e ativar o envio
            automático como as outras.
          </p>
        </div>
        <span className="status-chip neutral">
          {rules.length} {rules.length === 1 ? "regra" : "regras"}
        </span>
      </header>

      {notice ? (
        <div className={`feedback-banner ${notice.tone}`} role="status">
          <span>{notice.message}</span>
        </div>
      ) : null}

      {canManage && licenseLocked ? (
        <p className="action-note warn" role="status">
          {conversionsLicenseLockedNote}
        </p>
      ) : null}

      <ul className="conversion-rule-list conversion-legacy-list" role="list">
        {rules.map((rule) => (
          <li key={rule.id} className="conversion-rule-row">
            <article className="conversion-rule conversion-legacy-rule" aria-label={rule.name}>
              <div className="conversion-rule-identity">
                <span className="conversion-rule-origin">
                  {rule.triggerType === "keyword" ? "Palavra na conversa" : "Etiqueta no WhatsApp"}
                </span>
                <strong>{rule.name}</strong>
                <small className="conversion-rule-trigger">
                  {rule.matchMode === "exact" ? "Igual a" : "Contém"} “
                  <PresentationMask placeholder="Gatilho oculto">{rule.triggerValue}</PresentationMask>”
                </small>
              </div>
              <div className="conversion-rule-cell">
                <span className="conversion-rule-cell-label">Evento</span>
                <span>{ruleEventLabel(rule.eventName)}</span>
              </div>
              <div className="conversion-rule-cell">
                <span className="conversion-rule-cell-label">Valor</span>
                <span>
                  {valuedEvents.has(rule.eventName)
                    ? `${rule.defaultContentName ?? "Sem produto"} · ${moneyLabel(rule.defaultValueCents, rule.defaultCurrency)}`
                    : "Não se aplica"}
                </span>
              </div>
              <div className="conversion-rule-cell">
                <span className="conversion-rule-cell-label">Status</span>
                <span className={`status-chip${rule.active ? "" : " warn"}`}>
                  {rule.active ? "Ativa" : "Pausada"}
                </span>
              </div>
              {canManage && !rule.adaptable && rule.adaptBlockedReason === "missing_value" ? (
                <p className="action-note conversion-rule-notes">
                  {legacyBlockedReasonCopy.missing_value}
                </p>
              ) : null}
              {canManage ? (
                <div className="conversion-rule-actions">
                  {legacyRuleCanAdapt(rule, numbers, capabilities) ? (
                    <button
                      className="button ghost compact-button"
                      type="button"
                      aria-haspopup="dialog"
                      aria-label={`Conectar ${rule.name} aos números`}
                      disabled={licenseLocked}
                      onClick={() => setAdaptRule(rule)}
                    >
                      <Link2 size={14} aria-hidden="true" />
                      Conectar aos números
                    </button>
                  ) : null}
                  {valuedEvents.has(rule.eventName) ? (
                    <button
                      className="button ghost compact-button"
                      type="button"
                      aria-haspopup="dialog"
                      aria-label={`Editar valor de ${rule.name}`}
                      disabled={licenseLocked}
                      onClick={() => setValueRule(rule)}
                    >
                      <Pencil size={14} aria-hidden="true" />
                      Editar valor
                    </button>
                  ) : null}
                  <button
                    className="button ghost compact-button"
                    type="button"
                    disabled={pendingId !== null || licenseLocked}
                    aria-label={`${rule.active ? "Pausar" : "Reativar"} ${rule.name}`}
                    onClick={() => void toggle(rule)}
                  >
                    {rule.active ? (
                      <Pause size={14} aria-hidden="true" />
                    ) : (
                      <Play size={14} aria-hidden="true" />
                    )}
                    {pendingId === rule.id ? "Salvando..." : rule.active ? "Pausar" : "Reativar"}
                  </button>
                </div>
              ) : null}
            </article>
          </li>
        ))}
      </ul>

      <Modal
        open={valueRule !== null}
        onClose={() => setValueRule(null)}
        title="Editar produto e valor"
        description={valueRule?.name}
      >
        {valueRule ? (
          <LegacyValueForm
            key={valueRule.id}
            rule={valueRule}
            action={actions.update}
            onDone={(message) => {
              setValueRule(null);
              setNotice({ tone: "success", message });
              router.refresh();
            }}
          />
        ) : null}
      </Modal>

      <Modal
        open={adaptRule !== null}
        onClose={() => setAdaptRule(null)}
        title="Conectar regra aos números"
        description={adaptRule?.name}
        size="wide"
      >
        {adaptRule ? (
          <LegacyAdaptForm
            key={adaptRule.id}
            rule={adaptRule}
            numbers={numbers}
            capabilities={capabilities}
            licenseLocked={licenseLocked}
            action={actions.adapt}
            onDone={(message) => {
              setAdaptRule(null);
              setNotice({ tone: "success", message });
              router.refresh();
            }}
          />
        ) : null}
      </Modal>
    </section>
  );
}

function LegacyValueForm({
  rule,
  action,
  onDone,
}: {
  rule: LegacyConversionRuleDto;
  action: LegacyUpdateAction;
  onDone: (message: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="conversion-flow provider-conversion-builder"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        const formData = new FormData(event.currentTarget);
        formData.set("ruleId", rule.id);
        formData.set("intent", "value");
        setPending(true);
        setError(null);
        try {
          const result = await action(formData);
          if (result.ok) {
            onDone(`Produto e valor de “${rule.name}” salvos.`);
            return;
          }
          setError(result.message);
        } catch {
          setError("Não deu para confirmar se foi salvo. Atualize a página para conferir.");
        }
        setPending(false);
      }}
    >
      <div className="conversion-field-row">
        <label className="conversion-field">
          <span className="field-label">Produto ou serviço</span>
          <input
            name="productName"
            defaultValue={rule.defaultContentName ?? ""}
            maxLength={180}
            placeholder="Ex.: Consulta"
          />
        </label>
        <label className="conversion-field">
          <span className="field-label">Valor</span>
          <input
            name="defaultValue"
            defaultValue={moneyInput(rule.defaultValueCents)}
            inputMode="decimal"
            placeholder="0,00"
          />
        </label>
      </div>
      <RuleCurrencySelect
        name="defaultCurrency"
        value={ruleCurrencyChoice(rule.defaultCurrency)}
      />
      {error ? (
        <p className="action-note warn" role="alert">
          {error}
        </p>
      ) : null}
      <div className="conversion-flow-actions">
        <button className="button primary" type="submit" disabled={pending}>
          {pending ? "Salvando..." : "Salvar"}
        </button>
      </div>
    </form>
  );
}

function LegacyAdaptForm({
  rule,
  numbers,
  capabilities,
  licenseLocked,
  action,
  onDone,
}: {
  rule: LegacyConversionRuleDto;
  numbers: ConversionNumber[];
  capabilities: ProviderConversionRuleCapabilitiesDto | null;
  licenseLocked: boolean;
  action: AdaptAction;
  onDone: (message: string) => void;
}) {
  const eligible = adaptableNumbers(numbers, capabilities);
  const connections = [
    ...new Map(eligible.map((number) => [number.connectionId, number.connectionName])),
  ];
  const [connectionId, setConnectionId] = useState(connections[0]?.[0] ?? "");
  const connectionNumbers = eligible.filter((number) => number.connectionId === connectionId);
  const [channelIds, setChannelIds] = useState<string[]>(() =>
    connectionNumbers.length === 1 ? [connectionNumbers[0]!.id] : [],
  );
  const [phrases, setPhrases] = useState(rule.triggerValue);
  const [authorScope, setAuthorScope] = useState<"team" | "contact" | "both">("team");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (pending) return;
    const triggerPhrases = parseLines(phrases);
    if (!connectionId || channelIds.length === 0) {
      setError("Escolha ao menos um número.");
      return;
    }
    if (triggerPhrases.length === 0 || triggerPhrases.some((phrase) => phrase.length < 3)) {
      setError("Informe ao menos uma frase com 3 letras ou mais.");
      return;
    }
    const contactProviders = contactMessageProviders(capabilities);
    if (
      authorScope === "contact" &&
      connectionNumbers.some(
        (number) =>
          channelIds.includes(number.id) &&
          !contactProviders.includes(number.provider),
      )
    ) {
      setError(
        "Mensagens do contato só são lidas na Umbler. Escolha números da Umbler ou mude “Quem pode enviar”.",
      );
      return;
    }
    setPending(true);
    setError(null);
    const formData = new FormData();
    formData.set("legacyRuleId", rule.id);
    formData.set(
      "payload",
      JSON.stringify({
        connectionId,
        channelIds,
        triggerPhrases,
        messageAuthorScope: authorScope,
      }),
    );
    try {
      const result = await action(formData);
      if (result.ok) {
        onDone(
          `“${rule.name}” agora é uma regra de frase nos números escolhidos, em observação. O histórico foi mantido.`,
        );
        return;
      }
      setError(result.message);
    } catch {
      setError("Não deu para confirmar a mudança. Atualize a página para conferir.");
    }
    setPending(false);
  }

  return (
    <form
      className="conversion-flow provider-conversion-builder"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset className="conversion-flow-fieldset" disabled={pending}>
        <legend>Onde a regra vai valer</legend>
        <label className="conversion-field">
          <span className="field-label">Conexão</span>
          <select
            value={connectionId}
            onChange={(event) => {
              const next = event.target.value;
              const nextNumbers = eligible.filter((number) => number.connectionId === next);
              setConnectionId(next);
              setChannelIds(nextNumbers.length === 1 ? [nextNumbers[0]!.id] : []);
            }}
          >
            {connections.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="conversion-number-picker">
          <fieldset className="conversion-number-group">
            <legend>Números</legend>
            {connectionNumbers.map((number) => (
              <label className="conversion-number-option" key={number.id}>
                <input
                  type="checkbox"
                  checked={channelIds.includes(number.id)}
                  onChange={() =>
                    setChannelIds((current) =>
                      current.includes(number.id)
                        ? current.filter((id) => id !== number.id)
                        : [...current, number.id],
                    )
                  }
                />
                <span />
                <span>
                  <PresentationMask placeholder="Número oculto">{number.label}</PresentationMask>
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      </fieldset>
      <fieldset className="conversion-flow-fieldset" disabled={pending}>
        <legend>Frases</legend>
        <label className="conversion-field">
          <span className="field-label">Frases (uma por linha)</span>
          <textarea
            value={phrases}
            onChange={(event) => setPhrases(event.target.value)}
            rows={3}
            maxLength={4_800}
          />
          <small className="action-note">
            A frase pode estar no meio de uma mensagem maior. Maiúsculas e
            acentos não fazem diferença.
          </small>
        </label>
        <label className="conversion-field">
          <span className="field-label">Quem pode enviar</span>
          <select
            value={authorScope}
            onChange={(event) =>
              setAuthorScope(event.target.value as "team" | "contact" | "both")
            }
          >
            <option value="team">Equipe ou robô</option>
            <option value="contact">Só o contato (só na Umbler)</option>
            <option value="both">Equipe, robô ou contato</option>
          </select>
        </label>
      </fieldset>
      <p className="action-note">
        A regra mantém o histórico, passa a valer só nos números escolhidos e
        começa em observação: nada é enviado à Meta até você ativar o envio.
      </p>
      {licenseLocked ? (
        <p className="action-note warn" role="status">
          {conversionsLicenseLockedNote}
        </p>
      ) : null}
      {error ? (
        <p className="action-note warn" role="alert">
          {error}
        </p>
      ) : null}
      <div className="conversion-flow-actions">
        <button className="button primary" type="submit" disabled={pending || licenseLocked}>
          <Link2 size={15} aria-hidden="true" />
          {pending ? "Conectando..." : "Conectar em observação"}
        </button>
      </div>
    </form>
  );
}
