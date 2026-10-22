import type { WorkspacePermissionsDto } from "./schemas/workspace";

export const clientNavigation = [
  { id: "overview", label: "Visao geral" },
  { id: "leads", label: "Leads" },
  { id: "reports", label: "Relatorios" },
  { id: "events", label: "Eventos Meta" },
  { id: "integrations", label: "Integracoes" },
  { id: "conversions", label: "Conversões" },
  { id: "settings", label: "Configuracoes" }
] as const;

export const backofficeNavigation = [
  { id: "workspaces", label: "Workspaces" },
  { id: "billing", label: "Financeiro" },
  { id: "split", label: "Split" },
  { id: "diagnostics", label: "Diagnostico" }
] as const;

export type ClientNavId = (typeof clientNavigation)[number]["id"];
export type BackofficeNavId = (typeof backofficeNavigation)[number]["id"];

// Management nav items gated by workspace permissions. Anything not listed
// here (overview, leads, reports, events) is always visible once authenticated.
const clientNavPermissionRequirement: Partial<
  Record<ClientNavId, keyof WorkspacePermissionsDto>
> = {
  integrations: "canManageIntegrations",
  conversions: "canManageIntegrations",
  settings: "canManageWorkspaceSettings"
};

// Fail-closed: an item gated by a permission is hidden unless permissions are
// present and the flag is explicitly true (missing/null permissions hide it).
export function clientNavVisibleForPermissions(
  itemId: ClientNavId,
  permissions: WorkspacePermissionsDto | null | undefined
): boolean {
  const requiredPermission = clientNavPermissionRequirement[itemId];

  if (!requiredPermission) {
    return true;
  }

  return permissions?.[requiredPermission] === true;
}
