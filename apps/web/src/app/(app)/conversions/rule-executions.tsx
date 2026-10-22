"use client";

import type { ProviderConversionRuleExecutionAuditDto } from "@wpptrack/shared";
import { formatMoney } from "@wpptrack/shared";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PresentationMask } from "../../../components/presentation-mask";
import { executionReasonLabel } from "../settings/provider-conversion-labels";
import type { ProviderConversionRuleActionResult } from "./actions";

type LoadAction = (
  formData: FormData,
) => Promise<ProviderConversionRuleActionResult>;

const statusLabels: Record<
  ProviderConversionRuleExecutionAuditDto["items"][number]["status"],
  { label: string; tone: "" | "warn" | "bad" | "neutral" }
> = {
  observed: { label: "Reconhecida em observação", tone: "neutral" },
  eligible: { label: "Na fila de envio", tone: "neutral" },
  materialized: { label: "Evento enviado", tone: "" },
  duplicate: { label: "Repetida", tone: "warn" },
  blocked: { label: "Bloqueada", tone: "warn" },
  failed: { label: "Falhou", tone: "bad" },
};

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  });
}

/**
 * Last executions of one rule (GET .../executions), the same audit the old
 * view shows, read on demand when the modal opens.
 */
export function RuleExecutions({
  ruleId,
  loadAction,
  purchaseReviewHref = null,
}: {
  ruleId: string;
  loadAction: LoadAction;
  /** Purchase rules: where each recognized purchase is reviewed. */
  purchaseReviewHref?: string | null;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "loaded"; audit: ProviderConversionRuleExecutionAuditDto }
  >({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    const formData = new FormData();
    formData.set("ruleId", ruleId);
    try {
      const result = await loadAction(formData);
      setState(
        result.ok && result.executionAudit
          ? { status: "loaded", audit: result.executionAudit }
          : { status: "error", message: result.message },
      );
    } catch {
      setState({
        status: "error",
        message: "Não foi possível carregar as execuções agora.",
      });
    }
  }, [loadAction, ruleId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return (
      <p className="muted" role="status">
        Carregando execuções...
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="conversion-executions-error" role="alert">
        <p className="action-note warn">{state.message}</p>
        <button className="button" type="button" onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />
          Tentar de novo
        </button>
      </div>
    );
  }

  const { audit } = state;

  return (
    <div className="conversion-executions">
      <dl className="conversion-executions-summary">
        <div>
          <dt>Total</dt>
          <dd>{audit.summary.total}</dd>
        </div>
        <div>
          <dt>Enviadas</dt>
          <dd>{audit.summary.materialized}</dd>
        </div>
        <div>
          <dt>Em observação</dt>
          <dd>{audit.summary.observed}</dd>
        </div>
        <div>
          <dt>Bloqueadas ou com falha</dt>
          <dd>{audit.summary.blocked + audit.summary.failed}</dd>
        </div>
      </dl>
      {audit.items.length === 0 ? (
        <p className="muted">
          Esta regra ainda não reconheceu nenhuma conversa.
        </p>
      ) : (
        <ul className="conversion-executions-list" role="list">
          {audit.items.map((item) => {
            const status = statusLabels[item.status];
            return (
              <li key={item.executionId}>
                <div className="conversion-executions-head">
                  <span
                    className={`status-chip${status.tone ? ` ${status.tone}` : ""}`}
                  >
                    {status.label}
                  </span>
                  <time dateTime={item.occurredAt}>
                    {formatDateTime(item.occurredAt)}
                  </time>
                </div>
                <p>{executionReasonLabel(item.reasonCode)}</p>
                <p className="muted">
                  {item.channel ? (
                    <PresentationMask placeholder="Número oculto">
                      {item.channel.name ?? item.channel.connectedPhone}
                    </PresentationMask>
                  ) : (
                    "Número não identificado"
                  )}
                  {item.leadName || item.phoneDisplay ? (
                    <>
                      {" · "}
                      <PresentationMask placeholder="Lead oculto">
                        {item.leadName ?? item.phoneDisplay}
                      </PresentationMask>
                    </>
                  ) : null}
                  {item.valueCents && item.currency
                    ? ` · ${formatMoney(item.valueCents, item.currency)}`
                    : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {audit.pagination.totalItems > audit.items.length ? (
        <p className="action-note">
          Mostrando as {audit.items.length} mais recentes de{" "}
          {audit.pagination.totalItems}.
        </p>
      ) : null}
      {purchaseReviewHref ? (
        <Link className="conversion-inline-link" href={purchaseReviewHref}>
          Revisar as compras desta regra
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}
