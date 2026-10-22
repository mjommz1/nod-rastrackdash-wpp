import { Prisma } from "@prisma/client";
import { vi } from "vitest";
import { KommoService } from "../../src/kommo/kommo.service";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import { hashPhoneIdentity } from "../../src/common/phone/phone-identity";

// A stateful transaction/constraint simulator. It exercises the service's CAS
// predicates and commit/rollback paths; it is NOT PostgreSQL concurrency proof.
export function matches(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]: any) => {
    if (value === undefined) return true;
    if (key === "OR") return value.some((clause: any) => matches(row, clause));
    if (key === "AND")
      return (Array.isArray(value) ? value : [value]).every((clause: any) =>
        matches(row, clause),
      );
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("in" in value) return value.in.includes(row[key]);
      if ("startsWith" in value)
        return (
          typeof row[key] === "string" && row[key].startsWith(value.startsWith)
        );
      if ("is" in value) return value.is === null ? row[key] == null : matches(row[key] ?? {}, value.is);
      if ("gte" in value) return row[key] != null && row[key] >= value.gte;
      if ("not" in value) return row[key] !== value.not;
      if ("lt" in value) return row[key] != null && row[key] < value.lt;
      if ("gt" in value) return row[key] != null && row[key] > value.gt;
      if ("lte" in value) return row[key] != null && row[key] <= value.lte;
      if (key.includes("_")) return matches(row, value);
      if (row[key] && typeof row[key] === "object")
        return matches(row[key], value);
    }
    return row[key] instanceof Date && value instanceof Date
      ? row[key].getTime() === value.getTime()
      : row[key] === value;
  });
}
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export function kommoHarness(extraTables: string[] = []) {
  let time = new Date("2026-10-05T12:00:00Z");
  vi.stubEnv(
    "KOMMO_CRM_ENCRYPTION_KEY",
    Buffer.alloc(32, 7).toString("base64"),
  );
  vi.stubEnv("API_PUBLIC_URL", "");
  const state: Record<string, any[]> = {};
  const prisma: any = {};
  const uniqueKeys: Record<string, string[][]> = {
    kommoWebhookEvent: [["deliveryKey"]],
    kommoConversionDedupe: [
      ["workspaceId", "verifiedAccountId", "dealId", "eventName"],
    ],
    conversionEventLog: [["dedupeKey"]],
    auditLog: [["id"]],
    kommoPipelineCatalog: [["connectionId", "pipelineId", "statusId"]],
  };
  let sequence = 0;
  const tableNames = [
    "kommoConnection",
    "kommoWebhookEvent",
    "kommoPipelineCatalog",
    "kommoConversionRule",
    "kommoConversionDedupe",
    "conversionEventLog",
    "lead",
    "metaAd",
    "metaReportingAccount",
    "inboundWebhookEvent",
    "metaAdDestinationAssignment",
    "inboundWebhookChannelRoute",
    // Numbers bound by channel id (shared CRM channel policy); empty unless a
    // test seeds them.
    "inboundWebhookChannel",
    "auditLog",
    "jobAttempt",
    "integrationLog",
    "diagnosticEvent",
    "purchaseReview",
    "providerConversionRuleExecution",
    ...extraTables,
  ];
  for (const name of tableNames) {
    state[name] = [];
    const copy = (row: any, args: any = {}) => {
      if (!row) return null;
      const result = structuredClone(row);
      if (args.include?.connection && name.startsWith("kommo"))
        result.connection = structuredClone(
          state.kommoConnection.find((item) => item.id === row.connectionId),
        );
      if (name === "inboundWebhookReplayBatch" && args.include?.items) result.items = structuredClone(state.inboundWebhookReplayItem.filter((item) => item.batchId === row.id));
      if (name === "inboundWebhookEvent") {
        result.connection = structuredClone(state.inboundWebhookConnection?.find((item) => item.id === row.connectionId) ?? row.connection);
        result.channel = structuredClone(state.inboundWebhookChannel?.find((item) => item.id === row.channelId) ?? row.channel);
        result.replayItem = structuredClone(state.inboundWebhookReplayItem?.find((item) => item.eventId === row.id) ?? null);
      }
      if (name === "metaReportingAccount" && state.metaReportingAccountDestination && (args.select?.allowedDestinations || args.include?.allowedDestinations)) {
        const relation = args.select?.allowedDestinations ?? args.include?.allowedDestinations;
        result.allowedDestinations = structuredClone((state.metaReportingAccountDestination ?? []).filter((binding) => binding.reportingAccountId === row.id && matches(binding, relation.where)));
      }
      if (args.include?.pipelines)
        result.pipelines = structuredClone(
          state.kommoPipelineCatalog.filter(
            (item) => item.connectionId === row.id,
          ),
        );
      if (args.include?.rules)
        result.rules = structuredClone(
          state.kommoConversionRule.filter(
            (item) => item.connectionId === row.id,
          ),
        );
      return result;
    };
    const apply = (row: any, data: any) => {
      for (const [key, value] of Object.entries(data) as any) {
        if (value === undefined) continue;
        row[key] =
          value && typeof value === "object" && "increment" in value
            ? row[key] + value.increment
            : structuredClone(value);
      }
      row.updatedAt = new Date(time);
      return copy(row);
    };
    prisma[name] = {
      findFirst: vi.fn(async (args: any = {}) =>
        copy(
          state[name].find((row) => matches(row, args.where)),
          args,
        ),
      ),
      findUnique: vi.fn(async (args: any) =>
        copy(
          state[name].find((row) => matches(row, args.where)),
          args,
        ),
      ),
      findUniqueOrThrow: vi.fn(async (args: any) => {
        const row = state[name].find((row) => matches(row, args.where));
        if (!row) throw new Error("not found");
        return copy(row, args);
      }),
      findMany: vi.fn(async (args: any = {}) => {
        let rows = state[name].filter((row) => matches(row, args.where));
        if (args.orderBy?.id)
          rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
        return rows
          .slice(0, args.take ?? Infinity)
          .map((row) => copy(row, args));
      }),
      count: vi.fn(
        async (args: any) =>
          state[name].filter((row) => matches(row, args.where)).length,
      ),
      create: vi.fn(async ({ data }: any) => {
        if (
          uniqueKeys[name]?.some((keys) =>
            state[name].some((row) =>
              keys.every((key) => row[key] === data[key]),
            ),
          )
        )
          throw new Prisma.PrismaClientKnownRequestError("duplicate", {
            code: "P2002",
            clientVersion: "synthetic",
          });
        const row = {
          id: `${name}-${String(++sequence).padStart(5, "0")}`,
          createdAt: new Date(time),
          updatedAt: new Date(time),
          ...(name === "kommoWebhookEvent"
            ? {
                status: "accepted",
                revision: 0,
                leaseToken: null,
                leaseExpiresAt: null,
                nextAttemptAt: null,
                attempts: 0,
                results: [],
                errorCode: null,
              }
            : {}),
          ...(name === "kommoConversionDedupe"
            ? {
                publicationStatus: "materialized",
                publicationAttempts: 0,
                senderAttempts: 0,
                senderRetryable: false,
                senderLeaseToken: null,
                publicationLeaseToken: null,
                publicationLeaseExpiresAt: null,
                publicationNextAttemptAt: null,
              }
            : {}),
          ...structuredClone(data),
        };
        state[name].push(row);
        return copy(row);
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = state[name].find((row) => matches(row, where));
        if (!row) throw new Error("not found");
        return apply(row, data);
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = state[name].filter((row) => matches(row, where));
        rows.forEach((row) => apply(row, data));
        return { count: rows.length };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const rows = state[name].filter((row) => matches(row, where));
        state[name] = state[name].filter((row) => !rows.includes(row));
        return { count: rows.length };
      }),
      delete: vi.fn(async ({ where }: any) => {
        const row = state[name].find((row) => matches(row, where));
        state[name] = state[name].filter((item) => item !== row);
        return row;
      }),
      upsert: vi.fn(async (args: any) => {
        const row = state[name].find((row) => matches(row, args.where));
        return row
          ? apply(row, args.update)
          : prisma[name].create({ data: args.create });
      }),
    };
  }
  let transactionTail = Promise.resolve();
  prisma.$queryRaw = vi.fn(async (query: any) =>
    query?.sql?.includes("pg_try_advisory_xact_lock")
      ? [{ acquired: true }]
      : [],
  );
  prisma.$transaction = vi.fn(async (callback: any) => {
    const previous = transactionTail;
    const done = deferred();
    transactionTail = done.promise;
    await previous;
    const snapshot = structuredClone(state);
    try {
      return await callback(prisma);
    } catch (error) {
      for (const name of tableNames) state[name] = snapshot[name];
      throw error;
    } finally {
      done.resolve();
    }
  });
  const adapter = {
    verify: vi.fn(async () => ({ id: "account-a", subdomain: "synthetic" })),
    listPipelines: vi.fn(async (_origin: string, _token: string) => [
      {
        id: "p",
        name: "Pipeline",
        sort: 1,
        statuses: [{ id: "142", name: "Won", type: "won" }],
      },
    ]),
    getLead: vi.fn(async () => ({
      id: "deal-a",
      accountId: "account-a",
      contactIds: ["contact-a"],
    })),
    getContact: vi.fn(async () => ({
      id: "contact-a",
      accountId: "account-a",
      phones: ["+5511999999999"],
    })),
  };
  const queue = { enqueue: vi.fn(async (id: string) => `job-${id}`) };
  const conversionQueue = {
    retrySend: vi.fn(async (_id: string, _workspace: string) => ({
      status: "queued",
    })),
  };
  let licenseDecision: any = { inert: true, locked: false };
  const license = {
    getLockState: vi.fn(async () => licenseDecision),
  };
  const metaAdapter = { sendEvent: vi.fn() };
  const conversions = new ConversionEventsService(
    prisma,
    metaAdapter as any,
    {} as any,
    undefined,
    license as any,
  );
  const service = new KommoService(
    prisma,
    adapter as any,
    queue as any,
    conversions,
    conversionQueue as any,
    license as any,
  );
  service.now = () => new Date(time);
  const connection: any = {
    id: "connection-a",
    workspaceId: "workspace-a",
    status: "active",
    verifiedAccountId: "account-a",
    accountSubdomain: "synthetic",
    accountOrigin: "https://synthetic.kommo.com/",
    credentialGeneration: 1,
    credentialHealthy: true,
    catalogState: "fresh",
    catalogRefreshedAt: new Date(time),
    allowedChannelRouteIds: ["route-a"],
    createdAt: time,
    updatedAt: time,
    webhookSecretHash: (service as any).hash("synthetic-capability"),
    ...(service as any).encrypt("connection-a", "synthetic-token-only"),
  };
  state.kommoConnection.push(connection);
  state.kommoPipelineCatalog.push({
    id: "catalog-a",
    workspaceId: "workspace-a",
    connectionId: connection.id,
    pipelineId: "p",
    statusId: "142",
    available: true,
  });
  state.kommoConversionRule.push({
    id: "rule-a",
    workspaceId: "workspace-a",
    connectionId: connection.id,
    name: "Synthetic Purchase",
    pipelineId: "p",
    statusId: "142",
    eventName: "Purchase",
    mode: "production",
    active: true,
    valueMode: "lead_price",
    currency: "BRL",
    fixedValueCents: null,
    contentName: null,
    createdAt: time,
    updatedAt: time,
  });
  state.lead.push({
    id: "captured-lead",
    workspaceId: "workspace-a",
    phoneHash: hashPhoneIdentity("+5511999999999"),
    whatsappInstanceId: "instance-a",
    campaignId: "campaign-a",
    adSetId: "adset-a",
    adId: "ad-a",
    ctwaClid: "trusted-click",
  });
  state.metaAdDestinationAssignment.push({
    workspaceId: "workspace-a",
    adId: "ad-a",
    conversionDestinationId: "destination-a",
    reportingAccountId: "reporting-a",
  });
  state.inboundWebhookChannelRoute.push({
    id: "route-a",
    workspaceId: "workspace-a",
    active: true,
    validationStatus: "valid",
    metaConversionDestinationId: "destination-a",
    metaReportingAccountId: "reporting-a",
    metaBusinessConnectionId: "business-a",
    channel: {
      id: "channel-a",
      workspaceId: "workspace-a",
      status: "active",
      productionActivatedAt: time,
      whatsappInstanceId: "instance-a",
      whatsappInstance: { workspaceId: "workspace-a", status: "active" },
      connection: {
        workspaceId: "workspace-a",
        status: "production",
        productionActivatedAt: time,
        removedAt: null,
        parserRelease: { status: "certified" },
      },
    },
    metaBusinessConnection: {
      id: "business-a",
      workspaceId: "workspace-a",
      status: "active",
      credential: { workspaceId: "workspace-a", status: "active" },
    },
    metaReportingAccount: {
      id: "reporting-a",
      adAccountId: "act_synthetic",
      workspaceId: "workspace-a",
      active: true,
      businessConnectionId: "business-a",
    },
    metaConversionDestination: {
      workspaceId: "workspace-a",
      pixelId: "synthetic-pixel",
      pageId: "synthetic-page",
      status: "configured",
    },
  });
  const stageEvent = {
    accountId: "account-a",
    accountSubdomain: "synthetic",
    dealId: "deal-a",
    pipelineId: "p",
    statusId: "142",
    oldStatusId: "100",
    occurredAt: time,
    priceCents: 12000,
    pricePresent: true,
  };
  const receive = async (override: any = {}) => {
    await service.receive(connection.id, "synthetic-capability", [
      { ...stageEvent, ...override },
    ]);
    return state.kommoWebhookEvent.at(-1)!;
  };
  return {
    service,
    state,
    prisma,
    adapter,
    queue,
    conversionQueue,
    conversions,
    license,
    setLicense: (decision: any) => {
      licenseDecision = decision;
    },
    metaAdapter,
    connection,
    stageEvent,
    receive,
    advance: (ms: number) => {
      time = new Date(time.getTime() + ms);
    },
  };
}
