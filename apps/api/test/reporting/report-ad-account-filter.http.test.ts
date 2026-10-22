import "reflect-metadata";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import { DiagnosticsService } from "../../src/diagnostics/diagnostics.service";
import { MetaInitialSyncPeriodService } from "../../src/reporting/meta-initial-sync-period";
import { MetaReportSyncQueueService } from "../../src/reporting/meta-report-sync-queue.service";
import { MetaReportingService } from "../../src/reporting/meta-reporting.service";
import { ReportingController } from "../../src/reporting/reporting.controller";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";

// Fase 5.2: filtro por conta(s) de anúncio nos relatórios (Visão Geral e
// Relatórios). Portado do SaaS (996e7c1, reporting-controller).

const apps: INestApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function harness() {
  const reporting = {
    getCampaignReportOverview: vi.fn(
      async (_input: Record<string, unknown>) => ({}),
    ),
    getCampaignReportCsv: vi.fn(async () => ({
      filename: "relatorio.csv",
      content: "",
    })),
    getAdSetReportOverview: vi.fn(async () => ({})),
    getAdReportOverview: vi.fn(async () => ({})),
  };
  const module = await Test.createTestingModule({
    controllers: [ReportingController],
    providers: [
      { provide: MetaReportingService, useValue: reporting },
      { provide: DiagnosticsService, useValue: {} },
      {
        provide: AuthService,
        useValue: { getSession: vi.fn(async () => ({ user: { id: "u" } })) },
      },
      {
        provide: WorkspacesService,
        useValue: {
          getCurrentWorkspace: () => ({
            id: "workspace_1",
            role: "owner",
            accessMode: "membership",
            permissions: { canViewReports: true, canExportReports: true },
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
  return { app, reporting };
}

const get = (app: INestApplication, path: string) =>
  request(app.getHttpServer())
    .get(path)
    .set("Cookie", "wpptrack_session=refresh-token");

describe("reports: filtro por conta de anúncio", () => {
  it("passes several ad accounts (comma separated or repeated) to every report", async () => {
    const { app, reporting } = await harness();

    await get(
      app,
      "/reports/campaigns?adAccountIds=act_us,act_123&adAccountIds=act_us",
    ).expect(200);
    await get(app, "/reports/adsets?adAccountIds=act_us").expect(200);
    await get(app, "/reports/ads?adAccountIds=act_us").expect(200);
    await get(app, "/reports/campaigns/export.csv?adAccountIds=act_us").expect(
      200,
    );

    expect(reporting.getCampaignReportOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        adAccountIds: ["act_us", "act_123"],
      }),
    );
    for (const method of [
      reporting.getAdSetReportOverview,
      reporting.getAdReportOverview,
      reporting.getCampaignReportCsv,
    ]) {
      expect(method).toHaveBeenCalledWith(
        expect.objectContaining({ adAccountIds: ["act_us"] }),
      );
    }
  });

  it("keeps the single adAccountId filter as it was and omits an empty list", async () => {
    const { app, reporting } = await harness();

    await get(
      app,
      "/reports/campaigns?adAccountId=act_123&adAccountIds=",
    ).expect(200);

    const input = reporting.getCampaignReportOverview.mock.calls[0]![0];
    expect(input.adAccountId).toBe("act_123");
    expect(input).not.toHaveProperty("adAccountIds");
  });

  it("rejects an oversized list or id with 400", async () => {
    const { app } = await harness();
    const many = Array.from({ length: 51 }, (_, index) => `act_${index}`).join(
      ",",
    );

    await get(app, `/reports/campaigns?adAccountIds=${"x".repeat(121)}`).expect(
      400,
    );
    await get(app, `/reports/adsets?adAccountIds=${many}`).expect(400);
  });
});
