import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderConversionObservationService } from "../../src/conversion-rules/provider-conversion-observation.service";
import { parseUnnichatAutomationV1 } from "../../src/inbound-webhooks/providers/unnichat/unnichat-automation-v1.parser";
import {
  createHarness,
  input,
} from "../fase4-payt/payt-ingestion-harness";

// Fase 4b (as in the SaaS): an Unnichat flow calls the URL of the rule
// (automation-v1). The rule chooses the event; the payload's event_name never
// does. ctwa_clid is mandatory: without it nothing is sent.
const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, "fixtures", name), "utf8"));
const body = (payload: unknown) => Buffer.from(JSON.stringify(payload));

describe("Unnichat automation on the rule URL", () => {
  it("parses the movement with the automation parser and takes the event from the rule", async () => {
    const harness = createHarness({ eventName: "QualifiedLead", unnichat: true });

    const accepted = await harness.service.ingest(
      input(body(fixture("movement-with-ctwa.json"))),
    );

    expect(accepted).toMatchObject({ status: "accepted", duplicate: false });
    expect(
      harness.conversionObservation.observeAutomation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        automation: expect.objectContaining({
          provider: "unnichat",
          automation: "crm_movement",
          // payload event_name is "Lead"; the rule decides QualifiedLead.
          eventName: "QualifiedLead",
          hasCtwa: true,
          ctwaClid: "test-ctwa-click-id",
        }),
      }),
    );
    const delivery = [...harness.deliveries.values()][0]!;
    expect(delivery).toMatchObject({
      provider: "unnichat",
      parserVersion: "automation-v1",
      purpose: "conversion_automation",
    });
    // The raw click id and the phone never enter the persisted summary.
    expect(JSON.stringify(delivery.normalizedSummary)).not.toMatch(
      /test-ctwa-click-id|5500000000000/,
    );
  });

  it("accepts the n8n single-item envelope as the same occurrence", () => {
    const direct = parseUnnichatAutomationV1(fixture("entry-with-ctwa.json"));
    const n8n = parseUnnichatAutomationV1(fixture("n8n-envelope-with-ctwa.json"));
    expect(direct.ok && n8n.ok).toBe(true);
    if (!direct.ok || !n8n.ok) return;
    expect(n8n.value.externalExecutionKey).toBe(
      direct.value.externalExecutionKey,
    );
  });

  it("counts a repeated callback as one occurrence (duplicate = one conversion)", async () => {
    const harness = createHarness({ eventName: "Purchase", unnichat: true });
    const payload = fixture("movement-with-ctwa.json");

    await harness.service.ingest(input(body(payload)));
    const repeated = await harness.service.ingest(input(body(payload)));
    await harness.service.ingest(input(body(payload)));

    expect(repeated).toMatchObject({ status: "accepted", duplicate: true });
    expect(harness.deliveries.size).toBe(1);
    // The observation keys the execution by the same identity every time.
    const keys = harness.conversionObservation.observeAutomation.mock.calls.map(
      ([call]: any) => call.automation.externalExecutionKey,
    );
    expect(new Set(keys).size).toBe(1);
    expect(harness.executions.size).toBeLessThanOrEqual(1);
  });

  it("records a payload of another platform as invalid and never observes it", async () => {
    const harness = createHarness({ eventName: "QualifiedLead", unnichat: true });

    await harness.service.ingest(
      input(body({ ...fixture("movement-with-ctwa.json"), source: "umbler" })),
    );

    expect(
      harness.conversionObservation.observeAutomation,
    ).not.toHaveBeenCalled();
  });
});

describe("Unnichat automation without ctwa_clid: nothing is sent", () => {
  function observation() {
    const upsert = vi.fn(async () => ({ id: "execution_blocked" }));
    const prisma = {
      providerConversionRuleConfig: {
        findFirst: vi.fn(async () => ({
          id: "provider_rule_1",
          workspaceId: "workspace_1",
          connectionId: "connection_unnichat_1",
          scope: "specific_numbers",
          mode: "production",
          removedAt: null,
          conversionRule: {
            triggerType: "provider_automation",
            eventName: "Purchase",
            active: true,
          },
          parserRelease: { provider: "unnichat", version: "automation-v1" },
          connection: { provider: "unnichat" },
          channels: [],
        })),
      },
      providerConversionRuleExecution: { upsert },
    };
    const paidLeads = { resolve: vi.fn() };
    const service = Object.assign(
      Object.create(ProviderConversionObservationService.prototype),
      {
        prisma,
        paidLeads,
        env: {
          NODE_ENV: "test",
          API_PUBLIC_URL: "http://localhost:3333",
          INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
          INBOUND_WEBHOOKS_ENABLED: "true",
          INBOUND_CONVERSION_RULES_ENABLED: "true",
        },
      },
    ) as ProviderConversionObservationService;
    return { service, upsert, paidLeads, prisma };
  }

  it.each(["movement-without-ctwa.json", "entry-without-ctwa.json"])(
    "blocks %s as ctwa_missing without lead, decision or send",
    async (name) => {
      const { service, upsert, paidLeads } = observation();
      const parsed = parseUnnichatAutomationV1(fixture(name));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.hasCtwa).toBe(false);

      const result = await service.observeAutomation({
        workspaceId: "workspace_1",
        connectionId: "connection_unnichat_1",
        deliveryId: "delivery_1",
        providerRuleId: "provider_rule_1",
        deliveryReceivedAt: new Date(),
        automation: {
          ...parsed.value,
          provider: "unnichat",
          automation: "crm_movement",
          eventName: "Purchase",
        },
      } as never);

      expect(result).toMatchObject({
        reasonCode: "ctwa_missing",
        disposition: "blocked",
        eligibleExecutionId: null,
        decisionId: null,
        leadResolved: false,
      });
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: "blocked",
            reasonCode: "ctwa_missing",
            leadId: null,
            valueCents: null,
          }),
        }),
      );
      // No lead lookup at all: the click is the proof, and there is none.
      expect(paidLeads.resolve).not.toHaveBeenCalled();
    },
  );
});
