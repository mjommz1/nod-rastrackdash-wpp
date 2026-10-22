import { afterEach, describe, expect, it, vi } from "vitest";

const { revalidatePath, serverApiFetch, ApiRequestErrorStub, LicenseLockedErrorStub } =
  vi.hoisted(() => {
  class ApiRequestErrorStub extends Error {
    status: number;
    code?: string;
    constructor(message: string, status = 409, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  class LicenseLockedErrorStub extends ApiRequestErrorStub {
    constructor(message = "Licença bloqueada") {
      super(message, 423);
    }
  }
  return {
    revalidatePath: vi.fn(),
    serverApiFetch: vi.fn(),
    ApiRequestErrorStub,
    LicenseLockedErrorStub,
  };
});

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/lib/server-api", () => ({
  serverApiFetch,
  isApiRequestError: (error: unknown) => error instanceof ApiRequestErrorStub,
  isLicenseLockedError: (error: unknown) => error instanceof LicenseLockedErrorStub,
}));

import {
  createPipedriveConnectionAction,
  createPipedriveRuleAction,
  deletePipedriveConnectionAction,
  deletePipedriveRuleAction,
  getPipedriveConnectionAction,
  listPipedriveConnectionsAction,
  listPipedriveEventsAction,
  refreshPipedriveCatalogAction,
  retryPipedriveEventAction,
  revokePipedriveWebhookSecretAction,
  rotatePipedriveWebhookSecretAction,
  setPipedriveConnectionStatusAction,
  updatePipedriveRuleAction,
} from "../src/app/(app)/integrations/pipedrive-actions";
import { baseConnection, baseRule, pipelines, snapshotOf } from "./support/pipedrive-fixtures";

afterEach(() => {
  revalidatePath.mockReset();
  serverApiFetch.mockReset();
});

function form(values: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

const ids = { workspaceId: "workspace_1", connectionId: "pipedrive_connection_1" };
const base = "/workspaces/workspace_1/pipedrive/connections";
const snapshot = snapshotOf(baseConnection);

describe("Pipedrive reads", () => {
  it("completes each listed connection with its catalog and rules (list has no catalog)", async () => {
    serverApiFetch.mockImplementation(async (path: string) => {
      if (path === base) return [{ ...snapshot, pipelines: undefined }];
      if (path === `${base}/pipedrive_connection_1`) return snapshot;
      if (path === `${base}/pipedrive_connection_1/rules`) return [baseRule];
      throw new Error(`unexpected ${path}`);
    });

    const result = await listPipedriveConnectionsAction("workspace_1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.connections[0]!.pipelines).toEqual(pipelines);
    expect(result.connections[0]!.rules).toEqual([baseRule]);
  });

  it("fails the whole list when one detail read fails, never returning a partial list as empty", async () => {
    serverApiFetch.mockImplementation(async (path: string) => {
      if (path === base) return [snapshot];
      throw new ApiRequestErrorStub("boom", 500);
    });
    expect(await listPipedriveConnectionsAction("workspace_1")).toEqual({ ok: false, reason: "network" });
  });

  it("maps 401/403 to unauthorized", async () => {
    serverApiFetch.mockRejectedValue(new ApiRequestErrorStub("no", 403));
    expect(await listPipedriveConnectionsAction("workspace_1")).toEqual({ ok: false, reason: "unauthorized" });
    expect(await getPipedriveConnectionAction("workspace_1", "pipedrive_connection_1")).toEqual({ ok: false, reason: "unauthorized" });
    expect(await listPipedriveEventsAction("workspace_1", "pipedrive_connection_1")).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("rejects a connection from another workspace as an invalid response", async () => {
    serverApiFetch.mockResolvedValueOnce([{ ...snapshot, workspaceId: "workspace_other" }]);
    expect(await listPipedriveConnectionsAction("workspace_1")).toEqual({ ok: false, reason: "invalid_response" });
  });

  it("rejects rules whose nested connection id is not the requested one", async () => {
    serverApiFetch.mockImplementation(async (path: string) =>
      path.endsWith("/rules") ? [{ ...baseRule, connectionId: "someone_else" }] : snapshot,
    );
    expect(await getPipedriveConnectionAction("workspace_1", "pipedrive_connection_1")).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("rejects a malformed events payload and bounds it to 100", async () => {
    serverApiFetch.mockResolvedValueOnce([{ id: "e1" }]);
    expect(await listPipedriveEventsAction("workspace_1", "pipedrive_connection_1")).toEqual({ ok: false, reason: "invalid_response" });

    const many = Array.from({ length: 101 }, (_, index) => ({
      id: `e${index}`, status: "observed", errorCode: null, attempts: 1,
      occurredAt: "2026-10-11T11:00:00.000Z", createdAt: "2026-10-11T11:00:00.000Z", nextAttemptAt: null, results: [],
    }));
    serverApiFetch.mockResolvedValueOnce(many);
    expect(await listPipedriveEventsAction("workspace_1", "pipedrive_connection_1")).toEqual({ ok: false, reason: "invalid_response" });
  });
});

describe("Pipedrive connection mutations", () => {
  it("creates a connection through the validated contract and returns connection + catalog, no URL", async () => {
    serverApiFetch.mockResolvedValueOnce(snapshot);
    const result = await createPipedriveConnectionAction(
      form({
        workspaceId: "workspace_1",
        payload: JSON.stringify({
          displayName: "Pipedrive principal",
          accountOrigin: "https://suaempresa.pipedrive.com",
          apiToken: "synthetic-token-0123456789",
          allowedChannelRouteIds: ["route_1"],
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.oneTimeWebhook).toBeUndefined();
    expect(serverApiFetch).toHaveBeenCalledWith(base, expect.objectContaining({ method: "POST" }));
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
  });

  it("refuses an invalid payload before any request", async () => {
    const result = await createPipedriveConnectionAction(
      form({ workspaceId: "workspace_1", payload: JSON.stringify({ displayName: "x", accountOrigin: "http://x", apiToken: "short" }) }),
    );
    expect(result.ok).toBe(false);
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("treats a 2xx with a mismatching scope as an unknown outcome, not success", async () => {
    serverApiFetch.mockResolvedValueOnce({ ...snapshot, id: "another" });
    const result = await setPipedriveConnectionStatusAction(form({ ...ids, status: "paused" }));
    expect(result).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("marks a failed catalog refresh as not ok even when the API answered 2xx", async () => {
    serverApiFetch.mockResolvedValueOnce({ ...snapshot, catalogState: "error", lastErrorCode: "pipedrive_timeout" });
    const result = await refreshPipedriveCatalogAction(form(ids));
    expect(result.ok).toBe(false);
  });

  it("maps 401/403 to an auth failure without an unknown outcome", async () => {
    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("Forbidden", 403));
    const result = await refreshPipedriveCatalogAction(form(ids));
    expect(result).toMatchObject({ ok: false, authFailure: "unauthorized" });
    expect(result.outcomeUnknown).toBeUndefined();
  });

  it("never lets provider or database text cross the boundary", async () => {
    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("PrismaClientKnownRequestError: relation foo", 409));
    const result = await refreshPipedriveCatalogAction(form(ids));
    expect(result.ok).toBe(false);
    expect(result.message).not.toMatch(/Prisma|relation/);
  });

  it("localizes known API messages and treats a 5xx as an unknown outcome", async () => {
    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("Conta Pipedrive já conectada neste workspace", 409));
    const known = await setPipedriveConnectionStatusAction(form({ ...ids, status: "active" }));
    expect(known.message).toMatch(/já está conectada/);
    expect(known.outcomeUnknown).toBeUndefined();

    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("anything", 502));
    const unknown = await setPipedriveConnectionStatusAction(form({ ...ids, status: "active" }));
    expect(unknown.outcomeUnknown).toBe(true);
  });

  it("treats a missing-encryption-key 5xx as definitive (nothing was written)", async () => {
    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("pipedrive_encryption_key_invalid", 503));
    const result = await refreshPipedriveCatalogAction(form(ids));
    expect(result.outcomeUnknown).toBeUndefined();
    expect(result.message).toMatch(/operador do ambiente/);
  });

  it("treats a non-API error (network) as an unknown outcome", async () => {
    serverApiFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    const result = await deletePipedriveConnectionAction(form(ids));
    expect(result).toMatchObject({ ok: false, outcomeUnknown: true });
  });

  it("confirms deletion only for the documented response", async () => {
    serverApiFetch.mockResolvedValueOnce({ status: "deleted" });
    expect(await deletePipedriveConnectionAction(form(ids))).toMatchObject({ ok: true, deleted: true });
    serverApiFetch.mockResolvedValueOnce({ ok: true });
    expect(await deletePipedriveConnectionAction(form(ids))).toMatchObject({ ok: false, outcomeUnknown: true });
  });
});

describe("Pipedrive webhook secret", () => {
  it("returns the one-time URL from rotate and never revalidates it into props", async () => {
    serverApiFetch.mockResolvedValueOnce({
      webhookUrl: "https://synthetic.invalid/hook/SECRET",
      version: 2,
      rotatedAt: "2026-10-11T12:00:00.000Z",
    });
    const result = await rotatePipedriveWebhookSecretAction(form(ids));
    expect(result.ok).toBe(true);
    expect(result.oneTimeWebhook?.webhookUrl).toBe("https://synthetic.invalid/hook/SECRET");
    expect(serverApiFetch).toHaveBeenCalledWith(`${base}/pipedrive_connection_1/webhook-secret/rotate`, expect.objectContaining({ method: "POST" }));
  });

  it("an unusable rotate response is an unknown outcome with no URL", async () => {
    serverApiFetch.mockResolvedValueOnce({ webhookUrl: "", version: "x" });
    const result = await rotatePipedriveWebhookSecretAction(form(ids));
    expect(result).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(result.oneTimeWebhook).toBeUndefined();
  });

  it("revokes only on the documented response", async () => {
    serverApiFetch.mockResolvedValueOnce({ status: "revoked" });
    expect(await revokePipedriveWebhookSecretAction(form(ids))).toMatchObject({ ok: true, revoked: true });
    expect(serverApiFetch).toHaveBeenCalledWith(`${base}/pipedrive_connection_1/webhook-secret`, expect.objectContaining({ method: "DELETE" }));
  });
});

describe("Pipedrive rules and event retry", () => {
  const rulePayload = {
    name: "Ganho do negócio",
    pipelineId: "pipeline_1",
    stageId: "stage_3",
    eventName: "Purchase",
    mode: "observation",
    valueMode: "fixed",
    fixedValueCents: 19990,
    currency: "BRL",
  };

  it("creates a rule with fixed positive cents and currency per the create contract", async () => {
    serverApiFetch.mockResolvedValueOnce({ ...baseRule, valueMode: "fixed", fixedValueCents: 19990 });
    const result = await createPipedriveRuleAction(form({ ...ids, payload: JSON.stringify(rulePayload) }));
    expect(result).toMatchObject({ ok: true });
    expect(serverApiFetch).toHaveBeenCalledWith(`${base}/pipedrive_connection_1/rules`, expect.objectContaining({ method: "POST" }));
  });

  it.each([
    ["a non-positive fixed value", { ...rulePayload, fixedValueCents: 0 }],
    ["a fixed value without currency", { ...rulePayload, currency: null }],
    ["a value on a no-value event", { ...rulePayload, eventName: "LeadSubmitted" }],
    ["an unknown field", { ...rulePayload, extra: 1 }],
  ])("rejects %s before any request", async (_label, payload) => {
    const result = await createPipedriveRuleAction(form({ ...ids, payload: JSON.stringify(payload) }));
    expect(result.ok).toBe(false);
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("treats a created rule under another connection as an unknown outcome", async () => {
    serverApiFetch.mockResolvedValueOnce({ ...baseRule, connectionId: "other" });
    const result = await createPipedriveRuleAction(form({ ...ids, payload: JSON.stringify(rulePayload) }));
    expect(result).toMatchObject({ ok: false, outcomeUnknown: true });
  });

  it("updates with a partial payload and validates the returned rule id", async () => {
    serverApiFetch.mockResolvedValueOnce({ ...baseRule, active: false });
    const result = await updatePipedriveRuleAction(form({ ...ids, ruleId: "rule_1", payload: JSON.stringify({ active: false }) }));
    expect(result).toMatchObject({ ok: true, message: "Regra Pipedrive pausada." });

    serverApiFetch.mockResolvedValueOnce({ ...baseRule, id: "rule_2" });
    const mismatched = await updatePipedriveRuleAction(form({ ...ids, ruleId: "rule_1", payload: JSON.stringify({ active: false }) }));
    expect(mismatched).toMatchObject({ ok: false, outcomeUnknown: true });
  });

  it("rejects an empty update", async () => {
    const result = await updatePipedriveRuleAction(form({ ...ids, ruleId: "rule_1", payload: "{}" }));
    expect(result.ok).toBe(false);
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("deletes a rule only on the documented response", async () => {
    serverApiFetch.mockResolvedValueOnce({ status: "deleted" });
    expect(await deletePipedriveRuleAction(form({ ...ids, ruleId: "rule_1" }))).toMatchObject({ ok: true });
    serverApiFetch.mockResolvedValueOnce({});
    expect(await deletePipedriveRuleAction(form({ ...ids, ruleId: "rule_1" }))).toMatchObject({ ok: false, outcomeUnknown: true });
  });

  it("retries an event only on the documented acceptance", async () => {
    serverApiFetch.mockResolvedValueOnce({ status: "accepted" });
    expect(await retryPipedriveEventAction(form({ ...ids, eventId: "e1" }))).toMatchObject({ ok: true });
    expect(serverApiFetch).toHaveBeenCalledWith(`${base}/pipedrive_connection_1/events/e1/retry`, expect.objectContaining({ method: "POST" }));

    serverApiFetch.mockResolvedValueOnce({ status: "queued" });
    expect(await retryPipedriveEventAction(form({ ...ids, eventId: "e1" }))).toMatchObject({ ok: false, outcomeUnknown: true });
  });

  it("rejects ids containing control characters", async () => {
    const result = await deletePipedriveRuleAction(form({ ...ids, ruleId: "rule\n1" }));
    expect(result.ok).toBe(false);
    expect(serverApiFetch).not.toHaveBeenCalled();
  });
});
