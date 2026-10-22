import { LicenseClientModule } from "../src/licensing-client/license-client.module";
import { OfflinePipedriveLicenseModule } from "./support/pipedrive-http-harness";
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PipedriveModule } from "../src/pipedrive/pipedrive.module";
import { PipedriveWebhookService } from "../src/pipedrive/pipedrive-webhook.service";
import { PipedriveWebhookWorker } from "../src/pipedrive/pipedrive-webhook.worker";
import { PipedriveService } from "../src/pipedrive/pipedrive.service";
import { PipedriveAdapter } from "../src/pipedrive/pipedrive.adapter";
import { ConversionEventsService } from "../src/conversion-events/conversion-events.service";
import { ConversionEventsQueueService } from "../src/common/queue/conversion-events-queue.service";
import { ConversionEventProcessor } from "../src/common/queue/conversion-event.processor";
import { QueueModule } from "../src/common/queue/queue.module";
import { IntegrationsModule } from "../src/integrations/integrations.module";
import { MetaCapiAdapter } from "../src/conversion-events/meta-capi.adapter";
import { MetaConnectionResolverService } from "../src/integrations/meta/meta-connection-resolver.service";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { AuthService } from "../src/auth/auth.service";
import { configureInboundWebhookBodyParser } from "../src/inbound-webhooks/inbound-webhook-body-parser";
import {
  productionEnv,
  productionHarness,
} from "./support/pipedrive-production-harness";
import {
  dispatch,
  OfflinePipedriveQueueModule,
  OfflinePipedriveIntegrationsModule,
} from "./support/pipedrive-http-harness";
import { payload, ruleInput } from "./support/pipedrive-observation-harness";

beforeEach(productionEnv);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("offline real Nest DI: owner activation -> durable HTTP202 -> worker -> canonical queue/processor -> injected CAPI -> visible sent", async () => {
  const h = await productionHarness();
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
    .overrideProvider(MetaConnectionResolverService)
    .useValue(h.resolver)
    .overrideProvider(MetaCapiAdapter)
    .useValue(
      new MetaCapiAdapter(
        { META_CAPI_ACCESS_TOKEN: "synthetic-global-fallback" },
        h.fetcher as any,
      ),
    )
    .overrideProvider(ConversionEventsQueueService)
    .useValue(h.queue)
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
  mod.get(PipedriveService).now = () => h.now;
  const conversions = mod.get(ConversionEventsService);
  const ownerHeaders = { authorization: "Bearer synthetic-session" };
  const base = `/workspaces/workspace-a/pipedrive/connections/${h.c.id}`;
  try {
    await app.init();
    expect(
      await dispatch(
        app,
        "GET",
        `${base}/capabilities`,
        Buffer.alloc(0),
        ownerHeaders,
      ),
    ).toMatchObject({
      status: 200,
      body: {
        productionEnabled: true,
        historicalReplay: false,
        unknownDeliveryRetry: false,
      },
    });
    const created = await dispatch(
      app,
      "POST",
      `${base}/rules`,
      Buffer.from(JSON.stringify({ ...ruleInput, mode: "production" })),
      ownerHeaders,
    );
    expect(created).toMatchObject({
      status: 201,
      body: { mode: "production", productionActivatedAt: h.now.toISOString() },
    });
    h.setNow(new Date(+h.now + 1000));
    const publicUrl = `/webhooks/pipedrive/v1/${h.c.id}?token=${h.secret}`;
    expect(
      await dispatch(app, "POST", publicUrl, payload(h.now)),
    ).toMatchObject({ status: 202, body: { status: "accepted" } });
    expect(h.adapter.getPerson).not.toHaveBeenCalled();
    expect(h.state.conversionEventLog).toHaveLength(0);
    await new PipedriveWebhookWorker(webhooks).tick();
    expect(h.state.conversionEventLog).toHaveLength(1);
    expect(h.jobs.size).toBe(1);
    expect(h.fetcher).not.toHaveBeenCalled();
    const log = h.state.conversionEventLog![0]!;
    const processor = new ConversionEventProcessor(conversions, h.client);
    expect(
      await processor.process({
        id: "synthetic-job",
        name: "send-ready-event",
        data: { conversionEventLogId: log.id, workspaceId: "workspace-a" },
        attemptsMade: 0,
      } as any),
    ).toMatchObject({ status: "sent" });
    const events = await dispatch(
      app,
      "GET",
      `${base}/events`,
      Buffer.alloc(0),
      ownerHeaders,
    );
    expect(events).toMatchObject({
      status: 200,
      body: [
        expect.objectContaining({
          status: "materialized",
          results: [
            expect.objectContaining({
              conversionEventLogId: log.id,
              deliveryStatus: "sent",
            }),
          ],
        }),
      ],
    });
    expect(h.fetcher).toHaveBeenCalledOnce();
    expect(
      await dispatch(app, "POST", publicUrl, payload(h.now)),
    ).toMatchObject({ status: 202 });
    await new PipedriveWebhookWorker(webhooks).tick();
    expect(h.state.conversionEventLog).toHaveLength(1);
    expect(h.fetcher).toHaveBeenCalledOnce();

    session.workspaces[0].role = "member";
    expect(
      (
        await dispatch(
          app,
          "PATCH",
          `${base}/rules/${created.body.id}`,
          Buffer.from('{"mode":"observation"}'),
          ownerHeaders,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await dispatch(
          app,
          "PATCH",
          `${base}/status`,
          Buffer.from('{"status":"paused"}'),
          ownerHeaders,
        )
      ).status,
    ).toBe(403);
    session.user.platformRole = "platform_owner";
    session.workspaces = [];
    session.supportContext = { workspaceId: "workspace-b" };
    expect(
      (
        await dispatch(
          app,
          "PATCH",
          `${base}/status`,
          Buffer.from('{"status":"paused"}'),
          ownerHeaders,
        )
      ).status,
    ).toBe(403);
    session.supportContext = { workspaceId: "workspace-a" };
    expect(
      (
        await dispatch(
          app,
          "PATCH",
          `${base}/status`,
          Buffer.from('{"status":"paused"}'),
          ownerHeaders,
        )
      ).status,
    ).toBe(200);
    expect(h.state.auditLog!.at(-1)).toMatchObject({
      actorType: "platform_admin",
      action: "pipedrive.connection_paused",
    });
  } finally {
    await app.close();
  }
});
