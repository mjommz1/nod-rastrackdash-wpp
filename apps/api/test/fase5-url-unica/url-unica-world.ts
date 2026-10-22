import { createHash } from "node:crypto";
import { vi } from "vitest";
import { hashPhoneIdentity } from "../../src/common/phone/phone-identity";
import { InboundConversionAutomationIngestionService } from "../../src/inbound-webhooks/inbound-conversion-automation-ingestion.service";
import { InboundWebhookPayloadEncryptionService } from "../../src/inbound-webhooks/inbound-webhook-payload-encryption.service";
import { IntegrationEndpointsService } from "../../src/inbound-webhooks/integration-endpoints.service";

/**
 * Fase 5.3 — in-memory world for the URL única (Payt) and the URLs por
 * evento (Unnichat/Umbler), ported from the SaaS (`integration-endpoints.test`)
 * and adapted to this edition (no billing access service; the license lock is
 * the global HTTP guard, covered by the .http test). Real router, real
 * ingestion of both URLs and real payload encryption; storage, paid-lead
 * resolution and the decision pipeline are fakes. Synthetic data only.
 */

export const W = "workspace_jean";
export const OTHER_WORKSPACE = "workspace_other";
export const oldToken = "old-rule-token";
const oldTokenHash = createHash("sha256").update(oldToken).digest("hex");
export const at = new Date("2026-10-19T12:00:00.000Z");

function env(production = false) {
  return {
    NODE_ENV: "test",
    API_PUBLIC_URL: "https://api.example.test",
    INBOUND_WEBHOOKS_ENABLED: "true",
    INBOUND_WEBHOOK_PRODUCTION_ENABLED: String(production),
    INBOUND_CONVERSION_RULES_ENABLED: "true",
    INBOUND_CONVERSION_PRODUCTION_ENABLED: String(production),
    INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 41).toString("base64"),
  };
}

export type Provider = "payt" | "unnichat" | "umbler";
export type Channel = {
  id: string;
  connectionId: string;
  provider: string;
  phone: string;
};
export type Rule = {
  id: string;
  provider: Provider;
  eventName: string;
  scope: "all_numbers" | "specific_numbers";
  connectionId: string;
  channelIds: string[];
  productFilterCodes?: string[];
  createdAt?: Date;
  mode?: "observation" | "production";
  publicUrlDisabledAt?: Date | null;
};
export type Lead = {
  phone: string;
  id: string;
  /** Channel of the lead's CTWA entry proof (no ad id). */
  entryChannelId: string;
  ctwaClid: string;
  /** Ad lead: its ad id and the numbers with a materialized ad entry. */
  adId?: string;
  adEntries?: string[];
};

export function paytSale(input: {
  status?: string;
  type?: string;
  order?: string;
  phone?: string;
  product?: string;
  totalCents?: number;
}) {
  return {
    seller_id: "SELLER-1",
    transaction_id: input.order ?? "ORDER-1",
    cart_id: "CART-1",
    status: input.status ?? "paid",
    type: input.type ?? "order",
    customer: { phone: input.phone ?? "11991231020" },
    product: { code: input.product ?? "PROD1", name: "Mentoria", price: 9900 },
    link: { title: "Oferta principal", url: "https://payt.site/OFR1" },
    transaction: {
      payment_status: input.status ?? "paid",
      total_price: input.totalCents ?? 19700,
      created_at: "2026-10-19 11:59:00",
      paid_at: "2026-10-19 11:59:30",
    },
  };
}

export function unnichatMovement(input: {
  phone: string;
  ctwaClid: string | null;
  externalId?: string;
}) {
  return {
    event: "lead.stage_changed",
    event_name: "Lead",
    phone: input.phone,
    external_id: input.externalId ?? `movement-${input.phone}`,
    ctwa_clid: input.ctwaClid,
    source_type: "paid",
    lead_source: "meta_ads",
    source: "unnichat",
    channel: "whatsapp",
    origin: "funil",
  };
}

export function umblerAutomation(
  automation: "lead_qualificado" | "compra_aprovada",
  phone = "5511977775520",
) {
  return {
    schema: "wpptrack.umbler.automation.v1",
    source: "umbler_tag_automation",
    automation,
    contact: { phone },
    conversation: { id: `conv-${phone}`, created_at_utc: "2026-10-19 11:00:00" },
  };
}

export function world(options: {
  channels: Channel[];
  rules: Rule[];
  leads?: Lead[];
  production?: boolean;
  /** Last inbound message (Umbler) per phone -> channel. */
  lastMessages?: Array<{ phone: string; channelId: string }>;
}) {
  const runtime = env(options.production);
  const encryption = new InboundWebhookPayloadEncryptionService(runtime);
  const parserRelease = (provider: string) => ({
    id: `parser_${provider}_automation_v1`,
    provider,
    version: "automation-v1",
    status: "certified",
  });
  const connections = new Map<string, any>();
  for (const channel of options.channels) {
    connections.set(channel.connectionId, {
      id: channel.connectionId,
      workspaceId: W,
      provider: channel.provider,
      status: options.production ? "production" : "observation",
      removedAt: null,
      parserReleaseId: `parser_${channel.provider}_v1`,
      parserRelease: {
        id: "x",
        provider: channel.provider,
        version: "v1",
        status: "certified",
      },
    });
  }
  const endpoints = new Map<string, any>();
  const rules: any[] = [];
  function addRule(rule: Rule, index = rules.length) {
    const createdAt =
      rule.createdAt ?? new Date(at.getTime() - (100 - index) * 1000);
    const record: any = {
      id: rule.id,
      workspaceId: W,
      scope: rule.scope,
      connectionId: rule.connectionId,
      parserReleaseId: `parser_${rule.provider}_automation_v1`,
      mode: rule.mode ?? (options.production ? "production" : "observation"),
      productionActivatedAt: options.production
        ? new Date(at.getTime() - 86_400_000)
        : null,
      removedAt: null,
      createdAt,
      productFilterCodes: rule.productFilterCodes ?? [],
      conversionRule: {
        id: `conversion_${rule.id}`,
        name: `Regra ${rule.id}`,
        triggerType: "provider_automation",
        eventName: rule.eventName,
        active: true,
        defaultValueCents: null,
        defaultCurrency: null,
      },
      connection: connections.get(rule.connectionId),
      parserRelease: parserRelease(rule.provider),
      channels: rule.channelIds.map((channelId) => ({
        channelId,
        channel: {
          id: channelId,
          status: "active",
          productionActivatedAt: at,
          conversionEngineMode: "canonical",
        },
      })),
    };
    const endpoint = {
      id: `endpoint_${rule.id}`,
      workspaceId: W,
      providerRuleId: rule.id,
      secretHash: oldTokenHash,
      removedAt: null,
      publicUrlDisabledAt: rule.publicUrlDisabledAt ?? null,
      lastDeliveryAt: null as Date | null,
      providerRule: record,
    };
    endpoints.set(endpoint.id, endpoint);
    record.endpoint = endpoint;
    rules.push(record);
    return record;
  }
  options.rules.forEach((rule, index) => addRule(rule, index));
  const integrationEndpoints = new Map<string, any>();
  const receipts = new Map<string, any>();
  const deliveries = new Map<string, any>();
  const audit: any[] = [];
  const observed: any[] = [];
  const leadsByHash = new Map<string, Lead>();
  for (const lead of options.leads ?? [])
    leadsByHash.set(hashPhoneIdentity(lead.phone)!, lead);

  const statusMatches = (where: any, status: string) =>
    !where.status ||
    (where.status.in ? where.status.in.includes(status) : status === where.status);

  const prisma: any = {
    $transaction: vi.fn(async (input: any) =>
      Array.isArray(input) ? Promise.all(input) : input(prisma),
    ),
    auditLog: { create: vi.fn(async ({ data }: any) => audit.push(data)) },
    workspace: {
      findUnique: vi.fn(async () => ({ conversionCurrency: "BRL" })),
    },
    inboundWebhookParserRelease: {
      findFirst: vi.fn(async ({ where }: any) => parserRelease(where.provider)),
    },
    integrationEndpoint: {
      findUnique: vi.fn(
        async ({ where }: any) => integrationEndpoints.get(where.id) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: any) =>
          [...integrationEndpoints.values()].find(
            (endpoint) =>
              endpoint.workspaceId === where.workspaceId &&
              endpoint.removedAt === null &&
              (where.id === undefined || endpoint.id === where.id) &&
              (where.provider === undefined ||
                endpoint.provider === where.provider) &&
              (where.eventName === undefined ||
                endpoint.eventName === where.eventName),
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where }: any) =>
        [...integrationEndpoints.values()].filter(
          (e) =>
            e.workspaceId === where.workspaceId &&
            (where.removedAt?.not === null ? e.removedAt !== null : !e.removedAt) &&
            (!where.id?.in || where.id.in.includes(e.id)),
        ),
      ),
      create: vi.fn(async ({ data }: any) => {
        const endpoint = {
          ...data,
          secretVersion: 1,
          lastDeliveryAt: null,
          lastRoutedAt: null,
          rotatedAt: null,
          removedAt: null,
          createdAt: at,
          parserRelease: parserRelease(data.provider),
        };
        integrationEndpoints.set(endpoint.id, endpoint);
        return endpoint;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const endpoint = integrationEndpoints.get(where.id);
        Object.assign(
          endpoint,
          data,
          data.secretVersion
            ? { secretVersion: endpoint.secretVersion + 1 }
            : {},
        );
        return endpoint;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const endpoint = integrationEndpoints.get(where.id);
        if (endpoint) Object.assign(endpoint, data);
        return { count: endpoint ? 1 : 0 };
      }),
    },
    integrationEndpointEvent: {
      findUnique: vi.fn(async ({ where }: any) => {
        const key = where.integrationEndpointId_ingressKey;
        return (
          [...receipts.values()].find(
            (r) =>
              r.integrationEndpointId === key.integrationEndpointId &&
              r.ingressKey === key.ingressKey,
          ) ?? null
        );
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const receipt = receipts.get(where.id);
        return receipt && receipt.workspaceId === where.workspaceId
          ? {
              ...receipt,
              integrationEndpoint: integrationEndpoints.get(
                receipt.integrationEndpointId,
              ),
            }
          : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const receipt = { attemptCount: 1, ...data };
        receipts.set(data.id, receipt);
        return receipt;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const receipt = receipts.get(where.id);
        if (data.attemptCount?.increment)
          receipt.attemptCount += data.attemptCount.increment;
        for (const [key, value] of Object.entries(data))
          if (key !== "attemptCount") receipt[key] = value;
        return receipt;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        [...receipts.values()].filter(
          (r) =>
            r.workspaceId === where.workspaceId &&
            statusMatches(where, r.status) &&
            (!where.provider || r.provider === where.provider),
        ),
      ),
      count: vi.fn(
        async ({ where }: any) =>
          [...receipts.values()].filter(
            (r) =>
              r.workspaceId === where.workspaceId &&
              statusMatches(where, r.status),
          ).length,
      ),
      groupBy: vi.fn(async () => []),
    },
    providerConversionRuleConfig: {
      findMany: vi.fn(async ({ where }: any) => {
        const provider = where.parserRelease?.is?.provider;
        const eventName = where.conversionRule?.eventName;
        return rules.filter(
          (rule) =>
            !rule.removedAt &&
            rule.conversionRule.active &&
            (!provider ||
              (typeof provider === "string"
                ? rule.parserRelease.provider === provider
                : provider.in.includes(rule.parserRelease.provider))) &&
            (!eventName || rule.conversionRule.eventName === eventName) &&
            (!where.id?.in || where.id.in.includes(rule.id)) &&
            // legacy URL listing: disabled URLs that never received are hidden
            (!where.endpoint?.is?.OR ||
              rule.endpoint.publicUrlDisabledAt === null ||
              rule.endpoint.lastDeliveryAt !== null),
        );
      }),
      findFirst: vi.fn(async () => null),
    },
    providerConversionRuleEndpoint: {
      findUnique: vi.fn(
        async ({ where }: any) => endpoints.get(where.id) ?? null,
      ),
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.providerRuleId)
          return (
            [...endpoints.values()].find(
              (e) =>
                e.workspaceId === where.workspaceId &&
                e.providerRuleId === where.providerRuleId &&
                !e.removedAt,
            ) ?? null
          );
        const endpoint = endpoints.get(where.id);
        return endpoint && endpoint.secretHash === where.secretHash
          ? { id: endpoint.id }
          : null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const endpoint = endpoints.get(where.id);
        if (endpoint) Object.assign(endpoint, data);
        return { count: endpoint ? 1 : 0 };
      }),
    },
    inboundWebhookConnection: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    inboundWebhookDelivery: {
      findUnique: vi.fn(async ({ where }: any) => {
        const identity = where.connectionId_ingressKey;
        const delivery = deliveries.get(
          `${identity.connectionId}:${identity.ingressKey}`,
        );
        return delivery
          ? { id: delivery.id, firstReceivedAt: delivery.firstReceivedAt }
          : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const delivery = { attemptCount: 1, ...data };
        deliveries.set(`${data.connectionId}:${data.ingressKey}`, delivery);
        return delivery;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const delivery = [...deliveries.values()].find(
          (d) =>
            d.id === where.id &&
            (where.providerRuleEndpointId === undefined ||
              d.providerRuleEndpointId === where.providerRuleEndpointId),
        );
        if (!delivery) return { count: 0 };
        if (data.attemptCount?.increment)
          delivery.attemptCount += data.attemptCount.increment;
        for (const [key, value] of Object.entries(data))
          if (key !== "attemptCount") delivery[key] = value;
        return { count: 1 };
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const delivery = [...deliveries.values()].find(
          (d) =>
            d.id === where.id &&
            (where.connectionId === undefined ||
              d.connectionId === where.connectionId) &&
            (where.providerRuleEndpointId === undefined ||
              d.providerRuleEndpointId === where.providerRuleEndpointId),
        );
        return delivery
          ? {
              ...delivery,
              providerConversionExecutions: [],
              providerConversionDecisions: [],
            }
          : null;
      }),
    },
    providerConversionDecisionAudit: {
      findFirst: vi.fn(async () => null),
    },
    providerConversionRuleExecution: {
      findUnique: vi.fn(async () => null),
    },
    inboundWebhookChannel: {
      findMany: vi.fn(async () =>
        options.channels.map((channel, index) => ({
          id: channel.id,
          connectionId: channel.connectionId,
          status: "active",
          createdAt: new Date(at.getTime() - (50 - index) * 1000),
          connectedPhone: channel.phone,
          productionActivatedAt: at,
          connection: { provider: channel.provider, status: "observation" },
          whatsappSeats: [],
          whatsappInstance: null,
        })),
      ),
    },
    conversionEventLog: {
      findMany: vi.fn(async ({ where }: any) =>
        (options.leads ?? [])
          .filter((lead) => !where.ctwaClid || lead.ctwaClid === where.ctwaClid)
          .filter((lead) =>
            (where.phoneHash?.in ?? []).includes(hashPhoneIdentity(lead.phone)),
          )
          .flatMap((lead) =>
            (lead.adEntries && where.adId !== undefined
              ? lead.adEntries
              : [lead.entryChannelId]
            ).map((channelId) => ({
              id: `log_${lead.id}_${channelId}`,
              sourcePayload: {
                channelId,
                connectionId: options.channels.find((c) => c.id === channelId)
                  ?.connectionId,
                inboundEventId: `event_${lead.id}_${channelId}`,
              },
            })),
          ),
      ),
    },
    inboundWebhookEvent: {
      // resolvePurchaseChannels (OR proofs) finds nothing here; the Umbler
      // lookup returns the distinct numbers the contact talked to.
      findMany: vi.fn(async ({ where }: any) =>
        where.OR
          ? [
              ...new Set(
                where.OR.map((proof: any) => proof.channelId as string).filter(
                  (channelId: string) => where.channelId.in.includes(channelId),
                ),
              ),
            ].map((id) => ({ channel: { id } }))
          : [
              ...new Set(
                (options.lastMessages ?? [])
                  .filter(
                    (message) =>
                      where.contactIdentityHash.in.includes(
                        hashPhoneIdentity(message.phone),
                      ) && where.channelId.in.includes(message.channelId),
                  )
                  .map((message) => message.channelId),
              ),
            ].map((channelId) => ({ channelId })),
      ),
    },
  };

  const paidLeads = {
    resolve: vi.fn(async (input: any) => {
      const lead = [input.phone, ...(input.phoneCandidates ?? [])]
        .map((phone: string) => leadsByHash.get(hashPhoneIdentity(phone) ?? ""))
        .find(Boolean);
      if (!lead)
        return {
          status: "not_found",
          reasonCode: "paid_lead_not_found",
          candidateLeadId: null,
        };
      const channel = options.channels.find(
        (c) => c.id === lead.entryChannelId,
      )!;
      return {
        status: "resolved",
        reasonCode: "paid_lead_resolved",
        lead: {
          id: lead.id,
          phoneHash: hashPhoneIdentity(lead.phone)!,
          campaignId: null,
          adSetId: null,
          adId: lead.adId ?? null,
          ctwaClid: lead.ctwaClid,
          ctwaDestination: {
            channelId: channel.id,
            connectionId: channel.connectionId,
          },
        },
      };
    }),
  };
  const observation = {
    observeAutomation: vi.fn(async (input: any) => {
      observed.push(input);
      return {
        decisionId: `decision_${input.deliveryId}`,
        decisionCode: "eligible",
        reasonCode: "automation_matched",
        disposition: input.manualReplayApproval ? "eligible" : "observed",
        executionId: `execution_${input.deliveryId}`,
        eligibleExecutionId: input.manualReplayApproval
          ? `execution_${input.deliveryId}`
          : null,
        reviewId: null,
        channelId: "channel",
        leadResolved: true,
      };
    }),
  };
  const productionQueue = {
    enqueueProviderConversion: vi.fn(async () => ({ status: "queued" })),
  };
  const ingestion = new InboundConversionAutomationIngestionService(
    prisma,
    runtime,
    encryption,
    productionQueue as any,
    observation as any,
  );
  const service = new IntegrationEndpointsService(
    prisma,
    runtime,
    encryption,
    paidLeads as any,
    ingestion,
  );

  async function connect(provider: Provider, eventName?: string) {
    const endpoint = await service.ensure(
      W,
      { provider, ...(eventName ? { eventName: eventName as any } : {}) },
      "operator",
    );
    const url = new URL(endpoint.url!);
    return { endpoint, token: url.searchParams.get("token")!, url };
  }

  function post(
    endpointId: string,
    token: string,
    body: unknown,
    attempt?: string,
  ) {
    return service.ingest({
      endpointId,
      token,
      contentType: "application/json",
      providerAttempt: attempt,
      rawBody: Buffer.from(JSON.stringify(body)),
    });
  }

  function postOldUrl(ruleId: string, body: unknown) {
    return ingestion.ingest({
      endpointId: `endpoint_${ruleId}`,
      token: oldToken,
      contentType: "application/json",
      providerAttempt: undefined,
      rawBody: Buffer.from(JSON.stringify(body)),
    });
  }

  return {
    service,
    ingestion,
    prisma,
    connect,
    post,
    postOldUrl,
    addRule,
    rules,
    receipts,
    deliveries,
    endpoints,
    integrationEndpoints,
    observed,
    audit,
    productionQueue,
    paidLeads,
  };
}

// Jean: two numbers (…1020 and …5520), leads entering through CTWA without ad.
export const jeanChannels: Channel[] = [
  {
    id: "ch_1020",
    connectionId: "conn_unnichat_a",
    provider: "unnichat",
    phone: "5511900001020",
  },
  {
    id: "ch_5520",
    connectionId: "conn_unnichat_b",
    provider: "unnichat",
    phone: "5511900005520",
  },
];
export const jeanLeads: Lead[] = [
  {
    id: "lead_a",
    phone: "5511991231020",
    entryChannelId: "ch_1020",
    ctwaClid: "click-a",
  },
  {
    id: "lead_b",
    phone: "5511987655520",
    entryChannelId: "ch_5520",
    ctwaClid: "click-b",
  },
];
