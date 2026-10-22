// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaManualConnectionPanel } from "../src/app/(app)/integrations/meta-manual-connection-panel";

const pairingId = "p".repeat(43);
const authorizeUrl = `https://wpptrack-api.rastrack.app/integrations/meta/student-connect/start?pairingId=${pairingId}&challenge=${"c".repeat(43)}`;
const leakedToken = "EAAB-palmup-secret-token-should-never-leave-the-api";

const capabilities = {
  enabledModes: ["oauth", "manual"] as Array<"oauth" | "manual">,
  oauthEnabled: true,
  manualEnabled: true,
};

const credential = {
  id: "credential_palmup",
  workspaceId: "workspace_1",
  source: "manual" as const,
  label: "Login social PalmUP",
  fingerprint: "1234567890abcdef",
  tokenLast4: "oken",
  tokenType: "bearer",
  scopes: ["ads_read", "business_management"],
  expiresAt: null,
  status: "active" as const,
  lastValidatedAt: "2026-10-10T12:00:00.000Z",
  validationError: null,
  rotatedAt: null,
  createdAt: "2026-10-10T12:00:00.000Z",
  updatedAt: "2026-10-10T12:00:00.000Z",
};

const discovery = {
  credential,
  businesses: [
    { id: "business_1", name: "BM Cliente", verificationStatus: null },
  ],
  selectedBusinessId: "business_1",
  adAccounts: [],
  pixels: [],
  pages: [],
};

const emptyConfiguration = {
  workspaceId: "workspace_1",
  connectionMode: "manual" as const,
  advancedRoutingEnabled: false,
  unmappedActiveAccountCount: 0,
  credentials: [],
  businessConnections: [],
  destinations: [],
  reportingAccounts: [],
};

function renderPanel(
  overrides: Partial<Parameters<typeof MetaManualConnectionPanel>[0]> = {},
) {
  const props = {
    workspaceId: "workspace_1",
    capabilities,
    initialConfiguration: emptyConfiguration,
    legacyConnected: false,
    canManage: true,
    canConnectPalmup: true,
    disconnectOAuthAction: vi.fn(),
    prepareOAuthCredentialAction: vi.fn(),
    createCredentialAction: vi.fn(),
    discoverAssetsAction: vi.fn(),
    createConnectionAction: vi.fn(),
    rotateCredentialAction: vi.fn(),
    setConnectionStatusAction: vi.fn(),
    testConnectionAction: vi.fn(),
    removeConnectionAction: vi.fn(),
    syncHistoryAction: vi.fn(),
    setAccountDestinationAction: vi.fn(),
    loadAdRoutingAction: vi.fn(),
    setAdDestinationAction: vi.fn(),
    setOAuthRoutingAction: vi.fn(),
    startPalmupConnectAction: vi.fn(),
    completePalmupConnectAction: vi.fn(),
    ...overrides,
  };

  render(createElement(MetaManualConnectionPanel, props));
  return props;
}

function openSetup() {
  fireEvent.click(screen.getByRole("button", { name: /usar token permanente/i }));
}

afterEach(() => {
  cleanup();
});

describe("Conectar Meta (PalmUP)", () => {
  it("is offered to owners next to the manual token form", () => {
    renderPanel();
    openSetup();

    expect(
      screen.getByRole("button", { name: /conectar meta \(palmup\)/i }),
    ).toBeTruthy();
    expect(document.querySelector('input[name="accessToken"]')).toBeTruthy();
  });

  it("is hidden for members who are not the workspace owner", () => {
    renderPanel({ canConnectPalmup: false });
    openSetup();

    expect(screen.queryByText(/conectar meta \(palmup\)/i)).toBeNull();
    expect(document.querySelector('input[name="accessToken"]')).toBeTruthy();
  });

  it("sits next to Nova conexao on saved structures, for owners only", () => {
    const savedConfiguration = {
      ...emptyConfiguration,
      credentials: [credential],
      businessConnections: [
        {
          id: "connection_1",
          workspaceId: "workspace_1",
          credentialId: "credential_palmup",
          businessManagerId: "business_1",
          businessManagerName: "BM Cliente",
          status: "active" as const,
          defaultConversionDestinationId: null,
          reportingAccountCount: 0,
          activeReportingAccountCount: 0,
          lastValidatedAt: null,
          validationError: null,
          lastSyncedAt: null,
          createdAt: "2026-10-10T12:00:00.000Z",
          updatedAt: "2026-10-10T12:00:00.000Z",
        },
      ],
    };

    renderPanel({ initialConfiguration: savedConfiguration });
    const actions = document.querySelector(".meta-advanced-list-actions");
    expect(actions?.textContent).toContain("Nova conexao");
    expect(actions?.textContent).toContain("Conectar Meta (PalmUP)");
    expect(
      screen.getByRole("button", { name: /trocar token de bm cliente/i }),
    ).toBeTruthy();

    cleanup();
    renderPanel({
      initialConfiguration: savedConfiguration,
      canConnectPalmup: false,
    });
    expect(
      document.querySelector(".meta-advanced-list-actions")?.textContent,
    ).not.toContain("Conectar Meta (PalmUP)");
  });

  it("is hidden while the workspace still runs on legacy OAuth", () => {
    renderPanel({ legacyConnected: true });

    expect(screen.queryByText(/conectar meta \(palmup\)/i)).toBeNull();
  });

  it("starts, completes with the pairing id and continues into the BM step without exposing a token", async () => {
    const startPalmupConnectAction = vi.fn().mockResolvedValue({
      ok: true,
      message: "Autorize a Meta na aba da PalmUP.",
      palmupPairing: { pairingId, authorizeUrl },
    });
    const completePalmupConnectAction = vi.fn().mockResolvedValue({
      ok: true,
      message: "Meta conectada pela PalmUP e token protegido.",
      discovery: { ...discovery, accessToken: leakedToken },
    });
    renderPanel({ startPalmupConnectAction, completePalmupConnectAction });
    openSetup();

    fireEvent.click(
      screen.getByRole("button", { name: /conectar meta \(palmup\)/i }),
    );

    const loginLink = await screen.findByRole("link", {
      name: /abrir login da meta/i,
    });
    expect(loginLink.getAttribute("href")).toBe(authorizeUrl);
    expect(loginLink.getAttribute("target")).toBe("_blank");
    expect(loginLink.getAttribute("rel")).toContain("noopener");

    fireEvent.click(
      screen.getByRole("button", { name: /ja autorizei, concluir/i }),
    );

    await waitFor(() => {
      expect(completePalmupConnectAction).toHaveBeenCalledWith(pairingId);
    });
    await screen.findByText(/meta conectada pela palmup/i);

    // Same continuation as "Validar e proteger": the discovered BM is preselected.
    expect(
      (
        document.querySelector(
          'input[name="businessManagerId"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("business_1");
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Business Manager") as HTMLInputElement).value,
      ).toBe("BM Cliente");
    });
    expect(
      (screen.getByLabelText("Credencial Meta") as HTMLInputElement).value,
    ).toBe("Login social PalmUP");
    expect(screen.queryByRole("link", { name: /abrir login da meta/i })).toBeNull();
    expect(document.body.innerHTML).not.toContain(leakedToken);
  });

  it("switches to an honest disabled state when the API has no broker URL", async () => {
    const startPalmupConnectAction = vi.fn().mockResolvedValue({
      ok: false,
      message:
        "Login social PalmUP nao configurado neste servidor. Use o token permanente.",
      palmupUnconfigured: true,
    });
    renderPanel({ startPalmupConnectAction });
    openSetup();

    fireEvent.click(
      screen.getByRole("button", { name: /conectar meta \(palmup\)/i }),
    );

    await waitFor(() => {
      expect(
        (
          screen.getByRole("button", {
            name: /conectar meta \(palmup\)/i,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    });
    expect(screen.getByText(/PALMUP_META_BROKER_URL/)).toBeTruthy();
    expect(document.querySelector('input[name="accessToken"]')).toBeTruthy();
  });

  it("asks for a new start after a failed completion", async () => {
    const startPalmupConnectAction = vi.fn().mockResolvedValue({
      ok: true,
      message: "Autorize a Meta na aba da PalmUP.",
      palmupPairing: { pairingId, authorizeUrl },
    });
    const completePalmupConnectAction = vi.fn().mockResolvedValue({
      ok: false,
      message:
        "Conexao PalmUP expirada, invalida ou ja utilizada. Inicie novamente",
    });
    renderPanel({ startPalmupConnectAction, completePalmupConnectAction });
    openSetup();

    fireEvent.click(
      screen.getByRole("button", { name: /conectar meta \(palmup\)/i }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /ja autorizei, concluir/i }),
    );

    await screen.findByText(/inicie novamente/i);
    expect(
      screen.getByRole("button", { name: /conectar meta \(palmup\)/i }),
    ).toBeTruthy();
  });
});
