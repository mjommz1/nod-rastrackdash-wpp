"use client";

import {
  currencySymbol,
  type CampaignReportRowDto,
  type CurrencyCode,
} from "@wpptrack/shared";
import { Pause, Play, Wallet, X } from "lucide-react";
import { useCallback, useRef } from "react";
import {
  BackofficeActionForm,
  type BackofficeFormAction,
} from "../../../components/backoffice-action-form";
import { SubmitButton } from "../../../components/submit-button";
import { formatReportMoney } from "../../../lib/report-currency";
import { PresentationMask } from "../../../components/presentation-mask";

type MetaLevel = "campaign" | "adset" | "ad";
type ReportBudget = NonNullable<CampaignReportRowDto["budget"]>;

const levelCopy: Record<MetaLevel, { article: string; label: string }> = {
  campaign: { article: "a", label: "campanha" },
  adset: { article: "o", label: "conjunto" },
  ad: { article: "o", label: "anuncio" },
};

const currencyAmountLabels: Record<CurrencyCode, string> = {
  BRL: "Valor em reais",
  USD: "Valor em dólares",
  EUR: "Valor em euros",
};

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    ACTIVE: "Ativo",
    ADSET_PAUSED: "Conjunto pausado",
    ARCHIVED: "Arquivado",
    CAMPAIGN_PAUSED: "Campanha pausada",
    DELETED: "Excluido",
    IN_PROCESS: "Em processamento",
    PAUSED: "Pausado",
    WITH_ISSUES: "Com problemas",
  };

  return labels[status] ?? "Status desconhecido";
}

export function MetaEntityControls({
  action,
  budget,
  canManage,
  configuredStatus,
  currency = "BRL",
  effectiveStatus,
  id,
  level,
  name,
}: {
  action: BackofficeFormAction;
  budget?: ReportBudget | null;
  canManage: boolean;
  /** Moeda da conta de anúncio: o orçamento vive nela na Meta. */
  currency?: CurrencyCode;
  configuredStatus?: string | null;
  effectiveStatus?: string | null;
  id: string;
  level: MetaLevel;
  name: string;
}) {
  const statusDialogRef = useRef<HTMLDialogElement>(null);
  const budgetDialogRef = useRef<HTMLDialogElement>(null);
  const normalizedStatus = configuredStatus?.toUpperCase();
  const normalizedEffectiveStatus = effectiveStatus?.toUpperCase();
  const statusIsMutable =
    normalizedStatus === "ACTIVE" || normalizedStatus === "PAUSED";
  const isActive = normalizedStatus === "ACTIVE";
  const targetStatus = isActive ? "PAUSED" : "ACTIVE";
  const statusVerb = isActive ? "Pausar" : "Ativar";
  const copy = levelCopy[level];
  const money = (cents: number) => formatReportMoney(cents, currency);
  const budgetIsEditable =
    canManage && budget?.editable && budget.owner === level;
  const closeStatusDialog = useCallback(
    () => statusDialogRef.current?.close(),
    [],
  );
  const closeBudgetDialog = useCallback(
    () => budgetDialogRef.current?.close(),
    [],
  );

  return (
    <div className="meta-entity-controls">
      <div className="meta-entity-control-row">
        {statusIsMutable && canManage ? (
          <button
            aria-checked={isActive}
            aria-label={`${statusVerb} ${copy.label} ${name}`}
            className={`meta-status-switch${isActive ? " active" : ""}`}
            onClick={() => statusDialogRef.current?.showModal()}
            role="switch"
            title={`${statusVerb} ${copy.label}`}
            type="button"
          >
            <span aria-hidden="true" className="meta-status-switch-track">
              <span />
            </span>
            {isActive ? "Ativo" : "Pausado"}
          </button>
        ) : statusIsMutable ? (
          <span
            className={`meta-status-switch readonly${isActive ? " active" : ""}`}
          >
            <span aria-hidden="true" className="meta-status-switch-track">
              <span />
            </span>
            {isActive ? "Ativo" : "Pausado"}
          </span>
        ) : normalizedStatus ? (
          <span className="meta-effective-status">
            {statusLabel(normalizedStatus)}
          </span>
        ) : null}

        {normalizedEffectiveStatus &&
        normalizedEffectiveStatus !== normalizedStatus ? (
          <span className="meta-effective-status">
            {statusLabel(normalizedEffectiveStatus)}
          </span>
        ) : null}

        {budget ? (
          budgetIsEditable ? (
            <button
              aria-label={`Alterar orcamento d${copy.article} ${copy.label} ${name}`}
              className="meta-budget-control"
              onClick={() => budgetDialogRef.current?.showModal()}
              title="Alterar orcamento"
              type="button"
            >
              <Wallet aria-hidden="true" size={13} strokeWidth={2} />
              {money(budget.amountCents)}
            </button>
          ) : (
            <span
              className="meta-budget-control readonly"
              title={
                budget.owner === "campaign" && level === "adset"
                  ? "Orcamento controlado pela campanha"
                  : undefined
              }
            >
              <Wallet aria-hidden="true" size={13} strokeWidth={2} />
              {money(budget.amountCents)}
              {budget.owner === "campaign" && level === "adset"
                ? " na campanha"
                : budget.type === "daily"
                  ? " por dia"
                  : " total"}
            </span>
          )
        ) : level === "campaign" ? (
          <span className="meta-budget-control readonly">
            <Wallet aria-hidden="true" size={13} strokeWidth={2} />
            Orcamento nos conjuntos
          </span>
        ) : null}
      </div>

      {statusIsMutable && canManage ? (
        <dialog className="meta-action-dialog" ref={statusDialogRef}>
          <div className="meta-action-dialog-header">
            <div>
              <span className="micro-label">Confirmar alteracao</span>
              <h3>
                {statusVerb} {copy.label}?
              </h3>
            </div>
            <button
              aria-label="Fechar"
              className="meta-dialog-close"
              onClick={closeStatusDialog}
              title="Fechar"
              type="button"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </div>
          <p className="meta-action-target">
            <PresentationMask
              placeholder={
                level === "campaign"
                  ? "Campanha oculta"
                  : level === "adset"
                    ? "Conjunto oculto"
                    : "Anuncio oculto"
              }
            >
              {name}
            </PresentationMask>
          </p>
          <BackofficeActionForm
            action={action}
            className="meta-action-form"
            onSuccess={closeStatusDialog}
          >
            <input type="hidden" name="intent" value="status" />
            <input type="hidden" name="level" value={level} />
            <input type="hidden" name="id" value={id} />
            <input
              type="hidden"
              name="expectedStatus"
              value={normalizedStatus}
            />
            <input type="hidden" name="targetStatus" value={targetStatus} />
            <div className="meta-action-dialog-footer">
              <button
                className="button ghost"
                onClick={closeStatusDialog}
                type="button"
              >
                Cancelar
              </button>
              <SubmitButton
                className={`button${isActive ? " danger" : " primary"}`}
                pendingLabel="Salvando..."
                statusText="Enviando alteracao para a Meta."
              >
                {isActive ? (
                  <Pause aria-hidden="true" size={15} />
                ) : (
                  <Play aria-hidden="true" size={15} />
                )}
                {statusVerb}
              </SubmitButton>
            </div>
          </BackofficeActionForm>
        </dialog>
      ) : null}

      {budget && budgetIsEditable ? (
        <dialog className="meta-action-dialog" ref={budgetDialogRef}>
          <div className="meta-action-dialog-header">
            <div>
              <span className="micro-label">Orcamento Meta</span>
              <h3>
                Alterar valor {budget.type === "daily" ? "diario" : "total"}
              </h3>
            </div>
            <button
              aria-label="Fechar"
              className="meta-dialog-close"
              onClick={closeBudgetDialog}
              title="Fechar"
              type="button"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </div>
          <p className="meta-action-target">
            <PresentationMask
              placeholder={
                level === "campaign"
                  ? "Campanha oculta"
                  : level === "adset"
                    ? "Conjunto oculto"
                    : "Anuncio oculto"
              }
            >
              {name}
            </PresentationMask>
          </p>
          <BackofficeActionForm
            action={action}
            className="meta-action-form"
            onSuccess={closeBudgetDialog}
          >
            <input type="hidden" name="intent" value="budget" />
            <input type="hidden" name="level" value={level} />
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="budgetType" value={budget.type} />
            <input
              type="hidden"
              name="expectedBudgetCents"
              value={budget.amountCents}
            />
            <label className="meta-budget-field">
              <span>{currencyAmountLabels[currency]}</span>
              <span className="meta-budget-input-wrap">
                <span>{currencySymbol(currency)}</span>
                <input
                  autoComplete="off"
                  defaultValue={(budget.amountCents / 100).toFixed(2)}
                  inputMode="decimal"
                  min="0.01"
                  name="budgetAmount"
                  required
                  step="0.01"
                  type="number"
                />
              </span>
            </label>
            <div className="meta-action-dialog-footer">
              <button
                className="button ghost"
                onClick={closeBudgetDialog}
                type="button"
              >
                Cancelar
              </button>
              <SubmitButton
                className="button primary"
                pendingLabel="Salvando..."
                statusText="Enviando novo orcamento para a Meta."
              >
                <Wallet aria-hidden="true" size={15} />
                Salvar orcamento
              </SubmitButton>
            </div>
          </BackofficeActionForm>
        </dialog>
      ) : null}
    </div>
  );
}
