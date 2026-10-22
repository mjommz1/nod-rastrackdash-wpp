import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { providerRule } from "./conversions-fixtures";
import IntegrationsPage from "../src/app/(app)/integrations/page";
import {
  metaAdAccountsForBusiness,
  metaPixelsForBusiness,
} from "../src/app/(app)/integrations/meta-assets-form";
import { resolveMetaStatus } from "../src/app/(app)/integrations/meta-connection-state";
import { metaReportingAccountsForBusiness } from "../src/app/(app)/integrations/meta-reporting-accounts-form";
import {
  baseConnection,
  baseRule,
  snapshotOf,
} from "./support/pipedrive-fixtures";

vi.mock("next/navigation", () => ({
  redirect: () => undefined,
  useRouter: () => ({
    refresh: () => undefined,
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("integrations route", () => {
  it("uses the persisted OAuth status before a stale asset status", () => {
    expect(resolveMetaStatus("connected", "not_connected")).toBe("connected");
  });

  it("renders whatsapp instances with connection actions", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      const response = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (path === "/integrations/health") return response({ checkedAt: "2026-07-02T03:00:00.000Z", providers: [{ provider: "uazapi", status: "connected", checkedAt: "2026-07-02T03:00:00.000Z" }] });
      if (path === "/integrations/whatsapp/instances") return response([{ id: "wpp_1", name: "Vendas", provider: "uazapi", billingStatus: "active", providerInstanceId: "provider_instance_1", checkoutUrl: null, createdAt: "2026-07-02T03:00:00.000Z" }, { id: "wpp_2", name: "Suporte", provider: "uazapi", billingStatus: "pending_payment", providerInstanceId: null, checkoutUrl: "https://sandbox.asaas.com/i/pay_2", createdAt: "2026-07-02T03:00:00.000Z" }]);
      if (path === "/integrations/meta/connection") return response({ workspaceId: "workspace_1", status: "connected", tokenType: "bearer", scopes: ["ads_read", "business_management"], expiresAt: null, connectedAt: "2026-07-02T03:00:00.000Z", selectedBusinessId: null, selectedAdAccountId: null, selectedPixelId: "pixel_1", capiTokenConfigured: true });
      if (path === "/integrations/meta/assets") return response({ workspaceId: "workspace_1", status: "connected", businesses: [{ id: "business_1", name: "BM Principal", verificationStatus: "verified" }, { id: "business_2", name: "BM Secundario", verificationStatus: null }], adAccounts: [{ id: "act_1", businessId: "business_1", name: "Conta WhatsApp", accountStatus: "active", currency: "BRL", timezoneName: "America/Sao_Paulo" }, { id: "act_2", businessId: "business_2", name: "Conta Outro BM", accountStatus: "active", currency: "USD", timezoneName: "America/New_York" }], pixels: [{ id: "pixel_1", businessId: "business_1", name: "Pixel Loja", code: "<!-- Facebook Pixel Code --> <script>fbq('init', '123456789');</script><script src=\"https://connect.facebook.net/en_US/fbevents.js\"></script>" }, { id: "pixel_2", businessId: "business_2", name: "Pixel Outro BM", code: "987654321" }], pages: [{ id: "page_1", businessId: "business_1", name: "Pagina Facebook principal" }, { id: "page_2", businessId: "business_2", name: "Pagina Outro BM" }], conversionDestination: { workspaceId: "workspace_1", pixelId: "pixel_1", pixelName: "Pixel Loja", pageId: "page_1", pageName: "Pagina Facebook principal", status: "configured", lastValidatedAt: "2026-07-02T03:00:00.000Z", validationError: null }, reportingAccounts: [{ id: "reporting_1", workspaceId: "workspace_1", businessId: "business_1", businessName: "BM Principal", adAccountId: "act_1", adAccountName: "Conta WhatsApp", currency: "BRL", timezoneName: "America/Sao_Paulo", active: true, syncStatus: "synced", lastSyncedAt: "2026-07-02T03:00:00.000Z", syncError: null }], selection: { businessId: "business_1", adAccountId: "act_1", pixelId: "pixel_1" }, lastSyncedAt: "2026-07-02T03:00:00.000Z", syncError: null });
      if (path === "/integrations/pipeline") return response({ workspaceId: "workspace_1", rangeLabel: "Ultimos 7 dias", stages: [{ key: "ctwa", label: "CTWA", value: 3, detail: "Leads com origem de campanha Meta" }, { key: "webhook", label: "Webhook", value: 4, detail: "Webhooks NOD API recebidos" }, { key: "lead", label: "Lead", value: 5, detail: "Leads rastreados pelo WhatsApp" }, { key: "conversion_ready", label: "CAPI pronta", value: 6, detail: "Eventos aguardando envio para Meta" }, { key: "meta_sent", label: "Meta ACK", value: 2, detail: "Eventos enviados para Meta" }] });
      if (path === "/workspaces/current") return response({ id: "workspace_1", name: "Workspace", slug: "workspace", role: "owner", platformRole: "platform_owner", permissions: { canInviteMembers: true, canManageBilling: true, canManageIntegrations: true, canViewReports: true } });
      if (path === "/integrations/meta/capabilities") return response({ enabledModes: ["oauth"], oauthEnabled: true, manualEnabled: false });
      if (path === "/integrations/meta/oauth/advanced") return response({ workspaceId: "workspace_1", connectionMode: "oauth", advancedRoutingEnabled: false, unmappedActiveAccountCount: 1, credentials: [], businessConnections: [], destinations: [], reportingAccounts: [] });
      if (path === "/integrations/whatsapp/instances/wpp_1/status") return response({ whatsappInstanceId: "wpp_1", provider: "uazapi", billingStatus: "active", connectionStatus: "qr_required", qrCode: "qr-code-text", message: "Escaneie o QR Code" });
      if (path === "/integrations/whatsapp-connections") return response([]);
      return response({ message: "unavailable" }, 503);
    });

    const element = await IntegrationsPage({
      searchParams: Promise.resolve({ notice: "meta-reporting-saved" }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    // Hub layout: tabs by category, cards with state, one modal per provider.
    expect(html).toContain("Central de integracoes");
    expect(html).not.toContain("Mapa das conexoes");
    expect(html).not.toContain('aria-label="Atalhos das integracoes"');
    expect(html).toContain('role="tablist"');
    for (const tab of ["WhatsApp", "Atendimento e vendas", "Anúncios", "CRM"]) {
      expect(html).toContain(`<span>${tab}</span>`);
    }
    for (const id of [
      "integracao-whatsapp",
      "integracao-atendimento",
      "integracao-anuncios",
      "integracao-crm",
      "integracao-fluxo",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('aria-label="Gerenciar Meta Ads"');
    expect(html).toContain('data-integration="meta" data-state="active"');
    expect(html).toContain('aria-label="Conectar Kommo"');
    expect(html).toContain("Ativos");
    expect(html).toContain("Disponíveis");

    for (const path of [
      "/integrations/whatsapp/instances",
      "/integrations/meta/connection",
      "/integrations/meta/assets",
      "/integrations/meta/oauth/advanced",
      "/integrations/pipeline",
      "/workspaces/current",
      "/integrations/whatsapp-connections",
    ]) {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `http://localhost:3333${path}`,
        expect.objectContaining({ credentials: "include" }),
      );
    }
    // Student edition: no SaaS billing endpoints behind the hub.
    for (const call of vi.mocked(globalThis.fetch).mock.calls) {
      expect(String(call[0])).not.toContain("/billing/");
    }

    // The Meta modal (notice reopens it) keeps the former Meta section.
    expect(html).toContain("Meta conectado");
    expect(html).toContain("Conta adicionada");
    expect(html).toContain("A conta de anuncio foi adicionada aos relatorios.");
    expect(html).toContain("Atualizar ativos Meta");
    expect(html).not.toContain("Trocar conta Meta");
    expect(html).toContain("pixel_1");
    expect(html).toContain("BM Principal");
    expect(html).toContain("Conta WhatsApp");
    expect(html).toContain("Pixel Loja");
    expect(html).toContain("Destino de conversao");
    expect(html).toContain("Pagina Facebook principal");
    expect(html).not.toContain("Pagina Outro BM");
    expect(html).toContain("Contas para relatorios");
    expect(html).toContain("America/Sao_Paulo");
    expect(html).toContain("Desativar");
    expect(html).toContain("meta-reporting-account-action-cell");
    expect(html).toContain("meta-reporting-account-action");
    expect(html).not.toContain("Facebook Pixel Code");
    expect(html).not.toContain("connect.facebook.net");
    expect(html).not.toContain("fbq(&#x27;init&#x27;");
    expect(html).toContain("BM Secundario");
    expect(html).not.toContain("Conta Outro BM");
    expect(html).not.toContain("Pixel Outro BM");
    expect(html).not.toContain("Escopos");
    expect(html).not.toContain("Token CAPI");
    expect(html).not.toContain('name="accessToken"');
    expect(html).not.toContain("Salvar token CAPI");
    expect(html).not.toContain("Remover token CAPI");
    expect(html).toContain('name="businessId"');
    expect(html).toContain('name="businessName"');
    expect(html).toContain('name="adAccountId"');
    expect(html).toContain('name="adAccountName"');
    expect(html).toContain('name="pixelId"');
    expect(html).toContain('name="pixelName"');
    expect(html).toContain('name="pageName"');
    expect(html).not.toContain("Salvar selecao Meta");

    // The environment-based Uazapi instance lives in the Uazapi modal.
    expect(html).toContain('data-integration="uazapi_byo" data-state="active"');
    expect(html).toContain("Vendas");
    expect(html).toContain("provider_instance_1");
    expect(html).toContain("Suporte");
    expect(html).toContain("Aguardando ativação");
    expect(html).not.toContain("Pagar agora");
    expect(html).not.toContain("Adicionar instancia");
    expect(html).not.toContain("Abrir assinatura");

    // Pipeline section stays below the hub.
    expect(html).toContain("Leads com origem de campanha Meta");
    expect(html).toContain("Webhooks NOD API recebidos");
    expect(html).toContain("Eventos enviados para Meta");
    expect(html).toContain("Ver diagnostico");
    expect(html).toContain("API conectada");
    expect(html).not.toContain("aguardando dados");
  });

  it("offers only the student providers and no SaaS-only cards", async () => {
    mockWave7IntegrationsFetch({ canManage: true });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));
    const cardIds = [...html.matchAll(/data-integration="([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect([...new Set(cardIds)].sort()).toEqual(
      [
        "kommo",
        "meta",
        "nod_api",
        "payt",
        "pipedrive",
        "umbler",
        "uazapi_byo",
        "waha",
        "zapi",
      ].sort(),
    );
    for (const absent of [
      "unnichat",
      "gohighlevel",
      "guimo",
      "whatsapp-qr",
    ]) {
      expect(html).not.toContain(`data-integration="${absent}"`);
    }
    // Payt has no connection: its card explains the rule flow in Conversões.
    expect(html).toContain('src="/integrations/payt.svg"');
    expect(html).toContain('data-integration="payt" data-state="available"');
    expect(html).toContain("A Payt não tem conexão própria");
    expect(html).toContain("/conversions?nova=automation_payt");
    expect(html).toContain("Criar regra de venda da Payt");
    // Official logos with a fallback for missing files.
    expect(html).toContain('src="/integrations/umbler.svg"');
    expect(html).toContain('src="/integrations/kommo.png"');
    expect(html).toContain('src="/integrations/uazapi.svg"');
    expect(html).not.toContain("/billing/package");
  });

  it("shows the Unnichat card when the API offers it, with the number field in its modal", async () => {
    mockWave7IntegrationsFetch({
      canManage: true,
      extraResponses: {
        "/integrations/inbound-webhooks/capabilities": {
          enabled: true,
          providers: [
            {
              provider: "umbler",
              parserVersion: "umbler/v1",
              parserReleaseStatus: "observation_only",
              creationEnabled: true,
            },
            {
              provider: "unnichat",
              parserVersion: "unnichat/v1",
              parserReleaseStatus: "certified",
              creationEnabled: true,
            },
          ],
        },
      },
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain('data-integration="unnichat" data-state="available"');
    expect(html).toContain('src="/integrations/unnichat.png"');
    expect(html).toContain("Conectar Unnichat");
    expect(html).toContain('name="connectedPhone"');
    expect(html).toContain("Número de WhatsApp do cliente");
    expect(html).toContain('<input type="hidden" name="provider" value="unnichat"/>');
    // The other providers' forms do not ask for a number.
    expect(html.match(/name="connectedPhone"/g)).toHaveLength(1);
  });

  it("shows the Payt card as active once a sale rule exists and links to Conversões", async () => {
    mockWave7IntegrationsFetch({
      canManage: true,
      extraResponses: {
        "/conversion-rules/providers": [
          paytRuleFixture("rule_payt_1", true),
          paytRuleFixture("rule_payt_2", false),
        ],
      },
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain('data-integration="payt" data-state="active"');
    expect(html).toContain("Recebendo vendas");
    expect(html).toContain("2 regras");
    expect(html).toContain("2 regras de venda configuradas");
    expect(html).toContain("Gerenciar regras da Payt");
    expect(html).not.toContain("Criar regra de venda da Payt");
    // The rule is not a connection: no inbound panel is asked for Payt.
    expect(html).not.toContain("Criar conexão Payt");
  });

  it("shows the external WhatsApp source without instance sales or false API errors", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (url.endsWith("/integrations/health")) {
        return json({
          checkedAt: "2026-07-12T03:42:00.000Z",
          providers: [],
        });
      }

      if (url.endsWith("/integrations/meta/connection")) {
        return json({
          workspaceId: "workspace_1",
          status: "not_connected",
          tokenType: null,
          scopes: [],
          expiresAt: null,
          connectedAt: null,
          selectedBusinessId: null,
          selectedAdAccountId: null,
          selectedPixelId: null,
          capiTokenConfigured: false,
        });
      }

      if (url.endsWith("/integrations/meta/assets")) {
        return json({
          workspaceId: "workspace_1",
          status: "not_connected",
          businesses: [],
          adAccounts: [],
          pixels: [],
          pages: [],
          reportingAccounts: [],
          selection: {
            businessId: null,
            adAccountId: null,
            pixelId: null,
          },
          lastSyncedAt: null,
          syncError: null,
        });
      }

      if (url.endsWith("/integrations/pipeline")) {
        return json({
          workspaceId: "workspace_1",
          rangeLabel: "Ultimos 7 dias",
          whatsappSource: {
            mode: "external",
            connectorName: "MySQL Barbieri",
            provider: "kinbox_mysql",
            lastSyncCompletedAt: "2026-07-12T03:41:52.000Z",
            lastSyncStatus: "completed",
          },
          stages: [],
        });
      }

      if (url.endsWith("/workspaces/current")) {
        return json({
          id: "workspace_1",
          name: "Barbieri",
          slug: "barbieri",
          role: "owner",
          permissions: {
            canInviteMembers: true,
            canManageBilling: true,
            canManageIntegrations: true,
            canViewReports: true,
          },
        });
      }

      return json({ message: "native WhatsApp billing unavailable" }, 503);
    });

    const element = await IntegrationsPage({
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Dados recebidos por integracao externa do MySQL");
    expect(html).toContain("Integracao externa MySQL");
    expect(html).toContain("12/07/2026, 00:41");
    expect(html).toContain("Sincronizado");
    expect(html).not.toContain("MySQL Barbieri");
    expect(html).not.toContain("Kinbox / MySQL");
    expect(html).not.toContain("API conectada");
    expect(html).not.toContain("API indisponivel");
    expect(html).not.toContain("Ver diagnostico");
    expect(html).not.toContain("Instancias conectadas");
    expect(html).not.toContain("Adicionar instancia");
    expect(html).not.toContain("Antecipada via Asaas");
    expect(html).not.toContain("Nova instancia");
  });

  it("filters Meta ad accounts and pixels by selected business", () => {
    const assets = {
      workspaceId: "workspace_1",
      status: "connected" as const,
      businesses: [
        { id: "business_1", name: "BM Principal", verificationStatus: null },
        { id: "business_2", name: "BM Secundario", verificationStatus: null },
      ],
      adAccounts: [
        {
          id: "act_1",
          businessId: "business_1",
          name: "Conta Principal",
          accountStatus: null,
          currency: "BRL",
          timezoneName: null,
        },
        {
          id: "act_2",
          businessId: "business_2",
          name: "Conta Secundaria",
          accountStatus: null,
          currency: "USD",
          timezoneName: null,
        },
      ],
      pixels: [
        {
          id: "pixel_1",
          businessId: "business_1",
          name: "Pixel Principal",
          code: null,
        },
        {
          id: "pixel_2",
          businessId: "business_2",
          name: "Pixel Secundario",
          code: null,
        },
      ],
      selection: {
        businessId: "business_1",
        adAccountId: "act_1",
        pixelId: "pixel_1",
      },
      lastSyncedAt: "2026-07-02T03:00:00.000Z",
      syncError: null,
    };

    expect(metaAdAccountsForBusiness(assets, "business_2")).toEqual([
      expect.objectContaining({ id: "act_2", name: "Conta Secundaria" }),
    ]);
    expect(metaPixelsForBusiness(assets, "business_2")).toEqual([
      expect.objectContaining({ id: "pixel_2", name: "Pixel Secundario" }),
    ]);
  });

  it("filters Meta reporting accounts by selected business", () => {
    const assets = {
      workspaceId: "workspace_1",
      status: "connected" as const,
      businesses: [
        { id: "business_1", name: "BM Principal", verificationStatus: null },
        { id: "business_2", name: "BM Secundario", verificationStatus: null },
      ],
      adAccounts: [
        {
          id: "act_1",
          businessId: "business_1",
          name: "Conta Principal",
          accountStatus: null,
          currency: "BRL",
          timezoneName: null,
        },
        {
          id: "act_2",
          businessId: "business_2",
          name: "Conta Secundaria",
          accountStatus: null,
          currency: "USD",
          timezoneName: null,
        },
      ],
      pixels: [],
      pages: [],
      selection: {
        businessId: "business_1",
        adAccountId: "act_1",
        pixelId: null,
      },
      lastSyncedAt: "2026-07-02T03:00:00.000Z",
      syncError: null,
    };

    expect(metaReportingAccountsForBusiness(assets, "business_2")).toEqual([
      expect.objectContaining({ id: "act_2", name: "Conta Secundaria" }),
    ]);
  });

  it("hides integration mutation actions for workspace members", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

      if (path === "/integrations/health") return response({ checkedAt: "2026-07-02T03:00:00.000Z", providers: [{ provider: "uazapi", status: "connected", checkedAt: "2026-07-02T03:00:00.000Z" }] });
      if (path === "/integrations/whatsapp/instances") return response([{ id: "wpp_1", name: "Vendas", provider: "uazapi", billingStatus: "active", providerInstanceId: "provider_instance_1", checkoutUrl: null, createdAt: "2026-07-02T03:00:00.000Z" }]);
      if (path === "/integrations/meta/connection") return response({ workspaceId: "workspace_1", status: "connected", tokenType: "bearer", scopes: ["ads_read"], expiresAt: null, connectedAt: "2026-07-02T03:00:00.000Z", selectedBusinessId: "business_1", selectedAdAccountId: "act_1", selectedPixelId: "pixel_1", capiTokenConfigured: true });
      if (path === "/integrations/meta/assets") return response({ workspaceId: "workspace_1", status: "connected", businesses: [{ id: "business_1", name: "BM Principal", verificationStatus: null }], adAccounts: [{ id: "act_1", businessId: "business_1", name: "Conta WhatsApp", accountStatus: null, currency: "BRL", timezoneName: null }], pixels: [{ id: "pixel_1", businessId: "business_1", name: "Pixel Loja", code: "123456789" }], selection: { businessId: "business_1", adAccountId: "act_1", pixelId: "pixel_1" }, lastSyncedAt: "2026-07-02T03:00:00.000Z", syncError: null });
      if (path === "/integrations/pipeline") return response({ workspaceId: "workspace_1", rangeLabel: "Ultimos 7 dias", stages: [] });
      if (path === "/workspaces/current") return response({ id: "workspace_1", name: "Workspace", slug: "workspace", role: "member", permissions: { canInviteMembers: false, canManageBilling: false, canManageIntegrations: false, canViewReports: true } });
      if (path === "/integrations/meta/capabilities") return response({ enabledModes: ["oauth"], oauthEnabled: true, manualEnabled: false });
      if (path === "/integrations/whatsapp/instances/wpp_1/status") return response({ whatsappInstanceId: "wpp_1", provider: "uazapi", billingStatus: "active", connectionStatus: "connected", qrCode: null, message: "WhatsApp conectado" });
      if (path === "/integrations/whatsapp-connections") return response([]);
      return response({ message: "unavailable" }, 503);
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Contas para relatorios");
    expect(html).toContain("Vendas");
    expect(html).toContain("Sem permissao para alterar destino Meta");
    expect(html).toContain("Sem permissao para alterar contas de relatorio");
    expect(html).not.toContain("Escopos");
    expect(html).not.toContain("Token CAPI");
    expect(html).not.toContain("Salvar token CAPI");
    expect(html).not.toContain("Remover token CAPI");
    expect(html).toContain("Aguardando eventos reais");
    expect(html).not.toContain("sem dados");
    expect(html).not.toContain("Salvar selecao Meta");
    // Members read the hub but never mutate: no create/connect/refresh forms.
    expect(html).not.toContain("Atualizar ativos Meta");
    expect(html).not.toContain("Salvar conexao");
    expect(html).not.toContain('name="baseUrl"');
    expect(html).not.toContain("Gerar URL de integração");
    expect(html).not.toContain("Excluir");
    expect(html).not.toContain("Ver diagnostico");
    expect(html).not.toContain("provedores");
    // Kommo is owner-only on the API: members only see why.
    expect(html).toContain("Somente o dono da conta conecta CRMs");
    expect(html).toContain("Sem acesso");
  });

  it("renders unavailable states without visual fallback providers or fake pipeline metrics", async () => {
    // Path-based (not call-order based): every endpoint fails, whatever the
    // page reads and in whatever order.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ message: "unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).not.toContain("Ver diagnostico");
    expect(html).not.toContain("Nao foi possivel carregar integracoes");
    expect(html).toContain("Nao foi possivel ler os ativos Meta agora.");
    expect(html).toContain("Nao foi possivel carregar instancias");
    expect(html).not.toContain("Leitura de ativos indisponivel");
    expect(html).not.toContain("Tente novamente apos a API responder");
    expect(html).not.toContain("aguardando API");
    expect(html).not.toContain("sem dados");
    expect(html).not.toContain("Fallback visual");
    expect(html).not.toContain("Fallback local");
    expect(html).not.toContain("Sem credenciais reais");
    expect(html).not.toContain("capturado");
    expect(html).not.toContain("online");
    expect(html).not.toContain("92%");
    expect(html).not.toContain("99%");
    expect(html).not.toContain("18s");
  });

  it("renders unknown integration statuses as explicit unknown states", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

      if (path === "/integrations/health") return response({ checkedAt: "2026-07-02T03:00:00.000Z", providers: [{ provider: "uazapi", status: "rate_limited", checkedAt: "2026-07-02T03:00:00.000Z" }] });
      if (path === "/integrations/whatsapp/instances") return response([{ id: "wpp_1", name: "Vendas", provider: "uazapi", billingStatus: "provisioning_hold", providerInstanceId: null, checkoutUrl: null, createdAt: "2026-07-02T03:00:00.000Z" }]);
      if (path === "/integrations/meta/connection") return response({ workspaceId: "workspace_1", status: "sync_paused", tokenType: "bearer", scopes: [], expiresAt: null, connectedAt: null, selectedBusinessId: null, selectedAdAccountId: null, selectedPixelId: null });
      if (path === "/integrations/meta/assets") return response({ workspaceId: "workspace_1", status: "sync_paused", businesses: [], adAccounts: [], pixels: [], selection: { businessId: null, adAccountId: null, pixelId: null }, lastSyncedAt: null, syncError: null });
      if (path === "/integrations/pipeline") return response({ workspaceId: "workspace_1", rangeLabel: "Ultimos 7 dias", stages: [] });
      if (path === "/workspaces/current") return response({ id: "workspace_1", name: "Workspace", slug: "workspace", role: "owner", platformRole: "platform_owner", permissions: { canInviteMembers: true, canManageBilling: true, canManageIntegrations: true, canViewReports: true } });
      if (path === "/integrations/meta/capabilities") return response({ enabledModes: ["oauth"], oauthEnabled: true, manualEnabled: false });
      if (path === "/integrations/whatsapp-connections") return response([]);
      return response({ message: "unavailable" }, 503);
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Meta com status desconhecido");
    expect(html).toContain("Status desconhecido");
    // An unknown Meta status never looks connected on the hub card.
    expect(html).toContain('data-integration="meta" data-state="available"');
    expect(html).not.toContain("rate_limited");
    expect(html).not.toContain("sync_paused");
    expect(html).not.toContain("provisioning_hold");
    expect(html).not.toContain("manual_review");
  });

  it("renders stale Meta asset selections as resync-required states", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

      if (path === "/integrations/health") return response({ checkedAt: "2026-07-02T03:00:00.000Z", providers: [] });
      if (path === "/integrations/whatsapp/instances") return response([]);
      if (path === "/integrations/meta/connection") return response({ workspaceId: "workspace_1", status: "connected", tokenType: "bearer", scopes: ["ads_read"], expiresAt: null, connectedAt: "2026-07-02T03:00:00.000Z", selectedBusinessId: "business_old", selectedAdAccountId: "act_old", selectedPixelId: "pixel_old" });
      if (path === "/integrations/meta/assets") return response({ workspaceId: "workspace_1", status: "connected", businesses: [{ id: "business_new", name: "BM Nova", verificationStatus: null }], adAccounts: [{ id: "act_new", businessId: "business_new", name: "Conta Nova", accountStatus: null, currency: "BRL", timezoneName: null }], pixels: [{ id: "pixel_new", businessId: "business_new", name: "Pixel Novo", code: "999" }], selection: { businessId: "business_old", adAccountId: "act_old", pixelId: "pixel_old" }, lastSyncedAt: "2026-07-02T03:00:00.000Z", syncError: null });
      if (path === "/integrations/pipeline") return response({ workspaceId: "workspace_1", rangeLabel: "Ultimos 7 dias", stages: [] });
      if (path === "/workspaces/current") return response({ id: "workspace_1", name: "Workspace", slug: "workspace", role: "owner", permissions: { canInviteMembers: true, canManageBilling: true, canManageIntegrations: true, canViewReports: true } });
      if (path === "/integrations/meta/capabilities") return response({ enabledModes: ["oauth"], oauthEnabled: true, manualEnabled: false });
      if (path === "/integrations/whatsapp-connections") return response([]);
      return response({ message: "unavailable" }, 503);
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("BM Nova");
    expect(html).toContain("Sem Pixel");
    expect(html).toContain("Sem Pagina");
    expect(html).toContain("Nenhuma conta configurada");
    expect(html).not.toContain("business_old");
    expect(html).not.toContain("act_old");
    expect(html).not.toContain("pixel_old");
    expect(html).not.toContain("ativo selecionado nao encontrado");
  });

  it("does not present a workspace API failure as denied permission", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const response = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (url.includes("/workspaces/current")) {
        return response({ message: "unavailable" }, 503);
      }

      if (url.includes("/integrations/health")) {
        return response({
          checkedAt: "2026-07-10T10:00:00.000Z",
          providers: [],
        });
      }

      if (url.includes("/integrations/whatsapp/instances")) {
        return response([]);
      }

      if (url.includes("/integrations/meta/connection")) {
        return response({
          workspaceId: "workspace_1",
          status: "connected",
          scopes: [],
          expiresAt: null,
          connectedAt: "2026-07-10T10:00:00.000Z",
        });
      }

      if (url.includes("/integrations/meta/assets")) {
        return response({
          workspaceId: "workspace_1",
          status: "connected",
          businesses: [],
          adAccounts: [],
          pixels: [],
          pages: [],
          reportingAccounts: [],
          selection: {
            businessId: null,
            adAccountId: null,
            pixelId: null,
          },
          conversionDestination: null,
          lastSyncedAt: null,
          syncError: null,
        });
      }

      if (url.includes("/billing/whatsapp-instance/quote")) {
        return response({
          workspaceId: "workspace_1",
          activeInstances: 0,
          pricePerInstanceCents: 9900,
          nextInstanceAmountCents: 9900,
          currency: "BRL",
        });
      }

      if (url.includes("/billing/subscription")) {
        return response({
          workspaceId: "workspace_1",
          status: "active",
          planName: "Por instancia",
          activeInstances: 0,
          pricePerWhatsappInstanceCents: 9900,
          monthlyAmountCents: 0,
          currentPeriodEnd: null,
          asaasSubscriptionId: null,
        });
      }

      if (url.includes("/integrations/pipeline")) {
        return response({
          workspaceId: "workspace_1",
          rangeLabel: "Ultimos 7 dias",
          stages: [],
        });
      }

      return response({ message: "not found" }, 404);
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Permissoes temporariamente indisponiveis");
    expect(html).toContain("Nao foi possivel confirmar as permissoes agora.");
    expect(html).toContain("Trocar conta Meta");
    expect(html).toContain("A API validara a acao ao continuar.");
    expect(html).not.toContain(">sem permissao<");
  });

  it("keeps OAuth first and exposes manual setup only as the alternative", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        const response = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          });

        if (url.includes("/integrations/health")) {
          return response({
            checkedAt: "2026-07-14T12:00:00.000Z",
            providers: [],
          });
        }
        if (url.includes("/integrations/whatsapp/instances")) {
          return response([]);
        }
        if (url.includes("/integrations/meta/connection")) {
          return response({
            workspaceId: "workspace_manual",
            status: "not_connected",
            tokenType: null,
            scopes: [],
            expiresAt: null,
            connectedAt: null,
            selectedBusinessId: null,
            selectedAdAccountId: null,
            selectedPixelId: null,
            capiTokenConfigured: false,
          });
        }
        if (url.includes("/integrations/meta/assets")) {
          return response({
            workspaceId: "workspace_manual",
            status: "not_connected",
            businesses: [],
            adAccounts: [],
            pixels: [],
            pages: [],
            reportingAccounts: [],
            selection: {
              businessId: null,
              adAccountId: null,
              pixelId: null,
            },
            conversionDestination: null,
            lastSyncedAt: null,
            syncError: null,
          });
        }
        if (url.includes("/integrations/meta/capabilities")) {
          return response({
            enabledModes: ["oauth", "manual"],
            oauthEnabled: true,
            manualEnabled: true,
          });
        }
        if (url.includes("/integrations/meta/manual")) {
          return response({
            workspaceId: "workspace_manual",
            credentials: [],
            businessConnections: [],
            destinations: [],
            reportingAccounts: [],
          });
        }
        if (url.includes("/billing/whatsapp-instance/quote")) {
          return response({
            workspaceId: "workspace_manual",
            activeInstances: 0,
            pricePerInstanceCents: 9900,
            nextInstanceAmountCents: 9900,
            currency: "BRL",
          });
        }
        if (url.includes("/billing/subscription")) {
          return response({
            workspaceId: "workspace_manual",
            status: "active",
            planName: "Por instancia",
            activeInstances: 0,
            pricePerWhatsappInstanceCents: 9900,
            monthlyAmountCents: 0,
            currentPeriodEnd: null,
            asaasSubscriptionId: null,
          });
        }
        if (url.includes("/integrations/pipeline")) {
          return response({
            workspaceId: "workspace_manual",
            rangeLabel: "Ultimos 7 dias",
            stages: [],
          });
        }
        if (url.includes("/workspaces/current")) {
          return response({
            id: "workspace_manual",
            name: "Cliente Manual",
            slug: "cliente-manual",
            role: "owner",
            permissions: {
              canInviteMembers: true,
              canManageBilling: true,
              canManageIntegrations: true,
              canViewReports: true,
            },
          });
        }

        return response({ message: "not found" }, 404);
      });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));
    const oauthPosition = html.indexOf("Login social Facebook");
    const manualPosition = html.indexOf("Usar token permanente");

    expect(oauthPosition).toBeGreaterThanOrEqual(0);
    expect(manualPosition).toBeGreaterThan(oauthPosition);
    expect(html).toContain("Use o OAuth oficial");
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/integrations/meta/manual"),
      ),
    ).toBe(true);
  });

  it("renders only manual Meta setup when OAuth is disabled", async () => {
    const { requestedPaths } = mockWave7IntegrationsFetch({ canManage: true });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Conexao manual Meta");
    expect(html).toContain(
      "Use o App ID e o token permanente do usuario do sistema.",
    );
    expect(html).not.toContain("Login social Facebook");
    expect(html).not.toContain("Use o OAuth oficial");
    expect(html).not.toContain("Desconectar OAuth");
    expect(html).not.toContain("Usar autorizacao OAuth");
    expect(requestedPaths).not.toContain("/integrations/meta/oauth/advanced");
  });

  it("fails closed when Meta capabilities are unavailable", async () => {
    mockWave7IntegrationsFetch({
      canManage: true,
      failMetaCapabilities: true,
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Configuracao Meta indisponivel");
    expect(html).toContain("Nao foi possivel confirmar os modos de conexao");
    expect(html).not.toContain("Login social Facebook");
    expect(html).not.toContain("Use o OAuth oficial");
    expect(html).not.toContain("Usar autorizacao OAuth");
    expect(html).not.toContain("Salvar destino");
  });

  it.each([
    ["manager", true],
    ["analyst", false],
  ] as const)(
    "wires current-workspace Umbler routes for a %s without relying on fetch order",
    async (_, canManage) => {
      const { requestedPaths } = mockWave7IntegrationsFetch({ canManage });

      const element = await IntegrationsPage({});
      const html = renderToStaticMarkup(createElement("div", null, element));

      expect(requestedPaths).toContain("/integrations/meta/manual");
      expect(requestedPaths).toContain(
        "/integrations/inbound-webhooks/capabilities",
      );
      expect(requestedPaths).toContain("/conversion-rules/providers");
      expect(requestedPaths).toContain(
        "/integrations/inbound-webhooks/connection_wave7/channels",
      );
      expect(html).toContain("Suas conexões Umbler Talk");
      expect(html).toContain("Gatilhos de conversao");
      expect(html).toContain("Regras disponíveis");
      expect(html).toContain('href="/conversions"');
      expect(html).toContain("Abrir Conversões");
      expect(html).not.toContain("whatsapp-triggers");
      expect(html).not.toContain("Gerenciar gatilhos");
      expect(html).not.toContain("Qualificados e compras");
      expect(html).toContain("Umbler Talk");
      expect(html).toContain("Umbler Workspace Atual");
      expect(html).toContain("Canal Workspace Atual");
      expect(html).toContain("+5511988880000");
      expect(html.match(/class="inbound-route-row"/g)).toHaveLength(2);
      expect(html).toContain('name="business-route_wave7_sales"');
      expect(html).toContain('name="account-route_wave7_support"');
      expect(html).toContain("BM Vendas Workspace Atual");
      expect(html).toContain("Conta Suporte Workspace Atual");
      expect(html).toContain("Pixel e Pagina Vendas Workspace Atual");
      expect(html).not.toContain("workspace_foreign");
      expect(html).not.toContain("Conta Foreign");

      if (canManage) {
        expect(html).toContain("Adicionar conexão");
        expect(html).toContain("Gerar nova URL");
        expect(html).toContain("Pausar envio");
        expect(html).toContain("Adicionar rota");
        expect(html).toContain("2 rota(s) preparada(s).");
      } else {
        expect(html).toContain("Rotas visiveis em modo somente leitura.");
        expect(html).toContain("2 rota(s) configurada(s).");
        expect(html).not.toContain("Gerar nova URL");
        expect(html).not.toContain("Pausar canal");
        expect(html).not.toContain("Adicionar rota");
        expect(html).not.toContain("Salvar rotas");
      }
    },
  );

  it("moves Kommo from Settings to the hub CRM tab for the owner", async () => {
    mockWave7IntegrationsFetch({
      canManage: true,
      extraResponses: {
        "/auth/me": { user: { id: "user_owner" } },
        "/workspaces/workspace_current/kommo/connections": [],
        "/license-client/status": {
          status: "active",
          softLock: false,
          hardLock: false,
          usable: true,
          expiresAt: null,
          validUntil: null,
          source: "cache",
        },
      },
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html.match(/data-testid="kommo-crm-manager"/g)).toHaveLength(1);
    expect(html).toContain('id="crm-configurado"');
    expect(html).not.toContain("0 conexão(ões)");
    expect(html).toContain('data-integration="kommo" data-state="available"');
    expect(html).toContain('aria-label="Conectar Kommo"');
    expect(html).not.toContain("Somente o dono da conta conecta CRMs");
    expect(html).not.toContain("Licença bloqueada: criar, editar");
  });

  const activeLicense = {
    status: "active",
    softLock: false,
    hardLock: false,
    usable: true,
    expiresAt: null,
    validUntil: null,
    source: "cache",
  };
  const blockedLicense = {
    status: "blocked",
    softLock: true,
    hardLock: true,
    usable: false,
    expiresAt: null,
    validUntil: null,
    source: "cache",
    locked: true,
    lockReason: "revoked",
  };

  it("offers Pipedrive in the hub CRM tab for the owner, always available (no pilot gate)", async () => {
    mockWave7IntegrationsFetch({
      canManage: true,
      extraResponses: {
        "/auth/me": { user: { id: "user_owner" } },
        "/workspaces/workspace_current/kommo/connections": [],
        "/workspaces/workspace_current/pipedrive/connections": [],
        "/license-client/status": activeLicense,
      },
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html.match(/data-testid="pipedrive-crm-manager"/g)).toHaveLength(1);
    expect(html).toContain('id="crm-configurado-pipedrive"');
    expect(html).toContain('data-integration="pipedrive" data-state="available"');
    expect(html).toContain('aria-label="Conectar Pipedrive"');
    expect(html).toContain('src="/integrations/pipedrive.svg"');
    expect(html).toContain("Nova conexão");
    expect(html).not.toContain("0 conexão(ões)");
    expect(html).not.toContain("Somente o dono da conta conecta CRMs");
    expect(html).not.toContain("Licença bloqueada: criar, editar, pausar, gerar URL");
  });

  it("lists an existing Pipedrive connection with its rule and never renders the token", async () => {
    const snapshot = snapshotOf(baseConnection);
    const base = "/workspaces/workspace_current/pipedrive/connections";
    mockWave7IntegrationsFetch({
      canManage: true,
      extraResponses: {
        "/auth/me": { user: { id: "user_owner" } },
        "/workspaces/workspace_current/kommo/connections": [],
        [base]: [{ ...snapshot, workspaceId: "workspace_current" }],
        [`${base}/${baseConnection.id}`]: {
          ...snapshot,
          workspaceId: "workspace_current",
        },
        [`${base}/${baseConnection.id}/rules`]: [baseRule],
        "/license-client/status": activeLicense,
      },
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain('data-integration="pipedrive" data-state="active"');
    expect(html).toContain("Pipedrive principal");
    expect(html).toContain("Ganho do negócio");
    expect(html).toContain("Subdomínio verificado: suaempresa");
    // The token field is write-only: it never comes back with a value.
    expect(html).not.toMatch(/name="apiToken"[^>]*value=/);
    expect(html).not.toMatch(/value="[^"]*"[^>]*name="apiToken"/);
  });

  it("shows a load failure of the Pipedrive connections instead of an empty CRM", async () => {
    mockWave7IntegrationsFetch({
      canManage: true,
      extraResponses: {
        "/auth/me": { user: { id: "user_owner" } },
        "/workspaces/workspace_current/kommo/connections": [],
        "/license-client/status": activeLicense,
      },
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Não foi possível carregar as conexões Pipedrive");
    expect(html).not.toContain("Nenhuma conexão Pipedrive.");
  });

  it("shows the license lock inside the Pipedrive modal when the license is blocked", async () => {
    mockWave7IntegrationsFetch({
      canManage: true,
      extraResponses: {
        "/auth/me": { user: { id: "user_owner" } },
        "/workspaces/workspace_current/kommo/connections": [],
        "/workspaces/workspace_current/pipedrive/connections": [],
        "/license-client/status": blockedLicense,
      },
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Licença bloqueada: criar, editar, pausar, gerar URL");
  });

  it("opens the Pipedrive modal from ?abrir=pipedrive and shows members the owner-only note", async () => {
    mockWave7IntegrationsFetch({
      canManage: true,
      extraResponses: {
        "/auth/me": { user: { id: "user_owner" } },
        "/workspaces/workspace_current/kommo/connections": [],
        "/workspaces/workspace_current/pipedrive/connections": [],
      },
    });

    const element = await IntegrationsPage({
      searchParams: Promise.resolve({ abrir: "pipedrive" }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toMatch(
      /<div class="app-modal-layer" data-state="open"><div class="app-modal-backdrop"[^>]*><\/div><div class="app-modal app-modal-wide"[^>]*id="integration-modal-pipedrive"/,
    );
    expect(html).toMatch(/id="integrations-tab-crm"[^>]*aria-selected="true"/);

    vi.restoreAllMocks();
    mockWave7IntegrationsFetch({
      canManage: false,
      extraResponses: { "/auth/me": { user: { id: "user_member" } } },
    });
    const memberHtml = renderToStaticMarkup(
      createElement("div", null, await IntegrationsPage({})),
    );
    expect(memberHtml).toContain("Somente o dono da conta conecta CRMs");
    expect(memberHtml).not.toContain('data-testid="pipedrive-crm-manager"');
  });

  it("shows the license lock inside the Kommo modal when the license is blocked", async () => {
    mockWave7IntegrationsFetch({
      canManage: true,
      extraResponses: {
        "/auth/me": { user: { id: "user_owner" } },
        "/workspaces/workspace_current/kommo/connections": [],
        "/license-client/status": {
          status: "blocked",
          softLock: true,
          hardLock: true,
          usable: false,
          expiresAt: null,
          validUntil: null,
          source: "cache",
          locked: true,
          lockReason: "revoked",
        },
      },
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Licença bloqueada: criar, editar, pausar");
  });

  it("scopes each provider modal to its own connections and keeps removal in the student provider flow", async () => {
    mockWave7IntegrationsFetch({
      canManage: true,
      extraResponses: {
        "/integrations/whatsapp-connections": [
          {
            id: "connection_waha",
            name: "WAHA Comercial",
            displayName: null,
            provider: "waha",
            status: "active",
            lastHealthStatus: null,
            lastHealthCheckedAt: null,
            createdAt: "2026-07-02T03:00:00.000Z",
          },
        ],
      },
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain('data-integration="waha" data-state="active"');
    expect(html).toContain("WAHA Comercial");
    // Removing a number is the provider "Excluir" flow, never package billing.
    expect(html).toContain("Excluir");
    expect(html).not.toContain("/billing/package");
    expect(html).not.toContain("Remover QR");
    // Scoped modals: the provider is fixed per card, no provider picker.
    expect(html).toContain('name="provider" value="uazapi_byo"');
    // WAHA is "Em breve": existing connection manageable, no create form.
    expect(html).not.toContain('name="provider" value="waha"');
    expect(html).toContain("Novas conexões deste provedor estão em breve");
    expect(html).not.toContain("<span class=\"field-label\">Provedor</span>");
  });

  it("opens the Kommo modal from ?abrir=kommo on the server render", async () => {
    mockWave7IntegrationsFetch({
      canManage: true,
      extraResponses: {
        "/auth/me": { user: { id: "user_owner" } },
        "/workspaces/workspace_current/kommo/connections": [],
      },
    });

    const element = await IntegrationsPage({
      searchParams: Promise.resolve({ abrir: "kommo" }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toMatch(
      /<div class="app-modal-layer" data-state="open"><div class="app-modal-backdrop"[^>]*><\/div><div class="app-modal app-modal-wide"[^>]*id="integration-modal-kommo"/,
    );
    expect(html).toMatch(/id="integrations-tab-crm"[^>]*aria-selected="true"/);
  });

  it("shows members only the owner-only note in the Kommo modal", async () => {
    mockWave7IntegrationsFetch({
      canManage: false,
      extraResponses: { "/auth/me": { user: { id: "user_member" } } },
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Somente o dono da conta conecta CRMs");
    expect(html).not.toContain('data-testid="kommo-crm-manager"');
    expect(html).not.toContain("0 conexão(ões)");
  });

  it("keeps inbound cards and warns on both tabs when the inbound API fails", async () => {
    mockWave7IntegrationsFetch({
      canManage: true,
      extraResponses: {},
    });
    const original = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/integrations/inbound-webhooks/capabilities") {
        return jsonResponse({ message: "unavailable" }, 503);
      }
      return original(input, init);
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    for (const id of ["umbler", "gupshup", "meta_cloud", "data_crazy"]) {
      expect(html).toContain(`data-integration="${id}" data-state="available"`);
    }
    expect(html).toContain("Não foi possível verificar");
    const banners = html.match(/Algumas conexões não carregaram/g) ?? [];
    expect(banners).toHaveLength(2);
  });

  it("disables WhatsApp and webhook write controls while the license is locked", async () => {
    const lockedStatus = {
      status: "blocked",
      softLock: true,
      hardLock: true,
      usable: false,
      expiresAt: null,
      validUntil: null,
      source: "cache",
      locked: true,
      lockReason: "revoked",
    };
    mockWave7IntegrationsFetch({
      canManage: true,
      extraResponses: {
        "/license-client/status": lockedStatus,
        "/integrations/whatsapp-connections": [
          {
            id: "connection_waha",
            name: "WAHA Comercial",
            displayName: null,
            provider: "waha",
            status: "active",
            lastHealthStatus: null,
            lastHealthCheckedAt: null,
            createdAt: "2026-07-02T03:00:00.000Z",
          },
        ],
      },
    });

    const locked = renderToStaticMarkup(
      createElement("div", null, await IntegrationsPage({})),
    );

    expect(locked).toContain(
      "Licença bloqueada: criar, testar, editar e excluir conexões está",
    );
    expect(locked).toContain(
      "Licença bloqueada: criar, alterar e remover conexões está",
    );
    expect(locked.match(/<fieldset class="license-lock-scope" disabled=""/g)?.length)
      .toBeGreaterThanOrEqual(3);
    expect(locked).toContain("Excluir");

    vi.restoreAllMocks();
    mockWave7IntegrationsFetch({ canManage: true });
    const unlocked = renderToStaticMarkup(
      createElement("div", null, await IntegrationsPage({})),
    );
    expect(unlocked).not.toContain('class="license-lock-scope" disabled=""');
    expect(unlocked).not.toContain("Licença bloqueada: criar, testar");
  });

  it("shows WAHA, Z-API and NOD API as 'Em breve' without a modal, but keeps existing connections manageable", async () => {
    mockWave7IntegrationsFetch({ canManage: true });
    const none = renderToStaticMarkup(
      createElement("div", null, await IntegrationsPage({})),
    );

    for (const id of ["waha", "zapi", "nod_api"]) {
      expect(none).toContain(
        `data-integration="${id}" data-state="available" data-coming-soon="true"`,
      );
      expect(none).not.toContain(`id="integration-modal-${id}"`);
    }
    expect(none).toContain("Z-API: em breve");
    // Cloud API is the only Meta WhatsApp card; Meta Ads is its own tab.
    expect((none.match(/data-integration="meta_cloud"/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(none).toContain('src="/integrations/meta.svg"');
    expect(none).not.toContain("meta-cloud.svg");

    vi.restoreAllMocks();
    mockWave7IntegrationsFetch({
      canManage: true,
      extraResponses: {
        "/integrations/whatsapp-connections": [
          {
            id: "connection_zapi",
            name: "Z-API Antiga",
            displayName: null,
            provider: "zapi",
            status: "active",
            lastHealthStatus: null,
            lastHealthCheckedAt: null,
            createdAt: "2026-07-02T03:00:00.000Z",
          },
        ],
      },
    });
    const existing = renderToStaticMarkup(
      createElement("div", null, await IntegrationsPage({})),
    );

    expect(existing).toContain('data-integration="zapi" data-state="active"');
    expect(existing).not.toContain('data-integration="zapi" data-state="active" data-coming-soon');
    expect(existing).toContain('id="integration-modal-zapi"');
    expect(existing).toContain("Z-API Antiga");
    expect(existing).toContain("Novas conexões deste provedor estão em breve");
    expect(existing).toContain("Excluir");
    expect(existing).not.toContain('name="provider" value="zapi"');
  });

  it("shows a generic inbound detail error without payload or secret data", async () => {
    mockWave7IntegrationsFetch({
      canManage: true,
      failInboundDetails: true,
    });

    const element = await IntegrationsPage({});
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain(
      "Parte dos dados desta conexao esta temporariamente indisponivel.",
    );
    expect(html).toContain("Umbler Workspace Atual");
    expect(html).not.toContain("umbler-token-ultra-secreto");
    expect(html).not.toContain("raw-payload");
    expect(html).not.toContain("+5511977771111");
    expect(html).not.toContain("secret=");
  });
});

function mockWave7IntegrationsFetch({
  canManage,
  failMetaCapabilities = false,
  failInboundDetails = false,
  extraResponses = {},
}: {
  canManage: boolean;
  failMetaCapabilities?: boolean;
  failInboundDetails?: boolean;
  extraResponses?: Record<string, unknown>;
}) {
  const requestedPaths: string[] = [];
  const responses: Record<string, unknown> = {
    "/integrations/health": {
      checkedAt: "2026-07-17T20:00:00.000Z",
      providers: [],
    },
    "/integrations/whatsapp/instances": [],
    "/integrations/meta/connection": {
      workspaceId: "workspace_current",
      status: "not_connected",
      tokenType: null,
      scopes: [],
      expiresAt: null,
      connectedAt: null,
      selectedBusinessId: null,
      selectedAdAccountId: null,
      selectedPixelId: null,
      capiTokenConfigured: false,
    },
    "/integrations/meta/assets": {
      workspaceId: "workspace_current",
      status: "not_connected",
      businesses: [],
      adAccounts: [],
      pixels: [],
      pages: [],
      reportingAccounts: [],
      selection: {
        businessId: null,
        adAccountId: null,
        pixelId: null,
      },
      lastSyncedAt: null,
      syncError: null,
    },
    "/billing/whatsapp-instance/quote": {
      workspaceId: "workspace_current",
      activeInstances: 0,
      pricePerInstanceCents: 9900,
      nextInstanceAmountCents: 9900,
      currency: "BRL",
    },
    "/billing/subscription": {
      workspaceId: "workspace_current",
      status: "active",
      planName: "Por instancia",
      activeInstances: 0,
      pricePerWhatsappInstanceCents: 9900,
      monthlyAmountCents: 0,
      currentPeriodEnd: null,
      asaasSubscriptionId: null,
    },
    "/integrations/pipeline": {
      workspaceId: "workspace_current",
      rangeLabel: "Ultimos 7 dias",
      stages: [],
    },
    "/workspaces/current": {
      id: "workspace_current",
      name: "Workspace Atual",
      slug: "workspace-atual",
      role: canManage ? "owner" : "member",
      permissions: {
        canInviteMembers: canManage,
        canManageBilling: canManage,
        canManageIntegrations: canManage,
        canViewReports: true,
      },
    },
    "/integrations/meta/capabilities": {
      enabledModes: ["manual"],
      oauthEnabled: false,
      manualEnabled: true,
    },
    "/integrations/meta/manual": wave7MetaConfiguration,
    "/integrations/inbound-webhooks/capabilities": {
      enabled: true,
      providers: [
        {
          provider: "umbler",
          parserVersion: "umbler/v1",
          parserReleaseStatus: "observation_only",
          creationEnabled: true,
        },
      ],
    },
    "/integrations/inbound-webhooks": [wave7Connection],
    "/conversion-rules/providers": [],
    "/integrations/inbound-webhooks/connection_wave7/overview": {
      connection: wave7Connection,
      counters: {
        eligibleRouted: 9,
        eligibleUnresolved: 4,
        ignoredNoCtwa: 7,
        duplicate: 2,
        invalid: 1,
      },
    },
    "/integrations/inbound-webhooks/connection_wave7/channels": [wave7Channel],
    ...extraResponses,
  };

  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      requestedPaths.push(path);

      if (
        failInboundDetails &&
        path === "/integrations/inbound-webhooks/connection_wave7/overview"
      ) {
        return jsonResponse(
          { message: "secret=umbler-token-ultra-secreto" },
          500,
        );
      }

      if (
        failInboundDetails &&
        path === "/integrations/inbound-webhooks/connection_wave7/channels"
      ) {
        return jsonResponse(
          {
            message:
              "raw-payload={phone:+5511977771111,content:mensagem privada}",
          },
          500,
        );
      }

      if (failMetaCapabilities && path === "/integrations/meta/capabilities") {
        return jsonResponse({ message: "unavailable" }, 503);
      }

      if (!(path in responses)) {
        return jsonResponse({ message: `Unhandled test URL: ${path}` }, 404);
      }

      return jsonResponse(responses[path]);
    });

  return { fetchMock, requestedPaths };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const wave7Connection = {
  id: "connection_wave7",
  workspaceId: "workspace_current",
  provider: "umbler",
  displayName: "Umbler Workspace Atual",
  parserVersion: "umbler/v1",
  parserReleaseStatus: "observation_only",
  status: "observation",
  lastDeliveryAt: "2026-07-17T20:00:00.000Z",
  lastSuccessfulParseAt: "2026-07-17T19:59:00.000Z",
  createdAt: "2026-07-17T18:00:00.000Z",
  updatedAt: "2026-07-17T20:00:00.000Z",
};

const wave7Channel = {
  id: "channel_wave7",
  connectionId: "connection_wave7",
  organizationId: "organization_wave7",
  providerChannelId: "umbler_channel_wave7",
  connectedPhone: "+5511988880000",
  channelName: "Canal Workspace Atual",
  status: "active",
  firstSeenAt: "2026-07-17T18:30:00.000Z",
  lastSeenAt: "2026-07-17T19:58:00.000Z",
  routes: [
    {
      id: "route_wave7_sales",
      channelId: "channel_wave7",
      metaBusinessConnectionId: "business_connection_wave7_sales",
      metaReportingAccountId: "reporting_wave7_sales",
      metaConversionDestinationId: "destination_wave7_sales",
      active: true,
      validationStatus: "valid",
      validationErrorCode: null,
      lastValidatedAt: "2026-07-17T19:50:00.000Z",
      createdAt: "2026-07-17T19:00:00.000Z",
      updatedAt: "2026-07-17T19:50:00.000Z",
    },
    {
      id: "route_wave7_support",
      channelId: "channel_wave7",
      metaBusinessConnectionId: "business_connection_wave7_support",
      metaReportingAccountId: "reporting_wave7_support",
      metaConversionDestinationId: "destination_wave7_support",
      active: true,
      validationStatus: "valid",
      validationErrorCode: null,
      lastValidatedAt: "2026-07-17T19:50:00.000Z",
      createdAt: "2026-07-17T19:00:00.000Z",
      updatedAt: "2026-07-17T19:50:00.000Z",
    },
  ],
  readiness: {
    state: "partial",
    blockers: ["ctwa_unresolved"],
    routeCount: 2,
    validRouteCount: 2,
    totalCtwa: 13,
    routedCtwa: 9,
    unresolvedCtwa: 4,
    retainedCtwa: 13,
    retainedRoutedCtwa: 9,
    payloadUnavailableCtwa: 0,
    alreadyMaterializedCtwa: 0,
    nextPayloadExpiresAt: "2026-07-20T19:58:00.000Z",
  },
  createdAt: "2026-07-17T18:30:00.000Z",
  updatedAt: "2026-07-17T19:58:00.000Z",
};

const wave7MetaConfiguration = {
  workspaceId: "workspace_current",
  connectionMode: "manual",
  advancedRoutingEnabled: false,
  unmappedActiveAccountCount: 0,
  credentials: [
    {
      id: "credential_wave7",
      workspaceId: "workspace_current",
      source: "manual",
      label: "Token Workspace Atual",
      fingerprint: "1234567890abcdef",
      tokenLast4: "cret",
      tokenType: "system_user",
      scopes: ["ads_read", "ads_management"],
      expiresAt: null,
      status: "active",
      lastValidatedAt: "2026-07-17T19:00:00.000Z",
      validationError: null,
      rotatedAt: null,
      createdAt: "2026-07-17T18:00:00.000Z",
      updatedAt: "2026-07-17T19:00:00.000Z",
    },
  ],
  businessConnections: [
    {
      id: "business_connection_wave7_sales",
      workspaceId: "workspace_current",
      credentialId: "credential_wave7",
      businessManagerId: "bm_wave7_sales",
      businessManagerName: "BM Vendas Workspace Atual",
      status: "active",
      defaultConversionDestinationId: "destination_wave7_sales",
      reportingAccountCount: 1,
      activeReportingAccountCount: 1,
      lastValidatedAt: "2026-07-17T19:00:00.000Z",
      validationError: null,
      lastSyncedAt: "2026-07-17T19:00:00.000Z",
      createdAt: "2026-07-17T18:00:00.000Z",
      updatedAt: "2026-07-17T19:00:00.000Z",
    },
    {
      id: "business_connection_wave7_support",
      workspaceId: "workspace_current",
      credentialId: "credential_wave7",
      businessManagerId: "bm_wave7_support",
      businessManagerName: "BM Suporte Workspace Atual",
      status: "active",
      defaultConversionDestinationId: "destination_wave7_support",
      reportingAccountCount: 1,
      activeReportingAccountCount: 1,
      lastValidatedAt: "2026-07-17T19:00:00.000Z",
      validationError: null,
      lastSyncedAt: "2026-07-17T19:00:00.000Z",
      createdAt: "2026-07-17T18:00:00.000Z",
      updatedAt: "2026-07-17T19:00:00.000Z",
    },
  ],
  destinations: [
    {
      id: "destination_wave7_sales",
      workspaceId: "workspace_current",
      label: "Pixel e Pagina Vendas Workspace Atual",
      ownerBusinessManagerId: "bm_wave7_sales",
      pixelId: "pixel_wave7_sales",
      pixelName: "Pixel Vendas Workspace Atual",
      pageId: "page_wave7_sales",
      pageName: "Pagina Vendas Workspace Atual",
      status: "configured",
      lastValidatedAt: "2026-07-17T19:00:00.000Z",
      validationError: null,
    },
    {
      id: "destination_wave7_support",
      workspaceId: "workspace_current",
      label: "Pixel e Pagina Suporte Workspace Atual",
      ownerBusinessManagerId: "bm_wave7_support",
      pixelId: "pixel_wave7_support",
      pixelName: "Pixel Suporte Workspace Atual",
      pageId: "page_wave7_support",
      pageName: "Pagina Suporte Workspace Atual",
      status: "configured",
      lastValidatedAt: "2026-07-17T19:00:00.000Z",
      validationError: null,
    },
  ],
  reportingAccounts: [
    {
      id: "reporting_wave7_sales",
      workspaceId: "workspace_current",
      businessId: "bm_wave7_sales",
      businessName: "BM Vendas Workspace Atual",
      adAccountId: "act_wave7_sales",
      adAccountName: "Conta Vendas Workspace Atual",
      currency: "BRL",
      timezoneName: "America/Sao_Paulo",
      businessConnectionId: "business_connection_wave7_sales",
      conversionDestinationId: "destination_wave7_sales",
      conversionDestinationIds: ["destination_wave7_sales"],
      active: true,
      syncStatus: "synced",
      lastSyncedAt: "2026-07-17T19:00:00.000Z",
      lastSyncSince: null,
      lastSyncUntil: null,
      syncError: null,
    },
    {
      id: "reporting_wave7_support",
      workspaceId: "workspace_current",
      businessId: "bm_wave7_support",
      businessName: "BM Suporte Workspace Atual",
      adAccountId: "act_wave7_support",
      adAccountName: "Conta Suporte Workspace Atual",
      currency: "BRL",
      timezoneName: "America/Sao_Paulo",
      businessConnectionId: "business_connection_wave7_support",
      conversionDestinationId: "destination_wave7_support",
      conversionDestinationIds: ["destination_wave7_support"],
      active: true,
      syncStatus: "synced",
      lastSyncedAt: "2026-07-17T19:00:00.000Z",
      lastSyncSince: null,
      lastSyncUntil: null,
      syncError: null,
    },
  ],
};

function paytRuleFixture(id: string, active: boolean) {
  return providerRule({
    id,
    name: `Venda ${id}`,
    triggerType: "provider_automation",
    origin: "automation_payt",
    eventName: "Purchase",
    connectionId: "connection_wave7",
    scope: "all_numbers",
    active,
    phrases: [],
    automationSource: "payt",
  });
}
