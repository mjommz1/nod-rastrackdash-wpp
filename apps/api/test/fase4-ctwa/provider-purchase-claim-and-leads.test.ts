import { describe, expect, it, vi } from "vitest";
import { ProviderConversionOrchestrator } from "../../src/conversion-rules/provider-conversion-orchestrator.service";
import { ProviderConversionPaidLeadResolver } from "../../src/conversion-rules/provider-conversion-paid-lead-resolver.service";
import {
  ProviderConversionProductionFailure,
  ProviderConversionProductionService,
} from "../../src/inbound-webhook-production/provider-conversion-production.service";
import { CTWA_SEND_SKIPPED_ERROR_CODE } from "../../src/conversion-events/conversion-event-retry";
import {
  hashNormalizedPhone,
  hashPhoneIdentity,
  hashPhoneIdentityVariants,
} from "../../src/common/phone/phone-identity";

const purchaseKey = `purchase:${"a".repeat(64)}`;

function persisted(
  occurrenceKey: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `decision-${occurrenceKey}`,
    decisionVersion: 1,
    workspaceId: "ws1",
    providerRuleId: "rule1",
    sourceDeliveryId: `delivery-${occurrenceKey}`,
    channelId: "ch1",
    occurrenceKey,
    occurredAt: new Date(),
    leadId: "lead1",
    decision: {
      decisionCode: "eligible",
      engineVersion: "e1",
      parserVersion: "p1",
      reasonCode: "eligible",
      occurrence: {
        provider: "payt",
        purchaseKey,
        contactIdentityHash: "hash",
        ...overrides,
      },
      rule: { mode: "observation" },
      conversion: {
        items: [],
        valueCents: 1000,
        currency: "BRL",
        matchedTriggerPhrase: null,
        observedPaymentValueCents: null,
        contentName: null,
      },
    },
  } as never;
}

function orchestratorHarness() {
  const claims: any[] = [];
  const executions = new Map<string, any>();
  const prisma: any = {
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    providerPurchaseClaim: {
      findUnique: vi.fn(async ({ where }: any) => {
        const key = where.workspaceId_effectMode_purchaseKey;
        return (
          claims.find(
            (claim) =>
              claim.workspaceId === key.workspaceId &&
              claim.effectMode === key.effectMode &&
              claim.purchaseKey === key.purchaseKey,
          ) ?? null
        );
      }),
      create: vi.fn(async ({ data }: any) => {
        claims.push(data);
        return data;
      }),
    },
    providerConversionRuleExecution: {
      findUnique: vi.fn(async ({ where }: any) => {
        const key = where.providerRuleId_externalExecutionKey;
        return executions.get(key.externalExecutionKey) ?? null;
      }),
      upsert: vi.fn(async ({ where, create }: any) => {
        const key = where.providerRuleId_externalExecutionKey.externalExecutionKey;
        const row = { id: `exec-${key}`, status: create.status, providerDecisionId: create.providerDecisionId };
        executions.set(key, row);
        return { id: row.id, status: row.status };
      }),
    },
  };
  return {
    claims,
    prisma,
    orchestrator: new ProviderConversionOrchestrator(prisma),
  };
}

describe("ProviderPurchaseClaim (observation): one winner per sale", () => {
  it("keeps the first delivery of a sale and reports the next ones as duplicates", async () => {
    const h = orchestratorHarness();
    const first = await h.orchestrator.orchestrate({
      persistedDecision: persisted("occ-1"),
      disposition: { state: "observed", reasonCode: "observed" },
    });
    expect(first).toMatchObject({ executionId: "exec-occ-1" });
    expect(first).not.toHaveProperty("purchaseDuplicate");
    expect(h.claims).toEqual([
      expect.objectContaining({ effectMode: "observation", purchaseKey, winnerExecutionId: "exec-occ-1" }),
    ]);
    const second = await h.orchestrator.orchestrate({
      persistedDecision: persisted("occ-2"),
      disposition: { state: "observed", reasonCode: "observed" },
    });
    expect(second).toEqual({
      executionId: "exec-occ-1",
      eligibleExecutionId: null,
      reviewId: null,
      purchaseDuplicate: true,
    });
    expect(h.claims).toHaveLength(1);
  });

  it("leaves decisions without a sale identity (all current providers) on the existing path", async () => {
    const h = orchestratorHarness();
    const result = await h.orchestrator.orchestrate({
      persistedDecision: persisted("occ-3", { provider: "umbler", purchaseKey: undefined }),
      disposition: { state: "observed", reasonCode: "observed" },
    });
    expect(result.executionId).toBe("exec-occ-3");
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.prisma.providerPurchaseClaim.create).not.toHaveBeenCalled();
  });
});

describe("Paid lead resolver", () => {
  const lead = (overrides: Record<string, unknown>) => ({
    id: "lead1",
    phoneHash: hashPhoneIdentity("5582999312477")!,
    campaignId: "c",
    adSetId: "s",
    adId: "123",
    ctwaClid: "clid",
    ...overrides,
  });
  const resolver = (rows: (hashes: string[]) => unknown[]) => {
    const findMany = vi.fn(async ({ where }: any) =>
      rows(typeof where.phoneHash === "string" ? [where.phoneHash] : where.phoneHash.in),
    );
    return {
      findMany,
      resolver: new ProviderConversionPaidLeadResolver({ lead: { findMany } } as never),
    };
  };

  it("never resolves a lead without ctwa_clid (nothing is sent)", async () => {
    for (const ctwaClid of [null, "", "  "]) {
      const { resolver: r } = resolver(() => [lead({ ctwaClid })]);
      expect(
        await r.resolve({ workspaceId: "ws1", phone: "5582999312477", ctwaProofAnyChannel: true }),
      ).toEqual({ status: "not_found", reasonCode: "paid_attribution_missing", candidateLeadId: "lead1" });
    }
  });

  it("keeps the ad-attributed lead unchanged and asks no CTWA proof for current providers", async () => {
    const { resolver: r } = resolver(() => [lead({})]);
    expect(await r.resolve({ workspaceId: "ws1", phone: "5582999312477" })).toEqual({
      status: "resolved",
      reasonCode: "paid_lead_resolved",
      lead: lead({}),
    });
    const noAd = resolver(() => [lead({ adId: null })]);
    expect(await noAd.resolver.resolve({ workspaceId: "ws1", phone: "5582999312477" })).toMatchObject({
      status: "not_found",
      reasonCode: "paid_attribution_missing",
    });
  });

  it("matches exact forms first, then the equivalent Brazilian 55 / 9th-digit forms", async () => {
    const stored = hashNormalizedPhone("558299312477")!; // without the 9th digit
    const { resolver: r, findMany } = resolver((hashes) =>
      hashes.includes(stored) ? [lead({ phoneHash: stored })] : [],
    );
    const resolution = await r.resolve({ workspaceId: "ws1", phone: "82 99931-2477" });
    expect(resolution.status).toBe("resolved");
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(hashPhoneIdentityVariants(["82 99931-2477"])).toContain(stored);
    const exact = resolver(() => [lead({})]);
    await exact.resolver.resolve({ workspaceId: "ws1", phone: "5582999312477" });
    expect(exact.findMany).toHaveBeenCalledTimes(1);
  });
});

function productionService(prisma: any, enqueueSend = vi.fn(async () => undefined)) {
  return new ProviderConversionProductionService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    { previewRoute: vi.fn() } as never,
    {} as never,
    { enqueueSend } as never,
    {
      INBOUND_WEBHOOKS_ENABLED: "true",
      INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
      INBOUND_CONVERSION_RULES_ENABLED: "true",
      INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
      API_PUBLIC_URL: "https://api.example.test",
      INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    },
  );
}

describe("Provider conversion production (purchase claim and CTWA guards)", () => {
  const frozen = (lead: Record<string, unknown>, occurrence: Record<string, unknown> = {}) => ({
    decisionCode: "eligible",
    leadResolution: {
      status: "resolved",
      lead: { id: "lead1", phoneHash: "hash", campaignId: null, adSetId: null, ...lead },
    },
    occurrence: {
      provider: "umbler",
      eventName: "Purchase",
      occurredAt: new Date().toISOString(),
      businessDedupePolicy: { mode: "rolling_window", scopeKey: "k", windowSeconds: 86400 },
      ...occurrence,
    },
    conversion: { valueCents: 1000, currency: "BRL", contentName: null, items: [] },
    rule: { triggerType: "provider_automation" },
  });
  const execution = { id: "exec1", workspaceId: "ws1", channelId: "ch1" };

  it("fails closed when a non-Payt provider claims a sale identity (only Payt can verify sales)", async () => {
    const service = productionService({});
    await expect(
      (service as any).materializeFrozenDecision(
        execution,
        frozen({ adId: "123", ctwaClid: "clid" }, { purchaseKey }),
      ),
    ).rejects.toMatchObject({ code: "provider_purchase_identity_missing" });
  });

  it("never materializes a lead without ctwa_clid or without ad id and CTWA proof", async () => {
    const prisma = { $transaction: vi.fn() };
    const service = productionService(prisma);
    for (const lead of [
      { adId: "123", ctwaClid: "" },
      { adId: null, ctwaClid: "clid" },
      { adId: null, ctwaClid: null },
    ]) {
      const failure = await (service as any)
        .materializeFrozenDecision(execution, frozen(lead))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderConversionProductionFailure);
      expect((failure as ProviderConversionProductionFailure).code).toBe(
        "provider_conversion_paid_lead_missing",
      );
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("recovers the purchase send outbox and leaves refused CTWA sends to the owner", async () => {
    const claims = [
      { id: "c1", workspaceId: "ws1", conversionEventLogId: "log-ready" },
      { id: "c2", workspaceId: "ws1", conversionEventLogId: "log-skipped" },
    ];
    const logs: Record<string, any> = {
      "log-ready": { status: "ready_to_send", errorCode: null },
      "log-skipped": { status: "ready_to_send", errorCode: CTWA_SEND_SKIPPED_ERROR_CODE },
    };
    const updates: any[] = [];
    const prisma = {
      providerPurchaseClaim: {
        findMany: vi.fn(async () => claims),
        updateMany: vi.fn(async (args: any) => {
          updates.push(args);
          return { count: 1 };
        }),
      },
      conversionEventLog: {
        findFirst: vi.fn(async ({ where }: any) => logs[where.id] ?? null),
      },
    };
    const enqueueSend = vi.fn(async () => undefined);
    const service = productionService(prisma, enqueueSend);
    expect(await service.recoverPurchaseOutbox()).toBe(1);
    expect(enqueueSend).toHaveBeenCalledWith("log-ready", "ws1");
    expect(updates).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({ id: "c2" }),
        data: { outboxPending: false },
      }),
    );
  });
});
