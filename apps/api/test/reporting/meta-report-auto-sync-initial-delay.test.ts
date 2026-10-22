import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  META_AUTO_SYNC_MAX_INITIAL_DELAY_MS,
  META_AUTO_SYNC_MIN_INITIAL_DELAY_MS,
  MetaReportAutoSyncService,
  resolveMetaAutoSyncInitialDelayMs,
} from "../../src/reporting/meta-report-auto-sync.service";

const ENV_KEYS = [
  "WPPTRACK_META_AUTO_SYNC_ENABLED",
  "WPPTRACK_META_AUTO_SYNC_INITIAL_DELAY_SECONDS",
  "WPPTRACK_META_AUTO_SYNC_INTERVAL_MINUTES",
] as const;

describe("resolveMetaAutoSyncInitialDelayMs", () => {
  it("defaults to a random delay between 10 and 30 minutes", () => {
    expect(resolveMetaAutoSyncInitialDelayMs(undefined, () => 0)).toBe(
      10 * 60_000,
    );
    expect(resolveMetaAutoSyncInitialDelayMs("", () => 1)).toBe(30 * 60_000);
    expect(resolveMetaAutoSyncInitialDelayMs(undefined, () => 0.5)).toBe(
      20 * 60_000,
    );

    for (let index = 0; index < 200; index += 1) {
      const delay = resolveMetaAutoSyncInitialDelayMs(undefined);
      expect(delay).toBeGreaterThanOrEqual(META_AUTO_SYNC_MIN_INITIAL_DELAY_MS);
      expect(delay).toBeLessThanOrEqual(META_AUTO_SYNC_MAX_INITIAL_DELAY_MS);
    }
  });

  it("ignores the old 60 second value and other values below 10 minutes", () => {
    for (const value of ["60", "0", "-5", "599", "abc"]) {
      expect(resolveMetaAutoSyncInitialDelayMs(value, () => 0)).toBe(
        META_AUTO_SYNC_MIN_INITIAL_DELAY_MS,
      );
    }
  });

  it("honours an explicit delay of at least 10 minutes", () => {
    expect(resolveMetaAutoSyncInitialDelayMs("600", () => 0.9)).toBe(600_000);
    expect(resolveMetaAutoSyncInitialDelayMs("3600", () => 0.9)).toBe(
      3_600_000,
    );
  });
});

describe("MetaReportAutoSyncService boot scheduling", () => {
  const saved: Record<string, string | undefined> = {};
  let service: MetaReportAutoSyncService | null = null;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    service?.onModuleDestroy();
    service = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it("does not sync in the first 10 minutes after boot, even with the old .env.example value", async () => {
    process.env.WPPTRACK_META_AUTO_SYNC_ENABLED = "true";
    process.env.WPPTRACK_META_AUTO_SYNC_INITIAL_DELAY_SECONDS = "60";
    process.env.WPPTRACK_META_AUTO_SYNC_INTERVAL_MINUTES = "180";
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    const findMany = vi.fn(async () => [{ id: "w1" }]);
    const enqueueWorkspaceSync = vi.fn(async () => undefined);
    service = new MetaReportAutoSyncService(
      { workspace: { findMany } } as never,
      { enqueueWorkspaceSync } as never,
    );

    service.onApplicationBootstrap();

    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(findMany).not.toHaveBeenCalled();

    // random 0.25 -> 10 min + 0.25 * 20 min = 15 min.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(enqueueWorkspaceSync).toHaveBeenCalledTimes(1);

    // The 180-minute interval is unchanged.
    await vi.advanceTimersByTimeAsync(180 * 60_000 - 15 * 60_000);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
