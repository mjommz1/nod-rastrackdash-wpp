import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The CTWA entry proof and destination authorization have their own suites
// (ctwa-lead-proof / unnichat-ctwa-*). Here they are stubbed to isolate the
// Pipedrive decision: which leads may use the CTWA page/pixel destination.
const proof = {
  kind: "authorized_ctwa_destination" as const,
  organizationId: "organization-a",
  providerChannelId: "provider-channel-a",
  credentialId: "credential-a",
  credentialFingerprint: "fingerprint-a",
  workspaceId: "workspace-a",
  channelId: "channel-a",
  connectionId: "unnichat-connection-a",
  businessConnectionId: "business-a",
  destinationId: "destination-a",
  deliveryKind: "page_pixel" as const,
  pixelId: "synthetic-pixel",
  pageId: "synthetic-page",
};
vi.mock("../src/conversion-rules/ctwa-lead-proof", () => ({
  resolveCtwaLeadProof: vi.fn(async () => proof),
}));
vi.mock(
  "../src/inbound-webhooks/authorized-ctwa-destination",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    ctwaIntentAuthorized: vi.fn(async () => true),
  }),
);

import { resolveCtwaLeadProof } from "../src/conversion-rules/ctwa-lead-proof";
import {
  PIPEDRIVE_CTWA_PROCESSING_MODE,
  pipedriveCtwaConversionAuthorized,
} from "../src/pipedrive/pipedrive-production-policy";
import {
  productionEnv,
  productionHarness,
} from "./support/pipedrive-production-harness";
import { ruleInput } from "./support/pipedrive-observation-harness";
import { actor } from "./support/pipedrive-harness";

// The harness clock is fixed (pipedrive-observation-harness), but the CTWA
// seven day Meta window in ConversionEventsService reads the system clock.
// Pin the system clock to the harness instant so the fixture never ages out.
const HARNESS_INSTANT = new Date("2026-10-11T18:00:05Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(HARNESS_INSTANT);
  productionEnv();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.mocked(resolveCtwaLeadProof).mockClear();
});

async function ctwaLead(field: "adId" | "none" = "adId") {
  const h = await productionHarness();
  await h.webhooks.createRule("workspace-a", h.c.id, actor, {
    ...ruleInput,
    mode: "production",
  });
  h.setNow(new Date(+h.now + 1000));
  // CTWA lead (Unnichat) without a known ad: no ad id, no WhatsApp number route.
  Object.assign(h.state.lead![0]!, {
    adId: null,
    campaignId: null,
    adSetId: null,
    ...(field === "adId" ? { whatsappInstanceId: null } : {}),
  });
  return h;
}

describe("Pipedrive conversion for a CTWA lead uses the CTWA destination path", () => {
  it("materializes with the proven page/pixel destination, never an ad route", async () => {
    const h = await ctwaLead();
    const event = await h.receive();
    expect(await h.webhooks.process(event.id, "workspace-a")).toMatchObject({
      status: "materialized",
    });
    expect(resolveCtwaLeadProof).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: "workspace-a",
        leadId: "lead-a",
        ctwaClid: "synthetic-existing-ctwa",
      }),
    );
    const log = h.state.conversionEventLog![0]!;
    expect(log).toMatchObject({
      sourceTrigger: "pipedrive_stage",
      adId: null,
      campaignId: null,
      metaAccountId: null,
      metaConversionDestinationId: "destination-a",
      attributionStatus: "ctwa_ad_unknown",
    });
    expect(log.sourcePayload).toMatchObject({
      ctwaDestination: proof,
      processingMode: PIPEDRIVE_CTWA_PROCESSING_MODE,
      channelId: "channel-a",
      connectionId: "unnichat-connection-a",
      pipedriveConnectionId: h.c.id,
    });
    const ledger = h.state.pipedriveConversionDedupe!.find(
      (row) => row.mode === "production",
    )!;
    expect(ledger.publicationIntent).toEqual({
      kind: "ctwa_destination",
      pipedriveConnectionId: h.c.id,
      channelId: "channel-a",
      connectionId: "unnichat-connection-a",
      destinationId: "destination-a",
      eventId: log.eventId,
    });
    // Outbox enqueues the canonical send; the CRM ad-route sender is not used.
    await h.webhooks.sweep();
    expect(h.jobs.get(log.id)).toBe("workspace-a");
    expect(h.state.pipedriveConversionDedupe!.find((r) => r.mode === "production"))
      .toMatchObject({ publicationStatus: "queued" });
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("refuses the CTWA destination when the proof channel is not bound to the connection", async () => {
    const h = await ctwaLead();
    vi.mocked(resolveCtwaLeadProof).mockResolvedValueOnce({
      ...proof,
      channelId: "other-channel",
    });
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    expect(h.state.pipedriveWebhookEvent![0]).toMatchObject({
      status: "ignored",
      errorCode: "lead_channel_route_unauthorized",
    });
    expect(h.state.conversionEventLog).toHaveLength(0);
  });

  it("never uses the CTWA path for a lead with an ad id (ad route required)", async () => {
    const h = await ctwaLead("none");
    h.state.lead![0]!.adId = "ad-a";
    h.client.metaAdDestinationAssignment.findUnique.mockResolvedValue(null);
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    expect(resolveCtwaLeadProof).not.toHaveBeenCalled();
    expect(h.state.pipedriveWebhookEvent![0]!.results[0]).toMatchObject({
      status: "ignored",
      errorCode: "lead_destination_unproven",
    });
  });

  it("the CTWA sender authorization requires this exact ledger row, an active connection and the binding", async () => {
    const h = await ctwaLead();
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    const log = h.state.conversionEventLog![0]!;
    expect(await pipedriveCtwaConversionAuthorized(h.client, log, proof)).toBe(
      true,
    );
    expect(
      await pipedriveCtwaConversionAuthorized(h.client, log, {
        ...proof,
        destinationId: "other",
      }),
    ).toBe(false);
    h.state.pipedriveConnection![0]!.status = "paused";
    expect(await pipedriveCtwaConversionAuthorized(h.client, log, proof)).toBe(
      false,
    );
    h.state.pipedriveConnection![0]!.status = "active";
    // Student edition: no SaaS environment opt-in; production follows the
    // rule. Unbinding the number revokes the committed CTWA conversion.
    expect(await pipedriveCtwaConversionAuthorized(h.client, log, proof)).toBe(
      true,
    );
    h.state.pipedriveConnection![0]!.allowedChannelRouteIds = [];
    expect(await pipedriveCtwaConversionAuthorized(h.client, log, proof)).toBe(
      false,
    );
  });

  // Rule of the student edition: ctwa_clid is mandatory. Without it nothing
  // is materialized, published or sent to Meta, with or without an ad id.
  it.each([
    ["without an ad id", null],
    ["with an ad id", "ad-a"],
  ])("without ctwa_clid nothing is sent (lead %s)", async (_label, adId) => {
    const h = await ctwaLead("none");
    Object.assign(h.state.lead![0]!, { adId, ctwaClid: null });
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    await h.webhooks.sweep();
    expect(resolveCtwaLeadProof).not.toHaveBeenCalled();
    expect(h.state.pipedriveWebhookEvent![0]!.results[0]).toMatchObject({
      status: "ignored",
      errorCode: "lead_channel_or_attribution_unproven",
    });
    expect(h.state.conversionEventLog).toHaveLength(0);
    expect(
      h.state.pipedriveConversionDedupe!.filter((r) => r.mode === "production"),
    ).toHaveLength(0);
    expect(h.jobs.size).toBe(0);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});
