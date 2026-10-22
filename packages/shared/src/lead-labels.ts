// Display labels for the Leads list. Shared so the table and the exported
// spreadsheet always say the same thing about a lead.

import type { LeadStatusDto } from "./schemas/leads";

type LeadLifecycleInput = {
  status: LeadStatusDto;
  lastEventName: string | null;
};

export function leadStatusLabel(status: LeadStatusDto): string {
  const labels: Record<LeadStatusDto, string> = {
    new: "Novo",
    active: "Atendimento ativo",
    qualified: "Lead qualificado",
    converted: "Compra atribuida",
    lost: "Perdido",
  };

  return labels[status];
}

/** "Etapa atual" of a lead. */
export function leadLifecycleLabel(lead: LeadLifecycleInput): string {
  if (lead.status === "lost") {
    return "Perdido";
  }

  const labels: Record<string, string> = {
    LeadSubmitted: "Conversa iniciada",
    QualifiedLead: "Lead qualificado",
    Purchase: "Compra atribuida",
  };

  return lead.lastEventName
    ? (labels[lead.lastEventName] ?? lead.lastEventName)
    : leadStatusLabel(lead.status);
}

/** Origin line under the campaign name. */
export function leadSourceLabel(
  source: string | null,
  adId: string | null,
): string {
  if (source === "external_mysql") {
    return "Integracao externa";
  }

  if (source === "umbler_talk") {
    return "Umbler Talk";
  }

  if (source === "uazapi") {
    return "NOD API";
  }

  return source ?? adId ?? "Origem parcial";
}
