import { describe, expect, it, vi } from "vitest";
import type { ProviderConversionDecisionDto } from "@wpptrack/shared";
import { hashPhoneIdentity } from "../../src/common/phone/phone-identity";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import {
  PAYT_PRODUCT_NOT_IN_RULE_REASON,
  ProviderConversionObservationService,
} from "../../src/conversion-rules/provider-conversion-observation.service";
import { ProviderConversionOrchestrator } from "../../src/conversion-rules/provider-conversion-orchestrator.service";
import { ProviderConversionPaidLeadResolver } from "../../src/conversion-rules/provider-conversion-paid-lead-resolver.service";
import { buildProviderPurchaseIdentity } from "../../src/conversion-rules/provider-purchase-identity";
import {
  parsePaytAutomationV1,
  paytProductFilterMatches,
  type ParsedPaytAutomationV1,
} from "../../src/inbound-webhooks/providers/payt/payt-automation-v1.parser";
import { paytFixture } from "../fase4-payt/payt-ingestion-harness";

/**
 * Fase 5.3 — the two Payt risks that live in the decision, with the real
 * paid-lead resolver, purchase routing, decision engine and orchestrator
 * (durable purchase claim). Only storage is in memory; synthetic data.
 *
 * - Double send: the same sale evaluated by two rules (the old URL of one,
 *   the URL única routed to the other) has ONE winner and ONE execution.
 * - Product filter: a rule limited to some products ignores the others with
 *   its own reason, and never silences the global rule for them.
 */
const workspaceId = "workspace_safe";
const activatedAt = new Date("2024-11-01T00:00:00.000Z");
const receivedAt = new Date("2024-11-22T15:21:00.000Z");
const env = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "http://localhost:3333",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};
const buyerHash = hashPhoneIdentity("5511999999999")!;

type RuleOptions = {
  id: string;
  scope: "all_numbers" | "specific_numbers";
  productFilterCodes?: string[];
};

function world(rulesInput: RuleOptions[], mode: "observation" | "production") {
  const certified = (provider: string, version: string) => ({
    id: `inbound_parser_${provider}_${version}`,
    provider,
    version,
    status: "certified",
    certifiedByUserId: null,
    certifiedAt: activatedAt,
    createdAt: activatedAt,
    updatedAt: activatedAt,
  });
  const channel = {
    id: "channel_1",
    organizationId: "org_1",
    providerChannelId: "provider_channel_1",
    status: "active",
    productionActivatedAt: activatedAt,
    conversionEngineMode: "canonical",
  };
  const rules = rulesInput.map((input) => ({
    id: input.id,
    workspaceId,
    conversionRuleId: `rule_${input.id}`,
    connectionId: "connection_wa",
    parserReleaseId: "inbound_parser_payt_automation-v1",
    scope: input.scope,
    mode,
    productionActivatedAt: mode === "production" ? activatedAt : null,
    removedAt: null,
    messageAuthorScope: null,
    messageTriggerPhrases: [] as string[],
    productFilterCodes: input.productFilterCodes ?? [],
    unifiedIntoProviderRuleId: null,
    createdAt: activatedAt,
    updatedAt: activatedAt,
    conversionRule: {
      id: `rule_${input.id}`,
      triggerType: "provider_automation",
      eventName: "Purchase",
      active: true,
      defaultValueCents: null,
      defaultCurrency: "BRL",
      defaultContentName: null,
      defaultItems: null,
      updatedAt: activatedAt,
    },
    connection: {
      id: "connection_wa",
      provider: "uazapi",
      status: mode === "production" ? "production" : "observation",
      removedAt: null,
      parserReleaseId: "inbound_parser_uazapi_v1",
      parserRelease: certified("uazapi", "v1"),
    },
    parserRelease: certified("payt", "automation-v1"),
    channels:
      input.scope === "specific_numbers"
        ? [{ channelId: channel.id, channel }]
        : [],
    catalog: null,
  }));
  const lead = {
    id: "lead_1",
    phoneHash: buyerHash,
    campaignId: "campaign_1",
    adSetId: "adset_1",
    adId: "ad_1",
    ctwaClid: "ctwa_1",
  };
  const claims: any[] = [];
  // Executions are unique per rule + occurrence, as in the database.
  const executions = new Map<string, any>();
  const recorded: ProviderConversionDecisionDto[] = [];
  const persistedDecisions = new Map<string, any>();
  const prisma: any = {
    $queryRaw: vi.fn(async () => []),
    providerConversionRuleConfig: {
      findFirst: vi.fn(
        async ({ where }: any) =>
          rules.find((rule) => rule.id === where.id) ?? null,
      ),
      findMany: vi.fn(async ({ where }: any) =>
        where.id?.in
          ? rules
              .filter((rule) => where.id.in.includes(rule.id))
              .map((rule) => ({
                id: rule.id,
                productFilterCodes: rule.productFilterCodes,
              }))
          : rules.filter((rule) => rule.scope === "specific_numbers"),
      ),
    },
    lead: {
      findMany: vi.fn(async ({ where }: any) => {
        const hashes: string[] =
          typeof where.phoneHash === "string"
            ? [where.phoneHash]
            : where.phoneHash.in;
        return hashes.includes(lead.phoneHash) ? [lead] : [];
      }),
    },
    conversionEventLog: {
      findMany: vi.fn(async ({ where }: any) =>
        where.leadId === lead.id &&
        where.adId === lead.adId &&
        where.ctwaClid === lead.ctwaClid
          ? [
              {
                id: "log_entry",
                sourcePayload: {
                  inboundEventId: "event_entry",
                  channelId: channel.id,
                  connectionId: "connection_wa",
                },
              },
            ]
          : [],
      ),
    },
    inboundWebhookEvent: {
      findMany: vi.fn(async ({ where }: any) =>
        where.channelId?.in?.includes(channel.id) ? [{ channel }] : [],
      ),
    },
    inboundWebhookChannel: {
      findMany: vi.fn(async ({ where }: any) =>
        where.id?.notIn
          ? []
          : [
              {
                ...channel,
                connectionId: "connection_wa",
                createdAt: activatedAt,
                connectedPhone: "5511900001020",
                connection: { provider: "uazapi", status: mode },
              },
            ],
      ),
      findFirst: vi.fn(async () => null),
    },
    providerPurchaseClaim: {
      findUnique: vi.fn(async ({ where }: any) => {
        const key = where.workspaceId_effectMode_purchaseKey;
        return (
          claims.find(
            (claim) =>
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
        return (
          executions.get(`${key.providerRuleId}|${key.externalExecutionKey}`) ??
          null
        );
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.providerRuleId_externalExecutionKey;
        const mapKey = `${key.providerRuleId}|${key.externalExecutionKey}`;
        const row = executions.get(mapKey)
          ? { ...executions.get(mapKey), ...update }
          : { id: `execution_${executions.size + 1}`, ...create };
        executions.set(mapKey, row);
        return { id: row.id, status: row.status };
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => data) },
  };
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  const decisions = {
    findLatestByOccurrence: vi.fn(
      async ({ providerRuleId, occurrenceKey }: any) =>
        persistedDecisions.get(`${providerRuleId}|${occurrenceKey}`) ?? null,
    ),
    recordInitial: vi.fn(
      async ({
        decision,
        sourceDeliveryId,
      }: {
        decision: ProviderConversionDecisionDto;
        sourceDeliveryId: string;
      }) => {
        recorded.push(decision);
        const persisted = {
          id: `decision_${recorded.length}`,
          decisionVersion: 1,
          workspaceId,
          providerRuleId: decision.rule.providerRuleId,
          sourceDeliveryId,
          channelId: decision.occurrence.channelId,
          leadId:
            decision.leadResolution.status === "resolved"
              ? decision.leadResolution.lead.id
              : null,
          occurredAt: new Date(decision.occurrence.occurredAt),
          decision,
          decisionCode: decision.decisionCode,
          reasonCode: decision.reasonCode,
          occurrenceKey: decision.occurrence.occurrenceKey,
          created: true,
        };
        persistedDecisions.set(
          `${persisted.providerRuleId}|${persisted.occurrenceKey}`,
          persisted,
        );
        return persisted;
      },
    ),
    appendReevaluation: vi.fn(),
  };
  const engine = new ProviderConversionDecisionEngine();
  const service = new ProviderConversionObservationService(
    prisma,
    {
      evaluate: vi.fn(async ({ decisionInput }: any) =>
        engine.evaluate(decisionInput),
      ),
    } as never,
    decisions as never,
    new ProviderConversionPaidLeadResolver(prisma),
    new ProviderConversionOrchestrator(prisma),
    env,
  );
  return { service, claims, executions, recorded };
}

function sale(productCode?: string): ParsedPaytAutomationV1 {
  const payload = paytFixture("order-paid.sanitized.json");
  if (productCode) payload.product = { ...payload.product, code: productCode };
  const parsed = parsePaytAutomationV1(payload);
  if (!parsed.ok) throw new Error(parsed.errorCode);
  return parsed.value;
}

function observe(
  w: ReturnType<typeof world>,
  providerRuleId: string,
  automation: ParsedPaytAutomationV1,
  deliveryId: string,
) {
  return w.service.observeAutomation({
    workspaceId,
    connectionId: "connection_wa",
    deliveryId,
    externalDeliveryId: automation.externalExecutionKey,
    deliveryReceivedAt: receivedAt,
    providerRuleId,
    automation,
  });
}

const purchaseKey = buildProviderPurchaseIdentity({
  workspaceId,
  provider: "payt",
  accountRef: "455QA2",
  orderRef: "PAYTS2",
  eventName: "Purchase",
});

describe("Double send between the old URL and the URL única (Payt)", () => {
  // Old URL of rule A still posting, URL única routing to rule B: both are
  // specific rules of the same number (e.g. one created for the new URL while
  // the old one was not disabled yet).
  const twoRules: RuleOptions[] = [
    { id: "rule_old_url", scope: "specific_numbers" },
    { id: "rule_new_url", scope: "specific_numbers" },
  ];

  it("observation: one sale reaching two rules has ONE durable winner", async () => {
    const w = world(twoRules, "observation");
    const first = await observe(w, "rule_old_url", sale(), "delivery_old");
    const second = await observe(w, "rule_new_url", sale(), "delivery_new");
    expect(first).toMatchObject({ disposition: "observed" });
    expect(second).toMatchObject({
      reasonCode: "purchase_duplicate",
      disposition: "ignored",
      executionId: first.executionId,
    });
    expect(w.claims).toEqual([
      expect.objectContaining({
        effectMode: "observation",
        purchaseKey,
        winnerExecutionId: first.executionId,
      }),
    ]);
  });

  it("production: both executions carry the SAME sale key, the claim/dedupe key of the one send", async () => {
    // In production the durable winner is taken when the conversion is
    // materialized (ProviderPurchaseClaim effectMode=production, and the
    // conversion dedupeKey is the sale key itself): the second execution
    // becomes "purchase_duplicate" there (fase4-ctwa purchase claim tests and
    // the .pg test of this phase prove the unique keys).
    const w = world(twoRules, "production");
    const first = await observe(w, "rule_old_url", sale(), "delivery_old");
    const second = await observe(w, "rule_new_url", sale(), "delivery_new");
    expect(first.disposition).toBe("eligible");
    expect(second.disposition).toBe("eligible");
    const keys = new Set(
      [...w.executions.values()].map(
        (execution) => execution.externalExecutionKey,
      ),
    );
    expect([...keys]).toEqual([purchaseKey]);
    expect(w.recorded.map((decision) => decision.occurrence.purchaseKey)).toEqual(
      [purchaseKey, purchaseKey],
    );
  });

  it("the global rule yields to the specific rule of the number, so only one of them decides the sale", async () => {
    const w = world(
      [
        { id: "rule_global", scope: "all_numbers" },
        { id: "rule_specific", scope: "specific_numbers" },
      ],
      "observation",
    );
    const global = await observe(w, "rule_global", sale(), "delivery_global");
    const specific = await observe(w, "rule_specific", sale(), "delivery_specific");
    expect(global).toMatchObject({
      reasonCode: "overridden_by_specific_rule",
      disposition: "ignored",
    });
    expect(specific).toMatchObject({ disposition: "observed" });
    expect(w.claims).toHaveLength(1);
  });
});

describe("Product filter discarding sales (Payt)", () => {
  it("ignores a sale of another product with its own reason, before any decision", async () => {
    const w = world(
      [{ id: "rule_a", scope: "specific_numbers", productFilterCodes: ["PRODA"] }],
      "production",
    );
    const result = await observe(w, "rule_a", sale("PRODB"), "delivery_b");
    expect(result).toMatchObject({
      reasonCode: PAYT_PRODUCT_NOT_IN_RULE_REASON,
      disposition: "ignored",
      decisionId: null,
      executionId: null,
    });
    expect(w.recorded).toHaveLength(0);
    expect(w.claims).toHaveLength(0);
  });

  it("accepts the filtered product case-insensitively", async () => {
    const w = world(
      [{ id: "rule_a", scope: "specific_numbers", productFilterCodes: ["proda"] }],
      "production",
    );
    const result = await observe(w, "rule_a", sale("PRODA"), "delivery_a");
    expect(result.disposition).toBe("eligible");
  });

  it("a specific rule limited to product A never silences the global rule for product B", async () => {
    const w = world(
      [
        { id: "rule_global", scope: "all_numbers" },
        {
          id: "rule_specific_a",
          scope: "specific_numbers",
          productFilterCodes: ["PRODA"],
        },
      ],
      "production",
    );
    const productB = await observe(w, "rule_global", sale("PRODB"), "delivery_b");
    expect(productB.disposition).toBe("eligible");
  });

  it("matches by product or offer code; an empty filter accepts everything", () => {
    expect(paytProductFilterMatches([], ["X"])).toBe(true);
    expect(paytProductFilterMatches(null, [])).toBe(true);
    expect(paytProductFilterMatches(["ofr1"], ["PROD1", "OFR1"])).toBe(true);
    expect(paytProductFilterMatches(["PRODA"], [])).toBe(false);
    expect(paytProductFilterMatches(["PRODA"], ["PRODB"])).toBe(false);
  });
});
