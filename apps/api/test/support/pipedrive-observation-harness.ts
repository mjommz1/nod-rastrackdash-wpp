import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import {
  pipedriveHarness,
  createInput,
  actor,
  allowedLicense,
} from "./pipedrive-harness";
import { PipedriveWebhookService } from "../../src/pipedrive/pipedrive-webhook.service";
import { hashPhoneIdentity } from "../../src/common/phone/phone-identity";

export function observationHarness() {
  const h = pipedriveHarness();
  h.client.$queryRaw.mockResolvedValue([{ acquired: true }]);
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
      if (k === "OR") return v.some((w: any) => matches(row, w));
      if (k === "AND") return v.every((w: any) => matches(row, w));
      if (v instanceof Date) return +row[k] === +v;
      if (v && typeof v === "object") {
        if ("in" in v) return v.in.includes(row[k]);
        if ("startsWith" in v)
          return typeof row[k] === "string" && row[k].startsWith(v.startsWith);
        if ("gt" in v) return row[k] > v.gt;
        if ("lte" in v) return row[k] <= v.lte;
        if ("lt" in v) return row[k] < v.lt;
        if ("not" in v) return row[k] !== v.not;
        return matches(row, v);
      }
      return row[k] === v;
    });
  for (const name of [
    "pipedriveConversionRule",
    "pipedriveWebhookEvent",
    "pipedriveConversionDedupe",
    "lead",
    "conversionRule",
    "conversionEventLog",
  ]) {
    h.state[name] = [];
    h.client[name] = {
      findFirst: vi.fn(async ({ where }: any) =>
        structuredClone(h.state[name]!.find((r) => matches(r, where)) ?? null),
      ),
      count: vi.fn(
        async ({ where }: any) =>
          h.state[name]!.filter((r) => matches(r, where)).length,
      ),
      findUnique: vi.fn(async ({ where }: any) =>
        structuredClone(h.state[name]!.find((r) => matches(r, where)) ?? null),
      ),
      findMany: vi.fn(async ({ where, orderBy, take }: any = {}) => {
        let rows = h.state[name]!.filter((r) => matches(r, where));
        if (orderBy)
          rows = rows.slice().sort((a, b) => {
            for (const order of Array.isArray(orderBy) ? orderBy : [orderBy]) {
              const [key, dir] = Object.entries(order)[0]!;
              const result = a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0;
              if (result) return result * (dir === "desc" ? -1 : 1);
            }
            return 0;
          });
        return structuredClone(rows.slice(0, take ?? rows.length));
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
          attempts: 0,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          errorCode: null,
          results: [],
          matchedLeadId: null,
          mode: "observation",
          publicationStatus: "observed",
          publicationAttempts: 0,
          publicationNextAttemptAt: null,
          publicationLeaseToken: null,
          publicationLeaseExpiresAt: null,
          publicationErrorCode: null,
          senderAttempts: 0,
          senderRetryable: false,
          senderLeaseToken: null,
          conversionEventLogId: null,
          ...data,
        };
        h.state[name]!.push(row);
        return structuredClone(row);
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = h.state[name]!.filter((r) => matches(r, where));
        for (const row of rows) {
          for (const [k, v] of Object.entries(data) as [string, any][])
            row[k] =
              v && typeof v === "object" && "increment" in v
                ? row[k] + v.increment
                : structuredClone(v);
          row.updatedAt = new Date();
        }
        return { count: rows.length };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = h.state[name]!;
        h.state[name] = before.filter((r) => !matches(r, where));
        return { count: before.length - h.state[name]!.length };
      }),
    };
  }
  const getPerson = vi.fn(
    async (_origin: string, _token: string, id: string) => ({
      id,
      phones: ["5500000000000"],
    }),
  );
  const adapter = Object.assign(h.adapter, { getPerson });
  const webhooks = new PipedriveWebhookService(
    h.client,
    adapter as any,
    h.service,
    undefined,
    undefined,
    allowedLicense,
  );
  let now = new Date("2026-10-11T18:00:00Z");
  webhooks.now = () => new Date(now);
  h.service.now = () => new Date(now);
  const seed = async () => {
    const connection = await h.service.create(
      "workspace-a",
      actor,
      structuredClone(createInput),
    );
    Object.assign(h.state.pipedriveConnection![0], {
      credentialActivatedAt: new Date(+now - 1000),
      webhookSecretHash: null,
      webhookSecretVersion: 0,
      webhookIssuedAt: null,
      webhookRateWindowAt: null,
      webhookRateCount: 0,
      catalogRefreshedAt: now,
    });
    h.state.lead!.push({
      id: "lead-a",
      workspaceId: "workspace-a",
      phoneHash: hashPhoneIdentity("5500000000000"),
      whatsappInstanceId: "instance-a",
      status: "active",
    });
    return connection;
  };
  return {
    ...h,
    adapter,
    webhooks,
    seed,
    setNow: (v: Date) => {
      now = v;
    },
    get now() {
      return new Date(now);
    },
  };
}
export function payload(at: Date, patch: any = {}) {
  return Buffer.from(
    JSON.stringify({
      meta: {
        action: "change",
        entity: "deal",
        version: "2.0",
        company_id: 1,
        host: "synthetic.pipedrive.com",
        id: "synthetic-event-1",
        timestamp: at.toISOString(),
      },
      data: {
        id: 1,
        pipeline_id: 1,
        stage_id: 11,
        person_id: 1,
        value: 12.5,
        currency: "BRL",
      },
      previous: { stage_id: 12 },
      ...patch,
    }),
  );
}
export const ruleInput = {
  name: "Synthetic rule",
  pipelineId: "1",
  stageId: "11",
  eventName: "QualifiedLead" as const,
  mode: "observation" as const,
  active: true,
  valueMode: "deal" as const,
};
