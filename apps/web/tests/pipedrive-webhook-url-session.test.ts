// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseConnection,
  connectionWith,
  SYNTHETIC_WEBHOOK_URL,
} from "./support/pipedrive-fixtures";
import { renderPanel } from "./support/pipedrive-panel-harness";

const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}));

const rotatedAt = "2026-10-11T12:00:00.000Z";
const mint = (url: string) => async () => ({
  ok: true as const,
  message: "gerada",
  oneTimeWebhook: { webhookUrl: url, version: 1, rotatedAt },
});

const rotateLabel = "Gerar URL do webhook de Pipedrive principal";

async function rotate() {
  fireEvent.click(screen.getByRole("button", { name: rotateLabel }));
  fireEvent.click(screen.getByRole("button", { name: "Gerar nova URL" }));
}

function urlInput() {
  return screen.queryByLabelText("URL do webhook Pipedrive de Pipedrive principal");
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  cleanup();
  routerRefresh.mockClear();
});

describe("Pipedrive one-time webhook URL (memory only)", () => {
  it("asks for confirmation before rotating and mints nothing on cancel", async () => {
    const rotateWebhookAction = vi.fn(mint(SYNTHETIC_WEBHOOK_URL));
    renderPanel({ rotateWebhookAction });

    fireEvent.click(screen.getByRole("button", { name: rotateLabel }));
    expect(screen.getByText(/invalida qualquer URL anterior/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(rotateWebhookAction).not.toHaveBeenCalled();
    expect(urlInput()).toBeNull();
  });

  it("shows the minted URL, copies it, and hides it on request", async () => {
    const rotateWebhookAction = vi.fn(mint(SYNTHETIC_WEBHOOK_URL));
    renderPanel({ rotateWebhookAction });

    await rotate();
    const input = (await screen.findByDisplayValue(SYNTHETIC_WEBHOOK_URL)) as HTMLInputElement;
    expect(input.readOnly).toBe(true);

    const sent = (rotateWebhookAction.mock.calls as unknown[][])[0]![0] as FormData;
    expect(sent.get("workspaceId")).toBe("workspace_1");
    expect(sent.get("connectionId")).toBe("pipedrive_connection_1");

    fireEvent.click(screen.getByRole("button", { name: "Copiar URL" }));
    await waitFor(() => expect(screen.getByText("Copiada")).toBeTruthy());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SYNTHETIC_WEBHOOK_URL);

    fireEvent.click(screen.getByRole("button", { name: "Ocultar URL" }));
    expect(screen.queryByDisplayValue(SYNTHETIC_WEBHOOK_URL)).toBeNull();
  });

  it("never writes the URL to browser storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    renderPanel({ rotateWebhookAction: mint(SYNTHETIC_WEBHOOK_URL) });
    await rotate();
    await screen.findByDisplayValue(SYNTHETIC_WEBHOOK_URL);
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify(window.localStorage)).not.toContain("SYNTHETIC-SECRET");
    setItem.mockRestore();
  });

  it("is gone after a reload (remount): the secret exists in memory only", async () => {
    const first = renderPanel({ rotateWebhookAction: mint(SYNTHETIC_WEBHOOK_URL) });
    await rotate();
    await screen.findByDisplayValue(SYNTHETIC_WEBHOOK_URL);
    first.unmount();

    renderPanel();
    expect(screen.queryByDisplayValue(SYNTHETIC_WEBHOOK_URL)).toBeNull();
  });

  it("keeps the URL across a passive same-identity refresh (status/catalog/timestamp only)", async () => {
    const view = renderPanel({ rotateWebhookAction: mint(SYNTHETIC_WEBHOOK_URL) });
    await rotate();
    await screen.findByDisplayValue(SYNTHETIC_WEBHOOK_URL);

    view.rerenderWith({
      connections: [
        connectionWith({
          catalogState: "stale",
          catalogRefreshedAt: "2026-10-11T13:00:00.000Z",
          updatedAt: "2026-10-11T13:00:00.000Z",
        }),
      ],
    });

    await waitFor(() => expect(view.actions.getConnectionAction).toHaveBeenCalled());
    expect(screen.getByDisplayValue(SYNTHETIC_WEBHOOK_URL)).toBeTruthy();
  });

  it("hides the URL when the refreshed connection is a different Pipedrive account", async () => {
    const view = renderPanel({ rotateWebhookAction: mint(SYNTHETIC_WEBHOOK_URL) });
    await rotate();
    await screen.findByDisplayValue(SYNTHETIC_WEBHOOK_URL);

    view.rerenderWith({
      connections: [
        connectionWith({
          verifiedAccountId: "account_other",
          accountSubdomain: "outraempresa",
          accountOrigin: "https://outraempresa.pipedrive.com",
          updatedAt: "2026-10-11T14:00:00.000Z",
        }),
      ],
    });

    await waitFor(() => expect(screen.queryByDisplayValue(SYNTHETIC_WEBHOOK_URL)).toBeNull());
  });

  it("keeps the URL visible when copying fails and tells the user to copy manually", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
    });
    renderPanel({ rotateWebhookAction: mint(SYNTHETIC_WEBHOOK_URL) });
    await rotate();
    await screen.findByDisplayValue(SYNTHETIC_WEBHOOK_URL);

    fireEvent.click(screen.getByRole("button", { name: "Copiar URL" }));
    await screen.findByText(/Selecione a URL e copie manualmente/);

    expect(screen.getByDisplayValue(SYNTHETIC_WEBHOOK_URL)).toBeTruthy();
    expect(screen.queryByText("Copiada")).toBeNull();
  });

  it("hides the URL as soon as the session is lost during another action", async () => {
    const refreshCatalogAction = vi.fn(async () => ({
      ok: false as const,
      message: "Sua sessão expirou",
      authFailure: "unauthorized" as const,
    }));
    renderPanel({ rotateWebhookAction: mint(SYNTHETIC_WEBHOOK_URL), refreshCatalogAction });
    await rotate();
    await screen.findByDisplayValue(SYNTHETIC_WEBHOOK_URL);

    fireEvent.click(screen.getByRole("button", { name: "Atualizar catálogo de Pipedrive principal" }));

    await waitFor(() => expect(screen.queryByDisplayValue(SYNTHETIC_WEBHOOK_URL)).toBeNull());
    expect(screen.getByText(/sessão não é mais válida/)).toBeTruthy();
  });

  it("hides the URL when manage permission is lost on a later render", async () => {
    const view = renderPanel({ rotateWebhookAction: mint(SYNTHETIC_WEBHOOK_URL) });
    await rotate();
    await screen.findByDisplayValue(SYNTHETIC_WEBHOOK_URL);

    view.rerenderWith({ canManage: false });
    expect(screen.queryByDisplayValue(SYNTHETIC_WEBHOOK_URL)).toBeNull();
  });

  it("hides the URL when the connection list becomes unavailable", async () => {
    const view = renderPanel({ rotateWebhookAction: mint(SYNTHETIC_WEBHOOK_URL) });
    await rotate();
    await screen.findByDisplayValue(SYNTHETIC_WEBHOOK_URL);

    view.rerenderWith({ loadState: "forbidden", connections: [] });
    expect(screen.queryByDisplayValue(SYNTHETIC_WEBHOOK_URL)).toBeNull();
  });

  it("hides the URL when the connection disappears from refreshed props", async () => {
    const view = renderPanel({ rotateWebhookAction: mint(SYNTHETIC_WEBHOOK_URL) });
    await rotate();
    await screen.findByDisplayValue(SYNTHETIC_WEBHOOK_URL);

    view.rerenderWith({ connections: [], loadState: "empty" });
    expect(screen.queryByDisplayValue(SYNTHETIC_WEBHOOK_URL)).toBeNull();
  });

  it("clears the previous URL the moment a new rotation starts and shows only the new one", async () => {
    let call = 0;
    const urls = [SYNTHETIC_WEBHOOK_URL, "https://synthetic.invalid/webhooks/pipedrive/SYNTHETIC-SECRET-2"];
    const rotateWebhookAction = vi.fn(async () => mint(urls[call++]!)());
    renderPanel({ rotateWebhookAction });

    await rotate();
    await screen.findByDisplayValue(urls[0]!);
    await rotate();
    await screen.findByDisplayValue(urls[1]!);

    expect(screen.queryByDisplayValue(urls[0]!)).toBeNull();
  });

  it("discards an out-of-order stale read so it cannot hide the newer URL", async () => {
    let resolveStale: (value: any) => void = () => undefined;
    const getConnectionAction = vi.fn(
      () => new Promise<any>((resolve) => { resolveStale = resolve; }),
    );
    let call = 0;
    const urls = [SYNTHETIC_WEBHOOK_URL, "https://synthetic.invalid/webhooks/pipedrive/SYNTHETIC-SECRET-2"];
    const rotateWebhookAction = vi.fn(async () => mint(urls[call++]!)());
    const view = renderPanel({ rotateWebhookAction, getConnectionAction });

    await rotate();
    await screen.findByDisplayValue(urls[0]!);

    view.rerenderWith({
      connections: [connectionWith({ displayName: "Pipedrive principal", updatedAt: "2026-10-11T13:00:00.000Z", catalogState: "stale" })],
    });
    await waitFor(() => expect(getConnectionAction).toHaveBeenCalled());

    await rotate();
    await screen.findByDisplayValue(urls[1]!);

    await act(async () => {
      resolveStale({
        ok: true,
        connection: connectionWith({
          verifiedAccountId: "account_swapped",
          accountSubdomain: "trocada",
          accountOrigin: "https://trocada.pipedrive.com",
          updatedAt: "2026-10-11T12:30:00.000Z",
        }),
      });
    });

    expect(screen.getByDisplayValue(urls[1]!)).toBeTruthy();
  });

  it("an unknown rotation outcome shows no URL, locks the connection, and survives close/reopen", async () => {
    const unsettledOperations = { creation: false, connectionIds: new Set<string>() };
    const rotateWebhookAction = vi.fn(async () => ({
      ok: false as const,
      message: "Não foi possível confirmar",
      outcomeUnknown: true,
    }));
    const view = renderPanel({ rotateWebhookAction, unsettledOperations });

    await rotate();
    await screen.findByText(/Requisição sem resposta final/);
    expect(urlInput()).toBeNull();
    expect((screen.getByRole("button", { name: rotateLabel }) as HTMLButtonElement).disabled).toBe(true);
    expect(unsettledOperations.connectionIds.has(baseConnection.id)).toBe(true);

    view.unmount();
    const reopenedRotate = vi.fn(mint(SYNTHETIC_WEBHOOK_URL));
    renderPanel({ unsettledOperations, rotateWebhookAction: reopenedRotate });
    expect((screen.getByRole("button", { name: rotateLabel }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remover conexão Pipedrive principal" }) as HTMLButtonElement).disabled).toBe(true);
    expect(reopenedRotate).not.toHaveBeenCalled();
  });

  it("a rejected rotation promise is treated as an unknown outcome, not as success", async () => {
    const rotateWebhookAction = vi.fn(async () => { throw new Error("network"); });
    renderPanel({ rotateWebhookAction });

    await rotate();
    await screen.findByText(/Requisição sem resposta final/);
    expect(urlInput()).toBeNull();
  });

  it("revoking requires its own confirmation and clears any displayed URL", async () => {
    const revokeWebhookAction = vi.fn(async () => ({ ok: true as const, message: "revogada", revoked: true }));
    renderPanel({ rotateWebhookAction: mint(SYNTHETIC_WEBHOOK_URL), revokeWebhookAction });
    await rotate();
    await screen.findByDisplayValue(SYNTHETIC_WEBHOOK_URL);

    fireEvent.click(screen.getByRole("button", { name: rotateLabel }));
    fireEvent.click(screen.getByRole("button", { name: "Revogar URL atual" }));
    expect(revokeWebhookAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Revogar URL" }));
    await waitFor(() => expect(revokeWebhookAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByDisplayValue(SYNTHETIC_WEBHOOK_URL)).toBeNull());
  });
});
