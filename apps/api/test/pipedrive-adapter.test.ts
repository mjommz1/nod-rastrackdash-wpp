import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pipedrivePipelineSchema } from "@wpptrack/shared";
import {
  PipedriveAdapter,
  type PipedriveTransport,
  extractPipedrivePersonPhones,
  unsafeAddress,
} from "../src/pipedrive/pipedrive.adapter";

const origin = "https://example.pipedrive.com/";
const token = "synthetic-api-token-only";
const account = {
  success: true,
  data: { id: 2, company_id: 1, company_domain: "example" },
};
const pipeline = (id = 1) => ({ id, name: "Synthetic pipeline", order_nr: id });
const stage = (id = 3, pipeline_id = 1) => ({
  id,
  pipeline_id,
  name: "Synthetic stage",
  order_nr: id,
});
const page = (data: unknown[], next_cursor: unknown = null) => ({
  success: true,
  data,
  additional_data: { next_cursor },
});
type Reply = {
  body?: unknown;
  raw?: Buffer;
  status?: number;
  delay?: number;
  slow?: boolean;
  event?: "error" | "aborted";
};

function network(replies: Reply[] = [{ body: account }]) {
  const responses: EventEmitter[] = [];
  const requests: Array<
    EventEmitter & {
      destroy: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    }
  > = [];
  const request = vi.fn(
    (
      url: URL,
      options: RequestOptions,
      onResponse: (res: IncomingMessage) => void,
    ) => {
      const reply = replies[Math.min(requests.length, replies.length - 1)]!;
      const response = Object.assign(new EventEmitter(), {
        statusCode: reply.status ?? 200,
      });
      const req = Object.assign(new EventEmitter(), {
        destroy: vi.fn((error: Error) => {
          queueMicrotask(() => req.emit("error", error));
          return req;
        }),
        end: vi.fn(() =>
          queueMicrotask(() => {
            onResponse(response as IncomingMessage);
            const finish = () => {
              if (reply.event) {
                response.emit(reply.event, new Error(token));
                return;
              }
              response.emit(
                "data",
                reply.raw ?? Buffer.from(JSON.stringify(reply.body ?? account)),
              );
              if (!reply.slow) response.emit("end");
            };
            if (reply.delay) setTimeout(finish, reply.delay);
            else finish();
          }),
        ),
      });
      responses.push(response);
      requests.push(req);
      return req as unknown as ClientRequest;
    },
  );
  const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
  const transport = {
    request,
    lookup,
    now: Date.now,
  } as unknown as PipedriveTransport;
  return {
    request,
    lookup,
    requests,
    responses,
    adapter: new PipedriveAdapter(transport),
  };
}
afterEach(() => vi.useRealTimers());

describe("Pipedrive adapter", () => {
  it("verifies the company rather than user id and pins validated DNS with header auth", async () => {
    const h = network();
    expect(await h.adapter.verify(origin, token)).toEqual({
      id: "1",
      subdomain: "example",
    });
    const [url, options] = h.request.mock.calls[0]!;
    expect(url.href).toBe("https://example.pipedrive.com/api/v1/users/me");
    expect(options.headers).toEqual({
      "x-api-token": token,
      accept: "application/json",
    });
    expect(options.method).toBe("GET");
    expect(options.servername).toBe("example.pipedrive.com");
    const pinned = vi.fn();
    (options.lookup as Function)("example.pipedrive.com", {}, pinned);
    expect(pinned).toHaveBeenLastCalledWith(null, "8.8.8.8", 4);
    (options.lookup as Function)(
      "example.pipedrive.com",
      { all: true },
      pinned,
    );
    expect(pinned).toHaveBeenLastCalledWith(null, [
      { address: "8.8.8.8", family: 4 },
    ]);
    expect(h.lookup).toHaveBeenCalledOnce();
  });
  it("lists paginated v2 pipelines and stages in the preserved shared DTO shape", async () => {
    const h = network([
      { body: page([pipeline()], "synthetic-cursor&next=1") },
      { body: page([pipeline(2)]) },
      { body: page([stage()], "https://example.invalid/?cursor=1") },
      { body: page([stage(4, 2)]) },
    ]);
    const result = await h.adapter.listPipelines(origin, token);
    expect(result).toEqual([
      {
        id: "1",
        name: "Synthetic pipeline",
        sort: 1,
        stages: [{ id: "3", name: "Synthetic stage", sort: 3 }],
      },
      {
        id: "2",
        name: "Synthetic pipeline",
        sort: 2,
        stages: [{ id: "4", name: "Synthetic stage", sort: 4 }],
      },
    ]);
    result.forEach((item) =>
      expect(pipedrivePipelineSchema.safeParse(item).success).toBe(true),
    );
    expect(h.request.mock.calls.map(([url]) => url.pathname)).toEqual([
      "/api/v2/pipelines",
      "/api/v2/pipelines",
      "/api/v2/stages",
      "/api/v2/stages",
    ]);
    expect(h.request.mock.calls[1]![0].searchParams.get("cursor")).toBe(
      "synthetic-cursor&next=1",
    );
    for (const [url] of h.request.mock.calls) {
      expect(url.origin).toBe("https://example.pipedrive.com");
      expect(url.searchParams.has("api_token")).toBe(false);
    }
  });
  it("returns empty stages and nullable sort without inventing names", async () => {
    const h = network([
      { body: page([{ id: 1, name: "Synthetic", order_nr: null }]) },
      { body: page([]) },
    ]);
    expect(await h.adapter.listPipelines(origin, token)).toEqual([
      { id: "1", name: "Synthetic", sort: null, stages: [] },
    ]);
  });
  it("gets a v2 person and returns only id and distinct normalized phone candidates", async () => {
    const h = network([
      {
        body: {
          success: true,
          data: {
            id: 5,
            name: "Synthetic person",
            phones: [
              { value: "+55 00000000000", primary: true },
              { value: "5500000000000", primary: false },
            ],
          },
        },
      },
    ]);
    expect(await h.adapter.getPerson(origin, token, "5")).toEqual({
      id: "5",
      phones: ["5500000000000"],
    });
    expect(h.request.mock.calls[0]![0].pathname).toBe("/api/v2/persons/5");
  });
  it.each(["", "../users/me", "5?query=1", "0", "1.5"])(
    "rejects invalid person id %s before egress",
    async (id) => {
      const h = network();
      await expect(h.adapter.getPerson(origin, token, id)).rejects.toThrow(
        "pipedrive_invalid_response",
      );
      expect(h.lookup).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
    },
  );
  it("rejects a person response for a different id", async () => {
    const h = network([
      { body: { success: true, data: { id: 6, phones: [] } } },
    ]);
    await expect(h.adapter.getPerson(origin, token, "5")).rejects.toThrow(
      "pipedrive_invalid_response",
    );
  });
  it.each([
    "http://example.pipedrive.com/",
    "https://example.pipedrive.com/path",
    "https://user:synthetic@example.pipedrive.com/",
    "https://example.pipedrive.com:8443/",
    "https://example.invalid/",
    "https://example.pipedrive.com/?token=synthetic",
    "https://example.pipedrive.com/#fragment",
    "https://nested.example.pipedrive.com/",
    "https://example.pipedrive.com.example.invalid/",
    "https://www.pipedrive.com/",
    "https://api.pipedrive.com/",
    "https://app.pipedrive.com/",
    "https://API.pipedrive.com/",
  ])("rejects origin %s before DNS", async (url) => {
    const h = network();
    await expect(h.adapter.verify(url, token)).rejects.toThrow(
      "pipedrive_transport",
    );
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
  it.each(["", "synthetic\r\ninjected: header"])(
    "rejects malformed tokens before DNS",
    async (credential) => {
      const h = network();
      await expect(h.adapter.verify(origin, credential)).rejects.toThrow(
        "pipedrive_transport",
      );
      expect(h.lookup).not.toHaveBeenCalled();
    },
  );
  it.each([
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
    "fc00::1234",
    "fd00:1::abcd",
    "fe80::abcd",
    "febf::1234",
    "ff02::1",
    "::",
    "::1",
    "::127.0.0.2",
    "::ffff:7f00:2",
    "::ffff:10.0.0.2",
    "0:0:0:0:0:ffff:7f00:2",
    "64:ff9b::a00:2",
    "2002:7f00:2::1",
    "2001:db8::1234",
    "2001::1234",
    "3fff::1",
    "fe80::1%eth0",
    "not-an-address",
    "127.1",
    "2130706433",
  ])("blocks unsafe DNS %s even mixed with public results", async (address) => {
    expect(unsafeAddress(address)).toBe(true);
    const h = network();
    h.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address, family: address.includes(":") ? 6 : 4 },
    ]);
    await expect(h.adapter.verify(origin, token)).rejects.toThrow(
      "pipedrive_transport",
    );
    expect(h.request).not.toHaveBeenCalled();
  });
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])("accepts global unicast %s", (address) =>
    expect(unsafeAddress(address)).toBe(false),
  );
  it("rejects empty DNS and mismatched address families", async () => {
    for (const addresses of [[], [{ address: "8.8.8.8", family: 6 }]]) {
      const h = network();
      h.lookup.mockResolvedValue(addresses);
      await expect(h.adapter.verify(origin, token)).rejects.toThrow(
        "pipedrive_transport",
      );
      expect(h.request).not.toHaveBeenCalled();
    }
  });
  it.each([
    [401, "pipedrive_unauthorized"],
    [403, "pipedrive_unauthorized"],
    [429, "pipedrive_rate_limited"],
    [302, "pipedrive_transport"],
    [500, "pipedrive_transport"],
  ])(
    "classifies HTTP %s without remote text or redirect egress",
    async (status, code) => {
      const h = network([{ body: { error: token }, status: status as number }]);
      await expect(h.adapter.verify(origin, token)).rejects.toThrow(
        code as string,
      );
      expect(h.request).toHaveBeenCalledOnce();
    },
  );
  it.each([
    null,
    [],
    { success: false, error: token },
    { success: true, data: {} },
    { success: true, data: { company_id: 1, company_domain: "api" } },
    { success: true, data: { company_id: 1, company_domain: "different" } },
  ])("fails closed on malformed account response %s", async (body) => {
    const h = network([{ raw: Buffer.from(JSON.stringify(body)) }]);
    await expect(h.adapter.verify(origin, token)).rejects.toThrow(
      "pipedrive_invalid_response",
    );
  });
  it("rejects invalid JSON and oversize or aborted responses", async () => {
    for (const reply of [
      { raw: Buffer.from("{"), code: "pipedrive_invalid_response" },
      { raw: Buffer.alloc(1_000_001), code: "pipedrive_transport" },
      { event: "aborted" as const, code: "pipedrive_transport" },
      { event: "error" as const, code: "pipedrive_transport" },
    ]) {
      const h = network([reply]);
      await expect(h.adapter.verify(origin, token)).rejects.toThrow(reply.code);
    }
  });
  it("bounds hanging DNS with no credential egress", async () => {
    vi.useFakeTimers();
    const h = network();
    h.lookup.mockImplementation(() => new Promise(() => {}));
    const rejected = expect(h.adapter.verify(origin, token)).rejects.toThrow(
      "pipedrive_transport",
    );
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(h.request).not.toHaveBeenCalled();
  });
  it("uses one deadline across DNS and response", async () => {
    vi.useFakeTimers();
    const h = network([{ delay: 2201 }]);
    h.lookup.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve([{ address: "8.8.8.8", family: 4 }]), 800),
        ),
    );
    const rejected = expect(h.adapter.verify(origin, token)).rejects.toThrow(
      "pipedrive_transport",
    );
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    expect(h.requests[0]!.destroy).toHaveBeenCalledOnce();
  });
  it("bounds a continuously slow body", async () => {
    vi.useFakeTimers();
    const h = network([{ slow: true }]);
    const rejected = expect(h.adapter.verify(origin, token)).rejects.toThrow(
      "pipedrive_transport",
    );
    await vi.advanceTimersByTimeAsync(2500);
    h.responses[0]!.emit("data", Buffer.from(" "));
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(h.requests[0]!.destroy).toHaveBeenCalledOnce();
  });
  it("shares the wall deadline across pipeline and stage pagination", async () => {
    vi.useFakeTimers();
    const h = network([
      { body: page([pipeline()]), delay: 2000 },
      { body: page([stage()]), delay: 1001 },
    ]);
    const rejected = expect(
      h.adapter.listPipelines(origin, token),
    ).rejects.toThrow("pipedrive_transport");
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    expect(h.request).toHaveBeenCalledTimes(2);
  });
  it("caps pagination and detects cursor loops", async () => {
    const endless = network(
      Array.from({ length: 10 }, (_, i) => ({
        body: page([], `synthetic-${i}`),
      })),
    );
    await expect(endless.adapter.listPipelines(origin, token)).rejects.toThrow(
      "pipedrive_transport",
    );
    expect(endless.request).toHaveBeenCalledTimes(10);
    const loop = network([{ body: page([], "synthetic-loop") }]);
    await expect(loop.adapter.listPipelines(origin, token)).rejects.toThrow(
      "pipedrive_invalid_response",
    );
    expect(loop.request).toHaveBeenCalledTimes(2);
  });
  it("rejects malformed catalogs and orphan stages rather than offering a partial catalog", async () => {
    for (const body of [
      page([null]),
      page(Array(501).fill(pipeline())),
      page([{ id: 1 }]),
      page([pipeline(), pipeline()]),
      page([], {}),
      { success: true, data: [], additional_data: [] },
    ]) {
      const h = network([{ body }]);
      await expect(h.adapter.listPipelines(origin, token)).rejects.toThrow(
        "pipedrive_invalid_response",
      );
    }
    for (const data of [
      [stage(3, 9)],
      [stage(), stage()],
      [{ ...stage(), order_nr: "bad" }],
    ]) {
      const h = network([{ body: page([pipeline()]) }, { body: page(data) }]);
      await expect(h.adapter.listPipelines(origin, token)).rejects.toThrow(
        "pipedrive_invalid_response",
      );
    }
  });
});

describe("Pipedrive phone extraction", () => {
  it("returns zero, one or many distinct candidates without a primary tie-break", () => {
    expect(extractPipedrivePersonPhones({})).toEqual([]);
    expect(extractPipedrivePersonPhones({ phones: [] })).toEqual([]);
    expect(
      extractPipedrivePersonPhones({
        phones: [{ value: "" }, { value: "bad" }],
      }),
    ).toEqual([]);
    expect(
      extractPipedrivePersonPhones({ phone: [{ value: "5500000000000" }] }),
    ).toEqual(["5500000000000"]);
    expect(
      extractPipedrivePersonPhones({
        phones: [{ value: "+55 00000000000" }, { value: "5500000000000" }],
      }),
    ).toEqual(["5500000000000"]);
    expect(
      extractPipedrivePersonPhones({
        phones: [
          { value: "5500000000000", primary: true },
          { value: "5500000000001", primary: false },
        ],
      }),
    ).toEqual(["5500000000000", "5500000000001"]);
    expect(
      extractPipedrivePersonPhones({
        phones: [{ value: "5500000000000" }],
        phone: [{ value: "5500000000001" }],
      }),
    ).toEqual(["5500000000000", "5500000000001"]);
  });
  it.each([
    { phones: "5500000000000" },
    { phones: [null] },
    { phones: [{ value: {} }] },
    { phones: Array(101).fill({ value: "5500000000000" }) },
  ])("rejects malformed or unbounded phone lists", (person) => {
    expect(() => extractPipedrivePersonPhones(person)).toThrow(
      "pipedrive_invalid_response",
    );
  });
});
