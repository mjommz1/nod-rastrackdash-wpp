import "reflect-metadata";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.service";
import { DiagnosticsService } from "../src/diagnostics/diagnostics.service";
import { MetaInitialSyncPeriodService } from "../src/reporting/meta-initial-sync-period";
import { MetaReportSyncQueueService } from "../src/reporting/meta-report-sync-queue.service";
import { MetaReportingService } from "../src/reporting/meta-reporting.service";
import { ReportingController } from "../src/reporting/reporting.controller";
import { WorkspacesService } from "../src/workspaces/workspaces.service";

const apps: INestApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function harness(
  role = "owner",
  accessMode = "membership",
  platformRole?: string,
) {
  const reporting = {
    getBlockedConversionEventRetryIds: vi.fn(async () => ["blocked"]),
    getConversionEventAudit: vi.fn(async () => ({
      events: [{ id: "blocked", canRetry: true }],
    })),
    getConversionEventAuditDetail: vi.fn(async () => ({
      id: "blocked",
      canRetry: true,
    })),
  };
  const diagnostics = {
    retryConversionEvent: vi.fn(async () => ({ ok: true, status: "queued" })),
    retryBlockedConversionEvents: vi.fn(async () => ({
      claimed: 1,
      enqueued: 1,
      skipped: 0,
      failed: 0,
    })),
  };
  const auth = { getSession: vi.fn(async () => ({ user: { id: "user_1" } })) };
  const module = await Test.createTestingModule({
    controllers: [ReportingController],
    providers: [
      { provide: MetaReportingService, useValue: reporting },
      { provide: DiagnosticsService, useValue: diagnostics },
      { provide: AuthService, useValue: auth },
      {
        provide: WorkspacesService,
        useValue: {
          getCurrentWorkspace: () => ({
            id: "workspace_1",
            role,
            accessMode,
            platformRole,
            permissions: { canViewReports: true },
          }),
        },
      },
      { provide: MetaReportSyncQueueService, useValue: {} },
      { provide: MetaInitialSyncPeriodService, useValue: {} },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  apps.push(app);
  await app.init();
  return { app, reporting, diagnostics, auth };
}

describe("reporting conversion retry routes", () => {
  it("passes audit filters and authenticated workspace to bulk retries, ignoring pagination and workspace input", async () => {
    const { app, reporting, diagnostics, auth } = await harness();
    await request(app.getHttpServer())
      .post(
        "/reports/conversions/audit/retry-blocked?since=2026-07-01&until=2026-07-02&eventName=Purchase&status=blocked&source=external_integration&workspaceId=workspace_2&page=2&pageSize=1",
      )
      .set("Cookie", "wpptrack_session=refresh-token")
      .expect(201)
      .expect({ claimed: 1, enqueued: 1, skipped: 0, failed: 0 });
    expect(auth.getSession).toHaveBeenCalledWith("refresh-token");
    expect(reporting.getBlockedConversionEventRetryIds).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      since: "2026-07-01",
      until: "2026-07-02",
      rangeLabel: "2026-07-01 a 2026-07-02",
      eventName: "Purchase",
      deliveryState: "blocked",
      source: "external_integration",
    });
    expect(diagnostics.retryBlockedConversionEvents).toHaveBeenCalledWith(
      ["blocked"],
      { reason: "Reenvio manual de eventos Meta bloqueados por configuracao" },
      expect.objectContaining({
        workspaceId: "workspace_1",
        actorUserId: "user_1",
        actorType: "workspace_owner",
      }),
    );
  });

  it("enables configuration retries for single events", async () => {
    const { app, diagnostics } = await harness();
    await request(app.getHttpServer())
      .post("/reports/conversions/audit/blocked/retry")
      .set("Cookie", "wpptrack_session=refresh-token")
      .expect(201);
    expect(diagnostics.retryConversionEvent).toHaveBeenCalledWith(
      "blocked",
      { reason: "Reenvio manual de evento Meta" },
      expect.objectContaining({
        workspaceId: "workspace_1",
        actorUserId: "user_1",
        transientOnly: true,
        allowConfigurationBlocked: true,
      }),
    );
  });

  it.each([
    ["owner", "membership", undefined, true],
    ["admin", "membership", undefined, false],
    ["member", "membership", undefined, false],
    ["owner", "platform_support", "platform_admin", false],
    ["member", "platform_support", "platform_owner", true],
  ])(
    "enforces owner policy for %s / %s / %s",
    async (role, accessMode, platformRole, allowed) => {
      const { app, reporting, diagnostics } = await harness(
        role,
        accessMode,
        platformRole,
      );
      for (const route of ["retry-blocked", "blocked/retry"]) {
        await request(app.getHttpServer())
          .post(`/reports/conversions/audit/${route}`)
          .set("Cookie", "wpptrack_session=refresh-token")
          .expect(allowed ? 201 : 403);
      }
      for (const route of ["", "/blocked"]) {
        const { body } = await request(app.getHttpServer())
          .get(`/reports/conversions/audit${route}`)
          .set("Cookie", "wpptrack_session=refresh-token")
          .expect(200);
        expect(route ? body.canRetry : body.events[0].canRetry).toBe(allowed);
      }
      if (!allowed) {
        expect(
          reporting.getBlockedConversionEventRetryIds,
        ).not.toHaveBeenCalled();
        expect(diagnostics.retryBlockedConversionEvents).not.toHaveBeenCalled();
        expect(diagnostics.retryConversionEvent).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    "status=unknown",
    "source=unknown",
    "since=invalid",
    "since=2026-07-02&until=2026-07-01",
    "status=blocked&status=sent",
    "source=system&source=manual_test",
    "eventName=Purchase&eventName=LeadSubmitted",
  ])("rejects invalid filters before selecting events: %s", async (query) => {
    const { app, reporting, diagnostics } = await harness();
    await request(app.getHttpServer())
      .post(`/reports/conversions/audit/retry-blocked?${query}`)
      .set("Cookie", "wpptrack_session=refresh-token")
      .expect(400);
    expect(reporting.getBlockedConversionEventRetryIds).not.toHaveBeenCalled();
    expect(diagnostics.retryBlockedConversionEvents).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const { app, reporting } = await harness();
    await request(app.getHttpServer())
      .post("/reports/conversions/audit/retry-blocked")
      .expect(401);
    expect(reporting.getBlockedConversionEventRetryIds).not.toHaveBeenCalled();
  });

  it("uses the default audit period and returns honest counters unchanged", async () => {
    const { app, reporting, diagnostics } = await harness();
    diagnostics.retryBlockedConversionEvents.mockResolvedValueOnce({
      claimed: 3,
      enqueued: 2,
      skipped: 4,
      failed: 2,
    });
    await request(app.getHttpServer())
      .post("/reports/conversions/audit/retry-blocked")
      .set("Cookie", "wpptrack_session=refresh-token")
      .expect(201)
      .expect({ claimed: 3, enqueued: 2, skipped: 4, failed: 2 });
    expect(reporting.getBlockedConversionEventRetryIds).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      rangeLabel: "Ultimos 7 dias",
      since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      until: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });
});
