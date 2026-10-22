"use client";

import { PresentationMask } from "../../../components/presentation-mask";
import { providerDisplayName } from "./conversion-origins";
import type { ComingSoonNumber } from "./conversions-data";
import type { ConversionNumber } from "./conversion-rules-view";

/**
 * Números que não entram nas regras de frase, etiqueta e catálogo, em dois
 * grupos que não se misturam:
 * - “Em breve”: WAHA, Z-API e NOD API (ainda não participam das regras);
 * - provedores que funcionam normalmente (Gupshup, Data Crazy, WhatsApp Cloud
 *   API): as conversões chegam pelo webhook do provedor, só não há regra de
 *   frase para eles. Nunca recebem o rótulo “Em breve”.
 */
export function NumbersWithoutRules({
  comingSoon,
  webhookOnly,
  intro = true,
}: {
  comingSoon: ComingSoonNumber[];
  webhookOnly: ConversionNumber[];
  intro?: boolean;
}) {
  if (comingSoon.length === 0 && webhookOnly.length === 0) return null;

  return (
    <div className="conversion-coming-soon" aria-label="Números sem regras">
      {comingSoon.length > 0 ? (
        <div aria-label="Números em breve nas regras">
          {intro ? (
            <p className="action-note">
              Em breve nas regras (ainda não dá para escolher):
            </p>
          ) : null}
          <ul className="conversion-number-chips" role="list">
            {comingSoon.map((number) => (
              <li key={number.id}>
                <PresentationMask placeholder="Número oculto">
                  {number.label}
                </PresentationMask>
                <small>{providerDisplayName(number.provider)} · Em breve</small>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {webhookOnly.length > 0 ? (
        <div aria-label="Números que usam o webhook do provedor">
          {intro ? (
            <p className="action-note">
              Conversões chegam pelo webhook do provedor; regras de frase não se
              aplicam a estes números:
            </p>
          ) : null}
          <ul className="conversion-number-chips" role="list">
            {webhookOnly.map((number) => (
              <li key={number.id}>
                <PresentationMask placeholder="Número oculto">
                  {number.label}
                </PresentationMask>
                <small>{providerDisplayName(number.provider)} · pelo webhook</small>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
