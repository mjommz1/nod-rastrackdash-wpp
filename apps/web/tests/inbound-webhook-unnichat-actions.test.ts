import { afterEach, describe, expect, it, vi } from "vitest";

const { revalidatePath, serverApiFetch } = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  serverApiFetch: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/lib/server-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server-api")>()),
  serverApiFetch,
}));

import {
  createInboundWebhookConnectionAction,
  saveInboundWebhookChannelRoutesAction,
  setInboundWebhookChannelStatusAction,
} from "../src/app/(app)/integrations/inbound-webhook-actions";

const secret = "u".repeat(43);

const connection = {
  id: "connection_unnichat",
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
  updatedAt: "2026-10-15T18:00:00.000Z",
} as const;

afterEach(() => {
  revalidatePath.mockReset();
  serverApiFetch.mockReset();
});

function form(values: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }
  return formData;
}

describe("Unnichat connection creation", () => {
  it("sends the client's number and returns the URL only as a one-time result", async () => {
    const webhookUrl = `https://api.example.test/webhooks/inbound/connection_unnichat?token=${secret}`;
    serverApiFetch.mockResolvedValueOnce({ connection, secret, webhookUrl });

    const result = await createInboundWebhookConnectionAction(
      form({
        provider: "unnichat",
        displayName: "  Unnichat Loja  ",
        connectedPhone: " +55 11 99999-0001 ",
      }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/inbound-webhooks",
      {
        method: "POST",
        body: JSON.stringify({
          provider: "unnichat",
          displayName: "Unnichat Loja",
          connectedPhone: "+55 11 99999-0001",
        }),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      oneTimeSecret: {
        connectionId: "connection_unnichat",
        provider: "unnichat",
        webhookUrl,
      },
    });
    // Only Meta Cloud has a verify token.
    expect(result.oneTimeSecret).not.toHaveProperty("verifyToken");
    expect(revalidatePath).toHaveBeenCalledWith("/integrations");
  });

  it("does not call the API without the client's number and says what is missing", async () => {
    const result = await createInboundWebhookConnectionAction(
      form({ provider: "unnichat", displayName: "Unnichat Loja" }),
    );

    expect(serverApiFetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      message:
        "Informe o número de WhatsApp do cliente atendido pelo Unnichat, com DDI e DDD.",
    });
  });

  it("rejects a number with too few digits", async () => {
    const result = await createInboundWebhookConnectionAction(
      form({
        provider: "unnichat",
        displayName: "Unnichat Loja",
        connectedPhone: "123",
      }),
    );

    expect(serverApiFetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("never sends a number for the other providers", async () => {
    serverApiFetch.mockResolvedValueOnce({
      connection: { ...connection, provider: "umbler" },
      secret,
      webhookUrl: `https://api.example.test/webhooks/inbound/c?token=${secret}`,
    });

    await createInboundWebhookConnectionAction(
      form({
        provider: "umbler",
        displayName: "Umbler Comercial",
        connectedPhone: "+5511999990001",
      }),
    );

    expect(JSON.parse(serverApiFetch.mock.calls[0]![1].body)).toEqual({
      provider: "umbler",
      displayName: "Umbler Comercial",
    });
  });

  it("explains the unavailable observation version for Unnichat", async () => {
    serverApiFetch.mockRejectedValueOnce(
      new Error("Versao de observacao do provedor indisponivel"),
    );

    const result = await createInboundWebhookConnectionAction(
      form({
        provider: "unnichat",
        displayName: "Unnichat Loja",
        connectedPhone: "+5511999990001",
      }),
    );

    expect(result).toEqual({
      ok: false,
      message:
        "O Unnichat ainda não está liberado nesta instalação: rode as migrations da API e tente de novo.",
    });
  });

  it("shows the API's refusal about the number in accented Portuguese", async () => {
    serverApiFetch.mockRejectedValueOnce(
      new Error("Conexões Unnichat exigem o número de WhatsApp do cliente"),
    );

    const result = await createInboundWebhookConnectionAction(
      form({
        provider: "unnichat",
        displayName: "Unnichat Loja",
        connectedPhone: "+5511999990001",
      }),
    );

    expect(result).toEqual({
      ok: false,
      message: "Conexões Unnichat exigem o número de WhatsApp do cliente",
    });
  });

  it("does not forward arbitrary API errors", async () => {
    serverApiFetch.mockRejectedValueOnce(new Error("synthetic-private-detail"));

    const result = await createInboundWebhookConnectionAction(
      form({
        provider: "unnichat",
        displayName: "Unnichat Loja",
        connectedPhone: "+5511999990001",
      }),
    );

    expect(result.message).not.toContain("synthetic-private-detail");
    expect(result.ok).toBe(false);
  });

  it("shows the license lock message on 423 and creates nothing", async () => {
    const { LicenseLockedError } = await import("../src/lib/server-api");
    serverApiFetch.mockRejectedValueOnce(
      new LicenseLockedError("bloqueada", "revoked"),
    );

    const result = await createInboundWebhookConnectionAction(
      form({
        provider: "unnichat",
        displayName: "Unnichat Loja",
        connectedPhone: "+5511999990001",
      }),
    );

    expect(result).toEqual({
      ok: false,
      message:
        "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("Unnichat routing mode", () => {
  it("sends the inherit mode with no routes", async () => {
    serverApiFetch.mockResolvedValueOnce({});

    const result = await saveInboundWebhookChannelRoutesAction(
      form({
        channelId: "channel_1",
        routingMode: "inherit_workspace",
        routes: "[]",
      }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/inbound-webhooks/channels/channel_1/routes",
      {
        method: "PUT",
        body: JSON.stringify({ routes: [], routingMode: "inherit_workspace" }),
      },
    );
    expect(result.ok).toBe(true);
  });

  it("sends the override mode with its routes", async () => {
    serverApiFetch.mockResolvedValueOnce({});
    const routes = [
      {
        metaBusinessConnectionId: "bm_1",
        metaReportingAccountId: null,
        metaConversionDestinationId: null,
      },
    ];

    await saveInboundWebhookChannelRoutesAction(
      form({
        channelId: "channel_1",
        routingMode: "channel_override",
        routes: JSON.stringify(routes),
      }),
    );

    expect(JSON.parse(serverApiFetch.mock.calls[0]![1].body)).toEqual({
      routes,
      routingMode: "channel_override",
    });
  });

  it("refuses to send routes together with the inherit mode", async () => {
    const result = await saveInboundWebhookChannelRoutesAction(
      form({
        channelId: "channel_1",
        routingMode: "inherit_workspace",
        routes: JSON.stringify([{ metaBusinessConnectionId: "bm_1" }]),
      }),
    );

    expect(serverApiFetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("does not send a mode for the other providers", async () => {
    serverApiFetch.mockResolvedValueOnce({});

    await saveInboundWebhookChannelRoutesAction(
      form({ channelId: "channel_1", routes: "[]" }),
    );

    expect(JSON.parse(serverApiFetch.mock.calls[0]![1].body)).toEqual({
      routes: [],
    });
  });

  it.each([
    [
      "Modo de herança disponível apenas para Unnichat",
      "O modo “Herdar do workspace” existe só para números do Unnichat.",
    ],
    [
      "Informe o modo de roteamento (automático ou rotas manuais) deste canal",
      "Escolha o modo de roteamento deste número (Herdar do workspace ou Configurar neste número) e salve.",
    ],
    [
      "Herança não aceita rotas locais como override",
      "No modo “Herdar do workspace” o número não tem rotas próprias. Remova as rotas ou escolha “Configurar neste número”.",
    ],
  ])("explains the 409 %s", async (apiMessage, expected) => {
    serverApiFetch.mockRejectedValueOnce(new Error(apiMessage));

    const result = await saveInboundWebhookChannelRoutesAction(
      form({
        channelId: "channel_1",
        routingMode: "channel_override",
        routes: JSON.stringify([{ metaBusinessConnectionId: "bm_1" }]),
      }),
    );

    expect(result).toEqual({ ok: false, message: expected });
  });

  it("falls back to the generic message for an unknown error", async () => {
    serverApiFetch.mockRejectedValueOnce(new Error("synthetic-private-detail"));

    const result = await saveInboundWebhookChannelRoutesAction(
      form({ channelId: "channel_1", routingMode: "inherit_workspace", routes: "[]" }),
    );

    expect(result).toEqual({
      ok: false,
      message: "Nao foi possivel salvar as rotas deste canal.",
    });
  });

  it("shows the license lock message on 423 and saves nothing", async () => {
    const { LicenseLockedError } = await import("../src/lib/server-api");
    serverApiFetch.mockRejectedValueOnce(
      new LicenseLockedError("bloqueada", "revoked"),
    );

    const result = await saveInboundWebhookChannelRoutesAction(
      form({ channelId: "channel_1", routingMode: "inherit_workspace", routes: "[]" }),
    );

    expect(result.message).toContain("Licença bloqueada");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("passes the Unnichat refusal to activate a number without Meta set up", async () => {
    const message =
      "Configure a Meta deste número (página e pixel do workspace ou rotas próprias) antes de ativar o canal";
    serverApiFetch.mockRejectedValueOnce(new Error(message));

    const result = await setInboundWebhookChannelStatusAction(
      form({ channelId: "channel_1", status: "active" }),
    );

    expect(result).toEqual({ ok: false, message });
  });
});
