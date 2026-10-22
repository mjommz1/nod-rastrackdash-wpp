import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../common/prisma/prisma.module";
import { INBOUND_WEBHOOK_REPLAY_QUEUE } from "../common/queue/queue.constants";
import { QueueModule } from "../common/queue/queue.module";
import { RuntimeModule } from "../common/runtime/runtime.module";
import { ConversionEventsModule } from "../conversion-events/conversion-events.module";
import { InboundWebhooksModule } from "../inbound-webhooks/inbound-webhooks.module";
import { LeadsModule } from "../leads/leads.module";
import { InboundWebhookReplayQueueService } from "./inbound-webhook-replay-queue.service";
import { InboundWebhookReplayProcessor } from "./inbound-webhook-replay.processor";
import { InboundWebhookReplayService } from "./inbound-webhook-replay.service";
import { StudentInboundReplayController } from "./student-inbound-replay.controller";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { LicenseClientModule } from "../licensing-client/license-client.module";

@Module({
  imports: [
    AuthModule,
    WorkspacesModule,
    LicenseClientModule,
    PrismaModule,
    RuntimeModule,
    QueueModule,
    LeadsModule,
    ConversionEventsModule,
    InboundWebhooksModule,
    BullModule.registerQueue({
      name: INBOUND_WEBHOOK_REPLAY_QUEUE,
    }),
  ],
  controllers: [StudentInboundReplayController],
  providers: [
    InboundWebhookReplayProcessor,
    InboundWebhookReplayQueueService,
    InboundWebhookReplayService,
  ],
})
export class InboundWebhookReplayModule {}
