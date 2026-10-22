import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderConversionAutomationObservationResult } from "../../src/conversion-rules/provider-conversion-observation.service";
import {
  createHarness,
  input,
  paytBody as encodeBody,
  paytFixture,
} from "../fase4-payt/payt-ingestion-harness";

/**
 * Fase 5.0 — ported from the SaaS (`d88fc6c`, `f5f535b`, `6f5fcf0`,
 * `apps/api/test/inbound-conversion-automation-ingestion.test.ts`, block
 * "Payt resend of the same transaction with a different body"), including
 * the case of the URL única (`ingestRouted`, Fase 5.3).
 */
describe("Payt resend of the same transaction with a different body", () => {
  const paytBody = (
    overrides: { totalPrice?: number; updatedAt?: string } = {},
  ) => {
    const body = paytFixture("order-paid.sanitized.json");
    if (overrides.totalPrice !== undefined) {
      body.transaction.total_price = overrides.totalPrice;
      body.transaction.price_without_installments = overrides.totalPrice;
    }
    if (overrides.updatedAt !== undefined) {
      body.updated_at = overrides.updatedAt;
      body.transaction.updated_at = overrides.updatedAt;
    }
    return encodeBody(body);
  };
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
  const paytHarness = () =>
    createHarness({ eventName: "Purchase", production: true, payt: true });
  const storedBody = (
    harness: ReturnType<typeof createHarness>,
    deliveryId: string,
  ) => {
    const delivery = [...harness.deliveries.values()].find(
      (candidate) => candidate.id === deliveryId,
    )!;
    return JSON.parse(
      harness.encryption
        .decrypt(
          {
            encryptedPayload: delivery.encryptedPayload,
            payloadIv: delivery.payloadIv,
            payloadTag: delivery.payloadTag,
            encryptionKeyVersion: delivery.encryptionKeyVersion,
          },
          {
            workspaceId: delivery.workspaceId,
            connectionId: delivery.connectionId,
            deliveryId: delivery.id,
          },
        )
        .toString("utf8"),
    );
  };
  const lastObservedAutomation = (harness: ReturnType<typeof createHarness>) =>
    harness.conversionObservation.observeAutomation.mock.calls.at(-1)![0]
      .automation;
  const failWithSourceMismatch = (
    harness: ReturnType<typeof createHarness>,
    reasonCode = "provider_conversion_source_event_mismatch",
  ) => {
    const execution = [...harness.executions.values()][0]!;
    execution.status = "failed";
    execution.reasonCode = reasonCode;
    execution.normalizedResult = {
      ...execution.normalizedResult,
      technicalDelivery: { state: "failed_permanent", retryable: false },
    };
    return execution;
  };

  it("stores the resend body when no decision was frozen and observes exactly that body", async () => {
    const harness = paytHarness();
    // First postback stops at channel selection: no decision is frozen.
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce(
      channelBlock,
    );
    const first = await harness.service.ingest(input(paytBody()));
    expect(first.observationStatus).toBe("blocked");

    const resend = await harness.service.ingest(
      input(
        paytBody({ totalPrice: 300_000, updatedAt: "2024-11-22 15:21:10" }),
      ),
    );

    expect(resend).toMatchObject({
      deliveryId: first.deliveryId,
      duplicate: true,
    });
    expect(harness.deliveries.size).toBe(1);
    expect([...harness.deliveries.values()][0]!.attemptCount).toBe(2);
    // The decision and the payload production re-reads are the same body.
    expect(lastObservedAutomation(harness)).toMatchObject({
      provider: "payt",
      valueCents: 300_000,
    });
    expect(storedBody(harness, first.deliveryId).transaction.total_price).toBe(
      300_000,
    );
    expect(harness.decisions.size).toBe(1);
    expect(harness.executions.size).toBe(1);
    expect(
      harness.productionQueue.enqueueProviderConversion,
    ).toHaveBeenCalledTimes(1);

    // A later resend after the decision is frozen never swaps the body and
    // is observed from the stored one: still one execution, same value.
    await harness.service.ingest(
      input(
        paytBody({ totalPrice: 310_000, updatedAt: "2024-11-22 15:30:00" }),
      ),
    );
    expect(storedBody(harness, first.deliveryId).transaction.total_price).toBe(
      300_000,
    );
    expect(lastObservedAutomation(harness)).toMatchObject({
      valueCents: 300_000,
    });
    expect(harness.decisions.size).toBe(1);
    expect(harness.executions.size).toBe(1);
  });

  it("applies the same reconciliation to a resend routed by the URL única (Fase 5.3)", async () => {
    const harness = paytHarness();
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce(
      channelBlock,
    );
    const first = await harness.service.ingest(input(paytBody()));

    const routed = await harness.service.ingestRouted({
      workspaceId: "workspace_safe",
      providerRuleId: "provider_rule_1",
      rawBody: paytBody({ totalPrice: 300_000 }),
      providerAttempt: null,
      integrationEndpointId: "integration_endpoint_1",
    });

    expect(routed).toMatchObject({
      deliveryId: first.deliveryId,
      duplicate: true,
    });
    expect(storedBody(harness, first.deliveryId).transaction.total_price).toBe(
      300_000,
    );
    expect(lastObservedAutomation(harness)).toMatchObject({
      valueCents: 300_000,
    });
    expect(harness.executions.size).toBe(1);
  });

  it("observes the stored body while the first observation is still in flight", async () => {
    const harness = paytHarness();
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce(
      channelBlock,
    );
    const first = await harness.service.ingest(input(paytBody()));
    const delivery = [...harness.deliveries.values()][0]!;
    delivery.normalizedSummary = {
      ...delivery.normalizedSummary,
      executionStatus: "decision_pending",
    };

    await harness.service.ingest(input(paytBody({ totalPrice: 300_000 })));

    expect(storedBody(harness, first.deliveryId).transaction.total_price).toBe(
      296_616,
    );
    expect(lastObservedAutomation(harness)).toMatchObject({
      valueCents: 233_331,
    });
  });

  it("keeps an identical resend a plain duplicate", async () => {
    const harness = paytHarness();
    const first = await harness.service.ingest(input(paytBody()));
    const ciphertext = [...harness.deliveries.values()][0]!.encryptedPayload;

    const again = await harness.service.ingest(input(paytBody()));

    expect(again).toMatchObject({
      deliveryId: first.deliveryId,
      duplicate: true,
      observationStatus: "duplicate",
    });
    expect([...harness.deliveries.values()][0]!.encryptedPayload).toBe(
      ciphertext,
    );
    expect(harness.deliveries.size).toBe(1);
    expect(harness.decisions.size).toBe(1);
    expect(harness.executions.size).toBe(1);
  });

  it("recovers a source-event mismatch on reprocess with a fresh decision from the stored body", async () => {
    const harness = paytHarness();
    const callback = await harness.service.ingest(input(paytBody()));
    const execution = failWithSourceMismatch(harness);

    const audit = await harness.service.listAutomationCallbacks(
      "workspace_safe",
      "provider_rule_1",
    );
    expect(audit.items[0]).toMatchObject({
      status: "failed",
      reprocessable: true,
    });
    expect(audit.summary.recoverable).toBe(1);

    const replay = await harness.service.reprocessSelectedCallbacks(
      "workspace_safe",
      "provider_rule_1",
      [callback.deliveryId],
      "manager_1",
    );

    const call =
      harness.conversionObservation.observeAutomation.mock.calls.at(-1)![0];
    expect(call).toMatchObject({
      deliveryId: callback.deliveryId,
      manualRecovery: true,
      evaluationMode: {
        type: "reevaluate",
        requestKey: expect.stringMatching(
          new RegExp(`^source-mismatch-reprocess:${execution.id}:`, "u"),
        ),
      },
      manualReplayApproval: {
        actorUserId: "manager_1",
        reason: "operator_reprocess",
      },
      automation: expect.objectContaining({ valueCents: 233_331 }),
    });
    expect(replay).toMatchObject({ requested: 1, queued: 1, skipped: 0 });
    expect(execution.status).toBe("eligible");
    expect(harness.executions.size).toBe(1);
  });

  it("heals a source-event mismatch when the provider resends the body that matches", async () => {
    const harness = paytHarness();
    // Incident shape: the stored body is #1, the frozen decision came from
    // another body and production failed comparing them.
    const callback = await harness.service.ingest(input(paytBody()));
    const execution = failWithSourceMismatch(harness);
    const enqueued =
      harness.productionQueue.enqueueProviderConversion.mock.calls.length;

    await harness.service.ingest(
      input(
        paytBody({ totalPrice: 300_000, updatedAt: "2024-11-22 15:40:00" }),
      ),
    );

    expect(
      storedBody(harness, callback.deliveryId).transaction.total_price,
    ).toBe(300_000);
    const call =
      harness.conversionObservation.observeAutomation.mock.calls.at(-1)![0];
    expect(call).toMatchObject({
      deliveryId: callback.deliveryId,
      evaluationMode: {
        type: "reevaluate",
        requestKey: expect.stringMatching(
          new RegExp(`^source-mismatch-resend:${execution.id}:`, "u"),
        ),
      },
      automation: expect.objectContaining({ valueCents: 300_000 }),
    });
    expect(call).not.toHaveProperty("manualReplayApproval");
    expect(execution.status).toBe("eligible");
    expect(harness.executions.size).toBe(1);
    expect(
      harness.productionQueue.enqueueProviderConversion.mock.calls.length,
    ).toBe(enqueued + 1);
  });

  it("limits the resend cure to Payt: another provider keeps the stored body once a decision exists", async () => {
    // SaaS `6f5fcf0`: an Unnichat resend of the same occurrence (same
    // external id, origin and phone) with a different body never replaces
    // the stored body of a failed mismatch, nor re-evaluates it.
    const harness = createHarness({
      eventName: "QualifiedLead",
      production: true,
      unnichat: true,
    });
    const movement = JSON.parse(
      readFileSync(
        resolve(
          __dirname,
          "../fase4-unnichat/fixtures/movement-with-ctwa.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const callback = await harness.service.ingest(
      input(encodeBody(movement)),
    );
    expect(harness.executions.size).toBe(1);
    failWithSourceMismatch(harness);

    await harness.service.ingest(
      input(encodeBody({ ...movement, resend_marker: "second-delivery" })),
    );

    expect(storedBody(harness, callback.deliveryId)).not.toHaveProperty(
      "resend_marker",
    );
    const call =
      harness.conversionObservation.observeAutomation.mock.calls.at(-1)![0];
    // The observation always forwards the key; no re-evaluation is asked.
    expect(call.evaluationMode).toBeUndefined();
  });

  it("explains a mismatch whose stored body cannot prove the purchase on reprocess", async () => {
    const harness = paytHarness();
    const callback = await harness.service.ingest(input(paytBody()));
    const execution = [...harness.executions.values()][0]!;
    execution.status = "failed";
    execution.reasonCode = "provider_conversion_source_event_mismatch";
    harness.conversionObservation.observeAutomation.mockResolvedValueOnce(
      channelBlock,
    );

    const replay = await harness.service.reprocessSelectedCallbacks(
      "workspace_safe",
      "provider_rule_1",
      [callback.deliveryId],
      "manager_1",
    );

    expect(replay.items[0]).toMatchObject({
      status: "blocked",
      reasonCode: "payt_channel_missing_or_ambiguous",
      message: expect.stringContaining("reenvie o postback"),
    });
    expect(
      harness.productionQueue.enqueueProviderConversion,
    ).toHaveBeenCalledTimes(1);
  });

  it("keeps every other permanent failure on its frozen decision", async () => {
    const harness = paytHarness();
    const callback = await harness.service.ingest(input(paytBody()));
    failWithSourceMismatch(
      harness,
      "provider_conversion_frozen_decision_invalid",
    );
    const observeCalls =
      harness.conversionObservation.observeAutomation.mock.calls.length;

    const replay = await harness.service.reprocessSelectedCallbacks(
      "workspace_safe",
      "provider_rule_1",
      [callback.deliveryId],
      "manager_1",
    );

    expect(replay.items[0]).toMatchObject({
      status: "skipped",
      reasonCode: "provider_conversion_frozen_decision_invalid",
    });
    expect(
      harness.conversionObservation.observeAutomation.mock.calls.length,
    ).toBe(observeCalls);
  });
});
