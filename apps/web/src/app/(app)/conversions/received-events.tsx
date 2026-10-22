"use client";

import type {
  ConversionEventNameDto,
  ProviderConversionAutomationAuditDto,
  ProviderConversionAutomationAuditItemDto,
  ProviderConversionAutomationPayloadDto,
  ProviderConversionAutomationReprocessBatchResultDto,
} from "@wpptrack/shared";
import { Check, Eye, EyeOff, RefreshCw, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PresentationMask } from "../../../components/presentation-mask";
import { ruleEventLabelForOrigin } from "./event-copy";
import type { ProviderConversionRuleActionResult } from "./actions";
import { executionReasonLabel } from "../settings/provider-conversion-labels";

type RuleAction = (formData: FormData) => Promise<ProviderConversionRuleActionResult>;

type Filter = "recoverable" | "blocked" | "materialized" | "all";

type AuditStatus = ProviderConversionAutomationAuditItemDto["status"];

/** Max per request (API contract). */
export const reprocessBatchLimit = 50;

const statusLabels: Record<AuditStatus, { label: string; tone: "" | "warn" | "bad" | "neutral" }> = {
  observed: { label: "Reconhecido em observação", tone: "neutral" },
  eligible: { label: "Na fila de envio", tone: "neutral" },
  materialized: { label: "Virou conversão", tone: "" },
  duplicate: { label: "Repetido", tone: "warn" },
  blocked: { label: "Bloqueado", tone: "warn" },
  failed: { label: "Falhou", tone: "bad" },
  ignored: { label: "Ignorado", tone: "neutral" },
  invalid_payload: { label: "Dados fora do padrão", tone: "bad" },
};

const filters: Array<[Filter, string]> = [
  ["recoverable", "Dá para reprocessar"],
  ["blocked", "Bloqueados"],
  ["materialized", "Viraram conversão"],
  ["all", "Todos"],
];

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  });
}

function eventLabel(
  eventName: ConversionEventNameDto | null,
  origin: string | null,
): string {
  return eventName
    ? ruleEventLabelForOrigin(origin ?? "", eventName)
    : "Evento não identificado";
}

/** Plain summary of a reprocess batch (never "callback" or "payload"). */
export function reprocessSummary(
  result: ProviderConversionAutomationReprocessBatchResultDto,
): string {
  const parts: string[] = [];
  if (result.queued) {
    parts.push(
      `${result.queued} encaminhado${result.queued === 1 ? "" : "s"} para envio`,
    );
  }
  if (result.observed) {
    parts.push(
      `${result.observed} reavaliado${result.observed === 1 ? "" : "s"} em observação`,
    );
  }
  if (result.blocked) {
    parts.push(`${result.blocked} continua${result.blocked === 1 ? "" : "m"} bloqueado${result.blocked === 1 ? "" : "s"}`);
  }
  if (result.skipped) {
    parts.push(`${result.skipped} sem mudança`);
  }
  return parts.length > 0 ? `${parts.join(", ")}.` : "Nada mudou.";
}

export function reprocessConfirmText(
  count: number,
  mode: "observation" | "production",
): string {
  const subject = `${count} evento${count === 1 ? "" : "s"} recebido${count === 1 ? "" : "s"}`;
  return mode === "observation"
    ? `Reavaliar ${subject}? A regra está em observação: nada é enviado à Meta.`
    : `Reavaliar ${subject}? Só os que forem de um lead vindo de anúncio viram conversão e são enviados à Meta.`;
}

/**
 * "Eventos recebidos" of an address automation (Umbler, venda da Payt):
 * every call the platform made, why it did or did not become a conversion,
 * the data received and reprocessing of the ones that can be recovered.
 */
export function ReceivedEvents({
  ruleId,
  origin = null,
  mode,
  canManage,
  loadAction,
  loadPayloadAction,
  reprocessAction,
}: {
  ruleId: string;
  /** Origem da regra: a Payt mostra os eventos de venda com nome próprio. */
  origin?: string | null;
  mode: "observation" | "production";
  canManage: boolean;
  loadAction: RuleAction;
  loadPayloadAction: RuleAction;
  reprocessAction: RuleAction;
}) {
  const [audit, setAudit] = useState<ProviderConversionAutomationAuditDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "warn"; message: string } | null>(
    null,
  );
  const [filter, setFilter] = useState<Filter>("recoverable");
  // The first load picks the filter: "Todos" when nothing can be reprocessed,
  // so a rule with only ignored events never opens on an empty list.
  const initialFilterChosen = useRef(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [reprocessing, setReprocessing] = useState(false);
  const [payloads, setPayloads] = useState<
    Record<string, ProviderConversionAutomationPayloadDto | "loading">
  >({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const formData = new FormData();
    formData.set("ruleId", ruleId);
    try {
      const result = await loadAction(formData);
      if (result.ok && result.automationAudit) {
        const next = result.automationAudit;
        setAudit(next);
        const recoverable = new Set(
          next.items.filter((item) => item.reprocessable).map((item) => item.deliveryId),
        );
        setSelected((current) => current.filter((id) => recoverable.has(id)));
        if (!initialFilterChosen.current) {
          initialFilterChosen.current = true;
          if (recoverable.size === 0) setFilter("all");
        }
      } else {
        setError(result.message);
      }
    } catch {
      setError("Não foi possível carregar os eventos recebidos agora.");
    } finally {
      setLoading(false);
    }
  }, [loadAction, ruleId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function togglePayload(deliveryId: string) {
    if (payloads[deliveryId]) {
      setPayloads(({ [deliveryId]: _removed, ...rest }) => rest);
      return;
    }
    setPayloads((current) => ({ ...current, [deliveryId]: "loading" }));
    const formData = new FormData();
    formData.set("ruleId", ruleId);
    formData.set("deliveryId", deliveryId);
    try {
      const result = await loadPayloadAction(formData);
      if (result.ok && result.automationPayload) {
        const payload = result.automationPayload;
        setPayloads((current) => ({ ...current, [deliveryId]: payload }));
        return;
      }
      setNotice({ tone: "warn", message: result.message });
    } catch {
      setNotice({ tone: "warn", message: "Não foi possível abrir os dados deste evento." });
    }
    setPayloads(({ [deliveryId]: _removed, ...rest }) => rest);
  }

  async function reprocess(deliveryIds: string[]) {
    if (reprocessing || deliveryIds.length === 0) return;
    setReprocessing(true);
    setNotice(null);
    const formData = new FormData();
    formData.set("ruleId", ruleId);
    formData.set(
      "payload",
      JSON.stringify({
        confirmation: "REPROCESSAR_CALLBACKS_SELECIONADOS",
        deliveryIds: deliveryIds.slice(0, reprocessBatchLimit),
      }),
    );
    try {
      const result = await reprocessAction(formData);
      if (result.ok) {
        setSelected([]);
        setNotice({
          tone: "success",
          message: result.automationReprocess
            ? reprocessSummary(result.automationReprocess)
            : "Eventos reavaliados.",
        });
        await load();
      } else {
        setNotice({ tone: "warn", message: result.message });
      }
    } catch {
      setNotice({
        tone: "warn",
        message: "Não deu para confirmar o reprocessamento. Atualize a lista para conferir.",
      });
    } finally {
      setReprocessing(false);
      setConfirming(null);
    }
  }

  if (loading && !audit) {
    return (
      <p className="muted" role="status">
        Carregando eventos recebidos...
      </p>
    );
  }

  if (error && !audit) {
    return (
      <div className="conversion-executions-error" role="alert">
        <p className="action-note warn">{error}</p>
        <button className="button" type="button" onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />
          Tentar de novo
        </button>
      </div>
    );
  }

  if (!audit) return null;

  const visible = audit.items.filter((item) => {
    if (filter === "recoverable") return item.reprocessable;
    if (filter === "blocked") return item.status === "blocked";
    if (filter === "materialized") return item.status === "materialized";
    return true;
  });
  const recoverableIds = audit.items
    .filter((item) => item.reprocessable)
    .map((item) => item.deliveryId)
    .slice(0, reprocessBatchLimit);
  const allSelected =
    recoverableIds.length > 0 && selected.length === recoverableIds.length;
  const busy = loading || reprocessing;

  return (
    <div className="conversion-received">
      <dl className="conversion-executions-summary conversion-received-summary">
        <div>
          <dt>Recebidos</dt>
          <dd>{audit.summary.total}</dd>
        </div>
        <div>
          <dt>Viraram conversão</dt>
          <dd>{audit.summary.materialized}</dd>
        </div>
        <div>
          <dt>Em observação</dt>
          <dd>{audit.summary.observed}</dd>
        </div>
        <div>
          <dt>Bloqueados ou com falha</dt>
          <dd>{audit.summary.blocked + audit.summary.failed}</dd>
        </div>
        <div>
          <dt>Dá para reprocessar</dt>
          <dd>{audit.summary.recoverable}</dd>
        </div>
      </dl>

      {notice ? (
        <div className={`feedback-banner ${notice.tone}`} role="status">
          <span>{notice.message}</span>
        </div>
      ) : null}

      <div className="conversion-received-toolbar">
        <div className="conversion-segmented" role="group" aria-label="Filtrar eventos recebidos">
          {filters.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={filter === value ? "is-active" : undefined}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="conversion-received-actions">
          <button
            className="button ghost compact-button"
            type="button"
            onClick={() => void load()}
            disabled={busy}
          >
            <RefreshCw size={14} aria-hidden="true" />
            Atualizar
          </button>
          {canManage && recoverableIds.length > 0 ? (
            <>
              <button
                className="button ghost compact-button"
                type="button"
                onClick={() => setSelected(allSelected ? [] : recoverableIds)}
                disabled={busy}
              >
                <Check size={14} aria-hidden="true" />
                {allSelected
                  ? "Limpar seleção"
                  : `Selecionar ${recoverableIds.length === 1 ? "o recuperável" : `os ${recoverableIds.length} recuperáveis`}`}
              </button>
              <button
                className="button primary compact-button"
                type="button"
                onClick={() => setConfirming(selected)}
                disabled={busy || selected.length === 0}
              >
                <RotateCcw size={14} aria-hidden="true" />
                {selected.length > 0
                  ? `Reprocessar ${selected.length} selecionado${selected.length === 1 ? "" : "s"}`
                  : "Reprocessar selecionados"}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {confirming ? (
        <div className="conversion-inline-confirm" role="alert">
          <p>{reprocessConfirmText(confirming.length, mode)}</p>
          <div className="conversion-flow-actions">
            <button
              className="button"
              type="button"
              onClick={() => setConfirming(null)}
              disabled={reprocessing}
            >
              Cancelar
            </button>
            <button
              className="button primary"
              type="button"
              onClick={() => void reprocess(confirming)}
              disabled={reprocessing}
            >
              {reprocessing ? "Reprocessando..." : "Reprocessar"}
            </button>
          </div>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <p className="muted conversion-received-empty">
          {audit.items.length === 0
            ? "Nenhum evento recebido ainda. Confira se o endereço desta regra está colado na plataforma."
            : "Nenhum evento neste filtro."}
        </p>
      ) : (
        <ul className="conversion-executions-list conversion-received-list" role="list">
          {visible.map((item) => {
            const status = statusLabels[item.status];
            const payload = payloads[item.deliveryId];
            const when = formatDateTime(item.receivedAt);
            return (
              <li key={item.deliveryId}>
                <div className="conversion-executions-head">
                  {canManage && item.reprocessable ? (
                    <input
                      type="checkbox"
                      checked={selected.includes(item.deliveryId)}
                      aria-label={`Selecionar evento de ${when}`}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...new Set([...current, item.deliveryId])].slice(
                                0,
                                reprocessBatchLimit,
                              )
                            : current.filter((id) => id !== item.deliveryId),
                        )
                      }
                    />
                  ) : null}
                  <span className={`status-chip${status.tone ? ` ${status.tone}` : ""}`}>
                    {status.label}
                  </span>
                  <time dateTime={item.receivedAt}>{when}</time>
                </div>
                <p>
                  <strong>{eventLabel(item.eventName, origin)}</strong>
                  {" · "}
                  {executionReasonLabel(item.reasonCode)}
                </p>
                {item.status === "ignored" ? null : (
                  <p className="muted">
                    {item.channel ? (
                      <PresentationMask placeholder="Número oculto">
                        {item.channel.name ?? item.channel.connectedPhone}
                      </PresentationMask>
                    ) : (
                      "Número não identificado"
                    )}
                    {" · "}
                    {item.leadResolved
                      ? "Lead vindo de anúncio encontrado"
                      : "Lead vindo de anúncio não encontrado"}
                    {item.attemptCount > 1 ? ` · recebido ${item.attemptCount} vezes` : ""}
                  </p>
                )}
                <div className="conversion-received-row-actions">
                  {item.payloadAvailable ? (
                    <button
                      className="button ghost compact-button"
                      type="button"
                      onClick={() => void togglePayload(item.deliveryId)}
                      aria-expanded={Boolean(payload && payload !== "loading")}
                      disabled={payload === "loading"}
                    >
                      {payload && payload !== "loading" ? (
                        <EyeOff size={14} aria-hidden="true" />
                      ) : (
                        <Eye size={14} aria-hidden="true" />
                      )}
                      {payload === "loading"
                        ? "Abrindo..."
                        : payload
                          ? "Ocultar dados recebidos"
                          : "Ver dados recebidos"}
                    </button>
                  ) : (
                    <small className="muted">Dados recebidos já apagados</small>
                  )}
                  {canManage && item.reprocessable ? (
                    <button
                      className="button ghost compact-button"
                      type="button"
                      onClick={() => setConfirming([item.deliveryId])}
                      disabled={busy}
                      aria-label={`Reprocessar evento de ${when}`}
                    >
                      <RotateCcw size={14} aria-hidden="true" />
                      Reprocessar
                    </button>
                  ) : null}
                </div>
                {payload && payload !== "loading" ? (
                  <div className="conversion-received-payload">
                    <small className="muted">
                      Guardado com criptografia até{" "}
                      {formatDateTime(payload.payloadExpiresAt)}.
                    </small>
                    <pre
                      className="payload-block"
                      data-presentation-sensitive-field="true"
                    >
                      {JSON.stringify(payload.payload, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {audit.summary.total > audit.items.length ? (
        <p className="action-note">
          Mostrando os {audit.items.length} eventos mais recentes de {audit.summary.total}.
        </p>
      ) : null}
      {audit.summary.recoverable > recoverableIds.length ? (
        <p className="action-note">
          Reprocesse em lotes de até {reprocessBatchLimit}. Depois de cada lote,
          atualize a lista para selecionar os próximos.
        </p>
      ) : null}
      {audit.items.some((item) => item.status !== "ignored") ? (
        <p className="action-note">
          Eventos sem lead vindo de anúncio podem ser reprocessados por 24 horas.
          Depois disso ficam só para consulta, em “Bloqueados” e “Todos”.
        </p>
      ) : null}
    </div>
  );
}
