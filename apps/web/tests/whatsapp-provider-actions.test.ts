import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWhatsappConnectionAction,
  deleteWhatsappConnectionAction,
  loadWhatsappConnectionForEditAction,
  rotateWhatsappWebhookTokenAction,
  testWhatsappConnectionAction,
  updateWhatsappConnectionAction,
} from "../src/app/(app)/integrations/whatsapp-provider-actions";

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    toString: (): string => "wpptrack_session=test",
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
});

function form(values: Record<string, string>): FormData {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
}

describe("WhatsApp provider actions", () => {
  it("uses the API rotation contract and returns a one-time webhook URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          connection: {
            id: "connection_1",
            name: "WAHA comercial",
            displayName: null,
            provider: "waha",
            status: "active",
            lastHealthStatus: null,
            lastHealthCheckedAt: null,
            createdAt: "2026-08-28T12:00:00.000Z",
          },
          webhookEndpoint:
            "https://api.example.test/webhooks/whatsapp/connection_1",
          webhookToken: "a".repeat(43),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await rotateWhatsappWebhookTokenAction(
      form({ connectionId: "connection_1" }),
    );

    expect(result).toMatchObject({
      ok: true,
      receiverSecret: {
        webhookUrl:
          "https://api.example.test/webhooks/whatsapp/connection_1?token=" +
          "a".repeat(43),
      },
    });
    expect(result.receiverSecret?.webhookUrl).toContain("token=");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/integrations/whatsapp-connections/connection_1/rotate-webhook-token",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("preserves Testar and allows retry after a receiver error without leaking input secrets", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "receiver unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            connectionId: "connection_1",
            provider: "waha",
            status: "connected",
            checkedAt: "2026-08-28T12:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    const request = form({
      connectionId: "connection_1",
      apiKey: "do-not-return",
    });

    const failed = await testWhatsappConnectionAction(request);
    const retried = await testWhatsappConnectionAction(request);

    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain("do-not-return");
    expect(retried).toMatchObject({ ok: true, connectionId: "connection_1" });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3333/integrations/whatsapp-connections/connection_1/test",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("validates create input locally and never echoes provider credentials", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = await createWhatsappConnectionAction(
      form({
        provider: "waha",
        name: "WAHA",
        baseUrl: "ftp://waha.example.test",
        apiKey: "do-not-return",
      }),
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("do-not-return");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads non-sensitive editable metadata for a connection", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "connection_1",
          provider: "waha",
          name: "WAHA comercial",
          displayName: null,
          baseUrl: "https://waha.example.test",
          instanceId: null,
          session: "support",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await loadWhatsappConnectionForEditAction("connection_1");

    expect(result).toEqual({
      ok: true,
      data: {
        id: "connection_1",
        provider: "waha",
        name: "WAHA comercial",
        displayName: null,
        baseUrl: "https://waha.example.test",
        instanceId: null,
        session: "support",
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3333/integrations/whatsapp-connections/connection_1/edit",
      expect.anything(),
    );
  });

  it("fails closed when the edit metadata response does not match the requested connection", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "connection_other",
          provider: "waha",
          name: "Outra conexao",
          displayName: null,
          baseUrl: null,
          instanceId: null,
          session: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await loadWhatsappConnectionForEditAction("connection_1");

    expect(result.ok).toBe(false);
  });

  it("keeps the current secret when the edit form leaves it blank", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "connection_1",
          name: "WAHA comercial",
          displayName: null,
          provider: "waha",
          status: "active",
          lastHealthStatus: null,
          lastHealthCheckedAt: null,
          createdAt: "2026-08-28T12:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await updateWhatsappConnectionAction(
      form({
        connectionId: "connection_1",
        provider: "waha",
        name: "WAHA comercial",
        baseUrl: "https://waha.example.test",
        session: "support",
      }),
    );

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3333/integrations/whatsapp-connections/connection_1/edit",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          provider: "waha",
          name: "WAHA comercial",
          displayName: null,
          credentials: {
            baseUrl: "https://waha.example.test",
            session: "support",
          },
        }),
      }),
    );
  });

  it("replaces the secret when the edit form provides one and never echoes it back", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "connection_1",
          name: "WAHA comercial",
          displayName: null,
          provider: "waha",
          status: "active",
          lastHealthStatus: null,
          lastHealthCheckedAt: null,
          createdAt: "2026-08-28T12:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await updateWhatsappConnectionAction(
      form({
        connectionId: "connection_1",
        provider: "waha",
        name: "WAHA comercial",
        baseUrl: "https://waha.example.test",
        secret: "rotated-secret-do-not-return",
      }),
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(
      "rotated-secret-do-not-return",
    );
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3333/integrations/whatsapp-connections/connection_1/edit",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          provider: "waha",
          name: "WAHA comercial",
          displayName: null,
          credentials: {
            baseUrl: "https://waha.example.test",
            apiKey: "rotated-secret-do-not-return",
          },
        }),
      }),
    );
  });

  it("validates edit input locally without calling the API", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");

    const result = await updateWhatsappConnectionAction(
      form({
        connectionId: "connection_1",
        provider: "waha",
        name: "WAHA comercial",
        baseUrl: "ftp://waha.example.test",
      }),
    );

    expect(result.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls the DELETE contract and reports success", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    const result = await deleteWhatsappConnectionAction(
      form({ connectionId: "connection_1" }),
    );

    expect(result).toMatchObject({ ok: true, connectionId: "connection_1" });
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3333/integrations/whatsapp-connections/connection_1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("fails closed without calling the API when connectionId is missing", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");

    const result = await deleteWhatsappConnectionAction(form({}));

    expect(result.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows the license lock message when the API answers 423", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ message: "Licença bloqueada", reason: "revoked" }),
        { status: 423, headers: { "Content-Type": "application/json" } },
      ),
    );

    const removed = await deleteWhatsappConnectionAction(
      form({ connectionId: "connection_1" }),
    );
    const created = await createWhatsappConnectionAction(
      form({
        provider: "waha",
        name: "WAHA",
        baseUrl: "https://waha.example.com",
        apiKey: "key",
      }),
    );

    for (const result of [removed, created]) {
      expect(result).toEqual({
        ok: false,
        message:
          "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.",
      });
    }
  });

  it("reports a friendly error when the delete request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
    );

    const result = await deleteWhatsappConnectionAction(
      form({ connectionId: "connection_1" }),
    );

    expect(result.ok).toBe(false);
  });
});
