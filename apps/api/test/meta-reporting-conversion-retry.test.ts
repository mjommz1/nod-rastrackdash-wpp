import { describe, expect, it, vi } from "vitest";
import { MetaReportingService } from "../src/reporting/meta-reporting.service";

type Row = Record<string, unknown>;

// Evaluate the Prisma operators used by audit filters against explicit fixtures.
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND")
      return (value as Row[]).every((clause) => matches(row, clause));
    if (key === "OR")
      return (value as Row[]).some((clause) => matches(row, clause));
    if (key === "NOT") return !matches(row, value as Row);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      return Object.entries(value).every(([operator, operand]) => {
        if (operator === "in") return (operand as unknown[]).includes(row[key]);
        if (operator === "startsWith")
          return String(row[key]).startsWith(String(operand));
        if (operator === "gte") return (row[key] as Date) >= (operand as Date);
        if (operator === "lte") return (row[key] as Date) <= (operand as Date);
        throw new Error(`Unsupported query operator: ${operator}`);
      });
    }
    return row[key] === value;
  });
}

function event(overrides: Row = {}) {
  return {
    id: "blocked",
    workspaceId: "workspace_1",
    eventName: "LeadSubmitted",
    status: "not_configured",
    errorCode: "MissingAccessToken",
    sourceTrigger: "external_mysql:students",
    ctwaClid: null,
    eventOccurredAt: new Date("2026-07-02T12:00:00.000Z"),
    sentAt: null,
    leadId: null,
    phoneHash: null,
    campaignId: null,
    adSetId: null,
    adId: null,
    pixelId: null,
    pageId: null,
    valueCents: null,
    valueSource: null,
    providerResponseSummary: null,
    providerRequestPayload: {},
    sourcePayload: {},
    ...overrides,
  };
}

function harness(events: Row[]) {
  const prisma = {
    conversionEventLog: {
      findMany: vi.fn(
        async ({
          where,
          take,
          skip = 0,
        }: {
          where: Row;
          take: number;
          skip?: number;
        }) =>
          events
            .filter((row) => matches(row, where))
            .sort(
              (a, b) =>
                (b.eventOccurredAt as Date).getTime() -
                  (a.eventOccurredAt as Date).getTime() ||
                String(b.id).localeCompare(String(a.id)),
            )
            .slice(skip, skip + take),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Row }) =>
          events.find((row) => matches(row, where)) ?? null,
      ),
      groupBy: vi.fn(async () => []),
    },
    externalIngestionRecord: { findFirst: vi.fn(async () => null) },
  };
  const funnel = { getConfiguration: vi.fn(async () => ({ stages: [] })) };
  const service = new MetaReportingService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    funnel as never,
  );
  return { service, prisma };
}

const filters = {
  workspaceId: "workspace_1",
  since: "2026-07-01",
  until: "2026-07-02",
};

describe("Meta reporting conversion retries", () => {
  it.each([
    ["error", "MetaCapiNetworkError", true],
    ["not_configured", "MissingAccessToken", true],
    ["not_configured", "MissingMetaDestination", true],
    ["not_configured", null, true],
    ["not_configured", "OtherError", false],
    ["error", "MetaCapiRejected", false],
    ["pending_meta_context", "MissingMetaDestination", false],
    ["pending_value", null, false],
    ["not_eligible", null, false],
    ["sent", null, false],
    ["skipped", null, false],
    ["queued", null, false],
  ])(
    "exposes consistent overview and detail canRetry for %s / %s",
    async (status, errorCode, canRetry) => {
      const { service } = harness([event({ status, errorCode })]);
      const overview = await service.getConversionEventAudit({
        ...filters,
        rangeLabel: "period",
        page: 1,
        pageSize: 25,
      });
      const detail = await service.getConversionEventAuditDetail({
        workspaceId: "workspace_1",
        eventId: "blocked",
      });
      expect(overview.events[0]).toMatchObject({ id: "blocked", canRetry });
      expect(detail).toMatchObject({ id: "blocked", canRetry });
    },
  );

  it("selects only allowed configuration errors in the workspace and audit period", async () => {
    const { service, prisma } = harness([
      event({ id: "token" }),
      event({ id: "destination", errorCode: "MissingMetaDestination" }),
      event({ id: "legacy", errorCode: null }),
      event({ id: "foreign", workspaceId: "workspace_2" }),
      event({
        id: "old",
        eventOccurredAt: new Date("2026-06-01T12:00:00.000Z"),
      }),
      event({
        id: "later",
        eventOccurredAt: new Date("2026-07-03T12:00:00.000Z"),
      }),
      event({
        id: "network",
        status: "error",
        errorCode: "MetaCapiNetworkError",
      }),
      event({ id: "unknown", errorCode: "OtherError" }),
      event({ id: "pending", status: "pending_meta_context" }),
      event({ id: "no_click", sourceTrigger: "auto_lead" }),
    ]);
    expect(await service.getBlockedConversionEventRetryIds(filters)).toEqual([
      "token",
      "legacy",
      "destination",
    ]);
    expect(prisma.conversionEventLog.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        take: 500,
        select: { id: true },
        orderBy: [{ eventOccurredAt: "desc" }, { id: "desc" }],
      }),
    );
  });

  it("shares the audit filters for event name, delivery state and source", async () => {
    const { service, prisma } = harness([
      event({ id: "external" }),
      event({ id: "purchase", eventName: "Purchase" }),
      event({ id: "keyword", sourceTrigger: "keyword" }),
      event({ id: "inbound", sourceTrigger: "inbound_webhook:data_crazy" }),
      event({ id: "system", sourceTrigger: "auto_lead", ctwaClid: "click" }),
      event({ id: "manual", sourceTrigger: "manual_test" }),
    ]);
    const input = {
      ...filters,
      eventName: "LeadSubmitted",
      deliveryState: "blocked" as const,
      source: "external_integration" as const,
    };
    await service.getConversionEventAudit({
      ...input,
      rangeLabel: "period",
      page: 1,
      pageSize: 25,
    });
    const overviewWhere =
      prisma.conversionEventLog.findMany.mock.calls[0][0].where;
    expect(await service.getBlockedConversionEventRetryIds(input)).toEqual([
      "external",
    ]);
    expect(
      prisma.conversionEventLog.findMany.mock.lastCall?.[0].where.AND,
    ).toContainEqual(overviewWhere);
    expect(
      await service.getBlockedConversionEventRetryIds({
        ...input,
        eventName: "Purchase",
      }),
    ).toEqual(["purchase"]);
    expect(
      await service.getBlockedConversionEventRetryIds({
        ...input,
        deliveryState: "sent",
      }),
    ).toEqual([]);
    expect(
      await service.getBlockedConversionEventRetryIds({
        ...input,
        eventName: "NoMatch",
      }),
    ).toEqual([]);
    expect(
      await service.getBlockedConversionEventRetryIds({
        ...filters,
        source: "whatsapp_automation",
      }),
    ).toEqual(["keyword", "inbound"]);
    expect(
      await service.getBlockedConversionEventRetryIds({
        ...filters,
        source: "system",
      }),
    ).toEqual(["system"]);
    expect(
      await service.getBlockedConversionEventRetryIds({
        ...filters,
        source: "manual_test",
      }),
    ).toEqual(["manual"]);
  });

  it("caps candidates at 500 across event names with newest events first", async () => {
    const events = Array.from({ length: 501 }, (_, index) =>
      event({
        id: `blocked_${String(index).padStart(3, "0")}`,
        eventName: index % 2 ? "Purchase" : "LeadSubmitted",
        errorCode: null,
      }),
    );
    const { service } = harness(events);
    const ids = await service.getBlockedConversionEventRetryIds(filters);
    expect(ids).toHaveLength(500);
    expect(ids[0]).toBe("blocked_500");
    expect(ids).not.toContain("blocked_000");
  });
});
