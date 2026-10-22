import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetaPalmupPairingStore } from "../../src/integrations/meta/meta-palmup-pairing.store";

const { redis, RedisMock } = vi.hoisted(() => {
  const redis = {
    set: vi.fn(),
    getdel: vi.fn(),
    on: vi.fn(),
    disconnect: vi.fn(),
  };
  return { redis, RedisMock: vi.fn(() => redis) };
});

vi.mock("ioredis", () => ({ default: RedisMock }));

beforeEach(() => {
  vi.clearAllMocks();
  redis.set.mockResolvedValue("OK");
  redis.getdel.mockResolvedValue(null);
});

describe("PalmUP server-side pairing store", () => {
  it("does not connect to Redis until a pairing is needed", () => {
    const store = new MetaPalmupPairingStore({});
    store.onModuleDestroy();
    expect(RedisMock).not.toHaveBeenCalled();
    expect(redis.disconnect).not.toHaveBeenCalled();
  });

  it("stores the challenge by workspace and pairing with a ten minute expiry", async () => {
    const store = new MetaPalmupPairingStore({
      REDIS_URL: "redis://redis.example.test:6379",
    });
    await store.save("workspace-1", "pairing-1", "challenge-1");
    expect(redis.set).toHaveBeenCalledWith(
      "meta:palmup-connect:workspace-1:pairing-1",
      "challenge-1",
      "EX",
      600,
      "NX",
    );
    expect(RedisMock).toHaveBeenCalledWith(
      "redis://redis.example.test:6379",
      expect.objectContaining({ lazyConnect: true, maxRetriesPerRequest: 0 }),
    );
    expect(redis.on).toHaveBeenCalledWith("error", expect.any(Function));
    store.onModuleDestroy();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it("uses atomic GETDEL to consume a challenge", async () => {
    const store = new MetaPalmupPairingStore({});
    redis.getdel.mockResolvedValueOnce("challenge-1");
    expect(await store.consume("workspace-1", "pairing-1")).toBe("challenge-1");
    expect(redis.getdel).toHaveBeenCalledWith(
      "meta:palmup-connect:workspace-1:pairing-1",
    );
    expect(await store.consume("workspace-1", "pairing-1")).toBeNull();
    expect(RedisMock).toHaveBeenCalledTimes(1);
  });

  it("separates workspace IDs containing delimiters", async () => {
    const store = new MetaPalmupPairingStore({});
    await store.save("workspace:1", "pairing-1", "challenge-1");
    await store.consume("workspace:1", "pairing-1");
    expect(redis.set).toHaveBeenCalledWith(
      "meta:palmup-connect:workspace%3A1:pairing-1",
      "challenge-1",
      "EX",
      600,
      "NX",
    );
    expect(redis.getdel).toHaveBeenCalledWith(
      "meta:palmup-connect:workspace%3A1:pairing-1",
    );
  });

  it.each(["save", "consume"] as const)(
    "sanitizes Redis failures during %s",
    async (operation) => {
      const store = new MetaPalmupPairingStore({});
      const error = new Error("private redis connection details");
      redis.set.mockRejectedValueOnce(error);
      redis.getdel.mockRejectedValueOnce(error);
      await expect(
        operation === "save"
          ? store.save("workspace-1", "pairing-1", "challenge-1")
          : store.consume("workspace-1", "pairing-1"),
      ).rejects.toMatchObject({
        status: 503,
        message: "Login social PalmUP temporariamente indisponivel",
      });
    },
  );

  it("fails closed if Redis does not save the pairing", async () => {
    redis.set.mockResolvedValueOnce(null);
    const store = new MetaPalmupPairingStore({});
    await expect(
      store.save("workspace-1", "pairing-1", "challenge-1"),
    ).rejects.toMatchObject({ status: 503 });
  });
});
