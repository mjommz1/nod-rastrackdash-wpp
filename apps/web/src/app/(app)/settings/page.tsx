import type {
  ConversionEventNameDto,
  CurrentWorkspaceDto,
  FunnelConfigurationDto,
  WorkspaceOpsAlertSettings,
  WorkspaceInviteDto,
  WorkspaceMemberDto,
} from "@wpptrack/shared";
import { workspaceOpsAlertSettingsSchema } from "@wpptrack/shared";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import {
  Bell,
  Building2,
  ChevronDown,
  Coins,
  ShieldCheck,
  UserPlus,
  UsersRound,
  Workflow,
} from "lucide-react";
import {
  BackofficeActionForm,
  type BackofficeActionState,
} from "../../../components/backoffice-action-form";
import { CopyLinkButton } from "../../../components/copy-link-button";
import { LinkResultActionForm } from "../../../components/link-result-action-form";
import { OpsAlertPhonesEditor } from "../../../components/ops-alert-phones-editor";
import { PendingSubmitButton } from "../../../components/pending-submit-button";
import { PresentationMask } from "../../../components/presentation-mask";
import { TeamActionButton } from "../../../components/team-action-button";
import { displayTimeZone } from "../../../lib/date-time";
import { serverApiFetch } from "../../../lib/server-api";
import { getCurrentWorkspace } from "../../../lib/current-workspace";
import {
  getAdAccountCurrencies,
  getWorkspaceCurrencySettings,
} from "../../../lib/currency-settings";
import { CurrencySettingsSection } from "./currency-settings-section";
import { saveOpsAlertSettingsAction } from "./ops-alert-settings-actions";
type AccountUserDto = {
  id: string;
  email: string;
  name: string | null;
  authProvider: string;
  emailVerifiedAt: string | null;
};

type AccountSettingsResult = {
  user: AccountUserDto | null;
  state: "real" | "error";
};

type WorkspaceOpsAlertSettingsDto = WorkspaceOpsAlertSettings;

type OpsAlertSettingsResult = {
  settings: WorkspaceOpsAlertSettingsDto | null;
  workspaceId: string | null;
  state: "real" | "forbidden" | "error";
};

const opsAlertSettingsDefaults: Pick<
  WorkspaceOpsAlertSettingsDto,
  | "enabled"
  | "alertPhonesE164"
  | "alertPhoneE164"
  | "disconnectAlerts"
  | "webhookSilenceAlerts"
  | "silenceThresholdHours"
  | "debounceHours"
> = {
  enabled: false,
  alertPhonesE164: [],
  alertPhoneE164: null,
  disconnectAlerts: true,
  webhookSilenceAlerts: true,
  silenceThresholdHours: 24,
  debounceHours: 6,
};

function defaultOpsAlertSettings(
  workspaceId: string,
): WorkspaceOpsAlertSettingsDto {
  return workspaceOpsAlertSettingsSchema.parse({
    id: null,
    workspaceId,
    ...opsAlertSettingsDefaults,
    createdAt: null,
    updatedAt: null,
  });
}

type FunnelConfigurationResult = {
  configuration: FunnelConfigurationDto;
  state: "real" | "error";
};

type WorkspaceSettingsResult = {
  workspace: CurrentWorkspaceDto | null;
  members: WorkspaceMemberDto[];
  invites: WorkspaceInviteDto[];
  state: "real" | "empty" | "error";
};

const eventsWithCommercialValue = new Set<ConversionEventNameDto>([
  "Purchase",
  "OrderCreated",
]);

function settingsActionState(
  status: BackofficeActionState["status"],
  message: string,
): BackofficeActionState {
  return {
    status,
    message,
    nonce: Date.now(),
  };
}

function eventSupportsCommercialValue(eventName: string): boolean {
  return eventsWithCommercialValue.has(eventName as ConversionEventNameDto);
}

function workspaceRoleLabel(role: WorkspaceMemberDto["role"]): string {
  if (role === "owner") {
    return "Owner";
  }

  if (role === "admin") {
    return "Administrador";
  }

  return "Analista";
}

function workspaceRoleDescription(
  role: WorkspaceMemberDto["role"],
  canManageMembers = false,
): string {
  if (role === "owner") {
    return "Equipe, integracoes e cobranca";
  }

  if (role === "admin") {
    return canManageMembers
      ? "Operacao, integracoes e gestao da equipe"
      : "Operacao e integracoes";
  }

  return "Leads e relatorios";
}

function initials(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);

  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function parseMoneyToCents(value: FormDataEntryValue | null): number | null {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return null;
  }

  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw;
  const amount = Number(normalized);

  return Number.isFinite(amount) && amount > 0
    ? Math.round(amount * 100)
    : null;
}

function moneyInputValue(valueCents: number | null | undefined): string {
  return valueCents == null
    ? ""
    : (valueCents / 100).toFixed(2).replace(".", ",");
}

async function getAccountSettings(): Promise<AccountSettingsResult> {
  try {
    const account = await serverApiFetch<{ user: AccountUserDto }>("/auth/me");

    return {
      user: account.user,
      state: "real",
    };
  } catch {
    return {
      user: null,
      state: "error",
    };
  }
}

async function getOpsAlertSettings(): Promise<OpsAlertSettingsResult> {
  let workspaceId: string | null = null;

  try {
    const workspace = await getCurrentWorkspace();
    workspaceId = workspace.id;

    if (!workspace.permissions.canManageWorkspaceSettings) {
      return { settings: null, state: "forbidden", workspaceId: workspace.id };
    }

    const payload = await serverApiFetch<unknown>(
      `/workspaces/${encodeURIComponent(workspace.id)}/ops-alerts/settings`,
    );
    const parsed = workspaceOpsAlertSettingsSchema.safeParse(payload);
    const settings = parsed.success
      ? parsed.data
      : defaultOpsAlertSettings(workspace.id);

    return { settings, state: "real", workspaceId: workspace.id };
  } catch {
    return { settings: null, state: "error", workspaceId };
  }
}

async function getFunnelConfiguration(): Promise<FunnelConfigurationResult> {
  try {
    const configuration = await serverApiFetch<FunnelConfigurationDto>(
      "/conversion-rules/funnel",
    );

    return {
      configuration,
      state: "real",
    };
  } catch {
    return {
      configuration: { stages: [] },
      state: "error",
    };
  }
}

async function getWorkspaceSettings(): Promise<WorkspaceSettingsResult> {
  try {
    const [workspace, members, invites] = await Promise.all([
      getCurrentWorkspace(),
      serverApiFetch<WorkspaceMemberDto[]>("/workspaces/current/members"),
      serverApiFetch<WorkspaceInviteDto[]>("/workspaces/current/invites"),
    ]);

    return {
      workspace,
      members,
      invites,
      state: members.length > 0 ? "real" : "empty",
    };
  } catch {
    return {
      workspace: null,
      members: [],
      invites: [],
      state: "error",
    };
  }
}

function shortDate(value: string): string {
  return new Date(value).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: displayTimeZone,
    year: "numeric",
  });
}

function inviteStatusLabel(status: WorkspaceInviteDto["status"]): string {
  if (status === "sent") {
    return "Enviado";
  }

  if (status === "failed") {
    return "Falha no envio";
  }

  if (status === "accepted") {
    return "Aceito";
  }

  if (status === "revoked") {
    return "Revogado";
  }

  if (status === "expired") {
    return "Expirado";
  }

  return "Pendente";
}

async function saveFunnelConfiguration(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  "use server";

  const eventNames = formData
    .getAll("stageEventName")
    .map((value) => String(value).trim())
    .filter(Boolean);

  if (eventNames.length === 0) {
    return settingsActionState(
      "error",
      "Nenhuma etapa de funil foi encontrada.",
    );
  }

  const stages = eventNames.map((eventName, index) => ({
    eventName,
    label: String(formData.get(`stageLabel:${eventName}`) ?? "").trim(),
    position:
      Number(formData.get(`stagePosition:${eventName}`) ?? index + 1) ||
      index + 1,
    visible: formData.get(`stageVisible:${eventName}`) === "on",
    defaultValueCents: eventSupportsCommercialValue(eventName)
      ? parseMoneyToCents(formData.get(`stageValue:${eventName}`))
      : null,
    defaultCurrency: eventSupportsCommercialValue(eventName)
      ? // "" = padrão do workspace (null: herda a moeda das conversões).
        String(formData.get(`stageCurrency:${eventName}`) ?? "")
          .trim()
          .toUpperCase() || null
      : null,
    defaultContentName: eventSupportsCommercialValue(eventName)
      ? String(formData.get(`stageProduct:${eventName}`) ?? "").trim() || null
      : null,
  }));

  try {
    await serverApiFetch("/conversion-rules/funnel", {
      method: "PUT",
      body: JSON.stringify({ stages }),
    });
    revalidatePath("/settings");
    revalidatePath("/overview");
    revalidatePath("/reports");
    revalidatePath("/events");

    return settingsActionState("success", "Jornada do funil atualizada.");
  } catch {
    return settingsActionState("error", "Nao foi possivel salvar o funil.");
  }
}

async function createWorkspaceInvite(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  "use server";

  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "member");

  if (!email) {
    return settingsActionState("error", "Informe o email do novo membro.");
  }

  try {
    const invite = await serverApiFetch<WorkspaceInviteDto>(
      "/workspaces/current/invites",
      {
        method: "POST",
        body: JSON.stringify({ email, role }),
      },
    );
    revalidatePath("/settings");

    return {
      status: "success",
      message: "Convite criado para a equipe.",
      nonce: Date.now(),
      acceptUrl: invite.acceptUrl,
    };
  } catch {
    return settingsActionState("error", "Nao foi possivel criar o convite.");
  }
}

async function updateWorkspaceMemberRole(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  "use server";

  const memberId = String(formData.get("memberId") ?? "").trim();
  const role = String(formData.get("role") ?? "member");

  if (!memberId) {
    return settingsActionState("error", "Membro nao identificado.");
  }

  try {
    await serverApiFetch(`/workspaces/current/members/${memberId}/role`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
    revalidatePath("/settings");
    return settingsActionState("success", "Nivel de acesso atualizado.");
  } catch {
    return settingsActionState("error", "Nao foi possivel alterar o acesso.");
  }
}

async function updateWorkspaceMemberManager(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  "use server";

  const memberId = String(formData.get("memberId") ?? "").trim();
  const canManageMembers = formData.get("canManageMembers") === "on";

  if (!memberId) {
    return settingsActionState("error", "Membro nao identificado.");
  }

  try {
    await serverApiFetch(
      `/workspaces/current/members/${memberId}/member-manager`,
      {
        method: "PATCH",
        body: JSON.stringify({ canManageMembers }),
      },
    );
    revalidatePath("/settings");
    return settingsActionState("success", "Gestao da equipe atualizada.");
  } catch {
    return settingsActionState(
      "error",
      "Nao foi possivel alterar a gestao da equipe.",
    );
  }
}

async function removeWorkspaceMember(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  "use server";

  const memberId = String(formData.get("memberId") ?? "").trim();

  if (!memberId) {
    return settingsActionState("error", "Membro nao identificado.");
  }

  try {
    await serverApiFetch(`/workspaces/current/members/${memberId}`, {
      method: "DELETE",
    });
    revalidatePath("/settings");
    return settingsActionState("success", "Membro removido do workspace.");
  } catch {
    return settingsActionState("error", "Nao foi possivel remover o membro.");
  }
}

async function resendWorkspaceInvite(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  "use server";

  const inviteId = String(formData.get("inviteId") ?? "").trim();

  if (!inviteId) {
    return settingsActionState("error", "Convite nao identificado.");
  }

  try {
    const invite = await serverApiFetch<WorkspaceInviteDto>(
      `/workspaces/current/invites/${inviteId}/resend`,
      { method: "POST" },
    );
    revalidatePath("/settings");

    return {
      status: "success",
      message: "Convite renovado.",
      nonce: Date.now(),
      acceptUrl: invite.acceptUrl,
    };
  } catch {
    return settingsActionState("error", "Nao foi possivel renovar o convite.");
  }
}

async function revokeWorkspaceInvite(
  _previousState: BackofficeActionState,
  formData: FormData,
): Promise<BackofficeActionState> {
  "use server";

  const inviteId = String(formData.get("inviteId") ?? "").trim();

  if (!inviteId) {
    return settingsActionState("error", "Convite nao identificado.");
  }

  try {
    await serverApiFetch(`/workspaces/current/invites/${inviteId}`, {
      method: "DELETE",
    });
    revalidatePath("/settings");
    return settingsActionState("success", "Convite revogado.");
  } catch {
    return settingsActionState("error", "Nao foi possivel revogar o convite.");
  }
}

async function updateWorkspaceProfile(formData: FormData) {
  "use server";

  const name = String(formData.get("workspaceName") ?? "").trim();

  if (!name) {
    return;
  }

  try {
    await serverApiFetch("/workspaces/current", {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    revalidatePath("/settings");
  } catch {
    return;
  }
}

async function requestEmailVerification() {
  "use server";

  try {
    await serverApiFetch("/auth/email/verification/start", {
      method: "POST",
    });
    revalidatePath("/settings");
  } catch {
    return;
  }
}

export default async function SettingsPage() {
  const [
    workspaceSettings,
    funnelConfiguration,
    accountSettings,
    opsAlertSettings,
    currencySettings,
    adAccountCurrencies,
  ] = await Promise.all([
    getWorkspaceSettings(),
    getFunnelConfiguration(),
    getAccountSettings(),
    getOpsAlertSettings(),
    getWorkspaceCurrencySettings(),
    getAdAccountCurrencies(),
  ]);
  const workspaceConversionCurrency =
    currencySettings?.conversionCurrency ?? "BRL";
  const { workspace, members, invites } = workspaceSettings;
  const accountUser = accountSettings.user;
  const funnelStages = funnelConfiguration.configuration.stages;
  const canManageConversionRules = Boolean(
    workspace?.permissions.canManageIntegrations,
  );
  const isPlatformSupport = workspace?.accessMode === "platform_support";
  const isPlatformOwnerSupport = Boolean(
    isPlatformSupport && workspace?.platformRole === "platform_owner",
  );
  const canManageTeam = Boolean(
    workspace?.permissions.canManageMembers &&
    (!isPlatformSupport || isPlatformOwnerSupport),
  );
  const canGrantMemberManager = Boolean(
    workspace?.permissions.canGrantMemberManager &&
    (!isPlatformSupport || isPlatformOwnerSupport),
  );
  const opsAlertFormValues =
    opsAlertSettings.settings ?? opsAlertSettingsDefaults;
  const opsAlertStatusLabel =
    opsAlertSettings.state === "forbidden"
      ? "Sem permissao"
      : opsAlertSettings.state === "error"
        ? "Indisponivel"
        : opsAlertFormValues.enabled
          ? "Ativado"
          : "Desativado";
  const pendingInviteCount = invites.filter((invite) =>
    ["pending", "sent", "failed"].includes(invite.status),
  ).length;
  const visibleFunnelStageCount = funnelStages.filter(
    (stage) => stage.visible,
  ).length;
  const currentAccessLabel = isPlatformSupport
    ? "Suporte da plataforma"
    : workspace
      ? workspaceRoleLabel(workspace.role)
      : "Acesso indisponivel";
  const currentAccessDescription = isPlatformSupport
    ? "Acesso interno ao workspace do cliente"
    : workspace
      ? workspaceRoleDescription(
          workspace.role,
          workspace.permissions.canManageMembers,
        )
      : "Nao foi possivel consultar as permissoes";

  return (
    <section className="page-stack page-standard settings-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Configuracoes</span>
          <h1>Central de configuracoes</h1>
          <p>
            Identidade, equipe e automacoes organizadas por responsabilidade.
          </p>
        </div>
        <div className="header-actions">
          <span
            className={`status-chip${workspaceSettings.state === "error" || funnelConfiguration.state === "error" ? " warn" : ""}`}
          >
            {workspaceSettings.state === "error" ||
            funnelConfiguration.state === "error"
              ? "API indisponivel"
              : "API conectada"}
          </span>
        </div>
      </header>

      <section
        className="settings-overview"
        aria-labelledby="settings-overview-title"
      >
        <div className="settings-overview-heading">
          <div>
            <span className="eyebrow">Estado do workspace</span>
            <h2 id="settings-overview-title">Mapa das configuracoes</h2>
          </div>
          <span
            className={`status-chip${workspaceSettings.state === "error" ? " warn" : ""}`}
          >
            {workspaceSettings.state === "error"
              ? "Dados indisponiveis"
              : "Acessos protegidos"}
          </span>
        </div>
        <div className="settings-overview-grid">
          <article>
            <span className="settings-overview-icon account" aria-hidden="true">
              <ShieldCheck size={19} />
            </span>
            <span>
              <small>Acesso atual</small>
              <strong>{currentAccessLabel}</strong>
              <span>{currentAccessDescription}</span>
            </span>
          </article>
          <article>
            <span className="settings-overview-icon team" aria-hidden="true">
              <UsersRound size={19} />
            </span>
            <span>
              <small>Equipe</small>
              <strong>
                {members.length} membro{members.length === 1 ? "" : "s"}
              </strong>
              <span>
                {canManageTeam ? "Gestao disponivel" : "Somente leitura"}
              </span>
            </span>
          </article>
          <article>
            <span className="settings-overview-icon invite" aria-hidden="true">
              <UserPlus size={19} />
            </span>
            <span>
              <small>Convites</small>
              <strong>
                {pendingInviteCount} pendente
                {pendingInviteCount === 1 ? "" : "s"}
              </strong>
              <span>Envio e reenvio por email</span>
            </span>
          </article>
          <article>
            <span
              className="settings-overview-icon automation"
              aria-hidden="true"
            >
              <Workflow size={19} />
            </span>
            <span>
              <small>Jornada</small>
              <strong>{visibleFunnelStageCount} etapas visiveis</strong>
              <span>As regras de conversão ficam em Conversões</span>
            </span>
          </article>
        </div>
      </section>

      <nav
        className="settings-domain-nav"
        aria-label="Atalhos das configuracoes"
      >
        <a href="#configuracao-conta">
          <Building2 size={16} aria-hidden="true" />
          Conta
        </a>
        <a href="#configuracao-equipe">
          <UsersRound size={16} aria-hidden="true" />
          Equipe
        </a>
        <a href="#configuracao-conversoes">
          <Workflow size={16} aria-hidden="true" />
          Jornada
        </a>
        <a href="#configuracao-moeda">
          <Coins size={16} aria-hidden="true" />
          Moeda
        </a>
        <a href="#configuracao-operacao">
          <Bell size={16} aria-hidden="true" />
          Operacao
        </a>
      </nav>

      <section
        className="settings-domain-section settings-account-domain"
        id="configuracao-conta"
        aria-labelledby="settings-account-title"
      >
        <div className="settings-domain-heading">
          <span className="settings-domain-number" aria-hidden="true">
            01
          </span>
          <div>
            <span className="eyebrow">Conta e workspace</span>
            <h2 id="settings-account-title">Identidade e acesso</h2>
            <p>
              Confira a identidade publica do workspace e o acesso da conta
              atual.
            </p>
          </div>
          <span className={`status-chip${isPlatformSupport ? " neutral" : ""}`}>
            {currentAccessLabel}
          </span>
        </div>

        <div className="surface-panel settings-profile-panel">
          <div className="settings-profile-grid">
            <div className="workspace-profile-section">
              <div className="settings-section-heading">
                <span className="micro-label">Workspace</span>
                <strong>
                  <PresentationMask placeholder="Workspace demonstrativo">
                    {workspace?.name ?? "Workspace indisponivel"}
                  </PresentationMask>
                </strong>
                <small>
                  <PresentationMask placeholder="workspace-demonstrativo">
                    {workspace ? workspace.slug : "Dados indisponiveis"}
                  </PresentationMask>
                </small>
              </div>
              <form
                className="workspace-name-form"
                action={updateWorkspaceProfile}
                data-presentation-sensitive-action="true"
              >
                <label>
                  <span>Nome publico</span>
                  <input
                    defaultValue={workspace?.name ?? ""}
                    name="workspaceName"
                    data-presentation-sensitive-field="true"
                  />
                </label>
                <button
                  className="button primary"
                  disabled={!workspace?.permissions.canManageWorkspaceSettings}
                  type="submit"
                >
                  Salvar nome
                </button>
              </form>
              <div className="access-summary">
                <span>{currentAccessLabel}</span>
                <small>{currentAccessDescription}</small>
              </div>
            </div>

            <div className="account-profile-section">
              <div className="account-identity">
                <span className="member-avatar" aria-hidden="true">
                  <PresentationMask placeholder="--">
                    {accountUser
                      ? initials(accountUser.name, accountUser.email)
                      : "--"}
                  </PresentationMask>
                </span>
                <span>
                  <strong>
                    <PresentationMask placeholder="Usuario oculto">
                      {accountUser?.name ?? "Conta do usuario"}
                    </PresentationMask>
                  </strong>
                  <small>
                    <PresentationMask placeholder="usuario@exemplo.com">
                      {accountUser?.email ?? "Conta indisponivel"}
                    </PresentationMask>
                  </small>
                </span>
              </div>
              <dl className="account-facts">
                <div>
                  <dt>Acesso</dt>
                  <dd>
                    {accountUser?.authProvider === "email"
                      ? "Email e senha"
                      : (accountUser?.authProvider ?? "Indisponivel")}
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    {accountUser?.emailVerifiedAt
                      ? "Email verificado"
                      : "Email pendente"}
                  </dd>
                </div>
              </dl>
              {!accountUser?.emailVerifiedAt ? (
                <form
                  action={requestEmailVerification}
                  data-presentation-sensitive-action="true"
                >
                  <button
                    className="button"
                    disabled={!accountUser}
                    type="submit"
                  >
                    Enviar verificacao
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section
        className="settings-domain-section settings-team-domain"
        id="configuracao-equipe"
        aria-labelledby="settings-team-title"
      >
        <div className="settings-domain-heading">
          <span className="settings-domain-number" aria-hidden="true">
            02
          </span>
          <div>
            <span className="eyebrow">Equipe</span>
            <h2 id="settings-team-title">Membros e acessos</h2>
            <p>
              {workspaceSettings.state === "error"
                ? "Nao foi possivel carregar a equipe."
                : `${members.length} usuario${members.length === 1 ? "" : "s"} ativo${members.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <span className={`status-chip${canManageTeam ? "" : " neutral"}`}>
            {canManageTeam ? "Gestao da equipe" : "Somente leitura"}
          </span>
        </div>

        <div className="surface-panel team-settings-panel">
          <div className="team-settings-layout">
            <div className="member-list" aria-label="Membros do workspace">
              {members.length > 0 ? (
                members.map((member) => {
                  const isSelf = member.userId === accountUser?.id;
                  const canManageTarget =
                    canManageTeam &&
                    member.role !== "owner" &&
                    (canGrantMemberManager ||
                      !member.canManageMembers ||
                      isSelf);

                  return (
                    <div className="member-row" key={member.id}>
                      <span className="member-avatar" aria-hidden="true">
                        <PresentationMask placeholder="--">
                          {initials(member.name, member.email)}
                        </PresentationMask>
                      </span>
                      <span className="member-identity">
                        <strong>
                          <PresentationMask placeholder="Usuario oculto">
                            {member.name ?? "Usuario sem nome"}
                          </PresentationMask>
                        </strong>
                        <small>
                          <PresentationMask placeholder="usuario@exemplo.com">
                            {member.email}
                          </PresentationMask>
                        </small>
                      </span>
                      <span className="member-role">
                        <strong>{workspaceRoleLabel(member.role)}</strong>
                        <small>
                          {workspaceRoleDescription(
                            member.role,
                            member.canManageMembers,
                          )}
                        </small>
                        {member.canManageMembers ? (
                          <span className="member-manager-label">
                            Gerencia equipe
                          </span>
                        ) : null}
                      </span>
                      {canManageTarget ? (
                        <div
                          className="member-controls"
                          data-presentation-sensitive-action="true"
                        >
                          <BackofficeActionForm
                            action={updateWorkspaceMemberRole}
                            className="member-role-form"
                          >
                            <input
                              name="memberId"
                              type="hidden"
                              value={member.id}
                            />
                            <label>
                              <span className="sr-only">
                                Nivel de acesso de {member.email}
                              </span>
                              <select
                                aria-label={`Nivel de acesso de ${member.email}`}
                                defaultValue={member.role}
                                name="role"
                              >
                                <option value="member">Analista</option>
                                <option value="admin">Administrador</option>
                              </select>
                            </label>
                            <TeamActionButton
                              kind="save"
                              label={`Salvar nivel de ${member.email}`}
                            />
                          </BackofficeActionForm>
                          {canGrantMemberManager && member.role === "admin" ? (
                            <BackofficeActionForm
                              action={updateWorkspaceMemberManager}
                              className="member-manager-form"
                            >
                              <input
                                name="memberId"
                                type="hidden"
                                value={member.id}
                              />
                              <label className="member-manager-toggle">
                                <input
                                  defaultChecked={member.canManageMembers}
                                  name="canManageMembers"
                                  type="checkbox"
                                />
                                <span>Gerenciar equipe</span>
                              </label>
                              <TeamActionButton
                                kind="shield"
                                label={`Salvar gestao de equipe de ${member.email}`}
                              />
                            </BackofficeActionForm>
                          ) : null}
                          <BackofficeActionForm
                            action={removeWorkspaceMember}
                            className="member-remove-form"
                          >
                            <input
                              name="memberId"
                              type="hidden"
                              value={member.id}
                            />
                            <TeamActionButton
                              confirmMessage={`Remover ${member.email} deste workspace?`}
                              danger
                              kind="remove"
                              label={`Remover ${member.email}`}
                            />
                          </BackofficeActionForm>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              ) : (
                <p className="muted">Nenhum membro retornado pela API.</p>
              )}
            </div>

            <aside className="invite-panel">
              <div>
                <span className="micro-label">Novo acesso</span>
                <strong>Convidar membro</strong>
              </div>
              {canManageTeam ? (
                <div data-presentation-sensitive-action="true">
                  <LinkResultActionForm
                    action={createWorkspaceInvite}
                    className="invite-form"
                    linkField="acceptUrl"
                    resetOnSuccess
                  >
                    <label>
                      <span>Email</span>
                      <input
                        name="email"
                        type="email"
                        placeholder="pessoa@empresa.com"
                        data-presentation-sensitive-field="true"
                      />
                    </label>
                    <label>
                      <span>Nivel de acesso</span>
                      <select name="role" defaultValue="member">
                        <option value="member">Analista</option>
                        <option value="admin">Administrador</option>
                      </select>
                    </label>
                    <button className="button primary" type="submit">
                      <UserPlus aria-hidden="true" size={16} strokeWidth={2} />
                      Enviar convite
                    </button>
                  </LinkResultActionForm>
                </div>
              ) : (
                <p className="muted">
                  Apenas gestores da equipe podem convidar.
                </p>
              )}
              <div className="pending-invites">
                <span className="micro-label">Convites</span>
                {invites.length > 0 ? (
                  invites.map((invite) => (
                    <div key={invite.id}>
                      <span>
                        <strong>
                          <PresentationMask placeholder="usuario@exemplo.com">
                            {invite.email}
                          </PresentationMask>
                        </strong>
                        <small>
                          {inviteStatusLabel(invite.status)} |{" "}
                          {workspaceRoleLabel(invite.role)}
                          {["pending", "sent", "failed"].includes(invite.status)
                            ? ` | expira em ${shortDate(invite.expiresAt)}`
                            : ""}
                        </small>
                      </span>
                      {canManageTeam && invite.status !== "accepted" ? (
                        <div
                          className="invite-actions"
                          data-presentation-sensitive-action="true"
                        >
                          <LinkResultActionForm
                            action={resendWorkspaceInvite}
                            linkField="acceptUrl"
                          >
                            <input
                              name="inviteId"
                              type="hidden"
                              value={invite.id}
                            />
                            <PendingSubmitButton
                              className="button ghost compact-button"
                              label="Reenviar"
                              pendingLabel="Enviando..."
                            />
                          </LinkResultActionForm>
                          {invite.acceptUrl ? (
                            <CopyLinkButton url={invite.acceptUrl} />
                          ) : null}
                          {["pending", "sent", "failed"].includes(
                            invite.status,
                          ) ? (
                            <BackofficeActionForm
                              action={revokeWorkspaceInvite}
                            >
                              <input
                                name="inviteId"
                                type="hidden"
                                value={invite.id}
                              />
                              <TeamActionButton
                                confirmMessage={`Revogar o convite de ${invite.email}?`}
                                danger
                                kind="revoke"
                                label={`Revogar convite de ${invite.email}`}
                              />
                            </BackofficeActionForm>
                          ) : null}
                        </div>
                      ) : (
                        <span className="status-chip neutral">
                          {inviteStatusLabel(invite.status)}
                        </span>
                      )}
                    </div>
                  ))
                ) : (
                  <small>Nenhum convite registrado</small>
                )}
              </div>
            </aside>
          </div>
        </div>
      </section>

      <section
        className="settings-domain-section settings-conversion-domain"
        id="configuracao-conversoes"
        aria-labelledby="settings-conversion-title"
      >
        <div className="settings-domain-heading">
          <span className="settings-domain-number" aria-hidden="true">
            03
          </span>
          <div>
            <span className="eyebrow">Jornada</span>
            <h2 id="settings-conversion-title">Jornada</h2>
            <p>
              Controle a ordem e o nome das etapas do funil. As regras de
              conversão ficam em <Link href="/conversions">Conversões</Link>.
            </p>
          </div>
          <span className="status-chip">
            {visibleFunnelStageCount} etapa
            {visibleFunnelStageCount === 1 ? "" : "s"} visíve
            {visibleFunnelStageCount === 1 ? "l" : "is"}
          </span>
        </div>

        <div className="settings-automation-list">
          <details
            className="surface-panel settings-automation-details funnel-settings-panel"
            open={funnelConfiguration.state === "error"}
          >
            <summary>
              <span className="settings-automation-icon" aria-hidden="true">
                <Workflow size={19} />
              </span>
              <span className="settings-automation-copy">
                <span className="eyebrow">Jornada do funil</span>
                <strong>Etapas exibidas nos indicadores</strong>
                <small>
                  Defina a ordem e o nome que o cliente ve em Visao geral e
                  Relatorios.
                </small>
              </span>
              <span
                className={`status-chip${funnelConfiguration.state === "error" ? " warn" : ""}`}
              >
                {funnelConfiguration.state === "error"
                  ? "Configuracao indisponivel"
                  : `${visibleFunnelStageCount} etapas visiveis`}
              </span>
              <span className="settings-automation-action">
                Configurar
                <ChevronDown size={16} aria-hidden="true" />
              </span>
            </summary>
            <div className="settings-automation-body">
              {canManageConversionRules && funnelStages.length > 0 ? (
                <BackofficeActionForm
                  action={saveFunnelConfiguration}
                  className="funnel-config-form"
                >
                  <div className="funnel-config-list">
                    {funnelStages.map((stage) => (
                      <div className="funnel-stage-row" key={stage.eventName}>
                        <input
                          type="hidden"
                          name="stageEventName"
                          value={stage.eventName}
                        />
                        <label className="funnel-stage-order">
                          <span>Etapa</span>
                          <input
                            aria-label={`Ordem de ${stage.label}`}
                            defaultValue={stage.position}
                            min={1}
                            name={`stagePosition:${stage.eventName}`}
                            type="number"
                          />
                        </label>
                        <label className="funnel-stage-name">
                          <span>Nome exibido</span>
                          <input
                            aria-label={`Nome exibido de ${stage.eventName}`}
                            defaultValue={stage.label}
                            maxLength={80}
                            name={`stageLabel:${stage.eventName}`}
                          />
                          <small className="funnel-event-code">
                            {stage.eventName}
                          </small>
                        </label>
                        {eventSupportsCommercialValue(stage.eventName) ? (
                          <div className="funnel-commercial-fields">
                            <label>
                              <span>Produto ou servico</span>
                              <input
                                defaultValue={stage.defaultContentName ?? ""}
                                name={`stageProduct:${stage.eventName}`}
                                placeholder="Opcional"
                              />
                            </label>
                            <label>
                              <span>Valor medio</span>
                              <input
                                defaultValue={moneyInputValue(
                                  stage.defaultValueCents,
                                )}
                                inputMode="decimal"
                                name={`stageValue:${stage.eventName}`}
                                placeholder="0,00"
                              />
                            </label>
                            <label>
                              <span>Moeda</span>
                              <select
                                defaultValue={stage.defaultCurrency ?? ""}
                                name={`stageCurrency:${stage.eventName}`}
                              >
                                <option value="">
                                  {`Padrão do workspace (${workspaceConversionCurrency})`}
                                </option>
                                <option value="BRL">BRL</option>
                                <option value="USD">USD</option>
                                <option value="EUR">EUR</option>
                              </select>
                            </label>
                          </div>
                        ) : (
                          <span className="funnel-stage-type">
                            Evento de relacionamento
                          </span>
                        )}
                        <label className="funnel-stage-visible">
                          <input
                            defaultChecked={stage.visible}
                            name={`stageVisible:${stage.eventName}`}
                            type="checkbox"
                          />
                          <span>Visivel</span>
                        </label>
                      </div>
                    ))}
                  </div>
                  <div className="form-command-row">
                    <span>
                      As alteracoes atualizam os indicadores do workspace.
                    </span>
                    <PendingSubmitButton
                      className="button primary"
                      label="Salvar jornada"
                      pendingLabel="Salvando jornada..."
                    />
                  </div>
                </BackofficeActionForm>
              ) : (
                <p className="muted">
                  {canManageConversionRules
                    ? "Nao foi possivel carregar as etapas do funil."
                    : "Sem permissao para editar a jornada."}
                </p>
              )}
            </div>
          </details>

        </div>
      </section>

      <CurrencySettingsSection
        accounts={adAccountCurrencies}
        sectionNumber="04"
        settings={currencySettings}
      />

      <section
        className="settings-domain-section settings-ops-alerts-domain"
        id="configuracao-operacao"
        aria-labelledby="settings-ops-alerts-title"
      >
        <div className="settings-domain-heading">
          <span className="settings-domain-number" aria-hidden="true">
            05
          </span>
          <div>
            <span className="eyebrow">Operacao</span>
            <h2 id="settings-ops-alerts-title">Alertas WhatsApp</h2>
            <p>
              Aviso no celular se a instancia NOD desconectar ou o webhook ficar
              sem entrega.
            </p>
          </div>
          <span
            className={`status-chip${
              opsAlertSettings.state === "real" && opsAlertFormValues.enabled
                ? ""
                : " neutral"
            }`}
          >
            {opsAlertStatusLabel}
          </span>
        </div>

        <div className="surface-panel ops-alert-settings-panel">
          {opsAlertSettings.state === "forbidden" ? (
            <p className="muted">
              Sem permissao para gerenciar alertas operacionais.
            </p>
          ) : opsAlertSettings.state === "error" ||
            !opsAlertSettings.workspaceId ? (
            <p className="muted">
              Nao foi possivel carregar as configuracoes de alerta.
            </p>
          ) : (
            <div data-presentation-sensitive-action="true">
              <BackofficeActionForm
                action={saveOpsAlertSettingsAction}
                className="ops-alert-settings-form"
              >
                <input
                  name="workspaceId"
                  type="hidden"
                  value={opsAlertSettings.workspaceId}
                />
                <label className="ops-alert-toggle">
                  <span className="ops-alert-toggle-copy">
                    <span className="field-label">Ativar alertas</span>
                    <small>Envia aviso no telefone cadastrado abaixo.</small>
                  </span>
                  <input
                    defaultChecked={opsAlertFormValues.enabled}
                    name="enabled"
                    type="checkbox"
                  />
                </label>
                <OpsAlertPhonesEditor
                  initialPhones={opsAlertFormValues.alertPhonesE164}
                  name="alertPhones"
                />
                <div className="ops-alert-checks-group">
                  <span className="field-label">O que monitorar</span>
                  <div className="ops-alert-checks">
                    <label>
                      <input
                        defaultChecked={opsAlertFormValues.disconnectAlerts}
                        name="disconnectAlerts"
                        type="checkbox"
                      />
                      <span>Desconexao da instancia WhatsApp</span>
                    </label>
                    <label>
                      <input
                        defaultChecked={opsAlertFormValues.webhookSilenceAlerts}
                        name="webhookSilenceAlerts"
                        type="checkbox"
                      />
                      <span>Silencio de webhook</span>
                    </label>
                  </div>
                </div>
                <details className="ops-alert-advanced">
                  <summary>Configuracoes avancadas</summary>
                  <div className="ops-alert-advanced-fields">
                    <label>
                      <span className="field-label">Horas de silencio</span>
                      <input
                        defaultValue={opsAlertFormValues.silenceThresholdHours}
                        min={1}
                        name="silenceThresholdHours"
                        type="number"
                      />
                    </label>
                    <label>
                      <span className="field-label">Horas de debounce</span>
                      <input
                        defaultValue={opsAlertFormValues.debounceHours}
                        min={1}
                        name="debounceHours"
                        type="number"
                      />
                    </label>
                  </div>
                </details>
                <div className="form-command-row">
                  <span>
                    Silencio padrao 24h. Nao dispara se o telefone estiver vazio
                    ou os alertas estiverem desligados.
                  </span>
                  <PendingSubmitButton
                    className="button primary"
                    label="Salvar alertas"
                    pendingLabel="Salvando..."
                  />
                </div>
              </BackofficeActionForm>
            </div>
          )}
        </div>
      </section>
    </section>
  );
}
