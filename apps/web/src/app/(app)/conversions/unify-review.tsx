"use client";

import type { ProviderConversionRuleUnifyCandidateDto } from "@wpptrack/shared";
import { Combine } from "lucide-react";
import { useState } from "react";
import { Modal } from "../../../components/modal";
import { PresentationMask } from "../../../components/presentation-mask";
import { ruleEventLabel } from "./event-copy";
import type { ConversionScreenActionResult } from "./actions";
import { ruleOriginDefinition } from "./conversion-origins";
import { observationCanonicalWarning } from "./conversion-rules-view";
import type { ConversionNumber } from "./conversion-rules-view";

type UnifyAction = (formData: FormData) => Promise<ConversionScreenActionResult>;

/** "3 regras iguais em 3 números" banner with one review button per group. */
export function UnifyBanner({
  groups,
  canManage,
  onReview,
}: {
  groups: ProviderConversionRuleUnifyCandidateDto[];
  canManage: boolean;
  onReview: (group: ProviderConversionRuleUnifyCandidateDto) => void;
}) {
  if (groups.length === 0) return null;

  return (
    <section
      className="conversion-unify-banner"
      aria-labelledby="conversion-unify-title"
    >
      <span className="conversion-unify-icon" aria-hidden="true">
        <Combine size={20} />
      </span>
      <div className="conversion-unify-copy">
        <h2 id="conversion-unify-title">
          {groups.length === 1
            ? "Há uma regra repetida em vários números"
            : `Há ${groups.length} regras repetidas em vários números`}
        </h2>
        <p>
          Você pode trocar as cópias por uma regra só, que vale para todos os
          números. Nada muda até você revisar e confirmar.
        </p>
      </div>
      <ul className="conversion-unify-groups" role="list">
        {groups.map((group) => (
          <li key={group.key}>
            <span>
              <strong>{group.name}</strong>
              <small>
                {ruleOriginDefinition(group.origin).label} ·{" "}
                {ruleEventLabel(group.eventName)} ·{" "}
                {group.ruleIds.length} cópias
              </small>
            </span>
            {canManage ? (
              <button
                className="button"
                type="button"
                onClick={() => onReview(group)}
                aria-haspopup="dialog"
              >
                Revisar e unificar
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function NumberList({
  ids,
  numbersById,
}: {
  ids: readonly string[];
  numbersById: ReadonlyMap<string, ConversionNumber>;
}) {
  return (
    <ul className="conversion-number-chips" role="list">
      {ids.map((id) => {
        const number = numbersById.get(id);
        return (
          <li key={id}>
            <PresentationMask placeholder="Número oculto">
              {number?.label ?? "Número removido"}
            </PresentationMask>
            {number ? <small>{number.connectionName}</small> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Confirmation of one "Unificar" group and its result. */
export function UnifyReviewModal({
  group,
  numbers,
  unifyAction,
  onClose,
  onDone,
}: {
  group: ProviderConversionRuleUnifyCandidateDto | null;
  numbers: readonly ConversionNumber[];
  unifyAction: UnifyAction;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ConversionScreenActionResult | null>(
    null,
  );
  const numbersById = new Map(numbers.map((number) => [number.id, number]));

  function close() {
    if (pending) return;
    const finished = result?.ok;
    setResult(null);
    setName("");
    if (finished) onDone();
    else onClose();
  }

  async function confirm() {
    if (!group || pending) return;
    setPending(true);
    const formData = new FormData();
    for (const id of group.ruleIds) formData.append("ruleId", id);
    if (name.trim()) formData.set("name", name.trim());
    try {
      const response = await unifyAction(formData);
      setResult(response);
    } catch {
      setResult({
        ok: false,
        outcomeUnknown: true,
        message:
          "Não deu para confirmar a unificação. Confira a lista antes de tentar de novo.",
      });
    } finally {
      setPending(false);
    }
  }

  const duplicatePhone = group?.duplicatePhoneChannelIds ?? [];
  const observationCanonical = group?.observationCanonicalChannels ?? [];

  return (
    <Modal
      open={group !== null}
      onClose={close}
      title="Unificar regras iguais"
      description={
        group
          ? `${group.ruleIds.length} regras “${group.name}” viram uma regra para todos os números.`
          : undefined
      }
      size="wide"
    >
      {group ? (
        result?.ok ? (
          <div className="conversion-flow-result" role="status">
            <div className="feedback-banner success">
              <strong>Regras unificadas</strong>
              <span>{result.message}</span>
            </div>
            {result.unify?.newlyCoveredChannelIds.length ? (
              <section className="conversion-review-block">
                <h3>Números que passaram a ser cobertos</h3>
                <NumberList
                  ids={result.unify.newlyCoveredChannelIds}
                  numbersById={numbersById}
                />
              </section>
            ) : null}
            {result.unify?.duplicatePhoneChannelIds.length ? (
              <p className="action-note">
                Alguns números têm o mesmo telefone em duas conexões: o evento
                sai uma vez só por telefone.
              </p>
            ) : null}
            <div className="conversion-flow-actions">
              <button className="button primary" type="button" onClick={close}>
                Concluir
              </button>
            </div>
          </div>
        ) : (
          <div className="conversion-unify-review provider-conversion-builder">
            <p className="muted">
              {ruleOriginDefinition(group.origin).label} ·{" "}
              {ruleEventLabel(group.eventName)} ·{" "}
              {group.mode === "production"
                ? "envio automático"
                : "em observação"}
              . As regras atuais são pausadas e o histórico delas continua
              salvo.
            </p>
            <p className="action-note">
              Dá para desfazer: retome as regras pausadas (em “Regras”,
              Retomar observação) e pause a regra para todos os números.
              Unificar é uma sugestão, nunca é obrigatório.
            </p>

            <section className="conversion-review-block">
              <h3>Já cobertos hoje ({group.channelIds.length})</h3>
              <NumberList ids={group.channelIds} numbersById={numbersById} />
            </section>

            <section className="conversion-review-block">
              <h3>
                Passam a ser cobertos ({group.newlyCoveredChannelIds.length})
              </h3>
              {group.newlyCoveredChannelIds.length > 0 ? (
                <>
                  <NumberList
                    ids={group.newlyCoveredChannelIds}
                    numbersById={numbersById}
                  />
                  <p className="action-note warn">
                    {group.mode === "production"
                      ? "Estes números começam a enviar este evento para a Meta."
                      : "Estes números começam a ser observados por esta regra (nada é enviado à Meta em observação)."}
                  </p>
                </>
              ) : (
                <p className="muted">
                  Nenhum número novo. Números conectados depois também entram
                  automaticamente.
                </p>
              )}
            </section>

            {group.overriddenChannelIds.length > 0 ? (
              <section className="conversion-review-block">
                <h3>
                  Continuam com a regra própria (
                  {group.overriddenChannelIds.length})
                </h3>
                <NumberList
                  ids={group.overriddenChannelIds}
                  numbersById={numbersById}
                />
                <p className="action-note">
                  Esses números já têm outra regra específica com a mesma origem
                  e o mesmo evento. Ela continua valendo no lugar da nova regra.
                </p>
              </section>
            ) : null}

            {duplicatePhone.length > 0 ? (
              <section className="conversion-review-block">
                <h3>Mesmo telefone em duas conexões ({duplicatePhone.length})</h3>
                <NumberList ids={duplicatePhone} numbersById={numbersById} />
                <p className="action-note">
                  O telefone destes números já é lido por outra conexão. A
                  regra roda uma vez só por telefone, para nunca enviar o
                  evento em dobro.
                </p>
              </section>
            ) : null}

            {observationCanonical.length > 0 ? (
              <section className="conversion-review-block">
                <h3>
                  Canal em observação ({observationCanonical.length})
                </h3>
                <NumberList
                  ids={observationCanonical.map((item) => item.canonicalChannelId)}
                  numbersById={numbersById}
                />
                <p className="action-note warn">
                  {observationCanonicalWarning(
                    observationCanonical.map((item) => item.canonicalChannelId),
                    numbersById,
                  )}
                </p>
              </section>
            ) : null}

            {group.existingGlobalRuleId ? (
              <p className="action-note">
                Já existe uma regra igual para todos os números. Ela será
                reaproveitada.
              </p>
            ) : (
              <label className="conversion-field">
                <span className="field-label">Nome da regra unificada</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={group.name}
                  maxLength={120}
                />
              </label>
            )}

            {result && !result.ok ? (
              <p
                className={`action-note${result.outcomeUnknown ? "" : " warn"}`}
                role="alert"
              >
                {result.message}
              </p>
            ) : null}

            <div className="conversion-flow-actions">
              <button
                className="button"
                type="button"
                onClick={close}
                disabled={pending}
              >
                Cancelar
              </button>
              <button
                className="button primary"
                type="button"
                onClick={() => void confirm()}
                disabled={pending || result?.licenseLocked === true}
                data-pending={pending ? "true" : undefined}
              >
                {pending ? "Unificando..." : "Unificar"}
              </button>
            </div>
          </div>
        )
      ) : null}
    </Modal>
  );
}
