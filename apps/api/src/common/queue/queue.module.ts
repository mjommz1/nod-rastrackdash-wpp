import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConversionEventsModule } from "../../conversion-events/conversion-events.module";
import { OpsAlertsModule } from "../../ops-alerts/ops-alerts.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ConversionEventProcessor } from "./conversion-event.processor";
import { ConversionEventsQueueService } from "./conversion-events-queue.service";
import { DiagnosticProcessor } from "./diagnostic.processor";
import { DiagnosticsQueueService } from "./diagnostics-queue.service";
import { OpsAlertsProcessor } from "./ops-alerts.processor";
import { OpsAlertsQueueService } from "./ops-alerts-queue.service";
import { CONVERSION_EVENTS_QUEUE, DIAGNOSTIC_QUEUE, KOMMO_WEBHOOK_QUEUE, OPS_ALERTS_QUEUE } from "./queue.constants";

@Module({
  imports: [
    ConversionEventsModule,
    OpsAlertsModule,
    PrismaModule,
    BullModule.forRoot({
      connection: {
        url: process.env.REDIS_URL ?? "redis://localhost:6379"
      }
    }),
    BullModule.registerQueue({
      name: DIAGNOSTIC_QUEUE
    }),
    BullModule.registerQueue({
      name: CONVERSION_EVENTS_QUEUE
    }),
    BullModule.registerQueue({ name: KOMMO_WEBHOOK_QUEUE }),
    BullModule.registerQueue({
      name: OPS_ALERTS_QUEUE
    })
  ],
  providers: [
    DiagnosticProcessor,
    ConversionEventProcessor,
    ConversionEventsQueueService,
    DiagnosticsQueueService,
    OpsAlertsProcessor,
    OpsAlertsQueueService
  ],
  exports: [BullModule, ConversionEventsQueueService, DiagnosticsQueueService, OpsAlertsQueueService]
})
export class QueueModule {}
