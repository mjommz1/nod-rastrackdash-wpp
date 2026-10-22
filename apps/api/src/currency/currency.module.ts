import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { CurrencySettingsController } from "./currency-settings.controller";
import { CurrencySettingsService } from "./currency-settings.service";
import { ExchangeRateService } from "./exchange-rate.service";

/**
 * Fase 5.1: moeda das conversões e correção da moeda por conta de anúncio.
 * Fase 5.2: cotação PTAX (ExchangeRateService) para os relatórios por moeda.
 */
@Module({
  imports: [AuthModule, PrismaModule, WorkspacesModule],
  controllers: [CurrencySettingsController],
  providers: [CurrencySettingsService, ExchangeRateService],
  exports: [CurrencySettingsService, ExchangeRateService],
})
export class CurrencyModule {}
