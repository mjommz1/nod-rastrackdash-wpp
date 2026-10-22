import type { InboundWebhookChannelDto } from "@wpptrack/shared";

/**
 * Textos da prontidão de um número do Unnichat (modo de roteamento e destino
 * da Meta). Cada motivo diz o que a pessoa precisa fazer.
 */

type Readiness = InboundWebhookChannelDto["readiness"];

const ctwaDestinationReasonLabels: Record<string, string> = {
  ctwa_destination_ambiguous:
    "Há mais de uma página e pixel possíveis. Escolha “Configurar neste número” e deixe só um par, ou ajuste a configuração Meta do workspace para ter um único par.",
  ctwa_verified_binding_missing:
    "Falta um par de página e pixel verificado para este número. Confira a página e o pixel em Integrações, na aba Anúncios (Meta Ads).",
  ctwa_workspace_routing_disabled:
    "A configuração Meta do workspace está desligada. Ative-a na aba Anúncios (Meta Ads) ou configure este número.",
  ctwa_channel_routing_mode_unset:
    "Este número ainda não tem um modo de roteamento. Escolha “Herdar do workspace” ou “Configurar neste número” e salve.",
  ctwa_override_no_valid_routes:
    "As rotas deste número não têm nenhuma rota válida. Adicione uma rota Meta válida ou volte para “Herdar do workspace”.",
  ctwa_channel_scope_invalid:
    "Este número está fora do alcance permitido para anúncios. Recadastre o número na conexão do Unnichat.",
};

/** O que fazer quando o destino do CTWA ainda não está verificado. */
export function ctwaDestinationReasonLabel(reason: string): string {
  return (
    ctwaDestinationReasonLabels[reason] ??
    "Motivo não reconhecido. Atualize a página e confira a configuração Meta."
  );
}

export type UnnichatRoutingChoice = "inherit_workspace" | "channel_override";

/** Modo escolhido de um número; sem modo salvo, abre no que o número já usa. */
export function unnichatRoutingChoice(
  channel: Pick<InboundWebhookChannelDto, "routes" | "readiness">,
): UnnichatRoutingChoice {
  const source = channel.readiness.routingSource;

  if (source === "channel_override") return "channel_override";
  if (source === "inherit_workspace") return "inherit_workspace";

  return channel.routes.some((route) => route.active)
    ? "channel_override"
    : "inherit_workspace";
}

export function unnichatRoutingSourceLabel(
  source: Readiness["routingSource"],
): string {
  switch (source) {
    case "inherit_workspace":
      return "Herda do workspace";
    case "channel_override":
      return "Configurado neste número";
    case "legacy_unknown":
      return "Modo não escolhido";
    default:
      return "";
  }
}

/** O número está pronto para enviar o CTWA sem ID do anúncio? */
export function unnichatDestinationVerified(readiness: Readiness): boolean {
  return readiness.ctwaDestinationReadiness?.status === "verified";
}

/** Frase de “Rota pendente” (blocker route_not_configured) conforme o modo. */
export function unnichatRouteNotConfiguredLabel(readiness: Readiness): string {
  if (readiness.routingSource === "inherit_workspace") {
    const ready =
      readiness.effectiveRouteEligible === true &&
      readiness.ctwaDestinationReadiness?.status !== "not_ready";

    return ready
      ? "Este número herda a configuração Meta do workspace: não precisa de rota própria."
      : "Este número herda a configuração Meta do workspace, que ainda não está pronta para ele. Confira a Meta na aba Anúncios (Meta Ads) ou escolha “Configurar neste número”.";
  }

  if (readiness.routingSource === "channel_override") {
    return "Este número usa rotas próprias no lugar da configuração do workspace. Adicione ao menos uma rota Meta válida.";
  }

  return "Escolha o modo de roteamento deste número e salve.";
}

export function adUnavailableLabel(count: number): string {
  return `${count} ${count === 1 ? "conversa chegou" : "conversas chegaram"} sem o anúncio de origem identificado e ainda não ${count === 1 ? "tem" : "têm"} destino. Elas só seguem quando o número tem um único par de página e pixel verificado; uma BM a mais não recupera o anúncio.`;
}
