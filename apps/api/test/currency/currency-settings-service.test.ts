import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { CurrencySettingsService } from "../../src/currency/currency-settings.service";
import { loadWorkspaceConversionCurrency } from "../../src/currency/workspace-currency";

const authenticated = { user: { id: "user_1" } } as never;

function workspace(canManage: boolean) {
  return {
    id: "workspace_1",
    name: "W",
    slug: "w",
    role: canManage ? "owner" : "member",
    operationalStatus: "active",
    accessMode: "member",
    permissions: {
      canManageWorkspaceSettings: canManage,
      canViewReports: true,
    },
  } as never;
}

function harness() {
  const state = {
    conversionCurrency: "BRL",
    accounts: [
      {
        id: "rep_1",
        workspaceId: "workspace_1",
        adAccountId: "act_1",
        adAccountName: "Conta BR",
        businessId: "bm_1",
        businessName: "BM",
        active: true,
        currency: "BRL",
        currencyOverride: null as string | null,
      },
      {
        id: "rep_2",
        workspaceId: "workspace_1",
        adAccountId: "act_2",
        adAccountName: "Conta US",
        businessId: "bm_1",
        businessName: "BM",
        active: true,
        currency: "usd",
        currencyOverride: null as string | null,
      },
      {
        id: "rep_3",
        workspaceId: "workspace_1",
        adAccountId: "act_3",
        adAccountName: "Conta GBP",
        businessId: "bm_1",
        businessName: "BM",
        active: false,
        currency: "GBP",
        currencyOverride: null as string | null,
      },
    ],
  };
  const prisma: any = {
    // Simula a transacao: em erro, desfaz o estado (rollback).
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const snapshot = JSON.parse(JSON.stringify(state));
      try {
        return await callback(prisma);
      } catch (error) {
        state.conversionCurrency = snapshot.conversionCurrency;
        state.accounts.forEach((account, index) =>
          Object.assign(account, snapshot.accounts[index]),
        );
        throw error;
      }
    }),
    workspace: {
      findUnique: vi.fn(async () => ({
        conversionCurrency: state.conversionCurrency,
      })),
      update: vi.fn(async ({ data }: any) => {
        state.conversionCurrency = data.conversionCurrency;
        return { id: "workspace_1" };
      }),
    },
    metaReportingAccount: {
      findMany: vi.fn(async () => state.accounts),
      findFirst: vi.fn(
        async ({ where }: any) =>
          state.accounts.find(
            (account) =>
              account.workspaceId === where.workspaceId &&
              where.OR.some(
                (option: Record<string, string>) =>
                  (option.id && option.id === account.id) ||
                  (option.adAccountId && option.adAccountId === account.adAccountId),
              ),
          ) ?? null,
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const account = state.accounts.find((item) => item.id === where.id)!;
        Object.assign(account, data);
        return account;
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  return {
    service: new CurrencySettingsService(prisma as never),
    prisma,
    state,
  };
}

describe("CurrencySettingsService", () => {
  it("defaults the workspace conversion currency to BRL", async () => {
    const { service } = harness();
    await expect(service.getSettings(workspace(false))).resolves.toEqual({
      workspaceId: "workspace_1",
      conversionCurrency: "BRL",
      supportedCurrencies: ["BRL", "USD", "EUR"],
      canManage: false,
    });
    await expect(loadWorkspaceConversionCurrency({}, "workspace_1")).resolves.toBe("BRL");
    await expect(
      loadWorkspaceConversionCurrency(
        { workspace: { findUnique: async () => { throw new Error("db"); } } },
        "workspace_1",
      ),
    ).resolves.toBe("BRL");
  });

  it("updates the conversion currency with an audit log (managers only)", async () => {
    const { service, prisma } = harness();
    await expect(
      service.updateSettings(authenticated, workspace(false), {
        conversionCurrency: "USD",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspace.update).not.toHaveBeenCalled();

    const result = await service.updateSettings(authenticated, workspace(true), {
      conversionCurrency: "USD",
    });
    expect(result.conversionCurrency).toBe("USD");
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_1",
        actorUserId: "user_1",
        action: "workspace.conversion_currency_updated",
        beforeSummary: { conversionCurrency: "BRL" },
        afterSummary: { conversionCurrency: "USD" },
      }),
    });
  });

  it("lists ad accounts with detected currency, override and effective currency", async () => {
    const { service } = harness();
    const list = await service.listAdAccounts(workspace(true));
    expect(list.currencies).toEqual(["BRL", "USD"]);
    expect(list.accounts.map((account) => ({
      id: account.id,
      detectedCurrency: account.detectedCurrency,
      detectedCurrencySupported: account.detectedCurrencySupported,
      effectiveCurrency: account.effectiveCurrency,
    }))).toEqual([
      { id: "rep_1", detectedCurrency: "BRL", detectedCurrencySupported: true, effectiveCurrency: "BRL" },
      { id: "rep_2", detectedCurrency: "USD", detectedCurrencySupported: true, effectiveCurrency: "USD" },
      { id: "rep_3", detectedCurrency: "GBP", detectedCurrencySupported: false, effectiveCurrency: "BRL" },
    ]);
  });

  it("sets and clears a per-account override with audit", async () => {
    const { service, prisma } = harness();
    const updated = await service.updateAdAccountOverride(
      authenticated,
      workspace(true),
      "rep_2",
      { currencyOverride: "EUR" },
    );
    expect(updated).toMatchObject({ currencyOverride: "EUR", effectiveCurrency: "EUR" });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "meta_reporting_account.currency_override_updated",
        targetId: "rep_2",
        afterSummary: expect.objectContaining({ effectiveCurrency: "EUR" }),
      }),
    });

    const cleared = await service.updateAdAccountOverride(
      authenticated,
      workspace(true),
      "act_2",
      { currencyOverride: null },
    );
    expect(cleared).toMatchObject({ currencyOverride: null, effectiveCurrency: "USD" });

    await expect(
      service.updateAdAccountOverride(authenticated, workspace(true), "missing", {
        currencyOverride: "USD",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.updateAdAccountOverride(authenticated, workspace(false), "rep_1", {
        currencyOverride: "USD",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rolls back the change when the audit log fails", async () => {
    const { service, prisma, state } = harness();
    prisma.auditLog.create.mockRejectedValue(new Error("audit down"));

    await expect(
      service.updateSettings(authenticated, workspace(true), {
        conversionCurrency: "USD",
      }),
    ).rejects.toThrow("audit down");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(state.conversionCurrency).toBe("BRL");

    await expect(
      service.updateAdAccountOverride(authenticated, workspace(true), "rep_2", {
        currencyOverride: "EUR",
      }),
    ).rejects.toThrow("audit down");
    expect(state.accounts[1]!.currencyOverride).toBeNull();
  });

  it("B3: reads the previous currency inside the same transaction as the change", async () => {
    const tx = {
      workspace: {
        findUnique: vi.fn(async () => ({ conversionCurrency: "EUR" })),
        update: vi.fn(async () => ({ id: "workspace_1" })),
      },
      auditLog: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) =>
        callback(tx),
      ),
      workspace: {
        // Fora da transação a leitura estaria velha (BRL).
        findUnique: vi.fn(async () => ({ conversionCurrency: "BRL" })),
      },
    };
    const service = new CurrencySettingsService(prisma as never);

    await service.updateSettings(authenticated, workspace(true), {
      conversionCurrency: "USD",
    });
    expect(tx.workspace.findUnique).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        beforeSummary: { conversionCurrency: "EUR" },
        afterSummary: { conversionCurrency: "USD" },
      }),
    });

    tx.auditLog.create.mockClear();
    tx.workspace.update.mockClear();
    await service.updateSettings(authenticated, workspace(true), {
      conversionCurrency: "EUR",
    });
    expect(tx.workspace.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
