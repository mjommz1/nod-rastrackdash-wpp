import type { CurrentWorkspaceDto, WorkspaceListDto } from "@wpptrack/shared";
import {
  clientNavVisibleForPermissions,
  type ClientNavId,
} from "@wpptrack/shared";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  getAvailableWorkspaces,
  getCurrentWorkspace,
} from "../lib/current-workspace";
import { getBrandConfig } from "../lib/brand";
import { isApiRequestError } from "../lib/server-api";
import { getWhatsappDataSource } from "../lib/whatsapp-data-source";
import { AppShell } from "./app-shell";

export async function WorkspaceAccessGate({
  children,
}: {
  children: ReactNode;
}) {
  const [workspaceAccess, workspaces, pathname] = await Promise.all([
    getWorkspaceAccessState(),
    getWorkspaceListState(),
    getRequestPathname(),
  ]);
  const brand = getBrandConfig();

  if (workspaceAccess.state === "operational_blocked") {
    return (
      <AppShell
        workspace={workspaceAccess.workspace}
        workspaces={workspaces}
        brand={brand}
      >
        <section className="page-stack">
          <header className="page-header">
            <div>
              <span className="eyebrow">Acesso suspenso</span>
              <h1>Workspace bloqueado</h1>
              <p>
                Fale com o suporte da plataforma para revisar a situacao
                operacional da conta antes de continuar.
              </p>
            </div>
            <div className="header-actions">
              <span className="status-chip warn">bloqueado</span>
            </div>
          </header>
        </section>
      </AppShell>
    );
  }

  if (!workspaceAccess.workspace) {
    const hasMemberships = workspaces.length > 0;

    return (
      <AppShell workspace={null} workspaces={workspaces} brand={brand}>
        <section className="page-stack">
          <header className="page-header">
            <div>
              <span className="eyebrow">Empresas</span>
              <h1>
                {hasMemberships
                  ? "Selecione uma empresa"
                  : "Nenhuma empresa disponivel"}
              </h1>
              <p>
                {hasMemberships
                  ? "Use o seletor no menu para abrir um workspace autorizado."
                  : "Seu acesso ainda nao esta vinculado a um workspace ativo."}
              </p>
            </div>
          </header>
        </section>
      </AppShell>
    );
  }

  // Fail-closed management routes: analyst (member) and others without the
  // matching permission cannot open integrations/settings by URL.
  const gatedNavId = managementNavIdForPath(pathname);
  if (
    gatedNavId &&
    !clientNavVisibleForPermissions(
      gatedNavId,
      workspaceAccess.workspace.permissions,
    )
  ) {
    redirect("/overview");
  }

  const dataSource = await getWhatsappDataSource();

  return (
    <AppShell
      dataSource={dataSource}
      workspace={workspaceAccess.workspace}
      workspaces={workspaces}
      brand={brand}
    >
      {children}
    </AppShell>
  );
}

function managementNavIdForPath(pathname: string): ClientNavId | null {
  if (pathname === "/integrations" || pathname.startsWith("/integrations/")) {
    return "integrations";
  }
  if (pathname === "/conversions" || pathname.startsWith("/conversions/")) {
    return "conversions";
  }
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return "settings";
  }
  return null;
}

async function getWorkspaceListState(): Promise<WorkspaceListDto> {
  try {
    return await getAvailableWorkspaces();
  } catch {
    return [];
  }
}

async function getWorkspaceAccessState(): Promise<
  | { state: "active"; workspace: CurrentWorkspaceDto | null }
  | {
      state: "operational_blocked";
      workspace: CurrentWorkspaceDto | null;
    }
> {
  try {
    const workspace = await getCurrentWorkspace();

    return {
      state:
        workspace.operationalStatus === "blocked"
          ? "operational_blocked"
          : "active",
      workspace,
    };
  } catch (error) {
    const blocked =
      isApiRequestError(error) &&
      error.status === 403 &&
      error.message.toLowerCase().includes("workspace bloqueado");

    return {
      state: blocked ? "operational_blocked" : "active",
      workspace: null,
    };
  }
}

async function getRequestPathname(): Promise<string> {
  try {
    const requestHeaders = await headers();
    return requestHeaders.get("x-wpptrack-pathname") ?? "/overview";
  } catch {
    return "/overview";
  }
}
