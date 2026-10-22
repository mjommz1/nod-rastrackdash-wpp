"use client";

import type {
  InboundWebhookChannelDto,
  MetaManualConfigurationDto,
} from "@wpptrack/shared";
import { Save } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { InboundWebhookActionResult } from "./inbound-webhook-actions";
import {
  unnichatRoutingChoice,
  type UnnichatRoutingChoice,
} from "./inbound-webhook-labels";
import { InboundWebhookRouteEditor } from "./inbound-webhook-route-editor";

type SaveRoutesAction = (
  formData: FormData,
) => Promise<InboundWebhookActionResult>;

export type InboundWebhookRoutingModeProps = {
  channel: InboundWebhookChannelDto;
  metaConfiguration: MetaManualConfigurationDto | null;
  canManage: boolean;
  saveAction: SaveRoutesAction;
  onUpdated: (result: InboundWebhookActionResult) => void;
};

/**
 * Modo de roteamento Meta de um número do Unnichat.
 *
 * - Herdar do workspace: o número usa a configuração Meta do workspace; um
 *   lead sem ID do anúncio vai para o único par de página e pixel autorizado.
 * - Configurar neste número: só valem as rotas salvas aqui (inclusive para o
 *   lead sem ID do anúncio).
 */
export function InboundWebhookRoutingMode({
  channel,
  metaConfiguration,
  canManage,
  saveAction,
  onUpdated,
}: InboundWebhookRoutingModeProps) {
  const groupName = useId();
  const routingSource = channel.readiness.routingSource;
  const storedChoice = unnichatRoutingChoice(channel);
  const [choice, setChoice] = useState<UnnichatRoutingChoice>(storedChoice);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setChoice(storedChoice);
  }, [storedChoice, channel.id]);

  const inheritApplied = routingSource === "inherit_workspace";
  const needsChoice =
    routingSource !== "inherit_workspace" &&
    routingSource !== "channel_override";

  async function applyInherit() {
    if (pending || !canManage) {
      return;
    }

    const localRoutes = channel.routes.filter((route) => route.active).length;
    const message =
      localRoutes > 0
        ? `Herdar do workspace? ${localRoutes === 1 ? "A rota própria deste número será removida" : `As ${localRoutes} rotas próprias deste número serão removidas`} e ele passará a usar a configuração Meta do workspace.`
        : "Herdar do workspace? O número passará a usar a configuração Meta do workspace (página e pixel).";

    if (!window.confirm(message)) {
      return;
    }

    const formData = new FormData();
    formData.set("channelId", channel.id);
    formData.set("routingMode", "inherit_workspace");
    formData.set("routes", "[]");

    setPending(true);
    try {
      onUpdated(await saveAction(formData));
    } catch {
      onUpdated({
        ok: false,
        message: "Não foi possível salvar o modo de roteamento deste número.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="inbound-routing-mode"
      aria-label="Modo de roteamento Meta do número"
    >
      <fieldset className="inbound-routing-mode-options">
        <legend className="micro-label">Roteamento Meta do número</legend>
        <label>
          <input
            type="radio"
            name={groupName}
            value="inherit_workspace"
            checked={choice === "inherit_workspace"}
            onChange={() => setChoice("inherit_workspace")}
            disabled={pending || !canManage}
          />
          <span>Herdar do workspace</span>
        </label>
        <label>
          <input
            type="radio"
            name={groupName}
            value="channel_override"
            checked={choice === "channel_override"}
            onChange={() => setChoice("channel_override")}
            disabled={pending || !canManage}
          />
          <span>Configurar neste número</span>
        </label>
      </fieldset>

      {needsChoice && canManage ? (
        <p className="action-note warn">
          Este número ainda não tem um modo de roteamento. Escolha uma das
          opções e salve.
        </p>
      ) : null}

      {choice === "inherit_workspace" ? (
        <div className="inbound-routing-mode-inherit">
          <p className="muted">
            Usa a página e o pixel da configuração Meta do workspace. Não
            precisa de rota por número: a conversa com ID do anúncio usa a rota
            do anúncio e a conversa sem ID vai para o único par de página e
            pixel autorizado. Se houver mais de um par possível, nada é
            enviado.
          </p>
          {canManage && !inheritApplied ? (
            <button
              className="button primary"
              type="button"
              onClick={() => void applyInherit()}
              disabled={pending}
            >
              <Save size={15} aria-hidden="true" />
              {pending ? "Salvando..." : "Herdar do workspace"}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <p className="muted">
            Só valem as rotas salvas neste número, inclusive para a conversa
            sem ID do anúncio. Use quando há mais de uma página e pixel ou
            quando o número deve usar só uma BM, conta ou destino.
          </p>
          <InboundWebhookRouteEditor
            channel={channel}
            metaConfiguration={metaConfiguration}
            canManage={canManage}
            saveAction={saveAction}
            onUpdated={onUpdated}
            routingMode="channel_override"
            requireRoute
          />
        </>
      )}
    </section>
  );
}
