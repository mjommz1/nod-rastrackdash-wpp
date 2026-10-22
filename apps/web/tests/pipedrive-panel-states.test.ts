// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectionWith,
  eventWith,
  resultWith,
  ruleWith,
} from "./support/pipedrive-fixtures";
import { formValues, renderPanel } from "./support/pipedrive-panel-harness";

const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));

afterEach(() => {
  cleanup();
  routerRefresh.mockClear();
});

function openEvents() {
  const details = screen.getByText("Eventos recebidos", { selector: "summary span" }).closest("details")!;
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

describe("Pipedrive read-only and unavailable states", () => {
  it("hides every mutation control for a role that cannot manage", () => {
    renderPanel({
      canManage: false,
      connections: [connectionWith({ rules: [ruleWith({ id: "r1" })] })],
    });

    expect(screen.queryByRole("button", { name: "Nova conexão" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Gerar URL do webhook/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Pausar conexão/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Atualizar catálogo/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remover/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Nova regra" })).toBeNull();
    expect(screen.queryByLabelText("Novo token de API")).toBeNull();
    expect(screen.queryByText("Editar regra")).toBeNull();
    expect(screen.getByText("Ganho do negócio")).toBeTruthy();
  });

  it("shows an actionable error, never the empty state, when the list failed to load", () => {
    renderPanel({ loadState: "error", connections: [] });

    expect(screen.getByRole("alert").textContent).toMatch(/Não foi possível carregar as conexões/);
    expect(screen.getByText("Indisponível")).toBeTruthy();
    expect(screen.queryByText(/Nenhuma conexão Pipedrive/)).toBeNull();
    expect(screen.queryByText(/0 conexão/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Nova conexão" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it("explains an expired or unauthorized session on forbidden loads", () => {
    renderPanel({ loadState: "forbidden", connections: [] });
    expect(screen.getByRole("alert").textContent).toMatch(/sessão não tem permissão/);
    expect(screen.queryByText(/Nenhuma conexão Pipedrive/)).toBeNull();
  });

  it("shows an honest empty state with the way forward", () => {
    renderPanel({ loadState: "empty", connections: [] });
    expect(screen.getByText(/Nenhuma conexão Pipedrive/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nova conexão" })).toBeTruthy();
  });

  it("marks stale/error catalogs and unverified accounts instead of inventing readiness", () => {
    renderPanel({
      connections: [
        connectionWith({
          catalogState: "error",
          lastErrorCode: "pipedrive_rate_limited",
          verifiedAccountId: null,
          accountSubdomain: null,
        }),
      ],
    });
    expect(screen.getByText("Falha ao atualizar catálogo")).toBeTruthy();
    expect(screen.getByText("Conta ainda não verificada")).toBeTruthy();
    expect(screen.getAllByText(/limitou as requisições/).length).toBeGreaterThan(0);
  });

  it("never prints an unknown error code as provider text", () => {
    renderPanel({
      connections: [connectionWith({ catalogState: "error", lastErrorCode: "Provider said: secret details!" })],
    });
    expect(screen.queryByText(/Provider said/)).toBeNull();
    expect(screen.getByText("Código desconhecido")).toBeTruthy();
  });

  it("treats an uncertain state after a failed read as non-editable until confirmed", async () => {
    const refreshCatalogAction = vi.fn(async () => ({ ok: false as const, message: "falhou" }));
    const getConnectionAction = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "network" })
      .mockResolvedValue({ ok: true, connection: connectionWith() });
    renderPanel({ refreshCatalogAction, getConnectionAction });

    fireEvent.click(screen.getByRole("button", { name: "Atualizar catálogo de Pipedrive principal" }));
    await screen.findByText("Estado não confirmado");
    expect((screen.getByRole("button", { name: "Salvar canais" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Confirmar estado atual" }));
    await waitFor(() => expect(screen.queryByText("Estado não confirmado")).toBeNull());
    expect(getConnectionAction).toHaveBeenCalledTimes(2);
  });
});

describe("Pipedrive received events (bounded, read-only diagnostics)", () => {
  it("does not request events until the section is opened", async () => {
    const view = renderPanel();
    expect(view.actions.listEventsAction).not.toHaveBeenCalled();
    openEvents();
    await waitFor(() => expect(view.actions.listEventsAction).toHaveBeenCalledWith("workspace_1", "pipedrive_connection_1"));
  });

  it("shows an honest empty state", async () => {
    renderPanel();
    openEvents();
    await screen.findByText(/Nenhum evento recebido ainda/);
  });

  it("shows loading, then rule names, event labels and values per result", async () => {
    let release: (value: any) => void = () => undefined;
    const listEventsAction = vi.fn(() => new Promise<any>((resolve) => { release = resolve; }));
    renderPanel({
      connections: [connectionWith({ rules: [ruleWith({ id: "r1" })] })],
      listEventsAction,
    });
    openEvents();
    await screen.findByText("Carregando eventos...");

    await act(async () => {
      release({
        ok: true,
        events: [
          eventWith({
            results: [
              resultWith({ ruleId: "r1", status: "observed", valueCents: 19990, currency: "BRL" }),
              resultWith({ ruleId: "gone", status: "ignored", errorCode: "event_currency_mismatch" }),
            ],
          }),
        ],
      });
    });

    expect(await screen.findByText(/Ganho do negócio \/ .*Observado/)).toBeTruthy();
    expect(screen.getByText(/199,90/)).toBeTruthy();
    expect(screen.getByText(/Regra removida/)).toBeTruthy();
    expect(screen.getByText(/Moeda do negócio diferente/)).toBeTruthy();
  });

  it("shows a retryable error when the list fails and retries on demand", async () => {
    const listEventsAction = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "network" })
      .mockResolvedValue({ ok: true, events: [eventWith()] });
    renderPanel({ listEventsAction });
    openEvents();
    await screen.findByText(/Não foi possível carregar os eventos/);
    expect(screen.queryByText(/Nenhum evento recebido ainda/)).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Tentar novamente" })[0]!);
    await screen.findByText("Observado", { selector: ".event-chip" });
  });

  it("flags a malformed events response without rendering it", async () => {
    renderPanel({ listEventsAction: vi.fn(async () => ({ ok: false as const, reason: "invalid_response" as const })) });
    openEvents();
    await screen.findByText(/formato inesperado/);
  });

  it("reports session loss when reading events", async () => {
    renderPanel({ listEventsAction: vi.fn(async () => ({ ok: false as const, reason: "unauthorized" as const })) });
    openEvents();
    await screen.findByText(/Sessão sem permissão para ver eventos/);
    await screen.findByText(/sessão não é mais válida/);
  });

  it("offers retry only for failed events with a transient code, behind a confirmation", async () => {
    const retryEventAction = vi.fn(async (_: FormData) => ({ ok: true as const, message: "Reprocessamento solicitado." }));
    const listEventsAction = vi.fn(async () => ({
      ok: true as const,
      events: [
        eventWith({ id: "e_transient", status: "failed", errorCode: "pipedrive_timeout", occurredAt: "2026-10-11T11:00:00.000Z" }),
        eventWith({ id: "e_exhausted", status: "failed", errorCode: "attempts_exhausted", occurredAt: "2026-10-11T12:00:00.000Z" }),
        eventWith({ id: "e_other", status: "failed", errorCode: "pipedrive_payload_invalid", occurredAt: "2026-10-11T13:00:00.000Z" }),
        eventWith({ id: "e_ok", status: "observed", occurredAt: "2026-10-11T14:00:00.000Z" }),
      ],
    }));
    renderPanel({ retryEventAction, listEventsAction });
    openEvents();
    await screen.findByText(/Corrija a causa e aguarde um novo movimento/);
    expect(screen.getByText(/Tentativas esgotadas\. Não é reprocessado automaticamente/)).toBeTruthy();

    const buttons = screen.getAllByRole("button", { name: /^Reprocessar evento de/ });
    expect(buttons).toHaveLength(1);
    expect(screen.getByText(/Esta falha não pode ser reprocessada/)).toBeTruthy();

    fireEvent.click(buttons[0]!);
    expect(retryEventAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reprocessar evento" }));

    await waitFor(() => expect(retryEventAction).toHaveBeenCalledTimes(1));
    expect(formValues(retryEventAction.mock.calls[0]![0])).toEqual({
      workspaceId: "workspace_1",
      connectionId: "pipedrive_connection_1",
      eventId: "e_transient",
    });
    await waitFor(() => expect(listEventsAction).toHaveBeenCalledTimes(2));
  });

  it("locks the retry of an event whose outcome is unknown", async () => {
    const retryEventAction = vi.fn(async (_: FormData) => ({
      ok: false as const,
      message: "Não foi possível confirmar",
      outcomeUnknown: true,
    }));
    renderPanel({
      retryEventAction,
      listEventsAction: vi.fn(async () => ({
        ok: true as const,
        events: [eventWith({ id: "e1", status: "failed", errorCode: "pipedrive_transport" })],
      })),
    });
    openEvents();
    const retry = await screen.findByRole("button", { name: /^Reprocessar evento de/ });
    fireEvent.click(retry);
    fireEvent.click(screen.getByRole("button", { name: "Reprocessar evento" }));

    await screen.findByText(/Reprocessamento sem resposta final/);
    expect((screen.getByRole("button", { name: /^Reprocessar evento de/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(retryEventAction).toHaveBeenCalledTimes(1);
  });

  it("does not show retry to a role that cannot manage", async () => {
    renderPanel({
      canManage: false,
      listEventsAction: vi.fn(async () => ({
        ok: true as const,
        events: [eventWith({ status: "failed", errorCode: "pipedrive_transport" })],
      })),
    });
    openEvents();
    await screen.findByText("Falhou");
    expect(screen.queryByRole("button", { name: /^Reprocessar evento de/ })).toBeNull();
  });

  it("bounds the visible list to 20 events with an explicit expand", async () => {
    const events = Array.from({ length: 40 }, (_, index) =>
      eventWith({ id: `e${index}`, occurredAt: new Date(Date.UTC(2026, 9, 11, 0, index)).toISOString() }),
    );
    renderPanel({ listEventsAction: vi.fn(async () => ({ ok: true as const, events })) });
    openEvents();
    await screen.findByRole("button", { name: "Ver todos (40)" });
    expect(screen.getByRole("list", { name: "Eventos recebidos" }).children).toHaveLength(20);

    fireEvent.click(screen.getByRole("button", { name: "Ver todos (40)" }));
    expect(screen.getByRole("list", { name: "Eventos recebidos" }).children).toHaveLength(40);
  });
});
