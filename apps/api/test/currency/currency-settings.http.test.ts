import "reflect-metadata";
import { APP_GUARD } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import { CurrencySettingsController } from "../../src/currency/currency-settings.controller";
import { CurrencySettingsService } from "../../src/currency/currency-settings.service";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";

const apps: NestExpressApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function workspace(canManage: boolean) {
  return {
    id: "workspace_1",
    name: "W",
    slug: "w",
    role: canManage ? "owner" : "member",
    operationalStatus: "active",
    accessMode: "member",
    permissions: { canManageWorkspaceSettings: canManage },
  };
}

async function appFor(input: { locked: boolean; canManage: boolean }) {
  const state = { conversionCurrency: "BRL" };
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(prisma),
    ),
    workspace: {
      findUnique: vi.fn(async () => ({ ...state })),
      update: vi.fn(async ({ data }: { data: { conversionCurrency: string } }) => {
        state.conversionCurrency = data.conversionCurrency;
        return { id: "workspace_1" };
      }),
    },
    metaReportingAccount: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const license = {
    getLockState: vi.fn(async () =>
      input.locked
        ? {
            inert: false,
            locked: true,
            reason: "revoked",
            state: { status: "blocked" },
          }
        : {
            inert: false,
            locked: false,
            reason: null,
            state: { status: "active" },
          },
    ),
  };
  const module = await Test.createTestingModule({
    controllers: [CurrencySettingsController],
    providers: [
      {
        provide: CurrencySettingsService,
        useValue: new CurrencySettingsService(prisma as never),
      },
      {
        provide: AuthService,
        useValue: {
          getSession: vi.fn(async () => ({ user: { id: "user_1" } })),
        },
      },
      {
        provide: WorkspacesService,
        useValue: {
          getCurrentWorkspace: vi.fn(() => workspace(input.canManage)),
        },
      },
      { provide: LicenseClientService, useValue: license },
      { provide: APP_GUARD, useClass: LicenseSoftlockGuard },
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>();
  apps.push(app);
  await app.init();
  return { api: request(app.getHttpServer()), prisma, state };
}

const auth = { Authorization: "Bearer token_1" };

describe("Configurações -> Moeda (HTTP)", () => {
  it("lets any member read the workspace currency (BRL by default)", async () => {
    const { api } = await appFor({ locked: false, canManage: false });
    const response = await api
      .get("/workspaces/current/currency")
      .set(auth)
      .expect(200);
    expect(response.body).toEqual({
      workspaceId: "workspace_1",
      conversionCurrency: "BRL",
      supportedCurrencies: ["BRL", "USD", "EUR"],
      canManage: false,
    });
    await api.get("/workspaces/current/currency/ad-accounts").set(auth).expect(200);
  });

  it("still reads with a blocked license", async () => {
    const { api } = await appFor({ locked: true, canManage: true });
    await api.get("/workspaces/current/currency").set(auth).expect(200);
  });

  it("answers 423 on every write with a blocked license and changes nothing", async () => {
    const { api, prisma, state } = await appFor({ locked: true, canManage: true });
    const response = await api
      .patch("/workspaces/current/currency")
      .set(auth)
      .send({ conversionCurrency: "USD" })
      .expect(423);
    expect(response.body).toMatchObject({ statusCode: 423, error: "License Locked" });
    await api
      .patch("/workspaces/current/currency/ad-accounts/rep_1")
      .set(auth)
      .send({ currencyOverride: "USD" })
      .expect(423);
    expect(prisma.workspace.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(state.conversionCurrency).toBe("BRL");
  });

  it("lets owner/admin change the currency, with audit", async () => {
    const { api, prisma } = await appFor({ locked: false, canManage: true });
    const response = await api
      .patch("/workspaces/current/currency")
      .set(auth)
      .send({ conversionCurrency: "EUR" })
      .expect(200);
    expect(response.body).toMatchObject({ conversionCurrency: "EUR", canManage: true });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("refuses members (403) and invalid currencies (400)", async () => {
    const member = await appFor({ locked: false, canManage: false });
    await member.api
      .patch("/workspaces/current/currency")
      .set(auth)
      .send({ conversionCurrency: "USD" })
      .expect(403);

    const owner = await appFor({ locked: false, canManage: true });
    await owner.api
      .patch("/workspaces/current/currency")
      .set(auth)
      .send({ conversionCurrency: "GBP" })
      .expect(400);
    await owner.api
      .patch("/workspaces/current/currency/ad-accounts/rep_1")
      .set(auth)
      .send({ currencyOverride: "ARS" })
      .expect(400);
    await owner.api
      .patch("/workspaces/current/currency/ad-accounts/missing")
      .set(auth)
      .send({ currencyOverride: "USD" })
      .expect(404);
  });
});
