// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipedriveCapabilitiesResult } from "../src/app/(app)/integrations/pipedrive-actions";
import {
  capabilitiesDisabled,
  capabilitiesEnabled,
  eventWith,
  productionRuleWith,
  resultWith,
  revisionedConnectionWith,
  ruleWith,
  SYNTHETIC_WEBHOOK_URL,
} from "./support/pipedrive-fixtures";
import { formValues, renderPanel, sentForm } from "./support/pipedrive-panel-harness";

const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));

beforeEach(() => {
  capsOk.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  routerRefresh.mockClear();
});

const LATER = "2026-10-11T16:00:00.000Z";
const activateLabel = "Ativar envio automático da regra Ganho do negócio";
const backLabel = "Voltar para observação a regra Ganho do negócio";
const pauseLabel = "Pausar regra Ganho do negócio";

const caps = (value: PipedriveCapabilitiesResult) => vi.fn(async (_w: string, _c: string) => value);
const capsOk = caps({ ok: true, capabilities: capabilitiesEnabled });

function updateReturning(rule: ReturnType<typeof ruleWith>) {
  return vi.fn(async (_: FormData) => ({
    ok: true as const,
    message: "Regra Pipedrive atualizada.",
    rule,
  }));
}

function payloadOf(action: { mock: { calls: unknown[] } }, call = 0) {
  return JSON.parse(formValues(sentForm(action, call)).payload);
}

async function confirmEnabled(name: string) {
  const button = (await screen.findByRole("button", { name })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

describe("Pipedrive production opt-in (existing rule)", () => {
  it("keeps observation as the default and sends nothing until the explicit confirmation", async () => {
    const updateRuleAction = updateReturning(productionRuleWith({ id: "rule_1", updatedAt: LATER }));
    const getCapabilitiesAction = capsOk;
    renderPanel({
      connections: [revisionedConnectionWith({ rules: [ruleWith()] })],
      updateRuleAction,
      getCapabilitiesAction,
    });

    expect(screen.getByText("Observando")).toBeTruthy();
    expect(screen.getByText("Observação (padrão)", { selector: ".event-chip" })).toBeTruthy();
    expect(getCapabilitiesAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: activateLabel }));
    expect(updateRuleAction).not.toHaveBeenCalled();
    await screen.findByText(/Envio automático disponível nesta instalação/);
    expect(getCapabilitiesAction).toHaveBeenCalledWith("workspace_1", "pipedrive_connection_1");
    expect(screen.getByRole("list", { name: "Requisitos para o envio automático" })).toBeTruthy();

    fireEvent.click(await confirmEnabled("Ativar envio automático"));

    await screen.findByText(/Envio automático ativo desde/);
    expect(payloadOf(updateRuleAction)).toEqual({ mode: "production" });
    expect(screen.getByText("Envio automático em 1 regra(s)")).toBeTruthy();
    expect(screen.getByText("Envio automático", { selector: ".event-chip" })).toBeTruthy();
  });

  it("cancelling the confirmation changes nothing", async () => {
    const updateRuleAction = updateReturning(productionRuleWith());
    renderPanel({
      connections: [revisionedConnectionWith({ rules: [ruleWith()] })],
      updateRuleAction,
      getCapabilitiesAction: capsOk,
    });
    fireEvent.click(screen.getByRole("button", { name: activateLabel }));
    await screen.findByText(/Envio automático disponível nesta instalação/);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByRole("list", { name: "Requisitos para o envio automático" })).toBeNull();
    expect(updateRuleAction).not.toHaveBeenCalled();
    expect(screen.getByText("Observando")).toBeTruthy();
  });

  it("blocks activation while the production gate is off in this environment", async () => {
    const updateRuleAction = updateReturning(productionRuleWith());
    renderPanel({
      connections: [revisionedConnectionWith({ rules: [ruleWith()] })],
      updateRuleAction,
      getCapabilitiesAction: caps({ ok: true, capabilities: capabilitiesDisabled }),
    });
    fireEvent.click(screen.getByRole("button", { name: activateLabel }));

    await screen.findByText(/Envio automático desativado nesta instalação/);
    const confirm = screen.getByRole("button", { name: "Ativar envio automático" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(updateRuleAction).not.toHaveBeenCalled();
  });

  it("treats a server without capabilities as unavailable and allows re-checking", async () => {
    const getCapabilitiesAction = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "missing" })
      .mockResolvedValue({ ok: true, capabilities: capabilitiesEnabled });
    const updateRuleAction = updateReturning(productionRuleWith());
    renderPanel({
      connections: [revisionedConnectionWith({ rules: [ruleWith()] })],
      updateRuleAction,
      getCapabilitiesAction,
    });
    fireEvent.click(screen.getByRole("button", { name: activateLabel }));

    await screen.findByText(/Não foi possível confirmar se o envio automático está disponível/);
    expect((screen.getByRole("button", { name: "Ativar envio automático" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Verificar de novo" }));
    await screen.findByText(/Envio automático disponível nesta instalação/);
    expect(getCapabilitiesAction).toHaveBeenCalledTimes(2);
    expect((await confirmEnabled("Ativar envio automático")).disabled).toBe(false);
    expect(updateRuleAction).not.toHaveBeenCalled();
  });

  it("does not enable production when the capabilities read fails (unknown, nothing changed)", async () => {
    renderPanel({
      connections: [revisionedConnectionWith({ rules: [ruleWith()] })],
      getCapabilitiesAction: caps({ ok: false, reason: "network" }),
    });
    fireEvent.click(screen.getByRole("button", { name: activateLabel }));
    await screen.findByText(/Não foi possível verificar o envio automático agora/);
    expect((screen.getByRole("button", { name: "Ativar envio automático" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("blocks and reports a lost session when capabilities are unauthorized, hiding the one-time URL", async () => {
    const rotateWebhookAction = vi.fn(async () => ({
      ok: true as const,
      message: "gerada",
      oneTimeWebhook: {
        webhookUrl: SYNTHETIC_WEBHOOK_URL,
        version: 3,
        rotatedAt: "2026-10-11T12:00:00.000Z",
      },
    }));
    renderPanel({
      connections: [revisionedConnectionWith({ rules: [ruleWith()] })],
      rotateWebhookAction,
      getConnectionAction: vi.fn(async (_w: string, _c: string) => ({
        ok: true as const,
        connection: revisionedConnectionWith({ rules: [ruleWith()] }),
      })),
      getCapabilitiesAction: caps({ ok: false, reason: "unauthorized" }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Gerar URL do webhook de Pipedrive principal" }));
    fireEvent.click(screen.getByRole("button", { name: "Gerar nova URL" }));
    await screen.findByDisplayValue(SYNTHETIC_WEBHOOK_URL);

    fireEvent.click(screen.getByRole("button", { name: activateLabel }));

    await waitFor(() => expect(screen.queryByDisplayValue(SYNTHETIC_WEBHOOK_URL)).toBeNull());
    expect((screen.getByRole("button", { name: "Ativar envio automático" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides every production control for a role that cannot manage, but still shows the mode", () => {
    const getCapabilitiesAction = capsOk;
    renderPanel({
      canManage: false,
      connections: [revisionedConnectionWith({ rules: [productionRuleWith()] })],
      getCapabilitiesAction,
    });
    expect(screen.queryByRole("button", { name: backLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: activateLabel })).toBeNull();
    expect(screen.getByText(/Envio automático ativo desde/)).toBeTruthy();
    expect(getCapabilitiesAction).not.toHaveBeenCalled();
  });

  it("shows the server refusal and re-reads the rule instead of assuming production", async () => {
    const updateRuleAction = vi.fn(async (_: FormData) => ({
      ok: false as const,
      message: "O envio automático está desativado nesta instalação",
    }));
    const getConnectionAction = vi.fn(async (_w: string, _c: string) => ({
      ok: true as const,
      connection: revisionedConnectionWith({ rules: [ruleWith()] }),
    }));
    renderPanel({
      connections: [revisionedConnectionWith({ rules: [ruleWith()] })],
      updateRuleAction,
      getConnectionAction,
      getCapabilitiesAction: capsOk,
    });
    fireEvent.click(screen.getByRole("button", { name: activateLabel }));
    fireEvent.click(await confirmEnabled("Ativar envio automático"));

    await screen.findByText("O envio automático está desativado nesta instalação");
    await waitFor(() => expect(getConnectionAction).toHaveBeenCalled());
    expect(screen.getByText("Observando")).toBeTruthy();
    expect(screen.queryByText(/Envio automático ativo desde/)).toBeNull();
  });

  it("deactivates back to observation immediately (a safe, no-send change) without capabilities", async () => {
    const updateRuleAction = updateReturning(ruleWith({ updatedAt: LATER }));
    const getCapabilitiesAction = capsOk;
    renderPanel({
      connections: [revisionedConnectionWith({ rules: [productionRuleWith()] })],
      updateRuleAction,
      getCapabilitiesAction,
    });
    expect(screen.getByText("Envio automático em 1 regra(s)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: backLabel }));

    await screen.findByText("Observando");
    expect(payloadOf(updateRuleAction)).toEqual({ mode: "observation" });
    expect(getCapabilitiesAction).not.toHaveBeenCalled();
    expect(screen.getByText("Observação (padrão)", { selector: ".event-chip" })).toBeTruthy();
  });

  it("pauses a production rule at once, and resuming it in production needs a fresh confirmation", async () => {
    const paused = productionRuleWith({ active: false, updatedAt: LATER });
    const resumed = productionRuleWith({ active: true, updatedAt: "2026-10-11T17:00:00.000Z" });
    const updateRuleAction = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, message: "Regra Pipedrive atualizada.", rule: paused })
      .mockResolvedValueOnce({ ok: true, message: "Regra Pipedrive atualizada.", rule: resumed });
    const getCapabilitiesAction = capsOk;
    renderPanel({
      connections: [revisionedConnectionWith({ rules: [productionRuleWith()] })],
      updateRuleAction,
      getCapabilitiesAction,
    });

    fireEvent.click(screen.getByRole("button", { name: pauseLabel }));
    await screen.findByText(/Configurada com envio automático, mas pausada/);
    expect(payloadOf(updateRuleAction, 0)).toEqual({ active: false });
    expect(getCapabilitiesAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retomar regra Ganho do negócio com envio automático" }));
    expect(updateRuleAction).toHaveBeenCalledTimes(1);
    await screen.findByText(/Envio automático disponível nesta instalação/);
    expect(getCapabilitiesAction).toHaveBeenCalledTimes(1);

    fireEvent.click(await confirmEnabled("Retomar envio automático"));
    await waitFor(() => expect(updateRuleAction).toHaveBeenCalledTimes(2));
    expect(payloadOf(updateRuleAction, 1)).toEqual({ active: true });
    await screen.findByText(/Envio automático ativo desde/);
  });

  it("resumes a paused observation rule immediately", async () => {
    const updateRuleAction = updateReturning(ruleWith({ active: true, updatedAt: LATER }));
    const getCapabilitiesAction = capsOk;
    renderPanel({
      connections: [revisionedConnectionWith({ rules: [ruleWith({ active: false })] })],
      updateRuleAction,
      getCapabilitiesAction,
    });
    fireEvent.click(screen.getByRole("button", { name: "Retomar regra Ganho do negócio" }));
    await screen.findByText("Observando");
    expect(payloadOf(updateRuleAction)).toEqual({ active: true });
    expect(getCapabilitiesAction).not.toHaveBeenCalled();
  });

  it("blocks the confirm with a pending requirement the connection definitely lacks", async () => {
    renderPanel({
      connections: [
        revisionedConnectionWith({
          rules: [ruleWith()],
          allowedChannelRouteIds: [],
          catalogState: "stale",
          webhook: { configured: false, version: 0, rotatedAt: null, lastReceivedAt: null },
        }),
      ],
      getCapabilitiesAction: capsOk,
    });
    fireEvent.click(screen.getByRole("button", { name: activateLabel }));
    await screen.findByText(/Envio automático disponível nesta instalação/);

    expect(screen.getAllByText("Pendente").length).toBe(3);
    expect(screen.getAllByText("Conferido a cada movimento").length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Ativar envio automático" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Pipedrive production opt-in (new rule)", () => {
  function fillNew() {
    fireEvent.click(screen.getByRole("button", { name: "Nova regra" }));
    fireEvent.change(screen.getByLabelText("Nome da regra"), { target: { value: "Lead em producao" } });
    fireEvent.change(screen.getByLabelText("Funil e etapa no Pipedrive"), {
      target: { value: "pipeline_1::stage_1" },
    });
    fireEvent.change(screen.getByLabelText("Evento da conversão"), { target: { value: "LeadSubmitted" } });
  }

  it("keeps observation as the pre-selected mode", () => {
    renderPanel({ connections: [revisionedConnectionWith()] });
    fireEvent.click(screen.getByRole("button", { name: "Nova regra" }));
    const observation = screen.getByRole("radio", { name: /Observação \(padrão\)/ }) as HTMLInputElement;
    expect(observation.checked).toBe(true);
    expect(screen.getByRole("button", { name: "Criar regra" })).toBeTruthy();
  });

  it("creates in production only after review and confirmation", async () => {
    const created = productionRuleWith({ id: "rule_new", name: "Lead em producao", eventName: "LeadSubmitted" });
    const createRuleAction = vi.fn(async (_: FormData) => ({
      ok: true as const,
      message: "Regra Pipedrive criada.",
      rule: created,
    }));
    const getCapabilitiesAction = capsOk;
    renderPanel({
      connections: [revisionedConnectionWith()],
      createRuleAction,
      getCapabilitiesAction,
    });
    fillNew();
    fireEvent.click(screen.getByRole("radio", { name: /Envio automático: envia o evento/ }));
    fireEvent.click(screen.getByRole("button", { name: "Revisar e ativar envio automático" }));

    expect(createRuleAction).not.toHaveBeenCalled();
    await screen.findByText(/já com envio automático ativo/);
    await screen.findByText(/Envio automático disponível nesta instalação/);

    fireEvent.click(await confirmEnabled("Criar com envio automático"));
    await waitFor(() => expect(createRuleAction).toHaveBeenCalledTimes(1));
    expect(payloadOf(createRuleAction)).toMatchObject({
      mode: "production",
      eventName: "LeadSubmitted",
      pipelineId: "pipeline_1",
      stageId: "stage_1",
    });
    await screen.findByText(/Envio automático ativo desde/);
  });

  it("cancelling the creation review sends nothing", async () => {
    const createRuleAction = vi.fn();
    renderPanel({ connections: [revisionedConnectionWith()], createRuleAction, getCapabilitiesAction: capsOk });
    fillNew();
    fireEvent.click(screen.getByRole("radio", { name: /Envio automático: envia o evento/ }));
    fireEvent.click(screen.getByRole("button", { name: "Revisar e ativar envio automático" }));
    await screen.findByText(/já com envio automático ativo/);

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByText(/já com envio automático ativo/)).toBeNull();
    expect(createRuleAction).not.toHaveBeenCalled();
  });

  it("does not create when the gate is off", async () => {
    const createRuleAction = vi.fn();
    renderPanel({
      connections: [revisionedConnectionWith()],
      createRuleAction,
      getCapabilitiesAction: caps({ ok: true, capabilities: capabilitiesDisabled }),
    });
    fillNew();
    fireEvent.click(screen.getByRole("radio", { name: /Envio automático: envia o evento/ }));
    fireEvent.click(screen.getByRole("button", { name: "Revisar e ativar envio automático" }));
    await screen.findByText(/Envio automático desativado nesta instalação/);
    const confirm = screen.getByRole("button", { name: "Criar com envio automático" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(createRuleAction).not.toHaveBeenCalled();
  });
});

describe("Pipedrive revision and webhook metadata", () => {
  it("shows secret-free webhook metadata and the mutation revision", () => {
    renderPanel({ connections: [revisionedConnectionWith()] });
    expect(screen.getByText(/Webhook \(versão 2\): URL gerada em/)).toBeTruthy();
    expect(screen.getByText("Versão 5 da configuração")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("SYNTHETIC-SECRET");
  });

  it("says plainly when the webhook URL was never generated", () => {
    renderPanel({
      connections: [
        revisionedConnectionWith({
          webhook: { configured: false, version: 0, rotatedAt: null, lastReceivedAt: null },
        }),
      ],
    });
    expect(screen.getByText("Webhook: URL ainda não gerada")).toBeTruthy();
  });

  it("labels a read without revision fencing instead of promising atomicity", () => {
    renderPanel({ connections: [revisionedConnectionWith({ revisionFenced: false })] });
    expect(screen.getByText(/Versão 5 da configuração \(pode estar desatualizada; atualize a página\)/)).toBeTruthy();
  });

  async function failRefreshThenRead(read: unknown) {
    const refreshCatalogAction = vi.fn(async (_: FormData) => ({ ok: false as const, message: "falhou" }));
    const getConnectionAction = vi.fn(async (_w: string, _c: string) => read as never);
    renderPanel({ connections: [revisionedConnectionWith()], refreshCatalogAction, getConnectionAction });
    fireEvent.click(screen.getByRole("button", { name: "Atualizar catálogo de Pipedrive principal" }));
    await waitFor(() => expect(getConnectionAction).toHaveBeenCalled());
    return getConnectionAction;
  }

  it("discards an older-revision read: the stale state is never adopted as current", async () => {
    await failRefreshThenRead({
      ok: true,
      connection: revisionedConnectionWith({ mutationRevision: 4, catalogState: "stale" }),
    });
    await screen.findByText("Estado não confirmado");
    expect(screen.getByText("Versão 5 da configuração")).toBeTruthy();
    expect(screen.queryByText("Versão 4 da configuração")).toBeNull();
  });

  it("adopts a newer-revision read and confirms the state", async () => {
    await failRefreshThenRead({
      ok: true,
      connection: revisionedConnectionWith({
        mutationRevision: 6,
        updatedAt: LATER,
        webhook: { configured: true, version: 3, rotatedAt: LATER, lastReceivedAt: null },
      }),
    });
    await screen.findByText("Versão 6 da configuração");
    expect(screen.queryByText("Estado não confirmado")).toBeNull();
    expect(screen.getByText(/Webhook \(versão 3\)/)).toBeTruthy();
  });

  it("keeps the state unconfirmed and explains it when every fenced read raced a write", async () => {
    await failRefreshThenRead({ ok: false, reason: "inconsistent" });
    await screen.findByText(/mudou durante a leitura/);
    expect(screen.getByText("Estado não confirmado")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Salvar canais" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("treats a 503-style failed read as unknown, never as absence", async () => {
    await failRefreshThenRead({ ok: false, reason: "network" });
    await screen.findByText("Estado não confirmado");
    expect(screen.getByRole("button", { name: "Atualizar catálogo de Pipedrive principal" })).toBeTruthy();
    expect(screen.queryByText(/não existe mais no servidor/)).toBeNull();
  });

  it("a scoped 404 proves absence: settles the card and refreshes the list", async () => {
    await failRefreshThenRead({ ok: false, reason: "not_found" });
    await screen.findByText("Confirmado: esta conexão não existe mais no servidor.");
    expect(routerRefresh).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Atualizar catálogo de Pipedrive principal" })).toBeNull();
  });

  it("an unknown delete stays locked on a 503 read, and is settled only by the scoped 404", async () => {
    const unsettledOperations = { creation: false, connectionIds: new Set<string>() };
    const deleteConnectionAction = vi.fn(async (_: FormData) => ({
      ok: false as const,
      message: "Sem resposta final",
      outcomeUnknown: true,
    }));
    const getConnectionAction = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "network" })
      .mockResolvedValue({ ok: false, reason: "not_found" });
    renderPanel({
      connections: [revisionedConnectionWith()],
      unsettledOperations,
      deleteConnectionAction,
      getConnectionAction,
    });
    fireEvent.click(screen.getByRole("button", { name: "Remover conexão Pipedrive principal" }));
    fireEvent.click(screen.getByRole("button", { name: "Remover conexão" }));

    await waitFor(() => expect(getConnectionAction).toHaveBeenCalledTimes(1));
    await screen.findByText("Estado não confirmado");
    expect(unsettledOperations.connectionIds.has("pipedrive_connection_1")).toBe(true);
    expect((screen.getByRole("button", { name: "Gerar URL do webhook de Pipedrive principal" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Confirmar estado atual" }));
    await screen.findByText("Confirmado: esta conexão não existe mais no servidor.");
    expect(unsettledOperations.connectionIds.has("pipedrive_connection_1")).toBe(false);
  });
});

describe("Pipedrive one-time URL retention across reconciliation", () => {
  const mint = async () => ({
    ok: true as const,
    message: "gerada",
    oneTimeWebhook: {
      webhookUrl: SYNTHETIC_WEBHOOK_URL,
      version: 3,
      rotatedAt: "2026-10-11T12:00:00.000Z",
    },
  });

  it("re-reads webhook metadata after a rotation without dropping the in-memory URL", async () => {
    const getConnectionAction = vi.fn(async (_w: string, _c: string) => ({
      ok: true as const,
      connection: revisionedConnectionWith({
        mutationRevision: 6,
        updatedAt: LATER,
        webhook: { configured: true, version: 3, rotatedAt: "2026-10-11T12:00:00.000Z", lastReceivedAt: null },
      }),
    }));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderPanel({
      connections: [revisionedConnectionWith()],
      rotateWebhookAction: mint,
      getConnectionAction,
    });
    fireEvent.click(screen.getByRole("button", { name: "Gerar URL do webhook de Pipedrive principal" }));
    fireEvent.click(screen.getByRole("button", { name: "Gerar nova URL" }));

    await screen.findByText(/Webhook \(versão 3\)/);
    expect(getConnectionAction).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue(SYNTHETIC_WEBHOOK_URL)).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("re-reads after a revocation and shows the URL gone", async () => {
    const revokeWebhookAction = vi.fn(async (_: FormData) => ({
      ok: true as const,
      message: "revogada",
      revoked: true,
    }));
    const getConnectionAction = vi.fn(async (_w: string, _c: string) => ({
      ok: true as const,
      connection: revisionedConnectionWith({
        mutationRevision: 6,
        updatedAt: LATER,
        webhook: { configured: false, version: 3, rotatedAt: null, lastReceivedAt: null },
      }),
    }));
    renderPanel({
      connections: [revisionedConnectionWith()],
      rotateWebhookAction: mint,
      revokeWebhookAction,
      getConnectionAction,
    });
    fireEvent.click(screen.getByRole("button", { name: "Gerar URL do webhook de Pipedrive principal" }));
    fireEvent.click(screen.getByRole("button", { name: "Revogar URL atual" }));
    fireEvent.click(screen.getByRole("button", { name: "Revogar URL" }));

    await screen.findByText("Webhook: URL ainda não gerada");
    expect(getConnectionAction).toHaveBeenCalledTimes(1);
  });

  it("an unknown rotation does not trigger a read that could look like completion", async () => {
    const getConnectionAction = vi.fn(async (_w: string, _c: string) => ({
      ok: true as const,
      connection: revisionedConnectionWith(),
    }));
    const unsettledOperations = { creation: false, connectionIds: new Set<string>() };
    renderPanel({
      connections: [revisionedConnectionWith()],
      unsettledOperations,
      rotateWebhookAction: vi.fn(async () => ({
        ok: false as const,
        message: "Não foi possível confirmar",
        outcomeUnknown: true,
      })),
      getConnectionAction,
    });
    fireEvent.click(screen.getByRole("button", { name: "Gerar URL do webhook de Pipedrive principal" }));
    fireEvent.click(screen.getByRole("button", { name: "Gerar nova URL" }));

    await screen.findByText(/Requisição sem resposta final/);
    expect(getConnectionAction).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue(SYNTHETIC_WEBHOOK_URL)).toBeNull();
    expect(unsettledOperations.connectionIds.has("pipedrive_connection_1")).toBe(true);
  });
});

function openEvents() {
  const details = screen.getByText("Eventos recebidos", { selector: "summary span" }).closest("details")!;
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

describe("Pipedrive delivery results (events are read-only; only 'sent' is ever called sent)", () => {
  const cases = [
    ["publication_pending", "Aguardando envio"],
    ["queued", "Na fila de envio"],
    ["sent", "Enviado"],
    ["revoked", "Não enviado"],
    ["publication_failed", "Envio não realizado"],
    ["delivery_unknown", "Resultado desconhecido"],
    ["materialized", "Conversão registrada"],
    ["unrecognized", "Estado de envio não reconhecido"],
  ] as const;

  async function renderWithResult(result: ReturnType<typeof resultWith>, eventOverrides = {}) {
    const listEventsAction = vi.fn(async (_w: string, _c: string) => ({
      ok: true as const,
      events: [eventWith({ results: [result], ...eventOverrides })],
    }));
    const view = renderPanel({
      connections: [revisionedConnectionWith({ rules: [productionRuleWith({ id: "rule_1" })] })],
      listEventsAction,
    });
    openEvents();
    await waitFor(() => expect(listEventsAction).toHaveBeenCalled());
    return view;
  }

  it.each(cases)("renders %s as %j", async (deliveryStatus, label) => {
    await renderWithResult(
      resultWith({
        status: "materialized",
        valueCents: 19990,
        currency: "BRL",
        conversionEventLogId: "conv_log_0123456789abcdef",
        deliveryStatus,
        deliveryErrorCode: deliveryStatus === "publication_failed" ? "sender_not_ready" : null,
      }),
    );
    const delivery = await waitFor(() => {
      const node = document.querySelector(".pipedrive-delivery");
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    expect(delivery.textContent).toContain(label);
    expect(delivery.getAttribute("data-delivery-status")).toBe(deliveryStatus);
    expect(delivery.querySelector("[title='conv_log_0123456789abcdef']")).toBeTruthy();

    const sentLabels = screen.queryAllByText("Enviado");
    expect(sentLabels.length).toBe(deliveryStatus === "sent" ? 1 : 0);
    if (deliveryStatus === "publication_failed") {
      expect(delivery.textContent).toMatch(/canal ainda não está pronto/i);
    }
  });

  it("never claims anything was sent for an observed result", async () => {
    await renderWithResult(resultWith({ status: "observed", valueCents: 19990, currency: "BRL" }));
    await screen.findByText(/Ganho do negócio \/ .*Observado/);
    expect(document.querySelector(".pipedrive-delivery")).toBeNull();
    expect(screen.queryAllByText("Enviado")).toHaveLength(0);
  });

  it("shows an honest value for a result without value or currency", async () => {
    await renderWithResult(
      resultWith({ status: "materialized", eventName: "LeadSubmitted", conversionEventLogId: "conv_1", deliveryStatus: "queued" }),
    );
    await screen.findByText("Na fila de envio");
    expect(screen.queryByText(/\(.*\d,\d\d.*\)/)).toBeNull();
  });

  it("a delivery_unknown result is never offered for retry or reprocessing, even on a retryable failure", async () => {
    await renderWithResult(
      resultWith({ status: "materialized", conversionEventLogId: "conv_1", deliveryStatus: "delivery_unknown" }),
      { status: "failed", errorCode: "pipedrive_timeout" },
    );
    await screen.findByText(/nunca é reenviado nem reprocessado/);
    expect(screen.queryByRole("button", { name: /Reprocessar evento/ })).toBeNull();
    expect(screen.queryByText("Reprocessar")).toBeNull();
  });

  it("an unrecognized delivery status is treated as unknown as well", async () => {
    await renderWithResult(
      resultWith({ status: "materialized", deliveryStatus: "unrecognized" }),
      { status: "failed", errorCode: "pipedrive_timeout" },
    );
    await screen.findByText(/nunca é reenviado nem reprocessado/);
    expect(screen.queryByRole("button", { name: /Reprocessar evento/ })).toBeNull();
  });

  it("control: a retryable failure without an unknown delivery keeps its confirmed retry", async () => {
    await renderWithResult(resultWith({ status: "ignored", errorCode: "pipedrive_timeout" }), {
      status: "failed",
      errorCode: "pipedrive_timeout",
    });
    const retry = await screen.findByRole("button", { name: /Reprocessar evento de/ });
    fireEvent.click(retry);
    expect(screen.getByRole("button", { name: "Reprocessar evento" })).toBeTruthy();
  });

  it("offers no retry control to a role that cannot manage", async () => {
    const listEventsAction = vi.fn(async (_w: string, _c: string) => ({
      ok: true as const,
      events: [eventWith({ status: "failed", errorCode: "pipedrive_timeout" })],
    }));
    renderPanel({ canManage: false, listEventsAction });
    openEvents();
    await waitFor(() => expect(listEventsAction).toHaveBeenCalled());
    await screen.findByText(/Esta falha não pode ser reprocessada|Falhou/);
    expect(screen.queryByRole("button", { name: /Reprocessar evento de/ })).toBeNull();
  });
});
