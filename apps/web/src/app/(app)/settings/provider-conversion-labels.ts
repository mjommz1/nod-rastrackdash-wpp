import type { PurchaseReviewDto } from "@wpptrack/shared";

export function purchaseReviewStatusLabel(
  status: PurchaseReviewDto["status"],
): string {
  const labels = {
    recognized: "Reconhecida",
    awaiting_data: "Aguardando dados",
    review_required: "Revisao necessaria",
    approved: "Na fila",
    sent: "Enviada",
    duplicate: "Duplicada",
    rejected: "Rejeitada",
    failed: "Falhou",
    corrected_after_send: "Corrigida no painel",
  } satisfies Record<PurchaseReviewDto["status"], string>;

  return labels[status];
}

export function purchaseReviewTone(
  status: PurchaseReviewDto["status"],
): "" | "warn" | "bad" | "neutral" {
  if (status === "sent" || status === "recognized") return "";
  if (status === "failed" || status === "rejected") return "bad";
  if (["awaiting_data", "review_required", "approved"].includes(status)) {
    return "warn";
  }
  return "neutral";
}

export function purchaseReviewReasonLabel(reasonCode: string | null): string {
  if (!reasonCode) return "Pronta para revisao";

  const labels: Record<string, string> = {
    awaiting_complete_purchase_data: "Mensagem sem dados completos",
    catalog_combination_not_found: "Combinacao fora do catalogo",
    catalog_message_ambiguous: "Mensagem com combinacao ambigua",
    provider_conversion_paid_lead_missing: "Lead pago nao localizado",
    provider_conversion_route_missing: "Rota Meta nao localizada",
    provider_conversion_value_missing: "Valor da compra nao localizado",
    provider_conversion_production_context_invalid:
      "Contexto de producao incompleto",
  };

  return labels[reasonCode] ?? executionReasonLabel(reasonCode);
}

export function executionReasonLabel(reasonCode: string | null): string {
  if (!reasonCode) return "Processado";

  const labels: Record<string, string> = {
    catalog_matched: "Catalogo reconhecido",
    catalog_matched_observation: "Reconhecido em observacao",
    message_matched: "Mensagem reconhecida",
    message_matched_observation: "Reconhecido em observacao",
    automation_matched: "Automacao reconhecida",
    automation_matched_observation: "Reconhecido em observacao",
    automation_manual_reprocess_approved: "Reprocessamento autorizado",
    automation_event_mismatch: "Evento diferente da regra",
    automation_channel_unresolved: "Canal nao localizado",
    automation_paid_lead_missing: "Lead pago nao localizado",
    automation_value_missing: "Valor medio nao configurado",
    before_production_activation: "Historico preservado",
    production_context_invalid: "Configuracao incompleta",
    rule_production_not_activated: "Regra ainda sem envio ativo",
    rule_parser_not_certified: "Parser da regra nao certificado",
    connection_parser_not_certified: "Parser da conexao nao certificado",
    parser_release_mismatch: "Parser da regra difere da conexao",
    connection_removed: "Conexao removida",
    connection_not_production: "Conexao ainda nao esta em producao",
    channel_unresolved: "Canal nao localizado",
    channel_not_active: "Canal ainda nao esta ativo",
    purchase_within_24h: "Compra repetida em menos de 24h",
    provider_conversion_paid_lead_missing: "Lead pago nao localizado",
    provider_conversion_catalog_mismatch: "Mensagem divergiu do catalogo",
    provider_conversion_payload_unavailable: "Payload nao esta mais disponivel",
    provider_conversion_source_event_mismatch: "Mensagem de origem invalida",
    provider_conversion_value_missing: "Valor medio nao configurado",
    provider_conversion_production_context_invalid:
      "Contexto de producao incompleto",
    provider_conversion_production_disabled: "Envio de conversoes desativado",
    provider_conversion_execution_not_found: "Execucao nao localizada",
    provider_conversion_identity_missing: "Identidade do lead incompleta",
    provider_conversion_execution_state_changed:
      "Estado da execucao foi alterado",
    provider_conversion_production_unexpected:
      "Falha interna ao criar o evento Meta",
    queue_recovery_pending: "Aguardando recuperacao da fila",
    qualified_lead_already_materialized: "Lead ja qualificado anteriormente",
    // Venda da Payt (Fase 4a).
    purchase_duplicate: "Venda repetida: recibo registrado, nada novo enviado",
    rule_in_observation: "Regra em observação: nada é enviado à Meta",
    payt_purchase_identity_missing:
      "Venda sem vendedor ou pedido identificados",
    payt_currency_unsupported:
      "Venda em moeda fora de BRL, USD ou EUR: nada enviado à Meta",
    provider_purchase_identity_missing:
      "Venda sem vendedor ou pedido identificados",
    payt_channel_missing_or_ambiguous:
      "Número da venda não identificado ou ambíguo",
    provider_purchase_channel_missing_or_ambiguous:
      "Número da venda não identificado ou ambíguo",
    payt_lead_other_channel:
      "Lead de outro número: a regra desse número envia a venda",
    automation_matched_payt_observation: "Reconhecido em observação",
    payt_automation_v1_not_purchase: "Status da Payt não gera conversão",
    payt_automation_v1_event_not_in_rule: "Evento da Payt fora desta regra",
    // Unnichat (Fase 4b).
    ctwa_missing: "Sem clique do anúncio (ctwa_clid): nada é enviado à Meta",
    ctwa_ad_unavailable:
      "Conversa sem anúncio de origem identificado e sem destino único de página e pixel",
    route_ad_missing:
      "Conversa sem anúncio de origem identificado e sem destino único de página e pixel",
    ctwa_destination_ambiguous:
      "Mais de um par de página e pixel possível: nada foi enviado",
    ctwa_destination_not_authorized:
      "Página e pixel deste número não estão autorizados",
    unnichat_v1_invalid_payload:
      "Corpo do webhook do Unnichat inválido ou incompleto",
    unnichat_automation_v1_invalid_payload:
      "Corpo da automação do Unnichat inválido ou incompleto",
    unnichat_original_bind_mismatch:
      "O contato não confere com a conversa original do anúncio",
    inbound_webhook_production_unnichat_bind_mismatch:
      "O contato não confere com a conversa original do anúncio",
    inbound_webhook_unnichat_channel_binding_missing:
      "A conexão do Unnichat está sem o número do cliente: recrie a conexão informando o número",
  };

  if (reasonCode.startsWith("provider_conversion_route_")) {
    return "Rota Meta indisponivel";
  }

  if (labels[reasonCode]) {
    return labels[reasonCode];
  }

  if (reasonCode.startsWith("inbound_webhook_production_unnichat_")) {
    return "Envio do Unnichat recusado: o contato não confere com a conversa do anúncio";
  }

  return catalogReasonLabel(reasonCode);
}

function catalogReasonLabel(reasonCode: string): string {
  const labels: Record<string, string> = {
    matched: "Conversao reconhecida",
    rule_inactive: "Regra pausada",
    catalog_inactive: "Catalogo pausado",
    missing_attribute: "Atributo ausente",
    ambiguous_attribute: "Atributo ambiguo",
    unknown_combination: "Combinacao nao cadastrada",
    ambiguous_variant: "Variante ambigua",
    missing_price: "Valor ausente",
    ambiguous_price: "Mais de um valor encontrado",
    price_mismatch: "Valor diferente do catalogo",
    trigger_missing: "Frase gatilho ausente",
    empty_template: "Template sem dados ignorado",
    awaiting_data: "Aguardando dados completos",
    incomplete_item: "Produto incompleto",
    invalid_quantity: "Quantidade invalida",
  };

  return labels[reasonCode] ?? "Requer revisao";
}
