import { describe, expect, it, vi } from "vitest";
import {
  INTEGRATION_RECEIPT_RETENTION_DAYS,
  InboundWebhookMaintenanceService,
} from "../../src/inbound-webhooks/inbound-webhook-maintenance.service";

/**
 * Fase 5.3 — retention of the URL única receipts (SaaS 73a9a56 + 46fb0df0):
 * the raw postback goes with the payload retention (7 days); receipts that
 * never reached a rule are deleted after 60 days; routed ones stay.
 * In-memory table; the .pg test runs the same queries on PostgreSQL 16.
 */
const now = new Date("2026-10-19T12:00:00.000Z");
const day = 24 * 60 * 60 * 1_000;

function receipt(id: string, status: string, ageDays: number, payload = true) {
  const lastReceivedAt = new Date(now.getTime() - ageDays * day);
  return {
    id,
    status,
    lastReceivedAt,
    payloadExpiresAt: new Date(lastReceivedAt.getTime() + 7 * day),
    encryptedPayload: payload ? "ciphertext" : null,
    payloadIv: payload ? "iv" : null,
    payloadTag: payload ? "tag" : null,
    encryptionKeyVersion: payload ? 1 : null,
  };
}

function matches(row: any, where: any): boolean {
  if (where.id?.in && !where.id.in.includes(row.id)) return false;
  if (where.status?.in && !where.status.in.includes(row.status)) return false;
  if (where.lastReceivedAt?.lt && !(row.lastReceivedAt < where.lastReceivedAt.lt))
    return false;
  if (where.payloadExpiresAt?.lte && !(row.payloadExpiresAt <= where.payloadExpiresAt.lte))
    return false;
  if (where.OR && !where.OR.some((clause: any) => {
    const [key] = Object.keys(clause);
    return row[key!] !== null;
  }))
    return false;
  return true;
}

function service(rows: any[]) {
  const table = [...rows];
  const prisma: any = {
    integrationEndpointEvent: {
      findMany: vi.fn(async ({ where, take }: any) =>
        table.filter((row) => matches(row, where)).slice(0, take).map((row) => ({ id: row.id })),
      ),
      deleteMany: vi.fn(async ({ where }: any) => {
        const doomed = table.filter((row) => matches(row, where));
        for (const row of doomed) table.splice(table.indexOf(row), 1);
        return { count: doomed.length };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const touched = table.filter((row) => matches(row, where));
        for (const row of touched) Object.assign(row, data);
        return { count: touched.length };
      }),
    },
  };
  const maintenance = new InboundWebhookMaintenanceService(
    prisma,
    { INBOUND_WEBHOOKS_ENABLED: "true" } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { maintenance: maintenance as any, table, prisma };
}

describe("URL única receipts retention", () => {
  it("keeps 60 days", () => {
    expect(INTEGRATION_RECEIPT_RETENTION_DAYS).toBe(60);
  });

  it("deletes unrouted receipts (pending, unattributed, ignored, invalid) older than 60 days and keeps routed ones", async () => {
    const { maintenance, table } = service([
      receipt("old_unattributed", "unattributed", 61, false),
      receipt("old_pending", "pending", 90, false),
      receipt("old_ignored", "ignored", 61, false),
      receipt("old_invalid", "invalid", 75, false),
      receipt("old_routed", "routed", 400, false),
      receipt("recent_unattributed", "unattributed", 59, false),
    ]);
    await expect(maintenance.deleteOldIntegrationReceipts(now)).resolves.toBe(4);
    expect(table.map((row) => row.id).sort()).toEqual([
      "old_routed",
      "recent_unattributed",
    ]);
  });

  it("measures the 60 days from the LAST attempt: a sale the platform keeps resending stays", async () => {
    const { maintenance, table } = service([
      { ...receipt("resent", "unattributed", 1), firstReceivedAt: new Date(now.getTime() - 120 * day) },
    ]);
    await expect(maintenance.deleteOldIntegrationReceipts(now)).resolves.toBe(0);
    expect(table).toHaveLength(1);
  });

  it("drops the raw postback after the payload retention but keeps product and reason", async () => {
    const { maintenance, table } = service([
      { ...receipt("expired", "unattributed", 8), productCode: "PRODA", reasonCode: "product_without_rule" },
      receipt("fresh", "unattributed", 2),
    ]);
    await expect(
      maintenance.clearExpiredIntegrationReceiptPayloads(now),
    ).resolves.toBe(1);
    expect(table.find((row) => row.id === "expired")).toMatchObject({
      encryptedPayload: null,
      payloadIv: null,
      payloadTag: null,
      encryptionKeyVersion: null,
      productCode: "PRODA",
      reasonCode: "product_without_rule",
    });
    expect(table.find((row) => row.id === "fresh")?.encryptedPayload).toBe(
      "ciphertext",
    );
  });
});
