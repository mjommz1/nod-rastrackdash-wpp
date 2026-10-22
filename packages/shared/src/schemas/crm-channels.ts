/**
 * CRMs (Kommo, Pipedrive) are CRM-only: no WhatsApp number is connected to
 * them. Their "authorized channels" are the workspace's own production WhatsApp
 * numbers of any provider (Uazapi, Gupshup, Umbler, Data Crazy, Cloud API...).
 * An authorized entry is a number's valid route id or, when the number
 * inherits the verified workspace page/pixel, its channel id.
 *
 * Why a number cannot be authorized. Messages are customer-facing, fixed
 * strings (the web maps them exactly).
 */
export const crmChannelBindingFailures = [
  "number_not_found",
  "number_paused",
  "number_not_in_production",
  "provider_not_certified",
  "whatsapp_disconnected",
  "meta_destination_unverified",
] as const;
export type CrmChannelBindingFailure =
  (typeof crmChannelBindingFailures)[number];

export function crmChannelBindingMessagesFor(
  crmName: string,
): Record<CrmChannelBindingFailure, string> {
  return {
    number_not_found:
      "Número de WhatsApp não encontrado neste workspace. Atualize a página e selecione novamente.",
    number_paused: `Número de WhatsApp pausado. Reative o número antes de autorizá-lo no ${crmName}.`,
    number_not_in_production:
      "Este número de WhatsApp ainda não está ativado para envio de conversões.",
    provider_not_certified:
      "A integração deste número de WhatsApp ainda não está liberada para envio de conversões.",
    whatsapp_disconnected:
      "O WhatsApp deste número está desconectado. Reconecte-o antes de autorizá-lo.",
    meta_destination_unverified:
      "Este número ainda não tem destino Meta verificado (pixel e página).",
  };
}

export const kommoChannelBindingMessages =
  crmChannelBindingMessagesFor("Kommo");
