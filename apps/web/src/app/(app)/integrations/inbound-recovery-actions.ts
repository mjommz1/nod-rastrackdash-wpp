"use server";

import {
  studentInboundReplayAuthorizeSchema,
  studentInboundReplayPreviewSchema,
  studentInboundReplayResultSchema,
  type StudentInboundReplayPreviewDto,
  type StudentInboundReplayResultDto,
} from "@wpptrack/shared";
import { serverApiFetch } from "../../../lib/server-api";

export type RecoveryActionResult<T> =
  { ok: true; data: T } | { ok: false; message: string };
const safeErrors = new Set([
  "A previa expirou ou mudou. Atualize a previa antes de enviar",
  "A previa nao pertence a este owner, conexao e canal",
  "A conexao ou a rota mudou. Atualize a previa antes de enviar",
  "Envie um de teste e aguarde a confirmacao de entrega antes de recuperar os demais",
  "Esta conexao ja possui um replay em andamento",
  "Nenhum evento possui rota completa e payload disponivel",
  "Digite exatamente o nome da conexao para autorizar",
  "Nao foi possivel iniciar o replay; tente novamente",
  "Configure META_APP_SECRET do seu proprio app Meta no ambiente da API antes de enviar. Nao use o segredo PalmUP nem cole segredos no chat.",
  "Replay de webhooks ainda nao esta habilitado",
]);
function failure(error: unknown): { ok: false; message: string } {
  return {
    ok: false,
    message:
      error instanceof Error && safeErrors.has(error.message)
        ? error.message
        : "Nao foi possivel consultar ou autorizar a recuperacao. Confira sua sessao, acesso de owner, licenca e disponibilidade da API.",
  };
}
function path(connectionId: string, channelId: string): string {
  if (!connectionId || !channelId) throw new Error();
  return `/integrations/inbound-webhooks/${encodeURIComponent(connectionId)}/channels/${encodeURIComponent(channelId)}/recovery`;
}
export async function previewInboundRecoveryAction(
  connectionId: string,
  channelId: string,
): Promise<RecoveryActionResult<StudentInboundReplayPreviewDto>> {
  try {
    const response = await serverApiFetch<unknown>(
      `${path(connectionId, channelId)}/preview`,
    );
    const parsed = studentInboundReplayPreviewSchema.safeParse(response);
    if (!parsed.success) throw new Error();
    return { ok: true, data: parsed.data };
  } catch (error) {
    return failure(error);
  }
}
export async function authorizeInboundRecoveryAction(
  connectionId: string,
  channelId: string,
  input: unknown,
): Promise<RecoveryActionResult<StudentInboundReplayResultDto>> {
  try {
    const parsed = studentInboundReplayAuthorizeSchema.safeParse(input);
    if (!parsed.success)
      return {
        ok: false,
        message: "Revise a previa e digite o nome da conexao para confirmar.",
      };
    const response = await serverApiFetch<unknown>(
      `${path(connectionId, channelId)}/authorize`,
      { method: "POST", body: JSON.stringify(parsed.data) },
    );
    return { ok: true, data: studentInboundReplayResultSchema.parse(response) };
  } catch (error) {
    return failure(error);
  }
}
export async function inboundRecoveryResultAction(
  connectionId: string,
  channelId: string,
  batchId: string,
): Promise<RecoveryActionResult<StudentInboundReplayResultDto>> {
  try {
    if (!batchId) throw new Error();
    const response = await serverApiFetch<unknown>(
      `${path(connectionId, channelId)}/batches/${encodeURIComponent(batchId)}`,
    );
    return { ok: true, data: studentInboundReplayResultSchema.parse(response) };
  } catch (error) {
    return failure(error);
  }
}
