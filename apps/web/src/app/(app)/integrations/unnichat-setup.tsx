"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/**
 * Corpo que o Unnichat envia nos dois pontos do fluxo (entrada da conversa e
 * automação que marca a conversão). É o contrato validado no SaaS: o Unnichat
 * troca os campos entre chaves. O evento da conversão vem da regra, não do
 * `event_name` (sempre "Lead").
 */
export const unnichatWebhookBody = {
  event: "Lead",
  event_name: "Lead",
  phone: "{{phoneNumber}}",
  external_id: "{{phoneNumber}}",
  ctwa_clid: "{{ctwa_clid}}",
  ctwa_id: "{{ctwa_id}}",
  source_type: "ctwa",
  lead_source: "meta_ads",
  source: "unnichat",
  channel: "whatsapp",
  origin: "ctwa",
} as const;

export const unnichatWebhookBodyJson = JSON.stringify(
  unnichatWebhookBody,
  null,
  2,
);

function BodyBlock() {
  const [copied, setCopied] = useState(false);

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(unnichatWebhookBodyJson);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <pre className="payload-block" data-presentation-sensitive-field="true">
        {unnichatWebhookBodyJson}
      </pre>
      <button
        className="button subtle"
        type="button"
        onClick={() => void copyBody()}
      >
        {copied ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <Copy size={14} aria-hidden="true" />
        )}
        {copied ? "Copiado" : "Copiar corpo JSON"}
      </button>
    </>
  );
}

/** Corpo JSON do Unnichat com o botão de copiar (URL por evento). */
export function UnnichatWebhookBody() {
  return (
    <div className="unnichat-setup">
      <BodyBlock />
    </div>
  );
}

/**
 * Passo a passo mostrado junto da URL de entrada da conexão (exibida uma vez):
 * webhook de entrada da conversa que veio do anúncio.
 */
export function UnnichatEntrySetupPanel() {
  return (
    <div className="provider-conversion-payload-helper unnichat-setup">
      <div>
        <span className="micro-label">Configuração no Unnichat</span>
        <strong>Webhook de entrada da conversa</strong>
      </div>
      <ol className="provider-conversion-payload-steps">
        <li>
          No Unnichat, abra o fluxo que recebe a conversa do anúncio e adicione
          uma chamada HTTP (método POST, corpo JSON).
        </li>
        <li>
          Cole a URL completa acima, com o token. Não precisa de cabeçalho
          extra.
        </li>
        <li>
          Cole o corpo abaixo. O Unnichat troca os campos entre chaves pelos
          dados reais da conversa.
        </li>
      </ol>
      <BodyBlock />
      <p className="action-note">
        Sem o <code>ctwa_clid</code> (o clique no anúncio) nada é enviado à
        Meta: a conversa fica registrada como ignorada. O ID do anúncio é
        opcional.
      </p>
      <p className="action-note">
        A conexão já guarda o seu número de WhatsApp e começa em observação:
        nada é enviado à Meta até você ativar o número e o envio automático.
      </p>
    </div>
  );
}

/**
 * Passo a passo da URL da regra de automação: chamada no ponto do fluxo que
 * marca a conversão. O evento é o da regra.
 */
export function UnnichatAutomationSetupPanel({
  eventLabel,
}: {
  eventLabel: string;
}) {
  return (
    <div className="provider-conversion-payload-helper unnichat-setup">
      <div>
        <span className="micro-label">Configuração no Unnichat</span>
        <strong>Automação que marca “{eventLabel}”</strong>
      </div>
      <ol className="provider-conversion-payload-steps">
        <li>
          No Unnichat, abra o fluxo e vá até a etapa que deve marcar a
          conversão. Adicione uma chamada HTTP (método POST, corpo JSON).
        </li>
        <li>
          Cole a URL desta regra. Ela é só desta regra e já leva o token; a URL
          de entrada da conexão continua em Integrações.
        </li>
        <li>
          Use o mesmo corpo da entrada. O evento enviado à Meta é o da regra,
          não o do campo <code>event_name</code>.
        </li>
      </ol>
      <BodyBlock />
      <p className="action-note">
        A automação só converte um contato que antes entrou pelo anúncio neste
        número. Contato sem <code>ctwa_clid</code> fica bloqueado (“sem clique
        do anúncio”) e nada é enviado.
      </p>
    </div>
  );
}
