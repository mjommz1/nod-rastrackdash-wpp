import type {
  KommoEventDto,
  KommoEventResultDto,
} from "../integrations/kommo-actions";

/**
 * Plain PT-BR reading of the Kommo webhook audit. The API (KommoService#listEvents)
 * only exposes: id, dealId, pipelineId, statusId, status, errorCode,
 * errorMessage, attempts and per-rule results. There are no timestamps and no
 * counters, so none are derived here. A row existing in the audit proves the
 * webhook was received and stored; an HTTP 202 alone never does.
 */

export type AuditStageState = "yes" | "no" | "pending" | "unknown";

export type AuditStageKey =
  | "received"
  | "processed"
  | "matched"
  | "materialized"
  | "queued"
  | "confirmedSent";

export type AuditStage = {
  key: AuditStageKey;
  label: string;
  state: AuditStageState;
  note: string;
};

export type AuditTone = "neutral" | "positive" | "warning" | "danger";

export type AuditEventSummary = {
  headline: string;
  detail: string;
  tone: AuditTone;
  stages: AuditStage[];
  auditOnly: boolean;
  deliveryUnknown: boolean;
};

export const KOMMO_DELIVERY_UNKNOWN_CODE = "kommo_delivery_unknown";

// Lead could not be proven to belong to a WhatsApp conversation of this
// workspace. These events are kept for audit only; no conversion is created.
const leadNotMatchedCodes = new Set([
  "workspace_lead_not_found",
  "lead_channel_or_attribution_unproven",
  "lead_destination_unproven",
  "lead_channel_route_ambiguous",
  "lead_channel_route_unauthorized",
  "phone_missing",
  "phone_ambiguous",
  "contact_missing",
  "contact_ambiguous",
  "remote_lead_account_mismatch",
  "remote_contact_account_mismatch",
]);

const notEvaluatedCodes = new Set([
  "connection_blocked",
  "credential_generation_mismatch",
  "credential_decrypt_failed",
  "stage_unavailable_or_catalog_stale",
  "license_locked",
]);

const errorCodeLabels: Record<string, string> = {
  stage_not_configured:
    "Este estágio não tem regra ativa. Registrado só para auditoria; nada foi criado nem enviado.",
  connection_blocked:
    "A conexão está pausada ou com credencial inválida. O evento não foi avaliado.",
  credential_generation_mismatch:
    "A credencial mudou depois do recebimento. O evento não foi avaliado.",
  credential_decrypt_failed:
    "Não foi possível usar a credencial salva. O evento não foi avaliado.",
  stage_unavailable_or_catalog_stale:
    "O estágio não está no catálogo atual ou o catálogo está desatualizado. Atualize o catálogo.",
  workspace_lead_not_found:
    "Nenhum lead deste workspace corresponde ao contato da Kommo.",
  lead_channel_or_attribution_unproven:
    "Não foi possível provar o canal ou a origem do lead. Nenhum clique de anúncio (CTWA) foi presumido.",
  lead_destination_unproven:
    "Não foi possível provar o destino do lead. Nenhuma conversão foi criada.",
  lead_channel_route_ambiguous:
    "Mais de um canal possível para o lead. Registrado só para auditoria.",
  lead_channel_route_unauthorized:
    "O canal do lead não está autorizado nesta conexão. Registrado só para auditoria.",
  phone_missing: "O contato da Kommo não tem telefone. Registrado só para auditoria.",
  phone_ambiguous:
    "Mais de um telefone possível no contato. Registrado só para auditoria.",
  contact_missing:
    "O lead da Kommo não tem contato associado. Registrado só para auditoria.",
  contact_ambiguous:
    "Mais de um contato associado ao lead. Registrado só para auditoria.",
  remote_lead_account_mismatch:
    "O lead pertence a outra conta Kommo. Registrado só para auditoria.",
  remote_contact_account_mismatch:
    "O contato pertence a outra conta Kommo. Registrado só para auditoria.",
  fixed_value_not_configured:
    "A regra pede valor fixo, mas ele não está configurado. Nada foi criado.",
  event_price_missing_or_nonpositive:
    "O lead não tem preço válido para este evento. Nada foi criado.",
  event_currency_not_configured:
    "A regra não tem moeda configurada. Nada foi criado.",
  trigger_authorization_changed:
    "A autorização do gatilho mudou durante o processamento. Nada foi criado.",
  channel_authorization_changed:
    "A autorização do canal mudou durante o processamento. Nada foi criado.",
  lead_authorization_changed:
    "A autorização do lead mudou durante o processamento. Nada foi criado.",
  semantic_identity_conflict:
    "Conflito de identidade da conversão. Nada foi criado.",
  enqueue_failed:
    "O evento foi recebido, mas não conseguiu entrar na fila de processamento.",
  processing_failed:
    "O processamento falhou. Uma nova tentativa automática pode ocorrer.",
  kommo_transport: "Falha de comunicação com a Kommo ao processar o evento.",
  kommo_rate_limited: "A Kommo limitou as consultas. Nova tentativa automática.",
  kommo_unauthorized: "A Kommo recusou a credencial.",
  publication_failed: "A publicação da conversão na fila de envio falhou.",
  revoked: "A conversão foi revogada antes do envio.",
  license_locked:
    "Licença bloqueada: o processamento ficou em espera. O servidor decide quando retomar.",
  [KOMMO_DELIVERY_UNKNOWN_CODE]:
    "Resultado da entrega desconhecido. O reenvio está bloqueado e a investigação é necessária. Não afirmamos que foi enviado.",
};

export function describeAuditErrorCode(code: string | null): string | null {
  if (!code) return null;
  return errorCodeLabels[code] ?? `Código técnico: ${code}`;
}

const statusNames: Record<string, string> = {
  accepted: "Recebido, aguardando processamento",
  processing: "Em processamento",
  observed: "Observado (nada enviado)",
  duplicate: "Duplicado (nada novo enviado)",
  blocked: "Bloqueado",
  materialized: "Conversão registrada (ainda não enviada)",
  publication_pending: "Aguardando publicação na fila de envio",
  queued: "Na fila de envio (envio não confirmado)",
  sent: "Envio confirmado",
  processed: "Processado",
  failed: "Falha no processamento (nova tentativa possível)",
  dead: "Falha definitiva no processamento",
};

export function auditStatusName(status: string): string {
  return statusNames[status] ?? `Status não reconhecido (${status})`;
}

export function auditStatusTone(status: string, errorCode: string | null): AuditTone {
  if (errorCode === KOMMO_DELIVERY_UNKNOWN_CODE) return "danger";
  switch (status) {
    case "sent":
      return "positive";
    case "blocked":
    case "failed":
    case "dead":
      return "danger";
    case "queued":
    case "publication_pending":
    case "materialized":
    case "processing":
    case "accepted":
      return "warning";
    default:
      return "neutral";
  }
}

function resultCodes(event: KommoEventDto): string[] {
  return event.results.flatMap((result) =>
    result.errorCode ? [result.errorCode] : [],
  );
}

function hasLeadNotMatched(event: KommoEventDto): boolean {
  return (
    (event.errorCode !== null && leadNotMatchedCodes.has(event.errorCode)) ||
    resultCodes(event).some((code) => leadNotMatchedCodes.has(code))
  );
}

function hasNotEvaluated(event: KommoEventDto): boolean {
  return event.errorCode !== null && notEvaluatedCodes.has(event.errorCode);
}

function publicationOf(result: KommoEventResultDto): string | null {
  return result.publicationStatus;
}

function isDeliveryUnknown(event: KommoEventDto): boolean {
  return (
    event.errorCode === KOMMO_DELIVERY_UNKNOWN_CODE ||
    event.results.some(
      (result) =>
        publicationOf(result) === "delivery_unknown" ||
        result.publicationErrorCode === KOMMO_DELIVERY_UNKNOWN_CODE,
    )
  );
}

export function describeAuditResult(result: KommoEventResultDto): {
  text: string;
  tone: AuditTone;
} {
  const publication = publicationOf(result);
  if (
    publication === "delivery_unknown" ||
    result.publicationErrorCode === KOMMO_DELIVERY_UNKNOWN_CODE
  ) {
    return {
      text: "Entrega desconhecida: reenvio bloqueado. Não é possível afirmar que foi enviado.",
      tone: "danger",
    };
  }
  if (publication === "sent" || result.senderStatus === "sent") {
    return { text: "Envio confirmado ao Meta.", tone: "positive" };
  }
  if (publication === "queued") {
    return {
      text: "Conversão na fila de envio. Envio ainda não confirmado.",
      tone: "warning",
    };
  }
  if (publication === "publication_pending") {
    return {
      text: "Conversão registrada; aguardando entrar na fila de envio.",
      tone: "warning",
    };
  }
  if (publication === "publication_failed" || publication === "revoked") {
    return {
      text:
        describeAuditErrorCode(result.publicationErrorCode ?? publication) ??
        "A publicação não foi concluída.",
      tone: "danger",
    };
  }
  switch (result.status) {
    case "observed":
      return {
        text: "Regra em observação: o evento foi avaliado, mas nada foi criado nem enviado.",
        tone: "neutral",
      };
    case "blocked":
      return {
        text:
          describeAuditErrorCode(result.errorCode) ??
          "Bloqueado: nada foi criado nem enviado.",
        tone: "danger",
      };
    case "materialized":
      return {
        text: "Conversão registrada. Ainda não confirmada como enviada.",
        tone: "warning",
      };
    case "duplicate":
      return {
        text: "Esta conversão já existia. Nada novo foi criado nem enviado.",
        tone: "neutral",
      };
    default:
      return {
        text: `Resultado: ${result.status ?? "sem status"}.`,
        tone: "neutral",
      };
  }
}

const terminalProcessed = new Set([
  "observed",
  "duplicate",
  "blocked",
  "materialized",
  "publication_pending",
  "queued",
  "sent",
  "processed",
]);

export function summarizeAuditEvent(event: KommoEventDto): AuditEventSummary {
  const deliveryUnknown = isDeliveryUnknown(event);
  const processedState: AuditStageState = terminalProcessed.has(event.status)
    ? "yes"
    : event.status === "accepted" || event.status === "processing"
      ? "pending"
      : event.status === "failed" || event.status === "dead"
        ? "no"
        : "unknown";

  const resultStatuses = event.results.map((result) => result.status);
  const resultPublications = event.results.flatMap((result) => {
    const publication = publicationOf(result);
    return publication ? [publication] : [];
  });

  const anyMaterialized =
    resultStatuses.includes("materialized") ||
    resultStatuses.includes("duplicate") ||
    ["materialized", "publication_pending", "queued", "sent"].includes(
      event.status,
    );
  const anyQueued =
    resultPublications.includes("queued") ||
    resultPublications.includes("sent") ||
    event.status === "queued" ||
    event.status === "sent";
  const allSent =
    event.results.length > 0 &&
    event.results.every(
      (result) =>
        publicationOf(result) === "sent" || result.senderStatus === "sent",
    );
  const confirmedSent = !deliveryUnknown && (event.status === "sent" || allSent);

  const leadUnmatched = hasLeadNotMatched(event);
  const notEvaluated = hasNotEvaluated(event);

  let matched: AuditStageState;
  let matchedNote: string;
  if (processedState === "pending") {
    matched = "pending";
    matchedNote = "Aguardando processamento.";
  } else if (event.errorCode === "stage_not_configured") {
    matched = "no";
    matchedNote = "Nenhuma regra ativa para este estágio.";
  } else if (leadUnmatched) {
    matched = "no";
    matchedNote = "O lead não foi vinculado com segurança a uma conversa WhatsApp.";
  } else if (notEvaluated) {
    matched = "unknown";
    matchedNote = "O evento não chegou a ser avaliado.";
  } else if (event.results.length > 0) {
    matched = "yes";
    matchedNote = "Estágio com regra ativa e lead vinculado.";
  } else {
    matched = "unknown";
    matchedNote = "A API não informa o vínculo neste registro.";
  }

  const productionExpected = anyMaterialized || resultPublications.length > 0;

  const stages: AuditStage[] = [
    {
      key: "received",
      label: "Webhook recebido",
      state: "yes",
      note: "O evento está registrado na auditoria.",
    },
    {
      key: "processed",
      label: "Processado",
      state: processedState,
      note:
        processedState === "yes"
          ? "O processamento terminou."
          : processedState === "pending"
            ? "Ainda não terminou."
            : processedState === "no"
              ? "O processamento falhou."
              : "Estado de processamento desconhecido.",
    },
    {
      key: "matched",
      label: "Regra e lead encontrados",
      state: matched,
      note: matchedNote,
    },
    {
      key: "materialized",
      label: "Conversão registrada",
      state: anyMaterialized
        ? "yes"
        : processedState === "pending"
          ? "pending"
          : "no",
      note: anyMaterialized
        ? "Existe uma conversão registrada para este evento."
        : "Nenhuma conversão registrada (observação, bloqueio ou sem regra).",
    },
    {
      key: "queued",
      label: "Na fila de envio",
      state: anyQueued
        ? "yes"
        : resultPublications.includes("publication_pending")
          ? "pending"
          : "no",
      note: anyQueued
        ? "A conversão entrou na fila de envio."
        : "Não está na fila de envio.",
    },
    {
      key: "confirmedSent",
      label: "Envio confirmado",
      state: deliveryUnknown
        ? "unknown"
        : confirmedSent
          ? "yes"
          : productionExpected
            ? "pending"
            : "no",
      note: deliveryUnknown
        ? "Entrega desconhecida: não afirmamos que foi enviado."
        : confirmedSent
          ? "O envio foi confirmado."
          : productionExpected
            ? "Envio ainda não confirmado."
            : "Nada foi enviado.",
    },
  ];

  const base = describeAuditErrorCode(event.errorCode);
  let detail: string;
  if (deliveryUnknown) {
    detail = errorCodeLabels[KOMMO_DELIVERY_UNKNOWN_CODE];
  } else if (base) {
    detail = base;
  } else if (event.status === "observed") {
    detail =
      "Regra em observação: o evento foi avaliado, mas nada foi criado nem enviado.";
  } else if (confirmedSent) {
    detail = "A conversão foi enviada e o envio está confirmado.";
  } else if (event.status === "queued") {
    detail = "Conversão na fila de envio. Envio ainda não confirmado.";
  } else if (event.status === "publication_pending") {
    detail = "Conversão registrada; aguardando entrar na fila de envio.";
  } else if (event.status === "materialized") {
    detail = "Conversão registrada. Ainda não confirmada como enviada.";
  } else if (event.status === "duplicate") {
    detail = "A conversão já existia. Nada novo foi criado nem enviado.";
  } else if (event.status === "accepted" || event.status === "processing") {
    detail = "Webhook recebido e registrado; o processamento ainda não terminou.";
  } else {
    detail = auditStatusName(event.status);
  }

  return {
    headline: deliveryUnknown
      ? "Entrega desconhecida (reenvio bloqueado)"
      : auditStatusName(event.status),
    detail,
    tone: auditStatusTone(event.status, deliveryUnknown ? KOMMO_DELIVERY_UNKNOWN_CODE : event.errorCode),
    stages,
    auditOnly: leadUnmatched || event.errorCode === "stage_not_configured",
    deliveryUnknown,
  };
}

export const auditStateLabels: Record<AuditStageState, string> = {
  yes: "Sim",
  no: "Não",
  pending: "Pendente",
  unknown: "Desconhecido",
};
