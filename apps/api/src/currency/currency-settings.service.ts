import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  adAccountCurrencyListSchema,
  effectiveAccountCurrency,
  normalizeCurrencyCode,
  supportedCurrencyCodes,
  workspaceCurrencySettingsSchema,
  type AdAccountCurrencyDto,
  type AdAccountCurrencyListDto,
  type AdAccountCurrencyOverrideInputDto,
  type CurrentWorkspaceDto,
  type WorkspaceCurrencySettingsDto,
  type WorkspaceCurrencyUpdateInputDto,
} from "@wpptrack/shared";
import type { Prisma } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/session.types";
import { PrismaService } from "../common/prisma/prisma.service";
import { loadWorkspaceConversionCurrency } from "./workspace-currency";

type ReportingAccountCurrencyRecord = {
  id: string;
  adAccountId: string;
  adAccountName: string;
  businessId: string;
  businessName: string;
  active: boolean;
  currency: string | null;
  currencyOverride: string | null;
};

const accountSelect = {
  id: true,
  adAccountId: true,
  adAccountName: true,
  businessId: true,
  businessName: true,
  active: true,
  currency: true,
  currencyOverride: true,
} as const;

/**
 * Configurações -> Moeda: "Moeda das conversões" do workspace e correção da
 * moeda do investimento por conta de anúncio (a moeda detectada vem da Meta).
 * Leitura: qualquer membro. Escrita: canManageWorkspaceSettings (dono/admin),
 * com registro de auditoria na mesma transação da alteração.
 */
@Injectable()
export class CurrencySettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getSettings(
    workspace: CurrentWorkspaceDto,
  ): Promise<WorkspaceCurrencySettingsDto> {
    return workspaceCurrencySettingsSchema.parse({
      workspaceId: workspace.id,
      conversionCurrency: await loadWorkspaceConversionCurrency(
        this.prisma,
        workspace.id,
      ),
      supportedCurrencies: [...supportedCurrencyCodes],
      canManage: workspace.permissions.canManageWorkspaceSettings,
    });
  }

  async updateSettings(
    authenticated: AuthenticatedUser,
    workspace: CurrentWorkspaceDto,
    input: WorkspaceCurrencyUpdateInputDto,
  ): Promise<WorkspaceCurrencySettingsDto> {
    this.requireManager(workspace);

    await this.prisma.$transaction(async (transaction) => {
      // O "antes" da auditoria é lido dentro da mesma transação da troca.
      const before = await loadWorkspaceConversionCurrency(
        transaction,
        workspace.id,
      );
      if (before === input.conversionCurrency) return;
      await transaction.workspace.update({
        where: { id: workspace.id },
        data: { conversionCurrency: input.conversionCurrency },
        select: { id: true },
      });
      await this.audit(transaction, {
        authenticated,
        workspace,
        action: "workspace.conversion_currency_updated",
        targetType: "Workspace",
        targetId: workspace.id,
        beforeSummary: { conversionCurrency: before },
        afterSummary: { conversionCurrency: input.conversionCurrency },
      });
    });

    return this.getSettings(workspace);
  }

  async listAdAccounts(
    workspace: CurrentWorkspaceDto,
  ): Promise<AdAccountCurrencyListDto> {
    const accounts = (await this.prisma.metaReportingAccount.findMany({
      where: { workspaceId: workspace.id },
      select: accountSelect,
      orderBy: [{ active: "desc" }, { adAccountName: "asc" }],
    })) as ReportingAccountCurrencyRecord[];
    const dtos = accounts.map((account) => this.toAccountDto(account));

    return adAccountCurrencyListSchema.parse({
      accounts: dtos,
      currencies: [
        ...new Set(
          dtos
            .filter((account) => account.active)
            .map((account) => account.effectiveCurrency),
        ),
      ],
      canManage: workspace.permissions.canManageWorkspaceSettings,
    });
  }

  async updateAdAccountOverride(
    authenticated: AuthenticatedUser,
    workspace: CurrentWorkspaceDto,
    reportingAccountId: string,
    input: AdAccountCurrencyOverrideInputDto,
  ): Promise<AdAccountCurrencyDto> {
    this.requireManager(workspace);
    const account = (await this.prisma.metaReportingAccount.findFirst({
      where: {
        workspaceId: workspace.id,
        OR: [{ id: reportingAccountId }, { adAccountId: reportingAccountId }],
      },
      select: accountSelect,
    })) as ReportingAccountCurrencyRecord | null;

    if (!account) {
      throw new NotFoundException("Conta de anúncio não encontrada");
    }

    const before = normalizeCurrencyCode(account.currencyOverride);

    if (before === input.currencyOverride) {
      return this.toAccountDto(account);
    }

    const updated = await this.prisma.$transaction(async (transaction) => {
      const record = (await transaction.metaReportingAccount.update({
        where: { id: account.id },
        data: { currencyOverride: input.currencyOverride },
        select: accountSelect,
      })) as ReportingAccountCurrencyRecord;
      await this.audit(transaction, {
        authenticated,
        workspace,
        action: "meta_reporting_account.currency_override_updated",
        targetType: "MetaReportingAccount",
        targetId: account.id,
        beforeSummary: {
          adAccountId: account.adAccountId,
          detectedCurrency: account.currency,
          currencyOverride: before,
          effectiveCurrency: effectiveAccountCurrency(account),
        },
        afterSummary: {
          adAccountId: account.adAccountId,
          detectedCurrency: account.currency,
          currencyOverride: input.currencyOverride,
          effectiveCurrency: effectiveAccountCurrency(record),
        },
      });
      return record;
    });

    return this.toAccountDto(updated);
  }

  private toAccountDto(
    account: ReportingAccountCurrencyRecord,
  ): AdAccountCurrencyDto {
    return {
      id: account.id,
      adAccountId: account.adAccountId,
      adAccountName: account.adAccountName,
      businessId: account.businessId,
      businessName: account.businessName,
      active: account.active,
      detectedCurrency: account.currency?.trim().toUpperCase() || null,
      detectedCurrencySupported:
        normalizeCurrencyCode(account.currency) !== null,
      currencyOverride: normalizeCurrencyCode(account.currencyOverride),
      effectiveCurrency: effectiveAccountCurrency(account),
    };
  }

  private requireManager(workspace: CurrentWorkspaceDto) {
    if (!workspace.permissions.canManageWorkspaceSettings) {
      throw new ForbiddenException("Sem permissão para alterar a moeda");
    }
  }

  /** Roda dentro da transação da alteração: falha na auditoria desfaz a mudança. */
  private async audit(
    transaction: Prisma.TransactionClient,
    input: {
      authenticated: AuthenticatedUser;
      workspace: CurrentWorkspaceDto;
      action: string;
      targetType: string;
      targetId: string;
      beforeSummary: Record<string, string | null>;
      afterSummary: Record<string, string | null>;
    },
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        workspaceId: input.workspace.id,
        actorUserId: input.authenticated.user.id,
        actorType:
          input.workspace.accessMode === "platform_support"
            ? "platform_support"
            : "user",
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: null,
        sourceIp: null,
        resultStatus: "success",
        beforeSummary: input.beforeSummary,
        afterSummary: input.afterSummary,
      },
    });
  }
}
