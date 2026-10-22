import { LicenseClientModule } from "../src/licensing-client/license-client.module";
import {
  OfflinePipedriveLicenseModule,
  offlineLicense,
} from "./support/pipedrive-http-harness";
import { IntegrationsModule } from "../src/integrations/integrations.module";
import { OfflinePipedriveIntegrationsModule } from "./support/pipedrive-http-harness";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import {
  dispatch,
  OfflinePipedriveQueueModule,
} from "./support/pipedrive-http-harness";
import { QueueModule } from "../src/common/queue/queue.module";
import { PipedriveWebhookWorker } from "../src/pipedrive/pipedrive-webhook.worker";
import { afterEach, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.service";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { PipedriveAdapter } from "../src/pipedrive/pipedrive.adapter";
import { PipedriveModule } from "../src/pipedrive/pipedrive.module";
import { createInput, pipedriveHarness } from "./support/pipedrive-harness";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("runs authenticated connection/catalog flow through real Nest/Express streams with synthetic dependencies", async () => {
  vi.stubEnv(
    "PIPEDRIVE_CRM_ENCRYPTION_KEY",
    Buffer.alloc(32, 7).toString("base64"),
  );
  const h = pipedriveHarness();
  const module = await Test.createTestingModule({ imports: [PipedriveModule] })
    .overrideModule(LicenseClientModule)
    .useModule(OfflinePipedriveLicenseModule)
    .overrideModule(IntegrationsModule)
    .useModule(OfflinePipedriveIntegrationsModule)
    .overrideModule(QueueModule)
    .useModule(OfflinePipedriveQueueModule)
    .overrideProvider(PipedriveWebhookWorker)
    .useValue({})
    .overrideProvider(PrismaService)
    .useValue(h.client)
    .overrideProvider(PipedriveAdapter)
    .useValue(h.adapter)
    .overrideProvider(AuthService)
    .useValue({
      getSession: vi.fn(async () => ({
        user: { id: "owner-a", platformRole: "user" },
        workspaces: [{ id: "workspace-a", role: "owner" }],
      })),
    })
    .compile();
  const app = module.createNestApplication();
  try {
    await app.init();
    const headers = { authorization: "Bearer synthetic-session" };
    const call = (
      method: string,
      path: string,
      body: unknown = undefined,
      authenticated = true,
    ) =>
      dispatch(
        app,
        method,
        path,
        body === undefined
          ? Buffer.alloc(0)
          : Buffer.from(JSON.stringify(body)),
        authenticated ? headers : {},
      );
    const base = "/workspaces/workspace-a/pipedrive/connections";
    expect((await call("GET", base, undefined, false)).status).toBe(401);
    const result = await call("POST", base, createInput);
    expect(result.status).toBe(201);
    expect(result.body.pipelines[1].stages).toEqual([]);
    expect(JSON.stringify(result.body)).not.toContain(createInput.apiToken);
    const path = `${base}/${result.body.id}`;
    expect((await call("GET", path)).status).toBe(200);
    expect(
      (
        await call(
          "GET",
          `/workspaces/workspace-b/pipedrive/connections/${result.body.id}`,
        )
      ).status,
    ).toBe(403);
    expect(
      (await call("PATCH", `${path}/status`, { status: "blocked" })).status,
    ).toBe(400);
    expect((await call("POST", `${path}/refresh-catalog`)).status).toBe(201);
    // Student edition: a locked license keeps reads and blocks every write
    // (management and the public webhook) with the global HTTP 423.
    // The guard caches a decision for 60s: move the clock past it.
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now").mockImplementation(
      () => realNow() + 61_000,
    );
    offlineLicense.locked = true;
    try {
      expect((await call("GET", path)).status).toBe(200);
      const locked = await call("POST", base, createInput);
      expect(locked).toMatchObject({
        status: 423,
        body: { statusCode: 423, error: "License Locked", reason: "revoked" },
      });
      expect(
        (await call("PATCH", `${path}/status`, { status: "paused" })).status,
      ).toBe(423);
      expect(
        (
          await call(
            "POST",
            `/webhooks/pipedrive/v1/${result.body.id}?token=synthetic`,
            {},
            false,
          )
        ).status,
      ).toBe(423);
      expect(h.state.pipedriveConnection).toHaveLength(1);
    } finally {
      offlineLicense.locked = false;
      clock.mockImplementation(() => realNow() + 122_000);
    }
    expect((await call("DELETE", path)).status).toBe(200);
    expect(await call("GET", path)).toMatchObject({
      status: 404,
      body: { code: "pipedrive_connection_not_found" },
    });
    expect(
      (
        await call(
          "POST",
          `/webhooks/pipedrive/v1/${result.body.id}`,
          {},
          false,
        )
      ).status,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
