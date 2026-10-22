import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseUnnichatAutomationV1,
  UNNICHAT_AUTOMATION_V1_PARSER_VERSION,
} from "../../src/inbound-webhooks/providers/unnichat/unnichat-automation-v1.parser";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(resolve(__dirname, "fixtures", name), "utf8"),
  );
}

afterEach(() => vi.useRealTimers());

describe("Unnichat automation v1 parser", () => {
  it("parses equivalent direct and n8n envelopes without an event name", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));

    const direct = parseUnnichatAutomationV1(
      fixture("movement-with-ctwa.json"),
    );
    const envelope = parseUnnichatAutomationV1([
      { body: fixture("movement-with-ctwa.json") },
    ]);

    expect(direct).toEqual(envelope);
    expect(direct).toMatchObject({
      ok: true,
      value: {
        phone: "5500000000000",
        hasCtwa: true,
        occurredAt: new Date("2026-10-10T12:00:00.000Z"),
      },
    });
    expect(direct.ok && direct.value.externalExecutionKey).toMatch(
      /^unnichat-automation:[0-9a-f]{64}$/u,
    );
    expect(JSON.stringify(direct)).not.toContain("eventName");
    expect(UNNICHAT_AUTOMATION_V1_PARSER_VERSION).toBe("automation-v1");
  });

  it("keeps an execution key stable and treats missing CTWA as false", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
    const withCtwa = fixture("movement-with-ctwa.json");
    const withoutCtwa = fixture("movement-without-ctwa.json");

    const first = parseUnnichatAutomationV1(withCtwa);
    const second = parseUnnichatAutomationV1(withCtwa);
    const noCtwa = parseUnnichatAutomationV1(withoutCtwa);

    expect(first).toEqual(second);
    expect(noCtwa).toMatchObject({ ok: true, value: { hasCtwa: false } });
  });

  it("rejects invalid provider/channel, envelopes, phone, and oversize values", () => {
    const body = fixture("movement-with-ctwa.json") as Record<string, unknown>;
    const invalidPayloads = [
      { ...body, source: "other" },
      { ...body, channel: "telegram" },
      { ...body, phone: "123" },
      { ...body, origin: "x".repeat(256) },
      [],
      [{ body }, { body }],
    ];

    for (const payload of invalidPayloads) {
      expect(parseUnnichatAutomationV1(payload)).toEqual({
        ok: false,
        errorCode: "unnichat_automation_v1_invalid_payload",
      });
    }
  });
});
