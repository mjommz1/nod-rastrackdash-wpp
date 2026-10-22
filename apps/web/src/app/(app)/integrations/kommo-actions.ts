"use server";

import {
  kommoConnectionChannelBindingsInputSchema,
  kommoConnectionCreateInputSchema,
  kommoConnectionCredentialReplaceInputSchema,
  kommoConnectionSchema,
  kommoConnectionStatusUpdateInputSchema,
  kommoConversionRuleCreateInputSchema,
  kommoConversionRuleSchema,
  kommoConversionRuleUpdateInputSchema,
  kommoPipelineStatusSchema,
  kommoRuleModes,
  kommoValueModes,
  type ConversionEventNameDto,
  type KommoConnectionDto,
  type KommoConversionRuleCreateInputDto,
  type KommoConversionRuleUpdateInputDto,
} from "@wpptrack/shared";
import { revalidatePath } from "next/cache";
import {
  isApiRequestError,
  isLicenseLockedError,
  serverApiFetch,
} from "../../../lib/server-api";

// Provenance: adapted from the read-only Kommo webhook-url session worktree
// (apps/web/src/app/(app)/integrations/kommo-actions.ts). Adds license-lock
// handling (HTTP 423) and the connection-scoped webhook event audit read.

/**
 * apps/web does not depend on zod directly, so the extra fields the API
 * embeds in a Kommo connection response (pipelines and rules, see
 * KommoService#dto in apps/api) are validated by hand here while reusing the
 * exported shared schemas for the nested pieces.
 */
type KommoRuleMode = (typeof kommoRuleModes)[number];
type KommoValueMode = (typeof kommoValueModes)[number];

export type KommoConversionRuleDto = {
  id: string;
  connectionId: string;
  name: string;
  pipelineId: string;
  statusId: string;
  eventName: ConversionEventNameDto;
  mode: KommoRuleMode;
  valueMode: KommoValueMode;
  fixedValueCents: number | null;
  currency: string | null;
  contentName: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type KommoConnectionPipelineRowDto = {
  id: string;
  name: string;
  sort: number | null;
  status: { id: string; name: string; type: string | null };
  available: boolean;
};

export type KommoConnectionDetailDto = KommoConnectionDto & {
  pipelines: KommoConnectionPipelineRowDto[];
  rules: KommoConversionRuleDto[];
};

export type KommoOneTimeWebhook = {
  webhookUrl: string;
};

export type KommoAuthFailureReason = "unauthorized";

export type KommoActionResult = {
  ok: boolean;
  message: string;
  authFailure?: KommoAuthFailureReason;
  /** HTTP 423: refused by the license guard before any write ran. */
  licenseLocked?: boolean;
  outcomeUnknown?: boolean;
  connection?: KommoConnectionDetailDto;
  oneTimeWebhook?: KommoOneTimeWebhook;
};

export type KommoRuleActionResult = {
  ok: boolean;
  message: string;
  authFailure?: KommoAuthFailureReason;
  licenseLocked?: boolean;
  outcomeUnknown?: boolean;
  rule?: KommoConversionRuleDto;
};

/** One rule outcome inside a webhook event. Only audited fields are kept. */
export type KommoEventResultDto = {
  ruleId: string;
  eventName: string | null;
  status: string | null;
  errorCode: string | null;
  publicationStatus: string | null;
  publicationErrorCode: string | null;
  publicationErrorMessage: string | null;
  senderStatus: string | null;
};

/**
 * Mirrors KommoService#listEvents (apps/api). The API sends no timestamps and
 * no counters; only these fields exist and only these are surfaced.
 */
export type KommoEventDto = {
  id: string;
  dealId: string;
  pipelineId: string;
  statusId: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  results: KommoEventResultDto[];
};

export type KommoEventsResult =
  | { ok: true; events: KommoEventDto[]; nextCursor: string | null }
  | {
      ok: false;
      reason:
        | "unauthorized"
        | "not_found"
        | "invalid_response"
        | "invalid_request"
        | "network";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePipelineRows(
  value: unknown,
): KommoConnectionPipelineRowDto[] | null {
  if (!Array.isArray(value)) return null;

  const rows: KommoConnectionPipelineRowDto[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const status = kommoPipelineStatusSchema.safeParse(entry.status);
    if (
      typeof entry.id !== "string" ||
      !entry.id ||
      typeof entry.name !== "string" ||
      !entry.name ||
      !(typeof entry.sort === "number" || entry.sort === null) ||
      typeof entry.available !== "boolean" ||
      !status.success
    ) {
      return null;
    }
    rows.push({
      id: entry.id,
      name: entry.name,
      sort: entry.sort,
      status: status.data,
      available: entry.available,
    });
  }
  return rows;
}

function parseRuleRows(value: unknown): KommoConversionRuleDto[] | null {
  if (!Array.isArray(value)) return null;

  const rows: KommoConversionRuleDto[] = [];
  for (const entry of value) {
    const rule = kommoConversionRuleSchema.safeParse(entry);
    if (!rule.success) return null;
    rows.push(rule.data);
  }
  return rows;
}

function parseConnectionDetail(value: unknown): KommoConnectionDetailDto | null {
  if (!isRecord(value)) return null;
  const base = kommoConnectionSchema.safeParse(value);
  if (!base.success) return null;

  const pipelines = parsePipelineRows(value.pipelines);
  if (!pipelines) return null;

  const rules = parseRuleRows(value.rules);
  if (!rules || rules.some((rule) => rule.connectionId !== base.data.id)) {
    return null;
  }

  return { ...base.data, pipelines, rules };
}

/** One malformed entry fails the whole list: a failed fetch must never look empty. */
function parseConnectionListStrict(
  value: unknown,
): KommoConnectionDetailDto[] | null {
  if (!Array.isArray(value)) return null;

  const rows: KommoConnectionDetailDto[] = [];
  for (const entry of value) {
    const parsed = parseConnectionDetail(entry);
    if (!parsed) return null;
    rows.push(parsed);
  }
  return rows;
}

function parseConnectionCreateResult(
  value: unknown,
): { connection: KommoConnectionDetailDto; webhookUrl: string } | null {
  if (!isRecord(value) || typeof value.webhookUrl !== "string" || !value.webhookUrl) {
    return null;
  }
  const connection = parseConnectionDetail(value);
  if (!connection) return null;

  return { connection, webhookUrl: value.webhookUrl };
}

function parseRotateSecretResult(value: unknown): { webhookUrl: string } | null {
  if (!isRecord(value) || typeof value.webhookUrl !== "string" || !value.webhookUrl) {
    return null;
  }
  return { webhookUrl: value.webhookUrl };
}

const codePattern = /^[A-Za-z0-9_.:-]{1,120}$/;
const deliveryUnknownMessage =
  "Resultado da entrega desconhecido. Reenvio bloqueado; investigacao requerida.";

function optionalCode(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !codePattern.test(value)) return undefined;
  return value;
}

function parseEventResult(value: unknown): KommoEventResultDto | null {
  if (!isRecord(value)) return null;
  const ruleId = value.ruleId;
  if (typeof ruleId !== "string" || !ruleId || ruleId.length > 255) return null;

  const eventName = optionalCode(value.eventName);
  const status = optionalCode(value.status);
  const errorCode = optionalCode(value.errorCode);
  const publicationStatus = optionalCode(value.publicationStatus);
  const publicationErrorCode = optionalCode(value.publicationErrorCode);
  const senderStatus = optionalCode(value.senderStatus);
  if (
    eventName === undefined ||
    status === undefined ||
    errorCode === undefined ||
    publicationStatus === undefined ||
    publicationErrorCode === undefined ||
    senderStatus === undefined
  ) {
    return null;
  }

  return {
    ruleId,
    eventName,
    status,
    errorCode,
    publicationStatus,
    publicationErrorCode,
    publicationErrorMessage:
      value.publicationErrorMessage === deliveryUnknownMessage
        ? deliveryUnknownMessage
        : null,
    senderStatus,
  };
}

function parseEvent(value: unknown): KommoEventDto | null {
  if (!isRecord(value)) return null;
  const { id, dealId, pipelineId, statusId, status, attempts } = value;
  if (
    typeof id !== "string" ||
    !id ||
    id.length > 255 ||
    typeof dealId !== "string" ||
    !dealId ||
    dealId.length > 255 ||
    typeof pipelineId !== "string" ||
    !pipelineId ||
    pipelineId.length > 255 ||
    typeof statusId !== "string" ||
    !statusId ||
    statusId.length > 255 ||
    typeof status !== "string" ||
    !codePattern.test(status) ||
    typeof attempts !== "number" ||
    !Number.isInteger(attempts) ||
    attempts < 0 ||
    !Array.isArray(value.results) ||
    value.results.length > 200
  ) {
    return null;
  }
  const errorCode = optionalCode(value.errorCode);
  if (errorCode === undefined) return null;

  const results: KommoEventResultDto[] = [];
  for (const entry of value.results) {
    const parsed = parseEventResult(entry);
    if (!parsed) return null;
    results.push(parsed);
  }

  return {
    id,
    dealId,
    pipelineId,
    statusId,
    status,
    errorCode,
    errorMessage:
      value.errorMessage === deliveryUnknownMessage ? deliveryUnknownMessage : null,
    attempts,
    results,
  };
}

function parseEventsPage(
  value: unknown,
  requestedCursor: string | undefined,
): { events: KommoEventDto[]; nextCursor: string | null } | null {
  if (!isRecord(value) || !Array.isArray(value.events) || value.events.length > 100) {
    return null;
  }
  const nextCursor = value.nextCursor;
  if (
    !(nextCursor === null || nextCursor === undefined) &&
    (typeof nextCursor !== "string" ||
      !nextCursor ||
      nextCursor.length > 255 ||
      nextCursor === requestedCursor)
  ) {
    return null;
  }

  const events: KommoEventDto[] = [];
  const seen = new Set<string>();
  for (const entry of value.events) {
    const parsed = parseEvent(entry);
    if (!parsed || seen.has(parsed.id)) return null;
    seen.add(parsed.id);
    events.push(parsed);
  }

  return { events, nextCursor: nextCursor ?? null };
}

const settingsPath = "/settings";
const invalidFormMessage = "Revise os dados informados e tente novamente.";
const sessionExpiredMessage =
  "Sua sessão expirou ou você não tem permissão para esta ação. Atualize a página e tente novamente.";
const licenseLockedMessage =
  "Licença bloqueada: alterações indisponíveis. Você ainda pode consultar a auditoria. Verifique /backoffice/license.";

// Only exact, locally controlled validation copy may cross this boundary.
const safeValidationMessages = new Set([
  "Canal ou rota indisponivel",
  "Credencial Kommo requer verificacao",
  "Conexao alterada; tente novamente",
  "Estagio Kommo indisponivel no catalogo",
  "Payload invalido",
]);

type DescribedError = {
  message: string;
  authFailure?: KommoAuthFailureReason;
  licenseLocked?: boolean;
};

function describeMutationError(error: unknown, fallback: string): DescribedError {
  // The license guard rejects before the handler runs: a definitive "nothing
  // was written", never an unknown outcome.
  if (isLicenseLockedError(error)) {
    return { message: licenseLockedMessage, licenseLocked: true };
  }
  if (isApiRequestError(error)) {
    if (error.status === 401 || error.status === 403) {
      return { message: sessionExpiredMessage, authFailure: "unauthorized" };
    }
    if (error.status === 400 || error.status === 409) {
      const message = error.message.trim();
      if (safeValidationMessages.has(message)) {
        return { message };
      }
    }
  }
  return { message: fallback };
}

function isUnknownOutcome(error: unknown): boolean {
  if (isLicenseLockedError(error)) return false;
  return !isApiRequestError(error) || error.status >= 500;
}

function failureFromError(error: unknown, fallback: string): KommoActionResult {
  const described = describeMutationError(error, fallback);
  return {
    ...failure(described.message, described.authFailure),
    ...(described.licenseLocked ? { licenseLocked: true } : {}),
    ...(isUnknownOutcome(error) ? { outcomeUnknown: true } : {}),
  };
}

function ruleFailureFromError(
  error: unknown,
  fallback: string,
): KommoRuleActionResult {
  const described = describeMutationError(error, fallback);
  return {
    ...ruleFailure(described.message, described.authFailure),
    ...(described.licenseLocked ? { licenseLocked: true } : {}),
    ...(isUnknownOutcome(error) ? { outcomeUnknown: true } : {}),
  };
}

function connectionMatchesScope(
  connection: KommoConnectionDetailDto,
  workspaceId: string,
  connectionId?: string,
): boolean {
  if (connection.workspaceId !== workspaceId) return false;
  if (connectionId !== undefined && connection.id !== connectionId) return false;
  return true;
}

function ruleMatchesScope(
  rule: KommoConversionRuleDto,
  connectionId: string,
  ruleId?: string,
): boolean {
  if (rule.connectionId !== connectionId) return false;
  if (ruleId !== undefined && rule.id !== ruleId) return false;
  return true;
}

function kommoConnectionsPath(workspaceId: string, connectionId?: string) {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/kommo/connections`;
  return connectionId ? `${base}/${encodeURIComponent(connectionId)}` : base;
}

export type KommoConnectionListResult =
  | { ok: true; connections: KommoConnectionDetailDto[] }
  | { ok: false; reason: "unauthorized" | "invalid_response" | "network" };

/**
 * Distinguishes a genuinely empty workspace from a failed/unauthorized fetch
 * so the caller never renders "no connections yet" on top of a load failure.
 */
export async function listKommoConnectionsAction(
  workspaceId: string,
): Promise<KommoConnectionListResult> {
  let response: unknown;

  try {
    response = await serverApiFetch<unknown>(kommoConnectionsPath(workspaceId));
  } catch (error) {
    if (isApiRequestError(error) && (error.status === 401 || error.status === 403)) {
      return { ok: false, reason: "unauthorized" };
    }
    return { ok: false, reason: "network" };
  }

  const connections = parseConnectionListStrict(response);
  if (
    !connections ||
    connections.some((connection) => connection.workspaceId !== workspaceId)
  ) {
    return { ok: false, reason: "invalid_response" };
  }

  return { ok: true, connections };
}

export type KommoConnectionGetResult =
  | { ok: true; connection: KommoConnectionDetailDto }
  | { ok: false; reason: "unauthorized" | "invalid_response" | "network" };

export async function getKommoConnectionAction(
  workspaceId: string,
  connectionId: string,
): Promise<KommoConnectionGetResult> {
  let response: unknown;

  try {
    response = await serverApiFetch<unknown>(
      kommoConnectionsPath(workspaceId, connectionId),
    );
  } catch (error) {
    if (isApiRequestError(error) && (error.status === 401 || error.status === 403)) {
      return { ok: false, reason: "unauthorized" };
    }
    return { ok: false, reason: "network" };
  }

  const connection = parseConnectionDetail(response);
  if (!connection || !connectionMatchesScope(connection, workspaceId, connectionId)) {
    return { ok: false, reason: "invalid_response" };
  }

  return { ok: true, connection };
}

/**
 * Connection-scoped webhook audit (GET .../kommo/connections/:id/events). A
 * read: it keeps working while the license is locked. The API pages forward
 * by event id (100 per page, oldest first) and sends `nextCursor: null` when
 * the page was not full.
 */
export async function listKommoEventsAction(
  workspaceId: string,
  connectionId: string,
  cursor?: string,
): Promise<KommoEventsResult> {
  const scopedWorkspace = typeof workspaceId === "string" ? workspaceId.trim() : "";
  const scopedConnection = typeof connectionId === "string" ? connectionId.trim() : "";
  if (
    !scopedWorkspace ||
    !scopedConnection ||
    scopedWorkspace.length > 255 ||
    scopedConnection.length > 255 ||
    (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursor.length > 255))
  ) {
    return { ok: false, reason: "invalid_request" };
  }

  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  let response: unknown;

  try {
    response = await serverApiFetch<unknown>(
      `${kommoConnectionsPath(scopedWorkspace, scopedConnection)}/events${query}`,
    );
  } catch (error) {
    if (isApiRequestError(error)) {
      if (error.status === 401 || error.status === 403) {
        return { ok: false, reason: "unauthorized" };
      }
      if (error.status === 404) return { ok: false, reason: "not_found" };
      if (error.status === 400) return { ok: false, reason: "invalid_request" };
    }
    return { ok: false, reason: "network" };
  }

  const page = parseEventsPage(response, cursor);
  if (!page) return { ok: false, reason: "invalid_response" };

  return { ok: true, events: page.events, nextCursor: page.nextCursor };
}

export async function createKommoConnectionAction(
  formData: FormData,
): Promise<KommoActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const input = parsePayload(
    formData,
    kommoConnectionCreateInputSchema.safeParse,
  );

  if (!workspaceId || !input) {
    return failure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      kommoConnectionsPath(workspaceId),
      { method: "POST", body: JSON.stringify(input) },
    );
    const result = parseConnectionCreateResult(response);

    if (!result || result.connection.workspaceId !== workspaceId) {
      return {
        ...failure("Não foi possível criar a conexão Kommo."),
        outcomeUnknown: true,
      };
    }

    revalidatePath(settingsPath);
    return {
      ok: true,
      message:
        "Conexão Kommo criada e catálogo carregado. Copie a URL do webhook; ela fica visível nesta sessão até você ocultar ou recarregar a página.",
      connection: result.connection,
      oneTimeWebhook: { webhookUrl: result.webhookUrl },
    };
  } catch (error) {
    return failureFromError(error, "Não foi possível criar a conexão Kommo.");
  }
}

export async function replaceKommoCredentialAction(
  formData: FormData,
): Promise<KommoActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");
  const input = parsePayload(
    formData,
    kommoConnectionCredentialReplaceInputSchema.safeParse,
  );

  if (!workspaceId || !connectionId || !input) {
    return failure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      `${kommoConnectionsPath(workspaceId, connectionId)}/credentials`,
      { method: "POST", body: JSON.stringify(input) },
    );
    const connection = parseConnectionDetail(response);

    if (!connection || !connectionMatchesScope(connection, workspaceId, connectionId)) {
      return {
        ...failure("Não foi possível atualizar as credenciais da Kommo."),
        outcomeUnknown: true,
      };
    }

    revalidatePath(settingsPath);
    return {
      ok: true,
      message: "Credenciais da Kommo atualizadas.",
      connection,
    };
  } catch (error) {
    return failureFromError(
      error,
      "Não foi possível atualizar as credenciais da Kommo.",
    );
  }
}

export async function setKommoConnectionStatusAction(
  formData: FormData,
): Promise<KommoActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");
  const input = kommoConnectionStatusUpdateInputSchema.safeParse({
    status: formText(formData, "status") ?? undefined,
  });

  if (!workspaceId || !connectionId || !input.success) {
    return failure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      `${kommoConnectionsPath(workspaceId, connectionId)}/status`,
      { method: "PATCH", body: JSON.stringify(input.data) },
    );
    const connection = parseConnectionDetail(response);

    if (!connection || !connectionMatchesScope(connection, workspaceId, connectionId)) {
      return {
        ...failure("Não foi possível alterar o status da conexão Kommo."),
        outcomeUnknown: true,
      };
    }

    revalidatePath(settingsPath);
    return {
      ok: true,
      message:
        input.data.status === "active"
          ? "Conexão Kommo retomada."
          : "Conexão Kommo pausada.",
      connection,
    };
  } catch (error) {
    return failureFromError(
      error,
      "Não foi possível alterar o status da conexão Kommo.",
    );
  }
}

export async function setKommoChannelBindingsAction(
  formData: FormData,
): Promise<KommoActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");
  const input = parsePayload(
    formData,
    kommoConnectionChannelBindingsInputSchema.safeParse,
  );

  if (!workspaceId || !connectionId || !input) {
    return failure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      `${kommoConnectionsPath(workspaceId, connectionId)}/channel-bindings`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
    const connection = parseConnectionDetail(response);

    if (!connection || !connectionMatchesScope(connection, workspaceId, connectionId)) {
      return {
        ...failure("Não foi possível atualizar os canais autorizados."),
        outcomeUnknown: true,
      };
    }

    revalidatePath(settingsPath);
    return {
      ok: true,
      message: "Canais autorizados atualizados.",
      connection,
    };
  } catch (error) {
    return failureFromError(
      error,
      "Não foi possível atualizar os canais autorizados.",
    );
  }
}

export async function rotateKommoWebhookTokenAction(
  formData: FormData,
): Promise<KommoActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");

  if (!workspaceId || !connectionId) {
    return failure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      `${kommoConnectionsPath(workspaceId, connectionId)}/rotate-webhook-token`,
      { method: "POST", body: "{}" },
    );
    const result = parseRotateSecretResult(response);

    if (!result) {
      return {
        ...failure("Não foi possível gerar uma nova URL de webhook."),
        outcomeUnknown: true,
      };
    }

    revalidatePath(settingsPath);
    return {
      ok: true,
      message:
        "Nova URL do webhook Kommo gerada; a anterior foi invalidada. Copie e cole a nova URL na Kommo.",
      oneTimeWebhook: { webhookUrl: result.webhookUrl },
    };
  } catch (error) {
    return failureFromError(
      error,
      "Não foi possível gerar uma nova URL de webhook.",
    );
  }
}

export async function refreshKommoCatalogAction(
  formData: FormData,
): Promise<KommoActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");

  if (!workspaceId || !connectionId) {
    return failure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      `${kommoConnectionsPath(workspaceId, connectionId)}/refresh-catalog`,
      { method: "POST", body: "{}" },
    );
    const connection = parseConnectionDetail(response);

    if (!connection || !connectionMatchesScope(connection, workspaceId, connectionId)) {
      return {
        ...failure("Não foi possível atualizar o catálogo da Kommo."),
        outcomeUnknown: true,
      };
    }

    revalidatePath(settingsPath);
    return {
      ok: true,
      message:
        connection.catalogState === "fresh"
          ? "Catálogo de pipelines e estágios atualizado."
          : "Não foi possível confirmar o catálogo; verifique a credencial.",
      connection,
    };
  } catch (error) {
    return failureFromError(
      error,
      "Não foi possível atualizar o catálogo da Kommo.",
    );
  }
}

export async function createKommoRuleAction(
  formData: FormData,
): Promise<KommoRuleActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");
  const input = parsePayload<KommoConversionRuleCreateInputDto>(
    formData,
    kommoConversionRuleCreateInputSchema.safeParse,
  );

  if (!workspaceId || !connectionId || !input) {
    return ruleFailure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      `${kommoConnectionsPath(workspaceId, connectionId)}/rules`,
      { method: "POST", body: JSON.stringify(input) },
    );
    const result = kommoConversionRuleSchema.safeParse(response);

    if (!result.success || !ruleMatchesScope(result.data, connectionId)) {
      return {
        ...ruleFailure("Não foi possível criar a regra Kommo."),
        outcomeUnknown: true,
      };
    }

    revalidatePath(settingsPath);
    return { ok: true, message: "Regra Kommo criada.", rule: result.data };
  } catch (error) {
    return ruleFailureFromError(error, "Não foi possível criar a regra Kommo.");
  }
}

export async function updateKommoRuleAction(
  formData: FormData,
): Promise<KommoRuleActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");
  const ruleId = formId(formData, "ruleId");
  const input = parsePayload<KommoConversionRuleUpdateInputDto>(
    formData,
    kommoConversionRuleUpdateInputSchema.safeParse,
  );

  if (!workspaceId || !connectionId || !ruleId || !input) {
    return ruleFailure(invalidFormMessage);
  }

  try {
    const response = await serverApiFetch<unknown>(
      `${kommoConnectionsPath(workspaceId, connectionId)}/rules/${encodeURIComponent(ruleId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
    const result = kommoConversionRuleSchema.safeParse(response);

    if (!result.success || !ruleMatchesScope(result.data, connectionId, ruleId)) {
      return {
        ...ruleFailure("Não foi possível atualizar a regra Kommo."),
        outcomeUnknown: true,
      };
    }

    revalidatePath(settingsPath);
    return {
      ok: true,
      message: result.data.active
        ? "Regra Kommo atualizada."
        : "Regra Kommo pausada.",
      rule: result.data,
    };
  } catch (error) {
    return ruleFailureFromError(
      error,
      "Não foi possível atualizar a regra Kommo.",
    );
  }
}

export async function deleteKommoRuleAction(
  formData: FormData,
): Promise<KommoRuleActionResult> {
  const workspaceId = formId(formData, "workspaceId");
  const connectionId = formId(formData, "connectionId");
  const ruleId = formId(formData, "ruleId");

  if (!workspaceId || !connectionId || !ruleId) {
    return ruleFailure(invalidFormMessage);
  }

  try {
    await serverApiFetch<unknown>(
      `${kommoConnectionsPath(workspaceId, connectionId)}/rules/${encodeURIComponent(ruleId)}`,
      { method: "DELETE" },
    );

    revalidatePath(settingsPath);
    return { ok: true, message: "Regra Kommo removida." };
  } catch (error) {
    return ruleFailureFromError(error, "Não foi possível remover a regra Kommo.");
  }
}

function parsePayload<T>(
  formData: FormData,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): T | null {
  const value = formText(formData, "payload");

  if (!value || value.length > 500_000) {
    return null;
  }

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
  authFailure?: KommoAuthFailureReason,
): KommoActionResult {
  return { ok: false, message, ...(authFailure ? { authFailure } : {}) };
}

function ruleFailure(
  message: string,
  authFailure?: KommoAuthFailureReason,
): KommoRuleActionResult {
  return { ok: false, message, ...(authFailure ? { authFailure } : {}) };
}
