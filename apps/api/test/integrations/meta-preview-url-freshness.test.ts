import { describe, expect, it } from "vitest";
import {
  META_PREVIEW_REFRESH_MARGIN_MS,
  evaluateMetaPreviewUrlFreshness,
} from "../../src/integrations/meta/meta-preview-url-freshness";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function oeHex(date: Date): string {
  return Math.floor(date.getTime() / 1000)
    .toString(16)
    .padStart(8, "0");
}

function cdnUrl(expiresAt: Date, host = "scontent.xx.fbcdn.net"): string {
  return `https://${host}/v/t45.1600-4/123_n.jpg?stp=dst-jpg&_nc_cat=1&oh=00_AbCd&oe=${oeHex(expiresAt)}`;
}

function inHours(hours: number): Date {
  return new Date(NOW.getTime() + hours * HOUR_MS);
}

describe("evaluateMetaPreviewUrlFreshness", () => {
  it("uses a 24h refresh margin by default", () => {
    expect(META_PREVIEW_REFRESH_MARGIN_MS).toBe(24 * HOUR_MS);
  });

  it("reuses an HTTPS fbcdn URL whose oe expiry is beyond the refresh margin", () => {
    const expiresAt = inHours(72);
    const result = evaluateMetaPreviewUrlFreshness(cdnUrl(expiresAt), NOW);

    expect(result).toEqual({
      reusable: true,
      expiresAt: new Date(Math.floor(expiresAt.getTime() / 1000) * 1000),
    });
  });

  it("accepts any fbcdn.net subdomain", () => {
    expect(
      evaluateMetaPreviewUrlFreshness(
        cdnUrl(inHours(48), "video.fgru1-1.fna.fbcdn.net"),
        NOW,
      ).reusable,
    ).toBe(true);
  });

  it("refreshes URLs that expire inside the margin", () => {
    expect(evaluateMetaPreviewUrlFreshness(cdnUrl(inHours(23)), NOW)).toEqual({
      reusable: false,
      reason: "expiring",
    });
    expect(evaluateMetaPreviewUrlFreshness(cdnUrl(inHours(24)), NOW)).toEqual({
      reusable: false,
      reason: "expiring",
    });
    expect(
      evaluateMetaPreviewUrlFreshness(cdnUrl(inHours(25)), NOW).reusable,
    ).toBe(true);
  });

  it("refreshes already expired URLs", () => {
    expect(evaluateMetaPreviewUrlFreshness(cdnUrl(inHours(-1)), NOW)).toEqual({
      reusable: false,
      reason: "expiring",
    });
  });

  it("honours an explicit refresh margin", () => {
    expect(
      evaluateMetaPreviewUrlFreshness(cdnUrl(inHours(5)), NOW, {
        refreshMarginMs: 2 * HOUR_MS,
      }).reusable,
    ).toBe(true);
    expect(
      evaluateMetaPreviewUrlFreshness(cdnUrl(inHours(1)), NOW, {
        refreshMarginMs: 2 * HOUR_MS,
      }).reusable,
    ).toBe(false);
  });

  it("refreshes non-HTTPS URLs", () => {
    expect(
      evaluateMetaPreviewUrlFreshness(
        cdnUrl(inHours(72)).replace("https://", "http://"),
        NOW,
      ),
    ).toEqual({ reusable: false, reason: "not_https" });
  });

  it.each([
    "example.com",
    "fbcdn.net.attacker.example",
    "evilfbcdn.net",
    "scontent.xx.fbcdn.net.evil",
  ])("refreshes URLs from untrusted host %s", (host) => {
    expect(
      evaluateMetaPreviewUrlFreshness(cdnUrl(inHours(72), host), NOW),
    ).toEqual({ reusable: false, reason: "untrusted_host" });
  });

  it("refreshes URLs carrying credentials or a non-default port", () => {
    const expiry = oeHex(inHours(72));

    expect(
      evaluateMetaPreviewUrlFreshness(
        `https://user:pass@scontent.xx.fbcdn.net/a.jpg?oe=${expiry}`,
        NOW,
      ),
    ).toEqual({ reusable: false, reason: "untrusted_host" });
    expect(
      evaluateMetaPreviewUrlFreshness(
        `https://scontent.xx.fbcdn.net:8443/a.jpg?oe=${expiry}`,
        NOW,
      ),
    ).toEqual({ reusable: false, reason: "untrusted_host" });
  });

  it("refreshes trusted URLs without an oe expiry hint", () => {
    expect(
      evaluateMetaPreviewUrlFreshness(
        "https://scontent.xx.fbcdn.net/v/a.jpg?oh=00_x",
        NOW,
      ),
    ).toEqual({ reusable: false, reason: "missing_expiry" });
  });

  it.each([
    ["empty", ""],
    ["non-hex", "zzzzzzzz"],
    ["too short", "6a1b2c3"],
    ["too long", "06a1b2c3d4"],
    ["prefixed", "0x6a1b2c3d"],
    ["signed", "-6a1b2c3"],
    ["whitespace", " 6a1b2c3"],
  ])("refreshes malformed oe values (%s)", (_label, oe) => {
    expect(
      evaluateMetaPreviewUrlFreshness(
        `https://scontent.xx.fbcdn.net/v/a.jpg?oe=${encodeURIComponent(oe)}`,
        NOW,
      ),
    ).toEqual({ reusable: false, reason: "malformed_expiry" });
  });

  it("refreshes URLs with duplicated oe parameters", () => {
    const expiry = oeHex(inHours(72));

    expect(
      evaluateMetaPreviewUrlFreshness(
        `https://scontent.xx.fbcdn.net/v/a.jpg?oe=${expiry}&oe=${expiry}`,
        NOW,
      ),
    ).toEqual({ reusable: false, reason: "malformed_expiry" });
  });

  it("refreshes implausibly distant expiry hints", () => {
    expect(
      evaluateMetaPreviewUrlFreshness(cdnUrl(inHours(24 * 400)), NOW),
    ).toEqual({ reusable: false, reason: "implausible_expiry" });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["number", 42],
    ["relative path", "/v/a.jpg?oe=6a1b2c3d"],
    ["garbage", "not a url"],
  ])("refreshes invalid values without throwing (%s)", (_label, value) => {
    expect(evaluateMetaPreviewUrlFreshness(value, NOW)).toEqual({
      reusable: false,
      reason: "invalid_url",
    });
  });

  it("refreshes when the clock itself is invalid", () => {
    expect(
      evaluateMetaPreviewUrlFreshness(
        cdnUrl(inHours(72)),
        new Date(Number.NaN),
      ),
    ).toEqual({ reusable: false, reason: "invalid_clock" });
  });
});
