"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  KommoConnectionPipelineRowDto,
  KommoEventDto,
  KommoEventsResult,
} from "../integrations/kommo-actions";
import {
  auditStateLabels,
  describeAuditResult,
  summarizeAuditEvent,
  type AuditTone,
} from "./kommo-audit-labels";

type ListEvents = (
  workspaceId: string,
  connectionId: string,
  cursor?: string,
) => Promise<KommoEventsResult>;

export type KommoAuditPanelProps = {
  workspaceId: string;
  connectionId: string;
  connectionLabel: string;
  pipelines?: KommoConnectionPipelineRowDto[];
  /** Mutations may be locked by the license; the audit is a read and stays available. */
  licenseLocked?: boolean;
  listEventsAction: ListEvents;
  /** The parent already lost authorization: rows must be cleared and reads refused. */
  authorityLost?: boolean;
  /** A read answered 401/403: the parent decides how to revoke everything else. */
  onUnauthorized?: () => void;
};

type FailureReason = Extract<KommoEventsResult, { ok: false }>["reason"];

type AuditState = {
  scope: string;
  events: KommoEventDto[];
  nextCursor: string | null;
  loaded: boolean;
  failure: FailureReason | null;
};

const failureCopy: Record<FailureReason, string> = {
  unauthorized:
    "Sem permissão para consultar esta auditoria. Somente o proprietário do workspace acessa estes registros; faça login novamente se sua sessão expirou.",
  not_found: "Conexão Kommo não encontrada neste workspace.",
  invalid_response:
    "A resposta da auditoria veio em formato inesperado e foi descartada. Tente novamente.",
  invalid_request: "Não foi possível pedir esta página da auditoria. Recarregue a página.",
  network: "Não foi possível carregar a auditoria agora. Tente novamente.",
};

function toneClass(tone: AuditTone): string {
  if (tone === "positive") return "event-chip";
  if (tone === "warning") return "event-chip warn";
  if (tone === "danger") return "event-chip bad";
  return "event-chip neutral";
}

export function KommoAuditPanel({
  workspaceId,
  connectionId,
  connectionLabel,
  pipelines = [],
  licenseLocked = false,
  listEventsAction,
  authorityLost = false,
  onUnauthorized,
}: KommoAuditPanelProps) {
  const headingId = useId();
  const scope = JSON.stringify([workspaceId, connectionId]);
  const [state, setState] = useState<AuditState>({
    scope,
    events: [],
    nextCursor: null,
    loaded: false,
    failure: authorityLost ? "unauthorized" : null,
  });
  const [pending, setPending] = useState(false);
  const scopeRef = useRef(scope);
  const requestRef = useRef(0);
  const inFlightRef = useRef(false);
  // Sticky for this mount: once any read answers 401/403 (or the parent says
  // authorization is gone) no later answer may restore rows or permission.
  const lostRef = useRef(authorityLost);
  if (authorityLost) lostRef.current = true;
  const [revoked, setRevoked] = useState(authorityLost);
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  const lost = authorityLost || revoked;

  function revoke() {
    lostRef.current = true;
    requestRef.current += 1;
    inFlightRef.current = false;
    setPending(false);
    setRevoked(true);
    setState((current) => ({
      scope: current.scope,
      events: [],
      nextCursor: null,
      loaded: false,
      failure: "unauthorized",
    }));
  }

  useEffect(() => {
    scopeRef.current = scope;
    requestRef.current += 1;
    inFlightRef.current = false;
    setPending(false);
    setState({
      scope,
      events: [],
      nextCursor: null,
      loaded: false,
      failure: lostRef.current ? "unauthorized" : null,
    });
  }, [scope]);

  useEffect(() => {
    if (authorityLost) revoke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorityLost]);

  const load = useCallback(
    async (cursor: string | null) => {
      if (inFlightRef.current || lostRef.current) return;
      inFlightRef.current = true;
      const requestId = ++requestRef.current;
      const requestScope = scopeRef.current;
      setPending(true);

      let result: KommoEventsResult;
      try {
        result = await listEventsAction(workspaceId, connectionId, cursor ?? undefined);
      } catch {
        result = { ok: false, reason: "network" };
      }

      // Authorization loss fails closed even for a superseded read: it is
      // account-level, so it must never be dropped as "stale".
      if (!result.ok && result.reason === "unauthorized") {
        const alreadyLost = lostRef.current;
        revoke();
        if (!alreadyLost) onUnauthorizedRef.current?.();
        return;
      }

      // After revocation nothing — not even an older successful read — may
      // bring rows back.
      if (lostRef.current) return;

      // A newer request or a scope change makes this answer stale.
      if (requestId !== requestRef.current || requestScope !== scopeRef.current) {
        return;
      }
      inFlightRef.current = false;
      setPending(false);

      if (!result.ok) {
        setState((current) =>
          current.scope === requestScope
            ? { ...current, loaded: current.loaded, failure: result.reason }
            : current,
        );
        return;
      }

      setState((current) => {
        if (current.scope !== requestScope) return current;
        const seen = new Set(cursor ? current.events.map((event) => event.id) : []);
        const fresh = result.events.filter((event) => !seen.has(event.id));
        return {
          scope: requestScope,
          events: cursor ? [...current.events, ...fresh] : result.events,
          nextCursor: result.nextCursor,
          loaded: true,
          failure: null,
        };
      });
    },
    [connectionId, listEventsAction, workspaceId],
  );

  const stageName = (pipelineId: string, statusId: string) => {
    const row = pipelines.find(
      (candidate) => candidate.id === pipelineId && candidate.status.id === statusId,
    );
    return row
      ? `${row.name} · ${row.status.name}`
      : `Pipeline ${pipelineId} · estágio ${statusId}`;
  };

  const current = state.scope === scope && !lost ? state : null;
  const events = current?.events ?? [];
  const loaded = current?.loaded ?? false;
  const failure: FailureReason | null = lost ? "unauthorized" : (current?.failure ?? null);
  const nextCursor = current?.nextCursor ?? null;

  return (
    <section
      className="kommo-audit-panel"
      aria-labelledby={headingId}
      data-testid="kommo-audit-panel"
    >
      <div className="provider-conversion-heading">
        <div>
          <h4 id={headingId}>Auditoria de webhooks · {connectionLabel}</h4>
          <p>
            Cada linha é um webhook que a Kommo enviou e que ficou registrado. Um
            registro aqui prova o recebimento; o envio ao Meta só vale quando
            aparece como confirmado. Eventos de leads sem conversa WhatsApp
            vinculada ficam apenas na auditoria.
          </p>
        </div>
        <div className="provider-conversion-heading-actions">
          <button
            type="button"
            className="button ghost"
            disabled={pending || lost}
            aria-disabled={pending || lost}
            onClick={() => void load(null)}
          >
            {loaded ? "Atualizar auditoria" : "Consultar auditoria"}
          </button>
        </div>
      </div>

      {licenseLocked ? (
        <p className="action-note warn">
          Licença bloqueada: alterações estão indisponíveis, mas a consulta à
          auditoria continua funcionando.
        </p>
      ) : null}

      <p className="action-note" role="status" aria-live="polite">
        {pending
          ? "Carregando auditoria…"
          : loaded
            ? events.length === 0
              ? "Nenhum webhook registrado para esta conexão ainda."
              : `${events.length} ${events.length === 1 ? "evento carregado" : "eventos carregados"}${nextCursor ? "; há mais eventos" : "; fim da lista"}.`
            : failure
              ? ""
              : "A auditoria ainda não foi consultada."}
      </p>

      {failure ? (
        <div className="feedback-banner error" role="alert">
          <span>{failureCopy[failure]}</span>
          {failure !== "unauthorized" ? (
            <button
              type="button"
              className="button ghost"
              disabled={pending}
              onClick={() => void load(loaded && nextCursor ? nextCursor : null)}
            >
              Tentar novamente
            </button>
          ) : null}
        </div>
      ) : null}

      {events.length > 0 ? (
        <>
          <p className="action-note">
            Ordem: do mais antigo para o mais recente. A API não informa data ou
            hora dos eventos.
          </p>
          <ol className="kommo-audit-list" aria-label="Eventos de webhook da Kommo">
            {events.map((event) => {
              const summary = summarizeAuditEvent(event);
              return (
                <li key={event.id} className="kommo-audit-event">
                  <div className="kommo-audit-event-head">
                    <span className={toneClass(summary.tone)}>{summary.headline}</span>
                    <strong>Lead Kommo #{event.dealId}</strong>
                    <small>{stageName(event.pipelineId, event.statusId)}</small>
                  </div>
                  <p>{summary.detail}</p>
                  {summary.auditOnly ? (
                    <p className="action-note">
                      Somente auditoria: nenhuma conversão foi criada nem enviada
                      para este evento.
                    </p>
                  ) : null}
                  <ul className="kommo-audit-stages" aria-label="Etapas deste evento">
                    {summary.stages.map((stage) => (
                      <li key={stage.key} data-state={stage.state}>
                        <strong>{stage.label}:</strong>{" "}
                        <span>{auditStateLabels[stage.state]}</span>
                        <small> — {stage.note}</small>
                      </li>
                    ))}
                  </ul>
                  {event.results.length > 0 ? (
                    <ul className="kommo-audit-results" aria-label="Resultado por regra">
                      {event.results.map((result) => {
                        const described = describeAuditResult(result);
                        return (
                          <li key={result.ruleId}>
                            <span className={toneClass(described.tone)}>
                              {result.eventName ?? "Evento"}
                            </span>{" "}
                            {described.text}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  <small>
                    Tentativas de processamento: {event.attempts} · ID {event.id}
                  </small>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}

      {loaded && nextCursor && !lost ? (
        <button
          type="button"
          className="button ghost"
          disabled={pending}
          aria-disabled={pending}
          onClick={() => void load(nextCursor)}
        >
          Carregar mais eventos
        </button>
      ) : null}
    </section>
  );
}
