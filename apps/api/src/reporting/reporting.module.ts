import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaService } from "../common/prisma/prisma.service";
import { META_REPORT_SYNC_QUEUE } from "../common/queue/queue.constants";
import { ConversionRulesModule } from "../conversion-rules/conversion-rules.module";
import { CurrencyModule } from "../currency/currency.module";
import { DiagnosticsModule } from "../diagnostics/diagnostics.module";
import { InboundWebhooksModule } from "../inbound-webhooks/inbound-webhooks.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { MetaReportSyncProcessor } from "./meta-report-sync.processor";
import { MetaReportAutoSyncService } from "./meta-report-auto-sync.service";
import { MetaInitialSyncPeriodService } from "./meta-initial-sync-period";
import { MetaReportSyncQueueService } from "./meta-report-sync-queue.service";
import { MetaReportingService } from "./meta-reporting.service";
import { ReportingMetricsEngine } from "./reporting-metrics.engine";
import { ReportingController } from "./reporting.controller";
import { WhatsappCampaignClassifierService } from "./whatsapp-campaign-classifier.service";

@Module({
  imports: [
    AuthModule,
    WorkspacesModule,
    DiagnosticsModule,
    InboundWebhooksModule,
    ConversionRulesModule,
    IntegrationsModule,
    CurrencyModule,
    BullModule.registerQueue({
      name: META_REPORT_SYNC_QUEUE,
    }),
  ],
  controllers: [ReportingController],
  providers: [
    MetaReportingService,
    MetaReportAutoSyncService,
    MetaInitialSyncPeriodService,
    MetaReportSyncQueueService,
    MetaReportSyncProcessor,
    ReportingMetricsEngine,
    WhatsappCampaignClassifierService,
    PrismaService,
  ],
  exports: [
    MetaReportingService,
    MetaReportSyncQueueService,
    WhatsappCampaignClassifierService,
  ],
})
export class ReportingModule {}
