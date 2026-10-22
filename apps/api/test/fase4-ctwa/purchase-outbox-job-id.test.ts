import { describe, expect, it, vi } from "vitest";
import { ConversionEventsQueueService } from "../../src/common/queue/conversion-events-queue.service";

describe("Purchase outbox enqueue is idempotent across replicas", () => {
  it("uses a deterministic job id per conversion, so concurrent recoveries collapse into one job", async () => {
    const add = vi.fn(async (_name: string, _data: unknown, options: { jobId: string }) => ({
      id: options.jobId,
    }));
    const queue = new ConversionEventsQueueService({ add } as never);
    const first = await queue.enqueueSend("log-1", "ws1");
    const second = await queue.enqueueSend("log-1", "ws1");
    expect(first.jobId).toBe(second.jobId);
    expect(add.mock.calls[0]![2].jobId).toBe(add.mock.calls[1]![2].jobId);
    expect((await queue.enqueueSend("log-2", "ws1")).jobId).not.toBe(first.jobId);
  });
});
