import { conversionEventBuilderLabel } from "@wpptrack/shared";

/**
 * O catálogo de eventos do pacote shared é ASCII de propósito (teste de
 * contrato em packages/shared). As telas mostram o texto com acentos.
 */
const accents: ReadonlyArray<[RegExp, string]> = [
  [/\bNao\b/gu, "Não"],
  [/\bnao\b/gu, "não"],
  [/\be enviado\b/gu, "é enviado"],
  [/\bO valor e opcional\b/gu, "O valor é opcional"],
  [/\bmaximo\b/gu, "máximo"],
  [/\bConteudo\b/gu, "Conteúdo"],
  [/\bpagina\b/gu, "página"],
  [/\bintencao\b/gu, "intenção"],
  [/\bextraido\b/gu, "extraído"],
  [/\bexpedicao\b/gu, "expedição"],
  [/\boperacoes\b/gu, "operações"],
  [/\boperacao\b/gu, "operação"],
  [/\bfisico\b/gu, "físico"],
  [/\bAvaliacao\b/gu, "Avaliação"],
  [/\bComentario\b/gu, "Comentário"],
  [/\bmonetario\b/gu, "monetário"],
  [/\bvez por lead\b/gu, "vez por lead"],
];

export function accentEventCopy(text: string): string {
  return accents.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text,
  );
}

/** Rótulo do evento com acentos, para as telas de Conversões. */
export function ruleEventLabel(eventName: string): string {
  return accentEventCopy(conversionEventBuilderLabel(eventName));
}

/**
 * Eventos de venda da Payt: o evento vem do status de cada venda, então o
 * rótulo fala da venda (Pix/boleto gerado, e não “Iniciar checkout”).
 */
export const paytEventLabels: Readonly<Record<string, string>> = {
  Purchase: "Compra aprovada",
  InitiateCheckout: "Pix/boleto gerado",
  CartAbandoned: "Carrinho abandonado",
};

export const paytEventExplanations: Readonly<Record<string, string>> = {
  Purchase: "Pagamento confirmado.",
  InitiateCheckout:
    "Pedido aguardando pagamento (Pix ou boleto gerado). Cartão aprovado na hora não gera este evento: vai direto para compra aprovada.",
  CartAbandoned:
    "Carrinho abandonado no checkout. Em beta: confira as primeiras vendas antes de ligar o envio automático.",
};

export const paytBetaBadge = "beta";

export function paytEventLabel(eventName: string): string {
  return paytEventLabels[eventName] ?? ruleEventLabel(eventName);
}

/** Rótulo do evento de uma regra, conforme a origem (Payt tem rótulos próprios). */
export function ruleEventLabelForOrigin(
  origin: string,
  eventName: string,
): string {
  return origin === "automation_payt"
    ? paytEventLabel(eventName)
    : ruleEventLabel(eventName);
}

/**
 * Rótulo do evento no filtro da lista, que agrupa regras de várias origens
 * pelo mesmo nome de evento. Se todas as regras com o evento são da Payt, usa
 * o rótulo da Payt; se há mistura, mantém o genérico e avisa o da Payt.
 */
export function ruleEventFilterLabel(
  eventName: string,
  origins: ReadonlyArray<string>,
): string {
  const paytLabel = paytEventLabels[eventName];
  const generic = ruleEventLabel(eventName);
  const paytCount = origins.filter((origin) => origin === "automation_payt").length;
  if (!paytLabel || paytCount === 0 || paytLabel === generic) return generic;
  if (paytCount === origins.length) return paytLabel;
  return `${generic} (Payt: ${paytLabel})`;
}
