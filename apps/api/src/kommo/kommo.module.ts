import { Module } from "@nestjs/common";
import { ConversionEventsModule } from "../conversion-events/conversion-events.module";
import { QueueModule } from "../common/queue/queue.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { LicenseClientModule } from "../licensing-client/license-client.module";
import { KommoAdapter } from "./kommo.adapter";
import { KommoController } from "./kommo.controller";
import { KommoService } from "./kommo.service";
import { KommoWebhookQueueService } from "./kommo-webhook-queue.service";
import { KommoWebhookProcessor } from "./kommo-webhook.processor";
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    QueueModule,
    ConversionEventsModule,
    LicenseClientModule,
  ],
  controllers: [KommoController],
  providers: [
    KommoAdapter,
    KommoService,
    KommoWebhookQueueService,
    KommoWebhookProcessor,
  ],
})
export class KommoModule {}
