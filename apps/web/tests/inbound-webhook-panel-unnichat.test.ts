// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  InboundWebhookCapabilitiesDto,
  InboundWebhookChannelDto,
  MetaManualConfigurationDto,
} from "@wpptrack/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InboundWebhookPanel,
  type InboundWebhookConnectionView,
} from "../src/app/(app)/integrations/inbound-webhook-panel";
import {
  ctwaDestinationReasonLabel,
  unnichatRoutingChoice,
} from "../src/app/(app)/integrations/inbound-webhook-labels";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const capabilities = {
  enabled: true,
  productionEnabled: true,
  providers: [
    {
      provider: "unnichat",
      parserVersion: "unnichat/v1",
      parserReleaseStatus: "certified",
      creationEnabled: true,
    },
    {
      provider: "umbler",
      parserVersion: "umbler/v1",
      parserReleaseStatus: "observation_only",
      creationEnabled: true,
    },
  ],
} satisfies InboundWebhookCapabilitiesDto;

function readiness(extra: Record<string, unknown> = {}) {
  return {
    state: "ready",
    blockers: [],
    routeCount: 0,
    validRouteCount: 0,
    totalCtwa: 0,
    routedCtwa: 0,
    unresolvedCtwa: 0,
    retainedCtwa: 0,
    retainedRoutedCtwa: 0,
    payloadUnavailableCtwa: 0,
    alreadyMaterializedCtwa: 0,
    nextPayloadExpiresAt: null,
    ...extra,
  };
}

const localRoute = {
  id: "route_1",
  channelId: "channel_1",
  metaBusinessConnectionId: "bm_a",
  metaReportingAccountId: null,
  metaConversionDestinationId: null,
  active: true,
  validationStatus: "valid",
  validationErrorCode: null,
  lastValidatedAt: null,
  createdAt: "2026-10-15T18:15:00.000Z",
  updatedAt: "2026-10-15T18:15:00.000Z",
};

function channel(
  readinessExtra: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): InboundWebhookChannelDto {
  return {
    id: "channel_1",
    connectionId: "connection_1",
    organizationId: "organization_1",
    providerChannelId: "provider_1",
    connectedPhone: "+5511999990001",
    channelName: "Comercial",
    whatsappInstanceId: null,
    status: "active",
    productionActivatedAt: null,
    firstSeenAt: "2026-10-15T18:15:00.000Z",
    lastSeenAt: "2026-10-15T19:30:00.000Z",
    routes: [],
    readiness: readiness(readinessExtra),
    createdAt: "2026-10-15T18:15:00.000Z",
    updatedAt: "2026-10-15T19:30:00.000Z",
    ...extra,
  } as unknown as InboundWebhookChannelDto;
}

function view(
  channels: InboundWebhookChannelDto[] = [channel()],
  connectionExtra: Record<string, unknown> = {},
  overviewExtra: Record<string, unknown> = {},
): InboundWebhookConnectionView {
  return {
    overview: {
      connection: {
        id: "connection_1",
        workspaceId: "workspace_1",
        provider: "unnichat",
        displayName: "Unnichat Loja",
        parserVersion: "unnichat/v1",
        parserReleaseStatus: "certified",
        status: "observation",
        productionActivatedAt: null,
        lastDeliveryAt: null,
        lastSuccessfulParseAt: null,
        createdAt: "2026-10-15T18:00:00.000Z",
        updatedAt: "2026-10-15T19:35:00.000Z",
        ...connectionExtra,
      },
      counters: {
        eligibleRouted: 0,
        eligibleUnresolved: 0,
        ignoredNoCtwa: 0,
        duplicate: 0,
        invalid: 0,
      },
      ...overviewExtra,
    },
    channels,
  } as unknown as InboundWebhookConnectionView;
}

const metaConfiguration = {
  workspaceId: "workspace_1",
  connectionMode: "manual",
  advancedRoutingEnabled: false,
  unmappedActiveAccountCount: 0,
  credentials: [],
  businessConnections: [
    {
      id: "bm_a",
      workspaceId: "workspace_1",
      credentialId: "credential_1",
      businessManagerId: "bm_a_meta",
      businessManagerName: "BM Alfa",
      status: "active",
      defaultConversionDestinationId: null,
      reportingAccountCount: 0,
      activeReportingAccountCount: 0,
      lastValidatedAt: null,
      validationError: null,
      lastSyncedAt: null,
      createdAt: "2026-10-15T18:00:00.000Z",
      updatedAt: "2026-10-15T18:00:00.000Z",
    },
  ],
  destinations: [],
  reportingAccounts: [],
} as unknown as MetaManualConfigurationDto;

type Overrides = {
  connections?: InboundWebhookConnectionView[];
  provider?: "unnichat" | "umbler";
  scoped?: boolean;
  canManage?: boolean;
  create?: (formData: FormData) => Promise<unknown>;
  rotate?: (formData: FormData) => Promise<unknown>;
  saveRoutes?: (formData: FormData) => Promise<unknown>;
  createChannel?: (formData: FormData) => Promise<unknown>;
};

function renderPanel({
  connections = [view()],
  scoped = true,
  provider = "unnichat",
  canManage = true,
  create,
  rotate,
  saveRoutes,
  createChannel,
}: Overrides = {}) {
  const action = vi.fn(async (_formData: FormData) => ({
    ok: true as const,
    message: "ok",
  }));

  return render(
    React.createElement(InboundWebhookPanel, {
      capabilities,
      connections,
      providerRules: [],
      providerRulesEnabled: true,
      metaConfiguration,
      canManage,
      createAction: (create ?? action) as never,
      rotateSecretAction: (rotate ?? action) as never,
      setConnectionStatusAction: action,
      removeConnectionAction: action,
      createChannelAction: (createChannel ?? action) as never,
      setChannelStatusAction: action,
      saveRoutesAction: (saveRoutes ?? action) as never,
      ...(scoped ? { provider } : {}),
    }),
  );
}

function openChannel() {
  fireEvent.click(screen.getByText("Unnichat Loja"));
  fireEvent.click(screen.getByText("Comercial"));
}

describe("Unnichat connection creation", () => {
  it("disables Gerar webhook while the license is locked", () => {
    renderPanel({ connections: [] });
    expect(
      screen.getByRole("button", { name: "Gerar webhook" }).hasAttribute("disabled"),
    ).toBe(false);
    cleanup();
    render(
      React.createElement(InboundWebhookPanel, {
        capabilities,
        connections: [],
        providerRules: [],
        providerRulesEnabled: true,
        metaConfiguration,
        canManage: true,
        licenseLocked: true,
        createAction: vi.fn() as never,
        rotateSecretAction: vi.fn() as never,
        setConnectionStatusAction: vi.fn() as never,
        scopedProvider: "unnichat",
      } as never),
    );
    expect(
      screen.getByRole("button", { name: "Gerar webhook" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("asks for the client's number next to the name and explains it", () => {
    renderPanel({ connections: [] });

    const phone = screen.getByLabelText(/Número de WhatsApp do cliente/);
    expect(phone.getAttribute("name")).toBe("connectedPhone");
    expect(phone.hasAttribute("required")).toBe(true);
    expect(phone.getAttribute("type")).toBe("tel");
    expect(
      screen.getByText(/Nunca o telefone do lead/, { exact: false }),
    ).toBeTruthy();
    expect(screen.getByLabelText(/Nome da conexão/)).toBeTruthy();
    expect(
      screen.getByText(/A conexão já nasce presa a esse número/),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Conectar Unnichat" })).toBeTruthy();
  });

  it("does not ask for a number when the provider is not Unnichat", () => {
    renderPanel({ connections: [], provider: "umbler" });

    expect(screen.queryByLabelText(/Número de WhatsApp do cliente/)).toBeNull();
  });

  it("shows the number field in the generic form only while Unnichat is picked", () => {
    renderPanel({ connections: [], scoped: false });

    fireEvent.change(screen.getByLabelText("Plataforma"), {
      target: { value: "umbler" },
    });
    expect(screen.queryByLabelText(/Número de WhatsApp do cliente/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Plataforma"), {
      target: { value: "unnichat" },
    });
    expect(screen.getByLabelText(/Número de WhatsApp do cliente/)).toBeTruthy();
  });

  it("submits the number, then shows the URL once with the Unnichat step by step", async () => {
    const create = vi.fn().mockResolvedValue({
      ok: true,
      message: "criada",
      oneTimeSecret: {
        connectionId: "connection_1",
        provider: "unnichat",
        webhookUrl: "https://api.example.test/webhooks/inbound/c1?token=secret_u",
      },
    });
    renderPanel({ connections: [], create });

    fireEvent.change(screen.getByLabelText(/Nome da conexão/), {
      target: { value: "Unnichat Loja" },
    });
    fireEvent.change(screen.getByLabelText(/Número de WhatsApp do cliente/), {
      target: { value: "+55 11 99999-0001" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Gerar webhook/ }));
    });

    const sent = create.mock.calls[0]![0] as FormData;
    expect(sent.get("provider")).toBe("unnichat");
    expect(sent.get("connectedPhone")).toBe("+55 11 99999-0001");
    expect(screen.getByDisplayValue(/token=secret_u/)).toBeTruthy();
    expect(screen.getByText("URL exibida uma única vez")).toBeTruthy();
    expect(screen.getByText(/Cadastre este webhook no Unnichat agora/)).toBeTruthy();
    expect(screen.getByText("Webhook de entrada da conversa")).toBeTruthy();
    expect(screen.getByText(/adicione\s+uma chamada HTTP/)).toBeTruthy();
    // The body the Unnichat flow must send, with its placeholders.
    const body = document.querySelector(".unnichat-setup .payload-block");
    expect(body?.textContent).toContain('"source": "unnichat"');
    expect(body?.textContent).toContain('"ctwa_clid": "{{ctwa_clid}}"');
    expect(body?.textContent).toContain('"phone": "{{phoneNumber}}"');
    expect(screen.getByText(/Sem o/).textContent).toContain("nada é enviado à Meta");
  });

  it("does not show the Unnichat step by step for other providers", async () => {
    const rotate = vi.fn().mockResolvedValue({
      ok: true,
      message: "ok",
      oneTimeSecret: {
        provider: "umbler",
        webhookUrl: "https://api.example.test/webhooks/inbound/c1?token=secret_u",
      },
    });
    renderPanel({
      connections: [
        view([channel()], { provider: "umbler", displayName: "Umbler Loja" }),
      ],
      provider: "umbler",
      rotate,
    });
    vi.stubGlobal("confirm", () => true);

    fireEvent.click(screen.getByText("Umbler Loja"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Gerar nova URL/ }));
    });

    expect(screen.getByDisplayValue(/token=secret_u/)).toBeTruthy();
    expect(screen.queryByText("Webhook de entrada da conversa")).toBeNull();
  });

  it("shows the step by step again after generating a new URL", async () => {
    const rotate = vi.fn().mockResolvedValue({
      ok: true,
      message: "ok",
      oneTimeSecret: {
        provider: "unnichat",
        webhookUrl: "https://api.example.test/webhooks/inbound/c1?token=secret_n",
      },
    });
    vi.stubGlobal("confirm", () => true);
    renderPanel({ rotate });

    fireEvent.click(screen.getByText("Unnichat Loja"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Gerar nova URL/ }));
    });

    expect(screen.getByText("Webhook de entrada da conversa")).toBeTruthy();
  });
});

describe("Unnichat number management", () => {
  it("does not offer to register a number by hand: it comes with the connection", () => {
    renderPanel();
    fireEvent.click(screen.getByText("Unnichat Loja"));

    expect(screen.queryByText(/Cadastrar canal/)).toBeNull();
    expect(screen.getByText("Comercial")).toBeTruthy();
  });

  it("tells how to fix a connection that has no number", () => {
    renderPanel({ connections: [view([])] });
    fireEvent.click(screen.getByText("Unnichat Loja"));

    expect(
      screen.getByText(/ainda não tem o número do cliente/),
    ).toBeTruthy();
  });

  it("links the connection to its rules in Conversões", () => {
    renderPanel();
    fireEvent.click(screen.getByText("Unnichat Loja"));

    expect(screen.getByText("0 regra(s) nesta conexao")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Abrir Conversões/ }).getAttribute("href"),
    ).toBe("/conversions");
  });

  it("does not expose internal parser status to the student", () => {
    renderPanel({
      connections: [
        view([channel()], {}, {
          automationParserRelease: {
            id: "release_1",
            version: "automation-v1",
            status: "certified",
          },
        }),
      ],
    });
    fireEvent.click(screen.getByText("Unnichat Loja"));

    expect(screen.queryByTestId("unnichat-automation-parser")).toBeNull();
    expect(screen.queryByText(/automation-v1/)).toBeNull();
    expect(screen.queryByText(/leitura automation/i)).toBeNull();
  });
});

describe("Unnichat routing mode per number", () => {
  it("opens on 'Herdar do workspace' for an inheriting number and offers no route editor", () => {
    renderPanel({
      connections: [
        view([channel({ routingSource: "inherit_workspace", effectiveRouteEligible: true })]),
      ],
    });
    openChannel();

    const inherit = screen.getByLabelText("Herdar do workspace") as HTMLInputElement;
    const override = screen.getByLabelText("Configurar neste número") as HTMLInputElement;
    expect(inherit.checked).toBe(true);
    expect(override.checked).toBe(false);
    expect(screen.queryByRole("button", { name: /Salvar rotas/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Herdar do workspace/ }),
    ).toBeNull();
    expect(
      screen.getByText(/Se houver mais de um par possível, nada é\s+enviado/),
    ).toBeTruthy();
  });

  it("opens on 'Configurar neste número' for an override and shows its routes", () => {
    renderPanel({
      connections: [
        view([
          channel(
            { routingSource: "channel_override", routeCount: 1, validRouteCount: 1 },
            { routes: [localRoute] },
          ),
        ]),
      ],
    });
    openChannel();

    expect(
      (screen.getByLabelText("Configurar neste número") as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByRole("button", { name: /Salvar rotas/ })).toBeTruthy();
    expect(screen.getByText(/Só valem as rotas salvas neste número/)).toBeTruthy();
  });

  it("asks for a choice when the number is legacy and has no mode yet", () => {
    renderPanel({
      connections: [view([channel({ routingSource: "legacy_unknown" })])],
    });
    openChannel();

    expect(
      screen.getByText(/ainda não tem um modo de roteamento\. Escolha uma das\s+opções e salve/),
    ).toBeTruthy();
    expect(screen.getAllByText(/Modo não escolhido/).length).toBeGreaterThan(0);
  });

  it("confirms, then saves inherit with no routes and says what is removed", async () => {
    const saveRoutes = vi.fn().mockResolvedValue({ ok: true, message: "salvo" });
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    renderPanel({
      saveRoutes,
      connections: [
        view([
          channel(
            { routingSource: "channel_override", routeCount: 1, validRouteCount: 1 },
            { routes: [localRoute] },
          ),
        ]),
      ],
    });
    openChannel();

    fireEvent.click(screen.getByLabelText("Herdar do workspace"));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /Herdar do workspace/ }),
      );
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("A rota própria deste número será removida"),
    );
    const sent = saveRoutes.mock.calls[0]![0] as FormData;
    expect(sent.get("channelId")).toBe("channel_1");
    expect(sent.get("routingMode")).toBe("inherit_workspace");
    expect(sent.get("routes")).toBe("[]");
  });

  it("does not save when the student cancels the confirmation", async () => {
    const saveRoutes = vi.fn().mockResolvedValue({ ok: true, message: "salvo" });
    vi.stubGlobal("confirm", () => false);
    renderPanel({
      saveRoutes,
      connections: [
        view([channel({ routingSource: "legacy_unknown" })]),
      ],
    });
    openChannel();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /Herdar do workspace/ }),
      );
    });

    expect(saveRoutes).not.toHaveBeenCalled();
  });

  it("saves the manual routes together with the override mode", async () => {
    const saveRoutes = vi.fn().mockResolvedValue({ ok: true, message: "salvo" });
    renderPanel({
      saveRoutes,
      connections: [
        view([
          channel(
            { routingSource: "channel_override", routeCount: 1, validRouteCount: 1 },
            { routes: [localRoute] },
          ),
        ]),
      ],
    });
    openChannel();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Salvar rotas/ }));
    });

    const sent = saveRoutes.mock.calls[0]![0] as FormData;
    expect(sent.get("routingMode")).toBe("channel_override");
    expect(JSON.parse(String(sent.get("routes")))).toEqual([
      {
        metaBusinessConnectionId: "bm_a",
        metaReportingAccountId: null,
        metaConversionDestinationId: null,
      },
    ]);
  });

  it("does not allow saving manual mode without a route", () => {
    renderPanel({
      connections: [
        view([channel({ routingSource: "channel_override" }, { routes: [] })]),
      ],
    });
    openChannel();

    expect(
      screen.getByText(/As rotas manuais precisam de ao menos uma rota/),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Salvar rotas/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows the API refusal when saving fails", async () => {
    const saveRoutes = vi.fn().mockResolvedValue({
      ok: false,
      message:
        "Escolha o modo de roteamento deste número (Herdar do workspace ou Configurar neste número) e salve.",
    });
    vi.stubGlobal("confirm", () => true);
    renderPanel({
      saveRoutes,
      connections: [view([channel({ routingSource: "legacy_unknown" })])],
    });
    openChannel();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /Herdar do workspace/ }),
      );
    });

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Escolha o modo de roteamento deste número",
      ),
    );
  });

  it("is read-only for someone who cannot manage integrations", () => {
    renderPanel({
      canManage: false,
      connections: [
        view([channel({ routingSource: "legacy_unknown" })]),
      ],
    });
    fireEvent.click(screen.getByText("Unnichat Loja"));
    fireEvent.click(screen.getByText("Comercial"));

    expect(
      (screen.getByLabelText("Herdar do workspace") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: /Herdar do workspace/ }),
    ).toBeNull();
    expect(screen.queryByText(/Escolha uma das/)).toBeNull();
  });

  it("keeps the plain route editor (no mode) for the other providers", () => {
    renderPanel({
      provider: "umbler",
      connections: [
        view([channel({}, { routes: [localRoute] })], {
          provider: "umbler",
          displayName: "Umbler Loja",
        }),
      ],
    });
    fireEvent.click(screen.getByText("Umbler Loja"));
    fireEvent.click(screen.getByText("Comercial"));

    expect(screen.queryByLabelText("Herdar do workspace")).toBeNull();
    expect(screen.getByRole("button", { name: /Salvar rotas/ })).toBeTruthy();
  });
});

describe("Unnichat readiness in plain Portuguese", () => {
  function readinessText() {
    return screen.getByLabelText("Prontidao operacional do canal").textContent ?? "";
  }

  it.each([
    [
      "ctwa_destination_ambiguous",
      /mais de uma página e pixel possíveis.*“Configurar neste número”/,
    ],
    [
      "ctwa_verified_binding_missing",
      /Falta um par de página e pixel verificado.*aba Anúncios \(Meta Ads\)/,
    ],
    [
      "ctwa_workspace_routing_disabled",
      /configuração Meta do workspace está desligada/,
    ],
    [
      "ctwa_channel_routing_mode_unset",
      /ainda não tem um modo de roteamento.*“Herdar do workspace” ou “Configurar neste número”/,
    ],
    [
      "ctwa_override_no_valid_routes",
      /não têm nenhuma rota válida.*volte para “Herdar do workspace”/,
    ],
    [
      "ctwa_channel_scope_invalid",
      /fora do alcance permitido.*Recadastre o número/,
    ],
  ])("explains %s and what to do", (reason, expected) => {
    renderPanel({
      connections: [
        view([
          channel({
            state: "blocked",
            routingSource: "inherit_workspace",
            effectiveRouteEligible: false,
            ctwaDestinationReadiness: { status: "not_ready", reason },
          }),
        ]),
      ],
    });
    openChannel();

    expect(readinessText()).toMatch(expected);
    expect(readinessText()).not.toMatch(/WABA|vinculação|BMs compartilhadas/i);
  });

  it("marks a verified destination", () => {
    renderPanel({
      connections: [
        view([
          channel({
            routingSource: "inherit_workspace",
            effectiveRouteEligible: true,
            ctwaDestinationReadiness: { status: "verified", reason: "ctwa_verified" },
          }),
        ]),
      ],
    });
    openChannel();

    expect(readinessText()).toContain("Destino Meta verificado");
    expect(readinessText()).toContain("Herda do workspace");
  });

  it("falls back for an unknown reason without leaking the code", () => {
    expect(ctwaDestinationReasonLabel("something_new")).toMatch(/Motivo não reconhecido/);
    expect(ctwaDestinationReasonLabel("something_new")).not.toContain("something_new");
  });

  it("uses the DTO count for conversations without an ad id", () => {
    renderPanel({
      connections: [
        view([
          channel({
            state: "blocked",
            blockers: ["ctwa_ad_unavailable"],
            adUnavailableCtwa: 4,
            routingSource: "inherit_workspace",
          }),
        ]),
      ],
    });
    openChannel();

    expect(readinessText()).toContain("4 conversas chegaram sem o anúncio de origem identificado");
    expect(readinessText()).toContain("uma BM a mais não recupera o anúncio");
  });

  it("uses the singular for one conversation", () => {
    renderPanel({
      connections: [
        view([
          channel({
            blockers: ["ctwa_ad_unavailable"],
            adUnavailableCtwa: 1,
            routingSource: "inherit_workspace",
          }),
        ]),
      ],
    });
    openChannel();

    expect(readinessText()).toContain("1 conversa chegou sem o anúncio de origem identificado");
    expect(readinessText()).toContain("ainda não tem destino");
  });

  it("does not ask an inheriting, eligible number for a manual route", () => {
    renderPanel({
      connections: [
        view([
          channel({
            blockers: ["route_not_configured"],
            routingSource: "inherit_workspace",
            effectiveRouteEligible: true,
            ctwaDestinationReadiness: { status: "verified", reason: "ctwa_verified" },
          }),
        ]),
      ],
    });
    openChannel();

    expect(readinessText()).not.toMatch(/Configure ao menos uma rota/);
    expect(readinessText()).toMatch(/não precisa de rota própria/);
  });

  it("points an inheriting, not-ready number to the Meta tab or to manual routes", () => {
    renderPanel({
      connections: [
        view([
          channel({
            blockers: ["route_not_configured"],
            routingSource: "inherit_workspace",
            effectiveRouteEligible: false,
          }),
        ]),
      ],
    });
    openChannel();

    expect(readinessText()).toMatch(/aba Anúncios \(Meta Ads\)/);
    expect(readinessText()).toMatch(/Configurar neste número/);
  });

  it("asks for at least one valid route in override mode and a choice in legacy mode", () => {
    renderPanel({
      connections: [
        view([
          channel({
            blockers: ["route_not_configured"],
            routingSource: "channel_override",
          }),
        ]),
      ],
    });
    openChannel();
    expect(readinessText()).toMatch(/no lugar da configuração do workspace/);
    expect(readinessText()).toMatch(/ao menos uma rota Meta válida/);

    cleanup();
    renderPanel({
      connections: [
        view([
          channel({
            blockers: ["route_not_configured"],
            routingSource: "legacy_unknown",
          }),
        ]),
      ],
    });
    openChannel();
    expect(readinessText()).toMatch(/Escolha o modo de roteamento deste número e salve/);
  });

  it("keeps the original instruction for providers without a routing source", () => {
    renderPanel({
      provider: "umbler",
      connections: [
        view(
          [channel({ blockers: ["route_not_configured"], state: "blocked" })],
          { provider: "umbler", displayName: "Umbler Loja" },
        ),
      ],
    });
    fireEvent.click(screen.getByText("Umbler Loja"));
    fireEvent.click(screen.getByText("Comercial"));

    expect(readinessText()).toContain("Configure ao menos uma rota Meta para este canal.");
  });
});

describe("routing choice helper", () => {
  it("follows the stored source and falls back to the routes present", () => {
    expect(
      unnichatRoutingChoice(channel({ routingSource: "inherit_workspace" })),
    ).toBe("inherit_workspace");
    expect(
      unnichatRoutingChoice(channel({ routingSource: "channel_override" })),
    ).toBe("channel_override");
    expect(unnichatRoutingChoice(channel({ routingSource: "legacy_unknown" }))).toBe(
      "inherit_workspace",
    );
    expect(
      unnichatRoutingChoice(
        channel({ routingSource: "legacy_unknown" }, { routes: [localRoute] }),
      ),
    ).toBe("channel_override");
  });
});

describe("responsive layout", () => {
  const css = readFileSync(
    resolve(__dirname, "../src/styles/globals.css"),
    "utf8",
  );

  it("stacks the create form (name, number, button) in one column on phones", () => {
    expect(css).toMatch(
      /@media \(max-width: 700px\) \{\s*\.inbound-webhook-create\.has-phone \{\s*grid-template-columns: minmax\(0, 1fr\);/,
    );
  });

  it("lets the JSON body scroll instead of overflowing", () => {
    expect(css).toMatch(/\.unnichat-setup \.payload-block \{[^}]*overflow-x: auto/);
  });
});
