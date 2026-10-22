import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConversionsPage from "../src/app/(app)/conversions/page";
import {
  capabilities as capabilitiesFixture,
  channelDto,
  connections,
  numbers,
  providerRule,
} from "./conversions-fixtures";

vi.mock("next/navigation", () => ({
  redirect: () => undefined,
  useRouter: () => ({ refresh: () => undefined }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const api = "http://localhost:3333";

type Options = {
  role?: "owner" | "admin";
  capabilities?: "missing" | "ok";
  rules?: unknown[] | "disabled";
  unifyGroups?: unknown[];
  /** GET /conversion-rules/legacy. */
  legacy?: unknown[] | "error";
  licenseLocked?: boolean;
  /** GET /integrations/whatsapp-connections (WAHA, Z-API, NOD API...). */
  whatsapp?: unknown[];
  kommo?: unknown[];
};

const rules = [
  providerRule({
    id: "global",
    name: "Qualificado (todos)",
    origin: "message_phrase",
    scope: "all_numbers",
    effective: ["ch_01"],
    overridden: ["ch_02"],
    mode: "production",
  }),
  providerRule({
    id: "specific",
    name: "Qualificado Atendimento",
    origin: "message_phrase",
    connectionId: "conn_qr_a",
    channelIds: ["ch_02"],
  }),
];

const unifyGroup = {
  key: "group_1",
  origin: "message_phrase",
  eventName: "InitiateCheckout",
  mode: "observation",
  name: "Checkout iniciado",
  triggerPhrases: ["segue o link"],
  ruleIds: ["r1", "r2"],
  channelIds: ["ch_01", "ch_02"],
  newlyCoveredChannelIds: ["ch_03"],
  overriddenChannelIds: [],
  duplicatePhoneChannelIds: [],
  existingGlobalRuleId: null,
};

function mockApi(options: Options = {}) {
  const role = options.role ?? "owner";

  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const path = url.startsWith(api) ? url.slice(api.length) : url;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (path === "/workspaces/current") {
      return json({
        id: "workspace_1",
        name: "Loja",
        slug: "loja",
        role,
        accessMode: "member",
        platformRole: null,
        permissions: { canManageIntegrations: true, canViewReports: true },
      });
    }
    if (path === "/license-client/status") {
      return json({
        status: options.licenseLocked ? "blocked" : "active",
        softLock: false,
        hardLock: Boolean(options.licenseLocked),
        usable: !options.licenseLocked,
        expiresAt: null,
        validUntil: null,
        source: "cache",
        locked: Boolean(options.licenseLocked),
        lockReason: options.licenseLocked ? "revoked" : null,
      });
    }
    if (path === "/conversion-rules/providers") {
      return options.rules === "disabled"
        ? json({ message: "Eventos de conversao por provedor ainda nao estao habilitados" }, 503)
        : json(options.rules ?? rules);
    }
    if (path === "/conversion-rules/legacy") {
      return options.legacy === "error"
        ? json({ message: "erro" }, 500)
        : json(options.legacy ?? []);
    }
    if (path === "/conversion-rules/providers/capabilities") {
      return options.capabilities === "missing"
        ? json({ message: "Cannot GET" }, 404)
        : json(capabilitiesFixture);
    }
    if (path === "/conversion-rules/providers/unify-candidates") {
      return json({ groups: options.unifyGroups ?? [unifyGroup] });
    }
    if (path === "/integrations/whatsapp-connections") {
      return json(options.whatsapp ?? []);
    }
    if (path === "/integrations/inbound-webhooks") {
      return json(
        connections.map((connection) => ({
          ...connection,
          workspaceId: "workspace_1",
          parserVersion: "v1",
          productionActivatedAt: null,
          lastDeliveryAt: null,
          lastSuccessfulParseAt: null,
          createdAt: "2026-10-01T12:00:00.000Z",
          updatedAt: "2026-10-01T12:00:00.000Z",
        })),
      );
    }
    const channels = path.match(/^\/integrations\/inbound-webhooks\/([^/]+)\/channels$/u);
    if (channels) {
      return json(
        numbers
          .filter((item) => item.connectionId === decodeURIComponent(channels[1]!))
          .map(channelDto),
      );
    }
    if (path === "/workspaces/workspace_1/kommo/connections") {
      return json(options.kommo ?? []);
    }

    return json({ message: `unexpected ${path}` }, 404);
  });
}

async function renderPage(search: { nova?: string } = {}) {
  return renderToStaticMarkup(
    await ConversionsPage({ searchParams: Promise.resolve(search) }),
  );
}

describe("Conversions route", () => {
  it("lists every rule with origin, scope, status and the override note", async () => {
    mockApi();

    const html = await renderPage();

    expect(html).toContain("<h1>Conversões</h1>");
    expect(html).toContain("Qualificado (todos)");
    expect(html).toContain("Todos os números");
    expect(html).toContain("Envio automático");
    expect(html).toContain("Substituída em Atendimento");
    expect(html).toContain("Vale no lugar da regra para todos os números em Atendimento.");
    // Filters: origin, number, event, status.
    for (const label of ["Origem", "Número", "Evento", "Status"]) {
      expect(html).toContain(`<span class="field-label">${label}</span>`);
    }
    expect(html).toContain("Recepção (Umbler Recepção)");
    expect(html).toContain("Revisar e unificar");
    expect(html).toContain("Nova regra");
    expect(html).not.toContain("Licença bloqueada");
  });

  it("manages every rule here: Gerenciar on each rule and the old rules listed", async () => {
    const legacy = {
      id: "legacy_1",
      workspaceId: "workspace_1",
      name: "Compra por aviso",
      triggerType: "keyword",
      triggerValue: "AVISO DE COMPRA",
      matchMode: "exact",
      eventName: "Purchase",
      pixelId: null,
      defaultValueCents: 9990,
      defaultCurrency: "BRL",
      defaultContentName: "Pedido médio",
      defaultItems: null,
      active: true,
      createdAt: "2026-10-01T12:00:00.000Z",
      updatedAt: "2026-10-01T12:00:00.000Z",
      kind: "legacy",
      adaptable: true,
      adaptBlockedReason: null,
    };
    mockApi({ legacy: [legacy] });

    const html = await renderPage();

    expect(html).toContain('aria-label="Gerenciar Qualificado (todos)"');
    expect(html).toContain('aria-label="Gerenciar Qualificado Atendimento"');
    expect(html).toContain("Regras antigas");
    expect(html).toContain("Compra por aviso");
    expect(html).toContain('aria-label="Conectar Compra por aviso aos números"');
    expect(html.match(/Qualificado Atendimento<\/strong>/g)).toHaveLength(1);
  });

  it("keeps the list when the old rules cannot be read", async () => {
    mockApi({ legacy: "error" });

    const html = await renderPage();

    expect(html).toContain("Qualificado Atendimento");
    expect(html).toContain("Não deu para ler as regras antigas agora");
  });

  it("does not offer Nova regra without the capabilities answer, but keeps the list", async () => {
    mockApi({ capabilities: "missing" });

    const html = await renderPage();

    expect(html).toContain("Não deu para confirmar quais origens de regra");
    expect(html).toContain("Qualificado Atendimento");
  });

  it("explains when provider rules are disabled and offers the first rule otherwise", async () => {
    mockApi({ rules: "disabled", unifyGroups: [] });
    const disabled = await renderPage();
    expect(disabled).toContain("Regras de conversão desligadas nesta instalação");

    vi.restoreAllMocks();
    mockApi({ rules: [], unifyGroups: [] });
    const empty = await renderPage();
    expect(empty).toContain("Nenhuma regra ainda");
    expect(empty).toContain("Criar a primeira regra");
  });

  it("shows the license lock and disables the write controls", async () => {
    mockApi({ licenseLocked: true });

    const html = await renderPage();

    expect(html).toContain("Licença bloqueada");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(<svg[^>]*>.*?<\/svg>)?\s*Nova regra/u);
    expect(html).not.toContain("Revisar e unificar");
  });

  it("lists Kommo rules read-only for the owner with a link to the hub", async () => {
    mockApi({
      kommo: [
        {
          id: "kommo_1",
          workspaceId: "workspace_1",
          displayName: "Kommo Comercial",
          status: "active",
          verifiedAccountId: null,
          accountSubdomain: null,
          accountOrigin: "https://loja.kommo.com",
          allowedChannelRouteIds: [],
          credentialHealthy: true,
          catalogState: "fresh",
          catalogRefreshedAt: null,
          lastErrorCode: null,
          createdAt: "2026-10-01T12:00:00.000Z",
          updatedAt: "2026-10-01T12:00:00.000Z",
          pipelines: [],
          rules: [
            {
              id: "kr_1",
              connectionId: "kommo_1",
              name: "Proposta enviada",
              pipelineId: "p1",
              statusId: "s1",
              eventName: "InitiateCheckout",
              mode: "observation",
              valueMode: "lead_price",
              fixedValueCents: null,
              currency: null,
              contentName: null,
              active: true,
              createdAt: "2026-10-01T12:00:00.000Z",
              updatedAt: "2026-10-01T12:00:00.000Z",
            },
          ],
        },
      ],
    });

    const html = await renderPage();

    expect(html).toContain("Proposta enviada");
    expect(html).toContain('href="/integrations?abrir=kommo"');
    expect(html).toContain("Gerenciar no Hub");
  });

  it("opens Nova regra from a deep link and says Kommo rules are owner-only for admins", async () => {
    const fetchMock = mockApi({ role: "admin" });

    const html = await renderPage({ nova: "message_phrase" });

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Etapas da nova regra");
    expect(html).toContain("aparecem só para o responsável da conta");
    // Owner-only data is not even requested for an admin.
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes("/kommo/")),
    ).toBe(false);
  });

  it("lists WAHA, Z-API and NOD API numbers as coming soon, not as choices", async () => {
    mockApi({
      whatsapp: [
        {
          id: "wc_1",
          name: "waha-loja",
          displayName: "WAHA Loja",
          provider: "waha",
          status: "active",
          lastHealthStatus: null,
          lastHealthCheckedAt: null,
          createdAt: "2026-10-01T12:00:00.000Z",
        },
      ],
    });

    const html = await renderPage();

    expect(html).toContain("WAHA Loja");
    expect(html).toContain("WAHA · Em breve");
    // Gupshup works through the provider webhook: never labelled "Em breve".
    expect(html).toContain("Gupshup · pelo webhook");
    expect(html).not.toContain("Gupshup · Em breve");
    expect(html).toContain("Conversões chegam pelo webhook do provedor");
  });
});
