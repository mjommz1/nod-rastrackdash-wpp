import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsService } from "../src/diagnostics/diagnostics.service";

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "blocked",
    workspaceId: "workspace_1",
    eventName: "Purchase",
    sourceTrigger: "keyword",
    status: "not_configured",
    errorCode: "MissingAccessToken" as string | null,
    errorMessage: "original",
    sentAt: null,
    jobId: "original_job",
    dedupeKey: "dedupe",
    eventId: "meta_event",
    ...overrides,
  };
}

function harness(events = [event()]) {
  const prisma = {
    conversionEventLog: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = events.find((row) => row.id === where.id);
        return row ? { ...row } : null;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const row = events.find((row) =>
            Object.entries(where).every(
              ([key, value]) => (row as Record<string, unknown>)[key] === value,
            ),
          );
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
      update: vi.fn(async () => ({})),
    },
    auditLog: { create: vi.fn(async () => ({ id: "audit" })) },
    jobAttempt: { create: vi.fn(async () => ({ id: "attempt" })) },
    diagnosticEvent: { create: vi.fn(async () => ({ id: "diagnostic" })) },
  };
  const queue = { retrySend: vi.fn(async () => ({ jobId: "retry_job" })) };
  const service = new DiagnosticsService(
    prisma as never,
    undefined,
    queue as never,
  );
  return { prisma, queue, service, events };
}

const context = {
  workspaceId: "workspace_1",
  actorUserId: "owner",
  actorType: "workspace_owner",
  transientOnly: true,
  allowConfigurationBlocked: true,
};
const input = { reason: "Configuration repaired" };

describe("diagnostics conversion retries", () => {
  it.each([
    ["not_configured", "MissingAccessToken"],
    ["not_configured", "MissingMetaDestination"],
    ["not_configured", null],
    ["error", "MetaCapiNetworkError"],
  ])(
    "retries %s / %s once and preserves Meta identity",
    async (status, errorCode) => {
      const { service, queue, prisma, events } = harness([
        event({ status, errorCode }),
      ]);
      await expect(
        service.retryConversionEvent("blocked", input, context),
      ).resolves.toMatchObject({
        ok: true,
        status: "queued",
        auditLogId: "audit",
      });
      expect(queue.retrySend).toHaveBeenCalledTimes(1);
      expect(queue.retrySend).toHaveBeenCalledWith("blocked", "workspace_1");
      expect(events[0]).toMatchObject({
        status: "ready_to_send",
        errorCode: null,
        errorMessage: null,
        eventId: "meta_event",
        dedupeKey: "dedupe",
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: "workspace_1",
            actorUserId: "owner",
            actorType: "workspace_owner",
            beforeSummary: expect.objectContaining({ status, errorCode }),
          }),
        }),
      );
      await expect(
        service.retryConversionEvent("blocked", input, context),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(queue.retrySend).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["not_configured", "OtherError"],
    ["error", "MetaCapiRejected"],
    ["pending_meta_context", "MissingMetaDestination"],
    ["pending_value", null],
    ["not_eligible", null],
    ["sent", null],
    ["skipped", null],
    ["queued", null],
    ["ready_to_send", null],
  ])("rejects %s / %s without writes", async (status, errorCode) => {
    const { service, queue, prisma } = harness([event({ status, errorCode })]);
    await expect(
      service.retryConversionEvent("blocked", input, context),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.conversionEventLog.updateMany).not.toHaveBeenCalled();
    expect(queue.retrySend).not.toHaveBeenCalled();
  });

  it("retains the transient-only restriction unless configuration retries are enabled", async () => {
    const { service, queue } = harness();
    await expect(
      service.retryConversionEvent("blocked", input, {
        ...context,
        allowConfigurationBlocked: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(queue.retrySend).not.toHaveBeenCalled();
  });

  it("hides foreign and missing events from single retries", async () => {
    const { service, queue } = harness([event({ workspaceId: "workspace_2" })]);
    for (const id of ["blocked", "missing"]) {
      await expect(
        service.retryConversionEvent(id, input, context),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(queue.retrySend).not.toHaveBeenCalled();
  });

  it("rejects a lost single claim without enqueueing", async () => {
    const { service, prisma, queue } = harness();
    prisma.conversionEventLog.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.retryConversionEvent("blocked", input, context),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(queue.retrySend).not.toHaveBeenCalled();
  });

  it("rechecks bulk eligibility and workspace, restores queue failures and continues", async () => {
    const { service, queue, events } = harness([
      event(),
      event({ id: "destination", errorCode: "MissingMetaDestination" }),
      event({ id: "foreign", workspaceId: "workspace_2" }),
      event({ id: "changed", status: "sent" }),
      event({
        id: "network",
        status: "error",
        errorCode: "MetaCapiNetworkError",
      }),
    ]);
    queue.retrySend.mockRejectedValueOnce(new Error("Redis unavailable"));
    expect(
      await service.retryBlockedConversionEvents(
        [
          "blocked",
          "destination",
          "foreign",
          "changed",
          "network",
          "missing",
          "destination",
        ],
        input,
        context,
      ),
    ).toEqual({ claimed: 2, enqueued: 1, skipped: 4, failed: 1 });
    expect(events[0]).toMatchObject(event());
    expect(events[1].status).toBe("ready_to_send");
    expect(queue.retrySend.mock.calls).toEqual([
      ["blocked", "workspace_1"],
      ["destination", "workspace_1"],
    ]);
  });

  it("counts a lost bulk claim as skipped", async () => {
    const { service, prisma, queue } = harness();
    prisma.conversionEventLog.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(
      await service.retryBlockedConversionEvents(["blocked"], input, context),
    ).toEqual({ claimed: 0, enqueued: 0, skipped: 1, failed: 0 });
    expect(queue.retrySend).not.toHaveBeenCalled();
  });

  it("enqueues once when two bulk requests race for the same event", async () => {
    const { service, queue } = harness();
    const results = await Promise.all([
      service.retryBlockedConversionEvents(["blocked"], input, context),
      service.retryBlockedConversionEvents(["blocked"], input, context),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        { claimed: 1, enqueued: 1, skipped: 0, failed: 0 },
        { claimed: 0, enqueued: 0, skipped: 1, failed: 0 },
      ]),
    );
    expect(queue.retrySend).toHaveBeenCalledTimes(1);
  });

  it("counts HTTP-style queue errors as failures after claiming", async () => {
    const { service, queue, events } = harness();
    queue.retrySend.mockRejectedValueOnce(
      new BadRequestException("Queue rejected retry"),
    );
    expect(
      await service.retryBlockedConversionEvents(["blocked"], input, context),
    ).toEqual({ claimed: 1, enqueued: 0, skipped: 0, failed: 1 });
    expect(events[0]).toMatchObject(event());
  });

  it("reports successful queueing even if audit persistence then fails", async () => {
    const { service, prisma, events } = harness();
    prisma.auditLog.create.mockRejectedValueOnce(
      new Error("Audit unavailable"),
    );
    expect(
      await service.retryBlockedConversionEvents(["blocked"], input, context),
    ).toEqual({ claimed: 1, enqueued: 1, skipped: 0, failed: 1 });
    expect(events[0].status).toBe("ready_to_send");
  });

  it("handles empty batches and caps deduplicated batches at 500", async () => {
    const events = Array.from({ length: 501 }, (_, index) =>
      event({ id: `blocked_${index}` }),
    );
    const { service, queue } = harness(events);
    expect(
      await service.retryBlockedConversionEvents([], input, context),
    ).toEqual({ claimed: 0, enqueued: 0, skipped: 0, failed: 0 });
    expect(
      await service.retryBlockedConversionEvents(
        [events[0].id, ...events.map((row) => row.id)],
        input,
        context,
      ),
    ).toEqual({ claimed: 500, enqueued: 500, skipped: 0, failed: 0 });
    expect(queue.retrySend).toHaveBeenCalledTimes(500);
    expect(events[500].status).toBe("not_configured");
  });
});
