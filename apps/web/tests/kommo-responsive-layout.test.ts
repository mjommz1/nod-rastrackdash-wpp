// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import type { KommoConnectionDetailDto } from "../src/app/(app)/integrations/kommo-actions";
import {
  KommoConversionPanel,
  type KommoConversionPanelProps,
} from "../src/app/(app)/settings/kommo-conversion-panel";

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, "../src/styles/globals.css"), "utf8");

function blockFor(selectorText: string, from = 0): { body: string; index: number } {
  const index = css.indexOf(`${selectorText} {`, from);
  if (index < 0) throw new Error(`CSS block not found: ${selectorText}`);
  const open = css.indexOf("{", index);
  const close = css.indexOf("}", open);
  return { body: css.slice(open + 1, close), index };
}

const rule = {
  id: "rule_1",
  connectionId: "kommo_connection_1",
  name: "Negociacao avancada com um nome bem comprido para o card",
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

function connection(): KommoConnectionDetailDto {
  return {
    id: "kommo_connection_1",
    workspaceId: "workspace_layout",
    displayName: "Kommo principal",
    status: "active",
    verifiedAccountId: "account_1",
    accountSubdomain: "suaempresa",
    accountOrigin: "https://suaempresa.kommo.com",
    allowedChannelRouteIds: [],
    credentialHealthy: false,
    catalogState: "fresh",
    catalogRefreshedAt: "2026-07-17T18:00:00.000Z",
    lastErrorCode: null,
    createdAt: "2026-07-17T17:00:00.000Z",
    updatedAt: "2026-07-17T18:00:00.000Z",
    pipelines: [
      {
        id: "pipeline_1",
        name: "Vendas",
        sort: 1,
        status: { id: "status_1", name: "Negociacao", type: "ordinary" },
        available: true,
      },
    ],
    rules: [rule, { ...rule, id: "rule_2", name: "Compra", mode: "production", currency: "BRL" }],
  };
}

function renderPanel() {
  const props: KommoConversionPanelProps = {
    workspaceId: "workspace_layout",
    connections: [connection()],
    loadState: "real",
    allChannels: [],
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
  };
  return render(createElement(KommoConversionPanel, props));
}

describe("Kommo responsive chips (DOM contract)", () => {
  it("keeps every status chip inside the scoped panel and its wrapping title rows", () => {
    const { container } = renderPanel();
    const panel = container.querySelector(".kommo-conversion-panel");
    expect(panel).not.toBeNull();

    const chips = Array.from(panel!.querySelectorAll(".event-chip"));
    expect(chips.length).toBeGreaterThanOrEqual(6);

    const observation = screen.getByText("Observação (nada é enviado)");
    expect(observation.classList.contains("event-chip")).toBe(true);
    expect(observation.parentElement?.classList.contains("provider-conversion-rule-title")).toBe(true);

    const standby = screen.getByText("Produção em espera (conexão não está enviando)");
    expect(standby.parentElement?.classList.contains("provider-conversion-rule-title")).toBe(true);
    expect(screen.getByText("Credencial inválida").closest(".provider-conversion-rule-title")).not.toBeNull();
  });

  it("does not truncate the full status text and keeps the rule controls", () => {
    renderPanel();
    expect(screen.getByText("Observação (nada é enviado)").textContent).toBe(
      "Observação (nada é enviado)",
    );
    expect(screen.getAllByRole("button", { name: /^Pausar regra /i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /^Remover regra /i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Ativar envio automático: /i })).toBeTruthy();
  });
});

describe("Kommo responsive chips (CSS contract)", () => {
  const baseChip = blockFor(".status-chip,\n.tag,\n.event-chip");

  it("lets chips wrap their text within the card instead of staying nowrap", () => {
    expect(baseChip.body).toContain("white-space: nowrap");
    const scoped = blockFor(
      ".kommo-conversion-panel .event-chip,\n.kommo-audit-event .event-chip",
    );
    expect(scoped.index).toBeGreaterThan(baseChip.index);
    expect(scoped.body).toMatch(/white-space:\s*normal/);
    expect(scoped.body).toMatch(/max-width:\s*100%/);
    expect(scoped.body).toMatch(/min-width:\s*0/);
    expect(scoped.body).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("wraps the title row and heading rows of the Kommo panel only", () => {
    const rows = blockFor(
      ".kommo-conversion-panel .provider-conversion-rule-title,\n.kommo-conversion-panel .provider-conversion-heading,\n.kommo-conversion-panel .provider-conversion-heading-actions",
    );
    expect(rows.body).toMatch(/flex-wrap:\s*wrap/);
    expect(css).not.toMatch(/\n\.provider-conversion-rule-title\s*\{[^}]*flex-wrap/);
  });

  it("keeps the status dot from shrinking and wraps rule actions on narrow screens", () => {
    expect(
      blockFor(
        ".kommo-conversion-panel .event-chip::before,\n.kommo-audit-event .event-chip::before",
      ).body,
    ).toMatch(/flex:\s*none/);
    const narrow = css.slice(css.lastIndexOf("@media (max-width: 700px) {\n  .kommo-audit-event"));
    expect(narrow).toContain(".kommo-conversion-panel .provider-conversion-rule-actions");
    expect(narrow).toMatch(/flex-wrap:\s*wrap/);
  });
});
