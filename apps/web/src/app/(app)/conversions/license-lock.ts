/**
 * Aviso mostrado nos controles de escrita quando a licença está bloqueada.
 * Fica fora de lib/license-locked-message.ts porque este arquivo é usado em
 * componentes de cliente (aquele importa server-api, que lê cookies).
 */
export const conversionsLicenseLockedNote =
  "Licença bloqueada: criar, editar, pausar, unificar e excluir regras está indisponível. Verifique /backoffice/license.";
