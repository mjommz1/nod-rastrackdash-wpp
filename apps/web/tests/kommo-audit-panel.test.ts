// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KommoAuditPanel } from "../src/app/(app)/settings/kommo-audit-panel";
import type {
  KommoEventDto,
  KommoEventsResult,
} from "../src/app/(app)/integrations/kommo-actions";

afterEach(() => cleanup());

type ListFn = (w: string, c: string, cursor?: string) => Promise<KommoEventsResult>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function event(id: string, overrides: Partial<KommoEventDto> = {}): KommoEventDto {
  return {
    id,
    dealId: `deal_${id}`,
    pipelineId: "pipeline_1",
    statusId: "status_1",
    status: "observed",
    errorCode: null,
    errorMessage: null,
    attempts: 1,
    results: [
      {
        ruleId: `rule_${id}`,
        eventName: "QualifiedLead",
        status: "observed",
        errorCode: null,
        publicationStatus: null,
        publicationErrorCode: null,
        publicationErrorMessage: null,
        senderStatus: null,
      },
    ],
    ...overrides,
  };
}

const pipelines = [
  {
    id: "pipeline_1",
    name: "Vendas",
    sort: 1,
    status: { id: "status_1", name: "Negociação", type: "ordinary" },
    available: true,
  },
];

function panel(listEventsAction: ListFn, props: Partial<ComponentProps<typeof KommoAuditPanel>> = {}) {
  return createElement(KommoAuditPanel, {
    workspaceId: "workspace_1",
    connectionId: "connection_1",
    connectionLabel: "Kommo suaempresa",
    pipelines,
    listEventsAction,
    ...props,
  });
}

function renderPanel(
  listEventsAction: ListFn | ReturnType<typeof vi.fn>,
  props: Partial<ComponentProps<typeof KommoAuditPanel>> = {},
) {
  return render(panel(listEventsAction as ListFn, props));
}

const consult = () => screen.getByRole("button", { name: "Consultar auditoria" });

describe("KommoAuditPanel", () => {
  it("starts unqueried and does not call the API until the user asks", () => {
    const list = vi.fn();
    renderPanel(list);
    expect(list).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(
      "A auditoria ainda não foi consultada.",
    );
    expect(
      screen.getByRole("heading", { name: "Auditoria de webhooks · Kommo suaempresa" }),
    ).toBeTruthy();
  });

  it("loads events, resolves stage names, and explains what the audit does and does not prove", async () => {
    const list = vi.fn().mockResolvedValue({
      ok: true,
      events: [event("e1")],
      nextCursor: null,
    });
    renderPanel(list);
    fireEvent.click(consult());

    expect(await screen.findByText("Lead Kommo #deal_e1")).toBeTruthy();
    expect(list).toHaveBeenCalledWith("workspace_1", "connection_1", undefined);
    expect(screen.getByText("Vendas · Negociação")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("1 evento carregado; fim da lista.");
    const stages = screen.getByRole("list", { name: "Etapas deste evento" });
    expect(within(stages).getByText("Webhook recebido:")).toBeTruthy();
    expect(within(stages).getByText("Envio confirmado:")).toBeTruthy();
    expect(within(stages).getByText(/Nada foi enviado\./)).toBeTruthy();
    expect(screen.getByText(/A API não informa data ou hora dos eventos\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Atualizar auditoria" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Carregar mais eventos" })).toBeNull();
  });

  it("falls back to ids when the stage is not in the catalog", async () => {
    const list = vi.fn().mockResolvedValue({
      ok: true,
      events: [event("e1", { pipelineId: "p9", statusId: "s9" })],
      nextCursor: null,
    });
    renderPanel(list);
    fireEvent.click(consult());
    expect(await screen.findByText("Pipeline p9 · estágio s9")).toBeTruthy();
  });

  it("shows an empty state for a connection with no webhooks", async () => {
    renderPanel(vi.fn().mockResolvedValue({ ok: true, events: [], nextCursor: null }));
    fireEvent.click(consult());
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Nenhum webhook registrado para esta conexão ainda.",
      ),
    );
  });

  it("pages forward with the cursor and de-duplicates repeated ids", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, events: [event("e1"), event("e2")], nextCursor: "e2" })
      .mockResolvedValueOnce({ ok: true, events: [event("e2"), event("e3")], nextCursor: null });
    renderPanel(list);
    fireEvent.click(consult());
    await screen.findByText("Lead Kommo #deal_e2");
    expect(screen.getByRole("status").textContent).toBe("2 eventos carregados; há mais eventos.");

    fireEvent.click(screen.getByRole("button", { name: "Carregar mais eventos" }));
    await screen.findByText("Lead Kommo #deal_e3");
    expect(list).toHaveBeenLastCalledWith("workspace_1", "connection_1", "e2");
    expect(screen.getAllByText(/^Lead Kommo #/)).toHaveLength(3);
    expect(screen.getByRole("status").textContent).toBe("3 eventos carregados; fim da lista.");
    expect(screen.queryByRole("button", { name: "Carregar mais eventos" })).toBeNull();
  });

  it("ignores a second click while a request is in flight", async () => {
    const gate = deferred<KommoEventsResult>();
    const list = vi.fn().mockReturnValue(gate.promise);
    renderPanel(list);
    const button = consult();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(list).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("Carregando auditoria…");
    gate.resolve({ ok: true, events: [], nextCursor: null });
    await waitFor(() => expect(screen.queryByText("Carregando auditoria…")).toBeNull());
  });

  it("shows a retryable error, keeps loaded events, and retries the same page", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, events: [event("e1")], nextCursor: "e1" })
      .mockResolvedValueOnce({ ok: false, reason: "network" })
      .mockResolvedValueOnce({ ok: true, events: [event("e2")], nextCursor: null });
    renderPanel(list);
    fireEvent.click(consult());
    await screen.findByText("Lead Kommo #deal_e1");

    fireEvent.click(screen.getByRole("button", { name: "Carregar mais eventos" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Não foi possível carregar a auditoria agora.");
    expect(screen.getByText("Lead Kommo #deal_e1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await screen.findByText("Lead Kommo #deal_e2");
    expect(list).toHaveBeenLastCalledWith("workspace_1", "connection_1", "e1");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("treats a thrown action as a network failure", async () => {
    renderPanel(vi.fn().mockRejectedValue(new Error("offline")));
    fireEvent.click(consult());
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Não foi possível carregar a auditoria agora.",
    );
  });

  it("unauthorized (member/expired) shows owner-only copy and offers no retry", async () => {
    renderPanel(vi.fn().mockResolvedValue({ ok: false, reason: "unauthorized" }));
    fireEvent.click(consult());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Somente o proprietário do workspace");
    expect(screen.queryByRole("button", { name: "Tentar novamente" })).toBeNull();
  });

  it("maps not_found / invalid_response / invalid_request to distinct copy", async () => {
    for (const [reason, copy] of [
      ["not_found", "Conexão Kommo não encontrada neste workspace."],
      ["invalid_response", "formato inesperado e foi descartada"],
      ["invalid_request", "Não foi possível pedir esta página da auditoria."],
    ] as const) {
      const { unmount } = renderPanel(vi.fn().mockResolvedValue({ ok: false, reason }));
      fireEvent.click(consult());
      expect((await screen.findByRole("alert")).textContent).toContain(copy);
      unmount();
    }
  });

  it("stays readable while the license is locked and says writes are unavailable", async () => {
    const list = vi.fn().mockResolvedValue({ ok: true, events: [event("e1")], nextCursor: null });
    renderPanel(list, { licenseLocked: true });
    expect(
      screen.getByText(
        /Licença bloqueada: alterações estão indisponíveis, mas a consulta à auditoria continua funcionando\./,
      ),
    ).toBeTruthy();
    expect((consult() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(consult());
    expect(await screen.findByText("Lead Kommo #deal_e1")).toBeTruthy();
  });

  it("renders delivery-unknown honestly and unmatched leads as audit-only", async () => {
    const list = vi.fn().mockResolvedValue({
      ok: true,
      events: [
        event("e1", {
          status: "sent",
          errorCode: "kommo_delivery_unknown",
          results: [
            {
              ruleId: "rule_e1",
              eventName: "Purchase",
              status: "materialized",
              errorCode: null,
              publicationStatus: "delivery_unknown",
              publicationErrorCode: "kommo_delivery_unknown",
              publicationErrorMessage: null,
              senderStatus: null,
            },
          ],
        }),
        event("e2", { status: "blocked", errorCode: "workspace_lead_not_found", results: [] }),
      ],
      nextCursor: null,
    });
    renderPanel(list);
    fireEvent.click(consult());
    await screen.findByText("Lead Kommo #deal_e1");

    expect(screen.getByText("Entrega desconhecida (reenvio bloqueado)")).toBeTruthy();
    expect(screen.getAllByText(/Não afirmamos que foi enviado/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Envio confirmado ao Meta.")).toBeNull();
    expect(
      screen.getAllByText(
        "Somente auditoria: nenhuma conversão foi criada nem enviada para este evento.",
      ),
    ).toHaveLength(1);
  });

  it("shows unknown error codes as technical codes only", async () => {
    const list = vi.fn().mockResolvedValue({
      ok: true,
      events: [event("e1", { errorCode: "brand_new_code" })],
      nextCursor: null,
    });
    const { container } = renderPanel(list);
    fireEvent.click(consult());
    await screen.findByText("Lead Kommo #deal_e1");
    expect(container.textContent).toContain("Código técnico: brand_new_code");
  });

  it("drops an out-of-order response from a previous scope", async () => {
    const first = deferred<KommoEventsResult>();
    const list = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ok: true, events: [event("b1")], nextCursor: null });
    const view = renderPanel(list);
    fireEvent.click(consult());

    view.rerender(
      panel(list as unknown as ListFn, {
        connectionId: "connection_2",
        connectionLabel: "Kommo outra",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "A auditoria ainda não foi consultada.",
      ),
    );
    first.resolve({ ok: true, events: [event("a1")], nextCursor: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText("Lead Kommo #deal_a1")).toBeNull();

    fireEvent.click(consult());
    expect(await screen.findByText("Lead Kommo #deal_b1")).toBeTruthy();
    expect(list).toHaveBeenLastCalledWith("workspace_1", "connection_2", undefined);
    expect(screen.queryByText("Lead Kommo #deal_a1")).toBeNull();
  });

  it("refresh replaces the list instead of appending", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, events: [event("e1")], nextCursor: null })
      .mockResolvedValueOnce({ ok: true, events: [event("e9")], nextCursor: null });
    renderPanel(list);
    fireEvent.click(consult());
    await screen.findByText("Lead Kommo #deal_e1");
    fireEvent.click(screen.getByRole("button", { name: "Atualizar auditoria" }));
    await screen.findByText("Lead Kommo #deal_e9");
    expect(screen.queryByText("Lead Kommo #deal_e1")).toBeNull();
  });
});

describe("KommoAuditPanel authorization loss", () => {
  it("reports an unauthorized read once, clears loaded rows and locks refresh and paging", async () => {
    const onUnauthorized = vi.fn();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, events: [event("e1")], nextCursor: "e1" })
      .mockResolvedValueOnce({ ok: false, reason: "unauthorized" });
    renderPanel(list, { onUnauthorized });
    fireEvent.click(consult());
    await screen.findByText("Lead Kommo #deal_e1");

    fireEvent.click(screen.getByRole("button", { name: "Carregar mais eventos" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Somente o proprietário do workspace",
    );
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Lead Kommo #deal_e1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Carregar mais eventos" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tentar novamente" })).toBeNull();
    const refresh = screen.getByRole("button", { name: "Consultar auditoria" }) as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
    fireEvent.click(refresh);
    expect(list).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("a transient error keeps the last-known rows and never reports authorization loss", async () => {
    const onUnauthorized = vi.fn();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, events: [event("e1")], nextCursor: null })
      .mockResolvedValueOnce({ ok: false, reason: "network" });
    renderPanel(list, { onUnauthorized });
    fireEvent.click(consult());
    await screen.findByText("Lead Kommo #deal_e1");
    fireEvent.click(screen.getByRole("button", { name: "Atualizar auditoria" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Lead Kommo #deal_e1")).toBeTruthy();
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "Atualizar auditoria" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("an older successful read that lands after the unauthorized answer cannot restore rows", async () => {
    const older = deferred<KommoEventsResult>();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, events: [event("e1")], nextCursor: null })
      .mockReturnValueOnce(older.promise);
    const view = renderPanel(list);
    fireEvent.click(consult());
    await screen.findByText("Lead Kommo #deal_e1");
    fireEvent.click(screen.getByRole("button", { name: "Atualizar auditoria" }));
    expect(list).toHaveBeenCalledTimes(2);

    // The parent revokes while the older read is still outstanding.
    view.rerender(panel(list as ListFn, { authorityLost: true }));
    await waitFor(() => expect(screen.queryByText("Lead Kommo #deal_e1")).toBeNull());

    older.resolve({ ok: true, events: [event("late")], nextCursor: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Lead Kommo #deal_late")).toBeNull();
    expect(screen.queryByText("Lead Kommo #deal_e1")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Somente o proprietário do workspace");
  });

  it("an unauthorized answer to a superseded read still fails closed", async () => {
    const onUnauthorized = vi.fn();
    const slow = deferred<KommoEventsResult>();
    const list = vi.fn().mockReturnValueOnce(slow.promise);
    const view = renderPanel(list, { onUnauthorized });
    fireEvent.click(consult());
    view.rerender(panel(list as ListFn, { onUnauthorized, connectionId: "connection_2" }));

    slow.resolve({ ok: false, reason: "unauthorized" });
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alert").textContent).toContain("Somente o proprietário do workspace");
  });

  it("mounting with authorityLost shows no rows and refuses to read", () => {
    const list = vi.fn();
    renderPanel(list, { authorityLost: true });
    expect(screen.getByRole("alert").textContent).toContain("Somente o proprietário do workspace");
    const button = screen.getByRole("button", { name: "Consultar auditoria" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(list).not.toHaveBeenCalled();
  });

  it("does not call onUnauthorized again when the parent already revoked", async () => {
    const onUnauthorized = vi.fn();
    const gate = deferred<KommoEventsResult>();
    const list = vi.fn().mockReturnValueOnce(gate.promise);
    const view = renderPanel(list, { onUnauthorized });
    fireEvent.click(consult());
    view.rerender(panel(list as ListFn, { onUnauthorized, authorityLost: true }));
    gate.resolve({ ok: false, reason: "unauthorized" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
