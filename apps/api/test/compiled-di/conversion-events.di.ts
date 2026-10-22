import "reflect-metadata";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studentReplayFixture } from "../support/student-replay-fixture";

// CJS require is deliberate: all class tokens and metadata must come from the
// same nest build, not Vitest's TypeScript transform (or manual constructors).
const compiledRequire = createRequire(resolve(process.cwd(), "package.json"));
const compiled = (path: string) => compiledRequire(`./dist/src/${path}`);
const { Test } = compiledRequire("@nestjs/testing");
const { Module } = compiledRequire("@nestjs/common");
const { ConversionEventsModule } = compiled(
  "conversion-events/conversion-events.module.js",
);
const { ConversionEventsService } = compiled(
  "conversion-events/conversion-events.service.js",
);
const { IntegrationsModule } = compiled("integrations/integrations.module.js");
const { MetaConnectionResolverService } = compiled(
  "integrations/meta/meta-connection-resolver.service.js",
);
const { MetaTokenEncryptionService } = compiled(
  "integrations/meta/meta-token-encryption.service.js",
);
const { MetaCapiAdapter } = compiled("conversion-events/meta-capi.adapter.js");
const { PrismaService } = compiled("common/prisma/prisma.service.js");
const { PrismaModule } = compiled("common/prisma/prisma.module.js");
const { LicenseClientService } = compiled(
  "licensing-client/license-client.service.js",
);
const { RuntimeModule, RUNTIME_ENV } = compiled(
  "common/runtime/runtime.module.js",
);
const { INTEGRATION_ENV } = compiled("integrations/integration.types.js");
const { ConversionEventProcessor } = compiled(
  "common/queue/conversion-event.processor.js",
);
const { DiagnosticsService } = compiled("diagnostics/diagnostics.service.js");
const { ConversionEventsQueueService } = compiled(
  "common/queue/conversion-events-queue.service.js",
);

const modules: any[] = [];
afterEach(async () => {
  for (const module of modules.splice(0)) await module.close();
  vi.restoreAllMocks();
});

async function fixture(mode: "production" | "replay" = "production") {
  const h = studentReplayFixture();
  const token = "synthetic-owned-manual-bm-token";
  const env = {
    ...h.env,
    API_PUBLIC_URL: "http://localhost:3333",
    META_TOKEN_ENCRYPTION_KEY: "synthetic-encryption-key",
  };
  // Synthetic persistence only; no Prisma client, Redis, sockets or provider I/O.
  Object.assign(h.prisma, {
    providerConversionRuleExecution: { findFirst: vi.fn(async () => null) },
    integrationLog: { create: vi.fn(async () => ({ id: "integration-log" })) },
    diagnosticEvent: { create: vi.fn(async () => ({ id: "diagnostic" })) },
    purchaseReview: { updateMany: vi.fn(async () => ({ count: 0 })) },
    jobAttempt: { create: vi.fn(async () => ({ id: "attempt" })) },
    metaReportingAccountDestination: {
      findMany: vi.fn(async () => [
        { active: true, conversionDestinationId: "dest" },
      ]),
    },
  });
  h.prisma.$queryRaw.mockImplementation(async (query: any) =>
    (query.sql ?? "").includes('SELECT "connectionId"')
      ? [structuredClone(h.event)]
      : [],
  );
  const readDestination =
    h.prisma.metaConversionDestination.findFirst.getMockImplementation()!;
  h.prisma.metaConversionDestination.findFirst.mockImplementation(
    async (args: any) => (args.where.id ? readDestination(args) : null), // No legacy destination configured.
  );
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          events_received: 1,
          messages: [],
          fbtrace_id: "synthetic-ack",
        }),
        { status: 200 },
      ),
  );
  const queue = { retrySend: vi.fn(async () => ({ jobId: "explicit-retry" })) };
  const builder = Test.createTestingModule({
    imports: [RuntimeModule, PrismaModule, ConversionEventsModule],
    providers: [
      ConversionEventProcessor,
      DiagnosticsService,
      { provide: ConversionEventsQueueService, useValue: queue },
    ],
  });
  // Retain the REAL ConversionEventsModule -> IntegrationsModule import/export
  // boundary and real resolver/encryption providers. Replace unrelated modules
  // and providers to avoid constructing any external service or queue.
  for (const module of Reflect.getMetadata("imports", IntegrationsModule)) {
    if (module.name === "PrismaModule") continue;
    if (module.name === "WhatsappProvidersModule") {
      for (const provider of Reflect.getMetadata("providers", module)) {
        if (
          typeof provider === "function" &&
          provider !== MetaTokenEncryptionService
        )
          builder.overrideProvider(provider).useValue({});
      }
      continue; // This module is re-exported by IntegrationsModule.
    }
    const exports = (Reflect.getMetadata("exports", module) ?? []).filter(
      (entry: any) =>
        typeof entry === "function" && !Reflect.hasMetadata("imports", entry),
    );
    class StubModule {}
    Module({
      providers: exports.map((provide: any) => ({ provide, useValue: {} })),
      exports,
    })(StubModule);
    builder.overrideModule(module).useModule(StubModule);
  }
  const { LicenseClientModule } = compiled(
    "licensing-client/license-client.module.js",
  );
  class StubLicenseModule {}
  Module({
    providers: [{ provide: LicenseClientService, useValue: h.license }],
    exports: [LicenseClientService],
  })(StubLicenseModule);
  builder.overrideModule(LicenseClientModule).useModule(StubLicenseModule);
  for (const provider of Reflect.getMetadata("providers", IntegrationsModule)) {
    if (
      typeof provider === "function" &&
      ![MetaConnectionResolverService, MetaTokenEncryptionService].includes(
        provider,
      )
    )
      builder.overrideProvider(provider).useValue({});
  }
  builder.overrideProvider(PrismaService).useValue(h.prisma);
  builder.overrideProvider(INTEGRATION_ENV).useValue(env);
  builder.overrideProvider(RUNTIME_ENV).useValue(env);
  // The adapter is real, only its fetch dependency is fake.
  builder
    .overrideProvider(MetaCapiAdapter)
    .useValue(new MetaCapiAdapter({}, fetcher));
  const module = await builder.compile();
  modules.push(module);
  const sender = module.get(ConversionEventsService);
  const resolver = module.get(MetaConnectionResolverService);
  const encryption = module.get(MetaTokenEncryptionService);
  Object.assign(h.business, { credentialId: "credential" });
  Object.assign(h.business.credential, {
    id: "credential",
    source: "manual",
    fingerprint: "original",
    expiresAt: null,
    updatedAt: new Date(),
    ...encryption.encrypt(token),
  });
  let batchId: string | undefined;
  if (mode === "replay") {
    batchId = (await h.authorize()).batchId;
    await h.replay.processBatch({ workspaceId: "ws", batchId });
  } else {
    h.delivery.firstReceivedAt = new Date();
    await h.production.processItem({
      workspaceId: "ws",
      productionItemId: "item",
    });
  }
  const log = h.logs[0];
  Object.assign(log, { eventOccurredAt: h.event.occurredAt, sentAt: null });
  h.prisma.conversionEventLog.findUnique.mockImplementation(
    async ({ where }: any) =>
      structuredClone(h.logs.find((l) => l.id === where.id) ?? null),
  );
  const readLog =
    h.prisma.conversionEventLog.findFirst.getMockImplementation()!;
  h.prisma.conversionEventLog.findFirst.mockImplementation(async (args: any) =>
    structuredClone(await readLog(args)),
  );
  h.prisma.metaIntegration.findUnique.mockClear();
  const job = {
    id: "synthetic-job",
    name: "send-ready-event",
    attemptsMade: 0,
    data: { conversionEventLogId: log.id, workspaceId: "ws" },
  };
  const send = () => module.get(ConversionEventProcessor).process(job);
  const retry = () =>
    module.get(DiagnosticsService).retryBlockedConversionEvents(
      [log.id],
      { reason: "Explicit owner retry after API repair" },
      {
        workspaceId: "ws",
        actorUserId: "actor",
        actorType: "workspace_owner",
      },
    );
  const assertNoTokenLogged = () => {
    const persisted = JSON.stringify({
      audits: h.audits,
      logs: h.logs,
      integration: h.prisma.integrationLog.create.mock.calls,
      diagnostic: h.prisma.diagnosticEvent.create.mock.calls,
      attempts: h.prisma.jobAttempt.create.mock.calls,
    });
    // Boolean assertions avoid printing the token even on failure.
    expect(persisted.includes(token)).toBe(false);
  };
  return {
    ...h,
    env,
    module,
    sender,
    resolver,
    encryption,
    log,
    batchId,
    fetcher,
    queue,
    send,
    retry,
    assertNoTokenLogged,
    tokenMatches: (value: string) => value === token,
  };
}

describe("Nest build CAPI resolver injection", () => {
  it("binds parameter 3 explicitly and requires the exported resolver", async () => {
    const metadata =
      Reflect.getMetadata("self:paramtypes", ConversionEventsService) ?? [];
    expect(
      metadata.some(
        (p: any) => p.index === 3 && p.param === MetaConnectionResolverService,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata("design:paramtypes", ConversionEventsService)[3],
    ).toBe(Object);
    expect(
      Reflect.getMetadata("optional:paramtypes", ConversionEventsService) ?? [],
    ).not.toContain(3);
  });

  it("injects the registered IntegrationsModule resolver into the compiled sender", async () => {
    const h = await fixture();
    expect(h.resolver instanceof MetaConnectionResolverService).toBe(true);
    expect(h.sender.connectionResolver === h.resolver).toBe(true);
  });

  it("rejects missing resolver registration at Nest compilation", async () => {
    let failure: unknown;
    try {
      modules.push(
        await Test.createTestingModule({
          providers: [
            ConversionEventsService,
            { provide: PrismaService, useValue: {} },
            { provide: MetaCapiAdapter, useValue: {} },
            { provide: MetaTokenEncryptionService, useValue: {} },
            { provide: LicenseClientService, useValue: {} },
            { provide: RUNTIME_ENV, useValue: {} },
          ],
        }).compile(),
      );
    } catch (error) {
      failure = error;
    }
    expect(
      failure instanceof Error &&
        failure.message.includes("MetaConnectionResolverService"),
    ).toBe(true);
  });

  it.each(["production", "replay"] as const)(
    "sends %s via the injected manual BM route exactly once with ACK 1",
    async (mode) => {
      const h = await fixture(mode);
      const resolveRoute = vi.spyOn(h.resolver, "resolveCapiRoute");
      const result = await h.send();
      expect({
        status: result.status,
        storedErrorCode: h.log.errorCode,
        resolverInjected: h.sender.connectionResolver === h.resolver,
      }).toEqual({
        status: "sent",
        storedErrorCode: null,
        resolverInjected: true,
      });
      expect(resolveRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          businessConnectionId: "bm",
          conversionDestinationId: "dest",
        }),
      );
      expect(
        await h.prisma.metaIntegration.findUnique({
          where: { workspaceId: "ws" },
        }),
      ).toBeNull();
      expect(h.log).toMatchObject({ status: "sent", sentAt: expect.any(Date) });
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      const request = h.fetcher.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(
        h.tokenMatches(
          new URL(request[0]).searchParams.get("access_token") ?? "",
        ),
      ).toBe(true);
      const event = JSON.parse(String(request[1].body)).data[0];
      expect(event).toMatchObject({
        event_id: h.log.eventId,
        user_data: { page_id: "page" },
      });
      expect(
        h.audits.filter((a) => a.action === "inbound_webhook.dispatch.claim"),
      ).toHaveLength(1);
      expect(await h.send()).toMatchObject({ status: "skipped" });
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      h.assertNoTokenLogged();
    },
  );

  it.each(["production", "replay"] as const)(
    "recovers a materialized %s MissingAccessToken through explicit owner retry",
    async (mode) => {
      const h = await fixture(mode);
      h.addEvent(2);
      // Persisted pre-claim outcome from the old optional Object injection. A
      // diagnostic retry reopens this existing log; it never rematerializes it.
      Object.assign(h.log, {
        status: "not_configured",
        errorCode: "MissingAccessToken",
      });
      expect(h.fetcher).not.toHaveBeenCalled();
      expect(
        h.audits.some((a) => a.action === "inbound_webhook.dispatch.claim"),
      ).toBe(false);
      if (h.batchId) {
        expect(h.items[0]).toMatchObject({
          status: "materialized",
          attemptCount: 1,
        });
        expect(h.batches[0]).toMatchObject({
          status: "completed",
          materializedCount: 1,
          failedCount: 0,
        });
        expect(
          await h.replay.getStudentReplayResult(
            h.actor,
            "connection",
            "channel",
            h.batchId,
          ),
        ).toMatchObject({ state: "failed" });
        expect((await h.preview()).canSendRemaining).toBe(false);
      }
      expect(await h.retry()).toEqual({
        claimed: 1,
        enqueued: 1,
        skipped: 0,
        failed: 0,
      });
      expect(h.queue.retrySend).toHaveBeenCalledWith(h.log.id, "ws");
      expect(await h.send()).toMatchObject({ status: "sent" });
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      expect(await h.send()).toMatchObject({ status: "skipped" });
      if (h.batchId) {
        expect(h.items[0]).toMatchObject({
          status: "materialized",
          attemptCount: 1,
        });
        expect(
          await h.replay.getStudentReplayResult(
            h.actor,
            "connection",
            "channel",
            h.batchId,
          ),
        ).toMatchObject({ state: "delivered", delivered: 1 });
        const preview = await h.preview();
        expect(preview.canSendRemaining).toBe(true);
        expect(preview.previewToken).toBeTruthy();
        expect(
          (await h.authorize("remaining", preview.previewToken!)).selection,
        ).toBe("remaining");
        expect(h.fetcher).toHaveBeenCalledTimes(1); // New authorization only; no automatic dispatch.
      }
      h.assertNoTokenLogged();
    },
  );

  it.each(["credential", "route", "unknown"])(
    "preserves the %s fence after module injection",
    async (reason) => {
      const h = await fixture("replay");
      if (reason === "credential") h.business.credential.status = "revoked";
      if (reason === "route") h.route.active = false;
      if (reason === "unknown")
        h.fetcher.mockResolvedValueOnce(new Response("{}", { status: 200 }));
      expect(await h.send()).toMatchObject(
        reason === "credential"
          ? { status: "not_configured" }
          : reason === "route"
            ? { status: "skipped" }
            : { status: "error", errorCode: "MetaCapiDeliveryUnknown" },
      );
      if (reason === "unknown") {
        expect(await h.send()).toMatchObject({ status: "skipped" });
        expect(h.fetcher).toHaveBeenCalledTimes(1);
        expect((await h.preview()).canSendRemaining).toBe(false);
      } else expect(h.fetcher).not.toHaveBeenCalled();
      h.assertNoTokenLogged();
    },
  );

  it.each([
    {
      sourceTrigger: "inbound_webhook:meta_cloud",
      metaBusinessConnectionId: null,
      metaConversionDestinationId: null,
    },
    {
      sourceTrigger: "keyword",
      metaBusinessConnectionId: "bm",
      metaConversionDestinationId: null,
    },
    {
      sourceTrigger: "keyword",
      metaBusinessConnectionId: null,
      metaConversionDestinationId: "dest",
    },
  ])(
    "blocks an explicit normalized route without resolver: %s",
    async (route) => {
      const h = await fixture();
      h.sender.connectionResolver = undefined;
      Object.assign(h.log, route);
      expect(await h.sender.resolveDeliveryRoute(h.log)).toMatchObject({
        source: "manual",
        accessToken: null,
        routeError: "Rota Meta normalizada indisponivel",
      });
      expect(h.prisma.metaIntegration.findUnique).not.toHaveBeenCalled();
      expect(h.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(["legacy", "oauth_bm"])(
    "preserves the %s CAPI route through compiled DI",
    async (source) => {
      const h = await fixture();
      if (source === "oauth_bm")
        Object.assign(h.business.credential, { source: "oauth" });
      else {
        const encrypted = h.encryption.encrypt("synthetic-legacy-token");
        h.prisma.metaIntegration.findUnique.mockResolvedValue({
          status: "connected",
          advancedRoutingEnabled: false,
          ...encrypted,
          capiAccessTokenEncrypted: null,
          capiTokenIv: null,
          capiTokenTag: null,
          selectedAdAccountId: "act-legacy",
          primaryConversionDestinationId: "dest",
        });
        Object.assign(h.log, {
          sourceTrigger: "keyword",
          metaAccountId: "act-legacy",
          metaBusinessConnectionId: null,
          metaConversionDestinationId: null,
        });
      }
      expect(await h.send()).toMatchObject({ status: "sent" });
      expect(h.fetcher).toHaveBeenCalledTimes(1);
      expect(
        h.prisma.integrationLog.create.mock.calls[0][0].data.requestSummary
          .routeSource,
      ).toBe("legacy_oauth");
      h.assertNoTokenLogged();
      expect(
        JSON.stringify(h.prisma.integrationLog.create.mock.calls).includes(
          "synthetic-legacy-token",
        ),
      ).toBe(false);
    },
  );
});
