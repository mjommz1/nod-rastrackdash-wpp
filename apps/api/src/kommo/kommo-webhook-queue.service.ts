import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { createBullJobId } from "../common/queue/job-id";
import {
  KOMMO_WEBHOOK_QUEUE,
  type KommoWebhookJobPayload,
} from "../common/queue/queue.constants";

@Injectable()
export class KommoWebhookQueueService {
  constructor(
    @InjectQueue(KOMMO_WEBHOOK_QUEUE)
    private readonly queue: Queue<KommoWebhookJobPayload>,
  ) {}
  async enqueue(eventId: string, workspaceId: string): Promise<string> {
    const jobId = createBullJobId("kommo", eventId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (["active", "waiting", "prioritized", "delayed"].includes(state)) {
        if (state === "delayed") await existing.promote();
        return jobId;
      }
      // BullMQ retains failed jobs with this deterministic id. Retrying it is
      // required; calling add with the same id merely returns a dead record.
      if (state === "failed") {
        await existing.retry();
        return jobId;
      }
      await existing.remove();
    }
    const job = await this.queue.add(
      "process-stage-event",
      { eventId, workspaceId },
      {
        jobId,
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    return String(job.id ?? jobId);
  }
}
