import { LicenseClientModule } from "../src/licensing-client/license-client.module";
import { OfflinePipedriveLicenseModule } from "./support/pipedrive-http-harness";
import { IntegrationsModule } from "../src/integrations/integrations.module";
import { OfflinePipedriveIntegrationsModule } from "./support/pipedrive-http-harness";
import {
  dispatch,
  OfflinePipedriveQueueModule,
} from "./support/pipedrive-http-harness";
import "reflect-metadata";
import { QueueModule } from "../src/common/queue/queue.module";
import { ConversionEventsQueueService } from "../src/common/queue/conversion-events-queue.service";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { AuthService } from "../src/auth/auth.service";
import { PipedriveAdapter } from "../src/pipedrive/pipedrive.adapter";
import { PipedriveModule } from "../src/pipedrive/pipedrive.module";
import { PipedriveWebhookService } from "../src/pipedrive/pipedrive-webhook.service";
import { PipedriveWebhookWorker } from "../src/pipedrive/pipedrive-webhook.worker";
import { configureInboundWebhookBodyParser } from "../src/inbound-webhooks/inbound-webhook-body-parser";
import { sanitizeRequestPath } from "../src/common/http/request-duration.interceptor";
import {
  observationHarness,
  payload,
  ruleInput,
} from "./support/pipedrive-observation-harness";
import { actor, deferred } from "./support/pipedrive-harness";

beforeEach(() => {
  vi.stubEnv(
    "PIPEDRIVE_CRM_ENCRYPTION_KEY",
    Buffer.alloc(32, 7).toString("base64"),
  );
  vi.stubEnv("API_PUBLIC_URL", "https://api.synthetic.example.invalid");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// Drive actual Nest/Express routing, guards and production parsers through Node
// request/response streams. This does not bind a TCP socket or test a proxy/TLS.

describe("Pipedrive real Nest/Express wiring with in-memory HTTP streams", () => {
  it("authenticates management, parses bounded raw ingress, accepts durably, then observes", async () => {
    const h = observationHarness();
    const c = await h.seed();
    const session: any = {
      user: { id: "owner-a", platformRole: "user" },
      workspaces: [{ id: "workspace-a", role: "owner" }],
      supportContext: null,
    };
    const mod = await Test.createTestingModule({ imports: [PipedriveModule] })
    .overrideModule(LicenseClientModule)
    .useModule(OfflinePipedriveLicenseModule)
      .overrideModule(IntegrationsModule)
      .useModule(OfflinePipedriveIntegrationsModule)
      .overrideModule(QueueModule)
      .useModule(OfflinePipedriveQueueModule)
      .overrideProvider(PrismaService)
      .useValue(h.client)
      .overrideProvider(PipedriveAdapter)
      .useValue(h.adapter)
      .overrideProvider(AuthService)
      .useValue({ getSession: vi.fn(async () => session) })
      .overrideProvider(PipedriveWebhookWorker)
      .useValue({})
      .compile();
    const app = mod.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureInboundWebhookBodyParser(app);
    const webhooks = mod.get(PipedriveWebhookService);
    webhooks.now = () => h.now;
    try {
      await app.init();
      const base = `/workspaces/workspace-a/pipedrive/connections/${c.id}`;
      const auth = { authorization: "Bearer synthetic-session" };
      expect(
        (await dispatch(app, "POST", `${base}/webhook-secret/rotate`)).status,
      ).toBe(401);
      const issued = await dispatch(
        app,
        "POST",
        `${base}/webhook-secret/rotate`,
        undefined,
        auth,
      );
      expect(issued.status).toBe(201);
      expect(issued.headers["cache-control"]).toBe("no-store");
      const token = new URL(issued.body.webhookUrl).searchParams.get("token")!;
      expect(
        (
          await dispatch(
            app,
            "POST",
            `${base}/rules`,
            Buffer.from(JSON.stringify(ruleInput)),
            auth,
          )
        ).status,
      ).toBe(201);
      const url = `/webhooks/pipedrive/v1/${c.id}?token=${token}`;
      expect((await dispatch(app, "POST", url, payload(h.now))).status).toBe(
        202,
      );
      expect(h.adapter.getPerson).not.toHaveBeenCalled();
      await webhooks.sweep();
      expect(h.state.pipedriveWebhookEvent![0].status).toBe("observed");
      const events = await dispatch(
        app,
        "GET",
        `${base}/events`,
        undefined,
        auth,
      );
      expect(events.status).toBe(200);
      expect(events.body[0].results[0].eventName).toBe("QualifiedLead");
      expect(JSON.stringify(events.body)).not.toContain(token);
      expect(
        (await dispatch(app, "POST", url, Buffer.from('{"__proto__":{}}')))
          .status,
      ).toBe(400);
      const huge = await dispatch(app, "POST", url, Buffer.alloc(102401));
      expect(huge).toMatchObject({
        status: 413,
        body: { message: "pipedrive_payload_invalid" },
      });
      const encoding = await dispatch(
        app,
        "POST",
        url,
        Buffer.from("synthetic"),
        { "content-encoding": "gzip" },
      );
      expect(encoding.status).toBe(415);
      expect(
        (
          await dispatch(
            app,
            "POST",
            url.replace(token, "invalid"),
            payload(h.now),
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await dispatch(
            app,
            "DELETE",
            `${base}/webhook-secret`,
            undefined,
            auth,
          )
        ).status,
      ).toBe(200);
      expect((await dispatch(app, "POST", url, payload(h.now))).status).toBe(
        404,
      );
      session.workspaces = [];
      session.user.platformRole = "platform_owner";
      session.supportContext = { workspaceId: "workspace-a" };
      expect(
        (await dispatch(app, "GET", `${base}/rules`, undefined, auth)).status,
      ).toBe(200);
      session.supportContext = { workspaceId: "workspace-b" };
      expect(
        (await dispatch(app, "GET", `${base}/events`, undefined, auth)).status,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
  it("removes the entire sensitive query even with encoded or duplicate token parameter names", () => {
    for (const query of [
      "token=synthetic-secret",
      "%74oken=synthetic-secret",
      "TOKEN=synthetic-secret&token=second",
      "other=synthetic-private-text",
    ])
      expect(
        sanitizeRequestPath(`/webhooks/pipedrive/v1/connection?${query}`),
      ).toBe("/webhooks/pipedrive/v1/connection");
  });
  it("uses the canonical conversion service and queue without a direct sender or lead writer", () => {
    const service = readFileSync(
      resolve(__dirname, "../src/pipedrive/pipedrive-webhook.service.ts"),
      "utf8",
    );
    expect(service).toContain("recordExternalConversion");
    expect(service).toContain("ConversionEventsQueueService");
    expect(service).not.toMatch(
      /MetaCapi|LeadsService|upsertFromWhatsappWebhook|lead\.(?:create|upsert|update)/,
    );
  });
});

describe("Pipedrive worker lifecycle", () => {
  it("wires recurring recovery and prevents overlapping local sweeps", async () => {
    vi.useFakeTimers();
    const pending = deferred<unknown>();
    const webhooks: any = { sweep: vi.fn(() => pending.promise) };
    const worker = new PipedriveWebhookWorker(webhooks);
    worker.onModuleInit();
    expect(webhooks.sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(webhooks.sweep).toHaveBeenCalledTimes(1);
    pending.resolve({ scanned: 0 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    expect(webhooks.sweep).toHaveBeenCalledTimes(2);
    worker.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(10000);
    expect(webhooks.sweep).toHaveBeenCalledTimes(2);
  });
  it("survives a rejected sweep without exposing the error", async () => {
    const webhooks: any = {
      sweep: vi
        .fn()
        .mockRejectedValueOnce(new Error("private token"))
        .mockResolvedValue({ scanned: 0 }),
    };
    const worker = new PipedriveWebhookWorker(webhooks);
    await worker.tick();
    await worker.tick();
    expect(webhooks.sweep).toHaveBeenCalledTimes(2);
    worker.onModuleDestroy();
  });
});
