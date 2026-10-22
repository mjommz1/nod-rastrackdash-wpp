// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../src/components/modal";
import {
  buildIntegrationCards,
  type IntegrationHubSnapshot,
} from "../src/app/(app)/integrations/hub/integration-cards";
import { IntegrationsHub } from "../src/app/(app)/integrations/hub/integrations-hub";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/integrations");
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

const snapshot: IntegrationHubSnapshot = {
  inbound: {
    enabled: true,
    providers: [
      { provider: "umbler", creationEnabled: true },
      { provider: "gupshup", creationEnabled: true },
    ],
    connections: [{ provider: "umbler", status: "observation" }],
  },
  whatsapp: { loaded: true, connections: [], legacyUazapiInstances: 0 },
  payt: { loaded: true, ruleCount: 0, activeRuleCount: 0 },
  crm: { kommo: { loadState: "real", statuses: ["active"] }, pipedrive: { loadState: "empty", statuses: [] } },
  meta: { connected: true, needsAttention: false, statusLabel: "Conectada" },
};

function renderHub(props: Partial<Parameters<typeof IntegrationsHub>[0]> = {}) {
  const cards = buildIntegrationCards(snapshot);

  return render(
    createElement(IntegrationsHub, {
      cards,
      panels: {
        umbler: createElement(
          "div",
          null,
          createElement(
            "label",
            null,
            "Nome da conexão",
            createElement("input"),
          ),
          createElement("button", { type: "button" }, "Gerar URL"),
        ),
        gupshup: createElement("p", null, "Painel Gupshup"),
        uazapi_byo: createElement("p", null, "Painel Uazapi"),
        kommo: createElement("p", null, "Painel Kommo montado"),
        meta: createElement("p", null, "Painel Meta"),
      },
      ...props,
    }),
  );
}

function panel(name: RegExp) {
  return screen.getByRole("tabpanel", { name });
}

describe("integrations hub", () => {
  it("renders the four tabs and separates active from available cards", () => {
    renderHub();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "WhatsApp",
      "Atendimento e vendas1 1 ativa",
      "Anúncios1 1 ativa",
      "CRM1 1 ativa",
    ]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");

    const whatsapp = panel(/WhatsApp/u);
    const [activeGroup, availableGroup] =
      within(whatsapp).getAllByRole("region");
    expect(
      within(activeGroup).getByText(/Nenhuma integração ativa aqui ainda/u),
    ).toBeTruthy();
    expect(within(availableGroup).getByText("Uazapi")).toBeTruthy();
    expect(
      within(availableGroup).getAllByText("Disponível").length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: /Atendimento e vendas/u }));
    const conversions = panel(/Atendimento e vendas/u);
    const [convActive, convAvailable] =
      within(conversions).getAllByRole("region");
    expect(within(convActive).getByText("Umbler Talk")).toBeTruthy();
    expect(within(convActive).getByText("Em teste")).toBeTruthy();
    expect(within(convActive).queryByText("Meta Ads")).toBeNull();
    expect(within(convAvailable).getByText("Gupshup")).toBeTruthy();
    expect(within(convAvailable).queryByText("Umbler Talk")).toBeNull();

    // Meta Ads (traffic + CAPI) has its own tab, apart from Cloud API.
    fireEvent.click(screen.getByRole("tab", { name: /Anúncios/u }));
    expect(
      within(panel(/Anúncios/u)).getByText("Meta Ads"),
    ).toBeTruthy();
  });

  it("shows 'Em breve' cards as a badge, not connectable, outside Ativos", () => {
    renderHub();

    const nod = document.querySelector('[data-integration="nod_api"]')!;
    expect(nod.getAttribute("data-coming-soon")).toBe("true");
    expect(within(nod as HTMLElement).getByText("Em breve")).toBeTruthy();
    const button = within(nod as HTMLElement).getByRole("button", {
      name: "NOD API: em breve",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(nod.textContent).not.toContain("Conectar");
    expect(nod.closest("[aria-labelledby$='-ativos']")).toBeNull();
  });

  it("switches tabs with click and arrow keys, keeping other tabs mounted", () => {
    renderHub();

    fireEvent.click(screen.getByRole("tab", { name: /CRM/u }));
    const crm = screen.getByRole("tabpanel", { name: /CRM/u });
    expect(crm.hidden).toBe(false);
    expect(within(crm).getByText("Kommo")).toBeTruthy();
    expect(window.location.hash).toBe("#integracao-crm");

    fireEvent.keyDown(screen.getByRole("tab", { name: /CRM/u }), {
      key: "ArrowRight",
    });
    expect(
      screen
        .getByRole("tab", { name: /^WhatsApp/u })
        .getAttribute("aria-selected"),
    ).toBe("true");
    // Hidden panels stay in the DOM (state inside them survives).
    expect(document.getElementById("integracao-crm")?.hidden).toBe(true);
  });

  it("opens the provider modal from its card and closes it with Escape", async () => {
    renderHub();

    fireEvent.click(screen.getByRole("tab", { name: /Atendimento e vendas/u }));
    const card = screen.getByRole("button", { name: "Conectar Gupshup" });
    fireEvent.click(card);

    const dialog = screen.getByRole("dialog", { name: "Gupshup" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByText("Painel Gupshup")).toBeTruthy();
    expect(window.location.hash).toBe("#integracao-gupshup");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Gupshup" })).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(window.location.hash).toBe("#integracao-atendimento");
  });

  it("closes from the close button and keeps the panel mounted while closed", () => {
    renderHub();

    // Closed modals keep their content mounted (hidden), so CRM locks and
    // one-time URLs survive closing.
    expect(
      screen.getByText("Painel Kommo montado", { selector: "p" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /CRM/u }));
    fireEvent.click(screen.getByRole("button", { name: "Gerenciar Kommo" }));
    const dialog = screen.getByRole("dialog", { name: "Kommo" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByText("Painel Kommo montado", { selector: "p" }),
    ).toBeTruthy();
  });

  it("opens the modal named in the URL hash (old #integracao-meta and #crm-configurado anchors)", async () => {
    window.history.replaceState(null, "", "/integrations#integracao-meta");
    const view = renderHub();

    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Meta Ads" })).toBeTruthy(),
    );
    expect(
      screen
        .getByRole("tab", { name: /Anúncios/u })
        .getAttribute("aria-selected"),
    ).toBe("true");
    view.unmount();

    window.history.replaceState(null, "", "/integrations#crm-configurado");
    renderHub();
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Kommo" })).toBeTruthy(),
    );
    expect(
      screen.getByRole("tab", { name: /CRM/u }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("closes the modal when a link inside it points to another tab", async () => {
    renderHub({
      panels: {
        kommo: createElement(
          "a",
          { href: "#integracao-whatsapp" },
          "Ir para WhatsApp",
        ),
      },
    });

    fireEvent.click(screen.getByRole("tab", { name: /CRM/u }));
    fireEvent.click(screen.getByRole("button", { name: "Gerenciar Kommo" }));
    expect(screen.getByRole("dialog", { name: "Kommo" })).toBeTruthy();

    // jsdom does not navigate anchors: move the hash like the browser would.
    act(() => {
      window.location.hash = "#integracao-whatsapp";
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      screen
        .getByRole("tab", { name: /^WhatsApp/u })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("shows the action notice inside the reopened modal, then above the tabs", () => {
    renderHub({
      initialTab: "ads",
      initialProvider: "meta",
      noticeProvider: "meta",
      notice: createElement("div", { role: "status" }, "Destino salvo"),
    });

    const dialog = screen.getByRole("dialog", { name: "Meta Ads" });
    expect(within(dialog).getByRole("status").textContent).toBe(
      "Destino salvo",
    );
    expect(screen.getAllByText("Destino salvo")).toHaveLength(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    const notice = screen.getByText("Destino salvo");
    expect(notice.closest(".app-modal-layer")).toBeNull();
  });

  it("keeps a notice without a modal visible on the page", () => {
    renderHub({
      notice: createElement("div", { role: "status" }, "Licença bloqueada"),
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Licença bloqueada");
  });

  it("shows quick links only on active cards", () => {
    renderHub({
      quickLinks: {
        umbler: [
          {
            label: "Regras de conversão",
            href: "/conversions",
          },
        ],
        gupshup: [
          {
            label: "Regras de conversão",
            href: "/conversions",
          },
        ],
      },
    });

    fireEvent.click(screen.getByRole("tab", { name: /Atendimento e vendas/u }));
    const links = screen.getAllByRole("link", { name: /Regras de conversão/u });
    expect(links).toHaveLength(1);
    expect(
      links[0].closest("[data-integration]")?.getAttribute("data-integration"),
    ).toBe("umbler");
  });

  it("replaces a logo that fails to load with the platform initials", () => {
    renderHub();

    const umbler = document.querySelector('[data-integration="umbler"]');
    const image = umbler?.querySelector("img") as HTMLImageElement;
    expect(image.getAttribute("src")).toBe("/integrations/umbler.svg");

    fireEvent.error(image);

    expect(umbler?.querySelector("img")).toBeNull();
    expect(
      umbler?.querySelector(".integration-logo-initials")?.textContent,
    ).toBe("Um");
  });
});

describe("Modal", () => {
  function Harness() {
    const [open, setOpen] = useState(false);

    return createElement(
      "div",
      null,
      createElement(
        "button",
        { type: "button", onClick: () => setOpen(true) },
        "Abrir",
      ),
      createElement(Modal, {
        open,
        onClose: () => setOpen(false),
        title: "Titulo do modal",
        description: "Descricao curta",
        children: createElement("button", { type: "button" }, "Acao interna"),
      }),
    );
  }

  it("labels the dialog, closes on backdrop click and unmounts by default", async () => {
    render(createElement(Harness));

    expect(screen.queryByText("Acao interna")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));

    const dialog = screen.getByRole("dialog", { name: "Titulo do modal" });
    expect(dialog.getAttribute("aria-describedby")).toBe(
      screen.getByText("Descricao curta").id,
    );
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );

    const backdrop = document.querySelector(".app-modal-backdrop");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop as Element);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Acao interna")).toBeNull();
  });

  it("keeps Tab inside the dialog", async () => {
    render(
      createElement(Modal, {
        open: true,
        onClose: () => undefined,
        title: "Foco preso",
        children: createElement("button", { type: "button" }, "Ultimo"),
      }),
    );

    const dialog = screen.getByRole("dialog", { name: "Foco preso" });
    const close = within(dialog).getByRole("button", { name: "Fechar" });
    const last = within(dialog).getByRole("button", { name: "Ultimo" });

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("lets a native dialog opened inside handle Escape itself", () => {
    const onClose = vi.fn();
    render(
      createElement(Modal, {
        open: true,
        onClose,
        title: "Com dialogo interno",
        children: createElement(
          "dialog",
          { open: true },
          createElement("button", { type: "button" }, "Confirmar"),
        ),
      }),
    );

    screen.getByRole("button", { name: "Confirmar" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
