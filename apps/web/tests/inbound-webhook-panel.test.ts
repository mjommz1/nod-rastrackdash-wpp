import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  InboundWebhookCapabilitiesDto,
  MetaManualConfigurationDto,
} from "@wpptrack/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { InboundWebhookOneTimeSecret } from "../src/app/(app)/integrations/inbound-webhook-actions";
import {
  InboundWebhookOneTimeSecretPanel,
  InboundWebhookPanel,
  inboundPasteInstruction,
  inboundWebhookProviderLabel,
  type InboundWebhookConnectionView,
} from "../src/app/(app)/integrations/inbound-webhook-panel";
import { inboundWebhookReportingAccountOptions } from "../src/app/(app)/integrations/inbound-webhook-route-editor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => undefined,
  }),
}));

const capabilities = {
  enabled: true,
  productionEnabled: true,
  providers: [
    {
      provider: "umbler",
      parserVersion: "umbler/v1",
      parserReleaseStatus: "observation_only",
      creationEnabled: true,
    },
    {
      provider: "gupshup",
      parserVersion: "v1",
      parserReleaseStatus: "observation_only",
      creationEnabled: true,
    },
    {
      provider: "meta_cloud",
      parserVersion: "v1",
      parserReleaseStatus: "observation_only",
      creationEnabled: true,
    },
  ],
} satisfies InboundWebhookCapabilitiesDto;

const connectionView = {
  overview: {
    connection: {
      id: "connection_1",
      workspaceId: "workspace_current",
      provider: "umbler",
      displayName: "Umbler Comercial",
      parserVersion: "umbler/v1",
      parserReleaseStatus: "observation_only",
      status: "observation",
      productionActivatedAt: null,
      lastDeliveryAt: "2026-07-17T19:35:00.000Z",
      lastSuccessfulParseAt: "2026-07-17T19:34:00.000Z",
      createdAt: "2026-07-17T18:00:00.000Z",
      updatedAt: "2026-07-17T19:35:00.000Z",
    },
    counters: {
      eligibleRouted: 12,
      eligibleUnresolved: 5,
      ignoredNoCtwa: 8,
      duplicate: 3,
      invalid: 2,
    },
  },
  channels: [
    {
      id: "channel_1",
      connectionId: "connection_1",
      organizationId: "organization_1",
      providerChannelId: "umbler_channel_1",
      connectedPhone: "+5511999990001",
      channelName: "Comercial Sao Paulo",
      whatsappInstanceId: null,
      status: "active",
      productionActivatedAt: null,
      firstSeenAt: "2026-07-17T18:15:00.000Z",
      lastSeenAt: "2026-07-17T19:30:00.000Z",
      routes: [
        inboundRoute({
          id: "route_sales",
          metaBusinessConnectionId: "business_connection_sales",
          metaReportingAccountId: "reporting_sales",
          metaConversionDestinationId: "destination_sales",
        }),
        inboundRoute({
          id: "route_support",
          metaBusinessConnectionId: "business_connection_support",
          metaReportingAccountId: "reporting_support",
          metaConversionDestinationId: "destination_support",
        }),
      ],
      readiness: {
        state: "partial",
        blockers: ["ctwa_unresolved", "payload_expiring_soon"],
        routeCount: 2,
        validRouteCount: 2,
        totalCtwa: 17,
        routedCtwa: 12,
        unresolvedCtwa: 5,
        retainedCtwa: 17,
        retainedRoutedCtwa: 12,
        payloadUnavailableCtwa: 0,
        alreadyMaterializedCtwa: 0,
        nextPayloadExpiresAt: "2026-07-19T18:00:00.000Z",
      },
      createdAt: "2026-07-17T18:15:00.000Z",
      updatedAt: "2026-07-17T19:30:00.000Z",
    },
  ],
} satisfies InboundWebhookConnectionView;

const metaConfiguration = {
  workspaceId: "workspace_current",
  connectionMode: "manual",
  advancedRoutingEnabled: false,
  unmappedActiveAccountCount: 0,
  credentials: [],
  businessConnections: [
    metaBusinessConnection({
      id: "business_connection_sales",
      businessManagerId: "bm_sales",
      businessManagerName: "BM Vendas Atual",
      defaultConversionDestinationId: "destination_sales",
    }),
    metaBusinessConnection({
      id: "business_connection_support",
      businessManagerId: "bm_support",
      businessManagerName: "BM Suporte Atual",
      defaultConversionDestinationId: "destination_support",
    }),
  ],
  destinations: [
    metaDestination({
      id: "destination_sales",
      label: "Pixel e Pagina Vendas",
      ownerBusinessManagerId: "bm_sales",
      pixelId: "pixel_sales",
      pixelName: "Pixel Vendas",
      pageId: "page_sales",
      pageName: "Pagina Vendas",
    }),
    metaDestination({
      id: "destination_support",
      label: "Pixel e Pagina Suporte",
      ownerBusinessManagerId: "bm_support",
      pixelId: "pixel_support",
      pixelName: "Pixel Suporte",
      pageId: "page_support",
      pageName: "Pagina Suporte",
    }),
  ],
  reportingAccounts: [
    metaReportingAccount({
      id: "reporting_sales",
      businessId: "bm_sales",
      businessName: "BM Vendas Atual",
      adAccountId: "act_sales",
      adAccountName: "Conta Vendas Atual",
      businessConnectionId: "business_connection_sales",
      conversionDestinationId: "destination_sales",
    }),
    metaReportingAccount({
      id: "reporting_support",
      businessId: "bm_support",
      businessName: "BM Suporte Atual",
      adAccountId: "act_support",
      adAccountName: "Conta Suporte Atual",
      businessConnectionId: "business_connection_support",
      conversionDestinationId: "destination_support",
    }),
  ],
} satisfies MetaManualConfigurationDto;

describe("inbound webhook panel", () => {
  it("keeps the submitted form reference across the async create action", () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "../src/app/(app)/integrations/inbound-webhook-panel.tsx",
      ),
      "utf8",
    );
    const handler = source.slice(
      source.indexOf("async function handleCreate"),
      source.indexOf("async function runConnectionAction"),
    );

    expect(handler).toMatch(/const form = event\.currentTarget;/);
    expect(handler).toMatch(/await createAction\(new FormData\(form\)\)/);
    expect(handler).toMatch(/form\.reset\(\)/);
    expect(handler).not.toMatch(
      /await createAction\(new FormData\(event\.currentTarget\)\)/,
    );
  });

  it("shows Umbler, Gupshup and Meta Cloud in an extensible provider selector", () => {
    const html = renderPanel({ connections: [] });

    expect(inboundWebhookProviderLabel("umbler")).toBe("Umbler Talk");
    expect(inboundWebhookProviderLabel("gupshup")).toBe("Gupshup");
    expect(inboundWebhookProviderLabel("meta_cloud")).toBe(
      "Meta WhatsApp (Cloud API)",
    );
    expect(inboundWebhookProviderLabel("future-provider")).toBe(
      "future-provider",
    );
    expect(html).toContain('<select name="provider"');
    expect(html).toContain('<option value="umbler" selected="">Umbler Talk');
    expect(html).toContain('<option value="gupshup">Gupshup</option>');
    expect(html).toContain(
      '<option value="meta_cloud">Meta WhatsApp (Cloud API)</option>',
    );
    expect(html).toContain("Webhooks de entrada");
    expect(html).toContain(
      "Configure Umbler Talk, Gupshup, Data Crazy ou Meta WhatsApp (Cloud API).",
    );
    expect(html).not.toContain(
      "parser de mensagens sera disponibilizado posteriormente",
    );
  });

  it("labels Data Crazy and explains where to paste the callback", () => {
    expect(inboundWebhookProviderLabel("data_crazy")).toBe("Data Crazy");
    expect(inboundPasteInstruction("data_crazy")).toBe(
      "No Data Crazy, crie uma automacao de mensagem recebida com requisicao HTTP POST (JSON) e cole esta URL.",
    );

    const html = renderPanel({
      connections: [],
      capabilities: {
        ...capabilities,
        providers: [
          ...capabilities.providers,
          {
            provider: "data_crazy",
            parserVersion: "v1",
            parserReleaseStatus: "observation_only",
            creationEnabled: true,
          },
        ],
      },
    });

    expect(html).toContain('<option value="data_crazy">Data Crazy</option>');
  });

  it("shows the Data Crazy one-time URL with its automation instruction", () => {
    const html = renderOneTimeSecret({
      provider: "data_crazy",
      webhookUrl: "https://app.example.com/inbound/data_crazy/abc123",
    });

    expect(html).toContain("Cadastre este webhook no Data Crazy agora");
    expect(html).toContain("Copiar URL");
    expect(html).not.toContain("Verify token");
    expect(html).toContain(inboundPasteInstruction("data_crazy"));
  });

  it("does not offer manual channel registration for Data Crazy and explains the automatic channel", () => {
    const html = renderPanel({
      connections: [connectionViewWithoutChannels({ provider: "data_crazy" })],
    });

    expect(html).toContain("Data Crazy - Observando");
    expect(html).not.toContain("Cadastrar canal/numero");
    expect(html).not.toContain("Nenhum canal cadastrado ainda");
    expect(html).toContain(
      "O canal aparece sozinho quando o primeiro webhook do Data Crazy chegar.",
    );
  });

  it("lets a manager register a channel before any webhook arrives (P0.2)", () => {
    const html = renderPanel({
      connections: [connectionViewWithoutChannels()],
    });

    expect(html).toContain("Cadastrar canal/numero");
    expect(html).toContain("Nenhum canal cadastrado ainda");
    expect(html).not.toMatch(/primeiro payload/i);
  });

  it("hides manual channel registration for auto-bridged UAZAPI instances", () => {
    const html = renderPanel({
      connections: [connectionViewWithoutChannels({ provider: "uazapi" })],
    });

    expect(html).not.toContain("Cadastrar canal/numero");
  });

  it("hides manual channel registration from analysts without manage permission", () => {
    const html = renderPanel({
      connections: [connectionViewWithoutChannels()],
      canManage: false,
    });

    expect(html).not.toContain("Cadastrar canal/numero");
  });

  it("gives provider-specific paste instructions for the one-time webhook URL", () => {
    expect(inboundPasteInstruction("umbler")).toBe(
      "Cole esta URL no painel/webhook da Umbler Talk.",
    );
    expect(inboundPasteInstruction("gupshup")).toBe(
      "Cole esta URL no painel/webhook da Gupshup.",
    );
    expect(inboundPasteInstruction("meta_cloud")).toBe(
      "Cole URL e token em App Meta → Configurar webhooks → Verificar e salvar.",
    );
  });

  it("shows the Meta callback URL and the verify token as readable labelled rows (F1.1)", () => {
    const html = renderOneTimeSecret({
      provider: "meta_cloud",
      webhookUrl: "https://app.example.com/inbound/meta/abc123",
      verifyToken: "verify_token_meta_123",
    });

    expect(html).toContain("URL de callback");
    expect(html).toContain("Verify token");
    expect(html).toContain(
      'value="https://app.example.com/inbound/meta/abc123"',
    );
    expect(html).toContain('value="verify_token_meta_123"');
    expect(html).toContain("Copiar URL");
    expect(html).toContain("Copiar token");
    expect(html).toContain(
      "Cole URL e token em App Meta → Configurar webhooks → Verificar e salvar.",
    );
    expect(html).toContain('aria-label="Token de verificacao Meta"');
    expect(
      html.match(/class="inbound-webhook-secret-field-row"/g) ?? [],
    ).toHaveLength(2);
  });

  it("keeps the sensitive presentation markers on the one-time Meta secret", () => {
    const html = renderOneTimeSecret({
      provider: "meta_cloud",
      webhookUrl: "https://app.example.com/inbound/meta/abc123",
      verifyToken: "verify_token_meta_123",
    });

    expect(html).toContain('data-presentation-sensitive-action="true"');
    expect(
      html.match(/data-presentation-sensitive-field="true"/g) ?? [],
    ).toHaveLength(2);
  });

  it("keeps a URL-only one-time panel for Umbler and Gupshup", () => {
    for (const provider of ["umbler", "gupshup"] as const) {
      const html = renderOneTimeSecret({
        provider,
        webhookUrl: `https://app.example.com/inbound/${provider}/abc123`,
      });

      expect(html).toContain("URL de callback");
      expect(html).toContain("Copiar URL");
      expect(html).not.toContain("Verify token");
      expect(html).not.toContain("Copiar token");
      expect(
        html.match(/class="inbound-webhook-secret-field-row"/g) ?? [],
      ).toHaveLength(1);
      expect(html).toContain(inboundPasteInstruction(provider));
    }
  });

  it("keeps integrations focused on connection health and links to the Conversões screen", () => {
    const html = renderPanel();

    expect(html).toContain("Gatilhos de conversao");
    expect(html).toContain("0 regra(s) nesta conexao");
    expect(html).toContain('href="/conversions"');
    expect(html).toContain("Abrir Conversões");
    expect(html).toContain("Crie e revise as regras na tela Conversões");
    expect(html).not.toContain("whatsapp-triggers");
    expect(html).not.toContain("Gerenciar gatilhos");
    expect(html).not.toContain("Qualificados e compras");
  });

  it("renders all five counters, channel metadata, and several N:N routes", () => {
    const html = renderPanel();
    const channel = connectionView.channels[0];
    const expectedLastSeen = new Date(channel.lastSeenAt).toLocaleString(
      "pt-BR",
      {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "America/Sao_Paulo",
      },
    );

    for (const [label, value] of [
      ["CTWA roteado", 12],
      ["CTWA pendente", 5],
      ["Sem CTWA", 8],
      ["Duplicados", 3],
      ["Invalidos", 2],
    ] as const) {
      expect(html).toContain(`<span>${label}</span><strong>${value}</strong>`);
    }

    expect(html).toContain('class="inbound-connection"');
    expect(html).not.toContain('<details class="inbound-connection" open="">');
    expect(html).toContain("12 roteados");
    expect(html).toContain("5 pendentes");
    expect(html).toContain("Comercial Sao Paulo");
    expect(html).toContain("+5511999990001");
    expect(html).toContain(expectedLastSeen);
    expect(html.match(/class="inbound-route-row"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="BM da rota 1"');
    expect(html).toContain('aria-label="BM da rota 2"');
    expect(html).toContain("2 rota(s) preparada(s).");
  });

  it("shows redacted readiness and exact blockers for each channel", () => {
    const html = renderPanel();
    const expectedExpiry = new Date(
      connectionView.channels[0].readiness.nextPayloadExpiresAt!,
    ).toLocaleString("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "America/Sao_Paulo",
    });

    expect(html).toContain("Prontidao parcial");
    expect(html).toContain("<span>Rotas válidas</span><strong>2/2</strong>");
    expect(html).toContain("<span>CTWA observados</span><strong>17</strong>");
    expect(html).toContain(
      "<span>Roteados preservados</span><strong>12</strong>",
    );
    expect(html).toContain("<span>CTWA pendentes</span><strong>5</strong>");
    expect(html).toContain("5 CTWA aguardam uma rota Meta exata.");
    expect(html).toContain(
      "O payload preservado mais proximo expira em menos de 48 horas.",
    );
    expect(html).toContain(expectedExpiry);
    expect(html).not.toContain("CTWaCLId");
    expect(html).not.toContain("encryptedPayload");
  });

  it("uses only the supplied workspace Meta options for each exact route", () => {
    expect(
      inboundWebhookReportingAccountOptions(
        metaConfiguration,
        "business_connection_sales",
      ),
    ).toEqual([
      {
        value: "reporting_sales",
        label: "Conta Vendas Atual",
        description: "act_sales",
      },
    ]);

    const html = renderPanel();

    for (const value of [
      "BM Vendas Atual",
      "BM Suporte Atual",
      "Conta Vendas Atual",
      "Conta Suporte Atual",
      "Pixel e Pagina Vendas",
      "Pixel e Pagina Suporte",
    ]) {
      expect(html).toContain(value);
    }
    expect(html).not.toContain("workspace_foreign");
    expect(html).not.toContain("Conta Foreign");
  });

  it("enables manager commands while keeping analyst routes visible and read-only", () => {
    const managerHtml = renderPanel({ canManage: true });
    const analystHtml = renderPanel({ canManage: false });

    for (const command of [
      "Adicionar conexão",
      "Ativar envios automaticos",
      "Pausar conexão",
      "Gerar nova URL",
      "Remover",
      "Pausar envio",
      "Adicionar rota",
      "Salvar rotas",
    ]) {
      expect(managerHtml).toContain(command);
    }
    expect(managerHtml).toContain('aria-readonly="false"');

    expect(analystHtml).toContain("Rotas visiveis em modo somente leitura.");
    expect(analystHtml).toContain("2 rota(s) configurada(s).");
    expect(analystHtml).toContain("BM Vendas Atual");
    expect(analystHtml).toContain("Conta Suporte Atual");
    expect(analystHtml).toContain('aria-readonly="true"');
    expect(analystHtml).not.toContain("Adicionar conexão");
    expect(analystHtml).not.toContain("Gerar nova URL");
    expect(analystHtml).not.toContain("Pausar envio");
    expect(analystHtml).not.toContain("Adicionar rota");
    expect(analystHtml).not.toContain("Salvar rotas");
  });

  it("marks connection, channel, number, BM, account, Pixel, and Page as private", () => {
    const html = renderPanel();

    for (const placeholder of [
      "Conexao WhatsApp",
      "Canal oculto",
      "Numero oculto",
      "BM oculta",
      "Conta oculta",
      "Pixel e Pagina ocultos",
    ]) {
      expect(html).toContain(placeholder);
    }
    expect(html).toContain('data-presentation-sensitive="true"');
    expect(html).toContain('data-presentation-sensitive-field="true"');
  });
});

function connectionViewWithoutChannels(
  connectionOverrides: Partial<
    InboundWebhookConnectionView["overview"]["connection"]
  > = {},
): InboundWebhookConnectionView {
  return {
    ...connectionView,
    overview: {
      ...connectionView.overview,
      connection: {
        ...connectionView.overview.connection,
        ...connectionOverrides,
      },
    },
    channels: [],
  };
}

function renderOneTimeSecret(
  secret: Omit<InboundWebhookOneTimeSecret, "connectionId"> &
    Partial<Pick<InboundWebhookOneTimeSecret, "connectionId">>,
) {
  return renderToStaticMarkup(
    createElement(InboundWebhookOneTimeSecretPanel, {
      secret: { connectionId: "connection_1", ...secret },
      urlCopied: false,
      onCopyUrl: () => undefined,
      onCopyVerifyToken: () => undefined,
      onDismiss: () => undefined,
    }),
  );
}

function renderPanel({
  canManage = true,
  connections = [connectionView],
  capabilities: panelCapabilities = capabilities,
}: {
  canManage?: boolean;
  connections?: InboundWebhookConnectionView[];
  capabilities?: InboundWebhookCapabilitiesDto;
} = {}) {
  const action = vi.fn(async (_formData: FormData) => ({
    ok: true as const,
    message: "ok",
  }));

  return renderToStaticMarkup(
    createElement(InboundWebhookPanel, {
      capabilities: panelCapabilities,
      connections,
      providerRules: [],
      providerRulesEnabled: true,
      metaConfiguration,
      canManage,
      canRecover: canManage,
      createAction: action,
      rotateSecretAction: action,
      setConnectionStatusAction: action,
      removeConnectionAction: action,
      createChannelAction: action,
      setChannelStatusAction: action,
      saveRoutesAction: action,
    }),
  );
}

it("offers student historical CTWA recovery on the Meta connection", () => {
  const html = renderPanel({ connections: [{
    ...connectionView,
    overview: { ...connectionView.overview, connection: {
      ...connectionView.overview.connection, provider: "meta_cloud", parserVersion: "v1",
    } },
  }] });
  expect(html).toContain("Recuperar CTWAs anteriores");
  expect(html).toContain("CTWA roteado nao significa enviado");
});

function inboundRoute({
  id,
  metaBusinessConnectionId,
  metaReportingAccountId,
  metaConversionDestinationId,
}: {
  id: string;
  metaBusinessConnectionId: string;
  metaReportingAccountId: string;
  metaConversionDestinationId: string;
}) {
  return {
    id,
    channelId: "channel_1",
    metaBusinessConnectionId,
    metaReportingAccountId,
    metaConversionDestinationId,
    active: true,
    validationStatus: "valid",
    validationErrorCode: null,
    lastValidatedAt: "2026-07-17T19:25:00.000Z",
    createdAt: "2026-07-17T19:00:00.000Z",
    updatedAt: "2026-07-17T19:25:00.000Z",
  };
}

function metaBusinessConnection({
  id,
  businessManagerId,
  businessManagerName,
  defaultConversionDestinationId,
}: {
  id: string;
  businessManagerId: string;
  businessManagerName: string;
  defaultConversionDestinationId: string;
}) {
  return {
    id,
    workspaceId: "workspace_current",
    credentialId: "credential_current",
    businessManagerId,
    businessManagerName,
    status: "active" as const,
    defaultConversionDestinationId,
    reportingAccountCount: 1,
    activeReportingAccountCount: 1,
    lastValidatedAt: "2026-07-17T19:00:00.000Z",
    validationError: null,
    lastSyncedAt: "2026-07-17T19:00:00.000Z",
    createdAt: "2026-07-17T18:00:00.000Z",
    updatedAt: "2026-07-17T19:00:00.000Z",
  };
}

function metaDestination({
  id,
  label,
  ownerBusinessManagerId,
  pixelId,
  pixelName,
  pageId,
  pageName,
}: {
  id: string;
  label: string;
  ownerBusinessManagerId: string;
  pixelId: string;
  pixelName: string;
  pageId: string;
  pageName: string;
}) {
  return {
    id,
    workspaceId: "workspace_current",
    label,
    ownerBusinessManagerId,
    pixelId,
    pixelName,
    pageId,
    pageName,
    status: "configured" as const,
    lastValidatedAt: "2026-07-17T19:00:00.000Z",
    validationError: null,
  };
}

function metaReportingAccount({
  id,
  businessId,
  businessName,
  adAccountId,
  adAccountName,
  businessConnectionId,
  conversionDestinationId,
}: {
  id: string;
  businessId: string;
  businessName: string;
  adAccountId: string;
  adAccountName: string;
  businessConnectionId: string;
  conversionDestinationId: string;
}) {
  return {
    id,
    workspaceId: "workspace_current",
    businessId,
    businessName,
    adAccountId,
    adAccountName,
    currency: "BRL",
    timezoneName: "America/Sao_Paulo",
    businessConnectionId,
    conversionDestinationId,
    conversionDestinationIds: [conversionDestinationId],
    active: true,
    syncStatus: "synced" as const,
    lastSyncedAt: "2026-07-17T19:00:00.000Z",
    lastSyncSince: null,
    lastSyncUntil: null,
    syncError: null,
  };
}
