import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The canonical page/pixel resolver has its own suites (unnichat-ctwa-*).
// Here it is stubbed so only the Pipedrive binding decision is exercised:
// a verified inherit_workspace Unnichat number resolves, anything else does not.
vi.mock(
  "../src/inbound-webhooks/authorized-ctwa-destination",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    resolveCtwaDestination: vi.fn(async (_client: unknown, channel: any) =>
      channel.metaRoutingMode === "inherit_workspace" &&
      channel.connection?.provider === "unnichat"
        ? {
            kind: "authorized_ctwa_destination",
            deliveryKind: "page_pixel",
            workspaceId: channel.workspaceId,
            channelId: channel.id,
            connectionId: channel.connectionId,
            organizationId: channel.organizationId,
            providerChannelId: channel.providerChannelId,
            destinationId: "destination-a",
            businessConnectionId: "business-a",
            credentialId: "credential-a",
            credentialFingerprint: "fingerprint-a",
            pixelId: "synthetic-pixel",
            pageId: "synthetic-page",
          }
        : {
            kind: "blocked_ctwa_destination",
            reason: "ctwa_verified_binding_missing",
          },
    ),
  }),
);

import { pipedriveChannelBindingMessages } from "@wpptrack/shared";
import { ConversionEventProcessor } from "../src/common/queue/conversion-event.processor";
import { hashPhoneIdentity } from "../src/common/phone/phone-identity";
import { actor, createInput, pipedriveHarness } from "./support/pipedrive-harness";
import { ruleInput } from "./support/pipedrive-observation-harness";
import {
  productionEnv,
  productionHarness,
} from "./support/pipedrive-production-harness";

const key = Buffer.alloc(32, 7).toString("base64");
afterEach(() => vi.unstubAllEnvs());

/** An official-API number (no WhatsApp instance) of the workspace. */
function officialApiRoute(route: any, provider = "gupshup") {
  route.channel.whatsappInstanceId = null;
  route.channel.whatsappInstance = null;
  route.channel.connection.provider = provider;
}

function inheritingNumber(patch: any = {}, connection: any = {}) {
  return {
    id: "channel-unnichat",
    workspaceId: "workspace-a",
    connectionId: "unnichat-connection-a",
    organizationId: "organization-a",
    providerChannelId: "provider-channel-a",
    connectedPhone: "5511999990000",
    status: "active",
    productionActivatedAt: new Date(),
    metaRoutingMode: "inherit_workspace",
    whatsappInstanceId: null,
    whatsappInstance: null,
    routes: [],
    ...patch,
    connection: {
      id: "unnichat-connection-a",
      workspaceId: "workspace-a",
      provider: "unnichat",
      status: "production",
      productionActivatedAt: new Date(),
      removedAt: null,
      parserRelease: { status: "certified" },
      ...connection,
    },
  };
}

describe("Pipedrive authorizes any production WhatsApp number of the workspace", () => {
  beforeEach(() => vi.stubEnv("PIPEDRIVE_CRM_ENCRYPTION_KEY", key));

  it("connects a Gupshup (official API) number with an explicit valid route", async () => {
    const h = pipedriveHarness();
    officialApiRoute(h.route);
    const result = await h.service.create("workspace-a", actor, createInput);
    expect(result.allowedChannelRouteIds).toEqual(["route-a"]);
    expect(h.state.pipedriveConnection).toHaveLength(1);
  });

  it("connects an Unnichat number inheriting the verified workspace page/pixel, bound by channel", async () => {
    const h = pipedriveHarness();
    h.channels.push(inheritingNumber());
    const result = await h.service.create("workspace-a", actor, {
      ...createInput,
      allowedChannelRouteIds: ["channel-unnichat"],
    });
    expect(result.allowedChannelRouteIds).toEqual(["channel-unnichat"]);
    // Route and channel bindings can be mixed on the same connection.
    const updated = await h.service.setChannelBindings(
      "workspace-a",
      result.id,
      actor,
      ["route-a", "channel-unnichat"],
    );
    expect(updated.allowedChannelRouteIds).toEqual([
      "route-a",
      "channel-unnichat",
    ]);
  });

  it("keeps the UAZAPI instance requirement unchanged", async () => {
    const h = pipedriveHarness();
    h.route.channel.connection.provider = "uazapi";
    expect(
      (await h.service.create("workspace-a", actor, createInput))
        .allowedChannelRouteIds,
    ).toEqual(["route-a"]);
    for (const patch of [
      { whatsappInstanceId: null, whatsappInstance: null },
      { whatsappInstance: { workspaceId: "workspace-a", status: "disconnected" } },
    ]) {
      const other = pipedriveHarness();
      other.route.channel.connection.provider = "uazapi";
      Object.assign(other.route.channel, patch);
      await expect(
        other.service.create("workspace-a", actor, createInput),
      ).rejects.toMatchObject({
        status: 400,
        message: pipedriveChannelBindingMessages.whatsapp_disconnected,
      });
      expect(other.adapter.verify).not.toHaveBeenCalled();
    }
  });

  it.each([
    [
      "paused number",
      (h: any): void => void (h.route.channel.status = "paused"),
      "number_paused",
    ],
    [
      "paused provider connection",
      (h: any): void => void (h.route.channel.connection.status = "paused"),
      "number_paused",
    ],
    [
      "number still in observation",
      (h: any): void => void (h.route.channel.connection.status = "observation"),
      "number_not_in_production",
    ],
    [
      "number never activated",
      (h: any): void => void (h.route.channel.productionActivatedAt = null),
      "number_not_in_production",
    ],
    [
      "uncertified provider parser",
      (h: any): void => void (h.route.channel.connection.parserRelease.status = "draft"),
      "provider_not_certified",
    ],
    [
      "invalid route",
      (h: any): void => void (h.route.validationStatus = "invalid"),
      "meta_destination_unverified",
    ],
    [
      "unconfigured Meta destination",
      (h: any): void => void (h.route.metaConversionDestination.status = "pending"),
      "meta_destination_unverified",
    ],
    [
      "foreign route",
      (h: any): void => void (h.route.workspaceId = "workspace-b"),
      "number_not_found",
    ],
  ] as const)(
    "rejects a Gupshup number with a specific reason: %s",
    async (_label, mutate, reason) => {
      const h = pipedriveHarness();
      officialApiRoute(h.route);
      mutate(h);
      await expect(
        h.service.create("workspace-a", actor, createInput),
      ).rejects.toMatchObject({
        status: 400,
        message: pipedriveChannelBindingMessages[reason],
        response: { code: `pipedrive_channel_${reason}` },
      });
      expect(h.state.pipedriveConnection).toHaveLength(0);
      expect(h.adapter.verify).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "Gupshup number without route nor verified page/pixel",
      inheritingNumber({}, { provider: "gupshup" }),
      "meta_destination_unverified",
    ],
    [
      "Unnichat number with an unset routing mode",
      inheritingNumber({ metaRoutingMode: null }),
      "meta_destination_unverified",
    ],
    [
      "paused inheriting number",
      inheritingNumber({ status: "paused" }),
      "number_paused",
    ],
    [
      "inheriting number not in production",
      inheritingNumber({}, { status: "observation" }),
      "number_not_in_production",
    ],
    [
      "inheriting number of another workspace",
      inheritingNumber({ workspaceId: "workspace-b" }),
      "number_not_found",
    ],
  ] as const)(
    "rejects a channel binding with a specific reason: %s",
    async (_label, channel, reason) => {
      const h = pipedriveHarness();
      h.channels.push(channel);
      await expect(
        h.service.create("workspace-a", actor, {
          ...createInput,
          allowedChannelRouteIds: ["channel-unnichat"],
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: pipedriveChannelBindingMessages[reason],
      });
      expect(h.state.pipedriveConnection).toHaveLength(0);
    },
  );
});

describe("Pipedrive production for a lead of an official-API number", () => {
  beforeEach(productionEnv);
  afterEach(() => vi.restoreAllMocks());

  async function gupshup(withEntryReceipt: boolean) {
    const h = await productionHarness();
    officialApiRoute(h.route);
    h.state.lead![0]!.whatsappInstanceId = null;
    if (withEntryReceipt)
      h.state.conversionEventLog!.push({
        id: "entry-log-a",
        workspaceId: "workspace-a",
        leadId: "lead-a",
        phoneHash: hashPhoneIdentity("5500000000000"),
        eventName: "LeadSubmitted",
        sourceTrigger: "inbound_webhook:gupshup",
        dedupeKey: "inbound-webhook:gupshup-connection-a:entry",
        status: "sent",
        sourcePayload: {
          provider: "gupshup",
          connectionId: "gupshup-connection-a",
          inboundEventId: "inbound-event-a",
          channelId: "channel-a",
          processingMode: "live_production",
        },
      });
    // Materialized receipt of that inbound entry (production item).
    h.client.inboundWebhookEvent = {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === "inbound-event-a" &&
        where.channelId === "channel-a" &&
        where.connectionId === "gupshup-connection-a" &&
        where.OR?.[0]?.productionItem?.is?.conversionEventLogId ===
          "entry-log-a"
          ? { id: "inbound-event-a" }
          : null,
      ),
    };
    await h.webhooks.createRule("workspace-a", h.c.id, actor, {
      ...ruleInput,
      mode: "production",
    });
    h.setNow(new Date(+h.now + 1000));
    return h;
  }

  it("matches the lead by its proven entry on the Gupshup number and sends through the route", async () => {
    const h = await gupshup(true);
    const event = await h.receive();
    expect(await h.webhooks.process(event.id, "workspace-a")).toMatchObject({
      status: "materialized",
    });
    const log = h.state.conversionEventLog!.find(
      (row) => row.sourceTrigger === "pipedrive_stage",
    )!;
    expect(log).toMatchObject({ leadId: "lead-a", adId: "ad-a" });
    const ledger = h.state.pipedriveConversionDedupe!.find(
      (row) => row.mode === "production",
    )!;
    expect(ledger.publicationIntent).toMatchObject({
      routeId: "route-a",
      channelId: "channel-a",
      whatsappInstanceId: null,
    });
    await h.webhooks.sweep();
    const processor = new ConversionEventProcessor(h.conversions, h.client);
    expect(
      await processor.process({
        id: "synthetic-job",
        name: "send-ready-event",
        data: { conversionEventLogId: log.id, workspaceId: "workspace-a" },
        attemptsMade: 0,
      } as any),
    ).toMatchObject({ status: "sent" });
    expect(h.fetcher).toHaveBeenCalledOnce();
  });

  it("does not match a lead that never entered through the bound number", async () => {
    const h = await gupshup(false);
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    expect(h.state.pipedriveWebhookEvent![0]).toMatchObject({
      status: "ignored",
      errorCode: "lead_channel_route_unauthorized",
    });
    expect(
      h.state.conversionEventLog!.some(
        (row) => row.sourceTrigger === "pipedrive_stage",
      ),
    ).toBe(false);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("revokes the send when the Gupshup number is paused after materialization", async () => {
    const h = await gupshup(true);
    const event = await h.receive();
    await h.webhooks.process(event.id, "workspace-a");
    const log = h.state.conversionEventLog!.find(
      (row) => row.sourceTrigger === "pipedrive_stage",
    )!;
    h.route.channel.status = "paused";
    await h.webhooks.sweep();
    await h.conversions
      .sendReadyEvent(log.id, { workspaceId: "workspace-a" })
      .catch(() => undefined);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});
