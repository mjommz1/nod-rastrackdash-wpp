import type {
  ConversionEventNameDto,
  IntegrationDetectedProductDto,
  IntegrationEndpointDto,
  IntegrationEndpointProviderDto,
  IntegrationLegacyUrlDto,
} from "@wpptrack/shared";
import {
  formatMoney,
  integrationEndpointSupportedEvents,
} from "@wpptrack/shared";
import {
  paytEventExplanations,
  paytEventLabels,
  ruleEventLabel,
} from "../../conversions/event-copy";

/**
 * Textos e decisões puras da Fase 5.3 (URL única da Payt e URLs por evento do
 * Unnichat e da Umbler). Sem React: testados direto. Linguagem do aluno, sem
 * jargão técnico.
 */

export const singleUrlPlatformNames: Record<
  IntegrationEndpointProviderDto,
  string
> = {
  payt: "Payt",
  unnichat: "Unnichat",
  umbler: "Umbler Talk",
};

/** "na Payt", "no Unnichat", "na Umbler Talk". */
export const singleUrlPlatformLocatives: Record<
  IntegrationEndpointProviderDto,
  string
> = {
  payt: "na Payt",
  unnichat: "no Unnichat",
  umbler: "na Umbler Talk",
};

/** "a Payt", "o Unnichat", "a Umbler Talk" (sujeito de uma frase). */
export const singleUrlPlatformSubjects: Record<
  IntegrationEndpointProviderDto,
  string
> = {
  payt: "a Payt",
  unnichat: "o Unnichat",
  umbler: "a Umbler Talk",
};

/**
 * Aviso dos controles de escrita quando a licença está bloqueada. É o mesmo
 * texto de `licenseLockedActionMessage` (lib/license-locked-message.ts); fica
 * aqui porque aquele arquivo importa o server-api, que não vai para o cliente.
 */
export const singleUrlLicenseLockedNote =
  "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.";

export const singleUrlForbiddenMessage =
  "Você não tem permissão para gerenciar integrações.";

export const singleUrlUnavailableMessage =
  "Não deu para concluir agora. Tente de novo em alguns instantes.";

/** Quem só lê vê contadores e datas, nunca a URL com a chave. */
export const singleUrlReadOnlyNote =
  "Só quem gerencia integrações gera, vê, gira ou remove a URL.";

/** A revelação é auditada: o texto deixa isso claro antes do clique. */
export const singleUrlRevealNote =
  "Por segurança, a URL com a chave só aparece quando você pede. Cada vez que você mostra a URL, o sistema registra quem viu e quando.";

export function isSalesPlatform(
  provider: IntegrationEndpointProviderDto,
): boolean {
  return provider === "payt";
}

/** Rótulo de um evento (Payt tem rótulos próprios de venda). */
export function eventLabel(
  eventName: string | null,
  provider: IntegrationEndpointProviderDto | null = null,
): string {
  if (!eventName) return "Evento da venda";
  if (provider === "payt" && paytEventLabels[eventName]) {
    return paytEventLabels[eventName];
  }
  return ruleEventLabel(eventName);
}

export { paytEventExplanations };

export function supportedEvents(
  provider: IntegrationEndpointProviderDto,
): ConversionEventNameDto[] {
  return [
    ...integrationEndpointSupportedEvents(provider),
  ] as ConversionEventNameDto[];
}

export const paytProductCodeGuidance =
  "Na Payt, o código do produto aparece em Produtos, ao abrir o produto (ex.: 4O9J39). O código da oferta é o final do link de checkout (payt.site/CÓDIGO).";

export const unseenProductCodeWarning =
  "Código ainda não visto em nenhuma venda. Confira se está igual ao da Payt.";

/** Passo a passo para colar a URL na plataforma. */
export function singleUrlSetupSteps(
  provider: IntegrationEndpointProviderDto,
  eventName: string | null = null,
): string[] {
  switch (provider) {
    case "payt":
      return [
        "Na Payt, abra Postback (webhook de vendas).",
        "Cole esta URL única. Ela vale para todos os seus números e produtos.",
        "Marque os avisos de venda aprovada, aguardando pagamento e carrinho abandonado.",
        "Cada venda vai para a regra do número por onde o comprador chegou. Sem regra, ela aparece em “Vendas sem atribuição”.",
      ];
    case "unnichat":
      return [
        `No Unnichat, abra o fluxo e a etapa que marca “${eventLabel(eventName)}”.`,
        "Adicione uma chamada HTTP (POST, corpo JSON) e cole esta URL.",
        "Use a mesma URL em todos os números: o sistema descobre o número pelo clique do anúncio (ctwa_clid) da conversa.",
      ];
    case "umbler":
      return [
        `Na Umbler Talk, abra a automação que marca “${eventLabel(eventName)}”.`,
        "Adicione uma ação HTTP (POST) e cole esta URL.",
        "Inclua no corpo o número do canal que atendeu (channel.phone): é assim que a URL acha a regra quando há mais de um número.",
      ];
  }
}

/** Se um código digitado à mão já apareceu em alguma venda recebida. */
export function productCodeSeen(
  code: string,
  products: readonly IntegrationDetectedProductDto[],
): boolean {
  const wanted = code.trim().toLocaleUpperCase("en-US");
  if (!wanted) return true;
  return products.some(
    (product) =>
      product.productCode?.toLocaleUpperCase("en-US") === wanted ||
      product.offerCode?.toLocaleUpperCase("en-US") === wanted,
  );
}

/** Normaliza o código digitado; null quando não é um código válido. */
export function normalizeManualProductCode(value: string): string | null {
  const code = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(code)
    ? code.toLocaleUpperCase("en-US")
    : null;
}

/** Opções do filtro: um item por código distinto de produto ou oferta. */
export function productFilterOptions(
  products: readonly IntegrationDetectedProductDto[],
): Array<{ code: string; label: string; kind: "Produto" | "Oferta" }> {
  const options = products.flatMap((product) => [
    ...(product.productCode
      ? [
          {
            code: product.productCode.toLocaleUpperCase("en-US"),
            label: product.productName ?? "Produto",
            kind: "Produto" as const,
          },
        ]
      : []),
    ...(product.offerCode
      ? [
          {
            code: product.offerCode.toLocaleUpperCase("en-US"),
            label: product.offerName ?? "Oferta",
            kind: "Oferta" as const,
          },
        ]
      : []),
  ]);
  return [...new Map(options.map((option) => [option.code, option])).values()];
}

export function findEventEndpoint(
  endpoints: readonly IntegrationEndpointDto[],
  provider: IntegrationEndpointProviderDto,
  eventName: string | null,
): IntegrationEndpointDto | null {
  return (
    endpoints.find(
      (endpoint) =>
        endpoint.provider === provider &&
        (isSalesPlatform(provider) || endpoint.eventName === eventName),
    ) ?? null
  );
}

/**
 * Junta a lista do servidor (sempre sem URL) com o que a tela acabou de criar
 * (com URL): os dados do servidor valem, e a URL recém-gerada continua à vista
 * depois que a página é atualizada. `removedIds` esconde o que foi removido.
 */
export function mergeEndpoints(
  fromServer: readonly IntegrationEndpointDto[],
  created: readonly IntegrationEndpointDto[],
  removedIds: readonly string[] = [],
): IntegrationEndpointDto[] {
  const byId = new Map(fromServer.map((endpoint) => [endpoint.id, endpoint]));
  for (const endpoint of created) {
    const server = byId.get(endpoint.id);
    byId.set(
      endpoint.id,
      server ? { ...server, url: server.url ?? endpoint.url } : endpoint,
    );
  }
  return [...byId.values()].filter(
    (endpoint) => !removedIds.includes(endpoint.id),
  );
}

export function legacyUrlsFor(
  legacyUrls: readonly IntegrationLegacyUrlDto[],
  provider: IntegrationEndpointProviderDto,
): IntegrationLegacyUrlDto[] {
  return legacyUrls.filter((legacy) => legacy.provider === provider);
}

export function legacyUrlState(legacy: {
  publicUrlDisabledAt: string | null;
  lastDeliveryAt: string | null;
}): { label: string; tone: "ok" | "warn" | "neutral" } {
  if (legacy.publicUrlDisabledAt) {
    return { label: "URL antiga desativada", tone: "neutral" };
  }
  return legacy.lastDeliveryAt
    ? { label: "URL antiga ainda recebe", tone: "warn" }
    : { label: "URL antiga ativa (sem recebimentos)", tone: "neutral" };
}

/** Texto da confirmação de "Desativar URL antiga". */
export function disableLegacyUrlConfirmText(
  provider: IntegrationEndpointProviderDto,
): string {
  const sales = isSalesPlatform(provider);
  return `A URL antiga deixa de aceitar: o que ${singleUrlPlatformSubjects[provider]} ainda enviar por ela é recusado. Confirme que você já colou a URL ${sales ? "única" : "do evento"} ${singleUrlPlatformLocatives[provider]} e viu ${sales ? "as vendas" : "os eventos"} chegando por ela. Dá para reativar depois.`;
}

export const rotateConfirmText = (
  provider: IntegrationEndpointProviderDto,
): string =>
  `A URL atual para de funcionar na hora. Depois, cole a nova ${singleUrlPlatformLocatives[provider]}: até lá, nada é recebido por ela.`;

export const removeConfirmText = (
  provider: IntegrationEndpointProviderDto,
): string =>
  `A URL é apagada e deixa de funcionar na hora: o que ${singleUrlPlatformSubjects[provider]} enviar para ela recebe resposta de endereço inexistente. As regras e o histórico continuam. Para voltar a receber, gere uma URL nova e cole de novo.`;

/** Contadores de um endereço em uma frase curta. */
export function statsSummary(stats: IntegrationEndpointDto["stats"]): string {
  return `${stats.received} ${stats.received === 1 ? "recebido" : "recebidos"}: ${stats.routed} com regra, ${stats.unattributed} sem atribuição, ${stats.ignored} ${stats.ignored === 1 ? "ignorado" : "ignorados"}, ${stats.invalid} ${stats.invalid === 1 ? "inválido" : "inválidos"}`;
}

export function formatWhen(value: string | null): string {
  if (!value) return "nunca";
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  });
}

export function formatCents(
  valueCents: number | null,
  currency: string | null,
): string {
  if (valueCents === null) return "—";
  // Moeda da venda; legado sem moeda = BRL.
  return formatMoney(valueCents, currency);
}
