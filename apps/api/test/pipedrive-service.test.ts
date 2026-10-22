import { createCipheriv, createDecipheriv } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PIPEDRIVE_CONNECTION_NOT_FOUND_MESSAGE,
  pipedriveConnectionSchema,
  pipedrivePipelineSchema,
} from "@wpptrack/shared";
import { PipedriveAdapterError } from "../src/pipedrive/pipedrive.adapter";
import {
  actor,
  createInput,
  deferred,
  pipedriveHarness,
} from "./support/pipedrive-harness";

const key = Buffer.alloc(32, 7).toString("base64");
beforeEach(() => vi.stubEnv("PIPEDRIVE_CRM_ENCRYPTION_KEY", key));
afterEach(() => vi.unstubAllEnvs());
async function connected() {
  const h = pipedriveHarness();
  const result = await h.service.create("workspace-a", actor, createInput);
  return { ...h, id: result.id, result };
}

describe("Pipedrive connections and catalog", () => {
  it("creates sealed credentials and shared DTOs with ordered stages and empty pipelines", async () => {
    const h = await connected();
    expect(pipedriveConnectionSchema.safeParse(h.result).success).toBe(true);
    expect(h.result.pipelines.map((p) => p.id)).toEqual(["1", "2"]);
    expect(h.result.pipelines[0]!.stages.map((s) => s.id)).toEqual([
      "11",
      "12",
    ]);
    expect(h.result.pipelines[1]!.stages).toEqual([]);
    h.result.pipelines.forEach((p) =>
      expect(pipedrivePipelineSchema.safeParse(p).success).toBe(true),
    );
    const row = h.state.pipedriveConnection![0]!;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "base64"),
      Buffer.from(row.accessTokenIv, "base64"),
    );
    decipher.setAAD(
      Buffer.from(`wpptrack:pipedrive-token:v1:${row.workspaceId}:${row.id}`),
    );
    decipher.setAuthTag(Buffer.from(row.accessTokenTag, "base64"));
    expect(
      Buffer.concat([
        decipher.update(Buffer.from(row.accessTokenEncrypted, "base64")),
        decipher.final(),
      ]).toString(),
    ).toBe(createInput.apiToken);
    expect(row.accessTokenEncrypted).not.toBe(createInput.apiToken);
    const publicText = JSON.stringify([
      h.result,
      await h.service.list("workspace-a"),
      h.state.auditLog,
    ]);
    for (const secret of [
      createInput.apiToken,
      row.accessTokenEncrypted,
      row.accessTokenIv,
      row.accessTokenTag,
    ])
      expect(publicText).not.toContain(secret);
    expect(publicText).not.toMatch(
      /webhookUrl|accessToken|apiToken|credentialGeneration/,
    );
  });
  it.each([
    undefined,
    "",
    "bad",
    Buffer.alloc(31).toString("base64"),
    key.slice(0, -2) + "B=",
  ])("fails closed for encryption configuration %s", async (value) => {
    vi.stubEnv("PIPEDRIVE_CRM_ENCRYPTION_KEY", value);
    vi.stubEnv("KOMMO_CRM_ENCRYPTION_KEY", key);
    const h = pipedriveHarness();
    await expect(
      h.service.create("workspace-a", actor, createInput),
    ).rejects.toMatchObject({ status: 503 });
    expect(h.adapter.verify).not.toHaveBeenCalled();
    expect(h.state.pipedriveConnection).toHaveLength(0);
  });
  it("lists only owned connections and hides foreign/missing IDs identically for every operation", async () => {
    const h = await connected();
    expect(await h.service.list("workspace-b")).toEqual([]);
    for (const id of [h.id, "missing"]) {
      for (const operation of [
        () => h.service.get("workspace-b", id),
        () => h.service.refreshCatalog("workspace-b", id),
        () =>
          h.service.replaceCredential("workspace-b", id, actor, {
            apiToken: createInput.apiToken,
          }),
        () => h.service.setStatus("workspace-b", id, actor, "paused"),
        () => h.service.setChannelBindings("workspace-b", id, actor, []),
        () => h.service.remove("workspace-b", id, actor),
      ])
        await expect(operation()).rejects.toMatchObject({
          status: 404,
          message: PIPEDRIVE_CONNECTION_NOT_FOUND_MESSAGE,
        });
    }
    expect(h.state.pipedriveConnection).toHaveLength(1);
    expect(h.adapter.verify).toHaveBeenCalledTimes(2);
  });
  it.each([
    "workspace",
    "channel",
    "instance",
    "parser",
    "business",
    "credential",
    "reporting",
    "destination",
    "inactive",
    "unvalidated",
  ])("rejects unavailable channel ownership/policy: %s", async (kind) => {
    const h = pipedriveHarness();
    if (kind === "workspace") h.route.workspaceId = "workspace-b";
    if (kind === "channel") h.route.channel.workspaceId = "workspace-b";
    if (kind === "instance")
      h.route.channel.whatsappInstance.workspaceId = "workspace-b";
    if (kind === "parser")
      h.route.channel.connection.parserRelease.status = "draft";
    if (kind === "business")
      h.route.metaBusinessConnection.workspaceId = "workspace-b";
    if (kind === "credential")
      h.route.metaBusinessConnection.credential.status = "revoked";
    if (kind === "reporting")
      h.route.metaReportingAccount.businessConnectionId = "business-b";
    if (kind === "destination")
      h.route.metaConversionDestination.status = "pending";
    if (kind === "inactive") h.route.active = false;
    if (kind === "unvalidated") h.route.validationStatus = "invalid";
    await expect(
      h.service.create("workspace-a", actor, createInput),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.state.pipedriveConnection).toHaveLength(0);
    expect(h.adapter.verify).not.toHaveBeenCalled();
  });
  it("rechecks channel policy transactionally after upstream verification", async () => {
    const h = pipedriveHarness();
    h.adapter.verify.mockImplementationOnce(async () => {
      h.route.channel.status = "paused";
      return { id: "1", subdomain: "synthetic" };
    });
    await expect(
      h.service.create("workspace-a", actor, createInput),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.state.pipedriveConnection).toHaveLength(0);
  });
  it("updates status/bindings and deletes stage children before their pipeline and connection", async () => {
    const h = await connected();
    expect(
      (await h.service.setStatus("workspace-a", h.id, actor, "paused")).status,
    ).toBe("paused");
    expect(
      (await h.service.setChannelBindings("workspace-a", h.id, actor, []))
        .allowedChannelRouteIds,
    ).toEqual([]);
    h.route.channel.status = "paused";
    await expect(
      h.service.setChannelBindings("workspace-a", h.id, actor, ["route-a"]),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (await h.service.get("workspace-a", h.id)).allowedChannelRouteIds,
    ).toEqual([]);
    expect(await h.service.remove("workspace-a", h.id, actor)).toEqual({
      status: "deleted",
    });
    expect(h.state.pipedriveStageCatalog).toHaveLength(0);
    expect(h.state.pipedrivePipelineCatalog).toHaveLength(0);
    expect(h.state.pipedriveConnection).toHaveLength(0);
    expect(
      h.client.pipedriveStageCatalog.deleteMany.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(
      h.client.pipedrivePipelineCatalog.deleteMany.mock.invocationCallOrder.at(
        -1,
      )!,
    );
    expect(
      h.client.pipedrivePipelineCatalog.deleteMany.mock.invocationCallOrder.at(
        -1,
      ),
    ).toBeLessThan(
      h.client.pipedriveConnection.deleteMany.mock.invocationCallOrder.at(-1)!,
    );
  });
  it("replaces a same-account token with a new generation and preserves paused status/bindings", async () => {
    const h = await connected();
    await h.service.setStatus("workspace-a", h.id, actor, "paused");
    const ciphertext = h.state.pipedriveConnection![0]!.accessTokenEncrypted;
    const result = await h.service.replaceCredential(
      "workspace-a",
      h.id,
      actor,
      { apiToken: "synthetic-replacement-token" },
    );
    expect(result.status).toBe("paused");
    expect(result.allowedChannelRouteIds).toEqual(["route-a"]);
    expect(h.state.pipedriveConnection![0]!.credentialGeneration).toBe(2);
    expect(h.state.pipedriveConnection![0]!.accessTokenEncrypted).not.toBe(
      ciphertext,
    );
    expect(h.adapter.listPipelines).toHaveBeenLastCalledWith(
      createInput.accountOrigin,
      "synthetic-replacement-token",
    );
  });
  it("invalidates bindings and catalogs before fetching a changed account, even if refresh fails", async () => {
    const h = await connected();
    h.adapter.verify.mockResolvedValue({
      id: "2",
      subdomain: "other-synthetic",
    });
    h.adapter.listPipelines.mockRejectedValueOnce(
      new PipedriveAdapterError("pipedrive_rate_limited"),
    );
    await expect(
      h.service.replaceCredential("workspace-a", h.id, actor, {
        accountOrigin: "https://other-synthetic.pipedrive.com",
        apiToken: "synthetic-second-token",
      }),
    ).rejects.toMatchObject({ status: 502 });
    const result = await h.service.get("workspace-a", h.id);
    expect(result.verifiedAccountId).toBe("2");
    expect(result.allowedChannelRouteIds).toEqual([]);
    expect(result.pipelines).toEqual([]);
    expect(result.catalogRefreshedAt).toBeNull();
    expect(result.catalogState).toBe("error");
  });
  it.each([
    "pipedrive_unauthorized",
    "pipedrive_rate_limited",
    "pipedrive_invalid_response",
    "pipedrive_transport",
  ] as const)(
    "sanitizes adapter failures %s and retains the last catalog",
    async (code) => {
      const h = await connected();
      const error = new PipedriveAdapterError(code);
      error.message = `private-upstream ${createInput.apiToken}`;
      h.adapter.listPipelines.mockRejectedValueOnce(error);
      await expect(
        h.service.refreshCatalog("workspace-a", h.id),
      ).rejects.toMatchObject({ status: 502, message: code });
      const result = await h.service.get("workspace-a", h.id);
      expect(result.catalogState).toBe("stale");
      expect(result.lastErrorCode).toBe(code);
      expect(result.credentialHealthy).toBe(code !== "pipedrive_unauthorized");
      expect(result.pipelines).toHaveLength(2);
      expect(JSON.stringify([result, h.state.auditLog])).not.toContain(
        error.message,
      );
      if (code === "pipedrive_unauthorized")
        await expect(
          h.service.setStatus("workspace-a", h.id, actor, "active"),
        ).rejects.toMatchObject({ status: 409 });
    },
  );
  it("sanitizes unexpected upstream text and rejects invalid verification without persisting", async () => {
    const h = pipedriveHarness();
    h.adapter.verify.mockRejectedValueOnce(
      new Error(`private ${createInput.apiToken}`),
    );
    await expect(
      h.service.create("workspace-a", actor, createInput),
    ).rejects.toMatchObject({ status: 502, message: "pipedrive_transport" });
    expect(h.state.pipedriveConnection).toHaveLength(0);
  });
  it("keeps the old credential when replacement verification fails", async () => {
    const h = await connected();
    const before = structuredClone(h.state);
    h.adapter.verify.mockRejectedValueOnce(
      new PipedriveAdapterError("pipedrive_unauthorized"),
    );
    await expect(
      h.service.replaceCredential("workspace-a", h.id, actor, {
        apiToken: "synthetic-invalid-token",
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(h.state).toEqual(before);
  });
  it("marks missing pipeline/stage rows unavailable while preserving correct joins and empty pipelines", async () => {
    const h = await connected();
    h.adapter.listPipelines.mockResolvedValueOnce([
      {
        id: "2",
        name: "Now populated",
        sort: null,
        stages: [{ id: "11", name: "Moved", sort: null }],
      },
    ]);
    const result = await h.service.refreshCatalog("workspace-a", h.id);
    expect(result.pipelines).toEqual([
      {
        id: "2",
        name: "Now populated",
        sort: null,
        stages: [{ id: "11", name: "Moved", sort: null }],
      },
    ]);
    expect(
      h.state.pipedrivePipelineCatalog!.find((row) => row.pipelineId === "1")!
        .available,
    ).toBe(false);
    expect(
      h.state
        .pipedriveStageCatalog!.filter((row) => row.pipelineId === "1")
        .every((row) => !row.available),
    ).toBe(true);
    h.adapter.listPipelines.mockResolvedValueOnce([]);
    expect(
      (await h.service.refreshCatalog("workspace-a", h.id)).pipelines,
    ).toEqual([]);
  });
  it.each(["id", "workspaceId", "tag", "key", "kommo"])(
    "fails credential authentication for altered %s without upstream access",
    async (kind) => {
      const h = await connected();
      const row = h.state.pipedriveConnection![0]!;
      if (kind === "id") row.id = "swapped-id";
      if (kind === "workspaceId") row.workspaceId = "workspace-b";
      if (kind === "tag")
        row.accessTokenTag = Buffer.alloc(16).toString("base64");
      if (kind === "key")
        vi.stubEnv(
          "PIPEDRIVE_CRM_ENCRYPTION_KEY",
          Buffer.alloc(32, 8).toString("base64"),
        );
      if (kind === "kommo") {
        // The Kommo key must differ from the Pipedrive key (boot validation).
        const kommoKey = Buffer.alloc(32, 9).toString("base64");
        vi.stubEnv("KOMMO_CRM_ENCRYPTION_KEY", kommoKey);
        const iv = Buffer.alloc(12, 3);
        const cipher = createCipheriv(
          "aes-256-gcm",
          Buffer.from(kommoKey, "base64"),
          iv,
        );
        cipher.setAAD(Buffer.from(`wpptrack:kommo-token:v1:${row.id}`));
        row.accessTokenEncrypted = Buffer.concat([
          cipher.update(createInput.apiToken, "utf8"),
          cipher.final(),
        ]).toString("base64");
        row.accessTokenIv = iv.toString("base64");
        row.accessTokenTag = cipher.getAuthTag().toString("base64");
      }
      h.adapter.verify.mockClear();
      h.adapter.listPipelines.mockClear();
      await expect(
        h.service.refreshCatalog(row.workspaceId, row.id),
      ).rejects.toMatchObject({
        status: 503,
        message: "credential_decrypt_failed",
      });
      expect(h.adapter.verify).not.toHaveBeenCalled();
      expect(h.adapter.listPipelines).not.toHaveBeenCalled();
      expect(row.credentialHealthy).toBe(false);
    },
  );
  it("rejects duplicate accounts within a workspace with a safe conflict", async () => {
    const h = await connected();
    await expect(
      h.service.create("workspace-a", actor, createInput),
    ).rejects.toMatchObject({
      status: 409,
      message: "Conta Pipedrive já conectada neste workspace",
    });
    expect(h.state.pipedriveConnection).toHaveLength(1);
    expect(h.state.auditLog).toHaveLength(1);
  });
});

describe("Pipedrive transactional generation fences", () => {
  it("preserves bindings when replacement merely normalizes the same account origin", async () => {
    const h = await connected();
    const result = await h.service.replaceCredential(
      "workspace-a",
      h.id,
      actor,
      {
        accountOrigin: `${createInput.accountOrigin}/`,
        apiToken: "synthetic-next-token",
      },
    );
    expect(result.allowedChannelRouteIds).toEqual(["route-a"]);
    expect(result.accountOrigin).toBe(createInput.accountOrigin);
  });

  it("isolates overlapping catalog IDs across workspaces and owned connections", async () => {
    const h = await connected();
    const foreign = await h.service.create("workspace-b", actor, {
      ...createInput,
      allowedChannelRouteIds: [],
    });
    h.adapter.verify.mockResolvedValue({ id: "2", subdomain: "synthetic" });
    const neighbor = await h.service.create("workspace-a", actor, {
      ...createInput,
      allowedChannelRouteIds: [],
    });
    const preserved = structuredClone(
      h.state.pipedrivePipelineCatalog!.filter(
        (row) => row.connectionId !== h.id,
      ),
    );
    await h.service.remove("workspace-a", h.id, actor);
    expect(h.state.pipedrivePipelineCatalog).toEqual(preserved);
    expect(
      (await h.service.get("workspace-a", neighbor.id)).pipelines,
    ).toHaveLength(2);
    expect(
      (await h.service.get("workspace-b", foreign.id)).pipelines,
    ).toHaveLength(2);
    expect(await h.service.list("workspace-a")).toHaveLength(1);
    expect(await h.service.list("workspace-b")).toHaveLength(1);
  });

  it("rolls back account-swap invalidation when credential persistence fails", async () => {
    const h = await connected();
    const before = structuredClone(h.state);
    h.adapter.verify.mockResolvedValue({
      id: "2",
      subdomain: "other-synthetic",
    });
    h.client.pipedriveConnection.updateMany.mockRejectedValueOnce(
      new Error("synthetic-private-database-text"),
    );
    await expect(
      h.service.replaceCredential("workspace-a", h.id, actor, {
        accountOrigin: "https://other-synthetic.pipedrive.com",
        apiToken: "synthetic-next-token",
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: "pipedrive_persistence_failed",
    });
    expect(h.state).toEqual(before);
  });
  it("preserves an explicit pause through a failed refresh and later credential recovery", async () => {
    const h = await connected();
    await h.service.setStatus("workspace-a", h.id, actor, "paused");
    h.adapter.verify.mockRejectedValueOnce(
      new PipedriveAdapterError("pipedrive_unauthorized"),
    );
    await expect(
      h.service.refreshCatalog("workspace-a", h.id),
    ).rejects.toMatchObject({ status: 502 });
    expect((await h.service.get("workspace-a", h.id)).status).toBe("paused");
    expect((await h.service.refreshCatalog("workspace-a", h.id)).status).toBe(
      "paused",
    );
  });

  it("fails closed on missing encryption configuration during replacement/refresh without changing existing state", async () => {
    const h = await connected();
    const before = structuredClone(h.state);
    h.adapter.verify.mockClear();
    vi.stubEnv("PIPEDRIVE_CRM_ENCRYPTION_KEY", undefined);
    await expect(
      h.service.replaceCredential("workspace-a", h.id, actor, {
        apiToken: "synthetic-next-token",
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: "pipedrive_encryption_key_invalid",
    });
    await expect(
      h.service.refreshCatalog("workspace-a", h.id),
    ).rejects.toMatchObject({
      status: 503,
      message: "pipedrive_encryption_key_invalid",
    });
    expect(h.state).toEqual(before);
    expect(h.adapter.verify).not.toHaveBeenCalled();
  });

  it("marks an aging catalog stale in both connection reads without changing the stored snapshot", async () => {
    const h = await connected();
    h.state.pipedriveConnection![0]!.catalogRefreshedAt = new Date(
      Date.now() - 16 * 60_000,
    );
    expect((await h.service.get("workspace-a", h.id)).catalogState).toBe(
      "stale",
    );
    expect((await h.service.list("workspace-a"))[0]!.catalogState).toBe(
      "stale",
    );
    expect(h.state.pipedriveConnection![0]!.catalogState).toBe("fresh");
  });
  it.each(["success", "failure"])(
    "does not let stale catalog %s overwrite a replacement account",
    async (outcome) => {
      const h = await connected();
      const pending =
        deferred<Awaited<ReturnType<typeof h.adapter.listPipelines>>>();
      const started = deferred<void>();
      h.adapter.listPipelines.mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      });
      const refresh = h.service.refreshCatalog("workspace-a", h.id);
      const check = expect(refresh).rejects.toMatchObject({ status: 409 });
      await started.promise;
      h.adapter.verify.mockResolvedValue({
        id: "2",
        subdomain: "other-synthetic",
      });
      h.adapter.listPipelines.mockResolvedValue([
        { id: "3", name: "New account", sort: 1, stages: [] },
      ]);
      await h.service.replaceCredential("workspace-a", h.id, actor, {
        accountOrigin: "https://other-synthetic.pipedrive.com",
        apiToken: "synthetic-next-token",
      });
      const before = structuredClone(h.state);
      if (outcome === "success")
        pending.resolve([
          { id: "9", name: "Old account", sort: 1, stages: [] },
        ]);
      else pending.reject(new PipedriveAdapterError("pipedrive_unauthorized"));
      await check;
      expect(h.state).toEqual(before);
    },
  );
  it.each([false, true])(
    "rejects delayed verification after a newer replacement (explicit origin %s)",
    async (explicit) => {
      const h = await connected();
      const pending = deferred<{ id: string; subdomain: string }>();
      const started = deferred<void>();
      h.adapter.verify.mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      });
      const first = h.service.replaceCredential("workspace-a", h.id, actor, {
        apiToken: "synthetic-old-delayed-token",
        ...(explicit ? { accountOrigin: createInput.accountOrigin } : {}),
      });
      const check = expect(first).rejects.toMatchObject({ status: 409 });
      await started.promise;
      await h.service.replaceCredential("workspace-a", h.id, actor, {
        apiToken: "synthetic-current-token",
      });
      const before = structuredClone(h.state);
      pending.resolve({ id: "1", subdomain: "synthetic" });
      await check;
      expect(h.state).toEqual(before);
    },
  );
  it("does not resurrect a removed connection after a delayed refresh", async () => {
    const h = await connected();
    const pending =
      deferred<Awaited<ReturnType<typeof h.adapter.listPipelines>>>();
    const started = deferred<void>();
    h.adapter.listPipelines.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const refresh = h.service.refreshCatalog("workspace-a", h.id);
    const check = expect(refresh).rejects.toMatchObject({ status: 404 });
    await started.promise;
    await h.service.remove("workspace-a", h.id, actor);
    pending.resolve([]);
    await check;
    expect(h.state.pipedriveConnection).toHaveLength(0);
    expect(h.state.pipedrivePipelineCatalog).toHaveLength(0);
  });
  it("blocks an upstream account mismatch and clears old bindings and catalog", async () => {
    const h = await connected();
    h.adapter.verify.mockResolvedValueOnce({ id: "2", subdomain: "synthetic" });
    h.adapter.listPipelines.mockClear();
    await expect(
      h.service.refreshCatalog("workspace-a", h.id),
    ).rejects.toMatchObject({
      status: 502,
      message: "pipedrive_account_mismatch",
    });
    const result = await h.service.get("workspace-a", h.id);
    expect(result.status).toBe("blocked");
    expect(result.allowedChannelRouteIds).toEqual([]);
    expect(result.pipelines).toEqual([]);
    expect(h.adapter.listPipelines).not.toHaveBeenCalled();
  });
  it("rolls back a failed catalog write instead of publishing a partial snapshot", async () => {
    const h = await connected();
    const before = structuredClone({
      pipelines: h.state.pipedrivePipelineCatalog,
      stages: h.state.pipedriveStageCatalog,
    });
    h.adapter.listPipelines.mockResolvedValueOnce([
      {
        id: "3",
        name: "New snapshot",
        sort: 1,
        stages: [{ id: "13", name: "New stage", sort: 1 }],
      },
    ]);
    h.client.pipedriveStageCatalog.create.mockRejectedValueOnce(
      new Error("synthetic-private-database-text"),
    );
    await expect(
      h.service.refreshCatalog("workspace-a", h.id),
    ).rejects.toMatchObject({
      status: 503,
      message: "pipedrive_persistence_failed",
    });
    expect({
      pipelines: h.state.pipedrivePipelineCatalog,
      stages: h.state.pipedriveStageCatalog,
    }).toEqual(before);
  });
});
