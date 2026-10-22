import { describe, it, expect, vi } from "vitest";
import { ProviderConversionPaidLeadResolver } from "../../src/conversion-rules/provider-conversion-paid-lead-resolver.service";
import { ctwaHarness } from "./helpers/ctwa-harness";
import { resolveCtwaDestination } from "../../src/inbound-webhooks/authorized-ctwa-destination";
import { providerConversionPaidLeadSchema } from "@wpptrack/shared";
describe("later conversions require materialized CTWA origin rather than ad analytics", () => {
  it("resolves no-ad lead only from exact channel/click materialization proof", async () => {
    const h = ctwaHarness();
    const intent = await resolveCtwaDestination(h.prisma, h.channel);
    const lead = {
      id: "lead",
      phoneHash: "hash",
      campaignId: null,
      adSetId: null,
      adId: null,
      ctwaClid: "click",
    };
    h.prisma.lead = { findMany: vi.fn(async () => [lead]) };
    h.prisma.conversionEventLog = {
      findMany: vi.fn(async () => [
        {
          id: "log",
          workspaceId: "w",
          leadId: "lead",
          adId: null,
          ctwaClid: "click",
          sourcePayload: {
            inboundEventId: "e",
            channelId: "ch",
            connectionId: "c",
            ctwaDestination: intent,
          },
        },
      ]),
    };
    h.prisma.inboundWebhookEvent = {
      findFirst: vi.fn(async () => ({ id: "e" })),
    };
    h.prisma.inboundWebhookChannel = {
      findFirst: vi.fn(async () => h.channel),
    };
    const r = await new ProviderConversionPaidLeadResolver(h.prisma).resolve({
      workspaceId: "w",
      phone: "5511999990001",
      channelId: "ch",
      connectionId: "c",
    });
    expect(r).toMatchObject({
      status: "resolved",
      lead: {
        adId: null,
        ctwaDestination: { kind: "authorized_ctwa_destination" },
      },
    });
    expect(
      providerConversionPaidLeadSchema.safeParse((r as any).lead).success,
    ).toBe(true);
    h.prisma.inboundWebhookEvent.findFirst.mockResolvedValue(null);
    expect(
      await new ProviderConversionPaidLeadResolver(h.prisma).resolve({
        workspaceId: "w",
        phone: "5511999990001",
        channelId: "ch",
        connectionId: "c",
      }),
    ).toMatchObject({ status: "not_found" });
  });
  it("nullable ad without typed origin proof is rejected by shared contract", () => {
    expect(
      providerConversionPaidLeadSchema.safeParse({
        id: "l",
        phoneHash: "h",
        campaignId: null,
        adSetId: null,
        adId: null,
        ctwaClid: "click",
      }).success,
    ).toBe(false);
  });
});
import { offline } from "./helpers/first-entry-offline";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import { ProviderConversionProductionService } from "../../src/inbound-webhook-production/provider-conversion-production.service";
import { parseUnnichatAutomationV1 } from "../../src/inbound-webhooks/providers/unnichat/unnichat-automation-v1.parser";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import { InboundWebhookMetaRouteReaderService } from "../../src/inbound-webhooks/inbound-webhook-meta-route-reader.service";
import { providerConversionDecisionSchema } from "@wpptrack/shared";
describe("real later Unnichat production services with no ad", () => {
  it.each([
    "QualifiedLead",
    "Purchase",
    "revoked_after_effect",
    "legacy_before_effect",
    "shadow_after_enqueue",
  ] as const)(
    "materializes and dispatches %s from genuine parser plus typed original receipt",
    async (scenario) => {
      const eventName = scenario === "Purchase" ? "Purchase" : "QualifiedLead";
      const h = offline();
      h.channel.conversionEngineMode = "canonical";
      await h.production.processItem({
        workspaceId: "w",
        productionItemId: "item",
      });
      await h.processor.process(h.jobs[0]);
      // These adapters implement only data storage. Production parser, engine,
      // recorder, queue, processor and Meta adapter remain actual application code.
      h.prisma.inboundWebhookEvent.findFirst = vi.fn(async () => ({
        ...h.event,
        productionItem: h.item,
      }));
      const leadResolution = await new ProviderConversionPaidLeadResolver(
        h.prisma,
      ).resolve({
        workspaceId: "w",
        phone: h.payload.phone,
        channelId: "ch",
        connectionId: "c",
      });
      expect(leadResolution.status).toBe("resolved");
      const parsed = parseUnnichatAutomationV1({
        ...h.payload,
        event: "crm_movement",
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("parse");
      const rule: any = {
        providerRuleId: "rule",
        conversionRuleId: "conversion_rule",
        version: new Date().toISOString(),
        triggerType: "provider_automation",
        eventName,
        mode: "production",
        active: true,
        authorScope: null,
        triggerPhrases: [],
        defaultValueCents: eventName === "Purchase" ? 12000 : null,
        defaultCurrency: eventName === "Purchase" ? "BRL" : null,
        defaultContentName: null,
        valueMode: "fixed",
        exampleMessage: null,
      };
      const occurredAt = new Date();
      const decision = new ProviderConversionDecisionEngine().evaluate({
        parserVersion: "automation-v1",
        rule,
        catalog: null,
        leadResolution,
        contactIdentityHash: h.leads[0].phoneHash,
        occurrence: {
          source: "automation",
          provider: "unnichat",
          workspaceId: "w",
          connectionId: "c",
          channelId: "ch",
          externalDeliveryId: "automation_delivery",
          externalEventId: null,
          externalMessageId: null,
          occurrenceKey: parsed.value.externalExecutionKey,
          eventName,
          occurredAt: occurredAt.toISOString(),
          authorType: null,
          automation: "crm_movement",
        },
      });
      expect(decision?.decisionCode).toBe("eligible");
      expect(providerConversionDecisionSchema.safeParse(decision).success).toBe(
        true,
      );
      const execution: any = {
        id: "execution",
        workspaceId: "w",
        channelId: "ch",
        channel: h.channel,
        leadId: "lead",
        providerRuleId: "rule",
        sourceDeliveryId: "automation_delivery",
        externalExecutionKey: parsed.value.externalExecutionKey,
        status: "eligible",
        occurredAt,
        providerDecisionId: "decision",
        providerDecision: {
          id: "decision",
          workspaceId: "w",
          providerRuleId: "rule",
          sourceDeliveryId: "automation_delivery",
          decisionCode: "eligible",
          occurrenceKey: parsed.value.externalExecutionKey,
          eventName,
          occurredAt,
          leadId: "lead",
          decisionJson: decision,
        },
        providerRule: {
          ...rule,
          id: "rule",
          connectionId: "c",
          mode: "production",
          productionActivatedAt: h.channel.productionActivatedAt,
          removedAt: null,
          conversionRule: rule,
          parserRelease: {
            provider: "unnichat",
            version: "automation-v1",
            status: "certified",
          },
          connection: h.channel.connection,
          channels: [{ channelId: "ch" }],
        },
        sourceDelivery: {
          ...h.event.delivery,
          id: "automation_delivery",
          providerRuleEndpointId: "endpoint",
          purpose: "conversion_automation",
          parserVersion: "automation-v1",
          firstReceivedAt: occurredAt,
        },
        contactIdentityHash: h.leads[0].phoneHash,
        purchaseReview: null,
        normalizedResult: null,
      };
      h.prisma.providerConversionRuleExecution = {
        findFirst: vi.fn(async ({ where }: any) =>
          typeof where.id === "string" ? execution : null,
        ),
        update: vi.fn(async ({ data }: any) => Object.assign(execution, data)),
        updateMany: vi.fn(async () => ({ count: 1 })),
      };
      h.prisma.purchaseReview = {
        updateMany: vi.fn(async () => ({ count: 0 })),
      };
      const service = new ProviderConversionProductionService(
        h.prisma,
        {
          decrypt: () =>
            Buffer.from(
              JSON.stringify({ ...h.payload, event: "crm_movement" }),
            ),
        } as any,
        new InboundWebhookParserRegistry(),
        {} as any,
        new InboundWebhookMetaRouteReaderService(h.prisma),
        h.conversions,
        h.queue,
        // No billing module in this edition.
        {
          NODE_ENV: "test",
          INBOUND_WEBHOOKS_ENABLED: "true",
          INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
          INBOUND_CONVERSION_RULES_ENABLED: "true",
          INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
          API_PUBLIC_URL: "http://localhost:3333",
          INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString(
            "base64",
          ),
        },
      );
      if (scenario === "revoked_after_effect")
        h.prisma.$transaction.mockImplementation(async (fn: any) => {
          const result = await fn(h.prisma);
          if (h.logs.length === 2) h.credential.status = "revoked";
          return result;
        });
      if (scenario === "legacy_before_effect") {
        h.channel.conversionEngineMode = "legacy";
        await expect(
          service.processExecution({
            workspaceId: "w",
            providerConversionExecutionId: "execution",
          }),
        ).rejects.toThrow();
        expect(h.logs).toHaveLength(1);
        expect(h.leads).toHaveLength(1);
        expect(h.calls).toHaveLength(1);
        return;
      }
      expect(
        await service
          .processExecution({
            workspaceId: "w",
            providerConversionExecutionId: "execution",
          })
          .catch((e: any) => {
            throw new Error(e.code);
          }),
      ).toMatchObject({ status: "materialized" });
      expect(h.logs[1]).toMatchObject({
        eventName,
        adId: null,
        metaAccountId: null,
        status: "ready_to_send",
        eventOccurredAt: occurredAt,
      });
      if (scenario === "revoked_after_effect") {
        expect(h.jobs).toHaveLength(1);
        expect(execution.status).toBe("materialized");
        expect(execution.reasonCode).toBe(
          "provider_conversion_ctwa_handoff_revoked",
        );
        expect(h.calls).toHaveLength(1);
        return;
      }
      if (scenario === "shadow_after_enqueue") {
        h.channel.conversionEngineMode = "shadow";
        expect(await h.processor.process(h.jobs[1])).toMatchObject({
          status: "skipped",
        });
        expect(execution.status).toBe("materialized");
        expect(h.logs[1].status).toBe("ready_to_send");
        expect(h.calls).toHaveLength(1);
        return;
      }
      expect(await h.processor.process(h.jobs[1])).toMatchObject({
        status: "sent",
      });
      expect(h.calls).toHaveLength(2);
      expect(h.calls[1].body.data[0].custom_data).not.toHaveProperty("ad_id");
      expect(h.leads).toHaveLength(1);
    },
  );
});
import { ProviderConversionLegacyDecisionEngine } from "../../src/conversion-rules/provider-conversion-legacy-decision.engine";
import { ProviderConversionEngineRolloutService } from "../../src/conversion-rules/provider-conversion-engine-rollout.service";
it.each(["legacy", "shadow"] as const)(
  "actual %s rollout retains ad-only authority for typed no-ad lead",
  async (mode) => {
    const h = ctwaHarness();
    const intent = await resolveCtwaDestination(h.prisma, h.channel);
    const input: any = {
      parserVersion: "automation-v1",
      catalog: null,
      leadResolution: {
        status: "resolved",
        reasonCode: "paid_lead_resolved",
        lead: {
          id: "lead",
          phoneHash: "hash",
          adId: null,
          campaignId: null,
          adSetId: null,
          ctwaClid: "click",
          ctwaDestination: intent,
        },
      },
      contactIdentityHash: "hash",
      rule: {
        providerRuleId: "rule",
        conversionRuleId: "cr",
        version: "v1",
        triggerType: "provider_automation",
        eventName: "QualifiedLead",
        mode: "production",
        active: true,
        authorScope: null,
        triggerPhrases: [],
        defaultValueCents: null,
        defaultCurrency: null,
        defaultContentName: null,
        valueMode: "fixed",
        exampleMessage: null,
      },
      occurrence: {
        source: "automation",
        provider: "unnichat",
        workspaceId: "w",
        connectionId: "c",
        channelId: "ch",
        externalDeliveryId: "d",
        externalEventId: null,
        externalMessageId: null,
        occurrenceKey: "movement",
        eventName: "QualifiedLead",
        occurredAt: new Date().toISOString(),
        authorType: null,
        automation: "crm_movement",
      },
    };
    const rollout = new ProviderConversionEngineRolloutService(
      new ProviderConversionDecisionEngine(),
      new ProviderConversionLegacyDecisionEngine(),
      {
        record: vi.fn(async () => ({
          id: "synthetic_comparison",
          matches: false,
          mismatchCode: "noad",
          created: true,
        })),
      } as any,
    );
    expect(
      await rollout.evaluate({
        mode,
        decisionInput: input,
        sourceDeliveryId: "d",
      }),
    ).toBeNull();
  },
);
