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
  createInboundWebhookChannelAction,
  createInboundWebhookConnectionAction,
  removeInboundWebhookChannelRouteAction,
  removeInboundWebhookConnectionAction,
  rotateInboundWebhookSecretAction,
  saveInboundWebhookChannelRoutesAction,
  setInboundWebhookChannelStatusAction,
  setInboundWebhookConnectionStatusAction,
} from "../src/app/(app)/integrations/inbound-webhook-actions";

const firstSecret = "a".repeat(43);
const rotatedSecret = "b".repeat(43);

const connection = {
  id: "connection_1",
  workspaceId: "workspace_1",
  provider: "umbler",
  displayName: "Umbler Comercial",
  parserVersion: "umbler/v1",
  parserReleaseStatus: "observation_only",
  status: "observation",
  productionActivatedAt: null,
  lastDeliveryAt: null,
  lastSuccessfulParseAt: null,
  createdAt: "2026-07-17T18:00:00.000Z",
  updatedAt: "2026-07-17T18:00:00.000Z",
} as const;

afterEach(() => {
  revalidatePath.mockReset();
  serverApiFetch.mockReset();
});

describe("inbound webhook server actions", () => {
  it("returns the allowlisted channel route denial without exposing arbitrary API errors", async () => {
    serverApiFetch.mockRejectedValueOnce(
      new Error("Configure uma rota Meta valida antes de ativar o canal"),
    );
    expect(
      await setInboundWebhookChannelStatusAction(
        form({ channelId: "channel_1", status: "active" }),
      ),
    ).toEqual({
      ok: false,
      message: "Configure uma rota Meta valida antes de ativar o canal",
    });
    serverApiFetch.mockRejectedValueOnce(new Error("synthetic-private-detail"));
    expect(
      await setInboundWebhookChannelStatusAction(
        form({ channelId: "channel_1", status: "active" }),
      ),
    ).toEqual({
      ok: false,
      message: "Nao foi possivel alterar o status deste canal.",
    });
  });
  it("creates an Umbler connection and returns the credential only as an ephemeral result", async () => {
    const webhookUrl = `https://api.wpptrack.test/webhooks/inbound/connection_1?token=${firstSecret}`;
    serverApiFetch.mockResolvedValueOnce({
      connection,
      secret: firstSecret,
      webhookUrl,
    });
    const formData = form({
      provider: "umbler",
      displayName: "  Umbler Comercial  ",
    });

    const result = await createInboundWebhookConnectionAction(formData);

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/inbound-webhooks",
      {
        method: "POST",
        body: JSON.stringify({
          provider: "umbler",
          displayName: "Umbler Comercial",
        }),
      },
    );
    expect(result).toEqual({
      ok: true,
      message:
        "Conexao de webhook criada. Copie a URL agora; ela nao sera exibida novamente.",
      oneTimeSecret: {
        connectionId: "connection_1",
        provider: "umbler",
        webhookUrl,
      },
    });
    expect(result).not.toHaveProperty("connection");
    expect(result.message).not.toContain(firstSecret);
    expect(serverApiFetch.mock.calls[0]?.[0]).not.toContain(firstSecret);
    expect(serverApiFetch.mock.calls[0]?.[1]?.body).not.toContain(firstSecret);
    expect(revalidatePath).toHaveBeenCalledWith("/integrations");
  });

  it("returns Meta Cloud's raw verify token only in the one-time result", async () => {
    const metaConnection = {
      ...connection,
      provider: "meta_cloud" as const,
      displayName: "Meta Comercial",
    };
    const webhookUrl =
      "https://api.wpptrack.test/webhooks/inbound/connection_meta_1";
    serverApiFetch.mockResolvedValueOnce({
      connection: { ...metaConnection, id: "connection_meta_1" },
      secret: firstSecret,
      webhookUrl,
    });

    const result = await createInboundWebhookConnectionAction(
      form({ provider: "meta_cloud", displayName: "Meta Comercial" }),
    );

    expect(result).toEqual({
      ok: true,
      message:
        "Conexao de webhook criada. Copie a URL agora; ela nao sera exibida novamente.",
      oneTimeSecret: {
        connectionId: "connection_meta_1",
        provider: "meta_cloud",
        webhookUrl,
        verifyToken: firstSecret,
      },
    });
    expect(webhookUrl).not.toContain("token=");
    expect(result.message).not.toContain(firstSecret);
  });

  it("rotates the secret without sending it in the request path or body", async () => {
    const webhookUrl = `https://api.wpptrack.test/webhooks/inbound/connection_1?token=${rotatedSecret}`;
    serverApiFetch.mockResolvedValueOnce({
      connectionId: "connection_1",
      provider: "umbler",
      secret: rotatedSecret,
      webhookUrl,
      rotatedAt: "2026-07-17T19:00:00.000Z",
    });

    const result = await rotateInboundWebhookSecretAction(
      form({ connectionId: "connection_1" }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/inbound-webhooks/connection_1/rotate-secret",
      { method: "POST", body: "{}" },
    );
    expect(result).toEqual({
      ok: true,
      message:
        "Segredo rotacionado. Copie a nova URL agora; ela nao sera exibida novamente.",
      oneTimeSecret: {
        connectionId: "connection_1",
        provider: "umbler",
        webhookUrl,
      },
    });
    expect(result.message).not.toContain(rotatedSecret);
    expect(serverApiFetch.mock.calls[0]?.[0]).not.toContain(rotatedSecret);
    expect(serverApiFetch.mock.calls[0]?.[1]?.body).not.toContain(
      rotatedSecret,
    );
    expect(revalidatePath).toHaveBeenCalledWith("/integrations");
  });

  it.each([
    ["paused", "Conexao pausada. Novas entregas nao serao processadas."],
    ["observation", "Conexao mantida em modo de observacao."],
    ["production", "Envio automatico ativado nos canais habilitados."],
  ] as const)(
    "updates the connection status to %s",
    async (status, message) => {
      serverApiFetch.mockResolvedValueOnce({ ...connection, status });

      const result = await setInboundWebhookConnectionStatusAction(
        form({ connectionId: "connection_1", status }),
      );

      expect(serverApiFetch).toHaveBeenCalledWith(
        "/integrations/inbound-webhooks/connection_1/status",
        {
          method: "PUT",
          body: JSON.stringify({ status }),
        },
      );
      expect(result).toEqual({ ok: true, message });
      expect(revalidatePath).toHaveBeenCalledWith("/integrations");
    },
  );

  it("returns a safe production-readiness reason when activation is blocked", async () => {
    serverApiFetch.mockRejectedValueOnce(
      new Error("Finalize o replay em andamento antes de ativar a producao"),
    );

    const result = await setInboundWebhookConnectionStatusAction(
      form({ connectionId: "connection_1", status: "production" }),
    );

    expect(result).toEqual({
      ok: false,
      message: "Finalize o replay em andamento antes de ativar a producao",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("removes a connection through the tenant-scoped endpoint", async () => {
    serverApiFetch.mockResolvedValueOnce(undefined);

    const result = await removeInboundWebhookConnectionAction(
      form({ connectionId: "connection_1" }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/inbound-webhooks/connection_1",
      { method: "DELETE" },
    );
    expect(result).toEqual({
      ok: true,
      message: "Conexao removida. O historico de observacao foi preservado.",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/integrations");
  });

  it("registers a provisional channel before any webhook has arrived (P0.2)", async () => {
    serverApiFetch.mockResolvedValueOnce({
      id: "channel_provisional",
      connectionId: "connection_1",
      organizationId: "provisional:connection_1",
      providerChannelId: "provisional:5511999998888",
      connectedPhone: "5511999998888",
      channelName: "Comercial",
      status: "discovered",
    });

    const result = await createInboundWebhookChannelAction(
      form({
        connectionId: "connection_1",
        connectedPhone: "(11) 99999-8888",
        channelName: "Comercial",
      }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/inbound-webhooks/connection_1/channels",
      {
        method: "POST",
        body: JSON.stringify({
          connectedPhone: "(11) 99999-8888",
          channelName: "Comercial",
        }),
      },
    );
    expect(result).toEqual({
      ok: true,
      message:
        "Canal cadastrado. Ja e possivel criar regras de conversao para ele antes de qualquer mensagem chegar.",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/integrations");
  });

  it("rejects an invalid phone number before calling the API", async () => {
    const result = await createInboundWebhookChannelAction(
      form({ connectionId: "connection_1", connectedPhone: "abc" }),
    );

    expect(serverApiFetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("reports failure when the channel cannot be created", async () => {
    serverApiFetch.mockRejectedValueOnce(new Error("boom"));

    const result = await createInboundWebhookChannelAction(
      form({ connectionId: "connection_1", connectedPhone: "11999998888" }),
    );

    expect(result).toEqual({
      ok: false,
      message: "Nao foi possivel cadastrar o canal.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [
      "active",
      "Canal habilitado para envio quando a conexao estiver em producao.",
    ],
    ["paused", "Canal pausado. Os demais canais continuam inalterados."],
  ] as const)("updates the channel status to %s", async (status, message) => {
    serverApiFetch.mockResolvedValueOnce({ status });

    const result = await setInboundWebhookChannelStatusAction(
      form({ channelId: "channel/1", status }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/inbound-webhooks/channels/channel%2F1/status",
      {
        method: "PUT",
        body: JSON.stringify({ status }),
      },
    );
    expect(result).toEqual({ ok: true, message });
    expect(revalidatePath).toHaveBeenCalledWith("/integrations");
  });

  it("saves several validated routes for one channel", async () => {
    const routes = [
      {
        metaBusinessConnectionId: "business_connection_1",
        metaReportingAccountId: "reporting_account_1",
        metaConversionDestinationId: null,
      },
      {
        metaBusinessConnectionId: "business_connection_2",
        metaReportingAccountId: null,
        metaConversionDestinationId: "destination_2",
      },
    ];
    serverApiFetch.mockResolvedValueOnce({ routes: [] });

    const result = await saveInboundWebhookChannelRoutesAction(
      form({
        channelId: "channel_1",
        routes: JSON.stringify(routes),
      }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/inbound-webhooks/channels/channel_1/routes",
      {
        method: "PUT",
        body: JSON.stringify({ routes }),
      },
    );
    expect(result).toEqual({
      ok: true,
      message: "Rotas do canal salvas e validadas.",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/integrations");
  });

  it("removes one exact channel route", async () => {
    serverApiFetch.mockResolvedValueOnce(undefined);

    const result = await removeInboundWebhookChannelRouteAction(
      form({ channelId: "channel_1", routeId: "route/1" }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/inbound-webhooks/channels/channel_1/routes/route%2F1",
      { method: "DELETE" },
    );
    expect(result).toEqual({
      ok: true,
      message: "Rota removida do canal.",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/integrations");
  });

  it.each([
    [
      "create",
      () =>
        createInboundWebhookConnectionAction(
          form({ provider: "other", displayName: "Umbler Comercial" }),
        ),
    ],
    [
      "rotate",
      () => rotateInboundWebhookSecretAction(form({ connectionId: "" })),
    ],
    [
      "connection status",
      () =>
        setInboundWebhookConnectionStatusAction(
          form({ connectionId: "connection_1", status: "removed" }),
        ),
    ],
    [
      "remove connection",
      () => removeInboundWebhookConnectionAction(form({ connectionId: "" })),
    ],
    [
      "channel status",
      () =>
        setInboundWebhookChannelStatusAction(
          form({ channelId: "channel_1", status: "discovered" }),
        ),
    ],
    [
      "save routes",
      () =>
        saveInboundWebhookChannelRoutesAction(
          form({ channelId: "channel_1", routes: "{raw-payload" }),
        ),
    ],
    [
      "remove route",
      () =>
        removeInboundWebhookChannelRouteAction(
          form({ channelId: "channel_1", routeId: "" }),
        ),
    ],
  ])(
    "rejects invalid FormData for %s before calling the API",
    async (_, run) => {
      const result = await run();

      expect(result).toMatchObject({ ok: false });
      expect(result.message).not.toContain("raw-payload");
      expect(serverApiFetch).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "create",
      () =>
        createInboundWebhookConnectionAction(
          form({ provider: "umbler", displayName: "Umbler Comercial" }),
        ),
    ],
    [
      "rotate",
      () =>
        rotateInboundWebhookSecretAction(
          form({ connectionId: "connection_1" }),
        ),
    ],
    [
      "connection status",
      () =>
        setInboundWebhookConnectionStatusAction(
          form({ connectionId: "connection_1", status: "paused" }),
        ),
    ],
    [
      "remove connection",
      () =>
        removeInboundWebhookConnectionAction(
          form({ connectionId: "connection_1" }),
        ),
    ],
    [
      "channel status",
      () =>
        setInboundWebhookChannelStatusAction(
          form({ channelId: "channel_1", status: "active" }),
        ),
    ],
    [
      "save routes",
      () =>
        saveInboundWebhookChannelRoutesAction(
          form({ channelId: "channel_1", routes: "[]" }),
        ),
    ],
    [
      "remove route",
      () =>
        removeInboundWebhookChannelRouteAction(
          form({ channelId: "channel_1", routeId: "route_1" }),
        ),
    ],
  ])("sanitizes API errors for %s", async (_, run) => {
    const sensitive =
      "secret=super-secret-value raw-payload={phone:+5511999999999}";
    serverApiFetch.mockRejectedValueOnce(new Error(sensitive));

    const result = await run();

    expect(result).toMatchObject({ ok: false });
    expect(result).not.toHaveProperty("oneTimeSecret");
    expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    expect(JSON.stringify(result)).not.toContain("+5511999999999");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("shows the license lock message when the API answers 423", async () => {
    const { LicenseLockedError } = await import("../src/lib/server-api");
    serverApiFetch.mockRejectedValueOnce(
      new LicenseLockedError("bloqueada", "revoked"),
    );

    const result = await createInboundWebhookConnectionAction(
      form({ provider: "umbler", displayName: "Comercial" }),
    );

    expect(result).toEqual({
      ok: false,
      message:
        "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does not forward an invalid secret-bearing API response", async () => {
    serverApiFetch.mockResolvedValueOnce({
      connection,
      secret: "short",
      webhookUrl:
        "https://api.wpptrack.test/webhooks/inbound/connection_1?token=payload-secret",
      payload: "raw-payload-must-not-leak",
    });

    const result = await createInboundWebhookConnectionAction(
      form({ provider: "umbler", displayName: "Umbler Comercial" }),
    );

    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("payload-secret");
    expect(JSON.stringify(result)).not.toContain("raw-payload-must-not-leak");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

function form(values: Record<string, string>): FormData {
  const formData = new FormData();

  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }

  return formData;
}
