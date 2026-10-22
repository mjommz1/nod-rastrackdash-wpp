"use client";

import type {
  ProviderConversionRuleDto,
  PurchaseReviewDto,
} from "@wpptrack/shared";
import { formatMoney } from "@wpptrack/shared";
import { Check, Plus, Save, ShoppingCart, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { PresentationMask } from "../../../../components/presentation-mask";
import { apiFetch } from "../../../../lib/api";
import { formatDateTime } from "../../../../lib/date-time";
import {
  purchaseReviewReasonLabel,
  purchaseReviewStatusLabel,
  purchaseReviewTone,
} from "../../settings/provider-conversion-labels";
import { EventAuditDetails } from "../event-audit-details";

type EditableItem = {
  catalogVariantId: string;
  quantity: number;
};

type PurchaseReviewPanelProps = {
  canManage: boolean;
  providerRules: ProviderConversionRuleDto[];
  reviews: PurchaseReviewDto[];
};

function money(valueCents: number | null, currency = "BRL"): string {
  if (valueCents === null) return "Pendente";
  return formatMoney(valueCents, currency);
}

function ReviewRow({
  canManage,
  providerRules,
  review,
}: PurchaseReviewPanelProps & { review: PurchaseReviewDto }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [reason, setReason] = useState("Revisao operacional da compra");
  const rule = providerRules.find(
    (candidate) => candidate.id === review.providerRuleId,
  );
  const variants =
    rule?.catalog?.variants.filter((variant) => variant.active) ?? [];
  const catalogReview =
    rule?.conversionRule.triggerType === "structured_catalog";
  const [items, setItems] = useState<EditableItem[]>(() => {
    const current = review.items
      .filter((item) => item.catalogVariantId)
      .map((item) => ({
        catalogVariantId: item.catalogVariantId!,
        quantity: item.quantity,
      }));
    return current.length || !catalogReview
      ? current
      : [{ catalogVariantId: "", quantity: 1 }];
  });
  const variantById = useMemo(
    () => new Map(variants.map((variant) => [variant.id, variant])),
    [variants],
  );
  const editedTotal = items.reduce((total, item) => {
    const variant = variantById.get(item.catalogVariantId);
    return total + (variant?.valueCents ?? 0) * item.quantity;
  }, 0);
  const materialized = Boolean(review.conversionEventLogId);
  const sent = ["sent", "corrected_after_send"].includes(review.status);
  const reviewIsTerminal = ["duplicate", "rejected", "approved"].includes(
    review.status,
  );
  const canEditCatalog =
    catalogReview && ((!materialized && !reviewIsTerminal) || sent);
  const canReject =
    !materialized &&
    !["duplicate", "rejected", "approved"].includes(review.status);
  const canApprove =
    !catalogReview &&
    !materialized &&
    !["duplicate", "rejected", "approved"].includes(review.status) &&
    review.effectiveValueCents !== null;

  async function perform(
    action: string,
    path: string,
    init: RequestInit,
    successMessage: string,
  ) {
    setBusy(action);
    setFeedback(null);
    try {
      await apiFetch(path, init);
      setFeedback(successMessage);
      router.refresh();
    } catch {
      setFeedback(
        "Nao foi possivel concluir. Atualize a pagina e tente novamente.",
      );
    } finally {
      setBusy(null);
    }
  }

  function validItems(): boolean {
    if (
      items.length === 0 ||
      items.some((item) => !item.catalogVariantId || item.quantity < 1)
    ) {
      setFeedback(
        "Selecione uma variante e informe a quantidade de cada item.",
      );
      return false;
    }
    return true;
  }

  function saveCorrection() {
    if (!validItems()) return;
    void perform(
      "save",
      `/purchase-reviews/${encodeURIComponent(review.id)}/items`,
      {
        method: "PUT",
        body: JSON.stringify({ items, reason }),
      },
      sent
        ? "Valor corrigido no painel sem reenviar para a Meta."
        : "Itens revisados. A compra ja pode ser aprovada.",
    );
  }

  async function resolveAndApproveCatalog() {
    if (!validItems()) return;

    setBusy("resolve-and-approve");
    setFeedback(null);
    try {
      await apiFetch(
        `/purchase-reviews/${encodeURIComponent(review.id)}/resolve-and-approve`,
        {
          method: "POST",
          body: JSON.stringify({ items, reason }),
        },
      );
      setFeedback("Compra aprovada e encaminhada para a Meta.");
      router.refresh();
    } catch {
      setFeedback(
        "A compra permanece pendente. Atualize a pagina e tente novamente.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="purchase-review-row">
      <header className="purchase-review-row-header">
        <div className="purchase-review-identity">
          <span className="purchase-review-icon" aria-hidden="true">
            <ShoppingCart size={17} strokeWidth={2.1} />
          </span>
          <div>
            <span className="eyebrow">{review.ruleName}</span>
            <h3>
              <PresentationMask placeholder="Cliente oculto">
                {review.leadName ?? "Lead sem nome"}
              </PresentationMask>
            </h3>
            <span>
              <PresentationMask placeholder="(00) 00000-0000">
                {review.phoneDisplay ?? "Telefone indisponivel"}
              </PresentationMask>
            </span>
          </div>
        </div>
        <div className="purchase-review-state">
          <span className={`status-chip ${purchaseReviewTone(review.status)}`}>
            {purchaseReviewStatusLabel(review.status)}
          </span>
          <time dateTime={review.occurredAt}>
            {formatDateTime(review.occurredAt)}
          </time>
        </div>
      </header>

      <div className="purchase-review-facts">
        <div>
          <span>Canal</span>
          <strong>{review.channelName ?? "Canal nao identificado"}</strong>
        </div>
        <div>
          <span>Origem</span>
          <strong>
            {review.sourceType === "provider_automation"
              ? "Automacao Umbler"
              : "Mensagem Umbler"}
          </strong>
        </div>
        <div>
          <span>Frase gatilho</span>
          <strong>{review.matchedTriggerPhrase ?? "Nao reconhecida"}</strong>
        </div>
        <div>
          <span>Valor efetivo</span>
          <strong>{money(review.effectiveValueCents, review.currency)}</strong>
        </div>
      </div>

      <div className="purchase-review-trace">
        <div>
          <span className="micro-label">Diagnostico</span>
          <strong>{purchaseReviewReasonLabel(review.reasonCode)}</strong>
        </div>
        {review.conversionEventLogId ? (
          <EventAuditDetails
            canRetry={false}
            eventId={review.conversionEventLogId}
            eventLabel={review.ruleName}
          />
        ) : (
          <span className="purchase-review-event-pending">
            Evento Meta ainda nao criado
          </span>
        )}
      </div>

      {catalogReview ? (
        <div className="purchase-review-items">
          <div className="purchase-review-items-heading">
            <div>
              <span className="micro-label">Itens da compra</span>
              <strong>
                {review.items.length
                  ? `${review.items.length} item(ns) reconhecido(s)`
                  : "Complete os produtos antes de aprovar"}
              </strong>
            </div>
            <span className="purchase-review-total">
              Edicao: {money(editedTotal, review.currency)}
            </span>
          </div>

          {canManage && canEditCatalog ? (
            <div className="purchase-review-editor">
              {items.map((item, index) => (
                <div
                  className="purchase-review-item-editor"
                  key={`${index}-${item.catalogVariantId}`}
                >
                  <label>
                    <span>Produto</span>
                    <select
                      value={item.catalogVariantId}
                      onChange={(event) =>
                        setItems((current) =>
                          current.map((entry, entryIndex) =>
                            entryIndex === index
                              ? {
                                  ...entry,
                                  catalogVariantId: event.target.value,
                                }
                              : entry,
                          ),
                        )
                      }
                    >
                      <option value="">Selecionar variante</option>
                      {variants.map((variant) => (
                        <option key={variant.id} value={variant.id}>
                          {variant.attributeValues.join(" / ")} -{" "}
                          {money(variant.valueCents, review.currency)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="purchase-review-quantity">
                    <span>Qtd.</span>
                    <input
                      min={1}
                      max={100}
                      type="number"
                      value={item.quantity}
                      onChange={(event) =>
                        setItems((current) =>
                          current.map((entry, entryIndex) =>
                            entryIndex === index
                              ? {
                                  ...entry,
                                  quantity: Math.max(
                                    1,
                                    Number(event.target.value) || 1,
                                  ),
                                }
                              : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    aria-label="Remover item"
                    className="icon-button danger"
                    disabled={items.length === 1}
                    onClick={() =>
                      setItems((current) =>
                        current.filter((_, entryIndex) => entryIndex !== index),
                      )
                    }
                    title="Remover item"
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={16} />
                  </button>
                </div>
              ))}
              <button
                className="button ghost"
                onClick={() =>
                  setItems((current) => [
                    ...current,
                    { catalogVariantId: "", quantity: 1 },
                  ])
                }
                type="button"
              >
                <Plus aria-hidden="true" size={15} />
                Adicionar item
              </button>
            </div>
          ) : (
            <div className="purchase-review-readonly-items">
              {review.items.map((item) => (
                <span key={item.id}>
                  <strong>{item.quantity}x</strong>{" "}
                  {item.attributeValues.join(" / ")}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="purchase-review-average-value">
          <span className="micro-label">Regra de valor medio</span>
          <strong>{money(review.effectiveValueCents, review.currency)}</strong>
          <span>Valor fixo configurado para esta conversao.</span>
        </div>
      )}

      {review.observedPaymentValueCents !== null ? (
        <p className="purchase-review-note">
          A mensagem mencionou{" "}
          {money(review.observedPaymentValueCents, review.currency)}. O valor do
          catalogo continua sendo a fonte oficial.
        </p>
      ) : null}

      {canManage ? (
        <footer className="purchase-review-actions">
          <label>
            <span>Motivo da decisao</span>
            <input
              maxLength={500}
              minLength={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div>
            {canEditCatalog ? (
              <button
                className={sent ? "button ghost" : "button primary"}
                disabled={busy !== null}
                onClick={
                  sent ? saveCorrection : () => void resolveAndApproveCatalog()
                }
                type="button"
              >
                {sent ? (
                  <Save aria-hidden="true" size={15} />
                ) : (
                  <Check aria-hidden="true" size={15} />
                )}
                {sent ? "Corrigir painel" : "Aprovar e enviar"}
              </button>
            ) : null}
            {canReject ? (
              <button
                className="button danger"
                disabled={busy !== null}
                onClick={() =>
                  void perform(
                    "reject",
                    `/purchase-reviews/${encodeURIComponent(review.id)}/reject`,
                    { method: "POST", body: JSON.stringify({ reason }) },
                    "Compra rejeitada.",
                  )
                }
                type="button"
              >
                <X aria-hidden="true" size={15} />
                Rejeitar
              </button>
            ) : null}
            {canApprove ? (
              <button
                className="button primary"
                disabled={busy !== null}
                onClick={() =>
                  void perform(
                    "approve",
                    `/purchase-reviews/${encodeURIComponent(review.id)}/approve`,
                    { method: "POST", body: JSON.stringify({ reason }) },
                    "Compra aprovada e encaminhada para a Meta.",
                  )
                }
                type="button"
              >
                <Check aria-hidden="true" size={15} />
                Aprovar e enviar
              </button>
            ) : null}
          </div>
          {feedback ? (
            <span className="purchase-review-feedback">{feedback}</span>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

export function PurchaseReviewPanel(props: PurchaseReviewPanelProps) {
  if (props.reviews.length === 0) {
    return (
      <div className="surface-panel purchase-review-empty">
        <ShoppingCart aria-hidden="true" size={22} />
        <strong>Nenhuma compra encontrada</strong>
        <span>
          Ajuste o periodo ou aguarde uma mensagem com a frase gatilho.
        </span>
      </div>
    );
  }

  return (
    <section
      className="surface-panel purchase-review-list"
      aria-label="Compras para revisao"
    >
      {props.reviews.map((review) => (
        <ReviewRow key={review.id} {...props} review={review} />
      ))}
    </section>
  );
}
