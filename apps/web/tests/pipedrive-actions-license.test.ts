import { afterEach, describe, expect, it, vi } from "vitest";

const { revalidatePath, serverApiFetch, ApiRequestErrorStub, LicenseLockedErrorStub } =
  vi.hoisted(() => {
    class ApiRequestErrorStub extends Error {
      status: number;
      constructor(message: string, status = 409) {
        super(message);
        this.status = status;
      }
    }
    class LicenseLockedErrorStub extends ApiRequestErrorStub {
      constructor(message = "Licença não utilizável") {
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
  replacePipedriveCredentialAction,
  retryPipedriveEventAction,
  revokePipedriveWebhookSecretAction,
  rotatePipedriveWebhookSecretAction,
  setPipedriveChannelBindingsAction,
  setPipedriveConnectionStatusAction,
  updatePipedriveRuleAction,
} from "../src/app/(app)/integrations/pipedrive-actions";
import { licenseLockedActionMessage } from "../src/lib/license-locked-message";
import { baseConnection, baseRule, snapshotOf } from "./support/pipedrive-fixtures";

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
const origin = "https://suaempresa.pipedrive.com";
const token = "synthetic-token-0123456789";

const writes: Array<[string, () => Promise<{ ok: boolean; message: string }>]> = [
  [
    "create connection",
    () =>
      createPipedriveConnectionAction(
        form({
          workspaceId: "workspace_1",
          payload: JSON.stringify({
            displayName: "Pipedrive principal",
            accountOrigin: origin,
            apiToken: token,
            allowedChannelRouteIds: [],
          }),
        }),
      ),
  ],
  [
    "replace credential",
    () =>
      replacePipedriveCredentialAction(
        form({ ...ids, payload: JSON.stringify({ apiToken: token }) }),
      ),
  ],
  [
    "pause connection",
    () => setPipedriveConnectionStatusAction(form({ ...ids, status: "paused" })),
  ],
  [
    "channel bindings",
    () =>
      setPipedriveChannelBindingsAction(
        form({ ...ids, payload: JSON.stringify({ allowedChannelRouteIds: ["route_1"] }) }),
      ),
  ],
  ["refresh catalog", () => refreshPipedriveCatalogAction(form(ids))],
  ["delete connection", () => deletePipedriveConnectionAction(form(ids))],
  ["generate webhook URL", () => rotatePipedriveWebhookSecretAction(form(ids))],
  ["revoke webhook URL", () => revokePipedriveWebhookSecretAction(form(ids))],
  [
    "create rule",
    () =>
      createPipedriveRuleAction(
        form({
          ...ids,
          payload: JSON.stringify({
            name: "Ganho",
            trigger: "stage_change",
            pipelineId: "pipeline_1",
            stageId: "stage_3",
            eventName: "Purchase",
            mode: "observation",
            valueMode: "deal",
            currency: "BRL",
          }),
        }),
      ),
  ],
  [
    "update rule",
    () =>
      updatePipedriveRuleAction(
        form({ ...ids, ruleId: "rule_1", payload: JSON.stringify({ active: false }) }),
      ),
  ],
  ["delete rule", () => deletePipedriveRuleAction(form({ ...ids, ruleId: "rule_1" }))],
  ["retry event", () => retryPipedriveEventAction(form({ ...ids, eventId: "event_1" }))],
];

describe("Pipedrive writes refused by the license guard (HTTP 423)", () => {
  it.each(writes)("flags %s as license-locked, definitive and without side effects", async (_name, run) => {
    serverApiFetch.mockRejectedValueOnce(new LicenseLockedErrorStub());

    const result = await run();

    expect(result).toEqual({
      ok: false,
      message: licenseLockedActionMessage,
      licenseLocked: true,
    });
    expect(result).not.toHaveProperty("outcomeUnknown");
    expect(result).not.toHaveProperty("authFailure");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("never leaks the API text of the 423 and keeps other 4xx without the lock flag", async () => {
    serverApiFetch.mockRejectedValueOnce(
      new LicenseLockedErrorStub("Mensagem interna da licença com detalhes"),
    );
    const locked = await refreshPipedriveCatalogAction(form(ids));
    expect(locked.message).not.toContain("detalhes");

    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("anything", 409));
    const other = await refreshPipedriveCatalogAction(form(ids));
    expect(other.licenseLocked).toBeUndefined();
    expect(other.ok).toBe(false);
  });

  it("keeps the reads working while the license is locked", async () => {
    const snapshot = snapshotOf(baseConnection);
    const base = "/workspaces/workspace_1/pipedrive/connections";
    serverApiFetch.mockImplementation(async (path: string) => {
      if (path === base) return [{ ...snapshot, pipelines: undefined }];
      if (path === `${base}/pipedrive_connection_1`) return snapshot;
      if (path === `${base}/pipedrive_connection_1/rules`) return [baseRule];
      if (path === `${base}/pipedrive_connection_1/events`) return [];
      throw new Error(`unexpected ${path}`);
    });

    const list = await listPipedriveConnectionsAction("workspace_1");
    expect(list.ok).toBe(true);
    const detail = await getPipedriveConnectionAction("workspace_1", "pipedrive_connection_1");
    expect(detail.ok).toBe(true);
    const events = await listPipedriveEventsAction("workspace_1", "pipedrive_connection_1");
    expect(events).toEqual({ ok: true, events: [] });
  });
});
