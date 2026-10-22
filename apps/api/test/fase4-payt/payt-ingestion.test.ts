import { describe, expect, it } from "vitest";
import type { ProviderConversionAutomationObservationResult } from "../../src/conversion-rules/provider-conversion-observation.service";
import { buildProviderPurchaseIdentity } from "../../src/conversion-rules/provider-purchase-identity";
import {
  createHarness,
  input,
  paytBody,
  paytFixture,
} from "./payt-ingestion-harness";

const paid = () => paytFixture("order-paid.sanitized.json");
const waiting = () => paytFixture("order-nonpaid.sanitized.json");
const lostCart = () => ({
  ...waiting(),
  status: "lost_cart",
  transaction: undefined,
});

describe("Payt postback on the rule URL (Fase 4a)", () => {
  it("uses the Payt parser for a rule bound to a WhatsApp connection", async () => {
    const harness = createHarness({ eventName: "Purchase", payt: true });

    const accepted = await harness.service.ingest(input(paytBody(paid())));

    expect(accepted).toMatchObject({
      status: "accepted",
      duplicate: false,
      observationStatus: "observed",
    });
    expect(
      harness.conversionObservation.observeAutomation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        automation: expect.objectContaining({
          provider: "payt",
          eventName: "Purchase",
          externalExecutionKey: buildProviderPurchaseIdentity({
            workspaceId: "workspace_safe",
            provider: "payt",
            accountRef: "455QA2",
            orderRef: "PAYTS2",
            eventName: "Purchase",
          }),
          valueCents: 233331,
          // A Payt não declara moeda: a da regra ou a do workspace decide depois.
          currency: null,
        }),
      }),
    );
    const delivery = [...harness.deliveries.values()][0]!;
    expect(delivery).toMatchObject({
      provider: "uazapi",
      parserVersion: "automation-v1",
      purpose: "conversion_automation",
      status: "processed",
    });
    expect(JSON.stringify(delivery.normalizedSummary)).not.toMatch(
      /11999999999|integration_key|REDACTED/,
    );
  });

  it("refuses the Payt URL when the stored parser release is retired", async () => {
    const harness = createHarness({ eventName: "Purchase", payt: true });
    harness.endpoint.providerRule.parserRelease.status = "retired" as never;

    await expect(
      harness.service.ingest(input(paytBody(paid()))),
    ).rejects.toThrow("Webhook nao encontrado");
    expect(harness.deliveries.size).toBe(0);
  });

  it.each([
    {
      rule: "Purchase",
      accepts: "paid",
      body: paid,
      automation: "purchase_paid",
    },
    {
      rule: "InitiateCheckout",
      accepts: "waiting_payment (Pix/boleto gerado)",
      body: waiting,
      automation: "checkout_waiting_payment",
    },
    {
      rule: "CartAbandoned",
      accepts: "lost_cart (beta)",
      body: lostCart,
      automation: "cart_abandoned",
    },
  ] as const)(
    "a $rule rule takes $accepts and ignores every other sale event",
    async ({ rule, body, automation }) => {
      const harness = createHarness({ eventName: rule, payt: true });

      const own = await harness.service.ingest(input(paytBody(body())));
      expect(own.observationStatus).not.toBe("ignored");
      expect(
        harness.conversionObservation.observeAutomation,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          automation: expect.objectContaining({ eventName: rule, automation }),
        }),
      );

      const others = [paid, waiting, lostCart].filter((other) => other !== body);
      for (const other of [
        ...others,
        () => ({ ...paid(), status: "refunded" }),
        () => ({ ...paid(), status: "canceled" }),
      ]) {
        const ignored = await harness.service.ingest(input(paytBody(other())));
        expect(ignored).toMatchObject({
          status: "accepted",
          observationStatus: "ignored",
        });
      }
      // Only the rule's own event ever reached the decision.
      expect(
        harness.conversionObservation.observeAutomation,
      ).toHaveBeenCalledTimes(1);
      const ignoredDeliveries = [...harness.deliveries.values()].filter(
        (delivery) => delivery.classification === "unsupported_event",
      );
      expect(ignoredDeliveries).toHaveLength(4);
      for (const delivery of ignoredDeliveries) {
        expect(delivery.status).toBe("processed");
        expect(delivery.parseErrorCode).toBe(
          rule === "Purchase"
            ? "payt_automation_v1_not_purchase"
            : "payt_automation_v1_event_not_in_rule",
        );
      }
    },
  );

  it("lists postbacks of another status or event as ignored, never invalid", async () => {
    const harness = createHarness({ eventName: "Purchase", payt: true });
    const refunded = await harness.service.ingest(
      input(paytBody({ ...paid(), status: "refunded" })),
    );
    const canceled = await harness.service.ingest(
      input(paytBody({ ...paid(), status: "canceled" })),
    );
    const checkout = await harness.service.ingest(input(paytBody(waiting())));
    const invalid = await harness.service.ingest(
      input(paytBody({ ...paid(), seller_id: "" })),
    );

    const audit = await harness.service.listAutomationCallbacks(
      "workspace_safe",
      "provider_rule_1",
    );

    for (const deliveryId of [
      refunded.deliveryId,
      canceled.deliveryId,
      checkout.deliveryId,
    ]) {
      expect(
        audit.items.find((item) => item.deliveryId === deliveryId),
      ).toMatchObject({
        status: "ignored",
        reasonCode: "payt_automation_v1_not_purchase",
        reprocessable: false,
      });
    }
    expect(
      audit.items.find((item) => item.deliveryId === invalid.deliveryId),
    ).toMatchObject({ status: "invalid_payload" });
    // Only the real invalid payload counts as invalid.
    expect(audit.summary).toMatchObject({ total: 4, invalid: 1 });
    // Audit classification only: nothing reached the decision.
    expect(
      harness.conversionObservation.observeAutomation,
    ).not.toHaveBeenCalled();
  });

  it("lists an event outside an InitiateCheckout rule as ignored", async () => {
    const harness = createHarness({ eventName: "InitiateCheckout", payt: true });
    const purchase = await harness.service.ingest(input(paytBody(paid())));

    const audit = await harness.service.listAutomationCallbacks(
      "workspace_safe",
      "provider_rule_1",
    );

    expect(audit.items[0]).toMatchObject({
      deliveryId: purchase.deliveryId,
      status: "ignored",
      reasonCode: "payt_automation_v1_event_not_in_rule",
    });
    expect(audit.summary).toMatchObject({ total: 1, invalid: 0 });
  });

  it("keeps a sale without seller/order identity as an invalid payload", async () => {
    const harness = createHarness({ eventName: "Purchase", payt: true });
    const noSeller = await harness.service.ingest(
      input(paytBody({ ...paid(), seller_id: "" })),
    );
    expect(noSeller.observationStatus).toBe("invalid_payload");
    expect([...harness.deliveries.values()][0]).toMatchObject({
      status: "failed",
      classification: "invalid_payload",
      parseErrorCode: "payt_purchase_identity_missing",
    });
    expect(
      harness.conversionObservation.observeAutomation,
    ).not.toHaveBeenCalled();
  });

  it("refuses a sale declared in a currency outside BRL/USD/EUR, with a clear reason (Fase 5.1)", async () => {
    const harness = createHarness({
      eventName: "Purchase",
      payt: true,
      production: true,
    });
    const result = await harness.service.ingest(
      input(paytBody({ ...(paid() as Record<string, unknown>), currency: "GBP" })),
    );
    expect(result.observationStatus).toBe("invalid_payload");
    expect([...harness.deliveries.values()][0]).toMatchObject({
      status: "failed",
      classification: "invalid_payload",
      parseErrorCode: "payt_currency_unsupported",
    });
    expect(
      harness.conversionObservation.observeAutomation,
    ).not.toHaveBeenCalled();
    expect(harness.decisions.size).toBe(0);
  });

  it("collapses a duplicate postback of the same sale into one delivery and one conversion", async () => {
    const harness = createHarness({
      eventName: "Purchase",
      payt: true,
      production: true,
    });
    const first = await harness.service.ingest(input(paytBody(paid())));
    // Payt resends the same order later (other timestamps, n8n envelope):
    // the sale identity (seller + order + event) is the same.
    const resent = await harness.service.ingest(
      input(paytBody({ ...paid(), updated_at: "2024-11-22 16:00:00" })),
    );
    const envelope = await harness.service.ingest(
      input(paytBody(paytFixture("order-paid-n8n-envelope.sanitized.json"))),
    );

    expect(first).toMatchObject({ duplicate: false });
    for (const retry of [resent, envelope]) {
      expect(retry).toMatchObject({
        deliveryId: first.deliveryId,
        duplicate: true,
        observationStatus: "duplicate",
      });
    }
    expect(harness.deliveries.size).toBe(1);
    expect([...harness.deliveries.values()][0]!.attemptCount).toBe(3);
    expect(harness.decisions.size).toBe(1);
    expect(harness.executions.size).toBe(1);
  });

  it("keeps the Purchase and the checkout of the same order as two distinct sales", () => {
    const identity = (eventName: string) =>
      buildProviderPurchaseIdentity({
        workspaceId: "workspace_safe",
        provider: "payt",
        accountRef: "455QA2",
        orderRef: "PAYTS2",
        eventName,
      });
    expect(identity("Purchase")).not.toBe(identity("InitiateCheckout"));
    expect(identity("InitiateCheckout")).not.toBe(identity("CartAbandoned"));
  });

  it("reports a sale already recognized by another delivery as a duplicate", async () => {
    const harness = createHarness({ eventName: "Purchase", payt: true });
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce({
      decisionId: "decision_other",
      decisionCode: "eligible",
      reasonCode: "purchase_duplicate",
      disposition: "ignored",
      executionId: "execution_winner",
      eligibleExecutionId: null,
      reviewId: null,
      channelId: "channel_1",
      leadResolved: true,
    });

    const accepted = await harness.service.ingest(input(paytBody(paid())));
    expect(accepted).toMatchObject({
      duplicate: true,
      observationStatus: "duplicate",
    });
    expect(
      harness.productionQueue.enqueueProviderConversion,
    ).not.toHaveBeenCalled();
  });
});

// Ported from the SaaS (6f9c229, 7ac17df): Payt reprocess and approvals.
describe("Payt callbacks blocked by buyer/lead phone matching", () => {
  const channelBlock: ProviderConversionAutomationObservationResult = {
    decisionId: null,
    decisionCode: null,
    reasonCode: "payt_channel_missing_or_ambiguous",
    disposition: "blocked",
    executionId: null,
    eligibleExecutionId: null,
    reviewId: null,
    channelId: null,
    leadResolved: false,
  };

  it("lists the callback as blocked and re-evaluates it from scratch on reprocess", async () => {
    const harness = createHarness({
      eventName: "Purchase",
      production: true,
      payt: true,
    });
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce(
      channelBlock,
    );

    const callback = await harness.service.ingest(input(paytBody(paid())));
    const audit = await harness.service.listAutomationCallbacks(
      "workspace_safe",
      "provider_rule_1",
    );

    expect(callback.observationStatus).toBe("blocked");
    expect(audit.items[0]).toMatchObject({
      deliveryId: callback.deliveryId,
      status: "blocked",
      reasonCode: "payt_channel_missing_or_ambiguous",
      leadResolved: false,
      reprocessable: true,
    });
    expect(audit.summary).toMatchObject({
      total: 1,
      blocked: 1,
      invalid: 0,
      recoverable: 1,
    });

    const replay = await harness.service.reprocessSelectedCallbacks(
      "workspace_safe",
      "provider_rule_1",
      [callback.deliveryId],
      "manager_1",
    );

    expect(
      harness.conversionObservation.observeAutomation,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deliveryId: callback.deliveryId,
        manualRecovery: true,
        automation: expect.objectContaining({ provider: "payt" }),
      }),
    );
    expect(replay).toMatchObject({ requested: 1, queued: 1, skipped: 0 });
    expect(
      harness.productionQueue.enqueueProviderConversion,
    ).toHaveBeenCalledTimes(1);
  });

  it("keeps other blocks and invalid payloads non-reprocessable", async () => {
    const harness = createHarness({
      eventName: "Purchase",
      production: true,
      payt: true,
    });
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce({
      ...channelBlock,
      reasonCode: "automation_rule_unavailable",
    });
    const otherBlock = await harness.service.ingest(input(paytBody(paid())));
    const invalid = await harness.service.ingest(
      input(paytBody({ status: "paid" })),
    );

    const audit = await harness.service.listAutomationCallbacks(
      "workspace_safe",
      "provider_rule_1",
    );

    expect(invalid.observationStatus).toBe("invalid_payload");
    for (const deliveryId of [otherBlock.deliveryId, invalid.deliveryId]) {
      expect(
        audit.items.find((item) => item.deliveryId === deliveryId),
      ).toMatchObject({ reprocessable: false, status: "invalid_payload" });
    }
    expect(audit.summary.recoverable).toBe(0);
  });
});

describe("Payt observation-mode reprocess and lead from another number", () => {
  const blocked: ProviderConversionAutomationObservationResult = {
    decisionId: null,
    decisionCode: null,
    reasonCode: "payt_channel_missing_or_ambiguous",
    disposition: "blocked",
    executionId: null,
    eligibleExecutionId: null,
    reviewId: null,
    channelId: null,
    leadResolved: false,
  };

  it("re-evaluates selected callbacks while the rule is in observation and never queues Meta", async () => {
    const harness = createHarness({ eventName: "Purchase", payt: true });
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce(
      blocked,
    );
    const callback = await harness.service.ingest(input(paytBody(paid())));
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce({
      decisionId: "decision_obs",
      decisionCode: "eligible",
      reasonCode: "automation_matched_observation",
      disposition: "observed",
      executionId: "execution_obs",
      eligibleExecutionId: null,
      reviewId: null,
      channelId: "channel_1",
      leadResolved: true,
    });

    const replay = await harness.service.reprocessSelectedCallbacks(
      "workspace_safe",
      "provider_rule_1",
      [callback.deliveryId],
      "manager_1",
    );

    expect(
      harness.conversionObservation.observeAutomation,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deliveryId: callback.deliveryId,
        manualRecovery: true,
        evaluationMode: expect.objectContaining({
          type: "reevaluate",
          recordInitialWhenMissing: true,
        }),
      }),
    );
    expect(replay).toMatchObject({
      requested: 1,
      queued: 0,
      observed: 1,
      items: [
        expect.objectContaining({
          status: "observed",
          executionId: "execution_obs",
        }),
      ],
    });
    expect(
      harness.productionQueue.enqueueProviderConversion,
    ).not.toHaveBeenCalled();
  });

  it("keeps the production reprocess gate for a production rule", async () => {
    const harness = createHarness({
      eventName: "Purchase",
      production: true,
      payt: true,
    });
    harness.endpoint.providerRule.parserRelease.status =
      "observation_only" as never;
    await expect(
      harness.service.reprocessSelectedCallbacks(
        "workspace_safe",
        "provider_rule_1",
        ["delivery_x"],
        "manager_1",
      ),
    ).rejects.toThrow(
      "Ative o envio automático da regra antes de reprocessar callbacks",
    );
  });

  it("lists a sale owned by another number as ignored, not invalid or ambiguous", async () => {
    const harness = createHarness({
      eventName: "Purchase",
      production: true,
      payt: true,
    });
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce({
      ...blocked,
      reasonCode: "payt_lead_other_channel",
      disposition: "ignored",
      leadResolved: true,
    });
    const callback = await harness.service.ingest(input(paytBody(paid())));
    const audit = await harness.service.listAutomationCallbacks(
      "workspace_safe",
      "provider_rule_1",
    );

    expect(audit.items[0]).toMatchObject({
      deliveryId: callback.deliveryId,
      status: "ignored",
      reasonCode: "payt_lead_other_channel",
      reprocessable: false,
    });
    expect(audit.summary).toMatchObject({ total: 1, invalid: 0, blocked: 0 });
  });
});

describe("Explicit production replay approval", () => {
  it("approves only the operator's production reprocess, never the webhook ingestion", async () => {
    const harness = createHarness({
      eventName: "Purchase",
      production: true,
      payt: true,
    });
    // Received before activation: recorded without a production execution.
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce({
      decisionId: "decision_pre",
      decisionCode: "eligible",
      reasonCode: "before_production_activation",
      disposition: "observed",
      executionId: null,
      eligibleExecutionId: null,
      reviewId: null,
      channelId: "channel_1",
      leadResolved: true,
    });

    const callback = await harness.service.ingest(input(paytBody(paid())));
    const ingestCall =
      harness.conversionObservation.observeAutomation.mock.calls[0]![0];
    expect(ingestCall).not.toHaveProperty("manualReplayApproval");
    expect(ingestCall.manualRecovery).toBeFalsy();

    await harness.service.reprocessSelectedCallbacks(
      "workspace_safe",
      "provider_rule_1",
      [callback.deliveryId],
      "manager_1",
    );

    expect(
      harness.conversionObservation.observeAutomation,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deliveryId: callback.deliveryId,
        manualRecovery: true,
        manualReplayApproval: {
          actorUserId: "manager_1",
          reason: "operator_reprocess",
        },
      }),
    );
  });

  it("never approves an observation-mode re-evaluation", async () => {
    const harness = createHarness({ eventName: "Purchase", payt: true });
    const callback = await harness.service.ingest(input(paytBody(paid())));

    await harness.service.reprocessSelectedCallbacks(
      "workspace_safe",
      "provider_rule_1",
      [callback.deliveryId],
      "manager_1",
    );

    const last =
      harness.conversionObservation.observeAutomation.mock.calls.at(-1)![0];
    expect(last.manualRecovery).toBe(true);
    expect(last).not.toHaveProperty("manualReplayApproval");
  });
});
