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

import { PIPEDRIVE_CONNECTION_NOT_FOUND_MESSAGE } from "@wpptrack/shared";
import {
  getPipedriveCapabilitiesAction,
  getPipedriveConnectionAction,
  listPipedriveEventsAction,
  updatePipedriveRuleAction,
} from "../src/app/(app)/integrations/pipedrive-actions";
import {
  baseConnection,
  capabilitiesEnabled,
  productionRuleWith,
  revisionedConnectionWith,
  snapshotOf,
} from "./support/pipedrive-fixtures";

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
const connPath = "/workspaces/workspace_1/pipedrive/connections/pipedrive_connection_1";

function routeReads(snapshots: unknown[], rules: unknown[] = []) {
  let snapshotCall = 0;
  serverApiFetch.mockImplementation(async (path: string) => {
    if (path === connPath) return snapshots[Math.min(snapshotCall++, snapshots.length - 1)];
    if (path === `${connPath}/rules`) return rules;
    throw new Error(`unexpected ${path}`);
  });
}

describe("Pipedrive production capabilities read", () => {
  it("parses the exact backend capabilities DTO and exposes only environment gates", async () => {
    serverApiFetch.mockResolvedValueOnce({ ...capabilitiesEnabled, modes: ["observation", "production"] });
    const result = await getPipedriveCapabilitiesAction("workspace_1", "pipedrive_connection_1");
    expect(serverApiFetch).toHaveBeenCalledWith(`${connPath}/capabilities`);
    expect(result).toEqual({ ok: true, capabilities: capabilitiesEnabled });
  });

  it("reports productionEnabled=false faithfully (gate off is not an error)", async () => {
    serverApiFetch.mockResolvedValueOnce({
      ...capabilitiesEnabled,
      productionEnabled: false,
      modes: ["observation", "production"],
    });
    expect(await getPipedriveCapabilitiesAction("workspace_1", "pipedrive_connection_1")).toMatchObject({
      ok: true,
      capabilities: { productionEnabled: false },
    });
  });

  it("never turns an absent historicalReplay/unknownDeliveryRetry into a capability", async () => {
    serverApiFetch.mockResolvedValueOnce({
      productionEnabled: true,
      modes: ["observation", "production"],
      activationRequirements: ["verified_account"],
    });
    expect(await getPipedriveCapabilitiesAction("workspace_1", "pipedrive_connection_1")).toMatchObject({
      ok: true,
      capabilities: { historicalReplay: false, unknownDeliveryRetry: false },
    });
  });

  it("treats a route the deployed API does not know (plain 404) as missing", async () => {
    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("not found", 404));
    expect(await getPipedriveCapabilitiesAction("workspace_1", "pipedrive_connection_1")).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("treats a malformed or production-less body as missing, never as enabled", async () => {
    for (const body of [
      null,
      "ok",
      { productionEnabled: "yes", modes: ["production"], activationRequirements: [] },
      { productionEnabled: true, modes: ["observation"], activationRequirements: [] },
      { productionEnabled: true, modes: ["production"], activationRequirements: ["Has Spaces"] },
    ]) {
      serverApiFetch.mockResolvedValueOnce(body);
      expect(await getPipedriveCapabilitiesAction("workspace_1", "pipedrive_connection_1")).toEqual({
        ok: false,
        reason: "missing",
      });
    }
  });

  it("distinguishes scoped absence, unknown (503/network) and unauthorized", async () => {
    serverApiFetch.mockRejectedValueOnce(
      new ApiRequestErrorStub(PIPEDRIVE_CONNECTION_NOT_FOUND_MESSAGE, 404),
    );
    expect(await getPipedriveCapabilitiesAction("workspace_1", "pipedrive_connection_1")).toEqual({
      ok: false,
      reason: "not_found",
    });
    serverApiFetch.mockRejectedValueOnce(
      new ApiRequestErrorStub("x", 503, "pipedrive_persistence_failed"),
    );
    expect(await getPipedriveCapabilitiesAction("workspace_1", "pipedrive_connection_1")).toEqual({
      ok: false,
      reason: "network",
    });
    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("no", 403));
    expect(await getPipedriveCapabilitiesAction("workspace_1", "pipedrive_connection_1")).toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });
});

describe("Pipedrive revision-fenced reads", () => {
  it("reads snapshot, rules, snapshot and marks an unchanged revision as fenced", async () => {
    const connection = revisionedConnectionWith();
    routeReads([snapshotOf(connection), snapshotOf(connection)], [productionRuleWith()]);

    const result = await getPipedriveConnectionAction("workspace_1", "pipedrive_connection_1");

    expect(serverApiFetch.mock.calls.map((call) => call[0])).toEqual([
      connPath,
      `${connPath}/rules`,
      connPath,
    ]);
    if (!result.ok) throw new Error("expected ok");
    expect(result.connection.revisionFenced).toBe(true);
    expect(result.connection.mutationRevision).toBe(5);
    expect(result.connection.webhook).toMatchObject({ configured: true, version: 2 });
    expect(result.connection.rules[0]).toMatchObject({ mode: "production" });
  });

  it("retries when the revision moves between reads and then returns the settled pair", async () => {
    const before = snapshotOf(revisionedConnectionWith({ mutationRevision: 5 }));
    const after = snapshotOf(revisionedConnectionWith({ mutationRevision: 6 }));
    routeReads([before, after, after, after]);

    const result = await getPipedriveConnectionAction("workspace_1", "pipedrive_connection_1");

    if (!result.ok) throw new Error("expected ok");
    expect(result.connection.mutationRevision).toBe(6);
    expect(result.connection.revisionFenced).toBe(true);
    expect(serverApiFetch).toHaveBeenCalledTimes(6);
  });

  it("reports inconsistent, never a mixed pair, when every attempt races a write", async () => {
    let revision = 1;
    serverApiFetch.mockImplementation(async (path: string) =>
      path === connPath
        ? snapshotOf(revisionedConnectionWith({ mutationRevision: revision++ }))
        : [],
    );
    expect(await getPipedriveConnectionAction("workspace_1", "pipedrive_connection_1")).toEqual({
      ok: false,
      reason: "inconsistent",
    });
  });

  it("flags a backend without a revision as not fenced instead of promising atomicity", async () => {
    routeReads([snapshotOf(baseConnection)]);
    const result = await getPipedriveConnectionAction("workspace_1", "pipedrive_connection_1");
    if (!result.ok) throw new Error("expected ok");
    expect(result.connection.revisionFenced).toBe(false);
  });

  it("treats only the structured scoped 404 as proof of absence", async () => {
    serverApiFetch.mockRejectedValueOnce(
      new ApiRequestErrorStub(PIPEDRIVE_CONNECTION_NOT_FOUND_MESSAGE, 404),
    );
    expect(await getPipedriveConnectionAction("workspace_1", "pipedrive_connection_1")).toEqual({
      ok: false,
      reason: "not_found",
    });

    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("plain 404", 404));
    expect(await getPipedriveConnectionAction("workspace_1", "pipedrive_connection_1")).toEqual({
      ok: false,
      reason: "network",
    });

    serverApiFetch.mockRejectedValueOnce(
      new ApiRequestErrorStub("sanitized", 503, "pipedrive_persistence_failed"),
    );
    expect(await getPipedriveConnectionAction("workspace_1", "pipedrive_connection_1")).toEqual({
      ok: false,
      reason: "network",
    });
  });
});

describe("Pipedrive materialized event results", () => {
  const eventRow = (results: unknown[]) => [
    {
      id: "e1",
      status: "observed",
      errorCode: null,
      attempts: 1,
      occurredAt: "2026-10-11T11:00:00.000Z",
      createdAt: "2026-10-11T11:00:01.000Z",
      nextAttemptAt: null,
      results,
    },
  ];
  const result = (extra: Record<string, unknown>) => ({
    ruleId: "rule_1",
    eventName: "Purchase",
    status: "materialized",
    valueCents: 19990,
    currency: "BRL",
    errorCode: null,
    ...extra,
  });

  it("parses every canonical delivery status and forces deliveryRetryable=false", async () => {
    const statuses = [
      "publication_pending",
      "queued",
      "sent",
      "revoked",
      "publication_failed",
      "delivery_unknown",
      "materialized",
    ];
    serverApiFetch.mockResolvedValueOnce(
      eventRow(
        statuses.map((deliveryStatus, index) =>
          result({
            deliveryStatus,
            conversionEventLogId: `log_${index}`,
            deliveryErrorCode: deliveryStatus === "publication_failed" ? "sender_not_ready" : null,
            deliveryRetryable: true,
          }),
        ),
      ),
    );
    const parsed = await listPipedriveEventsAction("workspace_1", "pipedrive_connection_1");
    if (!parsed.ok) throw new Error("expected ok");
    const results = parsed.events[0]!.results;
    expect(results.map((item) => item.deliveryStatus)).toEqual(statuses);
    expect(results.every((item) => item.deliveryRetryable === false)).toBe(true);
    expect(results[4]).toMatchObject({ deliveryErrorCode: "sender_not_ready", conversionEventLogId: "log_4" });
  });

  it("accepts results without any delivery fields (older observation rows)", async () => {
    serverApiFetch.mockResolvedValueOnce(eventRow([{ ...result({}), status: "observed" }]));
    const parsed = await listPipedriveEventsAction("workspace_1", "pipedrive_connection_1");
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.events[0]!.results[0]).toMatchObject({
      status: "observed",
      conversionEventLogId: null,
      deliveryStatus: null,
      deliveryRetryable: false,
    });
  });

  it("maps an unknown delivery status to unrecognized instead of assuming sent", async () => {
    serverApiFetch.mockResolvedValueOnce(eventRow([result({ deliveryStatus: "teleported" })]));
    const parsed = await listPipedriveEventsAction("workspace_1", "pipedrive_connection_1");
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.events[0]!.results[0]!.deliveryStatus).toBe("unrecognized");
  });

  it("rejects unsafe ids, error codes and non-string statuses as an invalid response", async () => {
    for (const bad of [
      { conversionEventLogId: "log with spaces/<script>" },
      { deliveryErrorCode: "Provider said: boom" },
      { deliveryStatus: 7 },
      { deliveryRetryable: "yes" },
    ]) {
      serverApiFetch.mockResolvedValueOnce(eventRow([result(bad)]));
      expect(await listPipedriveEventsAction("workspace_1", "pipedrive_connection_1")).toEqual({
        ok: false,
        reason: "invalid_response",
      });
    }
  });
});

describe("Pipedrive production conflict messages", () => {
  it("localizes the production gate and context conflicts without provider text", async () => {
    serverApiFetch.mockRejectedValueOnce(
      new ApiRequestErrorStub("pipedrive_production_disabled", 409),
    );
    const disabled = await updatePipedriveRuleAction(
      form({ ...ids, ruleId: "rule_1", payload: JSON.stringify({ mode: "production" }) }),
    );
    expect(disabled.ok).toBe(false);
    expect(disabled.message).toMatch(/envio automático/i);
    expect(disabled.message).not.toMatch(/pipedrive_production/);
    expect(disabled.outcomeUnknown).toBeFalsy();

    serverApiFetch.mockRejectedValueOnce(
      new ApiRequestErrorStub("Provider said: nope", 409, "pipedrive_production_disabled"),
    );
    const foreign = await updatePipedriveRuleAction(
      form({ ...ids, ruleId: "rule_1", payload: JSON.stringify({ mode: "production" }) }),
    );
    expect(foreign.ok).toBe(false);
    expect(foreign.message).not.toMatch(/Provider said/);

    serverApiFetch.mockRejectedValueOnce(
      new ApiRequestErrorStub("pipedrive_production_context_invalid", 409),
    );
    const context = await updatePipedriveRuleAction(
      form({ ...ids, ruleId: "rule_1", payload: JSON.stringify({ mode: "production" }) }),
    );
    expect(context.ok).toBe(false);
    expect(context.message).toMatch(/requisitos do envio automático/);
  });
});
