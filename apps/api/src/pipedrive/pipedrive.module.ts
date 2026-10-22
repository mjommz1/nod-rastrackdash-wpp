import { Module } from "@nestjs/common";
import { ConversionEventsModule } from "../conversion-events/conversion-events.module";
import { QueueModule } from "../common/queue/queue.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { AuthModule } from "../auth/auth.module";
import { LicenseClientModule } from "../licensing-client/license-client.module";
import { PipedriveAdapter } from "./pipedrive.adapter";
import { PipedriveController } from "./pipedrive.controller";
import { PipedriveService } from "./pipedrive.service";
import { PipedriveWebhookService } from "./pipedrive-webhook.service";
import { PipedriveWebhookController } from "./pipedrive-webhook.controller";
import { PipedriveWebhookWorker } from "./pipedrive-webhook.worker";

/**
 * Pipedrive CRM (deal stage change / won deal -> Meta conversion). Unlike the
 * SaaS pilot there is no feature gate: the integration exists for every
 * workspace, is managed by the workspace owner and, like Kommo, writes only
 * with an allowed license (global 423 guard on HTTP writes, explicit checks
 * in the background worker).
 */
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ConversionEventsModule,
    QueueModule,
    LicenseClientModule,
  ],
  controllers: [PipedriveController, PipedriveWebhookController],
  providers: [
    PipedriveAdapter,
    PipedriveService,
    PipedriveWebhookService,
    PipedriveWebhookWorker,
  ],
})
export class PipedriveModule {}
