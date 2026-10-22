import { Prisma } from "@prisma/client";
import { vi } from "vitest";
import { wildcardDispatchFixture } from "./inbound-wildcard-fixture";
import { InboundWebhookReplayService } from "../../src/inbound-webhook-replay/inbound-webhook-replay.service";
import type { StudentReplayActor } from "../../src/inbound-webhook-replay/student-replay-context";

// Synthetic persistence with real parser/encryption/eligibility/services.
// This is not a PostgreSQL integration test and does not claim database locking proof.
function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, val]: [string, any]) => {
    if (key === "OR") return val.some((part: any) => matches(row, part));
    const actual = row?.[key];
    if (val && typeof val === "object" && !(val instanceof Date)) {
      if ("in" in val) return val.in.includes(actual);
      if ("not" in val) return actual !== val.not;
      if ("is" in val)
        return val.is === null ? actual == null : matches(actual, val.is);
      if ("gte" in val && actual < val.gte) return false;
      if ("lte" in val && actual > val.lte) return false;
      if ("gt" in val && actual <= val.gt) return false;
      if ("gte" in val || "lte" in val || "gt" in val) return true;
      return matches(actual, val);
    }
    return actual === val;
  });
}

export function studentReplayFixture() {
  const h = wildcardDispatchFixture();
  const actor: StudentReplayActor = {
    id: "actor",
    role: "owner",
    workspaceId: "ws",
  };
  const owner = {
    id: "membership",
    userId: actor.id,
    workspaceId: "ws",
    role: "owner",
    workspace: { operationalStatus: "active" },
  };
  const events: any[] = [h.event],
    batches: any[] = [],
    items: any[] = [],
    audits: any[] = [],
    logs: any[] = [];
  h.delivery.firstReceivedAt = new Date(Date.now() - 120_000);
  const license = {
    getLockState: vi.fn(async () => ({ inert: false, locked: false })),
  };
  let sequence = 0;
  const refreshRelations = () => {
    for (const event of events)
      event.replayItem = items.find((i) => i.eventId === event.id) ?? null;
    for (const batch of batches)
      batch.items = items.filter((i) => i.batchId === batch.id);
  };
  const read = (rows: any[], args: any) => {
    refreshRelations();
    let result = rows.filter((r) => matches(r, args?.where));
    if ((JSON.stringify(args?.orderBy) ?? "").includes('"desc"'))
      result = [...result].reverse();
    if (args?.take) result = result.slice(0, args.take);
    return result;
  };
  Object.assign(h.prisma, {
    metaIntegration: { findUnique: vi.fn(async () => null) },
    workspaceMember: {
      findFirst: vi.fn(async ({ where }) =>
        matches(owner, where) ? owner : null,
      ),
    },
    $queryRaw: vi.fn(async () => []),
    inboundWebhookEvent: {
      ...h.prisma.inboundWebhookEvent,
      findMany: vi.fn(async (args) => read(events, args)),
      findFirst: vi.fn(async (args) => read(events, args)[0] ?? null),
    },
    inboundWebhookConnection: {
      ...h.prisma.inboundWebhookConnection,
      findFirst: vi.fn(async ({ where }) =>
        matches(h.connection, where) ? h.connection : null,
      ),
    },
    inboundWebhookChannel: {
      ...h.prisma.inboundWebhookChannel,
      findFirst: vi.fn(async ({ where }) =>
        matches(h.channel, where) ? h.channel : null,
      ),
      count: vi.fn(async ({ where }) => (matches(h.channel, where) ? 1 : 0)),
    },
    inboundWebhookReplayBatch: {
      findFirst: vi.fn(async (args) => read(batches, args)[0] ?? null),
      findMany: vi.fn(async (args) => read(batches, args)),
      count: vi.fn(async (args) => read(batches, args).length),
      create: vi.fn(async ({ data }) => {
        const now = new Date();
        const row = {
          id: `batch-${++sequence}`,
          totalItems: 0,
          materializedCount: 0,
          duplicateCount: 0,
          skippedCount: 0,
          failedCount: 0,
          retryableFailedCount: 0,
          retryCount: 0,
          startedAt: null,
          completedAt: null,
          lastRetriedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
          items: [],
        };
        batches.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = batches.find((r) => matches(r, where));
        if (!row) throw new Error("fixture batch missing");
        Object.assign(row, data);
        refreshRelations();
        return row;
      }),
      deleteMany: vi.fn(async ({ where }) => {
        const remove = batches.filter((r) => matches(r, where));
        for (const row of remove) batches.splice(batches.indexOf(row), 1);
        return { count: remove.length };
      }),
    },
    inboundWebhookReplayItem: {
      findFirst: vi.fn(async (args) => {
        const row = read(items, args)[0];
        return row
          ? { ...row, event: events.find((e) => e.id === row.eventId) }
          : null;
      }),
      findMany: vi.fn(async (args) => read(items, args)),
      count: vi.fn(async (args) => read(items, args).length),
      createMany: vi.fn(async ({ data }) => {
        let count = 0;
        for (const row of data) {
          if (items.some((i) => i.eventId === row.eventId)) continue;
          items.push({
            id: `item-${++sequence}`,
            conversionEventLogId: null,
            errorCode: null,
            attemptCount: 0,
            createdAt: new Date(),
            ...row,
          });
          count++;
        }
        refreshRelations();
        return { count };
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = items.find((i) => matches(i, where));
        if (!row) throw new Error("fixture item missing");
        Object.assign(row, data, {
          attemptCount: data.attemptCount?.increment
            ? row.attemptCount + data.attemptCount.increment
            : row.attemptCount,
        });
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const rows = read(items, { where });
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
      deleteMany: vi.fn(async ({ where }) => {
        const rows = read(items, { where });
        for (const row of rows) items.splice(items.indexOf(row), 1);
        refreshRelations();
        return { count: rows.length };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }) => {
        if (data.id && audits.some((a) => a.id === data.id))
          throw new Prisma.PrismaClientKnownRequestError(
            "synthetic unique constraint",
            { code: "P2002", clientVersion: "6.19.3" },
          );
        const row = { id: `audit-${++sequence}`, createdAt: new Date(), ...data };
        audits.push(row);
        return row;
      }),
      findFirst: vi.fn(async (args) => read(audits, args)[0] ?? null),
      findMany: vi.fn(async (args) => read(audits, args)),
      update: vi.fn(async ({ where, data }) => {
        const row = audits.find((a) => matches(a, where));
        if (!row) throw new Error("fixture audit missing");
        Object.assign(row, data);
        return row;
      }),
    },
    conversionEventLog: {
      updateMany: vi.fn(async ({ where, data }) => {
        const rows = read(logs, { where });
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
      findFirst: vi.fn(async (args) => read(logs, args)[0] ?? null),
      findUnique: vi.fn(async (args) => read(logs, args)[0] ?? null),
      findMany: vi.fn(async (args) => read(logs, args)),
      update: vi.fn(async ({ where, data }) => {
        const row = logs.find((l) => matches(l, where));
        if (!row) throw new Error("fixture log missing");
        Object.assign(row, data);
        return row;
      }),
    },
  });
  h.prisma.metaBusinessConnection.findMany = vi.fn(async ({ where }) =>
    matches(h.business, { workspaceId: where.workspaceId }) &&
    where.id.in.includes(h.business.id)
      ? [h.business]
      : [],
  );
  h.prisma.metaConversionDestination.findMany = vi.fn(async ({ where }) =>
    matches(h.destination, where) ? [h.destination] : [],
  );
  const accountRead = h.prisma.metaReportingAccount.findMany;
  h.prisma.metaReportingAccount.findMany = vi.fn(async (args) =>
    accountRead({
      ...args,
      where: {
        ...args.where,
        businessConnectionId:
          typeof args.where.businessConnectionId === "object"
            ? args.where.businessConnectionId.in[0]
            : args.where.businessConnectionId,
      },
    }),
  );
  let tail = Promise.resolve();
  h.prisma.$transaction = vi.fn(async (fn) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const lengths = [batches.length, items.length, audits.length];
    try {
      return await fn(h.prisma);
    } catch (error) {
      batches.splice(lengths[0]);
      items.splice(lengths[1]);
      audits.splice(lengths[2]);
      refreshRelations();
      throw error;
    } finally {
      release();
    }
  });
  h.conversions.recordExternalConversion.mockImplementation(
    async (input: any) => {
      const existing = logs.find((l) => l.dedupeKey === input.dedupeKey);
      if (existing)
        return {
          status: "duplicate",
          conversionEventLogId: existing.id,
          deliveryStatus: existing.status,
        };
      const log = {
        id: `conversion-${++sequence}`,
        status: "ready_to_send",
        sentAt: null,
        ...input,
      };
      logs.push(log);
      return {
        status: "created",
        conversionEventLogId: log.id,
        deliveryStatus: log.status,
      };
    },
  );
  const replay = new InboundWebhookReplayService(
    h.prisma,
    h.encryption,
    h.registry,
    h.leads as never,
    h.conversions as never,
    h.conversionQueue as never,
    h.replayQueue as never,
    h.env,
    license as never,
  );
  const preview = () =>
    replay.previewStudentReplay(actor, "connection", "channel");
  const authorize = async (
    selection: "canary_1" | "remaining" = "canary_1",
    ticket?: string,
  ) => {
    const p = ticket ? { previewToken: ticket } : await preview();
    if (!p.previewToken)
      throw new Error(
        (p as any).unavailableReason ??
          "Nenhum evento possui rota completa e payload disponivel",
      );
    return replay.authorizeStudentReplay(actor, "connection", "channel", {
      confirmation: "fixture",
      selection,
      previewToken: p.previewToken,
    });
  };
  function addEvent(index: number, accountIndex = 0) {
    const payload = structuredClone(h.payload);
    const message = payload.entry[0].changes[0].value.messages[0];
    message.id = `wamid.synthetic-${index}`;
    message.referral.source_id = h.ads[accountIndex].adId;
    const parsed = h.registry
      .resolve({ provider: "meta_cloud", parserVersion: "v1" })
      .parse(payload).events[0];
    const deliveryId = `delivery-${index}`;
    const delivery = {
      ...h.delivery,
      id: deliveryId,
      ...h.encryption.encrypt(Buffer.from(JSON.stringify(payload)), {
        workspaceId: "ws",
        connectionId: "connection",
        deliveryId,
      }),
    };
    const event = {
      ...h.event,
      id: `event-${index}`,
      deliveryId,
      delivery,
      externalMessageId: parsed.externalMessageId,
      dedupeKey: parsed.dedupeKey,
      adId: parsed.adId,
      occurredAt: parsed.occurredAt,
      resolvedReportingAccountId: h.accounts[accountIndex].id,
      resolvedReportingAccount: h.accounts[accountIndex],
      replayItem: null,
    };
    events.push(event);
    return event;
  }
  return {
    ...h,
    replay,
    actor,
    owner,
    events,
    batches,
    items,
    audits,
    logs,
    license,
    preview,
    authorize,
    addEvent,
  };
}
