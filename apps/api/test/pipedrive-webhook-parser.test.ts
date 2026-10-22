import { describe, expect, it } from "vitest";
import {
  decodePipedriveBody,
  parsePipedriveStageEvents,
  pipedriveDeliveryKey,
} from "../src/pipedrive/pipedrive-webhook.parser";

function payload() {
  return {
    meta: {
      action: "change",
      entity: "deal",
      company_id: "1",
      entity_id: "2",
      id: "synthetic-event-1",
      timestamp: "2026-01-01T00:00:00.123Z",
      version: "2.0",
      host: "example.pipedrive.com",
      attempt: 1,
    },
    data: {
      id: 2,
      pipeline_id: 3,
      stage_id: 4,
      person_id: 5,
      value: 12.34,
      currency: "brl",
    },
    previous: { stage_id: 6 },
  };
}

describe("Pipedrive JSON webhook parser", () => {
  it("preserves webhook-time ids, timestamp, value and currency without a phone or stage name", () => {
    const events = parsePipedriveStageEvents(
      decodePipedriveBody(
        Buffer.from(JSON.stringify(payload())),
        "application/json; charset=utf-8",
      ),
    );
    expect(events).toEqual([
      {
        kind: "stage_change",
        accountId: "1",
        accountSubdomain: "example",
        dealId: "2",
        pipelineId: "3",
        stageId: "4",
        oldStageId: "6",
        dealStatus: null,
        previousDealStatus: null,
        personId: "5",
        eventId: "synthetic-event-1",
        occurredAt: new Date("2026-01-01T00:00:00.123Z"),
        changedAt: new Date("2026-01-01T00:00:00.123Z"),
        valueCents: 1234,
        valuePresent: true,
        currency: "BRL",
      },
    ]);
  });
  it("allows missing person, company metadata and value for later service decisions", () => {
    const input: any = payload();
    input.data.person_id = null;
    delete input.meta.company_id;
    delete input.meta.host;
    delete input.meta.id;
    delete input.data.value;
    delete input.data.currency;
    expect(parsePipedriveStageEvents(input)?.[0]).toMatchObject({
      personId: null,
      accountId: null,
      accountSubdomain: null,
      eventId: null,
      valuePresent: false,
      valueCents: null,
      currency: null,
    });
  });
  it("ignores other entities/actions and absent or unchanged previous stage", () => {
    for (const change of [
      (p: any) => {
        p.meta.entity = "person";
        p.data = null;
      },
      (p: any) => {
        p.meta.action = "create";
        p.previous = null;
      },
      (p: any) => {
        p.meta.action = "delete";
        p.data = null;
      },
      (p: any) => {
        p.previous = {};
      },
      (p: any) => {
        p.previous = null;
      },
      (p: any) => {
        p.previous.stage_id = 4;
      },
    ]) {
      const input = payload();
      change(input);
      expect(parsePipedriveStageEvents(input)).toEqual([]);
    }
  });
  it.each(["id", "pipeline_id", "stage_id"])(
    "requires deal %s on stage changes",
    (field) => {
      const input: any = payload();
      delete input.data[field];
      expect(parsePipedriveStageEvents(input)).toBeNull();
    },
  );
  it.each([null, {}, [], "bad", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid ids %s",
    (id) => {
      const input: any = payload();
      input.data.id = id;
      expect(parsePipedriveStageEvents(input)).toBeNull();
    },
  );
  it.each([
    "",
    "not-a-date",
    "2026-02-30T00:00:00Z",
    1767225600,
    "2026-01-01",
    "2026-01-01T00:00:00",
  ])("rejects invalid v2 timestamp %s", (timestamp) => {
    const input: any = payload();
    input.meta.timestamp = timestamp;
    expect(parsePipedriveStageEvents(input)).toBeNull();
  });
  it("rejects conflicting entity ids, malformed previous ids, and unsupported versions", () => {
    const input: any = payload();
    input.meta.entity_id = "9";
    expect(parsePipedriveStageEvents(input)).toBeNull();
    input.meta.entity_id = "2";
    input.previous.stage_id = {};
    expect(parsePipedriveStageEvents(input)).toBeNull();
    input.previous.stage_id = 6;
    input.meta.version = "1.0";
    expect(parsePipedriveStageEvents(input)).toBeNull();
  });
  it.each([
    [0, 0],
    ["0.29", 29],
    ["12.34", 1234],
    [-1.25, -125],
  ])("parses exact monetary value %s", (value, cents) => {
    const input: any = payload();
    input.data.value = value;
    expect(parsePipedriveStageEvents(input)?.[0]?.valueCents).toBe(cents);
  });
  it.each(["1.234", "1e2", "NaN", {}, true, 9007199254740991])(
    "rejects invalid or unsafe value %s",
    (value) => {
      const input: any = payload();
      input.data.value = value;
      expect(parsePipedriveStageEvents(input)).toBeNull();
    },
  );
  it.each(["B", "123", {}, true])(
    "rejects malformed currency %s",
    (currency) => {
      const input: any = payload();
      input.data.currency = currency;
      expect(parsePipedriveStageEvents(input)).toBeNull();
    },
  );
  it("keeps delivery keys stable across retries and irrelevant data, scoped to the event and connection", () => {
    const input: any = payload();
    const first = parsePipedriveStageEvents(input)![0]!;
    const key = pipedriveDeliveryKey("connection-1", first);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    input.meta.attempt = 4;
    input.meta.id = "synthetic-redelivery";
    input.meta.correlation_id = "synthetic-retry";
    input.data.custom_fields = { unused: "synthetic" };
    expect(
      pipedriveDeliveryKey(
        "connection-1",
        parsePipedriveStageEvents(input)![0]!,
      ),
    ).toBe(key);
    expect(pipedriveDeliveryKey("connection-2", first)).not.toBe(key);
    for (const override of [
      { stageId: "7" },
      { oldStageId: "8" },
      { dealId: "9" },
      { pipelineId: "10" },
      { accountId: "11" },
      { kind: "deal_won" as const },
      { dealStatus: "won" as const },
      { changedAt: new Date("2026-01-01T00:00:01Z") },
      { valueCents: 0 },
      { currency: "USD" },
    ]) {
      expect(
        pipedriveDeliveryKey("connection-1", { ...first, ...override }),
      ).not.toBe(key);
    }
  });
  it("accepts JSON only and rejects malformed, oversize and invalid UTF-8 bodies", () => {
    const raw = Buffer.from(JSON.stringify(payload()));
    for (const type of [
      undefined,
      "text/plain",
      "application/x-www-form-urlencoded",
      "application/json; charset=latin1",
      "application/json; extra=1",
    ]) {
      expect(decodePipedriveBody(raw, type)).toBeNull();
    }
    for (const body of [
      Buffer.from("{"),
      Buffer.alloc(100 * 1024 + 1),
      Buffer.from([0xff]),
      {},
      raw.toString(),
    ]) {
      expect(decodePipedriveBody(body, "application/json")).toBeNull();
    }
    expect(parsePipedriveStageEvents(null)).toBeNull();
  });
  it("rejects prototype pollution and bounds nesting/items before parsing", () => {
    for (const key of [
      "__proto__",
      "constructor",
      "prototype",
      "constr\\u0075ctor",
    ]) {
      expect(
        decodePipedriveBody(
          Buffer.from(`{"unused":{"${key}":{}}}`),
          "application/json",
        ),
      ).toBeNull();
    }
    const input: any = payload();
    input.data.unused = Object.create({ stage_id: 99 });
    expect(parsePipedriveStageEvents(input)).toBeNull();
    for (const raw of [
      "[".repeat(10000) + "0" + "]".repeat(10000),
      JSON.stringify({ unused: Array(5001).fill(0) }),
    ]) {
      expect(
        decodePipedriveBody(Buffer.from(raw), "application/json"),
      ).toBeNull();
    }
    expect(({} as any).polluted).toBeUndefined();
  });
});
