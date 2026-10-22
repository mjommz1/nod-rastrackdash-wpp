import { describe, expect, it } from "vitest";
import { buildProviderPurchaseIdentity } from "../../src/conversion-rules/provider-purchase-identity";
import { runPaytValueBackfill } from "../../src/inbound-webhook-production/payt-value-backfill";
import { parseArgs } from "../../src/scripts/backfill-payt-sale-value";

/**
 * Fase 5.0 — ported from the SaaS (`608ec47`, `1d65161`,
 * `apps/api/test/payt-value-backfill.test.ts`). In-memory oracle of the Payt
 * value backfill: Prisma calls are emulated with the subset of filters the
 * backfill uses. The fake "encryption" stores the plain JSON (the real
 * AES-GCM path is covered by the payload tests).
 *
 * Adapted to this edition: only conversions NOT yet sent to Meta are
 * corrected (allowlist of statuses; sent, dispatching, delivery unknown and
 * queued ones are only counted), and there is no
 * "Vendas sem atribuicao" table yet (Fase 5.3), so its block is left out.
 */

const workspaceId = "workspace_1";
const now = new Date("2026-10-15T12:00:00Z");
const future = new Date("2026-10-20T00:00:00Z");
const past = new Date("2026-10-10T00:00:00Z");

function sale(order: string, transaction: Record<string, unknown>) {
  return {
    transaction_id: order,
    seller_id: "seller-1",
    status: "paid",
    customer: { phone: "11999999999" },
    product: { code: "PROD1", price: 24700, quantity: 1 },
    transaction: {
      payment_status: "paid",
      paid_at: "2026-10-12T12:00:00Z",
      ...transaction,
    },
  };
}

const installment = {
  installments: 12,
  installment_price: 2480,
  total_price: 29760,
  price_without_installments: 24700,
};

function encrypted(body: unknown, expiresAt = future) {
  return {
    encryptedPayload: JSON.stringify(body),
    payloadIv: "iv",
    payloadTag: "tag",
    encryptionKeyVersion: 1,
    payloadExpiresAt: expiresAt,
  };
}

function matches(row: Record<string, any>, where: Record<string, any>) {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      if (!condition.some((c: any) => matches(row, c))) return false;
      continue;
    }
    const value = row[key];
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      if ("not" in condition && value === condition.not) return false;
      if ("gt" in condition && !(value > condition.gt)) return false;
      if ("in" in condition && !condition.in.includes(value)) return false;
      if ("notIn" in condition && condition.notIn.includes(value)) return false;
      if (
        "startsWith" in condition &&
        !String(value ?? "").startsWith(condition.startsWith)
      )
        return false;
      if ("path" in condition) {
        let current = value;
        for (const part of condition.path) current = current?.[part];
        if (current !== condition.equals) return false;
      }
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function table<T extends Record<string, any>>(rows: T[]) {
  return {
    rows,
    findMany: async ({ where, take }: any) =>
      rows
        .filter((row) => matches(row, where))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, take)
        .map((row) => ({ ...row })),
    findFirst: async ({ where }: any) =>
      rows.find((row) => matches(row, where)) ?? null,
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of rows.filter((r) => matches(r, where))) {
        for (const [key, value] of Object.entries(data)) {
          (row as any)[key] =
            value && typeof value === "object" && "increment" in (value as any)
              ? (row as any)[key] + (value as any).increment
              : value;
        }
        count += 1;
      }
      return { count };
    },
    create: async ({ data }: any) => {
      rows.push(data);
      return data;
    },
  };
}

function harness() {
  const log = (
    id: string,
    order: string,
    valueCents: number,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    workspaceId,
    eventName: "Purchase",
    sourceTrigger: "inbound_webhook:payt:provider_automation",
    // Refused by Meta: proven not received, so the backfill may correct it.
    status: "error",
    errorCode: "MetaCapiRequestRejected" as string | null,
    sentAt: null as Date | null,
    eventId: `conversion_purchase_${order}`,
    dedupeKey: buildProviderPurchaseIdentity({
      workspaceId,
      provider: "payt",
      accountRef: "seller-1",
      orderRef: order,
      eventName: "Purchase",
    }),
    valueCents,
    sourcePayload: { provider: "payt", sourceDeliveryId: `delivery_${id}` } as
      Record<string, unknown>,
    purchaseValueAdjustments: [] as Array<{ id: string }>,
    ...extra,
  });
  const delivery = (id: string, body: unknown, expiresAt = future) => ({
    id: `delivery_${id}`,
    workspaceId,
    connectionId: "connection_1",
    ...encrypted(body, expiresAt),
  });
  const logs = table([
    // 12x card sale recorded with the interest, still queued.
    log("log_a", "order-a", 29760),
    // Pix sale: both values equal.
    log("log_b", "order-b", 24700),
    // Body expired: nothing else holds the value without interest.
    log("log_c", "order-c", 29760),
    // Operator adjusted the value in a purchase review.
    log("log_d", "order-d", 29760, {
      purchaseValueAdjustments: [{ id: "adjustment_1" }],
    }),
    // Value differs from both the new and the legacy one.
    log("log_e", "order-e", 11111),
    // Not Payt.
    log("log_f", "order-f", 29760, {
      sourceTrigger: "inbound_webhook:umbler:message_phrase",
      sourcePayload: { provider: "umbler" },
    }),
    // Already sent to Meta with the legacy value: never changes.
    log("log_g", "order-g", 29760, {
      status: "sent",
      sentAt: new Date("2026-10-12T12:05:00Z"),
    }),
    // Being sent right now: may reach Meta with the legacy value.
    log("log_h", "order-h", 29760, { status: "dispatching" }),
    // CTWA send with unknown outcome.
    log("log_i", "order-i", 29760, {
      status: "delivery_unknown",
      errorCode: "MetaCapiDeliveryUnknown",
    }),
    // Generic send with unknown outcome (HTTP ok, no acknowledgement).
    log("log_j", "order-j", 29760, { errorCode: "MetaCapiDeliveryUnknown" }),
    // Queued: the sender may already hold the row with the old value.
    log("log_k", "order-k", 29760, { status: "ready_to_send", errorCode: null }),
  ]);
  const deliveries = table([
    delivery("log_a", sale("order-a", installment)),
    delivery(
      "log_b",
      sale("order-b", { total_price: 24700, price_without_installments: 24700 }),
    ),
    delivery("log_c", sale("order-c", installment), past),
    delivery("log_d", sale("order-d", installment)),
    delivery("log_e", sale("order-e", installment)),
    delivery("log_g", sale("order-g", installment)),
    delivery("log_h", sale("order-h", installment)),
    delivery("log_i", sale("order-i", installment)),
    delivery("log_j", sale("order-j", installment)),
    delivery("log_k", sale("order-k", installment)),
  ]);
  const executions = table([
    {
      id: "execution_a",
      workspaceId,
      conversionEventLogId: "log_a",
      valueCents: 29760,
    },
    {
      id: "execution_g",
      workspaceId,
      conversionEventLogId: "log_g",
      valueCents: 29760,
    },
  ]);
  const reviews = table([
    {
      id: "review_a",
      workspaceId,
      conversionEventLogId: "log_a",
      effectiveValueCents: 29760,
      version: 1,
    },
  ]);
  const audits = table<Record<string, any>>([]);
  const prisma: any = {
    conversionEventLog: logs,
    inboundWebhookDelivery: deliveries,
    providerConversionRuleExecution: executions,
    purchaseReview: reviews,
    auditLog: audits,
    $transaction: async (fn: any) => fn(prisma),
  };
  const encryption = {
    decrypt: (payload: { encryptedPayload: string }) =>
      Buffer.from(payload.encryptedPayload, "utf8"),
  };
  return { prisma, encryption, logs, deliveries, executions, reviews, audits };
}

describe("Payt value backfill (installment interest)", () => {
  it("dry-run reports the corrections without writing anything", async () => {
    const h = harness();
    const before = JSON.stringify(h.logs.rows);

    const report = await runPaytValueBackfill(h.prisma, h.encryption, {
      apply: false,
      limit: 100,
      now,
    });

    expect(report.mode).toBe("dry_run");
    expect(report.conversionEvents).toMatchObject({
      scanned: 10,
      corrected: 1,
      previousTotalCents: 29760,
      correctedTotalCents: 24700,
      unchanged: 1,
      alreadySentToMeta: 2,
      deliveryUnknown: 2,
      queued: 1,
      statusNotCorrectable: 0,
      payloadUnavailable: 1,
      manualAdjustment: 1,
      valueNotLegacy: 1,
      nextCursor: null,
    });
    expect(report.safety).toEqual({
      metaEventsResent: false,
      metaDeliveryStatusChanged: false,
      eventIdOrDedupeChanged: false,
      sentEventsChanged: false,
    });
    expect(JSON.stringify(h.logs.rows)).toBe(before);
    expect(h.audits.rows).toHaveLength(0);
  });

  it("corrects only what was not sent to Meta yet, keeping the delivery untouched", async () => {
    const h = harness();

    const report = await runPaytValueBackfill(h.prisma, h.encryption, {
      apply: true,
      limit: 100,
      actorUserId: "owner_1",
      now,
    });

    expect(report.conversionEvents).toMatchObject({
      corrected: 1,
      alreadySentToMeta: 2,
      deliveryUnknown: 2,
      queued: 1,
      executionsUpdated: 1,
      purchaseReviewsUpdated: 1,
    });
    const corrected = h.logs.rows.find((row) => row.id === "log_a")!;
    expect(corrected).toMatchObject({
      valueCents: 24700,
      status: "error",
      sentAt: null,
      eventId: "conversion_purchase_order-a",
      sourcePayload: {
        provider: "payt",
        sourceDeliveryId: "delivery_log_a",
        valueCorrection: {
          previousValueCents: 29760,
          valueCents: 24700,
          reason: "payt_price_without_installments",
          correctedAt: now.toISOString(),
          source: "backfill",
        },
      },
    });
    expect(
      h.executions.rows.find((row) => row.id === "execution_a")!.valueCents,
    ).toBe(24700);
    expect(h.reviews.rows[0]).toMatchObject({
      effectiveValueCents: 24700,
      version: 2,
    });
    // Untouched: sent to Meta, expired body, manual adjustment, unknown
    // value, other provider.
    expect(
      Object.fromEntries(h.logs.rows.map((row) => [row.id, row.valueCents])),
    ).toEqual({
      log_a: 24700,
      log_b: 24700,
      log_c: 29760,
      log_d: 29760,
      log_e: 11111,
      log_f: 29760,
      log_g: 29760,
      log_h: 29760,
      log_i: 29760,
      log_j: 29760,
      log_k: 29760,
    });
    for (const id of ["log_h", "log_i", "log_j", "log_k"])
      expect(
        h.logs.rows.find((row) => row.id === id)!.sourcePayload,
      ).not.toHaveProperty("valueCorrection");
    const sent = h.logs.rows.find((row) => row.id === "log_g")!;
    expect(sent.sourcePayload).not.toHaveProperty("valueCorrection");
    expect(sent.status).toBe("sent");
    expect(
      h.executions.rows.find((row) => row.id === "execution_g")!.valueCents,
    ).toBe(29760);
    expect(h.audits.rows.map((row) => row.action)).toEqual([
      "conversion_event.payt_value_corrected",
      "conversion_event.payt_value_backfill",
    ]);
    expect(h.audits.rows[0]).toMatchObject({
      actorUserId: "owner_1",
      targetId: "log_a",
      beforeSummary: { valueCents: 29760 },
      afterSummary: { valueCents: 24700, metaEventResent: false },
    });
  });

  it.each([
    ["sent", { status: "sent", sentAt: now }],
    ["dispatching", { status: "dispatching" }],
    ["queued again (retry)", { status: "ready_to_send", errorCode: null }],
    ["delivery unknown", { status: "delivery_unknown" }],
    ["error with unknown outcome", { errorCode: "MetaCapiDeliveryUnknown" }],
  ] as Array<[string, Record<string, unknown>]>)(
    "never races the sender: a conversion %s after it was read keeps its value",
    async (_label, change) => {
    const h = harness();
    const findDelivery = h.deliveries.findFirst;
    h.prisma.inboundWebhookDelivery = {
      ...h.deliveries,
      findFirst: async (args: any) => {
        // The CAPI worker touches log_a while the backfill reads its body.
        const row = h.logs.rows.find((log) => log.id === "log_a")!;
        Object.assign(row, change);
        return findDelivery(args);
      },
    };

    const report = await runPaytValueBackfill(h.prisma, h.encryption, {
      apply: true,
      limit: 1,
      actorUserId: "owner_1",
      now,
    });

    expect(report.conversionEvents).toMatchObject({
      corrected: 0,
      concurrentChange: 1,
      executionsUpdated: 0,
    });
    expect(h.logs.rows.find((row) => row.id === "log_a")!.valueCents).toBe(
      29760,
    );
    expect(
      h.audits.rows.map((row) => row.action),
    ).toEqual(["conversion_event.payt_value_backfill"]);
    },
  );

  it("is idempotent: a second run changes nothing", async () => {
    const h = harness();
    await runPaytValueBackfill(h.prisma, h.encryption, {
      apply: true,
      limit: 100,
      actorUserId: "owner_1",
      now,
    });
    const snapshot = JSON.stringify([
      h.logs.rows,
      h.executions.rows,
      h.reviews.rows,
    ]);

    const again = await runPaytValueBackfill(h.prisma, h.encryption, {
      apply: true,
      limit: 100,
      actorUserId: "owner_1",
      now: new Date("2026-10-16T12:00:00Z"),
    });

    expect(again.conversionEvents).toMatchObject({
      corrected: 0,
      alreadyCorrected: 1,
    });
    expect(
      JSON.stringify([h.logs.rows, h.executions.rows, h.reviews.rows]),
    ).toBe(snapshot);
  });

  it("leaves an expired body untouched and counts it", async () => {
    const h = harness();
    const report = await runPaytValueBackfill(h.prisma, h.encryption, {
      apply: true,
      limit: 100,
      actorUserId: "owner_1",
      now: new Date("2026-10-25T00:00:00Z"), // every body expired
    });
    expect(report.conversionEvents).toMatchObject({
      corrected: 0,
      payloadUnavailable: 4,
      alreadySentToMeta: 2,
      deliveryUnknown: 2,
      queued: 1,
    });
    expect(h.logs.rows.find((row) => row.id === "log_a")!.valueCents).toBe(
      29760,
    );
  });

  it("works in limited batches with a resumable cursor and refuses to apply without an actor", async () => {
    const h = harness();
    const first = await runPaytValueBackfill(h.prisma, h.encryption, {
      apply: false,
      limit: 2,
      now,
    });
    expect(first.conversionEvents).toMatchObject({
      scanned: 2,
      nextCursor: "log_b",
    });
    const rest = await runPaytValueBackfill(h.prisma, h.encryption, {
      apply: false,
      limit: 100,
      afterId: first.conversionEvents.nextCursor!,
      now,
    });
    expect(rest.conversionEvents).toMatchObject({
      scanned: 8,
      nextCursor: null,
    });

    await expect(
      runPaytValueBackfill(h.prisma, h.encryption, { apply: true, limit: 10 }),
    ).rejects.toThrow("payt_value_backfill_actor_required");
  });

  it("aligns the execution of a sale corrected at send time (legacy frozen decision)", async () => {
    const h = harness();
    const row = h.logs.rows.find((log) => log.id === "log_a")!;
    row.valueCents = 24700;
    row.status = "sent";
    row.sentAt = now;
    row.sourcePayload = {
      ...row.sourcePayload,
      valueCorrection: {
        previousValueCents: 29760,
        reason: "payt_price_without_installments",
      },
    };

    const dry = await runPaytValueBackfill(h.prisma, h.encryption, {
      apply: false,
      limit: 100,
      now,
    });
    expect(dry.conversionEvents.alreadyCorrected).toBe(1);
    expect(h.executions.rows[0]!.valueCents).toBe(29760);

    const report = await runPaytValueBackfill(h.prisma, h.encryption, {
      apply: true,
      limit: 100,
      actorUserId: "owner_1",
      now,
    });
    expect(report.conversionEvents).toMatchObject({
      alreadyCorrected: 1,
      executionsUpdated: 1,
    });
    // The run audit counts the executions aligned in this branch too.
    expect(h.audits.rows.at(-1)).toMatchObject({
      action: "conversion_event.payt_value_backfill",
      afterSummary: { executionsUpdated: 1 },
    });
    // The value Meta received (corrected at send time) stays as sent.
    expect(h.executions.rows[0]!.valueCents).toBe(24700);
    expect(row).toMatchObject({ valueCents: 24700, status: "sent" });
  });
});

describe("payt:value-backfill command arguments", () => {
  it("defaults to a limited dry-run and reads the cursor, workspace and actor", () => {
    expect(parseArgs([])).toEqual({ apply: false, limit: 200 });
    expect(
      parseArgs([
        "--",
        "--workspace",
        " workspace_1 ",
        "--limit",
        "50",
        "--after",
        "log_b",
        "--apply",
        "--actor-email",
        "owner@example.com",
      ]),
    ).toEqual({
      apply: true,
      limit: 50,
      workspaceId: "workspace_1",
      afterId: "log_b",
      actorEmail: "owner@example.com",
    });
  });

  it("refuses a limit outside 1..2000", () => {
    for (const limit of ["0", "2001", "abc", "1.5"])
      expect(() => parseArgs(["--limit", limit])).toThrow("--limit");
  });
});
