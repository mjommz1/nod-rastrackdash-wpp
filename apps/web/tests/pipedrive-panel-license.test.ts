// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectionWith,
  eventWith,
  resultWith,
  ruleWith,
  snapshotOf,
} from "./support/pipedrive-fixtures";
import { renderPanel } from "./support/pipedrive-panel-harness";

const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));

afterEach(() => {
  cleanup();
  routerRefresh.mockClear();
});

const LOCK_NOTE = /Licença bloqueada: criar, editar, pausar, gerar URL ou ativar envio está indisponível/;
const RULE_FORM_LOCK_NOTE = /Licença bloqueada: esta regra não pode ser salva agora/;
const connection = connectionWith({ rules: [ruleWith({ id: "r1" })] });

describe("Pipedrive panel under a license lock", () => {
  it("shows the notice and disables every write while keeping the data readable", () => {
    renderPanel({ connections: [connection], licenseLocked: true });

    expect(screen.getByText(LOCK_NOTE)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Nova conexão" }) as HTMLButtonElement).disabled).toBe(true);
    for (const name of [
      /Pausar conexão/,
      /Atualizar catálogo de/,
      /Gerar URL do webhook de/,
      /Remover conexão/,
    ]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByRole("button", { name: "Nova regra" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Salvar canais" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Substituir token" }) as HTMLButtonElement).disabled).toBe(true);
    // Reading is untouched.
    expect(screen.getByText("Pipedrive principal")).toBeTruthy();
    expect(screen.getAllByText("Ganho do negócio").length).toBeGreaterThan(0);
  });

  it("does not show the notice when the license is usable", () => {
    renderPanel({ connections: [connection], licenseLocked: false });

    expect(screen.queryByText(LOCK_NOTE)).toBeNull();
    expect((screen.getByRole("button", { name: "Nova conexão" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not show the notice to a role that cannot manage", () => {
    renderPanel({ connections: [connection], licenseLocked: true, canManage: false });

    expect(screen.queryByText(LOCK_NOTE)).toBeNull();
    expect(screen.queryByRole("button", { name: "Nova conexão" })).toBeNull();
  });

  it("locks the whole panel after the API answers 423 to a write, with no unknown outcome", async () => {
    const refreshCatalogAction = vi.fn(async (_: FormData) => ({
      ok: false as const,
      message: "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.",
      licenseLocked: true,
    }));
    renderPanel({ connections: [connection], refreshCatalogAction });

    expect(screen.queryByText(LOCK_NOTE)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Atualizar catálogo de/ }));

    await screen.findByText(LOCK_NOTE);
    expect(screen.getByRole("alert").textContent).toMatch(/Licença bloqueada/);
    expect(screen.queryByText(/Requisição sem resposta final/)).toBeNull();
    expect(screen.queryByText("Estado não confirmado")).toBeNull();
    expect((screen.getByRole("button", { name: /Gerar URL do webhook de/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Nova conexão" }) as HTMLButtonElement).disabled).toBe(true);
    expect(refreshCatalogAction).toHaveBeenCalledTimes(1);
  });

  it("blocks a connection attempt after a 423 on the create call", async () => {
    const createConnectionAction = vi.fn(async (_: FormData) => ({
      ok: false as const,
      message: "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.",
      licenseLocked: true,
    }));
    renderPanel({ connections: [], loadState: "empty", createConnectionAction });

    fireEvent.click(screen.getByRole("button", { name: "Nova conexão" }));
    fireEvent.change(screen.getByLabelText("Nome da conexão"), { target: { value: "Conta nova" } });
    fireEvent.change(screen.getByLabelText("Origem da conta Pipedrive"), {
      target: { value: "https://suaempresa.pipedrive.com" },
    });
    fireEvent.change(screen.getByLabelText("Token de API"), {
      target: { value: "synthetic-token-0123456789" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Conectar Pipedrive" }));

    await screen.findByText(LOCK_NOTE);
    expect(createConnectionAction).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Fechar" }) as HTMLButtonElement).disabled).toBe(true);
    // The form is locked and the token field stays masked.
    const token = screen.getByLabelText("Token de API") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Conectar Pipedrive" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("disables event reprocessing while locked", async () => {
    const listEventsAction = vi.fn(async (_w: string, _c: string) => ({
      ok: true as const,
      events: [
        eventWith({
          id: "event_failed",
          status: "failed",
          errorCode: "pipedrive_transport",
          results: [resultWith({ status: "observed" })],
        }),
      ],
    }));
    const retryEventAction = vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" }));
    renderPanel({
      connections: [connection],
      licenseLocked: true,
      listEventsAction,
      retryEventAction,
    });

    const details = screen
      .getByText("Eventos recebidos", { selector: "summary span" })
      .closest("details")!;
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });

    const retry = await waitFor(() => screen.getByRole("button", { name: /Reprocessar evento de/ }));
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(retry);
    expect(retryEventAction).not.toHaveBeenCalled();
  });

  it("keeps a rule edit from being sent while locked", async () => {
    const updateRuleAction = vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" }));
    renderPanel({
      connections: [connectionWith({ rules: [ruleWith({ id: "r1" })] })],
      licenseLocked: true,
      updateRuleAction,
    });

    for (const name of [
      /Ativar envio automático da regra/,
      /Pausar regra/,
      /Remover regra/,
    ]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(updateRuleAction).not.toHaveBeenCalled();
  });

  it("keeps the new-rule form disabled and explains why after a 423 on create", async () => {
    const createRuleAction = vi.fn(async (_: FormData) => ({
      ok: false as const,
      message: "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.",
      licenseLocked: true,
    }));
    renderPanel({ connections: [connectionWith({ rules: [] })], createRuleAction });

    fireEvent.click(screen.getByRole("button", { name: "Nova regra" }));
    fireEvent.change(screen.getByLabelText("Nome da regra"), {
      target: { value: "Regra bloqueada" },
    });
    fireEvent.change(screen.getByLabelText("Funil e etapa no Pipedrive"), {
      target: { value: "pipeline_1::stage_3" },
    });
    const submit = screen.getByRole("button", { name: "Criar regra" }) as HTMLButtonElement;
    expect(screen.queryByText(RULE_FORM_LOCK_NOTE)).toBeNull();
    fireEvent.click(submit);

    await screen.findByText(RULE_FORM_LOCK_NOTE);
    expect(createRuleAction).toHaveBeenCalledTimes(1);
    const button = screen.getByRole("button", { name: "Criar regra" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect((screen.getByLabelText("Nome da regra") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Funil e etapa no Pipedrive") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.submit(button.closest("form")!);
    expect(createRuleAction).toHaveBeenCalledTimes(1);
  });

  it("shows the license notice in the rule editor and keeps it from saving", () => {
    const updateRuleAction = vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" }));
    renderPanel({ connections: [connection], licenseLocked: true, updateRuleAction });

    const editor = screen.getByText("Editar regra").closest("details")!;
    expect(within(editor).getByText(RULE_FORM_LOCK_NOTE)).toBeTruthy();
    const save = within(editor).getByRole("button", { name: "Salvar regra", hidden: true }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.closest("form")!);
    expect(updateRuleAction).not.toHaveBeenCalled();
  });

  it("is not affected by an unrelated snapshot refresh", () => {
    const { rerenderWith } = renderPanel({ connections: [connection], licenseLocked: true });
    rerenderWith({ connections: [connectionWith({ ...snapshotOf(connection), rules: connection.rules })] });
    expect(screen.getByText(LOCK_NOTE)).toBeTruthy();
  });
});
