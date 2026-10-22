import { Inject, Optional } from "@nestjs/common";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { normalizePhoneIdentity } from "../common/phone/phone-identity";

export type PipedriveAccount = { id: string; subdomain: string };
export type PipedrivePerson = { id: string; phones: string[] };
export type PipedriveStage = { id: string; name: string; sort: number | null };
export type PipedrivePipeline = {
  id: string;
  name: string;
  sort: number | null;
  stages: PipedriveStage[];
};
export class PipedriveAdapterError extends Error {
  constructor(
    readonly code:
      | "pipedrive_unauthorized"
      | "pipedrive_rate_limited"
      | "pipedrive_transport"
      | "pipedrive_invalid_response",
  ) {
    super(code);
  }
}

const MAX_RESPONSE_BYTES = 1_000_000;
const TOTAL_DEADLINE_MS = 3_000;
const DNS_DEADLINE_MS = 1_000;
const MAX_PAGES = 10;
const PAGE_SIZE = 500;
export const PIPEDRIVE_TRANSPORT = Symbol("PIPEDRIVE_TRANSPORT");
export type PipedriveTransport = {
  lookup: typeof lookup;
  request: typeof request;
  now: () => number;
};
const defaultTransport: PipedriveTransport = { lookup, request, now: Date.now };

export class PipedriveAdapter {
  constructor(
    @Optional()
    @Inject(PIPEDRIVE_TRANSPORT)
    private readonly transport: PipedriveTransport = defaultTransport,
  ) {}

  async verify(origin: string, token: string): Promise<PipedriveAccount> {
    // Pipedrive exposes company identity through the v1 current-user endpoint.
    const data = record(
      envelope(await this.get(origin, "/api/v1/users/me", token)).data,
    );
    if (!data) invalid();
    const companyId = requiredId(data.company_id);
    const subdomain = requiredName(data.company_domain).toLowerCase();
    if (
      !/^[a-z0-9-]+$/.test(subdomain) ||
      ["www", "api", "app"].includes(subdomain) ||
      validateOrigin(origin).hostname !== `${subdomain}.pipedrive.com`
    )
      invalid();
    return { id: companyId, subdomain };
  }

  async listPipelines(
    origin: string,
    token: string,
  ): Promise<PipedrivePipeline[]> {
    const deadline = this.transport.now() + TOTAL_DEADLINE_MS;
    const pipelines = await this.list(
      origin,
      "/api/v2/pipelines",
      token,
      deadline,
    );
    const stages = await this.list(origin, "/api/v2/stages", token, deadline);
    const catalog = new Map<string, PipedrivePipeline>();
    for (const item of pipelines) {
      const id = requiredId(item.id);
      if (catalog.has(id)) invalid();
      catalog.set(id, {
        id,
        name: requiredName(item.name),
        sort: sort(item.order_nr),
        stages: [],
      });
    }
    const stageIds = new Set<string>();
    for (const item of stages) {
      const id = requiredId(item.id);
      const pipeline = catalog.get(requiredId(item.pipeline_id));
      if (!pipeline || stageIds.has(id)) invalid();
      stageIds.add(id);
      pipeline.stages.push({
        id,
        name: requiredName(item.name),
        sort: sort(item.order_nr),
      });
    }
    return [...catalog.values()];
  }

  async getPerson(
    origin: string,
    token: string,
    id: string,
  ): Promise<PipedrivePerson> {
    const personId = requiredId(id);
    const data = record(
      envelope(
        await this.get(
          origin,
          `/api/v2/persons/${encodeURIComponent(personId)}`,
          token,
        ),
      ).data,
    );
    if (!data || requiredId(data.id) !== personId) invalid();
    return { id: personId, phones: extractPipedrivePersonPhones(data) };
  }

  private async list(
    origin: string,
    path: string,
    token: string,
    deadline: number,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor !== null) query.set("cursor", cursor);
      const response = envelope(
        await this.get(origin, `${path}?${query}`, token, deadline),
      );
      if (!Array.isArray(response.data) || response.data.length > PAGE_SIZE)
        invalid();
      for (const item of response.data) {
        const value = record(item);
        if (!value) invalid();
        items.push(value);
      }
      const additional =
        response.additional_data == null
          ? null
          : record(response.additional_data);
      if (response.additional_data != null && !additional) invalid();
      const next = additional?.next_cursor;
      if (next == null || next === "") return items;
      if (typeof next !== "string" || next.length > 2_048 || cursors.has(next))
        invalid();
      // Treat cursors as opaque query values, never as URLs to follow.
      cursors.add(next);
      cursor = next;
    }
    throw new PipedriveAdapterError("pipedrive_transport");
  }

  private async get(
    origin: string,
    path: string,
    token: string,
    deadline = this.transport.now() + TOTAL_DEADLINE_MS,
  ): Promise<any> {
    const base = validateOrigin(origin);
    if (!token || token.length > 4096 || /[^\x21-\x7e]/.test(token))
      throw new PipedriveAdapterError("pipedrive_transport");
    const address = await lookupWithDeadline(
      base.hostname,
      this.transport,
      deadline,
    );
    const url = new URL(path, base);
    if (url.origin !== base.origin || url.protocol !== "https:")
      throw new PipedriveAdapterError("pipedrive_transport");
    try {
      return await this.requestJson(
        url,
        base.hostname,
        address,
        token,
        deadline,
      );
    } catch (error) {
      throw error instanceof PipedriveAdapterError
        ? error
        : new PipedriveAdapterError("pipedrive_transport");
    }
  }

  private requestJson(
    url: URL,
    hostname: string,
    address: { address: string; family: number },
    token: string,
    expiresAt: number,
  ): Promise<any> {
    if (expiresAt <= this.transport.now())
      throw new PipedriveAdapterError("pipedrive_transport");
    return new Promise((resolve, reject) => {
      let settled = false;
      let deadline: NodeJS.Timeout | undefined;
      const finish = (callback: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(deadline);
          callback();
        }
      };
      const req = this.transport.request(
        url,
        {
          method: "GET",
          headers: {
            "x-api-token": token,
            accept: "application/json",
          },
          servername: hostname,
          // Pin the DNS result used for validation; HTTPS does not follow redirects.
          lookup: (_hostname, options, callback) => {
            // Node's automatic family selection requires the all:true shape.
            // Both forms use only the already validated, pinned address.
            if (typeof options === "object" && options.all)
              (callback as Function)(null, [address]);
            else callback(null, address.address, address.family);
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              finish(() =>
                reject(new PipedriveAdapterError("pipedrive_transport")),
              );
              req.destroy(new Error("response_too_large"));
            } else chunks.push(chunk);
          });
          response.on("error", () =>
            finish(() =>
              reject(new PipedriveAdapterError("pipedrive_transport")),
            ),
          );
          response.on("aborted", () =>
            finish(() =>
              reject(new PipedriveAdapterError("pipedrive_transport")),
            ),
          );
          response.on("end", () =>
            finish(() => {
              if (status === 401 || status === 403)
                return reject(
                  new PipedriveAdapterError("pipedrive_unauthorized"),
                );
              if (status === 429)
                return reject(
                  new PipedriveAdapterError("pipedrive_rate_limited"),
                );
              if (status < 200 || status >= 300)
                return reject(new PipedriveAdapterError("pipedrive_transport"));
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
              } catch {
                reject(new PipedriveAdapterError("pipedrive_invalid_response"));
              }
            }),
          );
        },
      );
      // This is a wall-clock deadline covering TLS connect and a slow body,
      // unlike request.setTimeout which only observes socket inactivity.
      deadline = setTimeout(
        () => {
          finish(() =>
            reject(new PipedriveAdapterError("pipedrive_transport")),
          );
          req.destroy(new Error("deadline"));
        },
        Math.max(1, expiresAt - this.transport.now()),
      );
      req.on("error", () =>
        finish(() => reject(new PipedriveAdapterError("pipedrive_transport"))),
      );
      req.end();
    });
  }
}

function validateOrigin(value: string): URL {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      ["www", "api", "app"].includes(url.hostname.split(".")[0]!) ||
      !/^[a-z0-9-]+\.pipedrive\.com$/i.test(url.hostname)
    )
      throw new Error();
    return url;
  } catch {
    throw new PipedriveAdapterError("pipedrive_transport");
  }
}

async function lookupWithDeadline(
  hostname: string,
  transport: PipedriveTransport,
  deadline: number,
): Promise<{ address: string; family: number }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const remaining = deadline - transport.now();
    if (remaining <= 0) throw new Error("deadline");
    const addresses = await Promise.race([
      transport.lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("dns_deadline")),
          Math.min(DNS_DEADLINE_MS, remaining),
        );
      }),
    ]);
    if (
      !addresses.length ||
      addresses.some(
        (item) =>
          unsafeAddress(item.address) || isIP(item.address) !== item.family,
      )
    )
      throw new Error("unsafe address");
    return addresses[0]!;
  } catch {
    throw new PipedriveAdapterError("pipedrive_transport");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fail closed: accept ordinary global unicast only, including every IPv6 encoding. */
export function unsafeAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 ||
          b === 0 ||
          (b === 88 && c === 99) ||
          (b === 2 && c === 0))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6 || address.includes("%")) return true;
  let input = address.toLowerCase();
  if (input.includes(".")) {
    const offset = input.lastIndexOf(":");
    const bytes = input
      .slice(offset + 1)
      .split(".")
      .map(Number);
    input =
      input.slice(0, offset + 1) +
      ((bytes[0]! << 8) | bytes[1]!).toString(16) +
      ":" +
      ((bytes[2]! << 8) | bytes[3]!).toString(16);
  }
  const halves = input.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = (
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left
  ).map((word) => Number.parseInt(word, 16));
  if (words.length !== 8) return true;
  // This also rejects IPv4 mapped/compatible, ULA, link-local, multicast,
  // translation and unspecified ranges, without a compressed-tail shortcut.
  const first = words[0]!;
  if ((first & 0xe000) !== 0x2000) return true;
  // IETF special allocations, documentation, and 6to4 tunnels fail closed.
  return (
    (first === 0x2001 && (words[1]! < 0x0200 || words[1] === 0x0db8)) ||
    first === 0x2002 ||
    (first === 0x3fff && words[1]! < 0x1000)
  );
}

function invalid(): never {
  throw new PipedriveAdapterError("pipedrive_invalid_response");
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value))
    ? (value as Record<string, unknown>)
    : null;
}
function envelope(value: unknown): Record<string, unknown> {
  const result = record(value);
  if (!result || result.success !== true || !Object.hasOwn(result, "data"))
    invalid();
  return result;
}
function requiredId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  if (
    typeof value === "string" &&
    /^[1-9]\d{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value))
  )
    return value;
  return invalid();
}
function requiredName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 255)
    invalid();
  return value.trim();
}
function sort(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid();
  return value;
}

/** Preserve every distinct candidate; the service decides missing/ambiguous identity. */
export function extractPipedrivePersonPhones(person: unknown): string[] {
  const data = record(person);
  if (!data) invalid();
  const phones = new Set<string>();
  let count = 0;
  // v2 uses phones; accept the legacy phone array without dropping candidates.
  for (const source of [data.phones, data.phone]) {
    if (source == null) continue;
    if (!Array.isArray(source) || source.length > 100) invalid();
    for (const entry of source) {
      count += 1;
      if (count > 100) invalid();
      const item = record(entry);
      if (!item || (item.value != null && typeof item.value !== "string"))
        invalid();
      if (typeof item.value !== "string") continue;
      if (item.value.length > 255) invalid();
      const normalized = normalizePhoneIdentity(item.value);
      if (normalized) phones.add(normalized);
    }
  }
  return [...phones];
}
