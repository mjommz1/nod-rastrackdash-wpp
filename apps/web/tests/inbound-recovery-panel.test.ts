// @vitest-environment jsdom
import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboundRecoveryPanel } from "../src/app/(app)/integrations/inbound-recovery-panel";
import {
  authorizeInboundRecoveryAction,
  inboundRecoveryResultAction,
  previewInboundRecoveryAction,
} from "../src/app/(app)/integrations/inbound-recovery-actions";
import type {
  StudentInboundReplayPreviewDto,
  StudentInboundReplayResultDto,
} from "@wpptrack/shared";

vi.mock("../src/app/(app)/integrations/inbound-recovery-actions", () => ({
  authorizeInboundRecoveryAction: vi.fn(),
  inboundRecoveryResultAction: vi.fn(),
  previewInboundRecoveryAction: vi.fn(),
}));
const preview = (
  change: Partial<StudentInboundReplayPreviewDto> = {},
): StudentInboundReplayPreviewDto => ({
  connectionId: "connection",
  channelId: "channel",
  eligible: 2,
  scanned: 3,
  scanLimit: 2500,
  batchLimit: 500,
  previewToken: "signed-preview",
  expiresAt: "2026-10-05T12:10:00Z",
  unavailableReason: null,
  canSendRemaining: false,
  latestBatch: null,
  ...change,
});
const result = (
  state: StudentInboundReplayResultDto["state"] = "pending",
): StudentInboundReplayResultDto => ({
  batchId: "batch",
  selection: "canary_1",
  state,
  total: 1,
  delivered: state === "delivered" ? 1 : 0,
  pending: ["pending", "processing"].includes(state) ? 1 : 0,
  failed: state === "failed" ? 1 : 0,
  unknown: state === "delivery_unknown" ? 1 : 0,
  items: [{ id: "item", state }],
});
async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}
async function mount() {
  render(
    createElement(InboundRecoveryPanel, {
      connectionId: "connection",
      channelId: "channel",
      connectionName: "Meta oficial",
    }),
  );
  await click("Recuperar CTWAs anteriores");
}
function confirmName() {
  fireEvent.change(screen.getByLabelText("Nome da conexao para confirmar"), {
    target: { value: "Meta oficial" },
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(previewInboundRecoveryAction).mockResolvedValue({
    ok: true,
    data: preview(),
  });
  vi.mocked(authorizeInboundRecoveryAction).mockResolvedValue({
    ok: true,
    data: result(),
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("owner recovery clicks and status polling", () => {
  it("opens a read-only preview and requires the exact name and real-send dialog", async () => {
    await mount();
    expect(previewInboundRecoveryAction).toHaveBeenCalledWith(
      "connection",
      "channel",
    );
    expect(authorizeInboundRecoveryAction).not.toHaveBeenCalled();
    await click("Enviar um de teste");
    expect(window.confirm).not.toHaveBeenCalled();
    confirmName();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await click("Enviar um de teste");
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("UMA conversao CTWA real"),
    );
    expect(authorizeInboundRecoveryAction).not.toHaveBeenCalled();
    await click("Enviar um de teste");
    expect(authorizeInboundRecoveryAction).toHaveBeenCalledTimes(1);
    expect(authorizeInboundRecoveryAction).toHaveBeenCalledWith(
      "connection",
      "channel",
      {
        previewToken: "signed-preview",
        confirmation: "Meta oficial",
        selection: "canary_1",
      },
    );
    expect(screen.getByRole("status").textContent).toContain("Pendente");
    expect(
      screen.queryByRole("button", { name: "Enviar um de teste" }),
    ).toBeNull();
  });
  it("polls pending/processing and unlocks remaining only after sent confirmation and fresh preview", async () => {
    await mount();
    confirmName();
    await click("Enviar um de teste");
    vi.mocked(inboundRecoveryResultAction)
      .mockResolvedValueOnce({ ok: true, data: result("processing") })
      .mockResolvedValueOnce({ ok: true, data: result("delivered") });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByRole("status").textContent).toContain("Processando");
    expect(
      screen.queryByRole("button", { name: "Recuperar os demais (ate 500)" }),
    ).toBeNull();
    vi.mocked(previewInboundRecoveryAction).mockResolvedValue({
      ok: true,
      data: preview({
        previewToken: "fresh-preview",
        canSendRemaining: true,
        eligible: 1,
        latestBatch: result("delivered"),
      }),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(inboundRecoveryResultAction).toHaveBeenCalledWith(
      "connection",
      "channel",
      "batch",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Entrega confirmada pela Meta",
    );
    confirmName();
    await click("Recuperar os demais (ate 500)");
    expect(authorizeInboundRecoveryAction).toHaveBeenLastCalledWith(
      "connection",
      "channel",
      {
        previewToken: "fresh-preview",
        confirmation: "Meta oficial",
        selection: "remaining",
      },
    );
    expect(window.confirm).toHaveBeenLastCalledWith(
      expect.stringContaining("ate 500"),
    );
  });
  it.each(["failed", "delivery_unknown"] as const)(
    "shows %s honestly and never enables remaining or retry",
    async (state) => {
      await mount();
      confirmName();
      await click("Enviar um de teste");
      vi.mocked(inboundRecoveryResultAction).mockResolvedValue({
        ok: true,
        data: result(state),
      });
      vi.mocked(previewInboundRecoveryAction).mockResolvedValue({
        ok: true,
        data: preview({
          previewToken: null,
          latestBatch: result(state),
          unavailableReason:
            state === "delivery_unknown" ? "Entrega incerta: aguarde" : null,
        }),
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByRole("status").textContent).toContain(
        state === "delivery_unknown" ? "UNKNOWN" : "Falhou",
      );
      expect(
        screen.queryByRole("button", { name: "Recuperar os demais (ate 500)" }),
      ).toBeNull();
      expect(authorizeInboundRecoveryAction).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(inboundRecoveryResultAction).toHaveBeenCalledTimes(1);
    },
  );
  it("refreshes unavailable/empty previews and never dispatches by opening or refreshing", async () => {
    vi.mocked(previewInboundRecoveryAction)
      .mockResolvedValueOnce({
        ok: true,
        data: preview({
          previewToken: null,
          unavailableReason:
            "Operador: habilite INBOUND_WEBHOOK_REPLAY_ENABLED",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        data: preview({ eligible: 0, previewToken: null }),
      });
    await mount();
    expect(screen.getByRole("alert").textContent).toContain(
      "INBOUND_WEBHOOK_REPLAY_ENABLED",
    );
    await click("Atualizar previa e resultado");
    expect(screen.getByText(/Nenhum CTWA anterior elegivel/)).toBeTruthy();
    expect(authorizeInboundRecoveryAction).not.toHaveBeenCalled();
  });
  it("invalidates an approval on authorization error and requires a fresh preview", async () => {
    await mount();
    confirmName();
    vi.mocked(authorizeInboundRecoveryAction).mockResolvedValue({
      ok: false,
      message: "A conexao ou a rota mudou. Atualize a previa antes de enviar",
    });
    await click("Enviar um de teste");
    expect(screen.getByRole("alert").textContent).toContain("rota mudou");
    expect(
      screen.queryByLabelText("Nome da conexao para confirmar"),
    ).toBeNull();
    await click("Atualizar previa e resultado");
    expect(
      screen.getByLabelText("Nome da conexao para confirmar"),
    ).toBeTruthy();
  });
  it("continues polling after a transient read error and cancels when closed", async () => {
    await mount();
    confirmName();
    await click("Enviar um de teste");
    vi.mocked(inboundRecoveryResultAction)
      .mockResolvedValueOnce({
        ok: false,
        message: "API temporariamente indisponivel",
      })
      .mockResolvedValue({ ok: true, data: result("processing") });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(inboundRecoveryResultAction).toHaveBeenCalledTimes(2);
    await click("Recuperar CTWAs anteriores");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(inboundRecoveryResultAction).toHaveBeenCalledTimes(2);
  });
});
