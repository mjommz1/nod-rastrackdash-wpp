import { Inject, Optional } from "@nestjs/common";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { request } from "node:https";

export type KommoAccount = { id: string; subdomain: string | null };
export type KommoContact = { id: string; accountId: string; phones: string[] };
export type KommoLead = { id: string; accountId: string; contactIds: string[] };
export type KommoPipeline = {
  id: string;
  name: string;
  sort: number | null;
  statuses: Array<{ id: string; name: string; type: string | null }>;
};
export class KommoAdapterError extends Error {
  constructor(
    readonly code:
      | "kommo_unauthorized"
      | "kommo_rate_limited"
      | "kommo_transport"
      | "kommo_invalid_response",
  ) {
    super(code);
  }
}

const MAX_RESPONSE_BYTES = 1_000_000;
const TOTAL_DEADLINE_MS = 3_000;
const DNS_DEADLINE_MS = 1_000;
export const KOMMO_TRANSPORT = Symbol("KOMMO_TRANSPORT");
export type KommoTransport = {
  lookup: typeof lookup;
  request: typeof request;
  now: () => number;
};
const defaultTransport: KommoTransport = { lookup, request, now: Date.now };

export class KommoAdapter {
  constructor(
    @Optional()
    @Inject(KOMMO_TRANSPORT)
    private readonly transport: KommoTransport = defaultTransport,
  ) {}
  async verify(origin: string, token: string): Promise<KommoAccount> {
    const data = await this.get(origin, "/api/v4/account", token);
    return { id: required(data?.id), subdomain: text(data?.subdomain) };
  }

  async listPipelines(origin: string, token: string): Promise<KommoPipeline[]> {
    const pipelines: KommoPipeline[] = [];
    const deadline = this.transport.now() + TOTAL_DEADLINE_MS;
    for (let page = 1; page <= 10; page += 1) {
      const data = await this.get(
        origin,
        `/api/v4/leads/pipelines?limit=250&page=${page}`,
        token,
        deadline,
      );
      const source = array(data?._embedded?.pipelines);
      if (!source || source.length > 250)
        throw new KommoAdapterError("kommo_invalid_response");
      pipelines.push(
        ...source.map((pipeline) => ({
          id: required(pipeline.id),
          name: required(pipeline.name),
          sort: number(pipeline.sort),
          statuses: (array(pipeline._embedded?.statuses) ?? []).map(
            (status) => ({
              id: required(status.id),
              name: required(status.name),
              type: text(status.type),
            }),
          ),
        })),
      );
      if (!data?._links?.next) return pipelines;
    }
    throw new KommoAdapterError("kommo_transport");
  }

  async getLead(origin: string, token: string, id: string): Promise<KommoLead> {
    const data = await this.get(
      origin,
      `/api/v4/leads/${encodeURIComponent(id)}?with=contacts`,
      token,
    );
    const contacts = array(data?._embedded?.contacts);
    if (!contacts) throw new KommoAdapterError("kommo_invalid_response");
    return {
      id: required(data?.id),
      accountId: required(data?.account_id),
      contactIds: contacts.map((contact) => required(contact.id)),
    };
  }

  async getContact(
    origin: string,
    token: string,
    id: string,
  ): Promise<KommoContact> {
    const data = await this.get(
      origin,
      `/api/v4/contacts/${encodeURIComponent(id)}`,
      token,
    );
    const phones: string[] = [];
    for (const field of array(data?.custom_fields_values) ?? []) {
      if (String(field.field_code ?? "").toUpperCase() !== "PHONE") continue;
      for (const item of array(field.values) ?? []) {
        const value = text(item.value);
        if (value) phones.push(value);
      }
    }
    return {
      id: required(data?.id),
      accountId: required(data?.account_id),
      phones: [...new Set(phones)],
    };
  }

  private async get(
    origin: string,
    path: string,
    token: string,
    deadline = this.transport.now() + TOTAL_DEADLINE_MS,
  ): Promise<any> {
    const base = validateOrigin(origin);
    const address = await lookupWithDeadline(
      base.hostname,
      this.transport,
      deadline,
    );
    const url = new URL(path, base);
    if (url.origin !== base.origin || url.protocol !== "https:")
      throw new KommoAdapterError("kommo_transport");
    try {
      return await this.requestJson(
        url,
        base.hostname,
        address,
        token,
        deadline,
      );
    } catch (error) {
      throw error instanceof KommoAdapterError
        ? error
        : new KommoAdapterError("kommo_transport");
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
      throw new KommoAdapterError("kommo_transport");
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
            authorization: `Bearer ${token}`,
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
              finish(() => reject(new KommoAdapterError("kommo_transport")));
              req.destroy(new Error("response_too_large"));
            } else chunks.push(chunk);
          });
          response.on("error", () =>
            finish(() => reject(new KommoAdapterError("kommo_transport"))),
          );
          response.on("aborted", () =>
            finish(() => reject(new KommoAdapterError("kommo_transport"))),
          );
          response.on("end", () =>
            finish(() => {
              if (status === 401 || status === 403)
                return reject(new KommoAdapterError("kommo_unauthorized"));
              if (status === 429)
                return reject(new KommoAdapterError("kommo_rate_limited"));
              if (status < 200 || status >= 300)
                return reject(new KommoAdapterError("kommo_transport"));
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
              } catch {
                reject(new KommoAdapterError("kommo_invalid_response"));
              }
            }),
          );
        },
      );
      // This is a wall-clock deadline covering TLS connect and a slow body,
      // unlike request.setTimeout which only observes socket inactivity.
      deadline = setTimeout(
        () => {
          finish(() => reject(new KommoAdapterError("kommo_transport")));
          req.destroy(new Error("deadline"));
        },
        Math.max(1, expiresAt - this.transport.now()),
      );
      req.on("error", () =>
        finish(() => reject(new KommoAdapterError("kommo_transport"))),
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
      !/^[a-z0-9-]+\.kommo\.com$/i.test(url.hostname)
    )
      throw new Error();
    return url;
  } catch {
    throw new KommoAdapterError("kommo_transport");
  }
}

async function lookupWithDeadline(
  hostname: string,
  transport: KommoTransport,
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
    throw new KommoAdapterError("kommo_transport");
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

function object(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}
function array(value: unknown): Array<Record<string, any>> | null {
  return Array.isArray(value) && value.every((item) => object(item))
    ? (value as Array<Record<string, any>>)
    : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim() || null
    : null;
}
function required(value: unknown): string {
  const result = text(value);
  if (!result) throw new KommoAdapterError("kommo_invalid_response");
  return result;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}
