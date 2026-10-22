import type { ConversionEventNameDto } from "@wpptrack/shared";
import { paytBetaBadge, paytEventExplanations, paytEventLabel } from "./event-copy";

/**
 * Como ligar a Payt a uma regra de venda. A Payt não precisa de corpo
 * personalizado: ela envia o próprio postback de venda para a URL da regra,
 * e o RastrackDash lê o status e o valor de cada venda.
 */
export function PaytSetupPanel({
  eventName,
  beta = false,
}: {
  eventName: ConversionEventNameDto;
  /** O evento da regra ainda está em beta na Payt. */
  beta?: boolean;
}) {
  return (
    <div className="provider-conversion-payload-helper">
      <div>
        <span className="micro-label">Configuração na Payt</span>
        <strong>
          {paytEventLabel(eventName)}
          {beta ? (
            <>
              {" "}
              <span className="status-chip neutral conversion-beta-chip">
                {paytBetaBadge}
              </span>
            </>
          ) : null}
        </strong>
      </div>
      <p className="action-note">
        {paytEventExplanations[eventName] ?? ""} O valor vem da própria venda da
        Payt.
      </p>
      <ol className="provider-conversion-payload-steps">
        <li>Na Payt, abra Postback (webhook de vendas) e cole a URL completa desta regra.</li>
        <li>
          Só use o token se a Payt pedir em um campo separado: ele já está na
          URL.
        </li>
        <li>
          A regra começa em observação: nada é enviado à Meta até você ativar o
          envio automático.
        </li>
      </ol>
    </div>
  );
}
