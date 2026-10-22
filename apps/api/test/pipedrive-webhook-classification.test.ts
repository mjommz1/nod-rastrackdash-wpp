import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPipedriveDealChange,
  decodePipedriveBody,
  parsePipedriveWebhookMetadata,
  pipedriveDeliveryKey,
} from "../src/pipedrive/pipedrive-webhook.parser";

// Anonymized copies of real Webhooks v2 "deal change" bodies (structure kept,
// every id/name/host/uuid replaced). `previous` carries only changed fields.
function fixture(name: string): any {
  return JSON.parse(
    readFileSync(resolve(__dirname, "fixtures/pipedrive", name), "utf8"),
  );
}
function classify(body: unknown) {
  return classifyPipedriveDealChange(
    decodePipedriveBody(
      Buffer.from(JSON.stringify(body)),
      "application/json",
    ),
  );
}

describe("Pipedrive deal change classification (real v2 shapes)", () => {
  it("won: status open -> won is a deal_won event with the deal value/currency", () => {
    const result = classify(fixture("deal-won.json"));
    expect(result).toEqual({
      kind: "event",
      event: {
        kind: "deal_won",
        accountId: "1000001",
        accountSubdomain: "example-company",
        dealId: "4001",
        pipelineId: "1",
        stageId: "1",
        oldStageId: null,
        dealStatus: "won",
        previousDealStatus: "open",
        personId: "3001",
        eventId: "00000000-0000-4000-8000-000000000001",
        occurredAt: new Date("2026-10-12T20:37:06.577Z"),
        changedAt: new Date("2026-10-12T20:37:06Z"),
        valueCents: 600000,
        valuePresent: true,
        currency: "BRL",
      },
    });
  });

  it("custom field only: ignored, never an event", () => {
    expect(classify(fixture("deal-custom-field-only.json"))).toEqual({
      kind: "ignored",
      reason: "no_relevant_change",
    });
  });

  it("stage change: previous.stage_id differs -> stage_change", () => {
    const result = classify(fixture("deal-stage-change.json"));
    expect(result).toMatchObject({
      kind: "event",
      event: {
        kind: "stage_change",
        dealId: "4001",
        pipelineId: "1",
        stageId: "1",
        oldStageId: "6",
        dealStatus: "open",
        previousDealStatus: null,
        personId: "3001",
        valueCents: 0,
        valuePresent: true,
        currency: "BRL",
      },
    });
  });

  it("lost: status open -> lost is recorded as deal_lost", () => {
    const body = fixture("deal-won.json");
    body.data.status = "lost";
    body.data.won_time = null;
    body.data.lost_time = "2026-10-12T20:37:06Z";
    body.previous = { status: "open", lost_time: null, close_time: null };
    expect(classify(body)).toMatchObject({
      kind: "event",
      event: { kind: "deal_lost", dealStatus: "lost", previousDealStatus: "open" },
    });
  });

  it("status and stage changed together: won/lost takes precedence, stage kept", () => {
    const won = fixture("deal-won.json");
    won.previous = { ...won.previous, stage_id: 6 };
    expect(classify(won)).toMatchObject({
      kind: "event",
      event: { kind: "deal_won", stageId: "1", oldStageId: "6" },
    });
    const lost = fixture("deal-stage-change.json");
    lost.data.status = "lost";
    lost.previous = { stage_id: 6, status: "open" };
    expect(classify(lost)).toMatchObject({
      kind: "event",
      event: { kind: "deal_lost", oldStageId: "6" },
    });
  });

  it("ignores reopen, edits of an already won deal and unchanged status keys", () => {
    for (const mutate of [
      (b: any) => {
        b.data.status = "open";
        b.previous = { status: "won" };
      },
      (b: any) => {
        b.previous = { custom_fields: { synthetic_custom_field_a: null } };
      },
      (b: any) => {
        b.previous = { status: "won" };
      },
      (b: any) => {
        b.previous = { value: 5000, update_time: "2026-10-12T20:37:00Z" };
      },
      (b: any) => {
        b.previous = { stage_id: 1 };
      },
    ]) {
      const body = fixture("deal-won.json");
      mutate(body);
      expect(classify(body)).toEqual({
        kind: "ignored",
        reason: "no_relevant_change",
      });
    }
  });

  it("other entities/actions are ignored, malformed status is rejected", () => {
    const person = fixture("deal-stage-change.json");
    person.meta.entity = "person";
    expect(classify(person)).toEqual({
      kind: "ignored",
      reason: "not_deal_change",
    });
    const bad = fixture("deal-won.json");
    bad.data.status = 7;
    expect(classify(bad)).toBeNull();
  });

  it("retries (new meta.id/attempt/correlation) keep the same delivery key", () => {
    const first = classify(fixture("deal-won.json"));
    const retry = fixture("deal-won.json");
    retry.meta.id = "00000000-0000-4000-8000-0000000000ff";
    retry.meta.attempt = 3;
    retry.meta.correlation_id = "00000000-0000-4000-8000-0000000000fe";
    retry.meta.timestamp = "2026-10-12T20:39:06.000Z";
    const second = classify(retry);
    if (first?.kind !== "event" || second?.kind !== "event")
      throw new Error("expected events");
    expect(pipedriveDeliveryKey("connection-1", second.event)).toBe(
      pipedriveDeliveryKey("connection-1", first.event),
    );
    const stage = classify(fixture("deal-stage-change.json"));
    if (stage?.kind !== "event") throw new Error("expected event");
    expect(pipedriveDeliveryKey("connection-1", stage.event)).not.toBe(
      pipedriveDeliveryKey("connection-1", first.event),
    );
  });

  it("exposes the account assertions every delivery is checked against", () => {
    for (const name of [
      "deal-won.json",
      "deal-custom-field-only.json",
      "deal-stage-change.json",
    ])
      expect(parsePipedriveWebhookMetadata(fixture(name))).toMatchObject({
        accountId: "1000001",
        accountSubdomain: "example-company",
      });
  });
});
