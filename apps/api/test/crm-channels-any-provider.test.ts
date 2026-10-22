import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The canonical page/pixel resolver (CRM mode included) has its own suite
// (crm-ctwa-destination-any-provider). Here it is stubbed so only the CRM
// decisions are exercised: an inherit_workspace number of a non-UAZAPI
// provider resolves the unique page/pixel, unless the pair is ambiguous.
const flags = vi.hoisted(() => ({ ambiguous: false }));
vi.mock(
  "../src/inbound-webhooks/authorized-ctwa-destination",
  async (importOriginal) => {
    const actual = await importOriginal<object>();
    const resolve = async (_client: unknown, channel: any, options: any = {}) => {
      const provider = channel.connection?.provider;
      const crm =
        options.crmAnyProvider === true &&
        provider !== "uazapi" &&
        !channel.whatsappInstanceId;
      if (
        (provider !== "unnichat" && !crm) ||
        channel.metaRoutingMode !== "inherit_workspace" ||
        channel.status === "paused"
      )
        return {
          kind: "blocked_ctwa_destination",
          reason: "ctwa_channel_scope_invalid",
        };
      if (flags.ambiguous)
        return {
          kind: "blocked_ctwa_destination",
          reason: "ctwa_destination_ambiguous",
        };
      return {
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
      };
    };
    return {
      ...actual,
      resolveCtwaDestination: vi.fn(resolve),
      ctwaIntentAuthorized: vi.fn(async () => !flags.ambiguous),
    };
  },
);

import {
  kommoChannelBindingMessages,
  pipedriveChannelBindingMessages,
} from "@wpptrack/shared";
import { hashPhoneIdentity } from "../src/common/phone/phone-identity";
import {
  KOMMO_CTWA_PROCESSING_MODE,
  kommoCtwaConversionAuthorized,
  kommoPublicationAuthorized,
} from "../src/kommo/kommo-publication-policy";
import { pipedriveCtwaConversionAuthorized } from "../src/pipedrive/pipedrive-production-policy";
import { kommoHarness } from "./support/kommo-stateful-harness";
import { actor, createInput, pipedriveHarness } from "./support/pipedrive-harness";
import { ruleInput } from "./support/pipedrive-observation-harness";
import {
  productionEnv,
  productionHarness,
} from "./support/pipedrive-production-harness";

afterEach(() => {
  flags.ambiguous = false;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** A Gupshup (official API) number inheriting the workspace page/pixel. */
function gupshupNumber(id = "channel-gupshup", patch: any = {}) {
  return {
    id,
    workspaceId: "workspace-a",
    connectionId: "gupshup-connection-a",
    organizationId: "organization-a",
    providerChannelId: `provider-${id}`,
    connectedPhone: "5511999990000",
    status: "active",
    productionActivatedAt: new Date("2026-10-01T00:00:00Z"),
    metaRoutingMode: "inherit_workspace",
    whatsappInstanceId: null,
    whatsappInstance: null,
    routes: [],
    ...patch,
    connection: {
      id: "gupshup-connection-a",
      workspaceId: "workspace-a",
      provider: "gupshup",
      status: "production",
      productionActivatedAt: new Date("2026-10-01T00:00:00Z"),
      removedAt: null,
      parserRelease: { status: "certified" },
    },
  };
}

/** Channel table returning full rows (with includes) by id. */
function channelTable(channels: any[]) {
  const pick = (where: any) =>
    channels.filter(
      (row) =>
        (where?.id?.in ? where.id.in.includes(row.id) : row.id === where?.id) &&
        row.workspaceId === where.workspaceId,
    );
  return {
    findFirst: vi.fn(async ({ where }: any) =>
      structuredClone(pick(where)[0] ?? null),
    ),
    findMany: vi.fn(async ({ where }: any) => structuredClone(pick(where))),
  };
}

/** Materialized inbound entry (LeadSubmitted) of a lead on a number. */
function entryReceipt(
  logs: any[],
  input: {
    leadId: string;
    phoneHash: string;
    ctwaClid: string;
    channelId: string;
  },
) {
  const id = `entry-log-${input.channelId}`;
  logs.push({
    id,
    workspaceId: "workspace-a",
    leadId: input.leadId,
    phoneHash: input.phoneHash,
    ctwaClid: input.ctwaClid,
    eventName: "LeadSubmitted",
    sourceTrigger: "inbound_webhook:gupshup",
    dedupeKey: `inbound-webhook:gupshup:${input.channelId}`,
    status: "sent",
    sourcePayload: {
      provider: "gupshup",
      connectionId: "gupshup-connection-a",
      inboundEventId: `inbound-${input.channelId}`,
      channelId: input.channelId,
      processingMode: "live_production",
    },
  });
}

/** Production item receipt lookup of the entries seeded above. */
function receiptEvents() {
  return {
    findFirst: vi.fn(async ({ where }: any) =>
      where.id === `inbound-${where.channelId}` &&
      where.connectionId === "gupshup-connection-a" &&
      where.OR?.[0]?.productionItem?.is?.conversionEventLogId ===
        `entry-log-${where.channelId}`
        ? { id: where.id }
        : null,
    ),
  };
}

describe("Kommo with a Gupshup number bound by an explicit route", () => {
  function gupshupRoute() {
    const h = kommoHarness();
    const route = h.state.inboundWebhookChannelRoute[0];
    route.channelId = "channel-a";
    route.channel.whatsappInstanceId = null;
    route.channel.whatsappInstance = null;
    route.channel.connection.provider = "gupshup";
    const lead = h.state.lead[0];
    lead.whatsappInstanceId = null;
    h.prisma.inboundWebhookEvent = receiptEvents();
    return { h, lead };
  }

  it("authorizes the route and materializes the lead proven by its entry receipt", async () => {
    const { h, lead } = gupshupRoute();
    await h.service.setChannelBindings(
      "workspace-a",
      h.connection.id,
      "owner-a",
      ["route-a"],
    );
    entryReceipt(h.state.conversionEventLog, {
      leadId: lead.id,
      phoneHash: lead.phoneHash,
      ctwaClid: "trusted-click",
      channelId: "channel-a",
    });
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    const log = h.state.conversionEventLog.find(
      (row: any) => row.sourceTrigger === "kommo_stage",
    );
    expect(log).toMatchObject({ leadId: lead.id, adId: "ad-a" });
    const ledger = h.state.kommoConversionDedupe[0];
    expect(ledger.publicationIntent).toMatchObject({
      routeId: "route-a",
      channelId: "channel-a",
      whatsappInstanceId: null,
      pixelId: "synthetic-pixel",
      pageId: "synthetic-page",
    });
    expect(
      await kommoPublicationAuthorized(
        h.prisma,
        "workspace-a",
        ledger.publicationIntent,
      ),
    ).toBe(true);
    // Pausing the number revokes the committed publication.
    h.state.inboundWebhookChannelRoute[0].channel.status = "paused";
    expect(
      await kommoPublicationAuthorized(
        h.prisma,
        "workspace-a",
        ledger.publicationIntent,
      ),
    ).toBe(false);
  });

  it("does not match a lead that never entered through the bound number", async () => {
    const { h } = gupshupRoute();
    const event = await h.receive();
    expect(
      await h.service.process(event.id, event.workspaceId),
    ).toMatchObject({
      status: "blocked",
      errorCode: "lead_channel_route_unauthorized",
    });
    expect(
      h.state.conversionEventLog.some(
        (row: any) => row.sourceTrigger === "kommo_stage",
      ),
    ).toBe(false);
  });

  it("reports why a number cannot be authorized", async () => {
    const { h } = gupshupRoute();
    h.state.inboundWebhookChannelRoute[0].channel.connection.status =
      "observation";
    await expect(
      h.service.setChannelBindings("workspace-a", h.connection.id, "owner-a", [
        "route-a",
      ]),
    ).rejects.toMatchObject({
      status: 400,
      message: kommoChannelBindingMessages.number_not_in_production,
      response: { code: "kommo_channel_number_not_in_production" },
    });
  });
});

describe("Kommo keeps the UAZAPI requirements unchanged", () => {
  it("requires the active WhatsApp instance of a UAZAPI number", async () => {
    const h = kommoHarness();
    h.state.inboundWebhookChannelRoute[0].channel.connection.provider =
      "uazapi";
    await h.service.setChannelBindings(
      "workspace-a",
      h.connection.id,
      "owner-a",
      ["route-a"],
    );
    h.state.inboundWebhookChannelRoute[0].channel.whatsappInstance.status =
      "disconnected";
    await expect(
      h.service.setChannelBindings("workspace-a", h.connection.id, "owner-a", [
        "route-a",
      ]),
    ).rejects.toMatchObject({
      status: 400,
      message: kommoChannelBindingMessages.whatsapp_disconnected,
    });
  });

  it("never binds a UAZAPI number by channel id (page/pixel inheritance)", async () => {
    const h = kommoHarness();
    h.prisma.inboundWebhookChannel = channelTable([
      {
        ...gupshupNumber("channel-uazapi", {
          whatsappInstanceId: "instance-a",
          whatsappInstance: { workspaceId: "workspace-a", status: "active" },
        }),
        connection: {
          ...gupshupNumber().connection,
          provider: "uazapi",
        },
      },
    ]);
    await expect(
      h.service.setChannelBindings("workspace-a", h.connection.id, "owner-a", [
        "channel-uazapi",
      ]),
    ).rejects.toMatchObject({
      status: 400,
      message: kommoChannelBindingMessages.meta_destination_unverified,
    });
  });
});

describe("Kommo with a Gupshup number inheriting the verified page/pixel", () => {
  function inheriting(numbers = [gupshupNumber()]) {
    const h = kommoHarness();
    h.prisma.inboundWebhookChannel = channelTable(numbers);
    h.prisma.inboundWebhookEvent = receiptEvents();
    const lead = h.state.lead[0];
    lead.whatsappInstanceId = null;
    for (const number of numbers)
      entryReceipt(h.state.conversionEventLog, {
        leadId: lead.id,
        phoneHash: lead.phoneHash,
        ctwaClid: "trusted-click",
        channelId: number.id,
      });
    return { h, lead };
  }

  it("binds the number by channel id and sends through the page/pixel destination", async () => {
    // Meta's seven-day window is measured against the synthetic harness clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:05:00Z"));
    const { h, lead } = inheriting();
    await h.service.setChannelBindings(
      "workspace-a",
      h.connection.id,
      "owner-a",
      ["channel-gupshup"],
    );
    expect(h.connection.allowedChannelRouteIds).toEqual(["channel-gupshup"]);
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    const log = h.state.conversionEventLog.find(
      (row: any) => row.sourceTrigger === "kommo_stage",
    );
    expect(log).toMatchObject({
      leadId: lead.id,
      adId: null,
      campaignId: null,
      metaAccountId: null,
      ctwaClid: "trusted-click",
      metaConversionDestinationId: "destination-a",
    });
    expect(log.sourcePayload).toMatchObject({
      processingMode: KOMMO_CTWA_PROCESSING_MODE,
      channelId: "channel-gupshup",
      connectionId: "gupshup-connection-a",
      kommoConnectionId: h.connection.id,
      ctwaDestination: {
        deliveryKind: "page_pixel",
        channelId: "channel-gupshup",
        pixelId: "synthetic-pixel",
        pageId: "synthetic-page",
      },
    });
    expect(log.status).toBe("ready_to_send");
    const ledger = h.state.kommoConversionDedupe[0];
    expect(ledger.publicationStatus).toBe("queued");
    expect(ledger.publicationIntent).toEqual({
      kind: "ctwa_destination",
      connectionId: h.connection.id,
      channelId: "channel-gupshup",
      inboundConnectionId: "gupshup-connection-a",
      destinationId: "destination-a",
      eventId: log.eventId,
    });
    // The outbox enqueues the canonical CTWA send.
    expect(h.conversionQueue.retrySend).toHaveBeenCalledWith(
      log.id,
      "workspace-a",
    );
    const destination = log.sourcePayload.ctwaDestination;
    expect(
      await kommoCtwaConversionAuthorized(h.prisma, log, destination),
    ).toBe(true);
    expect(
      await kommoCtwaConversionAuthorized(h.prisma, log, {
        ...destination,
        destinationId: "other",
      }),
    ).toBe(false);
    h.connection.allowedChannelRouteIds = [];
    expect(
      await kommoCtwaConversionAuthorized(h.prisma, log, destination),
    ).toBe(false);
    // A failed page/pixel log never goes through the Kommo route sender retry.
    const retry = vi.spyOn(h.conversions, "prepareKommoSenderRetry");
    log.status = "error";
    await h.conversions
      .sendReadyEvent(log.id, { workspaceId: "workspace-a" })
      .catch(() => undefined);
    expect(retry).not.toHaveBeenCalled();
  });

  it("refuses the conversion when the number is unbound after the lead was resolved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:05:00Z"));
    const { h } = inheriting();
    h.connection.allowedChannelRouteIds = ["channel-gupshup"];
    const resolveLead = (h.service as any).resolveLead.bind(h.service);
    vi.spyOn(h.service as any, "resolveLead").mockImplementation(
      async (...args: any[]) => {
        const resolved = await resolveLead(...args);
        // Concurrent edit: the connection now binds only another number.
        h.connection.allowedChannelRouteIds = ["route-a"];
        return resolved;
      },
    );
    const event = await h.receive();
    expect(
      await h.service.process(event.id, event.workspaceId),
    ).toMatchObject({
      status: "blocked",
      errorCode: "channel_authorization_changed",
    });
    expect(
      h.state.conversionEventLog.some(
        (row: any) => row.sourceTrigger === "kommo_stage",
      ),
    ).toBe(false);
    expect(h.state.kommoConversionDedupe).toHaveLength(0);
    expect(h.conversionQueue.retrySend).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous page/pixel pair at binding and at conversion", async () => {
    const { h } = inheriting();
    flags.ambiguous = true;
    await expect(
      h.service.setChannelBindings("workspace-a", h.connection.id, "owner-a", [
        "channel-gupshup",
      ]),
    ).rejects.toMatchObject({
      status: 400,
      message: kommoChannelBindingMessages.meta_destination_unverified,
    });
    h.connection.allowedChannelRouteIds = ["channel-gupshup"];
    const event = await h.receive();
    expect(
      await h.service.process(event.id, event.workspaceId),
    ).toMatchObject({
      status: "blocked",
      errorCode: "lead_channel_route_unauthorized",
    });
    expect(
      h.state.conversionEventLog.some(
        (row: any) => row.sourceTrigger === "kommo_stage",
      ),
    ).toBe(false);
  });

  it("refuses a lead that entered through two bound numbers (ambiguous origin)", async () => {
    const { h } = inheriting([
      gupshupNumber("channel-gupshup"),
      gupshupNumber("channel-gupshup-2"),
    ]);
    h.connection.allowedChannelRouteIds = [
      "channel-gupshup",
      "channel-gupshup-2",
    ];
    const event = await h.receive();
    expect(
      await h.service.process(event.id, event.workspaceId),
    ).toMatchObject({ status: "blocked" });
    expect(
      h.state.conversionEventLog.some(
        (row: any) => row.sourceTrigger === "kommo_stage",
      ),
    ).toBe(false);
  });

  it("requires the entry of the same click on the bound number", async () => {
    const { h } = inheriting();
    h.state.conversionEventLog[0].ctwaClid = "another-click";
    h.connection.allowedChannelRouteIds = ["channel-gupshup"];
    const event = await h.receive();
    expect(
      await h.service.process(event.id, event.workspaceId),
    ).toMatchObject({ status: "blocked" });
  });
});

describe("Kommo lead with ctwa_clid and no ad id (page/pixel, as the SaaS)", () => {
  function noAdLead(ctwaClid: string | null, adId: string | null = null) {
    const h = kommoHarness();
    h.prisma.inboundWebhookChannel = channelTable([gupshupNumber()]);
    h.prisma.inboundWebhookEvent = receiptEvents();
    const lead = h.state.lead[0];
    Object.assign(lead, {
      whatsappInstanceId: null,
      adId,
      campaignId: null,
      adSetId: null,
      ctwaClid,
    });
    entryReceipt(h.state.conversionEventLog, {
      leadId: lead.id,
      phoneHash: lead.phoneHash,
      ctwaClid: "trusted-click",
      channelId: "channel-gupshup",
    });
    h.connection.allowedChannelRouteIds = ["channel-gupshup"];
    return { h, lead };
  }

  it("now sends the lead through the verified page/pixel destination", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:05:00Z"));
    const { h, lead } = noAdLead("trusted-click");
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    const log = h.state.conversionEventLog.find(
      (row: any) => row.sourceTrigger === "kommo_stage",
    );
    expect(log).toMatchObject({
      leadId: lead.id,
      adId: null,
      campaignId: null,
      ctwaClid: "trusted-click",
      metaConversionDestinationId: "destination-a",
      status: "ready_to_send",
    });
    expect(log.sourcePayload).toMatchObject({
      processingMode: KOMMO_CTWA_PROCESSING_MODE,
      channelId: "channel-gupshup",
      ctwaDestination: { pixelId: "synthetic-pixel", pageId: "synthetic-page" },
    });
    expect(h.state.kommoConversionDedupe[0].publicationIntent).toMatchObject({
      kind: "ctwa_destination",
      channelId: "channel-gupshup",
    });
    expect(h.conversionQueue.retrySend).toHaveBeenCalledWith(
      log.id,
      "workspace-a",
    );
  });

  it.each([
    ["without an ad id", null],
    ["with an ad id", "ad-a"],
  ])(
    "without ctwa_clid nothing is sent (lead %s)",
    async (_label, adId) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-05T12:05:00Z"));
      const { h } = noAdLead(null, adId);
      const event = await h.receive();
      expect(
        await h.service.process(event.id, event.workspaceId),
      ).toMatchObject({
        status: "blocked",
        errorCode: "lead_channel_or_attribution_unproven",
      });
      expect(
        h.state.conversionEventLog.some(
          (row: any) => row.sourceTrigger === "kommo_stage",
        ),
      ).toBe(false);
      expect(h.state.kommoConversionDedupe).toHaveLength(0);
      expect(h.conversionQueue.retrySend).not.toHaveBeenCalled();
    },
  );
});

describe("Pipedrive with a Gupshup number inheriting the verified page/pixel", () => {
  beforeEach(() =>
    vi.stubEnv(
      "PIPEDRIVE_CRM_ENCRYPTION_KEY",
      Buffer.alloc(32, 7).toString("base64"),
    ),
  );

  it("binds the number by channel id; ambiguous pairs are rejected", async () => {
    const h = pipedriveHarness();
    h.channels.push(gupshupNumber());
    const created = await h.service.create("workspace-a", actor, {
      ...createInput,
      allowedChannelRouteIds: ["channel-gupshup"],
    });
    expect(created.allowedChannelRouteIds).toEqual(["channel-gupshup"]);
    flags.ambiguous = true;
    const other = pipedriveHarness();
    other.channels.push(gupshupNumber());
    await expect(
      other.service.create("workspace-a", actor, {
        ...createInput,
        allowedChannelRouteIds: ["channel-gupshup"],
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: pipedriveChannelBindingMessages.meta_destination_unverified,
    });
  });

  it("materializes a lead of the Gupshup number through the page/pixel destination", async () => {
    productionEnv();
    const h = await productionHarness();
    const number = gupshupNumber();
    h.client.inboundWebhookChannel = channelTable([number]);
    h.client.inboundWebhookEvent = receiptEvents();
    h.state.pipedriveConnection![0]!.allowedChannelRouteIds = [number.id];
    const lead = h.state.lead![0]!;
    lead.whatsappInstanceId = null;
    entryReceipt(h.state.conversionEventLog!, {
      leadId: lead.id,
      phoneHash: lead.phoneHash ?? hashPhoneIdentity("5500000000000"),
      ctwaClid: lead.ctwaClid,
      channelId: number.id,
    });
    await h.webhooks.createRule("workspace-a", h.c.id, actor, {
      ...ruleInput,
      mode: "production",
    });
    h.setNow(new Date(+h.now + 1000));
    const event = await h.receive();
    expect(await h.webhooks.process(event.id, "workspace-a")).toMatchObject({
      status: "materialized",
    });
    const log = h.state.conversionEventLog!.find(
      (row) => row.sourceTrigger === "pipedrive_stage",
    )!;
    expect(log).toMatchObject({ adId: null, metaAccountId: null });
    expect(log.sourcePayload).toMatchObject({
      channelId: number.id,
      connectionId: "gupshup-connection-a",
      ctwaDestination: { deliveryKind: "page_pixel", channelId: number.id },
    });
    const ledger = h.state.pipedriveConversionDedupe!.find(
      (row) => row.mode === "production",
    )!;
    expect(ledger.publicationIntent).toMatchObject({
      kind: "ctwa_destination",
      channelId: number.id,
      connectionId: "gupshup-connection-a",
    });
    expect(
      await pipedriveCtwaConversionAuthorized(
        h.client,
        log,
        (log.sourcePayload as any).ctwaDestination,
      ),
    ).toBe(true);
  });
});
