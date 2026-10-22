"use server";

import { revalidatePath } from "next/cache";
import type { BackofficeActionState } from "../../../components/backoffice-action-form";
import { serverApiFetch } from "../../../lib/server-api";

export async function retryMetaEventAction(
  _previousState: BackofficeActionState,
  formData: FormData
): Promise<BackofficeActionState> {
  const eventId = String(formData.get("eventId") ?? "").trim();

  if (!eventId) {
    return {
      status: "error",
      message: "Evento Meta nao identificado.",
      nonce: Date.now()
    };
  }

  try {
    await serverApiFetch(
      `/reports/conversions/audit/${encodeURIComponent(eventId)}/retry`,
      { method: "POST" }
    );
    revalidatePath("/events");

    return {
      status: "success",
      message: "Evento enfileirado para uma nova tentativa.",
      nonce: Date.now()
    };
  } catch {
    return {
      status: "error",
      message:
        "O evento nao pode ser reenviado. Atualize a pagina e confira o motivo tecnico.",
      nonce: Date.now()
    };
  }
}

type RetryBlockedResult = {
  claimed: number;
  enqueued: number;
  skipped: number;
  failed: number;
};

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

function retryBlockedMessage(result: RetryBlockedResult): string {
  const parts: string[] = [];

  if (result.enqueued > 0) {
    parts.push(
      `${result.enqueued} ${plural(result.enqueued, "evento enfileirado", "eventos enfileirados")} para nova tentativa.`
    );
  }

  if (result.skipped > 0) {
    parts.push(
      `${result.skipped} ${plural(result.skipped, "ja nao estava bloqueado e ficou", "ja nao estavam bloqueados e ficaram")} de fora.`
    );
  }

  if (result.failed > 0) {
    parts.push(
      `${result.failed} ${plural(result.failed, "nao pode ser enfileirado", "nao puderam ser enfileirados")} agora; tente de novo em instantes.`
    );
  }

  return parts.length
    ? parts.join(" ")
    : "Nenhum evento bloqueado para reenviar neste periodo.";
}

export async function retryBlockedMetaEventsAction(
  _previousState: BackofficeActionState,
  formData: FormData
): Promise<BackofficeActionState> {
  // Mesmos filtros da lista: o reenvio nunca alcanca eventos fora da tela atual.
  const params = new URLSearchParams();

  for (const key of ["since", "until", "eventName", "status", "source"]) {
    const value = String(formData.get(key) ?? "").trim();

    if (value) {
      params.set(key, value);
    }
  }

  try {
    const result = await serverApiFetch<RetryBlockedResult>(
      `/reports/conversions/audit/retry-blocked?${params.toString()}`,
      { method: "POST" }
    );
    revalidatePath("/events");

    return {
      status:
        result.failed > 0 && result.enqueued === 0 ? "error" : "success",
      message: retryBlockedMessage(result),
      nonce: Date.now()
    };
  } catch {
    return {
      status: "error",
      message:
        "Nao foi possivel reenviar os eventos bloqueados. Atualize a pagina e tente de novo.",
      nonce: Date.now()
    };
  }
}
