import { afterEach, describe, expect, it, vi } from "vitest";

const { revalidatePath, serverApiFetch, ApiRequestErrorStub } = vi.hoisted(() => {
  class ApiRequestErrorStub extends Error {
    status: number;
    constructor(message: string, status = 409) {
      super(message);
      this.status = status;
    }
  }
  return {
    revalidatePath: vi.fn(),
    serverApiFetch: vi.fn(),
    ApiRequestErrorStub,
  };
});

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/lib/server-api", () => ({
  serverApiFetch,
  isApiRequestError: (error: unknown) => error instanceof ApiRequestErrorStub,
  isLicenseLockedError: (error: unknown) =>
    error instanceof ApiRequestErrorStub && error.status === 423,
}));

import {
  createKommoConnectionAction,
  createKommoRuleAction,
  deleteKommoRuleAction,
  getKommoConnectionAction,
  listKommoConnectionsAction,
  listKommoEventsAction,
  refreshKommoCatalogAction,
  replaceKommoCredentialAction,
  rotateKommoWebhookTokenAction,
  setKommoChannelBindingsAction,
  setKommoConnectionStatusAction,
  updateKommoRuleAction,
} from "../src/app/(app)/integrations/kommo-actions";

afterEach(() => {
  revalidatePath.mockReset();
  serverApiFetch.mockReset();
});

const SECRET_TOKEN = "kommo-long-lived-token-1234567890";
const WEBHOOK_URL = "https://api.example.test/inbound/kommo/AAAA-secret-BBBB";

const baseConnectionFields = {
  id: "connection_1",
  workspaceId: "workspace_1",
  displayName: "Kommo principal",
  status: "active" as const,
  verifiedAccountId: "account_1",
  accountSubdomain: "suaempresa",
  accountOrigin: "https://suaempresa.kommo.com",
  allowedChannelRouteIds: ["route_1"],
  credentialHealthy: true,
  catalogState: "fresh" as const,
  catalogRefreshedAt: "2026-07-17T18:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-07-17T17:00:00.000Z",
  updatedAt: "2026-07-17T18:00:00.000Z",
};

const pipelineRow = {
  id: "pipeline_1",
  name: "Vendas",
  sort: 1,
  status: { id: "status_1", name: "Negociacao", type: "ordinary" },
  available: true,
};

const ruleRow = {
  id: "rule_1",
  connectionId: "connection_1",
  name: "Negociacao avancada",
  pipelineId: "pipeline_1",
  statusId: "status_1",
  eventName: "QualifiedLead",
  mode: "observation" as const,
  valueMode: "lead_price" as const,
  fixedValueCents: null,
  currency: null,
  contentName: null,
  active: true,
  createdAt: "2026-07-17T17:30:00.000Z",
  updatedAt: "2026-07-17T17:30:00.000Z",
};

function connectionDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...baseConnectionFields,
    pipelines: [pipelineRow],
    rules: [ruleRow],
    ...overrides,
  };
}

function form(values: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

describe("listKommoConnectionsAction", () => {
  it("parses full connection details with pipelines and rules", async () => {
    serverApiFetch.mockResolvedValueOnce([connectionDetail()]);
    const result = await listKommoConnectionsAction("workspace_1");
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/workspaces/workspace_1/kommo/connections",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.connections[0]).toMatchObject({
      id: "connection_1",
      pipelines: [pipelineRow],
      rules: [ruleRow],
    });
  });

  it("fails the WHOLE list when one entry is malformed", async () => {
    serverApiFetch.mockResolvedValueOnce([
      connectionDetail(),
      { ...connectionDetail({ id: "connection_2" }), pipelines: "not-an-array" },
    ]);
    expect(await listKommoConnectionsAction("workspace_1")).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("fails when an entry omits pipelines and rules", async () => {
    serverApiFetch.mockResolvedValueOnce([
      connectionDetail(),
      { ...baseConnectionFields, id: "connection_3" },
    ]);
    expect(await listKommoConnectionsAction("workspace_1")).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("fails when an entry belongs to another workspace", async () => {
    serverApiFetch.mockResolvedValueOnce([
      connectionDetail({ workspaceId: "workspace_other" }),
    ]);
    expect(await listKommoConnectionsAction("workspace_1")).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("fails when a rule points at a different connection", async () => {
    serverApiFetch.mockResolvedValueOnce([
      connectionDetail({ rules: [{ ...ruleRow, connectionId: "connection_x" }] }),
    ]);
    expect(await listKommoConnectionsAction("workspace_1")).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("never turns an unexpected shape into a silent empty list", async () => {
    serverApiFetch.mockResolvedValueOnce({ not: "an array" });
    expect(await listKommoConnectionsAction("workspace_1")).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("reports unauthorized for 401 and 403 (members are denied reads too)", async () => {
    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("x", 401));
    expect(await listKommoConnectionsAction("workspace_1")).toEqual({
      ok: false,
      reason: "unauthorized",
    });
    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("x", 403));
    expect(await listKommoConnectionsAction("workspace_1")).toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });

  it("reports network for other failures", async () => {
    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("x", 500));
    expect(await listKommoConnectionsAction("workspace_1")).toEqual({
      ok: false,
      reason: "network",
    });
    serverApiFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await listKommoConnectionsAction("workspace_1")).toEqual({
      ok: false,
      reason: "network",
    });
  });
});

describe("getKommoConnectionAction", () => {
  it("returns the scoped connection", async () => {
    serverApiFetch.mockResolvedValueOnce(connectionDetail());
    const result = await getKommoConnectionAction("workspace_1", "connection_1");
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/workspaces/workspace_1/kommo/connections/connection_1",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a response for another connection or workspace", async () => {
    serverApiFetch.mockResolvedValueOnce(connectionDetail({ id: "connection_9" }));
    expect(await getKommoConnectionAction("workspace_1", "connection_1")).toEqual({
      ok: false,
      reason: "invalid_response",
    });
    serverApiFetch.mockResolvedValueOnce(connectionDetail({ workspaceId: "w2" }));
    expect(await getKommoConnectionAction("workspace_1", "connection_1")).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("maps 403 to unauthorized and others to network", async () => {
    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("x", 403));
    expect(await getKommoConnectionAction("workspace_1", "connection_1")).toEqual({
      ok: false,
      reason: "unauthorized",
    });
    serverApiFetch.mockRejectedValueOnce(new Error("boom"));
    expect(await getKommoConnectionAction("workspace_1", "connection_1")).toEqual({
      ok: false,
      reason: "network",
    });
  });
});

describe("createKommoConnectionAction", () => {
  const payload = JSON.stringify({
    displayName: "Kommo suaempresa",
    accountOrigin: "https://suaempresa.kommo.com",
    accessToken: SECRET_TOKEN,
    allowedChannelRouteIds: [],
  });

  it("returns the connection and the one-time webhook URL separately, without leaking the URL into the connection", async () => {
    serverApiFetch.mockResolvedValueOnce({
      ...connectionDetail(),
      webhookUrl: WEBHOOK_URL,
    });
    const result = await createKommoConnectionAction(
      form({ workspaceId: "workspace_1", payload }),
    );
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/workspaces/workspace_1/kommo/connections",
      { method: "POST", body: expect.any(String) },
    );
    expect(result.ok).toBe(true);
    expect(result.oneTimeWebhook).toEqual({ webhookUrl: WEBHOOK_URL });
    expect(JSON.stringify(result.connection)).not.toContain(WEBHOOK_URL);
    expect(JSON.stringify(result.connection)).not.toContain("webhookUrl");
    expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("rejects an invalid payload before any request", async () => {
    for (const bad of [
      { displayName: "K", accountOrigin: "https://x.kommo.com", accessToken: SECRET_TOKEN },
      { displayName: "Kommo", accountOrigin: "http://x.kommo.com", accessToken: SECRET_TOKEN },
      { displayName: "Kommo", accountOrigin: "https://evil.example.com", accessToken: SECRET_TOKEN },
      { displayName: "Kommo", accountOrigin: "https://x.kommo.com", accessToken: "curto" },
      {
        displayName: "Kommo",
        accountOrigin: "https://x.kommo.com",
        accessToken: SECRET_TOKEN,
        allowedChannelRouteIds: ["a", "a"],
      },
    ]) {
      const result = await createKommoConnectionAction(
        form({ workspaceId: "workspace_1", payload: JSON.stringify(bad) }),
      );
      expect(result).toEqual({
        ok: false,
        message: "Revise os dados informados e tente novamente.",
      });
    }
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("treats a 2xx with a malformed body as an UNKNOWN outcome", async () => {
    serverApiFetch.mockResolvedValueOnce({ ok: true });
    const result = await createKommoConnectionAction(
      form({ workspaceId: "workspace_1", payload }),
    );
    expect(result).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("treats a response for another workspace as an unknown outcome", async () => {
    serverApiFetch.mockResolvedValueOnce({
      ...connectionDetail({ workspaceId: "other" }),
      webhookUrl: WEBHOOK_URL,
    });
    const result = await createKommoConnectionAction(
      form({ workspaceId: "workspace_1", payload }),
    );
    expect(result).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(result.oneTimeWebhook).toBeUndefined();
  });

  it("maps 5xx and transport errors to an unknown outcome without leaking server text or the token", async () => {
    serverApiFetch.mockRejectedValueOnce(
      new ApiRequestErrorStub(`boom ${SECRET_TOKEN}`, 502),
    );
    const upstream = await createKommoConnectionAction(
      form({ workspaceId: "workspace_1", payload }),
    );
    expect(upstream).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(JSON.stringify(upstream)).not.toContain(SECRET_TOKEN);

    serverApiFetch.mockRejectedValueOnce(new Error("socket hang up"));
    const transport = await createKommoConnectionAction(
      form({ workspaceId: "workspace_1", payload }),
    );
    expect(transport).toMatchObject({
      ok: false,
      message: "Não foi possível criar a conexão Kommo.",
      outcomeUnknown: true,
    });
  });

  it("maps 401/403 to an auth failure that is NOT an unknown outcome", async () => {
    for (const status of [401, 403]) {
      serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("nope", status));
      const result = await createKommoConnectionAction(
        form({ workspaceId: "workspace_1", payload }),
      );
      expect(result).toMatchObject({ ok: false, authFailure: "unauthorized" });
      expect(result.outcomeUnknown).toBeUndefined();
    }
  });

  it("maps 423 to licenseLocked, definitively not unknown", async () => {
    serverApiFetch.mockRejectedValueOnce(
      new ApiRequestErrorStub("license locked", 423),
    );
    const result = await createKommoConnectionAction(
      form({ workspaceId: "workspace_1", payload }),
    );
    expect(result).toMatchObject({ ok: false, licenseLocked: true });
    expect(result.outcomeUnknown).toBeUndefined();
    expect(result.message).toContain("Licença bloqueada");
  });

  it("passes only allowlisted 400/409 messages", async () => {
    serverApiFetch.mockRejectedValueOnce(
      new ApiRequestErrorStub("Credencial Kommo requer verificacao", 409),
    );
    expect(
      (await createKommoConnectionAction(form({ workspaceId: "workspace_1", payload })))
        .message,
    ).toBe("Credencial Kommo requer verificacao");

    serverApiFetch.mockRejectedValueOnce(
      new ApiRequestErrorStub(`SQL error near ${SECRET_TOKEN}`, 400),
    );
    const generic = await createKommoConnectionAction(
      form({ workspaceId: "workspace_1", payload }),
    );
    expect(generic.message).toBe("Não foi possível criar a conexão Kommo.");
    expect(generic.outcomeUnknown).toBeUndefined();
  });
});

describe("replaceKommoCredentialAction", () => {
  const payload = JSON.stringify({ accessToken: SECRET_TOKEN });

  it("posts to /credentials and returns the scoped connection", async () => {
    serverApiFetch.mockResolvedValueOnce(connectionDetail());
    const result = await replaceKommoCredentialAction(
      form({ workspaceId: "workspace_1", connectionId: "connection_1", payload }),
    );
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/workspaces/workspace_1/kommo/connections/connection_1/credentials",
      { method: "POST", body: expect.any(String) },
    );
    expect(result).toMatchObject({ ok: true, message: "Credenciais da Kommo atualizadas." });
    expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
  });

  it("rejects short tokens and bad origins locally", async () => {
    for (const bad of [
      { accessToken: "curto" },
      { accessToken: SECRET_TOKEN, accountOrigin: "https://x.example.com" },
      { accessToken: SECRET_TOKEN, extra: true },
    ]) {
      const result = await replaceKommoCredentialAction(
        form({
          workspaceId: "workspace_1",
          connectionId: "connection_1",
          payload: JSON.stringify(bad),
        }),
      );
      expect(result.ok).toBe(false);
    }
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("flags a mismatched connection id as an unknown outcome", async () => {
    serverApiFetch.mockResolvedValueOnce(connectionDetail({ id: "connection_other" }));
    const result = await replaceKommoCredentialAction(
      form({ workspaceId: "workspace_1", connectionId: "connection_1", payload }),
    );
    expect(result).toMatchObject({ ok: false, outcomeUnknown: true });
  });
});

describe("setKommoConnectionStatusAction", () => {
  it("accepts only active|paused and reports the right copy", async () => {
    serverApiFetch.mockResolvedValueOnce(connectionDetail({ status: "paused" }));
    const paused = await setKommoConnectionStatusAction(
      form({ workspaceId: "workspace_1", connectionId: "connection_1", status: "paused" }),
    );
    expect(paused).toMatchObject({ ok: true, message: "Conexão Kommo pausada." });

    serverApiFetch.mockResolvedValueOnce(connectionDetail());
    const active = await setKommoConnectionStatusAction(
      form({ workspaceId: "workspace_1", connectionId: "connection_1", status: "active" }),
    );
    expect(active).toMatchObject({ ok: true, message: "Conexão Kommo retomada." });

    const blocked = await setKommoConnectionStatusAction(
      form({ workspaceId: "workspace_1", connectionId: "connection_1", status: "blocked" }),
    );
    expect(blocked.ok).toBe(false);
    expect(serverApiFetch).toHaveBeenCalledTimes(2);
  });

  it("uses PATCH /status", async () => {
    serverApiFetch.mockResolvedValueOnce(connectionDetail());
    await setKommoConnectionStatusAction(
      form({ workspaceId: "workspace_1", connectionId: "connection_1", status: "active" }),
    );
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/workspaces/workspace_1/kommo/connections/connection_1/status",
      { method: "PATCH", body: JSON.stringify({ status: "active" }) },
    );
  });
});

describe("setKommoChannelBindingsAction", () => {
  it("rejects duplicate route ids and accepts an empty list", async () => {
    const dup = await setKommoChannelBindingsAction(
      form({
        workspaceId: "workspace_1",
        connectionId: "connection_1",
        payload: JSON.stringify({ allowedChannelRouteIds: ["a", "a"] }),
      }),
    );
    expect(dup.ok).toBe(false);
    expect(serverApiFetch).not.toHaveBeenCalled();

    serverApiFetch.mockResolvedValueOnce(connectionDetail({ allowedChannelRouteIds: [] }));
    const empty = await setKommoChannelBindingsAction(
      form({
        workspaceId: "workspace_1",
        connectionId: "connection_1",
        payload: JSON.stringify({ allowedChannelRouteIds: [] }),
      }),
    );
    expect(empty).toMatchObject({ ok: true, message: "Canais autorizados atualizados." });
  });
});

describe("rotateKommoWebhookTokenAction", () => {
  it("returns only the fresh URL and invalidates /settings", async () => {
    serverApiFetch.mockResolvedValueOnce({ webhookUrl: WEBHOOK_URL });
    const result = await rotateKommoWebhookTokenAction(
      form({ workspaceId: "workspace_1", connectionId: "connection_1" }),
    );
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/workspaces/workspace_1/kommo/connections/connection_1/rotate-webhook-token",
      { method: "POST", body: "{}" },
    );
    expect(result).toMatchObject({
      ok: true,
      oneTimeWebhook: { webhookUrl: WEBHOOK_URL },
    });
    expect(result.connection).toBeUndefined();
  });

  it("a malformed success is an unknown outcome and never rendered as a URL", async () => {
    serverApiFetch.mockResolvedValueOnce({ webhookUrl: "" });
    const result = await rotateKommoWebhookTokenAction(
      form({ workspaceId: "workspace_1", connectionId: "connection_1" }),
    );
    expect(result).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(result.oneTimeWebhook).toBeUndefined();
  });

  it("does not echo the server error text", async () => {
    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub(WEBHOOK_URL, 500));
    const result = await rotateKommoWebhookTokenAction(
      form({ workspaceId: "workspace_1", connectionId: "connection_1" }),
    );
    expect(JSON.stringify(result)).not.toContain(WEBHOOK_URL);
    expect(result.outcomeUnknown).toBe(true);
  });
});

describe("refreshKommoCatalogAction", () => {
  it("says the catalog is updated only when it is fresh", async () => {
    serverApiFetch.mockResolvedValueOnce(connectionDetail());
    expect(
      await refreshKommoCatalogAction(
        form({ workspaceId: "workspace_1", connectionId: "connection_1" }),
      ),
    ).toMatchObject({ ok: true, message: "Catálogo de pipelines e estágios atualizado." });

    serverApiFetch.mockResolvedValueOnce(connectionDetail({ catalogState: "error" }));
    expect(
      await refreshKommoCatalogAction(
        form({ workspaceId: "workspace_1", connectionId: "connection_1" }),
      ),
    ).toMatchObject({
      ok: true,
      message: "Não foi possível confirmar o catálogo; verifique a credencial.",
    });
  });
});

describe("Kommo rule actions", () => {
  const validRule = {
    name: "Negociacao avancada",
    pipelineId: "pipeline_1",
    statusId: "status_1",
    eventName: "QualifiedLead",
    mode: "observation",
    valueMode: "lead_price",
    active: true,
  };
  const ids = { workspaceId: "workspace_1", connectionId: "connection_1" };

  it("creates a rule at /rules and checks connection scope", async () => {
    serverApiFetch.mockResolvedValueOnce(ruleRow);
    const created = await createKommoRuleAction(
      form({ ...ids, payload: JSON.stringify(validRule) }),
    );
    expect(created).toMatchObject({ ok: true, message: "Regra Kommo criada.", rule: ruleRow });
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/workspaces/workspace_1/kommo/connections/connection_1/rules",
      { method: "POST", body: expect.any(String) },
    );

    serverApiFetch.mockResolvedValueOnce({ ...ruleRow, connectionId: "connection_x" });
    const crossed = await createKommoRuleAction(
      form({ ...ids, payload: JSON.stringify(validRule) }),
    );
    expect(crossed).toMatchObject({ ok: false, outcomeUnknown: true });
  });

  it("requires the currency for fixed-value Purchase and for lead_price Purchase", async () => {
    const fixedNoCurrency = await createKommoRuleAction(
      form({
        ...ids,
        payload: JSON.stringify({
          ...validRule,
          eventName: "Purchase",
          valueMode: "fixed",
          fixedValueCents: 1000,
        }),
      }),
    );
    expect(fixedNoCurrency.ok).toBe(false);

    const leadPriceNoCurrency = await createKommoRuleAction(
      form({
        ...ids,
        payload: JSON.stringify({ ...validRule, eventName: "Purchase" }),
      }),
    );
    expect(leadPriceNoCurrency.ok).toBe(false);
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("updates, pauses and encodes the rule id", async () => {
    serverApiFetch.mockResolvedValueOnce({ ...ruleRow, active: false });
    const paused = await updateKommoRuleAction(
      form({ ...ids, ruleId: "rule/1", payload: JSON.stringify({ active: false }) }),
    );
    expect(paused).toMatchObject({ ok: false });
    // a response whose id differs from the requested rule id is never trusted
    expect(paused.outcomeUnknown).toBe(true);

    serverApiFetch.mockResolvedValueOnce({ ...ruleRow, active: false });
    const ok = await updateKommoRuleAction(
      form({ ...ids, ruleId: "rule_1", payload: JSON.stringify({ active: false }) }),
    );
    expect(ok).toMatchObject({ ok: true, message: "Regra Kommo pausada." });
    expect(serverApiFetch).toHaveBeenLastCalledWith(
      "/workspaces/workspace_1/kommo/connections/connection_1/rules/rule_1",
      { method: "PATCH", body: JSON.stringify({ active: false }) },
    );
  });

  it("rejects an empty update", async () => {
    const result = await updateKommoRuleAction(
      form({ ...ids, ruleId: "rule_1", payload: "{}" }),
    );
    expect(result.ok).toBe(false);
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("deletes with DELETE and maps 423 to licenseLocked", async () => {
    serverApiFetch.mockResolvedValueOnce(undefined);
    expect(await deleteKommoRuleAction(form({ ...ids, ruleId: "rule_1" }))).toEqual({
      ok: true,
      message: "Regra Kommo removida.",
    });
    expect(serverApiFetch).toHaveBeenLastCalledWith(
      "/workspaces/workspace_1/kommo/connections/connection_1/rules/rule_1",
      { method: "DELETE" },
    );

    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("locked", 423));
    const locked = await deleteKommoRuleAction(form({ ...ids, ruleId: "rule_1" }));
    expect(locked).toMatchObject({ ok: false, licenseLocked: true });
    expect(locked.outcomeUnknown).toBeUndefined();
  });

  it("rejects ids with control characters or over 255 chars before any request", async () => {
    for (const bad of ["rule\u0000x", "r".repeat(256)]) {
      const result = await deleteKommoRuleAction(form({ ...ids, ruleId: bad }));
      expect(result.ok).toBe(false);
    }
    expect(serverApiFetch).not.toHaveBeenCalled();
  });
});

describe("listKommoEventsAction", () => {
  const eventRow = {
    id: "event_1",
    dealId: "9001",
    pipelineId: "pipeline_1",
    statusId: "status_1",
    status: "observed",
    errorCode: null,
    attempts: 1,
    results: [
      {
        ruleId: "rule_1",
        eventName: "QualifiedLead",
        status: "observed",
        errorCode: null,
        publicationStatus: null,
        publicationErrorCode: null,
        senderStatus: null,
      },
    ],
  };

  it("requests the events path, encodes the cursor, and keeps only DTO fields", async () => {
    serverApiFetch.mockResolvedValueOnce({
      events: [{ ...eventRow, secretExtra: "nope" }],
      nextCursor: "event_1",
    });
    const result = await listKommoEventsAction("workspace_1", "connection_1", "ev 0/1");
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/workspaces/workspace_1/kommo/connections/connection_1/events?cursor=ev%200%2F1",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.nextCursor).toBe("event_1");
    expect(JSON.stringify(result.events)).not.toContain("secretExtra");
    expect(result.events[0].errorMessage).toBeNull();
    expect(Object.keys(result.events[0]).sort()).toEqual(
      [
        "attempts",
        "dealId",
        "errorCode",
        "errorMessage",
        "id",
        "pipelineId",
        "results",
        "status",
        "statusId",
      ].sort(),
    );
  });

  it("omits the query string on the first page and treats a missing cursor as the end", async () => {
    serverApiFetch.mockResolvedValueOnce({ events: [eventRow] });
    const result = await listKommoEventsAction("workspace_1", "connection_1");
    expect(serverApiFetch).toHaveBeenCalledWith(
      "/workspaces/workspace_1/kommo/connections/connection_1/events",
    );
    expect(result).toMatchObject({ ok: true, nextCursor: null });
  });

  it("maps 401/403 to unauthorized, 404 to not_found, 400 to invalid_request, others to network", async () => {
    const expected: Array<[number, string]> = [
      [401, "unauthorized"],
      [403, "unauthorized"],
      [404, "not_found"],
      [400, "invalid_request"],
      [500, "network"],
    ];
    for (const [status, reason] of expected) {
      serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("x", status));
      expect(await listKommoEventsAction("workspace_1", "connection_1")).toEqual({
        ok: false,
        reason,
      });
    }
    serverApiFetch.mockRejectedValueOnce(new Error("offline"));
    expect(await listKommoEventsAction("workspace_1", "connection_1")).toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("does not map a 423 to an error: reads stay available while the server decides", async () => {
    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("locked", 423));
    expect(await listKommoEventsAction("workspace_1", "connection_1")).toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("rejects invalid ids/cursors without calling the API", async () => {
    expect(await listKommoEventsAction("", "connection_1")).toEqual({
      ok: false,
      reason: "invalid_request",
    });
    expect(await listKommoEventsAction("workspace_1", "  ")).toEqual({
      ok: false,
      reason: "invalid_request",
    });
    expect(await listKommoEventsAction("workspace_1", "connection_1", "")).toEqual({
      ok: false,
      reason: "invalid_request",
    });
    expect(
      await listKommoEventsAction("workspace_1", "connection_1", "c".repeat(256)),
    ).toEqual({ ok: false, reason: "invalid_request" });
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("rejects pages with duplicate ids, >100 events, a nextCursor equal to the requested cursor, or bad codes", async () => {
    serverApiFetch.mockResolvedValueOnce({ events: [eventRow, eventRow], nextCursor: null });
    expect(await listKommoEventsAction("workspace_1", "connection_1")).toEqual({
      ok: false,
      reason: "invalid_response",
    });

    serverApiFetch.mockResolvedValueOnce({
      events: Array.from({ length: 101 }, (_, i) => ({ ...eventRow, id: `e${i}` })),
      nextCursor: null,
    });
    expect(await listKommoEventsAction("workspace_1", "connection_1")).toEqual({
      ok: false,
      reason: "invalid_response",
    });

    serverApiFetch.mockResolvedValueOnce({ events: [eventRow], nextCursor: "event_0" });
    expect(await listKommoEventsAction("workspace_1", "connection_1", "event_0")).toEqual({
      ok: false,
      reason: "invalid_response",
    });

    serverApiFetch.mockResolvedValueOnce({
      events: [{ ...eventRow, status: "<script>alert(1)</script>" }],
      nextCursor: null,
    });
    expect(await listKommoEventsAction("workspace_1", "connection_1")).toEqual({
      ok: false,
      reason: "invalid_response",
    });

    serverApiFetch.mockResolvedValueOnce({ events: "nope" });
    expect(await listKommoEventsAction("workspace_1", "connection_1")).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("preserves the delivery-unknown message only when it is exactly the known copy", async () => {
    const unknownMessage =
      "Resultado da entrega desconhecido. Reenvio bloqueado; investigacao requerida.";
    serverApiFetch.mockResolvedValueOnce({
      events: [
        {
          ...eventRow,
          id: "event_a",
          errorCode: "kommo_delivery_unknown",
          errorMessage: unknownMessage,
          results: [
            {
              ...eventRow.results[0],
              publicationStatus: "delivery_unknown",
              publicationErrorCode: "kommo_delivery_unknown",
              publicationErrorMessage: unknownMessage,
            },
          ],
        },
        {
          ...eventRow,
          id: "event_b",
          errorMessage: `stack trace ${SECRET_TOKEN}`,
          results: [
            { ...eventRow.results[0], publicationErrorMessage: "free text from server" },
          ],
        },
      ],
      nextCursor: null,
    });
    const result = await listKommoEventsAction("workspace_1", "connection_1");
    if (!result.ok) throw new Error("expected ok");
    expect(result.events[0].errorMessage).toBe(unknownMessage);
    expect(result.events[0].results[0].publicationErrorMessage).toBe(unknownMessage);
    expect(result.events[1].errorMessage).toBeNull();
    expect(result.events[1].results[0].publicationErrorMessage).toBeNull();
    expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
  });
});
