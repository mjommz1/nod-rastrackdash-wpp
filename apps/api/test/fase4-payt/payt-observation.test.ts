import { describe, expect, it, vi } from "vitest";
import type { ProviderConversionDecisionDto } from "@wpptrack/shared";
import { hashPhoneIdentity } from "../../src/common/phone/phone-identity";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import { ProviderConversionObservationService } from "../../src/conversion-rules/provider-conversion-observation.service";
import { ProviderConversionOrchestrator } from "../../src/conversion-rules/provider-conversion-orchestrator.service";
import { ProviderConversionPaidLeadResolver } from "../../src/conversion-rules/provider-conversion-paid-lead-resolver.service";
import { buildProviderPurchaseIdentity } from "../../src/conversion-rules/provider-purchase-identity";
import {
  parsePaytAutomationV1,
  parsePaytSaleEventV1,
  type ParsedPaytAutomationV1,
} from "../../src/inbound-webhooks/providers/payt/payt-automation-v1.parser";
import { paytFixture } from "./payt-ingestion-harness";

/**
 * Payt sale -> decision with the real paid-lead resolver, purchase routing,
 * canonical decision engine and orchestrator (purchase claim). Only storage is
 * in memory. Phones and identifiers are synthetic.
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

function world(
  options: {
    mode?: "observation" | "production";
    eventName?: "Purchase" | "InitiateCheckout" | "CartAbandoned";
    lead?: { adId: string | null; ctwaClid: string | null } | null;
    /** Channel where the lead's CTWA entry was materialized. */
    entryChannelId?: string;
    engineMode?: "legacy" | "shadow" | "canonical";
  } = {},
) {
  const mode = options.mode ?? "observation";
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
    conversionEngineMode: options.engineMode ?? "canonical",
  };
  const rule = {
    id: "provider_rule_payt",
    workspaceId,
    conversionRuleId: "rule_payt",
    connectionId: "connection_wa",
    parserReleaseId: "inbound_parser_payt_automation-v1",
    scope: "specific_numbers",
    mode,
    productionActivatedAt: mode === "production" ? activatedAt : null,
    removedAt: null,
    messageAuthorScope: null,
    messageTriggerPhrases: [] as string[],
    unifiedIntoProviderRuleId: null,
    createdAt: activatedAt,
    updatedAt: activatedAt,
    conversionRule: {
      id: "rule_payt",
      triggerType: "provider_automation",
      eventName: options.eventName ?? "Purchase",
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
    channels: [{ channelId: channel.id, channel }],
    catalog: null,
  };
  const lead =
    options.lead === null
      ? null
      : {
          id: "lead_1",
          phoneHash: buyerHash,
          campaignId: "campaign_1",
          adSetId: "adset_1",
          adId: options.lead?.adId === undefined ? "ad_1" : options.lead.adId,
          ctwaClid:
            options.lead?.ctwaClid === undefined
              ? "ctwa_1"
              : options.lead.ctwaClid,
        };
  const entryChannelId = options.entryChannelId ?? channel.id;
  const claims: any[] = [];
  const executions = new Map<string, any>();
  const recorded: ProviderConversionDecisionDto[] = [];
  const persistedDecisions = new Map<string, any>();
  const prisma: any = {
    $queryRaw: vi.fn(async () => []),
    providerConversionRuleConfig: {
      findFirst: vi.fn(async () => rule),
      findMany: vi.fn(async () => []),
    },
    lead: {
      findMany: vi.fn(async ({ where }: any) => {
        const hashes: string[] =
          typeof where.phoneHash === "string"
            ? [where.phoneHash]
            : where.phoneHash.in;
        return lead && hashes.includes(lead.phoneHash) ? [lead] : [];
      }),
    },
    // Materialized LeadSubmitted of the CTWA entry (purchase routing proof).
    conversionEventLog: {
      findMany: vi.fn(async ({ where }: any) =>
        lead &&
        where.leadId === lead.id &&
        where.adId === lead.adId &&
        where.ctwaClid === lead.ctwaClid
          ? [
              {
                id: "log_entry",
                sourcePayload: {
                  inboundEventId: "event_entry",
                  channelId: entryChannelId,
                  connectionId: "connection_wa",
                },
              },
            ]
          : [],
      ),
    },
    inboundWebhookEvent: {
      findMany: vi.fn(async ({ where }: any) =>
        where.channelId.in.includes(entryChannelId)
          ? [{ channel: { ...channel, id: entryChannelId } }]
          : [],
      ),
    },
    inboundWebhookChannel: {
      findMany: vi.fn(async ({ where }: any) =>
        where.id?.notIn
          ? [{ id: "channel_2" }].filter(
              (candidate) => !where.id.notIn.includes(candidate.id),
            )
          : [channel],
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
        return executions.get(key.externalExecutionKey) ?? null;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.providerRuleId_externalExecutionKey.externalExecutionKey;
        const row = executions.get(key)
          ? { ...executions.get(key), ...update }
          : { id: `execution_${executions.size + 1}`, ...create };
        executions.set(key, row);
        return { id: row.id, status: row.status };
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => data) },
  };
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  const decisions = {
    findLatestByOccurrence: vi.fn(
      async ({ occurrenceKey }: any) => persistedDecisions.get(occurrenceKey) ?? null,
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
        persistedDecisions.set(persisted.occurrenceKey, persisted);
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
  return { service, prisma, claims, executions, recorded, decisions };
}

function sale(
  name = "order-paid.sanitized.json",
  eventName: "Purchase" | "InitiateCheckout" | "CartAbandoned" = "Purchase",
): ParsedPaytAutomationV1 {
  const payload = paytFixture(name);
  const parsed =
    eventName === "Purchase"
      ? parsePaytAutomationV1(payload)
      : parsePaytSaleEventV1(payload);
  if (!parsed.ok) throw new Error(parsed.errorCode);
  return parsed.value;
}

function observe(
  w: ReturnType<typeof world>,
  automation: ParsedPaytAutomationV1,
  deliveryId = "delivery_1",
) {
  return w.service.observeAutomation({
    workspaceId,
    connectionId: "connection_wa",
    deliveryId,
    externalDeliveryId: automation.externalExecutionKey,
    deliveryReceivedAt: receivedAt,
    providerRuleId: "provider_rule_payt",
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

describe("Payt sale without ctwa_clid: nothing is decided or sent", () => {
  it.each([
    ["a tracked lead without ctwa_clid", { adId: "ad_1", ctwaClid: null }],
    ["a lead without ctwa_clid nor ad id", { adId: null, ctwaClid: null }],
    ["no tracked lead at all", null],
  ] as const)("%s stays blocked before any decision", async (_label, lead) => {
    const w = world({ mode: "production", lead });

    const result = await observe(w, sale());

    expect(result).toMatchObject({
      decisionId: null,
      reasonCode: "payt_channel_missing_or_ambiguous",
      disposition: "blocked",
      executionId: null,
      eligibleExecutionId: null,
      leadResolved: false,
    });
    expect(w.decisions.recordInitial).not.toHaveBeenCalled();
    expect(w.executions.size).toBe(0);
    expect(w.claims).toHaveLength(0);
  });
});

describe("Payt sale of a tracked CTWA lead", () => {
  it("decides with the value of the postback on the channel of the lead's CTWA entry", async () => {
    const w = world();

    const result = await observe(w, sale());

    expect(result).toMatchObject({
      decisionCode: "eligible",
      disposition: "observed",
      channelId: "channel_1",
      leadResolved: true,
    });
    expect(w.recorded[0]).toMatchObject({
      occurrence: {
        provider: "payt",
        purchaseKey,
        occurrenceKey: purchaseKey,
        eventName: "Purchase",
      },
      conversion: { valueCents: 233331, currency: "BRL" },
      leadResolution: {
        status: "resolved",
        lead: { adId: "ad_1", ctwaClid: "ctwa_1" },
      },
    });
    // The phone is only a candidate: the routing asked for the materialized
    // CTWA entry of this lead, ad and click.
    expect(w.prisma.conversionEventLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          leadId: "lead_1",
          adId: "ad_1",
          ctwaClid: "ctwa_1",
          eventName: "LeadSubmitted",
        }),
      }),
    );
  });

  it("keeps one winner per sale: the same postback delivered again is a duplicate", async () => {
    const w = world();

    const first = await observe(w, sale(), "delivery_1");
    const again = await observe(w, sale(), "delivery_2");

    expect(first.disposition).toBe("observed");
    expect(again).toMatchObject({
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
    expect(w.executions.size).toBe(1);
  });

  it("makes one production execution for the sale however many times it arrives", async () => {
    const w = world({ mode: "production" });

    const first = await observe(w, sale(), "delivery_1");
    const again = await observe(w, sale(), "delivery_2");

    expect(first).toMatchObject({
      disposition: "eligible",
      eligibleExecutionId: "execution_1",
    });
    expect(again.eligibleExecutionId).toBe("execution_1");
    expect(w.executions.size).toBe(1);
    expect([...w.executions.values()][0]).toMatchObject({
      status: "eligible",
      externalExecutionKey: purchaseKey,
      valueCents: 233331,
    });
  });

  it("keeps a sale audit-only on a channel outside the canonical engine", async () => {
    const w = world({ mode: "production", engineMode: "legacy" });

    const result = await observe(w, sale());

    expect(result.disposition).toBe("observed");
    expect(result.eligibleExecutionId).toBeNull();
    expect([...w.executions.values()][0]).toMatchObject({
      status: "observed",
      reasonCode: "automation_matched_payt_observation",
    });
  });

  it("leaves a sale whose lead entered by another number to that number's rule", async () => {
    const w = world({ mode: "production", entryChannelId: "channel_2" });

    const result = await observe(w, sale());

    expect(result).toMatchObject({
      reasonCode: "payt_lead_other_channel",
      disposition: "ignored",
      decisionId: null,
      leadResolved: true,
    });
    expect(w.executions.size).toBe(0);
  });

  it("decides Pix/boleto gerado as InitiateCheckout with its own sale identity", async () => {
    const w = world({ eventName: "InitiateCheckout" });

    const result = await observe(
      w,
      sale("order-nonpaid.sanitized.json", "InitiateCheckout"),
    );

    expect(result.decisionCode).toBe("eligible");
    expect(w.recorded[0]).toMatchObject({
      occurrence: {
        eventName: "InitiateCheckout",
        purchaseKey: buildProviderPurchaseIdentity({
          workspaceId,
          provider: "payt",
          accountRef: "455QA2",
          orderRef: "PAYTS2",
          eventName: "InitiateCheckout",
        }),
      },
      conversion: { valueCents: 233331, currency: "BRL" },
    });
  });
});
