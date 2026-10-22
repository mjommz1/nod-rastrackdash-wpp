// @vitest-environment jsdom
import type { InboundWebhookChannelDto } from "@wpptrack/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCurrencyProvider } from "../src/components/workspace-currency";

const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

import type {
  KommoActionResult,
  KommoConnectionDetailDto,
  KommoEventDto,
  KommoEventsResult,
  KommoRuleActionResult,
} from "../src/app/(app)/integrations/kommo-actions";
import {
  KommoCrmManager,
  type KommoCrmManagerActions,
} from "../src/app/(app)/settings/kommo-crm-manager";
import {
  KommoConversionPanel,
  parseMoneyToCents,
  type KommoConversionPanelProps,
} from "../src/app/(app)/settings/kommo-conversion-panel";

const SECRET_TOKEN = "kommo-long-lived-token-1234567890";
const WEBHOOK_URL = "https://api.example.test/inbound/kommo/AAAA-secret-BBBB";
const ROTATED_URL = "https://api.example.test/inbound/kommo/CCCC-rotated-DDDD";

const channel = {
  id: "channel_1",
  connectionId: "connection_1",
  organizationId: "organization_1",
  providerChannelId: "provider_channel_1",
  connectedPhone: "+5511999990000",
  channelName: "Comercial",
  whatsappInstanceId: null,
  status: "active",
  productionActivatedAt: "2026-07-01T00:00:00.000Z",
  firstSeenAt: "2026-07-21T10:00:00.000Z",
  lastSeenAt: "2026-07-21T11:00:00.000Z",
  routes: [
    {
      id: "route_1",
      channelId: "channel_1",
      metaBusinessConnectionId: "business_1",
      metaReportingAccountId: "reporting_1",
      metaConversionDestinationId: "destination_1",
      active: true,
      validationStatus: "valid",
      validationErrorCode: null,
      lastValidatedAt: "2026-07-21T11:00:00.000Z",
      createdAt: "2026-07-21T10:00:00.000Z",
      updatedAt: "2026-07-21T11:00:00.000Z",
    },
  ],
  readiness: {
    state: "ready",
    blockers: [],
    routeCount: 1,
    validRouteCount: 1,
    totalCtwa: 1,
    routedCtwa: 1,
    unresolvedCtwa: 0,
    retainedCtwa: 1,
    retainedRoutedCtwa: 1,
    payloadUnavailableCtwa: 0,
    alreadyMaterializedCtwa: 0,
    nextPayloadExpiresAt: null,
  },
  createdAt: "2026-07-21T10:00:00.000Z",
  updatedAt: "2026-07-21T11:00:00.000Z",
} satisfies InboundWebhookChannelDto;

const pipelineRow = {
  id: "pipeline_1",
  name: "Vendas",
  sort: 1,
  status: { id: "status_1", name: "Negociacao", type: "ordinary" },
  available: true,
};

const observationRule = {
  id: "rule_1",
  connectionId: "kommo_connection_1",
  name: "Negociacao avancada",
  pipelineId: "pipeline_1",
  statusId: "status_1",
  eventName: "QualifiedLead" as const,
  mode: "observation" as const,
  valueMode: "lead_price" as const,
  fixedValueCents: null,
  currency: null,
  contentName: null,
  active: true,
  createdAt: "2026-07-17T17:30:00.000Z",
  updatedAt: "2026-07-17T17:30:00.000Z",
};

const productionRule = {
  ...observationRule,
  id: "rule_prod",
  name: "Compra ganha",
  mode: "production" as const,
  eventName: "Purchase" as const,
  currency: "BRL",
};

function conn(overrides: Partial<KommoConnectionDetailDto> = {}): KommoConnectionDetailDto {
  return {
    id: "kommo_connection_1",
    workspaceId: "workspace_1",
    displayName: "Kommo principal",
    status: "active",
    verifiedAccountId: "account_1",
    accountSubdomain: "suaempresa",
    accountOrigin: "https://suaempresa.kommo.com",
    allowedChannelRouteIds: ["route_1"],
    credentialHealthy: true,
    catalogState: "fresh",
    catalogRefreshedAt: "2026-07-17T18:00:00.000Z",
    lastErrorCode: null,
    createdAt: "2026-07-17T17:00:00.000Z",
    updatedAt: "2026-07-17T18:00:00.000Z",
    pipelines: [pipelineRow],
    rules: [observationRule],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ok = (connection: KommoConnectionDetailDto, message = "feito"): KommoActionResult => ({
  ok: true,
  message,
  connection,
});

type Overrides = Partial<KommoConversionPanelProps>;

function makeProps(overrides: Overrides = {}): KommoConversionPanelProps {
  return {
    workspaceId: "workspace_1",
    connections: [conn()],
    loadState: "real",
    allChannels: [channel],
    canManage: true,
    licenseLocked: false,
    createConnectionAction: vi.fn(),
    replaceCredentialAction: vi.fn(),
    setStatusAction: vi.fn(),
    setChannelBindingsAction: vi.fn(),
    rotateWebhookAction: vi.fn(),
    refreshCatalogAction: vi.fn(),
    getConnectionAction: vi.fn().mockResolvedValue({ ok: false, reason: "network" }),
    createRuleAction: vi.fn(),
    updateRuleAction: vi.fn(),
    deleteRuleAction: vi.fn(),
    listEventsAction: vi.fn().mockResolvedValue({ ok: true, events: [], nextCursor: null }),
    ...overrides,
  };
}

function renderPanel(overrides: Overrides = {}) {
  const props = makeProps(overrides);
  const view = render(createElement(KommoConversionPanel, props));
  return {
    props,
    ...view,
    rerenderWith(next: Overrides) {
      Object.assign(props, next);
      view.rerender(createElement(KommoConversionPanel, { ...props }));
    },
  };
}

let scopeCounter = 0;
function freshScope() {
  scopeCounter += 1;
  return { workspaceId: `workspace_${scopeCounter}`, viewerId: `viewer_${scopeCounter}` };
}

function managerActions(overrides: Partial<KommoCrmManagerActions> = {}): KommoCrmManagerActions {
  const base = makeProps();
  return {
    createConnectionAction: base.createConnectionAction,
    replaceCredentialAction: base.replaceCredentialAction,
    setStatusAction: base.setStatusAction,
    setChannelBindingsAction: base.setChannelBindingsAction,
    rotateWebhookAction: base.rotateWebhookAction,
    refreshCatalogAction: base.refreshCatalogAction,
    listConnectionsAction: vi.fn().mockResolvedValue({ ok: false, reason: "network" }),
    getConnectionAction: base.getConnectionAction,
    createRuleAction: base.createRuleAction,
    updateRuleAction: base.updateRuleAction,
    deleteRuleAction: base.deleteRuleAction,
    listEventsAction: base.listEventsAction,
    ...overrides,
  };
}

function managerElement(
  scope: { workspaceId: string; viewerId: string },
  actions: KommoCrmManagerActions,
  connections: KommoConnectionDetailDto[],
  extra: Partial<React.ComponentProps<typeof KommoCrmManager>> = {},
) {
  return createElement(KommoCrmManager, {
    workspaceId: scope.workspaceId,
    viewerId: scope.viewerId,
    connections,
    loadState: "real",
    allChannels: [channel],
    canManage: true,
    licenseLocked: false,
    actions,
    ...extra,
  });
}

// The hub keeps the Kommo modal mounted (hidden) while closed: hiding and
// showing the manager's container mirrors close/reopen without unmounting.
function closeAndReopenManager() {
  const manager = document.querySelector("#crm-configurado") as HTMLElement;
  const container = manager.parentElement as HTMLElement;
  container.hidden = true;
  container.hidden = false;
}

const clipboard = { writeText: vi.fn() };
let storageSet: ReturnType<typeof vi.spyOn>;
let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  clipboard.writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  storageSet = vi.spyOn(Storage.prototype, "setItem");
  consoleSpies = [
    vi.spyOn(console, "log"),
    vi.spyOn(console, "info"),
    vi.spyOn(console, "warn"),
    vi.spyOn(console, "error"),
  ];
});

afterEach(() => {
  cleanup();
  routerRefresh.mockReset();
  vi.restoreAllMocks();
});

function expectNoSecretLeak(container: HTMLElement) {
  for (const spy of [storageSet, ...consoleSpies]) {
    for (const call of spy.mock.calls) {
      const text = JSON.stringify(call);
      expect(text).not.toContain(SECRET_TOKEN);
      expect(text).not.toContain("AAAA-secret-BBBB");
      expect(text).not.toContain("CCCC-rotated-DDDD");
    }
  }
  expect(container.innerHTML).not.toContain(SECRET_TOKEN);
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
}

async function connectFlow(view: ReturnType<typeof renderPanel>, token = SECRET_TOKEN) {
  fireEvent.click(screen.getByRole("button", { name: "Conectar Kommo" }));
  fireEvent.change(screen.getByLabelText("Endereço da conta Kommo"), {
    target: { value: "https://suaempresa.kommo.com" },
  });
  fireEvent.change(screen.getByLabelText("Token de acesso de longa duração"), {
    target: { value: token },
  });
  const form = screen.getByRole("form", { name: "Conectar conta Kommo" });
  await act(async () => {
    fireEvent.submit(form);
  });
  return view;
}

const created = conn({
  id: "kommo_connection_new",
  displayName: "Kommo suaempresa",
  rules: [],
});
const createSuccess = (): KommoActionResult => ({
  ok: true,
  message: "Conexão Kommo criada e catálogo carregado.",
  connection: created,
  oneTimeWebhook: { webhookUrl: WEBHOOK_URL },
});

async function mountWithSecret() {
  const createConnectionAction = vi.fn().mockResolvedValue(createSuccess());
  const view = renderPanel({ connections: [], loadState: "empty", createConnectionAction });
  await connectFlow(view);
  await screen.findByLabelText("URL do webhook Kommo");
  return { ...view, createConnectionAction };
}

describe("parseMoneyToCents", () => {
  it("parses pt-BR and plain amounts and rejects non-positive input", () => {
    expect(parseMoneyToCents("1.234,50")).toBe(123450);
    expect(parseMoneyToCents("99.9")).toBe(9990);
    expect(parseMoneyToCents("0")).toBeNull();
    expect(parseMoneyToCents("abc")).toBeNull();
    expect(parseMoneyToCents("")).toBeNull();
  });
});

describe("Kommo panel: credentials-only connection", () => {
  it("creates with address+token only, derives the name, shows the URL and a card, and clears the token", async () => {
    const { createConnectionAction, container } = await mountWithSecret();

    expect(createConnectionAction).toHaveBeenCalledTimes(1);
    const formData = (createConnectionAction.mock.calls[0] as [FormData])[0];
    expect(formData.get("workspaceId")).toBe("workspace_1");
    expect(JSON.parse(String(formData.get("payload")))).toEqual({
      displayName: "Kommo suaempresa",
      accountOrigin: "https://suaempresa.kommo.com",
      accessToken: SECRET_TOKEN,
      allowedChannelRouteIds: [],
    });

    expect((screen.getByLabelText("URL do webhook Kommo") as HTMLInputElement).value).toBe(
      WEBHOOK_URL,
    );
    expect(screen.getByText("Kommo suaempresa")).toBeTruthy();
    expect(screen.queryByLabelText("Token de acesso de longa duração")).toBeNull();
    expect(routerRefresh).toHaveBeenCalled();
    expect(screen.getByTestId("kommo-live-region").textContent).toContain(
      "Conexão Kommo criada",
    );
    expectNoSecretLeak(container);
  });

  it("rejects a short token and a non-Kommo origin locally, with plain copy", async () => {
    const createConnectionAction = vi.fn();
    const view = renderPanel({ connections: [], loadState: "empty", createConnectionAction });
    await connectFlow(view, "curto");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Informe o token de acesso completo (mínimo de 16 caracteres).",
    );

    fireEvent.change(screen.getByLabelText("Endereço da conta Kommo"), {
      target: { value: "http://evil.example.com" },
    });
    fireEvent.change(screen.getByLabelText("Token de acesso de longa duração"), {
      target: { value: SECRET_TOKEN },
    });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Conectar conta Kommo" }));
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Informe apenas o endereço HTTPS da conta Kommo",
    );
    expect(createConnectionAction).not.toHaveBeenCalled();
  });

  it("does not offer channel selection or any other field at creation", () => {
    renderPanel({ connections: [], loadState: "empty" });
    fireEvent.click(screen.getByRole("button", { name: "Conectar Kommo" }));
    const form = screen.getByRole("form", { name: "Conectar conta Kommo" });
    const names = Array.from(form.querySelectorAll("input")).map((input) => input.name);
    expect(names).toEqual(["accountOrigin", "accessToken"]);
    expect((form.querySelector("input[name=accessToken]") as HTMLInputElement).type).toBe(
      "password",
    );
  });

  it("works with zero WhatsApp channels and says channels are chosen later", () => {
    renderPanel({ connections: [conn({ allowedChannelRouteIds: [] })], allChannels: [] });
    expect(screen.getByText("Nenhum canal autorizado")).toBeTruthy();
    expect(
      screen.getByText("Nenhum número de WhatsApp foi encontrado neste workspace ainda."),
    ).toBeTruthy();
  });

  it("shows the empty state only for a genuinely empty, readable list", () => {
    renderPanel({ connections: [], loadState: "empty" });
    expect(screen.getByText(/Nenhuma conexão Kommo ainda\./)).toBeTruthy();
  });

  it("a failed or forbidden load is never shown as 'no connections yet'", () => {
    for (const loadState of ["error", "forbidden"] as const) {
      const { unmount } = renderPanel({ connections: [], loadState });
      expect(screen.queryByText(/Nenhuma conexão Kommo ainda\./)).toBeNull();
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Conectar Kommo" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
      expect(routerRefresh).toHaveBeenCalled();
      unmount();
    }
  });

  it("blocks a second creation after an unknown outcome and keeps the URL hidden", async () => {
    const createConnectionAction = vi.fn().mockResolvedValue({
      ok: false,
      message: "Não foi possível criar a conexão Kommo.",
      outcomeUnknown: true,
    });
    const listConnectionsAction = vi.fn().mockResolvedValue({ ok: true, connections: [] });
    const view = renderPanel({
      connections: [],
      loadState: "empty",
      createConnectionAction,
      listConnectionsAction,
    });
    await connectFlow(view);
    await waitFor(() => expect(listConnectionsAction).toHaveBeenCalledWith("workspace_1"));
    expect(
      await screen.findByText(/Resultado da criação não confirmado\./),
    ).toBeTruthy();
    expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull();
    // a successful (even empty) list never re-authorizes another POST
    fireEvent.click(screen.getByRole("button", { name: "Conectar Kommo" }));
    const submit = screen.getByRole("button", { name: "Conectar Kommo" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Conectar conta Kommo" }));
    });
    expect(createConnectionAction).toHaveBeenCalledTimes(1);
  });

  it("clears the typed token when the create call is rejected for permission", async () => {
    const createConnectionAction = vi.fn().mockResolvedValue({
      ok: false,
      message: "Sua sessão expirou ou você não tem permissão para esta ação.",
      authFailure: "unauthorized",
    });
    const view = renderPanel({ connections: [], loadState: "empty", createConnectionAction });
    fireEvent.click(screen.getByRole("button", { name: "Conectar Kommo" }));
    const token = screen.getByLabelText("Token de acesso de longa duração") as HTMLInputElement;
    fireEvent.change(screen.getByLabelText("Endereço da conta Kommo"), {
      target: { value: "https://suaempresa.kommo.com" },
    });
    fireEvent.change(token, { target: { value: SECRET_TOKEN } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Conectar conta Kommo" }));
    });
    await screen.findByText(/não tem permissão/);
    expect(token.value).toBe("");
    expectNoSecretLeak(view.container);
    expect(screen.getByRole("button", { name: "Conectar Kommo" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Conectar Kommo" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("a transport rejection is an unknown outcome with generic copy", async () => {
    const createConnectionAction = vi.fn().mockRejectedValue(new Error(`boom ${SECRET_TOKEN}`));
    const view = renderPanel({ connections: [], loadState: "empty", createConnectionAction });
    await connectFlow(view);
    expect((await screen.findAllByText(/Não foi possível concluir a ação\./)).length).toBeGreaterThan(0);
    expect(view.container.textContent).not.toContain(SECRET_TOKEN);
    expect(await screen.findByText(/Resultado da criação não confirmado\./)).toBeTruthy();
  });

  it("ignores a double submit while creating", async () => {
    const gate = deferred<KommoActionResult>();
    const createConnectionAction = vi.fn().mockReturnValue(gate.promise);
    const view = renderPanel({ connections: [], loadState: "empty", createConnectionAction });
    fireEvent.click(screen.getByRole("button", { name: "Conectar Kommo" }));
    fireEvent.change(screen.getByLabelText("Endereço da conta Kommo"), {
      target: { value: "https://suaempresa.kommo.com" },
    });
    fireEvent.change(screen.getByLabelText("Token de acesso de longa duração"), {
      target: { value: SECRET_TOKEN },
    });
    const form = screen.getByRole("form", { name: "Conectar conta Kommo" });
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(createConnectionAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve(createSuccess());
    });
    await screen.findByLabelText("URL do webhook Kommo");
    expectNoSecretLeak(view.container);
  });
});

describe("Kommo panel: one-time webhook URL session", () => {
  it("stays visible through passive refreshes of the same account until explicitly hidden, and is never resurrected", async () => {
    const view = await mountWithSecret();

    view.rerenderWith({ connections: [created] });
    expect(screen.getByLabelText("URL do webhook Kommo")).toBeTruthy();

    view.rerenderWith({
      connections: [{ ...created, updatedAt: "2026-07-17T19:00:00.000Z" }],
    });
    expect(screen.getByLabelText("URL do webhook Kommo")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Ocultar URL" }));
    expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull();

    view.rerenderWith({
      connections: [{ ...created, updatedAt: "2026-07-17T20:00:00.000Z" }],
    });
    expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull();
    expect(view.container.innerHTML).not.toContain("AAAA-secret-BBBB");
    expectNoSecretLeak(view.container);
  });

  it("a full remount (reload) never shows the URL again", async () => {
    const view = await mountWithSecret();
    view.unmount();
    renderPanel({ connections: [created] });
    expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull();
    expect(document.body.innerHTML).not.toContain("AAAA-secret-BBBB");
  });

  it("is hidden when the connection identity changes under the same id", async () => {
    const view = await mountWithSecret();
    view.rerenderWith({
      connections: [{ ...created, accountSubdomain: "outraempresa", accountOrigin: "https://outraempresa.kommo.com" }],
    });
    await waitFor(() => expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull());
  });

  it("is hidden when the viewer stops being able to manage", async () => {
    const view = await mountWithSecret();
    view.rerenderWith({ canManage: false });
    await waitFor(() => expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull());
    view.rerenderWith({ canManage: true });
    expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull();
  });

  it("copy success marks 'Copiada' with a live notice", async () => {
    const view = await mountWithSecret();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copiar URL" }));
    });
    expect(clipboard.writeText).toHaveBeenCalledWith(WEBHOOK_URL);
    expect(await screen.findByRole("button", { name: "Copiada" })).toBeTruthy();
    expect(screen.getByTestId("kommo-live-region").textContent).toBe("URL do webhook copiada.");
    expectNoSecretLeak(view.container);
  });

  it("copy FAILURE says so, selects the field, and does not claim success", async () => {
    clipboard.writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const view = await mountWithSecret();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copiar URL" }));
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Não foi possível copiar automaticamente. A URL está selecionada: copie manualmente.",
    );
    expect(screen.queryByRole("button", { name: "Copiada" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copiar URL" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("URL do webhook Kommo"));
    expect(screen.getByTestId("kommo-live-region").textContent).toBe("");
    expectNoSecretLeak(view.container);
  });

  it("rotation needs confirmation, keeps focus management, replaces the URL, and never rotates unasked", async () => {
    const rotateWebhookAction = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        message: "Nova URL do webhook Kommo gerada; a anterior foi invalidada.",
        oneTimeWebhook: { webhookUrl: ROTATED_URL },
      } satisfies KommoActionResult);
    const view = renderPanel({ rotateWebhookAction });
    const trigger = screen.getByRole("button", {
      name: "Gerar nova URL do webhook de Kommo principal",
    });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("alertdialog");
    expect(rotateWebhookAction).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancelar" }));

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(rotateWebhookAction).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Gerar nova URL" }));
    });
    expect(rotateWebhookAction).toHaveBeenCalledTimes(1);
    expect((await screen.findByLabelText<HTMLInputElement>("URL do webhook Kommo")).value).toBe(
      ROTATED_URL,
    );
    expectNoSecretLeak(view.container);
  });

  it("rotation replaces an existing visible URL and the old value is gone", async () => {
    const rotateWebhookAction = vi.fn().mockResolvedValue({
      ok: true,
      message: "ok",
      oneTimeWebhook: { webhookUrl: ROTATED_URL },
    } satisfies KommoActionResult);
    const view = await mountWithSecret();
    view.rerenderWith({ connections: [created], rotateWebhookAction });
    fireEvent.click(
      screen.getByRole("button", { name: "Gerar nova URL do webhook de Kommo suaempresa" }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Gerar nova URL" }));
    });
    await waitFor(() =>
      expect((screen.getByLabelText("URL do webhook Kommo") as HTMLInputElement).value).toBe(
        ROTATED_URL,
      ),
    );
    expect(view.container.innerHTML).not.toContain("AAAA-secret-BBBB");
  });

  it("a rotation whose outcome is unknown hides the URL and locks the connection", async () => {
    const rotateWebhookAction = vi.fn().mockResolvedValue({
      ok: false,
      message: "Não foi possível gerar uma nova URL de webhook.",
      outcomeUnknown: true,
    } satisfies KommoActionResult);
    const view = await mountWithSecret();
    view.rerenderWith({ connections: [created], rotateWebhookAction });
    fireEvent.click(
      screen.getByRole("button", { name: "Gerar nova URL do webhook de Kommo suaempresa" }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Gerar nova URL" }));
    });
    await waitFor(() => expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull());
    expect(await screen.findByText(/Requisição sem resposta final\./)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Gerar nova URL do webhook de Kommo suaempresa",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("a late create response cannot resurrect a URL after the viewer lost permission", async () => {
    const gate = deferred<KommoActionResult>();
    const createConnectionAction = vi.fn().mockReturnValue(gate.promise);
    const view = renderPanel({ connections: [], loadState: "empty", createConnectionAction });
    fireEvent.click(screen.getByRole("button", { name: "Conectar Kommo" }));
    fireEvent.change(screen.getByLabelText("Endereço da conta Kommo"), {
      target: { value: "https://suaempresa.kommo.com" },
    });
    fireEvent.change(screen.getByLabelText("Token de acesso de longa duração"), {
      target: { value: SECRET_TOKEN },
    });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Conectar conta Kommo" }));
    });
    view.rerenderWith({ canManage: false });
    await act(async () => {
      gate.resolve(createSuccess());
    });
    expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull();
    expect(view.container.innerHTML).not.toContain("AAAA-secret-BBBB");
  });
});

describe("Kommo panel: ownership and license", () => {
  it("members see a note and no mutation controls", () => {
    renderPanel({ canManage: false });
    expect(
      screen.getByText("Somente o proprietário do workspace gerencia a integração Kommo."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Conectar Kommo" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Pausar conexão/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Gerar nova URL/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Salvar canais" })).toBeNull();
  });

  it("a locked license disables writes with safe copy but keeps the audit readable", async () => {
    const listEventsAction = vi.fn().mockResolvedValue({
      ok: true,
      events: [
        {
          id: "e1",
          dealId: "77",
          pipelineId: "pipeline_1",
          statusId: "status_1",
          status: "observed",
          errorCode: null,
          errorMessage: null,
          attempts: 1,
          results: [],
        },
      ],
      nextCursor: null,
    });
    renderPanel({ licenseLocked: true, listEventsAction });
    expect(screen.getAllByText(/Licença bloqueada: criar, editar, pausar ou ativar envio/).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Conectar Kommo" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Pausar conexão/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Gerar nova URL/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Nova regra" })).toBeNull();

    fireEvent.click(screen.getByText("Auditoria de webhooks", { selector: "summary span" }));
    fireEvent.click(await screen.findByRole("button", { name: "Consultar auditoria" }));
    expect(await screen.findByText("Lead Kommo #77")).toBeTruthy();
    expect(listEventsAction).toHaveBeenCalledWith("workspace_1", "kommo_connection_1", undefined);
  });

  it("the server's 423 locks the writes for this mount even if the page thought it was unlocked", async () => {
    const setStatusAction = vi.fn().mockResolvedValue({
      ok: false,
      message: "Licença bloqueada: alterações indisponíveis.",
      licenseLocked: true,
    } satisfies KommoActionResult);
    renderPanel({ setStatusAction, getConnectionAction: vi.fn().mockResolvedValue({ ok: true, connection: conn() }) });
    fireEvent.click(screen.getByRole("button", { name: "Pausar conexão Kommo principal" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pausar conexão" }));
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Pausar conexão Kommo principal" })).toBeNull(),
    );
    expect(screen.getAllByText(/Licença bloqueada/).length).toBeGreaterThan(0);
  });

  it("an auth failure hides the controls and the one-time URL for the rest of the mount", async () => {
    const setStatusAction = vi.fn().mockResolvedValue({
      ok: false,
      message: "Sua sessão expirou ou você não tem permissão para esta ação.",
      authFailure: "unauthorized",
    } satisfies KommoActionResult);
    const view = await mountWithSecret();
    view.rerenderWith({ connections: [created], setStatusAction });
    fireEvent.click(screen.getByRole("button", { name: "Pausar conexão Kommo suaempresa" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pausar conexão" }));
    });
    await waitFor(() => expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull());
    expect(screen.queryByRole("button", { name: /Pausar conexão Kommo/ })).toBeNull();
    expect((screen.getByRole("button", { name: "Conectar Kommo" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Kommo panel: confirmations for production paths", () => {
  const pausedWithProduction = () =>
    conn({ status: "paused", rules: [productionRule, observationRule] });

  it("resume with a live production rule asks first and rechecks at the final handler", async () => {
    const setStatusAction = vi.fn().mockResolvedValue(ok(conn()));
    renderPanel({ connections: [pausedWithProduction()], setStatusAction });
    fireEvent.click(screen.getByRole("button", { name: "Retomar conexão Kommo principal" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Retomar esta conexão? 1 regra(s)");
    expect(setStatusAction).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Retomar envio automático" }));
    });
    expect(setStatusAction).toHaveBeenCalledTimes(1);
    const formData = (setStatusAction.mock.calls[0] as [FormData])[0];
    expect(formData.get("status")).toBe("active");
  });

  it("resume without production rules needs no confirmation", async () => {
    const setStatusAction = vi.fn().mockResolvedValue(ok(conn()));
    renderPanel({ connections: [conn({ status: "paused" })], setStatusAction });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retomar conexão Kommo principal" }));
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(setStatusAction).toHaveBeenCalledTimes(1);
  });

  it("a confirmation opened earlier cannot be approved after the state changed underneath it", async () => {
    const setStatusAction = vi.fn().mockResolvedValue(ok(conn()));
    const getConnectionAction = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "network" });
    const view = renderPanel({
      connections: [pausedWithProduction()],
      setStatusAction,
      getConnectionAction,
    });
    fireEvent.click(screen.getByRole("button", { name: "Retomar conexão Kommo principal" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    view.rerenderWith({
      connections: [
        { ...pausedWithProduction(), updatedAt: "2026-07-17T19:00:00.000Z", catalogState: "stale" },
      ],
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(setStatusAction).not.toHaveBeenCalled();
  });

  it("loses the confirmation if the viewer loses manage permission", () => {
    const setStatusAction = vi.fn();
    const view = renderPanel({ connections: [pausedWithProduction()], setStatusAction });
    fireEvent.click(screen.getByRole("button", { name: "Retomar conexão Kommo principal" }));
    view.rerenderWith({ canManage: false });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(setStatusAction).not.toHaveBeenCalled();
  });

  it("does not confirm when the license locks mid-dialog", () => {
    const setStatusAction = vi.fn();
    const view = renderPanel({ connections: [pausedWithProduction()], setStatusAction });
    fireEvent.click(screen.getByRole("button", { name: "Retomar conexão Kommo principal" }));
    view.rerenderWith({ licenseLocked: true });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(setStatusAction).not.toHaveBeenCalled();
  });

  it("catalog refresh that could re-enable production asks first", async () => {
    const refreshCatalogAction = vi.fn().mockResolvedValue(ok(conn()));
    renderPanel({
      connections: [conn({ catalogState: "stale", rules: [productionRule] })],
      refreshCatalogAction,
    });
    fireEvent.click(screen.getByRole("button", { name: "Atualizar catálogo de Kommo principal" }));
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "reativar imediatamente o envio automático",
    );
    expect(refreshCatalogAction).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Atualizar e ativar envio" }));
    });
    expect(refreshCatalogAction).toHaveBeenCalledTimes(1);
  });

  it("pause asks for confirmation and a cancel issues no mutation", () => {
    const setStatusAction = vi.fn();
    renderPanel({ setStatusAction });
    fireEvent.click(screen.getByRole("button", { name: "Pausar conexão Kommo principal" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(setStatusAction).not.toHaveBeenCalled();
  });

  it("credential replacement validates, resets the field and gates production rules", async () => {
    const replaceCredentialAction = vi.fn().mockResolvedValue(ok(conn()));
    const view = renderPanel({
      connections: [conn({ rules: [productionRule] })],
      replaceCredentialAction,
    });
    const form = screen.getByRole("form", { name: "Substituir credenciais da Kommo" });
    const token = within(form).getByLabelText("Novo token de acesso") as HTMLInputElement;

    await act(async () => {
      fireEvent.submit(form);
    });
    expect(screen.getByRole("alert").textContent).toContain("Informe o novo token de acesso.");

    fireEvent.change(token, { target: { value: "curto" } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(screen.getByRole("alert").textContent).toContain("mínimo de 16 caracteres");
    expect(replaceCredentialAction).not.toHaveBeenCalled();

    fireEvent.change(token, { target: { value: SECRET_TOKEN } });
    // production rule is live and the connection is dispatching: no gate needed
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(replaceCredentialAction).toHaveBeenCalledTimes(1);
    expect(token.value).toBe("");
    expectNoSecretLeak(view.container);
  });

  it("credential replacement for a non-dispatching connection with production rules asks first", async () => {
    const replaceCredentialAction = vi.fn().mockResolvedValue(ok(conn()));
    renderPanel({
      connections: [conn({ credentialHealthy: false, rules: [productionRule] })],
      replaceCredentialAction,
    });
    const form = screen.getByRole("form", { name: "Substituir credenciais da Kommo" });
    fireEvent.change(within(form).getByLabelText("Novo token de acesso"), {
      target: { value: SECRET_TOKEN },
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(replaceCredentialAction).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "Substituir a credencial pode reativar",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Substituir e ativar envio" }));
    });
    expect(replaceCredentialAction).toHaveBeenCalledTimes(1);
  });
});

describe("Kommo panel: unknown operations and ordering", () => {
  it("an unknown status result locks the connection until explicit confirmation, and router.refresh never unlocks it", async () => {
    const setStatusAction = vi.fn().mockResolvedValue({
      ok: false,
      message: "Não foi possível alterar o status da conexão Kommo.",
      outcomeUnknown: true,
    } satisfies KommoActionResult);
    const getConnectionAction = vi.fn().mockResolvedValue({ ok: true, connection: conn() });
    const view = renderPanel({ setStatusAction, getConnectionAction });
    fireEvent.click(screen.getByRole("button", { name: "Pausar conexão Kommo principal" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pausar conexão" }));
    });
    expect(await screen.findByText(/Requisição sem resposta final\./)).toBeTruthy();
    expect(screen.getByText("Estado lido; ação não concluída")).toBeTruthy();
    const pause = screen.getByRole("button", { name: "Pausar conexão Kommo principal" });
    expect((pause as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Atualizar catálogo de Kommo principal" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // a router refresh with a fresh-looking prop proves nothing
    view.rerenderWith({ connections: [conn()] });
    view.rerenderWith({ connections: [{ ...conn(), updatedAt: "2026-07-17T19:00:00.000Z" }] });
    await waitFor(() => expect(getConnectionAction).toHaveBeenCalled());
    expect((screen.getByRole("button", { name: "Pausar conexão Kommo principal" }) as HTMLButtonElement).disabled).toBe(true);
    expect(setStatusAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Catálogo atualizado")).toBeNull();
  });

  it("a thrown action is also an unknown operation", async () => {
    const setStatusAction = vi.fn().mockRejectedValue(new Error("socket hang up"));
    renderPanel({ setStatusAction });
    fireEvent.click(screen.getByRole("button", { name: "Pausar conexão Kommo principal" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pausar conexão" }));
    });
    expect(await screen.findByText(/Requisição sem resposta final\./)).toBeTruthy();
    expect(screen.getAllByText(/Não foi possível concluir a ação\./).length).toBeGreaterThan(0);
  });

  it("a read failure after a definitive failure keeps the state 'não confirmado' with a retry", async () => {
    const setStatusAction = vi.fn().mockResolvedValue({
      ok: false,
      message: "Não foi possível alterar o status da conexão Kommo.",
    } satisfies KommoActionResult);
    const getConnectionAction = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "network" })
      .mockResolvedValueOnce({ ok: true, connection: conn() });
    renderPanel({ setStatusAction, getConnectionAction });
    fireEvent.click(screen.getByRole("button", { name: "Pausar conexão Kommo principal" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pausar conexão" }));
    });
    expect(await screen.findByText("Estado não confirmado")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirmar estado atual" }));
    });
    await waitFor(() => expect(screen.queryByText("Estado não confirmado")).toBeNull());
    expect(screen.getByText("Catálogo atualizado")).toBeTruthy();
  });

  it("an out-of-order passive read cannot overwrite a newer local operation", async () => {
    const slowRead = deferred<{ ok: true; connection: KommoConnectionDetailDto }>();
    const getConnectionAction = vi.fn().mockReturnValueOnce(slowRead.promise);
    const setStatusAction = vi.fn().mockResolvedValue({
      ok: false,
      message: "Não foi possível alterar o status da conexão Kommo.",
    } satisfies KommoActionResult);
    renderPanel({ setStatusAction, getConnectionAction });

    fireEvent.click(screen.getByRole("button", { name: "Pausar conexão Kommo principal" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pausar conexão" }));
    });
    await waitFor(() => expect(getConnectionAction).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Estado não confirmado")).toBeTruthy();

    // the late response is older than what the panel already holds
    await act(async () => {
      slowRead.resolve({
        ok: true,
        connection: conn({ status: "paused", updatedAt: "2026-07-17T10:00:00.000Z" }),
      });
    });
    expect(screen.queryByText("Pausada", { selector: ".event-chip" })).toBeNull();
    expect(screen.getByText("Ativa", { selector: ".event-chip" })).toBeTruthy();
    expect(screen.getByText("Estado não confirmado")).toBeTruthy();
  });

  it("a pending mutation blocks the other connection actions", async () => {
    const gate = deferred<KommoActionResult>();
    const refreshCatalogAction = vi.fn().mockReturnValue(gate.promise);
    renderPanel({ refreshCatalogAction });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Atualizar catálogo de Kommo principal" }));
    });
    expect(
      (screen.getByRole("button", { name: "Pausar conexão Kommo principal" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Gerar nova URL do webhook de Kommo principal" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      gate.resolve(ok(conn()));
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Pausar conexão Kommo principal" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("lists numbers of any provider, authorizes an inheriting number by its channel id and explains the blocked ones", async () => {
    const number = (id: string, patch: Record<string, unknown>) => ({
      ...channel,
      id,
      providerChannelId: `provider_${id}`,
      routes: [],
      ...patch,
      readiness: {
        ...channel.readiness,
        routeCount: 0,
        validRouteCount: 0,
        ...((patch.readiness as object) ?? {}),
      },
    });
    const setChannelBindingsAction = vi
      .fn()
      .mockResolvedValue(ok(conn({ allowedChannelRouteIds: ["channel_inherit"] })));
    renderPanel({
      connections: [conn({ allowedChannelRouteIds: [] })],
      setChannelBindingsAction,
      allChannels: [
        channel,
        number("channel_inherit", {
          channelName: "Cloud API",
          readiness: {
            crmDestinationReadiness: {
              status: "verified",
              reason: "verified_workspace_destination",
            },
          },
        }),
        number("channel_paused", { channelName: "Pausado", status: "paused" }),
        number("channel_no_meta", { channelName: "Sem Meta" }),
      ] as never,
    });

    const box = (name: RegExp) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
    expect(box(/Comercial/).disabled).toBe(false);
    expect(box(/Cloud API/).disabled).toBe(false);
    expect(box(/Pausado/).disabled).toBe(true);
    expect(box(/Sem Meta/).disabled).toBe(true);
    expect(screen.getByText(/Número de WhatsApp pausado/)).toBeTruthy();
    expect(screen.getByText(/ainda não tem destino Meta verificado/)).toBeTruthy();

    fireEvent.click(box(/Cloud API/));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Salvar canais" }));
    });
    const formData = (setChannelBindingsAction.mock.calls[0] as [FormData])[0];
    expect(JSON.parse(String(formData.get("payload")))).toEqual({
      allowedChannelRouteIds: ["channel_inherit"],
    });
  });

  it("channel bindings save only with a confirmed state", async () => {
    const setChannelBindingsAction = vi.fn().mockResolvedValue(ok(conn({ allowedChannelRouteIds: [] })));
    renderPanel({ setChannelBindingsAction });
    fireEvent.click(screen.getByRole("checkbox", { name: /Comercial/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Salvar canais" }));
    });
    expect(setChannelBindingsAction).toHaveBeenCalledTimes(1);
    const formData = (setChannelBindingsAction.mock.calls[0] as [FormData])[0];
    expect(JSON.parse(String(formData.get("payload")))).toEqual({ allowedChannelRouteIds: [] });
  });
});

describe("Kommo panel: rules", () => {
  async function openRuleForm(overrides: Overrides = {}) {
    const view = renderPanel(overrides);
    fireEvent.click(screen.getByRole("button", { name: "Nova regra" }));
    return view;
  }

  function chooseProductionMode() {
    const select = screen
      .getByRole("form", { name: "Nova regra Kommo" })
      .querySelector("select[name=mode]") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "production" } });
  }

  function fillBasics(stage = "pipeline_1::status_1") {
    const form = within(screen.getByRole("form", { name: "Nova regra Kommo" }));
    fireEvent.change(form.getByLabelText("Nome da regra"), { target: { value: "Compra ganha" } });
    fireEvent.change(form.getByLabelText("Pipeline e estágio na Kommo"), {
      target: { value: stage },
    });
  }

  it("creates an observation rule without confirmation and labels it as no-send", async () => {
    const createRuleAction = vi.fn().mockResolvedValue({
      ok: true,
      message: "Regra Kommo criada.",
      rule: { ...observationRule, id: "rule_new", name: "Compra ganha" },
    } satisfies KommoRuleActionResult);
    await openRuleForm({ createRuleAction });
    expect(
      screen.getByRole("option", { name: "Observar primeiro (nada é enviado ao Meta)" }),
    ).toBeTruthy();
    fillBasics();
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Nova regra Kommo" }));
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(createRuleAction).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String((createRuleAction.mock.calls[0] as [FormData])[0].get("payload")));
    expect(payload).toMatchObject({
      name: "Compra ganha",
      pipelineId: "pipeline_1",
      statusId: "status_1",
      mode: "observation",
    });
    await waitFor(() =>
      expect(screen.getAllByText("Observação (nada é enviado)").length).toBeGreaterThanOrEqual(2),
    );
  });

  it("requires the currency for a value-carrying event", async () => {
    const createRuleAction = vi.fn();
    await openRuleForm({ createRuleAction });
    fillBasics();
    const ruleForm = within(screen.getByRole("form", { name: "Nova regra Kommo" }));
    fireEvent.change(ruleForm.getByLabelText("Conversão disparada"), { target: { value: "Purchase" } });
    const currency = ruleForm.getByLabelText(/Moeda/) as HTMLSelectElement;
    fireEvent.change(currency, { target: { value: "" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Nova regra Kommo" }));
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Escolha a moeda (Real, Dólar ou Euro).",
    );
    expect(createRuleAction).not.toHaveBeenCalled();
  });

  it.each(["BRL", "USD", "EUR"] as const)(
    "starts a new rule on the workspace currency (%s) and sends it with the lead price",
    async (workspaceCurrency) => {
      const createRuleAction = vi.fn().mockResolvedValue({
        ok: true,
        message: "Regra Kommo criada.",
        rule: { ...productionRule, id: "rule_cur", currency: workspaceCurrency },
      } satisfies KommoRuleActionResult);
      const props = makeProps({ createRuleAction });
      render(
        createElement(
          WorkspaceCurrencyProvider,
          { currency: workspaceCurrency },
          createElement(KommoConversionPanel, props),
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "Nova regra" }));
      fillBasics();
      const ruleForm = within(screen.getByRole("form", { name: "Nova regra Kommo" }));
      fireEvent.change(ruleForm.getByLabelText("Conversão disparada"), {
        target: { value: "Purchase" },
      });
      const currency = ruleForm.getByLabelText(/Moeda/) as HTMLSelectElement;
      expect(currency.tagName).toBe("SELECT");
      expect(currency.value).toBe(workspaceCurrency);
      expect(
        Array.from(currency.options).map((option) => option.value).filter(Boolean),
      ).toEqual(["BRL", "USD", "EUR"]);

      await act(async () => {
        fireEvent.submit(screen.getByRole("form", { name: "Nova regra Kommo" }));
      });
      expect(createRuleAction).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(
        String((createRuleAction.mock.calls[0] as [FormData])[0].get("payload")),
      );
      expect(payload).toMatchObject({
        eventName: "Purchase",
        valueMode: "lead_price",
        currency: workspaceCurrency,
      });
    },
  );

  it("keeps the stored currency when editing and lets the user change it", async () => {
    const stored = { ...productionRule, id: "rule_edit", currency: "EUR" };
    const updateRuleAction = vi.fn().mockResolvedValue({
      ok: true,
      message: "Regra Kommo atualizada.",
      rule: { ...stored, currency: "USD" },
    } satisfies KommoRuleActionResult);
    render(
      createElement(
        WorkspaceCurrencyProvider,
        { currency: "BRL" },
        createElement(
          KommoConversionPanel,
          makeProps({
            connections: [conn({ rules: [stored] })],
            updateRuleAction,
          }),
        ),
      ),
    );
    const details = screen.getByText("Editar regra").closest("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    const form = within(screen.getByRole("form", { name: /Editar regra/ }));
    const currency = form.getByLabelText(/Moeda/) as HTMLSelectElement;
    expect(currency.value).toBe("EUR");
    fireEvent.change(currency, { target: { value: "USD" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: /Editar regra/ }));
    });
    const payload = JSON.parse(
      String((updateRuleAction.mock.calls[0] as [FormData])[0].get("payload")),
    );
    expect(payload).toMatchObject({ currency: "USD" });
  });

  it("a fixed value needs an amount", async () => {
    const createRuleAction = vi.fn();
    await openRuleForm({ createRuleAction });
    fillBasics();
    const ruleForm = within(screen.getByRole("form", { name: "Nova regra Kommo" }));
    fireEvent.change(ruleForm.getByLabelText("Conversão disparada"), { target: { value: "Purchase" } });
    fireEvent.click(ruleForm.getByRole("radio", { name: /Valor fixo/ }));
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Nova regra Kommo" }));
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(createRuleAction).not.toHaveBeenCalled();
  });

  it("creating straight into production needs an explicit confirmation", async () => {
    const createRuleAction = vi.fn().mockResolvedValue({
      ok: true,
      message: "Regra Kommo criada.",
      rule: { ...productionRule, id: "rule_new2" },
    } satisfies KommoRuleActionResult);
    await openRuleForm({ createRuleAction });
    fillBasics();
    chooseProductionMode();
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Nova regra Kommo" }));
    });
    expect(createRuleAction).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Criar esta regra já com envio automático ativo?");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Criar e ativar envio" }));
    });
    expect(createRuleAction).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((createRuleAction.mock.calls[0] as [FormData])[0].get("payload"))).mode).toBe(
      "production",
    );
  });

  it("an approved production creation is dropped if the state changes before the final click", async () => {
    const createRuleAction = vi.fn();
    const view = await openRuleForm({ createRuleAction });
    fillBasics();
    chooseProductionMode();
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Nova regra Kommo" }));
    });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    view.rerenderWith({ canManage: false });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(createRuleAction).not.toHaveBeenCalled();
  });

  it("renders honest rule chips and per-rule actions", () => {
    renderPanel({ connections: [conn({ rules: [observationRule, productionRule, { ...observationRule, id: "rule_p", name: "Parada", active: false }] })] });
    expect(screen.getByText("Observação (nada é enviado)")).toBeTruthy();
    expect(screen.getByText("Envio ativo (produção)")).toBeTruthy();
    expect(screen.getByText("Pausada", { selector: ".event-chip" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pausar regra Negociacao avancada" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ativar envio automático: Negociacao avancada" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Voltar para observação: Compra ganha" })).toBeTruthy();
  });

  it("activating a rule asks for confirmation before any mutation", async () => {
    const updateRuleAction = vi.fn().mockResolvedValue({
      ok: true,
      message: "Regra Kommo atualizada.",
      rule: { ...observationRule, mode: "production" },
    } satisfies KommoRuleActionResult);
    renderPanel({ updateRuleAction });
    fireEvent.click(screen.getByRole("button", { name: "Ativar envio automático: Negociacao avancada" }));
    expect(updateRuleAction).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Ativar o envio automático desta regra?");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Ativar envio" }));
    });
    expect(updateRuleAction).toHaveBeenCalledTimes(1);
  });

  it("deleting needs a confirmation and Escape cancels it", () => {
    const deleteRuleAction = vi.fn();
    renderPanel({ deleteRuleAction });
    fireEvent.click(screen.getByRole("button", { name: "Remover regra Negociacao avancada" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Remover esta regra? Esta ação não pode ser desfeita.");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(deleteRuleAction).not.toHaveBeenCalled();
  });

  it("explains what 202 and observation mean and never promises a send", () => {
    const { container } = renderPanel();
    expect(container.textContent).toContain("Regras em observação não enviam nada ao Meta.");
    expect(container.textContent).toContain("o aceite (202) do webhook da Kommo só significa que o evento entrou para processamento");
  });
});

describe("Kommo panel: audit authorization loss revokes everything", () => {
  const auditEvent = (id: string): KommoEventDto => ({
    id,
    dealId: `deal_${id}`,
    pipelineId: "pipeline_1",
    statusId: "status_1",
    status: "observed",
    errorCode: null,
    errorMessage: null,
    attempts: 1,
    results: [],
  });

  async function mountWithSecretRuleAndAudit(listEventsAction: ReturnType<typeof vi.fn>) {
    const withRule = conn({
      id: "kommo_connection_new",
      displayName: "Kommo suaempresa",
      rules: [observationRule],
    });
    const updateRuleAction = vi.fn();
    const deleteRuleAction = vi.fn();
    const view = renderPanel({
      connections: [],
      loadState: "empty",
      createConnectionAction: vi.fn().mockResolvedValue({ ...createSuccess(), connection: withRule }),
      listEventsAction,
      updateRuleAction,
      deleteRuleAction,
    });
    await connectFlow(view);
    await screen.findByLabelText("URL do webhook Kommo");
    return { ...view, withRule, updateRuleAction, deleteRuleAction };
  }

  async function consultAudit() {
    fireEvent.click(screen.getByText("Auditoria de webhooks", { selector: "summary span" }));
    fireEvent.click(await screen.findByRole("button", { name: "Consultar auditoria" }));
  }

  function expectPositivePreconditions() {
    expect(screen.getByLabelText("URL do webhook Kommo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copiar URL" })).toBeTruthy();
    expect(screen.getByText("Lead Kommo #deal_e1")).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  }

  function expectEverythingRevoked(container: HTMLElement) {
    expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copiar URL" })).toBeNull();
    expect(container.innerHTML).not.toContain("AAAA-secret-BBBB");
    expect(screen.queryByText("Lead Kommo #deal_e1")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Ativar envio automático/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remover regra/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Carregar mais eventos" })).toBeNull();
  }

  it.each([
    ["refresh", "Atualizar auditoria"],
    ["paging", "Carregar mais eventos"],
  ])(
    "an unauthorized audit %s clears URL, rows and production consent, and nothing can revive them",
    async (_label, buttonName) => {
      const listEventsAction = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, events: [auditEvent("e1")], nextCursor: "e1" })
        .mockResolvedValueOnce({ ok: false, reason: "unauthorized" });
      const view = await mountWithSecretRuleAndAudit(listEventsAction);
      await consultAudit();
      await screen.findByText("Lead Kommo #deal_e1");
      fireEvent.click(
        screen.getByRole("button", { name: "Ativar envio automático: Negociacao avancada" }),
      );
      expectPositivePreconditions();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: buttonName }));
      });

      await waitFor(() => expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull());
      expectEverythingRevoked(view.container);
      expect(view.updateRuleAction).not.toHaveBeenCalled();
      expect(
        screen.getAllByText(/Somente o proprietário do workspace/).length,
      ).toBeGreaterThan(0);
      const consult = screen.getByRole("button", { name: "Consultar auditoria" }) as HTMLButtonElement;
      expect(consult.disabled).toBe(true);
      fireEvent.click(consult);
      expect(listEventsAction).toHaveBeenCalledTimes(2);

      // A later prop refresh (even a newer updatedAt) cannot restore consent or the URL.
      view.rerenderWith({
        connections: [{ ...view.withRule, updatedAt: "2026-07-18T10:00:00.000Z" }],
      });
      expectEverythingRevoked(view.container);
      expectNoSecretLeak(view.container);
    },
  );

  it("a transient audit error keeps the last-known rows and does not revoke authorization", async () => {
    const listEventsAction = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, events: [auditEvent("e1")], nextCursor: null })
      .mockResolvedValueOnce({ ok: false, reason: "network" });
    const view = await mountWithSecretRuleAndAudit(listEventsAction);
    await consultAudit();
    await screen.findByText("Lead Kommo #deal_e1");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Atualizar auditoria" }));
    });
    await screen.findByText(/Não foi possível carregar a auditoria agora/);
    expect(screen.getByText("Lead Kommo #deal_e1")).toBeTruthy();
    expect(screen.getByLabelText("URL do webhook Kommo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ativar envio automático: Negociacao avancada" })).toBeTruthy();
    expectNoSecretLeak(view.container);
  });

  it("an older successful audit read that lands after an unauthorized remount cannot resurrect rows", async () => {
    const olderRead = deferred<KommoEventsResult>();
    const listEventsAction = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, events: [auditEvent("e1")], nextCursor: null })
      .mockReturnValueOnce(olderRead.promise)
      .mockResolvedValueOnce({ ok: false, reason: "unauthorized" });
    const view = await mountWithSecretRuleAndAudit(listEventsAction);
    await consultAudit();
    await screen.findByText("Lead Kommo #deal_e1");
    expect(screen.getByLabelText("URL do webhook Kommo")).toBeTruthy();

    // Older read A is still in flight when the panel is closed and reopened.
    fireEvent.click(screen.getByRole("button", { name: "Atualizar auditoria" }));
    const summary = screen.getByText("Auditoria de webhooks", { selector: "summary span" });
    fireEvent.click(summary);
    await waitFor(() => expect(screen.queryByTestId("kommo-audit-panel")).toBeNull());
    fireEvent.click(summary);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Consultar auditoria" }));
    });
    await waitFor(() => expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull());

    await act(async () => {
      olderRead.resolve({ ok: true, events: [auditEvent("late")], nextCursor: null });
    });
    expect(screen.queryByText("Lead Kommo #deal_late")).toBeNull();
    expect(screen.queryByText("Lead Kommo #deal_e1")).toBeNull();

    // Closing and reopening again keeps the revoked state: the parent is authoritative.
    fireEvent.click(summary);
    await waitFor(() => expect(screen.queryByTestId("kommo-audit-panel")).toBeNull());
    fireEvent.click(summary);
    const reopened = await screen.findByRole("button", { name: "Consultar auditoria" });
    expect((reopened as HTMLButtonElement).disabled).toBe(true);
    expect(listEventsAction).toHaveBeenCalledTimes(3);
    expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull();
    expect(view.container.innerHTML).not.toContain("AAAA-secret-BBBB");
  });

  it("an auth failure raised by a mutation voids an in-flight audit read from the parent", async () => {
    const inFlight = deferred<KommoEventsResult>();
    const listEventsAction = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, events: [auditEvent("e1")], nextCursor: null })
      .mockReturnValueOnce(inFlight.promise);
    const view = await mountWithSecretRuleAndAudit(listEventsAction);
    view.deleteRuleAction.mockResolvedValue({
      ok: false,
      message: "Sua sessão expirou ou você não tem permissão para esta ação.",
      authFailure: "unauthorized",
    } satisfies KommoRuleActionResult);
    await consultAudit();
    await screen.findByText("Lead Kommo #deal_e1");
    fireEvent.click(screen.getByRole("button", { name: "Atualizar auditoria" }));

    fireEvent.click(screen.getByRole("button", { name: "Remover regra Negociacao avancada" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remover" }));
    });
    await waitFor(() => expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull());
    expect(screen.queryByText("Lead Kommo #deal_e1")).toBeNull();

    await act(async () => {
      inFlight.resolve({ ok: true, events: [auditEvent("late")], nextCursor: null });
    });
    expect(screen.queryByText("Lead Kommo #deal_late")).toBeNull();
    expect(screen.queryByText("Lead Kommo #deal_e1")).toBeNull();
    expectNoSecretLeak(view.container);
  });
});

describe("KommoCrmManager: single mount and persistence of locks", () => {
  it("renders one manager section with the stable anchor", () => {
    const scope = freshScope();
    render(managerElement(scope, managerActions(), [conn()]));
    const sections = document.querySelectorAll("#crm-configurado");
    expect(sections).toHaveLength(1);
    expect(sections[0].getAttribute("data-testid")).toBe("kommo-crm-manager");
  });

  
  it("an unknown operation survives close/reopen and a remount for the same account, not for another", async () => {
    const scope = freshScope();
    const setStatusAction = vi.fn().mockResolvedValue({
      ok: false,
      message: "Não foi possível alterar o status da conexão Kommo.",
      outcomeUnknown: true,
    } satisfies KommoActionResult);
    const getConnectionAction = vi.fn().mockResolvedValue({ ok: true, connection: conn() });
    const actions = managerActions({ setStatusAction, getConnectionAction });
    const view = render(managerElement(scope, actions, [conn()]));

    fireEvent.click(screen.getByRole("button", { name: "Pausar conexão Kommo principal" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pausar conexão" }));
    });
    expect(await screen.findByText(/Requisição sem resposta final\./)).toBeTruthy();

    closeAndReopenManager();
    expect(screen.getByText(/Requisição sem resposta final\./)).toBeTruthy();

    view.unmount();
    render(managerElement(scope, actions, [conn()]));
    expect(screen.getByText(/Requisição sem resposta final\./)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Pausar conexão Kommo principal" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(setStatusAction).toHaveBeenCalledTimes(1);

    cleanup();
    render(managerElement({ ...scope, viewerId: "another_viewer" }, actions, [conn()]));
    expect(screen.queryByText(/Requisição sem resposta final\./)).toBeNull();
  });

  it("an unresolved creation survives a remount for the same account", async () => {
    const scope = freshScope();
    const createConnectionAction = vi.fn().mockResolvedValue({
      ok: false,
      message: "Não foi possível criar a conexão Kommo.",
      outcomeUnknown: true,
    } satisfies KommoActionResult);
    const actions = managerActions({ createConnectionAction });
    const view = render(managerElement(scope, actions, [], { loadState: "empty" }));
    fireEvent.click(screen.getByRole("button", { name: "Conectar Kommo" }));
    fireEvent.change(screen.getByLabelText("Endereço da conta Kommo"), {
      target: { value: "https://suaempresa.kommo.com" },
    });
    fireEvent.change(screen.getByLabelText("Token de acesso de longa duração"), {
      target: { value: SECRET_TOKEN },
    });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Conectar conta Kommo" }));
    });
    expect(await screen.findByText(/Resultado da criação não confirmado\./)).toBeTruthy();

    view.unmount();
    render(managerElement(scope, actions, [], { loadState: "empty" }));
    expect(screen.getByText(/Resultado da criação não confirmado\./)).toBeTruthy();
    expect(createConnectionAction).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).not.toContain(SECRET_TOKEN);
  });

  it("switching workspace or account drops a visible URL", async () => {
    const scope = freshScope();
    const createConnectionAction = vi.fn().mockResolvedValue(createSuccess());
    const actions = managerActions({ createConnectionAction });
    const view = render(managerElement(scope, actions, [], { loadState: "empty" }));
    fireEvent.click(screen.getByRole("button", { name: "Conectar Kommo" }));
    fireEvent.change(screen.getByLabelText("Endereço da conta Kommo"), {
      target: { value: "https://suaempresa.kommo.com" },
    });
    fireEvent.change(screen.getByLabelText("Token de acesso de longa duração"), {
      target: { value: SECRET_TOKEN },
    });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Conectar conta Kommo" }));
    });
    await screen.findByLabelText("URL do webhook Kommo");

    view.rerender(managerElement({ ...scope, viewerId: "other_viewer" }, actions, [], { loadState: "empty" }));
    expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull();
    view.rerender(managerElement(scope, actions, [], { loadState: "empty" }));
    expect(screen.queryByLabelText("URL do webhook Kommo")).toBeNull();
    expect(document.body.innerHTML).not.toContain("AAAA-secret-BBBB");
  });
});

describe("Kommo rules editor inside the Integrations hub window", () => {
  it("edits the Kommo conversion rules where the CRM connection lives", async () => {
    const scope = freshScope();
    const createRuleAction = vi.fn().mockResolvedValue({
      ok: true,
      message: "Regra criada.",
      rule: { ...observationRule, id: "rule_new" },
    });
    render(
      managerElement(scope, managerActions({ createRuleAction }), [
        conn({ rules: [observationRule, productionRule] }),
      ]),
    );

    // The rules listed in Conversões are edited here: list, create and edit.
    expect(screen.getAllByText("Negociacao avancada").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Compra ganha").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Nova regra" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Nova regra" }));
    expect(screen.getByRole("form", { name: "Nova regra Kommo" })).toBeTruthy();
  });

  it("keeps the rules read-only for non-managers and while the license is locked", () => {
    const scope = freshScope();
    render(
      managerElement(scope, managerActions(), [conn()], { canManage: false }),
    );
    expect(screen.getAllByText("Negociacao avancada").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Nova regra" })).toBeNull();

    cleanup();
    render(
      managerElement(freshScope(), managerActions(), [conn()], { licenseLocked: true }),
    );
    const create = screen.queryByRole("button", { name: "Nova regra" });
    expect(create === null || (create as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/Licença bloqueada/).length).toBeGreaterThan(0);
  });
});
