"use client";

import { RefreshCw } from "lucide-react";
import { useFormStatus } from "react-dom";
import { BackofficeActionForm } from "../../../components/backoffice-action-form";
import { retryBlockedMetaEventsAction } from "./actions";

export type RetryBlockedFilters = {
  since: string;
  until: string;
  eventName: string;
  status: string;
  source: string;
};

function RetryBlockedSubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button
      className="button ghost compact-button audit-retry-button"
      disabled={disabled || pending}
      title={
        disabled
          ? "Nenhum evento bloqueado neste periodo"
          : "Tentar enviar de novo os eventos bloqueados deste periodo com a conexao Meta atual"
      }
      type="submit"
    >
      <RefreshCw aria-hidden="true" size={16} />
      {pending ? "Enviando..." : "Reenviar bloqueados"}
    </button>
  );
}

export function RetryBlockedEvents({
  blockedCount,
  filters,
}: {
  blockedCount: number;
  filters: RetryBlockedFilters;
}) {
  return (
    <BackofficeActionForm
      action={retryBlockedMetaEventsAction}
      className="audit-retry-blocked-form"
    >
      {Object.entries(filters).map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} />
      ))}
      <RetryBlockedSubmitButton disabled={blockedCount === 0} />
    </BackofficeActionForm>
  );
}
