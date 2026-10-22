import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InboundWebhookProductionService } from "../../src/inbound-webhook-production/inbound-webhook-production.service";
import { InboundWebhookObservationService } from "../../src/inbound-webhooks/inbound-webhook-observation.service";
import {
  buildInboundWebhookEventDedupeKey,
  type InboundWebhookEventNormalizedSummary,
} from "../../src/inbound-webhooks/providers/inbound-webhook-parser";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import * as originalBind from "../../src/inbound-webhooks/unnichat-original-bind";
import {
  parseOriginalUnnichatOccurrence,
  UnnichatOriginalBindMismatchError,
} from "../../src/inbound-webhooks/unnichat-original-bind";

// Regression for d02ddb6: the Unnichat parser builds a click-scoped dedupe key
// (externalId:sha256(ctwa_clid)) but the observation service persisted a fixed
// summary without ctwaEntryIdentityHash, so replay and live production could
// never re-prove the original bind. These tests go through the REAL persisted
// summary shape (InboundWebhookObservationService.eventSummary + JSON).

const payload = JSON.parse(
  readFileSync(__dirname + "/fixtures/entry-with-ctwa.json", "utf8"),
) as Record<string, unknown>;
const phone = "551100001020";
const context = { organizationId: "w", connectedPhone: phone };
const registry = new InboundWebhookParserRegistry();
const parser = registry.resolve({
  provider: "unnichat",
  parserVersion: "v1",
  parserReleaseStatus: "certified",
});

function persistedSummary(
  summary: InboundWebhookEventNormalizedSummary,
): Record<string, unknown> {
  const observation = Object.create(
    InboundWebhookObservationService.prototype,
  ) as {
    eventSummary(
      value: InboundWebhookEventNormalizedSummary,
    ): InboundWebhookEventNormalizedSummary;
    toJsonValue(value: object): unknown;
  };
  return observation.toJsonValue(observation.eventSummary(summary)) as Record<
    string,
    unknown
  >;
}

function legacyKey(externalMessageId: string): string {
  return buildInboundWebhookEventDedupeKey({
    provider: "unnichat",
    organizationId: "w",
    providerChannelId: phone,
    externalMessageId,
  });
}

/** Persisted event row exactly as the observation service writes it. */
function storedEvent(shape: "current" | "pre_fix_without_hash" | "legacy_key") {
  const parsed = parser.parse(payload, context).events[0]!;
  const summary = persistedSummary(parsed.normalizedSummary);
  if (shape !== "current") delete summary.ctwaEntryIdentityHash;
  return {
    id: "e",
    workspaceId: "w",
    connectionId: "c",
    channelId: "ch",
    provider: "unnichat",
    dedupeKey:
      shape === "legacy_key"
        ? legacyKey(parsed.externalMessageId!)
        : parsed.dedupeKey,
    externalMessageId: parsed.externalMessageId,
    normalizedSummary: summary,
    occurredAt: new Date("2026-10-11T10:00:00Z"),
    delivery: { id: "d", workspaceId: "w", connectionId: "c" },
    connection: {
      id: "c",
      workspaceId: "w",
      provider: "unnichat",
      parserRelease: { version: "v1", status: "certified" },
    },
    channel: {
      id: "ch",
      workspaceId: "w",
      connectionId: "c",
      organizationId: "w",
      providerChannelId: phone,
      connectedPhone: phone,
    },
  };
}

describe("observation eventSummary keeps the Unnichat click identity hash", () => {
  it("persists only sha256(ctwa_clid), never the raw ctwa_clid", () => {
    const parsed = parser.parse(payload, context).events[0]!;
    const summary = persistedSummary(parsed.normalizedSummary);
    expect(summary.ctwaEntryIdentityHash).toBe(
      createHash("sha256")
        .update(String(payload.ctwa_clid), "utf8")
        .digest("hex"),
    );
    expect(JSON.stringify(summary)).not.toContain(String(payload.ctwa_clid));
    expect(summary).not.toHaveProperty("ctwaClid");
  });

  it("drops a malformed hash instead of persisting arbitrary data", () => {
    const parsed = parser.parse(payload, context).events[0]!;
    const summary = persistedSummary({
      ...parsed.normalizedSummary,
      ctwaEntryIdentityHash: "raw-ctwa-clid-value",
    });
    expect(summary).not.toHaveProperty("ctwaEntryIdentityHash");
  });

  it("does not add the field for events without CTWA", () => {
    const { ctwa_clid: _ignored, ...withoutCtwa } = payload;
    const parsed = parser.parse(withoutCtwa, context).events[0]!;
    expect(persistedSummary(parsed.normalizedSummary)).not.toHaveProperty(
      "ctwaEntryIdentityHash",
    );
  });
});

// Replay of Unnichat entries is not part of this edition (the student
// recovery flow stays Meta Cloud only): the bind is proven by live production.
for (const [cls, prefix] of [
  [InboundWebhookProductionService, "inbound_webhook_production"],
] as const)
  describe(`${cls.name} original bind over the persisted summary`, () => {
    function subject(body: unknown = payload) {
      return Object.assign(Object.create(cls.prototype), {
        parserRegistry: registry,
        payloadEncryption: {
          decrypt: () => Buffer.from(JSON.stringify(body)),
        },
      }) as {
        reparseEvent(item: { event: ReturnType<typeof storedEvent> }): {
          dedupeKey: string;
          ctwaClid: string | null;
          occurredAt: Date;
        };
      };
    }

    function errorCode(run: () => unknown): string | undefined {
      try {
        run();
      } catch (error) {
        const svc = Object.create(cls.prototype) as Record<
          string,
          (value: unknown) => string
        >;
        return svc.productionErrorCode.call(svc, error);
      }
      return undefined;
    }

    it.each(["current", "pre_fix_without_hash", "legacy_key"] as const)(
      "re-proves the original bind for a %s stored event",
      (shape) => {
        const event = storedEvent(shape);
        const reparsed = subject().reparseEvent({ event });
        expect(reparsed.dedupeKey).toBe(event.dedupeKey);
        expect(reparsed.ctwaClid).toBe(payload.ctwa_clid);
        expect(reparsed.occurredAt).toEqual(event.occurredAt);
      },
    );

    it("rejects a pre-fix event whose stored key belongs to another click", () => {
      const event = storedEvent("pre_fix_without_hash");
      const code = errorCode(() =>
        subject({ ...payload, ctwa_clid: "another_click" }).reparseEvent({
          event,
        }),
      );
      expect(code).toBe(`${prefix}_event_mismatch`);
    });

    it("rejects a pre-fix event whose stored key belongs to another channel", () => {
      const event = storedEvent("pre_fix_without_hash");
      event.dedupeKey = buildInboundWebhookEventDedupeKey({
        provider: "unnichat",
        organizationId: "w",
        providerChannelId: "559999999999",
        externalMessageId: `${event.externalMessageId}:${createHash("sha256")
          .update(String(payload.ctwa_clid), "utf8")
          .digest("hex")}`,
      });
      expect(errorCode(() => subject().reparseEvent({ event }))).toBe(
        `${prefix}_event_mismatch`,
      );
    });

    it("surfaces a typed bind code when the channel no longer matches", () => {
      const event = storedEvent("current");
      event.channel.providerChannelId = "559999999999";
      expect(errorCode(() => subject().reparseEvent({ event }))).toBe(
        `${prefix}_unnichat_bind_mismatch`,
      );
    });

    it("surfaces a typed bind code when the retained hash disagrees with the key", () => {
      const event = storedEvent("current");
      event.normalizedSummary.ctwaEntryIdentityHash = "0".repeat(64);
      expect(errorCode(() => subject().reparseEvent({ event }))).toBe(
        `${prefix}_unnichat_bind_mismatch`,
      );
    });

    it("never downgrades a malformed retained hash to the legacy path", () => {
      const event = storedEvent("legacy_key");
      event.normalizedSummary.ctwaEntryIdentityHash = "not-a-hash";
      expect(errorCode(() => subject().reparseEvent({ event }))).toBe(
        `${prefix}_unnichat_bind_mismatch`,
      );
    });

    it("maps a raw bind error to the typed code instead of _unexpected", () => {
      expect(
        errorCode(() => {
          throw new UnnichatOriginalBindMismatchError();
        }),
      ).toBe(`${prefix}_unnichat_bind_mismatch`);
    });
  });

describe("parseOriginalUnnichatOccurrence enforces the occurrence proof", () => {
  it("exposes only the combined entry point", () => {
    expect(originalBind).not.toHaveProperty("originalUnnichatContext");
    expect(originalBind).not.toHaveProperty(
      "matchesOriginalUnnichatOccurrence",
    );
  });

  it("rejects a no-hash occurrence whose key is not reproducible from the bound channel", () => {
    const event = storedEvent("pre_fix_without_hash");
    const forged = parser.parse(payload, {
      organizationId: "other_org",
      connectedPhone: phone,
    }).events[0]!;
    event.dedupeKey = buildInboundWebhookEventDedupeKey({
      provider: "unnichat",
      organizationId: "other_org",
      providerChannelId: phone,
      externalMessageId: event.externalMessageId!,
    });
    // A parser that ignored the bound context would select this candidate;
    // the bind still refuses it because the key is not the bound channel's.
    expect(() =>
      parseOriginalUnnichatOccurrence(event, () => ({
        ...parser.parse(payload, context),
        events: [forged],
      })),
    ).toThrow(UnnichatOriginalBindMismatchError);
  });
});
