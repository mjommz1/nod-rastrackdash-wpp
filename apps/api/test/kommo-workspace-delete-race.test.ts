import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversionEventsService } from "../src/conversion-events/conversion-events.service";
import { PlatformWorkspaceAccessService } from "../src/workspaces/platform-workspace-access.service";
import { deferred, kommoHarness } from "./support/kommo-stateful-harness";

const owner = {
  id: "platform-owner",
  email: "owner@example.com",
  role: "platform_owner" as const,
};

// This is a stateful Prisma mock, not PostgreSQL proof. It intentionally uses
// the real workspace-delete and ConversionEventsService consumers so their
// shared advisory-lock call and delete/send boundaries cannot drift silently.
function attachWorkspaceDeleteConsumer(
  h: ReturnType<typeof kommoHarness>,
  holdWorkspaceRead?: {
    entered: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  },
) {
  const events: string[] = [];
  let workspace = {
    id: "workspace-a",
    slug: "workspace-a",
  };
  const noDelete = () => ({ deleteMany: vi.fn(async () => ({ count: 0 })) });
  for (const delegate of [
    "purchaseValueAdjustment",
    "purchaseReviewItem",
    "purchaseReview",
    "providerPurchaseClaim",
    "providerConversionRuleExecution",
    "providerConversionDecisionAudit",
    "providerConversionShadowComparison",
    "providerConversionRuleChannel",
    "providerConversionRuleEndpoint",
    "conversionCatalogVariant",
    "conversionCatalogAttribute",
    "conversionCatalog",
    "providerRuleCreateClaim",
    "providerConversionRuleConfig",
    "conversionRule",
    "inboundWebhookReplayItem",
    "inboundWebhookReplayBatch",
    "inboundWebhookProductionItem",
    "inboundWebhookEvent",
    "inboundWebhookDelivery",
    "inboundWebhookChannelRoute",
    "integrationEndpointEvent",
    "integrationEndpoint",
    "inboundWebhookChannel",
    "inboundWebhookConnection",
    "externalIngestionRecord",
    "externalCapiCutover",
    "externalSyncCursor",
    "externalDataConnector",
    "metaAdDestinationAssignment",
    "metaReportingAccountDestination",
    "metaAdDailyInsight",
    "metaAd",
    "metaAdSetDailyInsight",
    "metaAdSet",
    "metaCampaignDailyInsight",
    "metaCampaign",
    "metaReportingAccount",
    "metaConversionDestination",
    "metaAssetSnapshot",
    "metaBusinessConnection",
    "metaCredential",
    "metaIntegration",
    "pipedriveConversionDedupe",
    "pipedriveWebhookEvent",
    "pipedriveConversionRule",
    "pipedriveStageCatalog",
    "pipedrivePipelineCatalog",
    "pipedriveConnection",
    "uazapiChatLabelState",
    "whatsappInstance",
    "funnelStageConfiguration",
    "webhookLog",
    "workspaceOpsAlertDelivery",
    "workspaceOpsAlertSettings",
    "authActionToken",
    "workspaceInvite",
    "workspaceMember",
  ]) {
    if (!h.prisma[delegate]) h.prisma[delegate] = noDelete();
  }
  h.prisma.providerConversionDecisionAudit.updateMany = vi.fn(async () => ({
    count: 0,
  }));
  h.prisma.providerConversionRuleConfig.updateMany = vi.fn(async () => ({
    count: 0,
  }));
  h.prisma.authSession = { updateMany: vi.fn(async () => ({ count: 0 })) };
  h.prisma.user = { updateMany: vi.fn(async () => ({ count: 0 })) };
  h.prisma.workspace = {
    findUnique: vi.fn(async () => {
      if (holdWorkspaceRead) {
        events.push("workspace-read-held");
        holdWorkspaceRead.entered.resolve();
        await holdWorkspaceRead.release.promise;
      }
      return workspace;
    }),
    delete: vi.fn(async () => {
      if (
        h.state.kommoConnection.some(
          (connection: any) => connection.workspaceId === "workspace-a",
        ) ||
        h.state.kommoPipelineCatalog.some(
          (row: any) => row.workspaceId === "workspace-a",
        ) ||
        h.state.kommoConversionRule.some(
          (row: any) => row.workspaceId === "workspace-a",
        ) ||
        h.state.kommoWebhookEvent.some(
          (row: any) => row.workspaceId === "workspace-a",
        ) ||
        h.state.kommoConversionDedupe.some(
          (row: any) => row.workspaceId === "workspace-a",
        )
      )
        throw new Error("synthetic Kommo Restrict dependency remains");
      events.push("workspace-delete");
      workspace = null as never;
      return { id: "workspace-a" };
    }),
  };
  const raw = h.prisma.$queryRaw;
  h.prisma.$queryRaw = vi.fn(async (query: any) => {
    if (query?.sql?.includes("pg_try_advisory_xact_lock"))
      events.push("kommo-dispatch-lock");
    return raw(query);
  });
  const access = new PlatformWorkspaceAccessService(
    h.prisma as never,
    { isEnabled: vi.fn(() => false), enqueue: vi.fn() } as never,
  );
  return { access, events, workspaceExists: () => workspace !== null };
}

function senderFor(h: ReturnType<typeof kommoHarness>) {
  return new ConversionEventsService(
    h.prisma,
    h.metaAdapter as never,
    {} as never,
    {
      hasNormalizedConnections: vi.fn(async () => true),
      resolveCapiRoute: vi.fn(async () => ({
        source: "manual",
        accessToken: "synthetic-only",
        pixelId: "synthetic-pixel",
        pageId: "synthetic-page",
        reportingAccountId: "reporting-a",
        adAccountId: "act_synthetic",
        businessConnectionId: "business-a",
        conversionDestinationId: "destination-a",
      })),
    } as never,
    h.license as never,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Kommo workspace delete and sender coordination (stateful mock)", () => {
  it("deletion-first removes the durable sender inputs before the real sender can start a provider call", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    const holdWorkspaceRead = {
      entered: deferred<void>(),
      release: deferred<void>(),
    };
    const { access, events, workspaceExists } = attachWorkspaceDeleteConsumer(
      h,
      holdWorkspaceRead,
    );
    const sender = senderFor(h);
    const logId = h.state.conversionEventLog[0].id;

    const deleting = access.deleteWorkspace(
      "workspace-a",
      { confirmation: "workspace-a" },
      owner,
    );
    await holdWorkspaceRead.entered.promise;
    const sending = sender.sendReadyEvent(logId, { workspaceId: "workspace-a" });
    await vi.waitFor(() =>
      expect(h.prisma.conversionEventLog.findUnique).toHaveBeenCalledWith({
        where: { id: logId, workspaceId: "workspace-a" },
      }),
    );
    holdWorkspaceRead.release.resolve();
    await deleting;
    await expect(sending).resolves.toMatchObject({ status: "skipped" });

    expect(h.metaAdapter.sendEvent).not.toHaveBeenCalled();
    expect(workspaceExists()).toBe(false);
    expect(events).toEqual([
      "kommo-dispatch-lock",
      "workspace-read-held",
      "workspace-delete",
    ]);
    expect(h.state.kommoConversionDedupe).toHaveLength(0);
    expect(h.state.conversionEventLog).toHaveLength(0);
  });

  it("dispatch-first starts the provider before the same lock domain permits the real deletion consumer", async () => {
    const h = kommoHarness();
    const event = await h.receive();
    await h.service.process(event.id, event.workspaceId);
    const { access, events, workspaceExists } = attachWorkspaceDeleteConsumer(h);
    const sender = senderFor(h);
    const started = deferred<void>();
    const response = deferred<any>();
    h.metaAdapter.sendEvent.mockImplementationOnce(() => {
      events.push("provider-start");
      started.resolve();
      return response.promise;
    });
    const sending = sender.sendReadyEvent(h.state.conversionEventLog[0].id, {
      workspaceId: "workspace-a",
    });

    await started.promise;
    expect(workspaceExists()).toBe(true);
    await access.deleteWorkspace(
      "workspace-a",
      { confirmation: "workspace-a" },
      owner,
    );
    expect(events.indexOf("provider-start")).toBeLessThan(
      events.indexOf("workspace-delete"),
    );
    expect(events.filter((event) => event === "kommo-dispatch-lock")).toHaveLength(2);

    response.resolve({
      status: "sent",
      requestPayload: null,
      responseSummary: { synthetic: true },
      errorCode: null,
      errorMessage: null,
    });
    await expect(sending).rejects.toThrow("kommo_sender_lease_lost");
    expect(workspaceExists()).toBe(false);
  });
});
