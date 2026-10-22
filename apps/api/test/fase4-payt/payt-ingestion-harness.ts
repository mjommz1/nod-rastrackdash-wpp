import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import { PrismaService } from "../../src/common/prisma/prisma.service";
import type { ProviderConversionAutomationObservationResult } from "../../src/conversion-rules/provider-conversion-observation.service";
import { InboundConversionAutomationIngestionService } from "../../src/inbound-webhooks/inbound-conversion-automation-ingestion.service";
import { InboundWebhookPayloadEncryptionService } from "../../src/inbound-webhooks/inbound-webhook-payload-encryption.service";

/**
 * In-memory harness of the automation ingestion service, ported from the SaaS
 * (`apps/api/test/inbound-conversion-automation-ingestion.test.ts`) and
 * adapted to this edition: no workspace package access (billing) and the
 * student inbound providers. Only storage and the observation are fakes.
 */
export const secret = "provider-conversion-secret";
const secretHash = createHash("sha256").update(secret).digest("hex");

function runtimeEnvironment(input: {
  enabled?: boolean;
  production?: boolean;
}) {
  return {
    NODE_ENV: "test",
    API_PUBLIC_URL: "http://localhost:3333",
    INBOUND_WEBHOOKS_ENABLED: "true",
    INBOUND_WEBHOOK_PRODUCTION_ENABLED: String(input.production ?? false),
    INBOUND_CONVERSION_RULES_ENABLED: String(input.enabled ?? true),
    INBOUND_CONVERSION_PRODUCTION_ENABLED: String(input.production ?? false),
    INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 29).toString("base64"),
  };
}

export function automationPayload(
  automation: "lead_qualificado" | "compra_aprovada" = "lead_qualificado",
) {
  return {
    schema: "wpptrack.umbler.automation.v1",
    source: "umbler_tag_automation",
    automation,
    contact: {
      phone: "+5511999999999",
      name: "Nome que nao deve ser persistido",
    },
    conversation: {
      id: "conversation_1",
      created_at_utc: "2026-07-22 16:59:29",
    },
  };
}

export function createHarness(options?: {
  enabled?: boolean;
  active?: boolean;
  removed?: boolean;
  production?: boolean;
  eventName?: "QualifiedLead" | "Purchase" | "InitiateCheckout" | "CartAbandoned";
  /** Payt rule bound to a WhatsApp (UAZAPI) connection, as created in Conversoes. */
  payt?: boolean;
  /** Fase 4b: Unnichat automation rule bound to its Unnichat connection. */
  unnichat?: boolean;
  channelResolved?: boolean;
  paidLeadResolved?: boolean;
}) {
  const now = new Date("2026-07-22T17:10:00.000Z");
  const activatedAt = new Date("2026-07-22T12:00:00.000Z");
  const eventName = options?.eventName ?? "QualifiedLead";
  const production = options?.production ?? false;
  const channel = {
    id: "channel_1",
    workspaceId: "workspace_safe",
    connectionId: "connection_1",
    channelName: "Comercial",
    connectedPhone: "+551****9999",
    status: "active" as const,
    productionActivatedAt: activatedAt as Date | null,
  };
  const endpoint = {
    id: "endpoint_1",
    workspaceId: "workspace_safe",
    providerRuleId: "provider_rule_1",
    secretHash,
    secretVersion: 1,
    lastDeliveryAt: null as Date | null,
    lastSuccessfulParseAt: null as Date | null,
    rotatedAt: null,
    removedAt: options?.removed ? now : null,
    createdAt: now,
    updatedAt: now,
    providerRule: {
      id: "provider_rule_1",
      workspaceId: "workspace_safe",
      conversionRuleId: "rule_1",
      connectionId: "connection_1",
      parserReleaseId: "inbound_parser_umbler_automation_v1",
      mode: production ? ("production" as const) : ("observation" as const),
      productionActivatedAt: production ? activatedAt : null,
      removedAt: null,
      createdByUserId: "user_1",
      createdAt: now,
      updatedAt: now,
      conversionRule: {
        id: "rule_1",
        workspaceId: "workspace_safe",
        name: "Automacao Umbler",
        triggerType: "provider_automation" as const,
        triggerValue: "provider_automation",
        matchMode: "exact" as const,
        eventName,
        pixelId: null,
        defaultValueCents: eventName === "Purchase" ? 250_000 : null,
        defaultCurrency: eventName === "Purchase" ? "BRL" : null,
        defaultContentName: eventName === "Purchase" ? "Pedido medio" : null,
        defaultItems: null,
        active: options?.active ?? true,
        createdAt: now,
        updatedAt: now,
      },
      connection: {
        id: "connection_1",
        workspaceId: "workspace_safe",
        provider: "umbler" as
          "umbler" | "gupshup" | "uazapi" | "meta_cloud" | "data_crazy" | "payt" | "unnichat",
        displayName: "Umbler Teste",
        parserReleaseId: "inbound_parser_umbler_v1",
        secretHash: "connection-hash",
        status: production ? ("production" as const) : ("observation" as const),
        productionActivatedAt: production ? activatedAt : null,
        createdByUserId: "user_1",
        lastDeliveryAt: null as Date | null,
        lastSuccessfulParseAt: null as Date | null,
        removedAt: null,
        createdAt: now,
        updatedAt: now,
        parserRelease: {
          id: "inbound_parser_umbler_v1",
          provider: "umbler" as
            "umbler" | "gupshup" | "uazapi" | "meta_cloud" | "data_crazy" | "payt" | "unnichat",
          version: "v1",
          status: "certified" as const,
          certifiedByUserId: "user_1",
          certifiedAt: activatedAt,
          createdAt: now,
          updatedAt: now,
        },
      },
      parserRelease: {
        id: "inbound_parser_umbler_automation_v1",
        provider: "umbler" as
          "umbler" | "gupshup" | "uazapi" | "meta_cloud" | "data_crazy" | "payt" | "unnichat",
        version: "automation-v1",
        status: "certified" as const,
        certifiedByUserId: "user_1",
        certifiedAt: activatedAt,
        createdAt: now,
        updatedAt: now,
      },
      channels: [{ channelId: channel.id, channel }],
    },
  };
  const deliveries = new Map<string, Record<string, any>>();
  const decisions = new Map<string, Record<string, any>>();
  const executions = new Map<string, Record<string, any>>();
  const purchaseReviews = new Map<string, Record<string, any>>();
  const deliveryByIdentity = (connectionId: string, ingressKey: string) =>
    `${connectionId}:${ingressKey}`;
  const hydrateDelivery = (delivery: Record<string, any>) => ({
    ...delivery,
    providerConversionExecutions: [...executions.values()]
      .filter((execution) => execution.sourceDeliveryId === delivery.id)
      .sort(
        (left, right) =>
          (right.createdAt?.getTime?.() ?? 0) -
          (left.createdAt?.getTime?.() ?? 0),
      )
      .slice(0, 1)
      .map((execution) => ({
        ...execution,
        channel:
          execution.channelId === channel.id
            ? {
                id: channel.id,
                channelName: channel.channelName,
                connectedPhone: channel.connectedPhone,
              }
            : null,
      })),
    providerConversionDecisions: [...decisions.values()]
      .filter((decision) => decision.sourceDeliveryId === delivery.id)
      .sort(
        (left, right) =>
          (right.decisionVersion ?? 0) - (left.decisionVersion ?? 0) ||
          (right.createdAt?.getTime?.() ?? 0) -
            (left.createdAt?.getTime?.() ?? 0),
      )
      .slice(0, 1)
      .map((decision) => ({
        ...decision,
        channel:
          decision.channelId === channel.id
            ? {
                id: channel.id,
                channelName: channel.channelName,
                connectedPhone: channel.connectedPhone,
              }
            : null,
      })),
  });
  const matchesNullableNotFilter = (
    record: Record<string, any>,
    where: Record<string, any> | undefined,
    field: "classification" | "reasonCode",
  ): boolean => {
    if (!where) return true;
    if (where.AND) {
      return where.AND.every((part: Record<string, any>) =>
        matchesNullableNotFilter(record, part, field),
      );
    }
    if (where.OR) {
      return where.OR.some((part: Record<string, any>) =>
        matchesNullableNotFilter(record, part, field),
      );
    }
    if (!(field in where)) return true;

    const expected = where[field];
    if (expected === null) return record[field] == null;
    if (expected?.not) return record[field] !== expected.not;
    if (expected?.notIn) return !expected.notIn.includes(record[field]);
    if (expected?.in) return expected.in.includes(record[field]);
    return record[field] === expected;
  };
  const deliveryMatchesScope = (
    delivery: Record<string, any>,
    where: Record<string, any>,
  ) => {
    if (
      (where.id && delivery.id !== where.id) ||
      (where.workspaceId && delivery.workspaceId !== where.workspaceId) ||
      (where.connectionId && delivery.connectionId !== where.connectionId) ||
      (where.providerRuleEndpointId &&
        delivery.providerRuleEndpointId !== where.providerRuleEndpointId) ||
      (where.purpose && delivery.purpose !== where.purpose) ||
      !matchesNullableNotFilter(delivery, where, "classification")
    ) {
      return false;
    }
    if (
      where.payloadExpiresAt?.gt &&
      delivery.payloadExpiresAt <= where.payloadExpiresAt.gt
    ) {
      return false;
    }
    for (const field of [
      "encryptedPayload",
      "payloadIv",
      "payloadTag",
      "encryptionKeyVersion",
    ] as const) {
      if (where[field]?.not === null && delivery[field] == null) return false;
    }

    const relatedExecutions = [...executions.values()].filter(
      (execution) => execution.sourceDeliveryId === delivery.id,
    );
    const executionSome = where.providerConversionExecutions?.some;
    if (
      executionSome &&
      !relatedExecutions.some(
        (execution) =>
          (!executionSome.providerRuleId ||
            execution.providerRuleId === executionSome.providerRuleId) &&
          (!executionSome.status || execution.status === executionSome.status),
      )
    ) {
      return false;
    }
    const executionNone = where.providerConversionExecutions?.none;
    if (
      executionNone &&
      relatedExecutions.some(
        (execution) =>
          !executionNone.providerRuleId ||
          execution.providerRuleId === executionNone.providerRuleId,
      )
    ) {
      return false;
    }

    return true;
  };

  const providerConversionRuleEndpoint = {
    findUnique: vi.fn(async ({ where }) =>
      where.id === endpoint.id ? endpoint : null,
    ),
    findFirst: vi.fn(async ({ where }: any) => {
      if (where.providerRuleId) {
        return where.providerRuleId === endpoint.providerRuleId &&
          endpoint.removedAt === null
          ? endpoint
          : null;
      }
      return endpoint.removedAt === null &&
        endpoint.providerRule.conversionRule.active
        ? { id: endpoint.id }
        : null;
    }),
    updateMany: vi.fn(async ({ data }) => {
      endpoint.lastDeliveryAt = data.lastDeliveryAt;
      if (data.lastSuccessfulParseAt) {
        endpoint.lastSuccessfulParseAt = data.lastSuccessfulParseAt;
      }
      return { count: 1 };
    }),
  };
  const inboundWebhookConnection = {
    updateMany: vi.fn(async ({ data }) => {
      endpoint.providerRule.connection.lastDeliveryAt = data.lastDeliveryAt;
      if (data.lastSuccessfulParseAt) {
        endpoint.providerRule.connection.lastSuccessfulParseAt =
          data.lastSuccessfulParseAt;
      }
      return { count: 1 };
    }),
  };
  const inboundWebhookDelivery = {
    findUnique: vi.fn(async ({ where }) => {
      const identity = where.connectionId_ingressKey;
      const delivery = deliveries.get(
        deliveryByIdentity(identity.connectionId, identity.ingressKey),
      );
      return delivery
        ? { id: delivery.id, firstReceivedAt: delivery.firstReceivedAt }
        : null;
    }),
    findFirst: vi.fn(async ({ where }: any) => {
      const candidates = [...deliveries.values()]
        .filter((delivery) => {
          if (!deliveryMatchesScope(delivery, where)) return false;
          const related = [...executions.values()].filter(
            (execution) =>
              execution.sourceDeliveryId === delivery.id &&
              (!where.providerConversionExecutions?.some?.providerRuleId ||
                execution.providerRuleId ===
                  where.providerConversionExecutions.some.providerRuleId),
          );
          if (where.providerConversionExecutions?.some) {
            return related.some(
              (execution) =>
                execution.status ===
                where.providerConversionExecutions.some.status,
            );
          }
          if (where.providerConversionExecutions?.none) {
            return !related.some(
              (execution) =>
                execution.providerRuleId ===
                where.providerConversionExecutions.none.providerRuleId,
            );
          }
          return true;
        })
        .sort(
          (left, right) =>
            right.lastReceivedAt.getTime() - left.lastReceivedAt.getTime(),
        );
      return candidates[0] ? hydrateDelivery(candidates[0]) : null;
    }),
    findMany: vi.fn(async ({ where, take }: any) =>
      [...deliveries.values()]
        .filter((delivery) => deliveryMatchesScope(delivery, where))
        .sort(
          (left, right) =>
            right.lastReceivedAt.getTime() - left.lastReceivedAt.getTime(),
        )
        .slice(0, take)
        .map(hydrateDelivery),
    ),
    count: vi.fn(
      async ({ where }: any) =>
        [...deliveries.values()].filter((delivery) =>
          deliveryMatchesScope(delivery, where),
        ).length,
    ),
    create: vi.fn(async ({ data }) => {
      const delivery = { attemptCount: 1, ...data };
      deliveries.set(
        deliveryByIdentity(data.connectionId, data.ingressKey),
        delivery,
      );
      return delivery;
    }),
    updateMany: vi.fn(async ({ where, data }) => {
      const delivery = [...deliveries.values()].find(
        (candidate) =>
          candidate.id === where.id &&
          candidate.workspaceId === where.workspaceId &&
          candidate.connectionId === where.connectionId &&
          candidate.providerRuleEndpointId === where.providerRuleEndpointId &&
          // Fase 5.0: compare-and-swap of a Payt resend on the ciphertext.
          (where.encryptedPayload === undefined ||
            candidate.encryptedPayload === where.encryptedPayload),
      );
      if (!delivery) return { count: 0 };
      if (data.attemptCount?.increment) {
        delivery.attemptCount += data.attemptCount.increment;
      }
      for (const [key, value] of Object.entries(data)) {
        if (key !== "attemptCount") delivery[key] = value;
      }
      return { count: 1 };
    }),
  };
  const providerConversionRuleExecution = {
    findUnique: vi.fn(async ({ where }) => {
      const key =
        where.providerRuleId_externalExecutionKey.externalExecutionKey;
      return executions.get(key) ?? null;
    }),
    upsert: vi.fn(async ({ where, create }) => {
      const key =
        where.providerRuleId_externalExecutionKey.externalExecutionKey;
      const existing = executions.get(key);
      if (existing) return { id: existing.id, status: existing.status };
      const execution = {
        id: `execution_${executions.size + 1}`,
        createdAt: now,
        updatedAt: now,
        ...create,
      };
      executions.set(key, execution);
      return { id: execution.id, status: execution.status };
    }),
    update: vi.fn(async ({ where, data }) => {
      const entry = [...executions.entries()].find(
        ([, execution]) => execution.id === where.id,
      );
      if (!entry) throw new Error("execution not found");
      if (data.attemptCount?.increment) {
        entry[1].attemptCount += data.attemptCount.increment;
      }
      for (const [key, value] of Object.entries(data)) {
        if (key !== "attemptCount") entry[1][key] = value;
      }
      return entry[1];
    }),
    create: vi.fn(async ({ data }) => {
      const execution = {
        id: `execution_${executions.size + 1}`,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      executions.set(data.externalExecutionKey, execution);
      return execution;
    }),
    groupBy: vi.fn(async ({ where }: any) => {
      const counts = new Map<string, number>();
      for (const execution of executions.values()) {
        const delivery = [...deliveries.values()].find(
          (candidate) => candidate.id === execution.sourceDeliveryId,
        );
        if (
          execution.workspaceId !== where.workspaceId ||
          execution.providerRuleId !== where.providerRuleId ||
          !matchesNullableNotFilter(execution, where, "reasonCode") ||
          !delivery ||
          (where.sourceDelivery &&
            !deliveryMatchesScope(delivery, where.sourceDelivery))
        ) {
          continue;
        }
        counts.set(execution.status, (counts.get(execution.status) ?? 0) + 1);
      }
      return [...counts.entries()].map(([status, count]) => ({
        status,
        _count: { _all: count },
      }));
    }),
    count: vi.fn(
      async ({ where }: any) =>
        [...executions.values()].filter((execution) => {
          const matchesStatus = where.OR
            ? where.OR.some((condition: Record<string, any>) => {
                if (condition.status?.in) {
                  return condition.status.in.includes(execution.status);
                }
                if (condition.status && execution.status !== condition.status) {
                  return false;
                }
                if (
                  condition.reasonCode &&
                  execution.reasonCode !== condition.reasonCode
                ) {
                  return false;
                }
                if (condition.normalizedResult) {
                  return (
                    execution.normalizedResult?.technicalDelivery?.retryable ===
                    condition.normalizedResult.equals
                  );
                }
                return true;
              })
            : where.status?.in
              ? where.status.in.includes(execution.status)
              : !where.status || execution.status === where.status;
          if (
            execution.workspaceId !== where.workspaceId ||
            execution.providerRuleId !== where.providerRuleId ||
            !matchesNullableNotFilter(execution, where, "reasonCode") ||
            !matchesStatus
          ) {
            return false;
          }
          const delivery = [...deliveries.values()].find(
            (candidate) => candidate.id === execution.sourceDeliveryId,
          );
          if (
            delivery &&
            !matchesNullableNotFilter(
              delivery,
              where.sourceDelivery,
              "classification",
            )
          ) {
            return false;
          }
          return Boolean(
            delivery &&
            (!where.sourceDelivery ||
              deliveryMatchesScope(delivery, where.sourceDelivery)),
          );
        }).length,
    ),
  };
  const decisionMatchesScope = (
    decision: Record<string, any>,
    where: Record<string, any>,
  ) => {
    if (
      (where.workspaceId && decision.workspaceId !== where.workspaceId) ||
      (where.providerRuleId &&
        decision.providerRuleId !== where.providerRuleId) ||
      (where.decisionCode && decision.decisionCode !== where.decisionCode) ||
      (where.occurrenceKey && decision.occurrenceKey !== where.occurrenceKey)
    ) {
      return false;
    }
    if (
      where.supersededBy?.none &&
      [...decisions.values()].some(
        (candidate) => candidate.supersedesDecisionId === decision.id,
      )
    ) {
      return false;
    }
    if (
      where.providerExecution?.is === null &&
      [...executions.values()].some(
        (execution) => execution.providerDecisionId === decision.id,
      )
    ) {
      return false;
    }
    const delivery = [...deliveries.values()].find(
      (candidate) => candidate.id === decision.sourceDeliveryId,
    );
    return Boolean(
      delivery &&
      (!where.sourceDelivery ||
        deliveryMatchesScope(delivery, where.sourceDelivery)),
    );
  };
  const providerConversionDecisionAudit = {
    findFirst: vi.fn(async ({ where }: any) => {
      const candidates = [...decisions.values()]
        .filter((decision) => decisionMatchesScope(decision, where))
        .sort(
          (left, right) =>
            (right.occurredAt?.getTime?.() ?? 0) -
              (left.occurredAt?.getTime?.() ?? 0) ||
            (right.createdAt?.getTime?.() ?? 0) -
              (left.createdAt?.getTime?.() ?? 0),
        );
      const decision = candidates[0] ?? null;
      return decision && where ? { ...decision } : decision;
    }),
    groupBy: vi.fn(async ({ where }: any) => {
      const counts = new Map<string, number>();
      for (const decision of decisions.values()) {
        if (!decisionMatchesScope(decision, where)) continue;
        counts.set(
          decision.decisionCode,
          (counts.get(decision.decisionCode) ?? 0) + 1,
        );
      }
      return [...counts.entries()].map(([decisionCode, count]) => ({
        decisionCode,
        _count: { _all: count },
      }));
    }),
    count: vi.fn(
      async ({ where }: any) =>
        [...decisions.values()].filter((decision) =>
          decisionMatchesScope(decision, where),
        ).length,
    ),
  };
  const purchaseReview = {
    upsert: vi.fn(async ({ where, create }) => {
      const key =
        where.providerRuleId_externalOccurrenceKey.externalOccurrenceKey;
      const existing = purchaseReviews.get(key);
      if (existing) return existing;
      const review = { id: "review_1", ...create };
      purchaseReviews.set(key, review);
      return review;
    }),
  };
  const leadFindFirst = vi.fn(async () =>
    options?.paidLeadResolved === false
      ? null
      : { id: "lead_1", adId: "ad_1", ctwaClid: "ctwa_1" },
  );
  const prisma: Record<string, any> = {
    providerConversionRuleEndpoint,
    inboundWebhookConnection,
    inboundWebhookDelivery,
    inboundWebhookEvent: {
      findFirst: vi.fn(async () =>
        options?.channelResolved === false ? null : { channel },
      ),
    },
    lead: {
      findFirst: leadFindFirst,
    },
    providerConversionRuleExecution,
    providerConversionDecisionAudit,
    purchaseReview,
    auditLog: {
      create: vi.fn(async ({ data }) => data),
    },
  };
  prisma.$transaction = vi.fn(async (operation) => operation(prisma));

  const env = runtimeEnvironment({
    enabled: options?.enabled ?? true,
    production,
  });
  const encryption = new InboundWebhookPayloadEncryptionService(env);
  const productionQueue = {
    enqueueProviderConversion: vi.fn(async () => ({
      jobId: "provider-conversion:execution_1",
      status: "queued" as const,
    })),
  };
  const conversionObservation = {
    observeAutomation: vi.fn<
      (input: any) => Promise<ProviderConversionAutomationObservationResult>
    >(async (input: any) => {
      const paidLead = await leadFindFirst();
      const paidLeadResolved = Boolean(paidLead);
      if (input.automation.eventName !== eventName) {
        return {
          decisionId: null,
          decisionCode: null,
          reasonCode: "automation_event_mismatch",
          disposition: "ignored",
          executionId: null,
          eligibleExecutionId: null,
          reviewId: null,
          channelId: options?.channelResolved === false ? null : channel.id,
          leadResolved: paidLeadResolved,
        };
      }

      const executionKey = input.automation.externalExecutionKey;
      let decision = [...decisions.values()].find(
        (candidate) =>
          candidate.providerRuleId === input.providerRuleId &&
          candidate.occurrenceKey === executionKey &&
          ![...decisions.values()].some(
            (newer) => newer.supersedesDecisionId === candidate.id,
          ),
      );
      const decisionCode = paidLeadResolved
        ? "eligible"
        : "ignored_untracked_lead";
      const reasonCode = paidLeadResolved
        ? "automation_matched"
        : "ignored_untracked_lead";
      if (!decision) {
        decision = {
          id: `decision_${decisions.size + 1}`,
          workspaceId: input.workspaceId,
          providerRuleId: input.providerRuleId,
          sourceDeliveryId: input.deliveryId,
          channelId: options?.channelResolved === false ? null : channel.id,
          leadId: paidLeadResolved ? "lead_1" : null,
          supersedesDecisionId: null,
          decisionCode,
          reasonCode,
          eventName: input.automation.eventName,
          occurredAt: input.deliveryReceivedAt,
          occurrenceKey: executionKey,
          decisionVersion: 1,
          valueCents:
            input.automation.eventName === "Purchase" ? 250_000 : null,
          currency: input.automation.eventName === "Purchase" ? "BRL" : null,
          createdAt: now,
        };
        decisions.set(decision.id, decision);
      }

      if (decisionCode === "ignored_untracked_lead") {
        return {
          decisionId: decision.id,
          decisionCode,
          reasonCode,
          disposition: "ignored",
          executionId: null,
          eligibleExecutionId: null,
          reviewId: null,
          channelId: options?.channelResolved === false ? null : channel.id,
          leadResolved: false,
        };
      }

      const productionEnabled =
        env.INBOUND_WEBHOOK_PRODUCTION_ENABLED === "true" &&
        env.INBOUND_CONVERSION_PRODUCTION_ENABLED === "true" &&
        endpoint.providerRule.mode === "production" &&
        endpoint.providerRule.connection.status === "production";
      const beforeActivation =
        !input.manualRecovery &&
        ((endpoint.providerRule.productionActivatedAt &&
          input.deliveryReceivedAt <
            endpoint.providerRule.productionActivatedAt) ||
          (channel.productionActivatedAt &&
            input.deliveryReceivedAt < channel.productionActivatedAt));
      const disposition =
        options?.channelResolved === false
          ? "blocked"
          : productionEnabled && !beforeActivation
            ? "eligible"
            : "observed";
      let execution: Record<string, any> | null = null;
      if (disposition !== "observed") {
        execution = executions.get(executionKey) ?? {
          id: `execution_${executions.size + 1}`,
          workspaceId: input.workspaceId,
          providerRuleId: input.providerRuleId,
          sourceDeliveryId: input.deliveryId,
          channelId: options?.channelResolved === false ? null : channel.id,
          externalExecutionKey: executionKey,
          status: disposition,
          reasonCode:
            disposition === "blocked"
              ? "automation_channel_unresolved"
              : "automation_matched",
          normalizedResult: {
            eventName: input.automation.eventName,
            automation: input.automation.automation,
          },
          leadId: "lead_1",
          providerDecisionId: decision.id,
          valueCents: decision.valueCents,
          currency: decision.currency,
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        execution.status = disposition;
        execution.sourceDeliveryId = input.deliveryId;
        executions.set(executionKey, execution);
      }

      return {
        decisionId: decision.id,
        decisionCode,
        reasonCode,
        disposition,
        executionId: execution?.id ?? null,
        eligibleExecutionId:
          disposition === "eligible" ? (execution?.id ?? null) : null,
        reviewId: null,
        channelId: options?.channelResolved === false ? null : channel.id,
        leadResolved: true,
      };
    }),
  };
  if (options?.payt) {
    // A Payt rule keeps the WhatsApp connection of its numbers only as the
    // anchor of its signed URL; the stored parser release is Payt's.
    const rule = endpoint.providerRule;
    rule.connection.provider = "uazapi";
    rule.connection.parserRelease.provider = "uazapi";
    rule.parserRelease.provider = "payt";
    rule.parserReleaseId = "inbound_parser_payt_automation_v1";
    rule.parserRelease.id = "inbound_parser_payt_automation_v1";
    rule.conversionRule.name = "Venda Payt";
  }
  if (options?.unnichat) {
    const rule = endpoint.providerRule;
    rule.connection.provider = "unnichat";
    rule.connection.parserRelease.provider = "unnichat";
    rule.parserRelease.provider = "unnichat";
    rule.parserReleaseId = "inbound_parser_unnichat_automation_v1";
    rule.parserRelease.id = "inbound_parser_unnichat_automation_v1";
    rule.conversionRule.name = "Automação Unnichat";
  }
  const service = new InboundConversionAutomationIngestionService(
    prisma as unknown as PrismaService,
    env,
    encryption,
    productionQueue as never,
    conversionObservation as never,
  );

  return {
    channel,
    deliveries,
    decisions,
    encryption,
    endpoint,
    env,
    executions,
    prisma,
    productionQueue,
    conversionObservation,
    purchaseReviews,
    service,
  };
}

export function input(rawBody: Buffer, token: unknown = secret) {
  return {
    endpointId: "endpoint_1",
    token,
    contentType: "application/json; charset=utf-8",
    providerAttempt: "1",
    rawBody,
  };
}


export function paytFixture(name: string): Record<string, any> {
  return JSON.parse(
    readFileSync(resolve(__dirname, "fixtures", name), "utf8"),
  ) as Record<string, any>;
}

export function paytBody(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload));
}
