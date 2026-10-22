// @vitest-environment jsdom
import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InboundWebhookPanel,
  type InboundWebhookPanelProps,
} from "../src/app/(app)/integrations/inbound-webhook-panel";
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
function props(): InboundWebhookPanelProps {
  const at = "2026-10-05T12:00:00Z";
  const action = vi.fn(async () => ({
    ok: true,
    message: "Estado atualizado",
  }));
  return {
    capabilities: {
      enabled: true,
      productionEnabled: true,
      providers: [
        {
          provider: "meta_cloud",
          parserVersion: "v1",
          parserReleaseStatus: "certified",
          creationEnabled: true,
        },
      ],
    },
    connections: [
      {
        overview: {
          connection: {
            id: "connection",
            workspaceId: "ws",
            provider: "meta_cloud",
            parserVersion: "v1",
            parserReleaseStatus: "certified",
            displayName: "Meta oficial",
            status: "observation",
            productionActivatedAt: null,
            lastDeliveryAt: null,
            lastSuccessfulParseAt: null,
            createdAt: at,
            updatedAt: at,
          },
          counters: {
            eligibleRouted: 12,
            eligibleUnresolved: 0,
            ignoredNoCtwa: 0,
            duplicate: 0,
            invalid: 0,
          },
        },
        channels: [
          {
            id: "channel",
            connectionId: "connection",
            organizationId: "waba",
            providerChannelId: "number",
            connectedPhone: "15550000001",
            channelName: "Numero",
            whatsappInstanceId: null,
            status: "active",
            productionActivatedAt: null,
            firstSeenAt: at,
            lastSeenAt: at,
            createdAt: at,
            updatedAt: at,
            routes: [],
            readiness: {
              state: "blocked",
              blockers: [],
              routeCount: 0,
              validRouteCount: 0,
              totalCtwa: 12,
              routedCtwa: 12,
              unresolvedCtwa: 0,
              retainedCtwa: 12,
              retainedRoutedCtwa: 12,
              payloadUnavailableCtwa: 0,
              alreadyMaterializedCtwa: 0,
              nextPayloadExpiresAt: null,
            },
          },
        ],
      },
    ],
    providerRules: [],
    providerRulesEnabled: false,
    metaConfiguration: null,
    canManage: true,
    canRecover: true,
    createAction: action,
    rotateSecretAction: action,
    setConnectionStatusAction: action,
    removeConnectionAction: action,
    createChannelAction: action,
    setChannelStatusAction: action,
    saveRoutesAction: action,
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  refresh.mockReset();
});
describe("Meta Cloud production UI actions", () => {
  it("requires a human confirmation before promoting the observed connection and refreshes on success", async () => {
    const p = props();
    render(createElement(InboundWebhookPanel, p));
    const button = screen.getByRole("button", {
      name: "Ativar envios automaticos",
      hidden: true,
    });
    vi.spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(p.setConnectionStatusAction).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(p.setConnectionStatusAction).toHaveBeenCalledTimes(1);
    const form = vi.mocked(p.setConnectionStatusAction).mock.calls[0][0];
    expect(Array.from(form.entries())).toEqual([
      ["connectionId", "connection"],
      ["status", "production"],
    ]);
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("novos eventos"),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/CTWA roteado nao significa enviado/)).toBeTruthy();
  });
  it("shows the actionable signing-secret rejection without changing connection state", async () => {
    const p = props();
    p.setConnectionStatusAction = vi.fn(async () => ({
      ok: false,
      message:
        "Configure META_APP_SECRET do seu proprio app Meta no ambiente da API antes de enviar.",
    }));
    render(createElement(InboundWebhookPanel, p));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Ativar envios automaticos",
          hidden: true,
        }),
      );
    });
    expect(screen.getByRole("alert").textContent).toContain("META_APP_SECRET");
    expect(refresh).not.toHaveBeenCalled();
  });
  it("only exposes recovery to the owner capability while retaining the observation/production distinction", () => {
    const p = props();
    const view = render(
      createElement(InboundWebhookPanel, { ...p, canRecover: false }),
    );
    expect(
      screen.queryByRole("button", {
        name: "Recuperar CTWAs anteriores",
        hidden: true,
      }),
    ).toBeNull();
    view.rerender(createElement(InboundWebhookPanel, p));
    expect(
      screen.getByRole("button", {
        name: "Recuperar CTWAs anteriores",
        hidden: true,
      }),
    ).toBeTruthy();
    view.rerender(
      createElement(InboundWebhookPanel, {
        ...p,
        canManage: false,
        canRecover: false,
      }),
    );
    expect(
      screen.queryByRole("button", {
        name: "Ativar envios automaticos",
        hidden: true,
      }),
    ).toBeNull();
  });
});
