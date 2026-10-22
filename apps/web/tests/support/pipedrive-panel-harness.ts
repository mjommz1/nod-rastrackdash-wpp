import { render } from "@testing-library/react";
import React from "react";
import { vi } from "vitest";
import {
  PipedriveConversionPanel,
  type PipedriveConversionPanelProps,
} from "../../src/app/(app)/settings/pipedrive-conversion-panel";
import type { PipedriveCapabilitiesResult } from "../../src/app/(app)/integrations/pipedrive-actions";
import { baseConnection, capabilitiesEnabled, eligibleChannel } from "./pipedrive-fixtures";

export function makeActions() {
  return {
    createConnectionAction: vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" })),
    replaceCredentialAction: vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" })),
    setStatusAction: vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" })),
    setChannelBindingsAction: vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" })),
    refreshCatalogAction: vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" })),
    deleteConnectionAction: vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" })),
    rotateWebhookAction: vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" })),
    revokeWebhookAction: vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" })),
    getConnectionAction: vi.fn(async (_w: string, _c: string) => ({
      ok: true as const,
      connection: baseConnection,
    })),
    getCapabilitiesAction: vi.fn(
      async (
        _w: string,
        _c: string,
      ): Promise<PipedriveCapabilitiesResult> => ({
        ok: true,
        capabilities: capabilitiesEnabled,
      }),
    ),
    listConnectionsAction: vi.fn(async (_w: string) => ({
      ok: true as const,
      connections: [baseConnection],
    })),
    createRuleAction: vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" })),
    updateRuleAction: vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" })),
    deleteRuleAction: vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" })),
    listEventsAction: vi.fn(async (_w: string, _c: string) => ({
      ok: true as const,
      events: [],
    })),
    retryEventAction: vi.fn(async (_: FormData) => ({ ok: true as const, message: "ok" })),
  };
}

export type PanelOverrides = Partial<PipedriveConversionPanelProps>;

export function buildPanelElement(overrides: PanelOverrides = {}) {
  const props: PipedriveConversionPanelProps = {
    workspaceId: "workspace_1",
    connections: [baseConnection],
    loadState: "real",
    allChannels: [eligibleChannel],
    canManage: true,
    ...makeActions(),
    ...overrides,
  } as PipedriveConversionPanelProps;
  return React.createElement(PipedriveConversionPanel, props);
}

export function renderPanel(overrides: PanelOverrides = {}) {
  const actions = makeActions();
  const merged = { ...actions, ...overrides };
  const view = render(buildPanelElement(merged));
  return {
    ...view,
    actions: merged as typeof actions & PanelOverrides,
    rerenderWith: (next: PanelOverrides) =>
      view.rerender(buildPanelElement({ ...merged, ...next })),
  };
}

export function sentForm(action: { mock: { calls: unknown[] } }, call = 0): FormData {
  return (action.mock.calls as unknown[][])[call]![0] as FormData;
}

export function formValues(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  formData.forEach((value, key) => {
    out[key] = String(value);
  });
  return out;
}
