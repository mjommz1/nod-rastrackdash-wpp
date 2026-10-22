import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInboundWebhookEventDedupeKey } from "../../src/inbound-webhooks/providers/inbound-webhook-parser";
import {
  UNNICHAT_V1_PROVIDER,
  UnnichatV1Parser,
} from "../../src/inbound-webhooks/providers/unnichat/unnichat-v1.parser";

const parser = new UnnichatV1Parser();
const context = {
  organizationId: "workspace_synthetic_001",
  connectedPhone: "+5500000000999",
};

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(resolve(__dirname, "fixtures", name), "utf8"),
  );
}

afterEach(() => vi.useRealTimers());

describe("Unnichat v1 inbound webhook parser", () => {
  it("parses equivalent direct and n8n envelopes identically", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));

    const direct = parser.parse(fixture("entry-with-ctwa.json"), context);
    const envelope = parser.parse(
      fixture("n8n-envelope-with-ctwa.json"),
      context,
    );

    expect(direct).toEqual(envelope);
    expect(direct).toMatchObject({
      provider: "unnichat",
      parserVersion: "v1",
      providerEventType: "lead.created",
      externalDeliveryId: "test-entry-001",
      classification: "eligible_route_unresolved",
      classificationReason: "route_resolution_pending",
      error: null,
      events: [
        {
          externalEventId: "test-entry-001",
          externalMessageId: "test-entry-001",
          organizationId: "workspace_synthetic_001",
          channel: {
            providerChannelId: "+5500000000999",
            connectedPhone: "+5500000000999",
            name: null,
          },
          contact: {
            externalContactId: "test-entry-001",
            phoneNumber: "5500000000000",
            name: null,
          },
          message: {
            direction: "inbound",
            authorType: "contact",
            messageType: null,
            text: null,
            isPrivate: false,
          },
          ctwaClid: "test-ctwa-click-id",
          adId: null,
          ad: null,
          hasCtwa: true,
        },
      ],
    });
    expect(direct.events[0]?.dedupeKey).toBe(
      buildInboundWebhookEventDedupeKey({
        provider: UNNICHAT_V1_PROVIDER,
        organizationId: context.organizationId,
        providerChannelId: context.connectedPhone,
        externalMessageId: `test-entry-001:${createHash("sha256").update("test-ctwa-click-id").digest("hex")}`,
      }),
    );
  });

  it("classifies empty, absent, and whitespace CTWA values as ignored", () => {
    const absent = { ...(fixture("entry-without-ctwa.json") as object) };
    delete (absent as Record<string, unknown>).ctwa_clid;

    for (const payload of [
      fixture("entry-without-ctwa.json"),
      fixture("movement-without-ctwa.json"),
      absent,
    ]) {
      const result = parser.parse(payload, context);
      expect(result).toMatchObject({
        classification: "ignored_no_ctwa",
        classificationReason: "ctwa_missing",
        error: null,
        events: [{ hasCtwa: false, ctwaClid: null, adId: null }],
      });
    }
  });

  it("does not let event_name select a conversion type", () => {
    const payload = fixture("entry-with-ctwa.json") as Record<string, unknown>;
    const result = parser.parse(
      { ...payload, event_name: "Purchase" },
      context,
    );

    expect(result).toMatchObject({
      classification: "eligible_route_unresolved",
      events: [{ providerEventType: "lead.created" }],
    });
    expect(JSON.stringify(result)).not.toContain("Purchase");
  });

  it("uses only the context channel bind and requires it", () => {
    const payload = {
      ...(fixture("entry-with-ctwa.json") as Record<string, unknown>),
      connectedPhone: "+5500000000123",
    };

    expect(
      parser.parse(payload, { organizationId: context.organizationId }),
    ).toMatchObject({
      classification: "invalid_payload",
      classificationReason: "connected_phone_context_missing",
      error: { code: "unnichat_v1_invalid_payload" },
    });
    expect(parser.parse(payload, context).events[0]?.channel).toMatchObject({
      providerChannelId: context.connectedPhone,
      connectedPhone: context.connectedPhone,
    });
  });

  it("rejects unsupported envelopes, provider/channel mismatches, and oversize values", () => {
    const body = fixture("entry-with-ctwa.json") as Record<string, unknown>;
    const invalidPayloads = [
      { ...body, source: "other" },
      { ...body, channel: "telegram" },
      { ...body, external_id: "x".repeat(256) },
      [{ body }, { body }],
      [],
    ];

    for (const payload of invalidPayloads) {
      expect(parser.parse(payload, context)).toMatchObject({
        classification: "invalid_payload",
        events: [],
        error: { code: "unnichat_v1_invalid_payload" },
      });
    }

    expect(parser.parse([], context).classificationReason).toBe(
      "payload_envelope_unsupported",
    );
  });

  it("keeps raw lead phone and CTWA out of normalized summaries", () => {
    const result = parser.parse(fixture("entry-with-ctwa.json"), context);
    const serializedSummary = JSON.stringify(result.normalizedSummary);
    const serializedEventSummary = JSON.stringify(
      result.events[0]?.normalizedSummary,
    );

    expect(serializedSummary).not.toContain("5500000000000");
    expect(serializedSummary).not.toContain("test-ctwa-click-id");
    expect(serializedEventSummary).not.toContain("5500000000000");
    expect(serializedEventSummary).not.toContain("test-ctwa-click-id");
  });
});
