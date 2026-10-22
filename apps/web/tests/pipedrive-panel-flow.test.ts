// @vitest-environment jsdom
import {
  conversionEventCarriesValue,
  conversionEventDisplayLabels,
  conversionEventNameSchema,
  conversionEventValuePolicy,
} from "@wpptrack/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  baseConnection,
  eligibleChannel,
  connectionWith,
  ruleWith,
  snapshotOf,
} from "./support/pipedrive-fixtures";
import {
  buildPanelElement,
  formValues,
  makeActions,
  renderPanel,
  sentForm,
} from "./support/pipedrive-panel-harness";
import { WorkspaceCurrencyProvider } from "../src/components/workspace-currency";

const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));

afterEach(() => {
  cleanup();
  routerRefresh.mockClear();
});

const allEvents = conversionEventNameSchema.options;

function fillNewRule(options: {
  name?: string;
  stage?: string;
  eventName?: string;
}) {
  fireEvent.click(screen.getByRole("button", { name: "Nova regra" }));
  fireEvent.change(screen.getByLabelText("Nome da regra"), {
    target: { value: options.name ?? "Regra de teste" },
  });
  fireEvent.change(screen.getByLabelText("Funil e etapa no Pipedrive"), {
    target: { value: options.stage ?? "pipeline_1::stage_3" },
  });
  if (options.eventName) {
    fireEvent.change(screen.getByLabelText("Evento da conversão"), {
      target: { value: options.eventName },
    });
  }
}

function submitRule() {
  fireEvent.click(screen.getByRole("button", { name: "Criar regra" }));
}

describe("Pipedrive connect flow", () => {
  it("states that observation is the default and production needs an explicit confirmation", () => {
    renderPanel({ connections: [], loadState: "empty" });
    expect(screen.getAllByText(/observação/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/com confirmação/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Producao ativa/)).toBeNull();
    expect(screen.getByText(/Nenhuma conexão Pipedrive/)).toBeTruthy();
  });

  it("creates a connection with validated credentials and authorized channels, then shows the card", async () => {
    const created = connectionWith({ id: "pipedrive_new", displayName: "Nova conta", rules: [] });
    const createConnectionAction = vi.fn(async () => ({
      ok: true as const,
      message: "criada",
      connection: snapshotOf(created),
    }));
    renderPanel({ connections: [], loadState: "empty", createConnectionAction });

    fireEvent.click(screen.getByRole("button", { name: "Nova conexão" }));
    fireEvent.change(screen.getByLabelText("Nome da conexão"), { target: { value: "Nova conta" } });
    fireEvent.change(screen.getByLabelText("Origem da conta Pipedrive"), {
      target: { value: "https://suaempresa.pipedrive.com" },
    });
    const token = screen.getByLabelText("Token de API") as HTMLInputElement;
    expect(token.type).toBe("password");
    fireEvent.change(token, { target: { value: "synthetic-token-0123456789" } });
    // Every eligible number is pre-selected (one entry per number).
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.find((box) => box.value === "route_1")!.checked).toBe(true);
    expect(boxes.find((box) => box.value === "route_2")!.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Conectar Pipedrive" }));

    await waitFor(() => expect(createConnectionAction).toHaveBeenCalledTimes(1));
    const sent = formValues(sentForm(createConnectionAction));
    expect(sent.workspaceId).toBe("workspace_1");
    expect(JSON.parse(sent.payload)).toEqual({
      displayName: "Nova conta",
      accountOrigin: "https://suaempresa.pipedrive.com",
      apiToken: "synthetic-token-0123456789",
      allowedChannelRouteIds: ["route_1"],
    });
    await screen.findByText("Nova conta");
    expect(screen.queryByDisplayValue("synthetic-token-0123456789")).toBeNull();
  });

  it("lists every WhatsApp number of any provider, pre-selects eligible ones and explains the others", async () => {
    const number = (id: string, patch: Record<string, unknown>) => ({
      ...eligibleChannel,
      id,
      providerChannelId: `provider_${id}`,
      routes: [],
      ...patch,
      readiness: {
        ...eligibleChannel.readiness,
        routeCount: 0,
        validRouteCount: 0,
        ...((patch.readiness as object) ?? {}),
      },
    });
    const createConnectionAction = vi.fn(async () => ({
      ok: true as const,
      message: "criada",
      connection: snapshotOf(connectionWith({ id: "pipedrive_new", rules: [] })),
    }));
    renderPanel({
      connections: [],
      loadState: "empty",
      createConnectionAction,
      allChannels: [
        eligibleChannel,
        // Official API number inheriting the verified workspace page/pixel.
        number("channel_inherit", {
          channelName: "Unnichat",
          readiness: {
            routingSource: "inherit_workspace",
            crmDestinationReadiness: {
              status: "verified",
              reason: "verified_workspace_destination",
            },
          },
        }),
        number("channel_paused", { channelName: "Pausado", status: "paused" }),
        number("channel_no_meta", { channelName: "Sem Meta" }),
      ] as any,
    });
    fireEvent.click(screen.getByRole("button", { name: "Nova conexão" }));
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    const box = (value: string) => boxes.find((b) => b.value === value)!;
    expect(box("channel_inherit").checked).toBe(true);
    expect(box("channel_inherit").disabled).toBe(false);
    for (const value of ["channel_paused", "channel_no_meta"]) {
      expect(box(value).checked).toBe(false);
      expect(box(value).disabled).toBe(true);
    }
    expect(screen.getByText(/Número de WhatsApp pausado/)).toBeTruthy();
    expect(screen.getByText(/ainda não tem destino Meta verificado/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Nome da conexão"), { target: { value: "Nova conta" } });
    fireEvent.change(screen.getByLabelText("Origem da conta Pipedrive"), {
      target: { value: "https://suaempresa.pipedrive.com" },
    });
    fireEvent.change(screen.getByLabelText("Token de API"), {
      target: { value: "synthetic-token-0123456789" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Conectar Pipedrive" }));
    await waitFor(() => expect(createConnectionAction).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse(formValues(sentForm(createConnectionAction)).payload)
        .allowedChannelRouteIds,
    ).toEqual(["route_1", "channel_inherit"]);
  });

  it("rejects an origin with a path locally, with no request", async () => {
    const createConnectionAction = vi.fn();
    renderPanel({ connections: [], loadState: "empty", createConnectionAction });

    fireEvent.click(screen.getByRole("button", { name: "Nova conexão" }));
    fireEvent.change(screen.getByLabelText("Nome da conexão"), { target: { value: "Nova conta" } });
    fireEvent.change(screen.getByLabelText("Origem da conta Pipedrive"), {
      target: { value: "https://suaempresa.pipedrive.com/api/v1" },
    });
    fireEvent.change(screen.getByLabelText("Token de API"), {
      target: { value: "synthetic-token-0123456789" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Conectar Pipedrive" }));

    await screen.findByText(/Revise o campo: Origem da conta/);
    expect(createConnectionAction).not.toHaveBeenCalled();
  });

  it("blocks a blind second create after an unknown creation outcome", async () => {
    const createConnectionAction = vi.fn(async () => ({
      ok: false as const,
      message: "Não foi possível confirmar a criação",
      outcomeUnknown: true,
    }));
    const listConnectionsAction = vi.fn(async () => ({
      ok: true as const,
      connections: [] as any[],
    }));
    renderPanel({ connections: [], loadState: "empty", createConnectionAction, listConnectionsAction });

    fireEvent.click(screen.getByRole("button", { name: "Nova conexão" }));
    fireEvent.change(screen.getByLabelText("Nome da conexão"), { target: { value: "Nova conta" } });
    fireEvent.change(screen.getByLabelText("Origem da conta Pipedrive"), {
      target: { value: "https://suaempresa.pipedrive.com" },
    });
    fireEvent.change(screen.getByLabelText("Token de API"), {
      target: { value: "synthetic-token-0123456789" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Conectar Pipedrive" }));

    await screen.findByText(/Resultado da criação não confirmado/);
    expect(listConnectionsAction).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Conectar Pipedrive" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole("button", { name: "Conectar Pipedrive" }).closest("form")!);
    expect(createConnectionAction).toHaveBeenCalledTimes(1);
  });
});

describe("Pipedrive catalog and channels", () => {
  it("refreshes the catalog with workspace and connection ids and adopts the returned catalog", async () => {
    const refreshed = connectionWith({
      updatedAt: "2026-10-11T15:00:00.000Z",
      pipelines: [{ id: "pipeline_7", name: "Funil novo", sort: 1, stages: [{ id: "s7", name: "Etapa nova", sort: 1 }] }],
    });
    const refreshCatalogAction = vi.fn(async () => ({
      ok: true as const,
      message: "Catálogo de pipelines e etapas atualizado.",
      connection: snapshotOf(refreshed),
    }));
    renderPanel({ refreshCatalogAction });

    fireEvent.click(screen.getByRole("button", { name: "Atualizar catálogo de Pipedrive principal" }));
    await screen.findByText("Catálogo de pipelines e etapas atualizado.");

    const sent = formValues(sentForm(refreshCatalogAction));
    expect(sent).toEqual({ workspaceId: "workspace_1", connectionId: "pipedrive_connection_1" });

    fireEvent.click(screen.getByRole("button", { name: "Nova regra" }));
    expect(screen.getByRole("option", { name: "Etapa nova" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Qualificado" })).toBeNull();
  });

  it("tells the user to refresh the catalog when none is loaded, instead of offering rule creation", () => {
    renderPanel({ connections: [connectionWith({ pipelines: [], catalogState: "empty" })] });
    expect(screen.getByText(/Atualize o catálogo para carregar pipelines e etapas/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Nova regra" })).toBeNull();
    expect(screen.getByText("Catálogo não carregado")).toBeTruthy();
  });

  it("saves the selected authorized channels and shows the resulting list", async () => {
    const saved = connectionWith({
      allowedChannelRouteIds: ["route_1", "route_2"],
      updatedAt: "2026-10-11T15:00:00.000Z",
    });
    const setChannelBindingsAction = vi.fn(async () => ({
      ok: true as const,
      message: "Canais autorizados atualizados.",
      connection: snapshotOf(saved),
    }));
    renderPanel({ setChannelBindingsAction });

    const boxes = screen.getAllByRole("checkbox");
    const route2 = boxes.filter((box) => (box as HTMLInputElement).value === "route_2")[0]!;
    fireEvent.click(route2);
    fireEvent.click(screen.getByRole("button", { name: "Salvar canais" }));

    await screen.findByText("Canais autorizados atualizados.");
    const sent = formValues(sentForm(setChannelBindingsAction));
    expect(JSON.parse(sent.payload)).toEqual({ allowedChannelRouteIds: ["route_1", "route_2"] });
  });

  it("keeps a saved channel that no longer exists explicitly removable", () => {
    renderPanel({ connections: [connectionWith({ allowedChannelRouteIds: ["route_gone"] })] });
    expect(screen.getByText("Canal removido (indisponível)")).toBeTruthy();
    expect(screen.getByText("Canal não localizado")).toBeTruthy();
  });
});

describe("Pipedrive status and health", () => {
  it("asks for confirmation before pausing and sends the paused status", async () => {
    const paused = connectionWith({ status: "paused", updatedAt: "2026-10-11T15:00:00.000Z" });
    const setStatusAction = vi.fn(async () => ({
      ok: true as const,
      message: "Conexão Pipedrive pausada.",
      connection: snapshotOf(paused),
    }));
    renderPanel({ setStatusAction });

    fireEvent.click(screen.getByRole("button", { name: "Pausar conexão Pipedrive principal" }));
    expect(setStatusAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Pausar conexão" }));

    await screen.findByText("Conexão Pipedrive pausada.");
    expect(formValues(sentForm(setStatusAction)).status).toBe("paused");
    expect(await screen.findByText("Pausada")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retomar conexão Pipedrive principal" })).toBeTruthy();
  });

  it("does not allow resuming with an unhealthy credential and explains why", () => {
    renderPanel({
      connections: [
        connectionWith({ status: "paused", credentialHealthy: false, lastErrorCode: "pipedrive_unauthorized" }),
      ],
    });
    expect((screen.getByRole("button", { name: "Retomar conexão Pipedrive principal" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Credencial inválida")).toBeTruthy();
    expect(screen.getAllByText(/O Pipedrive recusou a credencial/).length).toBeGreaterThan(0);
  });

  it("shows a blocked connection as actionable and never offers resume", () => {
    renderPanel({
      connections: [connectionWith({ status: "blocked", lastErrorCode: "pipedrive_account_mismatch" })],
    });
    expect(screen.getByText("Bloqueada")).toBeTruthy();
    expect(screen.getByText(/Conexão bloqueada: substitua a credencial/)).toBeTruthy();
    expect(screen.getAllByText(/token pertence a outra conta/).length).toBeGreaterThan(0);
  });

  it("replaces the credential with a password field and never echoes the token", async () => {
    const replaceCredentialAction = vi.fn(async () => ({
      ok: true as const,
      message: "Credenciais do Pipedrive atualizadas.",
      connection: snapshotOf(baseConnection),
    }));
    renderPanel({ replaceCredentialAction });

    const input = screen.getByLabelText("Novo token de API") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "synthetic-new-token-0123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Substituir token" }));

    await screen.findByText("Credenciais do Pipedrive atualizadas.");
    const sent = formValues(sentForm(replaceCredentialAction));
    expect(JSON.parse(sent.payload)).toEqual({ apiToken: "synthetic-new-token-0123456" });
    expect(screen.queryByDisplayValue("synthetic-new-token-0123456")).toBeNull();
  });

  it("deletes a connection only after confirmation and removes the card", async () => {
    const deleteConnectionAction = vi.fn(async () => ({
      ok: true as const,
      message: "Conexão Pipedrive removida.",
      deleted: true,
    }));
    renderPanel({ deleteConnectionAction });

    fireEvent.click(screen.getByRole("button", { name: "Remover conexão Pipedrive principal" }));
    expect(deleteConnectionAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remover conexão" }));

    await waitFor(() => expect(screen.queryByText("Pipedrive principal")).toBeNull());
    expect(screen.getByText(/Nenhuma conexão Pipedrive/)).toBeTruthy();
  });

  it("keeps the card and shows the safe message when deletion is refused", async () => {
    const deleteConnectionAction = vi.fn(async () => ({
      ok: false as const,
      message: "Esta conexão já tem eventos auditados e não pode ser removida. Pause-a.",
    }));
    renderPanel({ deleteConnectionAction });

    fireEvent.click(screen.getByRole("button", { name: "Remover conexão Pipedrive principal" }));
    fireEvent.click(screen.getByRole("button", { name: "Remover conexão" }));

    await screen.findByText(/eventos auditados/);
    expect(screen.getByText("Pipedrive principal")).toBeTruthy();
  });
});

describe("Pipedrive rule CRUD", () => {
  it("lists all 14 catalog events with their localized labels", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Nova regra" }));
    const select = screen.getByLabelText("Evento da conversão") as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((option) => option.textContent);

    expect(allEvents).toHaveLength(14);
    expect(optionLabels).toEqual(allEvents.map((name) => conversionEventDisplayLabels[name]));
  });

  it("groups stages by pipeline and sends pipelineId and stageId (not names)", async () => {
    const createRuleAction = vi.fn(async (formData: FormData) => ({
      ok: true as const,
      message: "Regra Pipedrive criada.",
      rule: ruleWith({
        id: "rule_new",
        name: "Reativar cliente",
        pipelineId: "pipeline_2",
        stageId: "stage_9",
        eventName: "LeadSubmitted",
      }),
    }));
    renderPanel({ createRuleAction });

    fillNewRule({ name: "Reativar cliente", stage: "pipeline_2::stage_9", eventName: "LeadSubmitted" });
    expect(document.querySelector('optgroup[label="Vendas"]')).toBeTruthy();
    expect(document.querySelector('optgroup[label="Pos-venda"]')).toBeTruthy();
    submitRule();

    await screen.findByText("Regra Pipedrive criada.");
    const payload = JSON.parse(formValues(createRuleAction.mock.calls[0]![0] as FormData).payload);
    expect(payload).toMatchObject({
      name: "Reativar cliente",
      pipelineId: "pipeline_2",
      stageId: "stage_9",
      eventName: "LeadSubmitted",
      mode: "observation",
    });
    expect(await screen.findByText("Pos-venda / Renovacao")).toBeTruthy();
  });

  it("offers 'Negócio ganho' per pipeline: Compra with the deal value, no stage, currency optional", async () => {
    const createRuleAction = vi.fn(async (_formData: FormData) => ({
      ok: true as const,
      message: "Regra Pipedrive criada.",
      rule: ruleWith({
        id: "rule_won",
        name: "Venda fechada",
        trigger: "deal_won",
        pipelineId: "pipeline_1",
        stageId: null,
        eventName: "Purchase",
      }),
    }));
    renderPanel({ createRuleAction });

    fillNewRule({ name: "Venda fechada", stage: "pipeline_1::__deal_won__" });
    const event = screen.getByLabelText("Evento da conversão") as HTMLSelectElement;
    expect(event.disabled).toBe(true);
    expect(event.value).toBe("Purchase");
    expect((screen.getByLabelText(/^Moeda/) as HTMLSelectElement).required).toBe(false);
    expect(screen.getByText(/marcado como ganho, envia Compra/)).toBeTruthy();
    submitRule();

    await screen.findByText("Regra Pipedrive criada.");
    const payload = JSON.parse(
      formValues(createRuleAction.mock.calls[0]![0] as FormData).payload,
    );
    expect(payload).toMatchObject({
      name: "Venda fechada",
      trigger: "deal_won",
      pipelineId: "pipeline_1",
      stageId: null,
      eventName: "Purchase",
      valueMode: "deal",
      mode: "observation",
    });
    expect(payload).not.toHaveProperty("currency");
    expect(await screen.findByText("Vendas / Negócio ganho")).toBeTruthy();
  });

  describe("workspace currency", () => {
    function renderWithWorkspaceCurrency(currency: "BRL" | "USD" | "EUR") {
      const actions = makeActions();
      render(
        createElement(
          WorkspaceCurrencyProvider,
          { currency },
          buildPanelElement(actions),
        ),
      );
      return actions;
    }

    it.each(["BRL", "USD", "EUR"] as const)(
      "starts a new valued rule on the workspace currency %s and sends it",
      async (workspaceCurrency) => {
        const actions = renderWithWorkspaceCurrency(workspaceCurrency);
        fillNewRule({ eventName: "Purchase" });
        const currency = screen.getByLabelText(/^Moeda/) as HTMLSelectElement;
        expect(currency.tagName).toBe("SELECT");
        expect(currency.value).toBe(workspaceCurrency);
        submitRule();

        await waitFor(() => expect(actions.createRuleAction).toHaveBeenCalledTimes(1));
        const payload = JSON.parse(
          formValues(actions.createRuleAction.mock.calls[0]![0] as FormData).payload,
        );
        expect(payload.currency).toBe(workspaceCurrency);
      },
    );

    it("lets a won deal keep the currency of the deal unless a currency is picked", () => {
      renderWithWorkspaceCurrency("USD");
      fillNewRule({ name: "Venda fechada", stage: "pipeline_1::__deal_won__" });
      const currency = screen.getByLabelText(/^Moeda/) as HTMLSelectElement;
      expect(currency.value).toBe("");
      expect(
        within(currency).getByRole("option", { name: "Usar a moeda do negócio" }),
      ).toBeTruthy();
    });
  });

  it("never shows internal jargon to the customer", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Nova regra" }));
    const text = document.body.textContent ?? "";
    for (const jargon of [
      /payload/i,
      /parser/i,
      /certifica/i,
      /observação tecnica/i,
      /dedupe/i,
      /materializ/i,
      /\blease\b/i,
      /fence/i,
      /CAPI/,
      /producao/i,
      /webhook v2/i,
    ])
      expect(text).not.toMatch(jargon);
  });

  describe.each(allEvents.map((name) => [name] as const))("event %s", (eventName) => {
    const policy = conversionEventValuePolicy(eventName);
    const carries = conversionEventCarriesValue(eventName);

    it(`renders the ${policy} value policy: value/currency/product fields ${carries ? "visible" : "hidden"}`, () => {
      renderPanel();
      fillNewRule({ eventName });

      expect(screen.queryByLabelText(/^Moeda/) !== null).toBe(carries);
      expect(screen.queryByLabelText("Produto (opcional)") !== null).toBe(carries);
      expect(screen.queryByText("Valor fixo") !== null).toBe(carries);
      if (!carries) {
        expect(screen.getByText(/não carrega valor/)).toBeTruthy();
      }
    });

    it("sends a payload the shared create contract accepts", async () => {
      const createRuleAction = vi.fn(async (_: FormData) => ({
        ok: true as const,
        message: "Regra Pipedrive criada.",
        rule: ruleWith({ id: "rule_x", eventName }),
      }));
      renderPanel({ createRuleAction });
      fillNewRule({ eventName });
      if (policy === "required") {
        fireEvent.change(screen.getByLabelText(/^Moeda/), { target: { value: "BRL" } });
      }
      submitRule();

      await waitFor(() => expect(createRuleAction).toHaveBeenCalledTimes(1));
      const payload = JSON.parse(formValues(createRuleAction.mock.calls[0]![0]).payload);
      expect(payload.eventName).toBe(eventName);
      expect(payload.mode).toBe("observation");
      expect(payload.valueMode).toBe("deal");
      if (policy === "required") expect(payload.currency).toBe("BRL");
      if (!carries) {
        expect(payload).not.toHaveProperty("currency");
        expect(payload).not.toHaveProperty("fixedValueCents");
        expect(payload).not.toHaveProperty("contentName");
      }
    });
  });

  it("converts a fixed amount to positive cents and requires the currency", async () => {
    const createRuleAction = vi.fn(async (_: FormData) => ({
      ok: true as const,
      message: "Regra Pipedrive criada.",
      rule: ruleWith({ id: "rule_fixed", valueMode: "fixed", fixedValueCents: 19990, currency: "BRL" }),
    }));
    renderPanel({ createRuleAction });
    fillNewRule({ eventName: "Purchase" });
    fireEvent.click(screen.getByRole("radio", { name: "Valor fixo" }));
    fireEvent.change(screen.getByLabelText("Valor fixo (positivo)"), { target: { value: "199,90" } });
    // A moeda começa na do workspace (BRL sem provider) e continua obrigatória
    // para valor fixo: sem moeda o navegador bloqueia o envio.
    const currency = screen.getByLabelText(/^Moeda/) as HTMLSelectElement;
    expect(currency.value).toBe("BRL");
    expect(currency.required).toBe(true);
    fireEvent.change(currency, { target: { value: "" } });
    submitRule();
    expect(createRuleAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^Moeda/), { target: { value: "BRL" } });
    fireEvent.change(screen.getByLabelText("Produto (opcional)"), { target: { value: "Plano anual" } });
    submitRule();

    await waitFor(() => expect(createRuleAction).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(formValues(createRuleAction.mock.calls[0]![0]).payload);
    expect(payload).toMatchObject({
      valueMode: "fixed",
      fixedValueCents: 19990,
      currency: "BRL",
      contentName: "Plano anual",
    });
  });

  it.each(["0", "-5", "abc", "10,999"])("rejects the invalid fixed amount %j without a request", async (amount) => {
    const createRuleAction = vi.fn();
    renderPanel({ createRuleAction });
    fillNewRule({ eventName: "Purchase" });
    fireEvent.click(screen.getByRole("radio", { name: "Valor fixo" }));
    fireEvent.change(screen.getByLabelText("Valor fixo (positivo)"), { target: { value: amount } });
    fireEvent.change(screen.getByLabelText(/^Moeda/), { target: { value: "BRL" } });
    submitRule();

    await screen.findByText(/valor fixo positivo válido/);
    expect(createRuleAction).not.toHaveBeenCalled();
  });

  it("shows rules with deal vs fixed value semantics", () => {
    renderPanel({
      connections: [
        connectionWith({
          rules: [
            ruleWith({ id: "r1", name: "Ganho deal", currency: "BRL" }),
            ruleWith({ id: "r2", name: "Ganho fixo", valueMode: "fixed", fixedValueCents: 5000, currency: "USD", contentName: "Kit" }),
            ruleWith({ id: "r3", name: "Contato", eventName: "LeadSubmitted", currency: null }),
          ],
        }),
      ],
    });
    expect(screen.getByText("Valor do negócio no Pipedrive (BRL)")).toBeTruthy();
    expect(screen.getByText(/Valor fixo: .*50,00/)).toBeTruthy();
    expect(screen.getByText(/Produto: Kit/)).toBeTruthy();
    expect(screen.getByText("Evento sem valor")).toBeTruthy();
  });

  it("edits a rule sending only a partial update with nulls for cleared fields", async () => {
    const original = ruleWith({ id: "r1", name: "Ganho", valueMode: "fixed", fixedValueCents: 5000, currency: "BRL", contentName: "Kit" });
    const updated = ruleWith({ id: "r1", name: "Ganho renomeado", valueMode: "deal", fixedValueCents: null, currency: "BRL", contentName: null, updatedAt: "2026-10-11T16:00:00.000Z" });
    const updateRuleAction = vi.fn(async (_: FormData) => ({
      ok: true as const,
      message: "Regra Pipedrive atualizada.",
      rule: updated,
    }));
    renderPanel({ connections: [connectionWith({ rules: [original] })], updateRuleAction });

    const editSummary = screen.getByText("Editar regra");
    fireEvent.click(editSummary);
    const form = editSummary.closest("details")!;
    fireEvent.change(within(form).getByLabelText("Nome da regra"), { target: { value: "Ganho renomeado" } });
    fireEvent.click(within(form).getByRole("radio", { name: "Valor do negócio no Pipedrive" }));
    fireEvent.change(within(form).getByLabelText("Produto (opcional)"), { target: { value: "" } });
    fireEvent.click(within(form).getByRole("button", { name: "Salvar regra" }));

    await screen.findByText("Regra Pipedrive atualizada.");
    const sent = formValues(updateRuleAction.mock.calls[0]![0]);
    expect(sent.ruleId).toBe("r1");
    const payload = JSON.parse(sent.payload);
    expect(payload).toMatchObject({ name: "Ganho renomeado", valueMode: "deal", fixedValueCents: null, contentName: null });
    expect(payload).not.toHaveProperty("mode");
    await waitFor(() =>
      expect(
        Array.from(
          document.querySelectorAll(".provider-conversion-rule-title strong"),
        ).map((node) => node.textContent),
      ).toContain("Ganho renomeado"),
    );
  });

  it("pauses a rule with a one-field update", async () => {
    const updateRuleAction = vi.fn(async (_: FormData) => ({
      ok: true as const,
      message: "Regra Pipedrive pausada.",
      rule: ruleWith({ id: "r1", active: false, updatedAt: "2026-10-11T16:00:00.000Z" }),
    }));
    renderPanel({ connections: [connectionWith({ rules: [ruleWith({ id: "r1" })] })], updateRuleAction });

    fireEvent.click(screen.getByRole("button", { name: "Pausar regra Ganho do negócio" }));
    await screen.findByText("Regra Pipedrive pausada.");
    expect(JSON.parse(formValues(updateRuleAction.mock.calls[0]![0]).payload)).toEqual({ active: false });
    expect(await screen.findByText("Pausada")).toBeTruthy();
  });

  it("deletes a rule only after confirmation", async () => {
    const deleteRuleAction = vi.fn(async (_: FormData) => ({ ok: true as const, message: "Regra Pipedrive removida." }));
    renderPanel({ connections: [connectionWith({ rules: [ruleWith({ id: "r1" })] })], deleteRuleAction });

    fireEvent.click(screen.getByRole("button", { name: "Remover regra Ganho do negócio" }));
    expect(deleteRuleAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remover" }));

    await screen.findByText("Regra Pipedrive removida.");
    expect(formValues(deleteRuleAction.mock.calls[0]![0]).ruleId).toBe("r1");
    await waitFor(() => expect(screen.getByText(/Nenhuma regra cadastrada/)).toBeTruthy());
  });

  it("locks rule edits after an unknown write outcome until the state is confirmed", async () => {
    const updateRuleAction = vi.fn(async (_: FormData) => ({
      ok: false as const,
      message: "Não foi possível confirmar",
      outcomeUnknown: true,
    }));
    const getConnectionAction = vi.fn(async () => ({ ok: false as const, reason: "network" as const }));
    renderPanel({
      connections: [connectionWith({ rules: [ruleWith({ id: "r1" })] })],
      updateRuleAction,
      getConnectionAction,
    });

    fireEvent.click(screen.getByRole("button", { name: "Pausar regra Ganho do negócio" }));
    await screen.findByText(/Requisição sem resposta final/);
    expect((screen.getByRole("button", { name: "Pausar regra Ganho do negócio" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remover regra Ganho do negócio" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
