import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KommoAdapter, unsafeAddress } from "../src/kommo/kommo.adapter";
const origin = "https://synthetic.kommo.com/";
const token = "synthetic-bearer-only";
function network(
  body: unknown = { id: "account-a", subdomain: "synthetic" },
  options: {
    status?: number;
    delay?: number;
    bytes?: number;
    slow?: boolean;
  } = {},
) {
  const response = new EventEmitter() as any;
  response.statusCode = options.status ?? 200;
  const req = new EventEmitter() as any;
  req.destroy = vi.fn((error: Error) => {
    queueMicrotask(() => req.emit("error", error));
  });
  let callback: any;
  req.end = vi.fn(() =>
    queueMicrotask(() => {
      callback(response);
      const finish = () => {
        response.emit(
          "data",
          options.bytes
            ? Buffer.alloc(options.bytes, 120)
            : Buffer.from(JSON.stringify(body)),
        );
        if (!options.slow) response.emit("end");
      };
      if (options.delay) setTimeout(finish, options.delay);
      else finish();
    }),
  );
  const request = vi.fn((_url, _options, onResponse) => {
    callback = onResponse;
    return req;
  });
  const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
  return {
    request,
    lookup,
    req,
    response,
    adapter: new KommoAdapter({ lookup, request, now: Date.now } as any),
  };
}
afterEach(() => {
  vi.useRealTimers();
});
describe("Kommo egress address classifier", () => {
  it.each([
    "fc00::1234",
    "fd00:1::abcd",
    "fe80::abcd",
    "febf::1234",
    "ff02::1",
    "::",
    "::1",
    "::127.0.0.2",
    "::10.0.0.2",
    "::ffff:7f00:2",
    "::ffff:a00:2",
    "::ffff:127.0.0.2",
    "0:0:0:0:0:ffff:7f00:2",
    "0:0:0:0:0:0:a00:2",
    "64:ff9b::a00:2",
    "2002:7f00:2::1",
    "2001:db8::1234",
    "2001::1234",
    "3fff::1",
    "fe80::1%eth0",
    "127.0.0.2",
    "10.0.0.2",
    "172.31.2.1",
    "192.168.0.2",
    "169.254.1.2",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "198.18.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "not-an-address",
    "127.1",
    "2130706433",
  ])("rejects %s", (address) => expect(unsafeAddress(address)).toBe(true));
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2606:4700:4700:0:0:0:0:1111",
    "2001:4860:4860::8888",
  ])("accepts global unicast %s", (address) =>
    expect(unsafeAddress(address)).toBe(false),
  );
});
describe("Kommo adapter injectable DNS/HTTPS path", () => {
  it("pins validated DNS and sends bearer only to the official origin", async () => {
    const h = network();
    expect(await h.adapter.verify(origin, token)).toEqual({
      id: "account-a",
      subdomain: "synthetic",
    });
    const [url, options] = h.request.mock.calls[0] as any;
    expect(url.origin).toBe("https://synthetic.kommo.com");
    expect(options.headers.authorization).toBe(`Bearer ${token}`);
    expect(options.servername).toBe("synthetic.kommo.com");
    const pinned = vi.fn();
    options.lookup("synthetic.kommo.com", {}, pinned);
    expect(pinned).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(h.lookup).toHaveBeenCalledOnce();
  });
  it.each([
    "fc00::1234",
    "fe80::abcd",
    "::ffff:7f00:2",
    "::ffff:a00:2",
    "::127.0.0.2",
  ])("prevents bearer egress for DNS containing %s", async (address) => {
    const h = network();
    h.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address, family: 6 },
    ]);
    await expect(h.adapter.verify(origin, token)).rejects.toThrow(
      "kommo_transport",
    );
    expect(h.request).not.toHaveBeenCalled();
  });
  it.each([
    "http://synthetic.kommo.com/",
    "https://synthetic.kommo.com/path",
    "https://user:password@synthetic.kommo.com/",
    "https://synthetic.kommo.com:8443/",
    "https://evil.example/",
    "https://synthetic.kommo.com/?token=secret",
  ])("rejects origin %s before DNS", async (url) => {
    const h = network();
    await expect(h.adapter.verify(url, token)).rejects.toThrow(
      "kommo_transport",
    );
    expect(h.lookup).not.toHaveBeenCalled();
  });
  it("never follows redirects or exposes remote text", async () => {
    const h = network({ message: token }, { status: 302 });
    await expect(h.adapter.verify(origin, token)).rejects.toThrow(
      "kommo_transport",
    );
    expect(h.request).toHaveBeenCalledOnce();
  });
  it.each([
    [401, "kommo_unauthorized"],
    [403, "kommo_unauthorized"],
    [429, "kommo_rate_limited"],
  ])("classifies HTTP %s safely", async (status, code) => {
    const h = network({ message: token }, { status: status as number });
    await expect(h.adapter.verify(origin, token)).rejects.toThrow(
      code as string,
    );
  });
  it("uses one wall deadline across DNS and slow response", async () => {
    vi.useFakeTimers();
    const h = network(undefined, { delay: 2201 });
    h.lookup.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve([{ address: "8.8.8.8", family: 4 }]), 800),
        ),
    );
    const rejected = expect(h.adapter.verify(origin, token)).rejects.toThrow(
      "kommo_transport",
    );
    await vi.advanceTimersByTimeAsync(800);
    expect(h.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2200);
    await rejected;
    expect(h.req.destroy).toHaveBeenCalledOnce();
  });
  it("bounds hanging DNS before bearer egress", async () => {
    vi.useFakeTimers();
    const h = network();
    h.lookup.mockImplementation(() => new Promise(() => {}));
    const rejected = expect(h.adapter.verify(origin, token)).rejects.toThrow(
      "kommo_transport",
    );
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(h.request).not.toHaveBeenCalled();
  });
  it("bounds continuous slow body by wall time", async () => {
    vi.useFakeTimers();
    const h = network({}, { slow: true });
    const rejected = expect(h.adapter.verify(origin, token)).rejects.toThrow(
      "kommo_transport",
    );
    await vi.advanceTimersByTimeAsync(2500);
    h.response.emit("data", Buffer.from(" "));
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
  });
  it("bounds response bytes and pagination without following remote next URLs", async () => {
    const huge = network({}, { bytes: 1_000_001 });
    await expect(huge.adapter.verify(origin, token)).rejects.toThrow(
      "kommo_transport",
    );
    expect(huge.req.destroy).toHaveBeenCalled();
    const pages = network({
      _embedded: { pipelines: [] },
      _links: { next: { href: "https://evil.example/" } },
    });
    await expect(pages.adapter.listPipelines(origin, token)).rejects.toThrow(
      "kommo_transport",
    );
    expect(pages.request).toHaveBeenCalledTimes(10);
    for (const [url] of pages.request.mock.calls as any)
      expect(url.origin).toBe("https://synthetic.kommo.com");
  });
});
