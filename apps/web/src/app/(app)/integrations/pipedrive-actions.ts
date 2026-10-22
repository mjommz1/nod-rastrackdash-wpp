"use server";

import {
  PIPEDRIVE_CONNECTION_NOT_FOUND_MESSAGE,
  pipedriveChannelBindingMessages,
  pipedriveConnectionChannelBindingsInputSchema,
  pipedriveConnectionCreateInputSchema,
  pipedriveConnectionCredentialReplaceInputSchema,
  pipedriveConnectionSchema,
  pipedriveConnectionStatusUpdateInputSchema,
  pipedriveConversionRuleCreateInputSchema,
  pipedriveConversionRuleSchema,
  pipedriveConversionRuleUpdateInputSchema,
  pipedrivePipelineSchema,
  type ConversionEventNameDto,
  type PipedriveConnectionDto,
  type PipedriveConversionRuleCreateInputDto,
  type PipedriveConversionRuleUpdateInputDto,
  type PipedriveRuleTriggerDto,
  type pipedriveRuleModes,
  type pipedriveValueModes,
} from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import { licenseLockedActionMessage } from "../../../lib/license-locked-message";
import {
  isApiRequestError,
  isLicenseLockedError,
  serverApiFetch,
} from "../../../lib/server-api";

/**
 * apps/web does not depend on zod directly, so the aggregate the panel needs
 * (connection + pipelines/stages + rules) is assembled by hand from the three
 * separate Pipedrive reads (GET :id, GET :id/rules) and validated by reusing
 * the shared schemas' own `.safeParse` for every nested part.
 */
type PipedriveRuleMode = (typeof pipedriveRuleModes)[number];
type PipedriveValueMode = (typeof pipedriveValueModes)[number];

export type PipedriveConversionRuleDto = {
  id: string;
  connectionId: string;
  name: string;
  /** stage_change: stageId set; deal_won: stageId null, always Purchase. */
  trigger: PipedriveRuleTriggerDto;
  pipelineId: string;
  stageId: string | null;
  eventName: ConversionEventNameDto;
  mode: PipedriveRuleMode;
  productionActivatedAt: string | null;
  valueMode: PipedriveValueMode;
  fixedValueCents: number | null;
  currency: string | null;
  contentName: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PipedriveStageDto = { id: string; name: string; sort: number | null };
export type PipedrivePipelineDto = {
  id: string;
  name: string;
  sort: number | null;
  stages: PipedriveStageDto[];
};

/** What every connection-level mutation returns: connection + catalog, no rules. */
export type PipedriveConnectionSnapshotDto = PipedriveConnectionDto & {
  pipelines: PipedrivePipelineDto[];
};

/**
 * The panel's canonical aggregate: snapshot + the separately fetched rules.
 * `revisionFenced` is true only when the snapshot revision was identical
 * before and after the rules read. It is never an atomicity promise.
 */
export type PipedriveConnectionDetailDto = PipedriveConnectionSnapshotDto & {
  rules: PipedriveConversionRuleDto[];
  revisionFenced?: boolean;
};

const deliveryStatuses = [
  "publication_pending",
  "queued",
  "sent",
  "revoked",
  "publication_failed",
  "delivery_unknown",
  "materialized",
] as const;
export type PipedriveDeliveryStatus =
  | (typeof deliveryStatuses)[number]
  | "unrecognized";

export type PipedriveCapabilitiesDto = {
  productionEnabled: boolean;
  activationRequirements: string[];
  historicalReplay: boolean;
  unknownDeliveryRetry: boolean;
};

export type PipedriveOneTimeWebhook = {
  webhookUrl: string;
  version: number;
  rotatedAt: string;
};

export type PipedriveEventResultDto = {
  ruleId: string;
  eventName: ConversionEventNameDto;
  status: "observed" | "materialized" | "duplicate" | "ignored";
  valueCents: number | null;
  currency: string | null;
  errorCode: string | null;
  conversionEventLogId: string | null;
  deliveryStatus: PipedriveDeliveryStatus | null;
  deliveryErrorCode: string | null;
  /** The backend always reports false; the UI never offers a delivery resend. */
  deliveryRetryable: boolean;
};

export type PipedriveEventDto = {
  id: string;
  status: string;
  errorCode: string | null;
  attempts: number;
  occurredAt: string;
  createdAt: string;
  nextAttemptAt: string | null;
  results: PipedriveEventResultDto[];
};

export type PipedriveAuthFailureReason = "unauthorized";

export type PipedriveActionResult = {
  ok: boolean;
  message: string;
  authFailure?: PipedriveAuthFailureReason;
  /** HTTP 423: refused by the license guard before any write ran. */
  licenseLocked?: boolean;
  outcomeUnknown?: boolean;
  connection?: PipedriveConnectionSnapshotDto;
  oneTimeWebhook?: PipedriveOneTimeWebhook;
  revoked?: boolean;
  deleted?: boolean;
};

export type PipedriveRuleActionResult = {
  ok: boolean;
  message: string;
  authFailure?: PipedriveAuthFailureReason;
  licenseLocked?: boolean;
  outcomeUnknown?: boolean;
  rule?: PipedriveConversionRuleDto;
};

export type PipedriveEventRetryResult = {
  ok: boolean;
  message: string;
  authFailure?: PipedriveAuthFailureReason;
  licenseLocked?: boolean;
  outcomeUnknown?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePipelines(value: unknown): PipedrivePipelineDto[] | null {
  if (!Array.isArray(value)) return null;
  const rows: PipedrivePipelineDto[] = [];
  for (const entry of value) {
    const parsed = pipedrivePipelineSchema.safeParse(entry);
    if (!parsed.success) return null;
    rows.push(parsed.data);
  }
  return rows;
}

function parseRule(value: unknown): PipedriveConversionRuleDto | null {
  const parsed = pipedriveConversionRuleSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    productionActivatedAt: parsed.data.productionActivatedAt ?? null,
  };
}

function parseRules(value: unknown): PipedriveConversionRuleDto[] | null {
  if (!Array.isArray(value)) return null;
  const rows: PipedriveConversionRuleDto[] = [];
  for (const entry of value) {
    const rule = parseRule(entry);
    if (!rule) return null;
    rows.push(rule);
  }
  return rows;
}

function parseSnapshot(value: unknown): PipedriveConnectionSnapshotDto | null {
  if (!isRecord(value)) return null;
  const base = pipedriveConnectionSchema.safeParse(value);
  if (!base.success) return null;
  const pipelines = parsePipelines(value.pipelines);
  if (!pipelines) return null;
  return { ...base.data, pipelines };
}

/** Strict on purpose: one malformed entry fails the whole list. */
function parseConnectionListStrict(value: unknown): PipedriveConnectionDto[] | null {
  if (!Array.isArray(value)) return null;
  const rows: PipedriveConnectionDto[] = [];
  for (const entry of value) {
    const parsed = pipedriveConnectionSchema.safeParse(entry);
    if (!parsed.success) return null;
    rows.push(parsed.data);
  }
  return rows;
}

function parseRotateResult(value: unknown): PipedriveOneTimeWebhook | null {
  if (
    !isRecord(value) ||
    typeof value.webhookUrl !== "string" ||
    !value.webhookUrl ||
    typeof value.version !== "number" ||
    !Number.isInteger(value.version) ||
    typeof value.rotatedAt !== "string" ||
    Number.isNaN(Date.parse(value.rotatedAt))
  ) {
    return null;
  }
  return {
    webhookUrl: value.webhookUrl,
    version: value.version,
    rotatedAt: value.rotatedAt,
  };
}

const eventStatusPattern = /^[a-z_]{1,32}$/;
const errorCodePattern = /^[a-z0-9_]{1,64}$/;

const conversionIdPattern = /^[A-Za-z0-9_-]{1,255}$/;

function parseDeliveryStatus(value: unknown): PipedriveDeliveryStatus | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  return (deliveryStatuses as readonly string[]).includes(value)
    ? (value as PipedriveDeliveryStatus)
    : "unrecognized";
}

function parseEventResult(value: unknown): PipedriveEventResultDto | null {
  if (!isRecord(value)) return null;
  const deliveryStatus = parseDeliveryStatus(value.deliveryStatus);
  if (
    deliveryStatus === undefined ||
    !(
      value.conversionEventLogId === null ||
      value.conversionEventLogId === undefined ||
      (typeof value.conversionEventLogId === "string" &&
        conversionIdPattern.test(value.conversionEventLogId))
    ) ||
    !(
      value.deliveryErrorCode === null ||
      value.deliveryErrorCode === undefined ||
      (typeof value.deliveryErrorCode === "string" &&
        errorCodePattern.test(value.deliveryErrorCode))
    ) ||
    !(
      value.deliveryRetryable === undefined ||
      typeof value.deliveryRetryable === "boolean"
    )
  ) {
    return null;
  }
  if (
    typeof value.ruleId !== "string" ||
    !value.ruleId ||
    (value.status !== "observed" &&
      value.status !== "materialized" &&
      value.status !== "duplicate" &&
      value.status !== "ignored") ||
    !(value.valueCents === null || value.valueCents === undefined || Number.isFinite(Number(value.valueCents))) ||
    !(value.currency === null || value.currency === undefined || (typeof value.currency === "string" && /^[A-Za-z]{3}$/.test(value.currency))) ||
    !(value.errorCode === null || value.errorCode === undefined || (typeof value.errorCode === "string" && errorCodePattern.test(value.errorCode)))
  ) {
    return null;
  }
  const rule = pipedriveConversionRuleSchema.shape.eventName.safeParse(value.eventName);
  if (!rule.success) return null;
  return {
    ruleId: value.ruleId,
    eventName: rule.data,
    status: value.status,
    valueCents: value.valueCents == null ? null : Number(value.valueCents),
    currency: typeof value.currency === "string" ? value.currency.toUpperCase() : null,
    errorCode: typeof value.errorCode === "string" ? value.errorCode : null,
    conversionEventLogId:
      typeof value.conversionEventLogId === "string" ? value.conversionEventLogId : null,
    deliveryStatus,
    deliveryErrorCode:
      typeof value.deliveryErrorCode === "string" ? value.deliveryErrorCode : null,
    // Delivery is never retryable from the UI, whatever the payload says.
    deliveryRetryable: false,
  };
}

function parseEvents(value: unknown): PipedriveEventDto[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const rows: PipedriveEventDto[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const results: PipedriveEventResultDto[] = [];
    if (!Array.isArray(entry.results) || entry.results.length > 100) return null;
    for (const item of entry.results) {
      const result = parseEventResult(item);
      if (!result) return null;
      results.push(result);
    }
    if (
      typeof entry.id !== "string" ||
      !entry.id ||
      typeof entry.status !== "string" ||
      !eventStatusPattern.test(entry.status) ||
      !(entry.errorCode === null || (typeof entry.errorCode === "string" && errorCodePattern.test(entry.errorCode))) ||
      typeof entry.attempts !== "number" ||
      !Number.isInteger(entry.attempts) ||
      typeof entry.occurredAt !== "string" ||
      Number.isNaN(Date.parse(entry.occurredAt)) ||
      typeof entry.createdAt !== "string" ||
      Number.isNaN(Date.parse(entry.createdAt)) ||
      !(entry.nextAttemptAt === null || (typeof entry.nextAttemptAt === "string" && !Number.isNaN(Date.parse(entry.nextAttemptAt))))
    ) {
      return null;
    }
    rows.push({
      id: entry.id,
      status: entry.status,
      errorCode: entry.errorCode as string | null,
      attempts: entry.attempts,
      occurredAt: entry.occurredAt,
      createdAt: entry.createdAt,
      nextAttemptAt: entry.nextAttemptAt as string | null,
      results,
    });
  }
  return rows;
}

const settingsPath = "/settings";

/** CRMs are managed in the Integrations hub; Settings still lists their rules. */
function revalidateCrmPaths(): void {
  revalidatePath(settingsPath);
  revalidatePath("/integrations");
}
const licenseLockedMessage = licenseLockedActionMessage;
const invalidFormMessage = "Revise os dados informados e tente novamente.";
const sessionExpiredMessage =
  "Sua sessão expirou ou não tem permissão para esta ação. Atualize a página e tente novamente.";

/**
 * Only exact, locally controlled API messages/codes map to localized copy.
 * Anything else — including provider or database text — never crosses this
 * boundary; callers get the fallback instead.
 */
const knownApiMessages: Record<string, string> = {
  // Specific, customer-facing reasons a WhatsApp number cannot be authorized.
  ...Object.fromEntries(
    Object.values(pipedriveChannelBindingMessages).map((message) => [
      message,
      message,
    ]),
  ),
  "Canal ou rota indisponível":
    "Canal ou rota indisponível. Revise os canais autorizados e tente novamente.",
  "Credencial Pipedrive requer verificação":
    "A credencial desta conexão precisa ser verificada. Substitua o token antes de retomar.",
  "Conexão alterada; tente novamente":
    "A conexão foi alterada por outra ação. Confirme o estado atual e tente novamente.",
  "Payload inválido": "Revise os dados informados e tente novamente.",
  "Conta Pipedrive já conectada neste workspace":
    "Esta conta Pipedrive já está conectada neste workspace. Gerencie a conexão existente.",
  "Conexão com eventos auditados não pode ser removida; pause-a":
    "Esta conexão já tem eventos auditados e não pode ser removida. Pause-a.",
  "Evento não pode ser reprocessado":
    "Este evento não pode ser reprocessado (só falhas transitórias com a mesma credencial).",
  "Catálogo Pipedrive requer atualização":
    "O catálogo está desatualizado. Atualize o catálogo antes de salvar a regra.",
  "Etapa Pipedrive indisponível":
    "Etapa indisponível no catálogo atual. Atualize o catálogo e escolha outra.",
  "Funil Pipedrive indisponível":
    "Funil indisponível no catálogo atual. Atualize o catálogo e escolha outro.",
  "Regra ou evento Pipedrive já existe":
    "Já existe uma regra equivalente (no máximo uma regra de negócio ganho por funil).",
  [PIPEDRIVE_CONNECTION_NOT_FOUND_MESSAGE]:
    "Conexão não encontrada. Atualize a página.",
  "Regra Pipedrive não encontrada": "Regra não encontrada. Atualize a página.",
  "Evento Pipedrive não encontrado": "Evento não encontrado. Atualize a lista.",
  pipedrive_unauthorized:
    "O Pipedrive recusou a credencial. Substitua o token da conexão.",
  pipedrive_rate_limited:
    "O Pipedrive limitou as requisições. Aguarde alguns minutos e tente novamente.",
  pipedrive_transport:
    "Não foi possível contatar o Pipedrive. Tente novamente em instantes.",
  pipedrive_invalid_response:
    "O Pipedrive retornou uma resposta inesperada. Tente novamente mais tarde.",
  pipedrive_account_mismatch:
    "O token pertence a outra conta Pipedrive. A conexão foi bloqueada; substitua a credencial pela correta.",
  pipedrive_persistence_failed:
    "O servidor não conseguiu salvar a alteração. Confirme o estado atual antes de repetir.",
  pipedrive_encryption_key_invalid:
    "A chave de criptografia das credenciais Pipedrive não está configurada no servidor. Acione o operador do ambiente.",
  credential_decrypt_failed:
    "A credencial salva não pode ser lida. Substitua o token da conexão.",
  pipedrive_public_url_invalid:
    "A URL pública da API não está configurada no servidor (API_PUBLIC_URL). Acione o operador do ambiente.",
  pipedrive_production_disabled:
    "O envio automático está desativado nesta instalação; a regra não foi ativada.",
  pipedrive_production_context_invalid:
    "A conexão ainda não atende os requisitos do envio automático (ativa, credencial válida, webhook configurado e canais autorizados válidos). Revise e tente novamente.",
};

/** Failures raised before any write happened, so no outcome is unknown. */
const definitiveServerFailures = new Set([
  "pipedrive_public_url_invalid",
  "pipedrive_encryption_key_invalid",
]);

function describeMutationError(
  error: unknown,
  fallback: string,
): {
  message: string;
  authFailure?: PipedriveAuthFailureReason;
  licenseLocked?: boolean;
  outcomeUnknown: boolean;
} {
  // The license guard rejects before the handler runs: a definitive "nothing
  // was changed", never an unknown outcome.
  if (isLicenseLockedError(error)) {
    return { message: licenseLockedMessage, licenseLocked: true, outcomeUnknown: false };
  }
  if (isApiRequestError(error)) {
    if (error.status === 401 || error.status === 403) {
      return { message: sessionExpiredMessage, authFailure: "unauthorized", outcomeUnknown: false };
    }
    const apiMessage = error.message.trim();
    const known = Object.hasOwn(knownApiMessages, apiMessage)
      ? knownApiMessages[apiMessage]
      : undefined;
    const outcomeUnknown =
      error.status >= 500 && !definitiveServerFailures.has(apiMessage);
    if (known && error.status < 600) return { message: known, outcomeUnknown };
    return { message: fallback, outcomeUnknown };
  }
  return { message: fallback, outcomeUnknown: true };
}

function failureFromError(error: unknown, fallback: string): PipedriveActionResult {
  const described = describeMutationError(error, fallback);
  return {
    ok: false,
    message: described.message,
    ...(described.authFailure ? { authFailure: described.authFailure } : {}),
    ...(described.licenseLocked ? { licenseLocked: true } : {}),
    ...(described.outcomeUnknown ? { outcomeUnknown: true } : {}),
  };
}

function ruleFailureFromError(error: unknown, fallback: string): PipedriveRuleActionResult {
  return failureFromError(error, fallback);
}

function connectionMatchesScope(
  connection: PipedriveConnectionDto,
  workspaceId: string,
  connectionId?: string,
): boolean {
  if (connection.workspaceId !== workspaceId) return false;
  if (connectionId !== undefined && connection.id !== connectionId) return false;
  return true;
}

function ruleMatchesScope(
  rule: PipedriveConversionRuleDto,
  connectionId: string,
  ruleId?: string,
): boolean {
  if (rule.connectionId !== connectionId) return false;
  if (ruleId !== undefined && rule.id !== ruleId) return false;
  return true;
}

function pipedriveConnectionsPath(workspaceId: string, connectionId?: string) {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/pipedrive/connections`;
  return connectionId ? `${base}/${encodeURIComponent(connectionId)}` : base;
}

/**
 * "not_found" is raised ONLY by the structured scoped 404
 * (`pipedrive_connection_not_found`) and is the sole proof of absence.
 * "network" covers 5xx (including the sanitized 503), timeouts and any 404
 * without that code: the state stays unknown. "inconsistent" means the
 * revision changed between reads on every attempt.
 */
type ReadFailure =
  | "unauthorized"
  | "invalid_response"
  | "network"
  | "not_found"
  | "inconsistent";

/**
 * The student API client carries no machine-readable error code, so the
 * scoped 404 is recognized by the exact message PipedriveService raises
 * (code pipedrive_connection_not_found). Any other 404 stays unknown.
 */
const scopedAbsenceMessage = PIPEDRIVE_CONNECTION_NOT_FOUND_MESSAGE;

function isScopedAbsence(error: unknown): boolean {
  return (
    isApiRequestError(error) &&
    error.status === 404 &&
    error.message === scopedAbsenceMessage
  );
}

function readFailureOf(error: unknown): ReadFailure {
  if (isApiRequestError(error) && (error.status === 401 || error.status === 403)) {
    return "unauthorized";
  }
  if (isScopedAbsence(error)) return "not_found";
  return "network";
}

const READ_FENCE_ATTEMPTS = 3;

/**
 * Snapshot and rules are two separate GETs, so this is a revision FENCE, not
 * an atomic read: GET snapshot (revision A), GET rules, GET snapshot again
 * (revision B). The pair is accepted only when A === B (and the connection
 * `updatedAt` did not move); otherwise the sequence is retried, then reported
 * as inconsistent. Without a backend revision the result is flagged unfenced.
 */
async function readDetail(
  workspaceId: string,
  connectionId: string,
): Promise<{ ok: true; connection: PipedriveConnectionDetailDto } | { ok: false; reason: ReadFailure }> {
  const path = pipedriveConnectionsPath(workspaceId, connectionId);

  for (let attempt = 0; attempt < READ_FENCE_ATTEMPTS; attempt += 1) {
    let firstBody: unknown;
    let rulesBody: unknown;
    let lastBody: unknown;
    try {
      firstBody = await serverApiFetch<unknown>(path);
      rulesBody = await serverApiFetch<unknown>(`${path}/rules`);
      lastBody = await serverApiFetch<unknown>(path);
    } catch (error) {
      return { ok: false, reason: readFailureOf(error) };
    }

    const first = parseSnapshot(firstBody);
    const last = parseSnapshot(lastBody);
    const rules = parseRules(rulesBody);
    if (
      !first ||
      !last ||
      !rules ||
      !connectionMatchesScope(first, workspaceId, connectionId) ||
      !connectionMatchesScope(last, workspaceId, connectionId) ||
      rules.some((rule) => !ruleMatchesScope(rule, connectionId))
    ) {
      return { ok: false, reason: "invalid_response" };
    }

    const revisioned =
      first.mutationRevision !== undefined && last.mutationRevision !== undefined;
    if (revisioned) {
      if (
        first.mutationRevision !== last.mutationRevision ||
        first.updatedAt !== last.updatedAt
      ) {
        continue;
      }
      return {
        ok: true,
        connection: { ...last, rules, revisionFenced: true },
      };
    }
    return { ok: true, connection: { ...last, rules, revisionFenced: false } };
  }
  return { ok: false, reason: "inconsistent" };
}

export type PipedriveCapabilitiesResult =
  | { ok: true; capabilities: PipedriveCapabilitiesDto }
  | { ok: false; reason: ReadFailure | "missing" };

/** Environment gates only; never a per-lead readiness promise. */
export async function getPipedriveCapabilitiesAction(
  workspaceId: string,
  connectionId: string,
): Promise<PipedriveCapabilitiesResult> {
  let body: unknown;
  try {
    body = await serverApiFetch<unknown>(
      `${pipedriveConnectionsPath(workspaceId, connectionId)}/capabilities`,
    );
  } catch (error) {
    // A route the deployed API does not know yet is "missing", not absence.
    if (isApiRequestError(error) && error.status === 404 && !isScopedAbsence(error)) {
      return { ok: false, reason: "missing" };
    }
    return { ok: false, reason: readFailureOf(error) };
  }
  if (
    !isRecord(body) ||
    typeof body.productionEnabled !== "boolean" ||
    !Array.isArray(body.activationRequirements) ||
    body.activationRequirements.length > 32 ||
    body.activationRequirements.some(
      (item) => typeof item !== "string" || !errorCodePattern.test(item),
    ) ||
    !Array.isArray(body.modes) ||
    !body.modes.includes("production")
  ) {
    return { ok: false, reason: "missing" };
  }
  return {
    ok: true,
    capabilities: {
      productionEnabled: body.productionEnabled,
      activationRequirements: body.activationRequirements as string[],
      historicalReplay: body.historicalReplay === true,
      unknownDeliveryRetry: body.unknownDeliveryRetry === true,
    },
  };
}

export type PipedriveConnectionListResult =
  | { ok: true; connections: PipedriveConnectionDetailDto[] }
  | { ok: false; reason: ReadFailure };

/**
 * The list endpoint carries no catalog, so each connection is completed with
 * its own revision-fenced scoped read (+ rules). Any failure fails the whole
 * load: a genuinely failed read must never look like an empty workspace. A
 * connection that disappears between the list and its detail is a failure too
 * (the list itself is then stale), never silently dropped.
 */
export async function listPipedriveConnectionsAction(
  workspaceId: string,
): Promise<PipedriveConnectionListResult> {
  let listBody: unknown;
  try {
    listBody = await serverApiFetch<unknown>(pipedriveConnectionsPath(workspaceId));
  } catch (error) {
    return { ok: false, reason: readFailureOf(error) };
  }

  const list = parseConnectionListStrict(listBody);
  if (!list || list.some((item) => !connectionMatchesScope(item, workspaceId))) {
    return { ok: false, reason: "invalid_response" };
  }

  const details = await Promise.all(
    list.map((item) => readDetail(workspaceId, item.id)),
  );
  const connections: PipedriveConnectionDetailDto[] = [];
  for (const detail of details) {
    if (!detail.ok) return { ok: false, reason: detail.reason };
    connections.push(detail.connection);
  }
  return { ok: true, connections };
}

export type PipedriveConnectionGetResult =
  | { ok: true; connection: PipedriveConnectionDetailDto }
  | { ok: false; reason: ReadFailure };

/** Explicit, awaited reconciliation read (connection + catalog + rules). */
export async function getPipedriveConnectionAction(
  workspaceId: string,
  connectionId: string,
): Promise<PipedriveConnectionGetResult> {
  return readDetail(workspaceId, connectionId);
}

export type PipedriveEventsResult =
  | { ok: true; events: PipedriveEventDto[] }
  | { ok: false; reason: ReadFailure };

export async function listPipedriveEventsAction(
  workspaceId: string,
  connectionId: string,
): Promise<PipedriveEventsResult> {
  let body: unknown;
  try {
    body = await serverApiFetch<unknown>(
      `${pipedriveConnectionsPath(workspaceId, connectionId)}/events`,
    );
  } catch (error) {
    return { ok: false, reason: readFailureOf(error) };
  }
  const events = parseEvents(body);
  if (!events) return { ok: false, reason: "invalid_response" };
  return { ok: true, events };
}

export async function createPipedriveConnectionAction(
  formData: FormData,
): Promise<PipedriveActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const input = parsePayload(formData, pipedriveConnectionCreateInputSchema.safeParse.bind(pipedriveConnectionCreateInputSchema));

  if (!workspaceId || !input) return failure(invalidFormMessage);

  try {
    const response = await serverApiFetch<unknown>(
      pipedriveConnectionsPath(workspaceId),
      { method: "POST", body: JSON.stringify(input) },
    );
    const connection = parseSnapshot(response);

    // The request may have committed even though the response is unusable.
    if (!connection || !connectionMatchesScope(connection, workspaceId)) {
      return { ...failure("Não foi possível confirmar a criação da conexão Pipedrive."), outcomeUnknown: true };
    }

    revalidateCrmPaths();
    return {
      ok: true,
      message:
        "Conexão Pipedrive criada. Gere a URL do webhook para concluir a configuração no Pipedrive.",
      connection,
    };
  } catch (error) {
    return failureFromError(error, "Não foi possível criar a conexão Pipedrive.");
  }
}

export async function replacePipedriveCredentialAction(
  formData: FormData,
): Promise<PipedriveActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");
  const input = parsePayload(formData, pipedriveConnectionCredentialReplaceInputSchema.safeParse.bind(pipedriveConnectionCredentialReplaceInputSchema));

  if (!workspaceId || !connectionId || !input) return failure(invalidFormMessage);

  return runConnectionMutation({
    workspaceId,
    connectionId,
    path: "/credentials",
    method: "POST",
    body: JSON.stringify(input),
    okMessage: "Credenciais do Pipedrive atualizadas.",
    failMessage: "Não foi possível atualizar as credenciais do Pipedrive.",
  });
}

export async function setPipedriveConnectionStatusAction(
  formData: FormData,
): Promise<PipedriveActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");
  const input = pipedriveConnectionStatusUpdateInputSchema.safeParse({
    status: formText(formData, "status") ?? undefined,
  });

  if (!workspaceId || !connectionId || !input.success) return failure(invalidFormMessage);

  return runConnectionMutation({
    workspaceId,
    connectionId,
    path: "/status",
    method: "PATCH",
    body: JSON.stringify(input.data),
    okMessage:
      input.data.status === "active"
        ? "Conexão Pipedrive retomada."
        : "Conexão Pipedrive pausada.",
    failMessage: "Não foi possível alterar o status da conexão Pipedrive.",
  });
}

export async function setPipedriveChannelBindingsAction(
  formData: FormData,
): Promise<PipedriveActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");
  const input = parsePayload(formData, pipedriveConnectionChannelBindingsInputSchema.safeParse.bind(pipedriveConnectionChannelBindingsInputSchema));

  if (!workspaceId || !connectionId || !input) return failure(invalidFormMessage);

  return runConnectionMutation({
    workspaceId,
    connectionId,
    path: "/channel-bindings",
    method: "PATCH",
    body: JSON.stringify(input),
    okMessage: "Canais autorizados atualizados.",
    failMessage: "Não foi possível atualizar os canais autorizados.",
  });
}

export async function refreshPipedriveCatalogAction(
  formData: FormData,
): Promise<PipedriveActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");

  if (!workspaceId || !connectionId) return failure(invalidFormMessage);

  const result = await runConnectionMutation({
    workspaceId,
    connectionId,
    path: "/refresh-catalog",
    method: "POST",
    body: "{}",
    okMessage: "Catálogo de pipelines e etapas atualizado.",
    failMessage: "Não foi possível atualizar o catálogo do Pipedrive.",
  });
  if (result.ok && result.connection && result.connection.catalogState !== "fresh") {
    return {
      ok: false,
      message: "Não foi possível confirmar o catálogo; verifique a credencial.",
    };
  }
  return result;
}

async function runConnectionMutation(options: {
  workspaceId: string;
  connectionId: string;
  path: string;
  method: "POST" | "PATCH";
  body: string;
  okMessage: string;
  failMessage: string;
}): Promise<PipedriveActionResult> {
  const { workspaceId, connectionId } = options;
  try {
    const response = await serverApiFetch<unknown>(
      `${pipedriveConnectionsPath(workspaceId, connectionId)}${options.path}`,
      { method: options.method, body: options.body },
    );
    const connection = parseSnapshot(response);

    // A well-formed 2xx whose scope does not match is never trusted, and the
    // write may still have happened, so the outcome stays unknown.
    if (!connection || !connectionMatchesScope(connection, workspaceId, connectionId)) {
      return { ...failure(options.failMessage), outcomeUnknown: true };
    }

    revalidateCrmPaths();
    return { ok: true, message: options.okMessage, connection };
  } catch (error) {
    return failureFromError(error, options.failMessage);
  }
}

export async function deletePipedriveConnectionAction(
  formData: FormData,
): Promise<PipedriveActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");

  if (!workspaceId || !connectionId) return failure(invalidFormMessage);

  try {
    const response = await serverApiFetch<unknown>(
      pipedriveConnectionsPath(workspaceId, connectionId),
      { method: "DELETE" },
    );
    if (!isRecord(response) || response.status !== "deleted") {
      return { ...failure("Não foi possível confirmar a remoção da conexão."), outcomeUnknown: true };
    }
    revalidateCrmPaths();
    return { ok: true, message: "Conexão Pipedrive removida.", deleted: true };
  } catch (error) {
    return failureFromError(error, "Não foi possível remover a conexão Pipedrive.");
  }
}

export async function rotatePipedriveWebhookSecretAction(
  formData: FormData,
): Promise<PipedriveActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");

  if (!workspaceId || !connectionId) return failure(invalidFormMessage);

  try {
    const response = await serverApiFetch<unknown>(
      `${pipedriveConnectionsPath(workspaceId, connectionId)}/webhook-secret/rotate`,
      { method: "POST", body: "{}" },
    );
    const result = parseRotateResult(response);

    // The secret was likely rotated server-side; the old URL is already dead.
    if (!result) {
      return { ...failure("Não foi possível exibir a nova URL de webhook. Gere outra."), outcomeUnknown: true };
    }

    revalidateCrmPaths();
    return {
      ok: true,
      message:
        "URL do webhook Pipedrive gerada. Copie-a agora; ela não será exibida novamente e a anterior foi invalidada.",
      oneTimeWebhook: result,
    };
  } catch (error) {
    return failureFromError(error, "Não foi possível gerar a URL de webhook.");
  }
}

export async function revokePipedriveWebhookSecretAction(
  formData: FormData,
): Promise<PipedriveActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");

  if (!workspaceId || !connectionId) return failure(invalidFormMessage);

  try {
    const response = await serverApiFetch<unknown>(
      `${pipedriveConnectionsPath(workspaceId, connectionId)}/webhook-secret`,
      { method: "DELETE" },
    );
    if (!isRecord(response) || response.status !== "revoked") {
      return { ...failure("Não foi possível confirmar a revogação da URL."), outcomeUnknown: true };
    }
    revalidateCrmPaths();
    return {
      ok: true,
      message: "URL do webhook revogada. O Pipedrive deixa de ser aceito até gerar uma nova.",
      revoked: true,
    };
  } catch (error) {
    return failureFromError(error, "Não foi possível revogar a URL de webhook.");
  }
}

export async function createPipedriveRuleAction(
  formData: FormData,
): Promise<PipedriveRuleActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");
  const input = parsePayload<PipedriveConversionRuleCreateInputDto>(
    formData,
    pipedriveConversionRuleCreateInputSchema.safeParse.bind(pipedriveConversionRuleCreateInputSchema),
  );

  if (!workspaceId || !connectionId || !input) return ruleFailure(invalidFormMessage);

  try {
    const response = await serverApiFetch<unknown>(
      `${pipedriveConnectionsPath(workspaceId, connectionId)}/rules`,
      { method: "POST", body: JSON.stringify(input) },
    );
    const rule = parseRule(response);

    if (!rule || !ruleMatchesScope(rule, connectionId)) {
      return { ...ruleFailure("Não foi possível confirmar a criação da regra."), outcomeUnknown: true };
    }

    revalidateCrmPaths();
    return { ok: true, message: "Regra Pipedrive criada.", rule };
  } catch (error) {
    return ruleFailureFromError(error, "Não foi possível criar a regra Pipedrive.");
  }
}

export async function updatePipedriveRuleAction(
  formData: FormData,
): Promise<PipedriveRuleActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");
  const ruleId = formId(formData, "ruleId");
  const input = parsePayload<PipedriveConversionRuleUpdateInputDto>(
    formData,
    pipedriveConversionRuleUpdateInputSchema.safeParse.bind(pipedriveConversionRuleUpdateInputSchema),
  );

  if (!workspaceId || !connectionId || !ruleId || !input) return ruleFailure(invalidFormMessage);

  try {
    const response = await serverApiFetch<unknown>(
      `${pipedriveConnectionsPath(workspaceId, connectionId)}/rules/${encodeURIComponent(ruleId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
    const rule = parseRule(response);

    if (!rule || !ruleMatchesScope(rule, connectionId, ruleId)) {
      return { ...ruleFailure("Não foi possível confirmar a atualização da regra."), outcomeUnknown: true };
    }

    revalidateCrmPaths();
    return {
      ok: true,
      message: rule.active ? "Regra Pipedrive atualizada." : "Regra Pipedrive pausada.",
      rule,
    };
  } catch (error) {
    return ruleFailureFromError(error, "Não foi possível atualizar a regra Pipedrive.");
  }
}

export async function deletePipedriveRuleAction(
  formData: FormData,
): Promise<PipedriveRuleActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");
  const ruleId = formId(formData, "ruleId");

  if (!workspaceId || !connectionId || !ruleId) return ruleFailure(invalidFormMessage);

  try {
    const response = await serverApiFetch<unknown>(
      `${pipedriveConnectionsPath(workspaceId, connectionId)}/rules/${encodeURIComponent(ruleId)}`,
      { method: "DELETE" },
    );
    if (!isRecord(response) || response.status !== "deleted") {
      return { ...ruleFailure("Não foi possível confirmar a remoção da regra."), outcomeUnknown: true };
    }

    revalidateCrmPaths();
    return { ok: true, message: "Regra Pipedrive removida." };
  } catch (error) {
    return ruleFailureFromError(error, "Não foi possível remover a regra Pipedrive.");
  }
}

export async function retryPipedriveEventAction(
  formData: FormData,
): Promise<PipedriveEventRetryResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");
  const eventId = formId(formData, "eventId");

  if (!workspaceId || !connectionId || !eventId) return failure(invalidFormMessage);

  try {
    const response = await serverApiFetch<unknown>(
      `${pipedriveConnectionsPath(workspaceId, connectionId)}/events/${encodeURIComponent(eventId)}/retry`,
      { method: "POST", body: "{}" },
    );
    if (!isRecord(response) || response.status !== "accepted") {
      return { ...failure("Não foi possível confirmar o reprocessamento."), outcomeUnknown: true };
    }
    return {
      ok: true,
      message:
        "Reprocessamento solicitado. O evento volta para a fila; atualize a lista para acompanhar.",
    };
  } catch (error) {
    return failureFromError(error, "Não foi possível reprocessar o evento.");
  }
}

function parsePayload<T>(
  formData: FormData,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): T | null {
  const value = formText(formData, "payload");

  if (!value || value.length > 500_000) return null;

  try {
    const parsed = parse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function formText(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formId(formData: FormData, key: string): string | null {
  const value = formText(formData, key);

  if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return null;
  }

  return value;
}

function failure(
  message: string,
  authFailure?: PipedriveAuthFailureReason,
): PipedriveActionResult {
  return { ok: false, message, ...(authFailure ? { authFailure } : {}) };
}

function ruleFailure(
  message: string,
  authFailure?: PipedriveAuthFailureReason,
): PipedriveRuleActionResult {
  return { ok: false, message, ...(authFailure ? { authFailure } : {}) };
}
