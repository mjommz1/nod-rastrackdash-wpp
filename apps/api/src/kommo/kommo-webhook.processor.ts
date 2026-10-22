import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  KOMMO_WEBHOOK_QUEUE,
  type KommoWebhookJobPayload,
} from "../common/queue/queue.constants";
import { KommoService } from "./kommo.service";
@Processor(KOMMO_WEBHOOK_QUEUE)
export class KommoWebhookProcessor extends WorkerHost {
  constructor(
    private readonly kommo: KommoService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }
  async process(job: Job<KommoWebhookJobPayload>) {
    try {
      const result = await this.kommo.process(
        job.data.eventId,
        job.data.workspaceId,
      );
      await this.attempt(job, result.status);
      return result;
    } catch (error) {
      await this.attempt(job, "failed");
      throw error;
    }
  }
  private async attempt(job: Job<KommoWebhookJobPayload>, status: string) {
    await this.prisma.jobAttempt.create({
      data: {
        workspaceId: job.data.workspaceId,
        queueName: KOMMO_WEBHOOK_QUEUE,
        jobId: String(job.id),
        jobName: job.name,
        attemptNumber: job.attemptsMade + 1,
        status,
        startedAt: new Date(),
        finishedAt: new Date(),
        source: "kommo",
        relatedEntityType: "KommoWebhookEvent",
        relatedEntityId: job.data.eventId,
        summaryPayload: { provider: "kommo", redacted: true },
      },
    });
  }
}
