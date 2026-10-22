import { vi } from "vitest";
import type { PrismaService } from "../../src/common/prisma/prisma.service";
import {
  PipedriveAdapter,
  type PipedrivePipeline,
} from "../../src/pipedrive/pipedrive.adapter";
import { PipedriveService } from "../../src/pipedrive/pipedrive.service";

// Synthetic transactional store only for tests; never a production persistence fallback.
export function pipedriveHarness() {
  const state: Record<string, any[]> = {
    pipedriveConnection: [],
    pipedrivePipelineCatalog: [],
    pipedriveStageCatalog: [],
    auditLog: [],
    pipedriveConversionRule: [],
    pipedriveWebhookEvent: [],
    pipedriveConversionDedupe: [],
  };
  const match = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([key, value]) =>
      value !== null && typeof value === "object" && !(value instanceof Date)
        ? match(row, value)
        : value instanceof Date
          ? +row[key] === +value
          : row[key] === value,
    );
  const update = (row: any, data: any) => {
    for (const [key, value] of Object.entries(data)) {
      row[key] =
        value && typeof value === "object" && "increment" in value
          ? row[key] + (value as { increment: number }).increment
          : structuredClone(value);
    }
    if (!data.updatedAt) row.updatedAt = new Date();
    return structuredClone(row);
  };
  const client: any = { $queryRaw: vi.fn(async () => []) };
  for (const model of Object.keys(state)) {
    const rows = () => state[model]!;
    client[model] = {
      findFirst: vi.fn(async ({ where }: any) =>
        structuredClone(rows().find((row) => match(row, where)) ?? null),
      ),
      findMany: vi.fn(async ({ where, include }: any = {}) =>
        rows()
          .filter((row) => match(row, where))
          .map((row) => ({
            ...structuredClone(row),
            ...(include?._count
              ? {
                  _count: {
                    pipelines: state.pipedrivePipelineCatalog!.filter(
                      (p) => p.connectionId === row.id && p.available,
                    ).length,
                    rules: state.pipedriveConversionRule!.filter(
                      (r) => r.connectionId === row.id,
                    ).length,
                  },
                }
              : {}),
            ...(include?.stages
              ? {
                  stages: state.pipedriveStageCatalog!.filter(
                    (stage) =>
                      stage.workspaceId === row.workspaceId &&
                      stage.connectionId === row.connectionId &&
                      stage.pipelineId === row.pipelineId &&
                      match(stage, include.stages.where),
                  ),
                }
              : {}),
          })),
      ),
      create: vi.fn(async ({ data }: any) => {
        if (
          model === "pipedriveConnection" &&
          rows().some(
            (row) =>
              row.workspaceId === data.workspaceId &&
              row.verifiedAccountId === data.verifiedAccountId,
          )
        )
          throw { code: "P2002", message: "synthetic-private-database-text" };
        const row = {
          id: `synthetic-${rows().length}`,
          ...(model === "pipedriveConnection"
            ? {
                credentialActivatedAt: new Date(),
                webhookSecretHash: null,
                webhookSecretVersion: 0,
                webhookIssuedAt: null,
                webhookRateWindowAt: null,
                webhookRateCount: 0,
                webhookLastReceivedAt: null,
                mutationRevision: 0,
                status: "blocked",
                credentialGeneration: 1,
                credentialHealthy: false,
                verifiedAccountId: null,
                accountSubdomain: null,
                allowedChannelRouteIds: [],
                catalogState: "empty",
                catalogRefreshedAt: null,
                lastErrorCode: null,
              }
            : {}),
          available: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows().push(row);
        return structuredClone(row);
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const selected = rows().filter((row) => match(row, where));
        selected.forEach((row) => {
          if (
            model === "pipedriveConnection" &&
            data.verifiedAccountId &&
            rows().some(
              (other) =>
                other.id !== row.id &&
                other.workspaceId === row.workspaceId &&
                other.verifiedAccountId === data.verifiedAccountId,
            )
          )
            throw { code: "P2002", message: "synthetic-private-database-text" };
          update(row, data);
        });
        return { count: selected.length };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const count = rows().filter((row) => match(row, where)).length;
        state[model] = rows().filter((row) => !match(row, where));
        return { count };
      }),
    };
  }
  const route: any = {
    id: "route-a",
    workspaceId: "workspace-a",
    active: true,
    validationStatus: "valid",
    channel: {
      workspaceId: "workspace-a",
      status: "active",
      productionActivatedAt: new Date(),
      whatsappInstanceId: "instance-a",
      whatsappInstance: { workspaceId: "workspace-a", status: "active" },
      connection: {
        workspaceId: "workspace-a",
        status: "production",
        productionActivatedAt: new Date(),
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
      workspaceId: "workspace-a",
      active: true,
      businessConnectionId: "business-a",
    },
    metaConversionDestination: {
      workspaceId: "workspace-a",
      status: "configured",
    },
  };
  client.inboundWebhookChannelRoute = {
    findFirst: vi.fn(async ({ where }: any) =>
      match(route, where) ? structuredClone(route) : null,
    ),
    // Binding lookup (route id -> channel id) used for CTWA destination proofs.
    findMany: vi.fn(async ({ where }: any) =>
      (where?.id?.in ?? []).includes(route.id) &&
      route.workspaceId === where.workspaceId
        ? [{ id: route.id, channelId: (route.channel as any).id ?? "channel-a" }]
        : [],
    ),
  };
  // Numbers bound directly by channel id (inherit_workspace page/pixel).
  const channels: any[] = [];
  client.inboundWebhookChannel = {
    findFirst: vi.fn(async ({ where }: any) =>
      structuredClone(channels.find((row) => match(row, where)) ?? null),
    ),
    findMany: vi.fn(async ({ where }: any) =>
      channels
        .filter(
          (row) =>
            (where?.id?.in ?? []).includes(row.id) &&
            row.workspaceId === where.workspaceId,
        )
        .map((row) => ({ id: row.id })),
    ),
  };
  let tail = Promise.resolve();
  client.$transaction = vi.fn(
    async (callback: (tx: any) => Promise<unknown>) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const before = structuredClone(state);
      try {
        return await callback(client);
      } catch (error) {
        Object.assign(state, before);
        throw error;
      } finally {
        release();
      }
    },
  );
  const adapter = {
    verify: vi.fn(async () => ({ id: "1", subdomain: "synthetic" })),
    listPipelines: vi.fn(async (): Promise<PipedrivePipeline[]> => [
      { id: "2", name: "Empty", sort: 2, stages: [] },
      {
        id: "1",
        name: "Sales",
        sort: 1,
        stages: [
          { id: "12", name: "Later", sort: 2 },
          { id: "11", name: "Earlier", sort: 1 },
        ],
      },
    ]),
  };
  const service = new PipedriveService(
    client as PrismaService,
    adapter as unknown as PipedriveAdapter,
  );
  return { state, client, adapter, service, route, channels };
}

export const createInput = {
  displayName: "Synthetic CRM",
  accountOrigin: "https://synthetic.pipedrive.com",
  apiToken: "synthetic-token-123456",
  allowedChannelRouteIds: ["route-a"],
};
export const actor = { userId: "owner-a", type: "user" as const };
/** Active license (student edition): background Pipedrive work requires it. */
export const allowedLicense = {
  getLockState: async () => ({
    inert: false,
    locked: false,
    reason: null,
    state: { status: "active" },
  }),
} as any;
/** Locked license: no background processing, materialization or send. */
export const lockedLicense = {
  getLockState: async () => ({
    inert: false,
    locked: true,
    reason: "revoked",
    state: { status: "revoked" },
  }),
} as any;
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
