import { buildInboundWebhookEventDedupeKey } from "../../src/inbound-webhooks/providers/inbound-webhook-parser";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import { InboundWebhookProductionService } from "../../src/inbound-webhook-production/inbound-webhook-production.service";
const payload = JSON.parse(
  readFileSync(__dirname + "/fixtures/entry-with-ctwa.json", "utf8"),
);
function event() {
  const registry = new InboundWebhookParserRegistry();
  const parsed = registry
    .resolve({
      provider: "unnichat",
      parserVersion: "v1",
      parserReleaseStatus: "certified",
    })
    .parse(payload, { organizationId: "w", connectedPhone: "551100001020" })
    .events[0]!;
  return {
    registry,
    item: {
      event: {
        id: "e",
        workspaceId: "w",
        connectionId: "c",
        channelId: "ch",
        provider: "unnichat",
        dedupeKey: parsed.dedupeKey,
        externalMessageId: parsed.externalMessageId,
        normalizedSummary: parsed.normalizedSummary,
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
          providerChannelId: "551100001020",
          connectedPhone: "551100001020",
        },
      },
    },
  };
}
// Replay of Unnichat entries is not part of this edition (the student
// recovery flow stays Meta Cloud only): the bind is proven by live production.
for (const cls of [InboundWebhookProductionService])
  describe(cls.name + " real Unnichat original bind", () => {
    function subject(h: ReturnType<typeof event>) {
      return Object.assign(Object.create(cls.prototype), {
        parserRegistry: h.registry,
        payloadEncryption: {
          decrypt: () => Buffer.from(JSON.stringify(payload)),
        },
      });
    }
    it("reproduces original occurrence and click without an ad", () => {
      const h = event();
      const p = subject(h).reparseEvent(h.item);
      expect(p.dedupeKey).toBe(h.item.event.dedupeKey);
      expect(p.adId).toBeNull();
      expect(p.ctwaClid).toBeTruthy();
      expect(p.occurredAt).toEqual(h.item.event.occurredAt);
    });
    it("uses immutable original identity despite changed display connectedPhone", () => {
      const h = event();
      h.item.event.channel.connectedPhone = "559999999999";
      expect(subject(h).reparseEvent(h.item).dedupeKey).toBe(
        h.item.event.dedupeKey,
      );
    });
    it.each([
      "workspaceId",
      "connectionId",
      "organizationId",
      "providerChannelId",
      "id",
    ] as const)("rejects changed %s", (field) => {
      const h = event();
      h.item.event.channel[field] = "foreign";
      expect(() => subject(h).reparseEvent(h.item)).toThrow();
    });
    it("reproduces retained legacy identity without converting it into a new receipt", () => {
      const h = event();
      h.item.event.dedupeKey = buildInboundWebhookEventDedupeKey({
        provider: "unnichat",
        organizationId: "w",
        providerChannelId: "551100001020",
        externalMessageId: h.item.event.externalMessageId!,
      });
      delete h.item.event.normalizedSummary.ctwaEntryIdentityHash;
      expect(subject(h).reparseEvent(h.item).dedupeKey).toBe(
        h.item.event.dedupeKey,
      );
    });
    it("rejects missing original summary proof", () => {
      const h = event();
      h.item.event.normalizedSummary = {} as any;
      expect(() => subject(h).reparseEvent(h.item)).toThrow();
    });
  });
describe("real Unnichat click identity", () => {
  it("preserves separate genuine clicks while identical payload retries dedupe", () => {
    const h = event();
    const parser = h.registry.resolve({
      provider: "unnichat",
      parserVersion: "v1",
      parserReleaseStatus: "certified",
    });
    const context = { organizationId: "w", connectedPhone: "551100001020" };
    const a = parser.parse(payload, context).events[0]!;
    const b = parser.parse(
      { ...payload, ctwa_clid: "another_synthetic_real_click" },
      context,
    ).events[0]!;
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
    expect(parser.parse(payload, context).events[0]!.dedupeKey).toBe(
      a.dedupeKey,
    );
  });
});
