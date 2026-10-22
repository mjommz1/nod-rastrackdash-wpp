import { vi } from "vitest";
import { observationHarness, payload } from "./pipedrive-observation-harness";
import { actor, allowedLicense } from "./pipedrive-harness";
import { PipedriveWebhookService } from "../../src/pipedrive/pipedrive-webhook.service";
import { ConversionEventsService } from "../../src/conversion-events/conversion-events.service";
import { ConversionEventsQueueService } from "../../src/common/queue/conversion-events-queue.service";
import { MetaCapiAdapter } from "../../src/conversion-events/meta-capi.adapter";

export function productionEnv() {
  for (const key of [
    "INBOUND_WEBHOOKS_ENABLED",
    "INBOUND_WEBHOOK_PRODUCTION_ENABLED",
    "INBOUND_CONVERSION_RULES_ENABLED",
    "INBOUND_CONVERSION_PRODUCTION_ENABLED",
  ])
    vi.stubEnv(key, "true");
  vi.stubEnv(
    "INBOUND_WEBHOOK_ENCRYPTION_KEY",
    Buffer.alloc(32, 8).toString("base64"),
  );
  vi.stubEnv(
    "PIPEDRIVE_CRM_ENCRYPTION_KEY",
    Buffer.alloc(32, 7).toString("base64"),
  );
  vi.stubEnv("API_PUBLIC_URL", "https://api.synthetic.example.invalid");
}

export async function productionHarness() {
  const h = observationHarness();
  h.client.$queryRaw.mockResolvedValue([{ acquired: true }]);
  const c = await h.seed();
  Object.assign(h.route, {
    metaBusinessConnectionId: "business-a",
    metaReportingAccountId: "reporting-a",
    metaConversionDestinationId: "destination-a",
  });
  h.route.channel.id = "channel-a";
  h.route.channel.productionActivatedAt = new Date(+h.now - 10000);
  h.route.channel.connection.productionActivatedAt = new Date(+h.now - 10000);
  Object.assign(h.route.metaConversionDestination, {
    pixelId: "synthetic-pixel",
    pageId: "synthetic-page",
  });
  h.route.metaReportingAccount.adAccountId = "act_synthetic";
  Object.assign(h.state.lead![0], {
    adId: "ad-a",
    ctwaClid: "synthetic-existing-ctwa",
    campaignId: "campaign-a",
    adSetId: "adset-a",
  });
  const assignment = {
    workspaceId: "workspace-a",
    adId: "ad-a",
    reportingAccountId: "reporting-a",
    conversionDestinationId: "destination-a",
  };
  h.client.metaAdDestinationAssignment = {
    findUnique: vi.fn(async () => assignment),
  };
  h.client.conversionEventLog.update = vi.fn(async ({ where, data }: any) => {
    const row = h.state.conversionEventLog!.find((r) => r.id === where.id)!;
    Object.assign(row, structuredClone(data));
    return structuredClone(row);
  });
  for (const name of [
    "providerConversionRuleExecution",
    "purchaseReview",
    "integrationLog",
    "diagnosticEvent",
    "jobAttempt",
  ]) {
    h.client[name] = {
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({ id: "synthetic-audit" })),
    };
  }
  const fetcher = vi.fn(
    async (_url: string, _request: RequestInit) =>
      new Response('{"events_received":1,"messages":[],"fbtrace_id":"synthetic-trace"}', { status: 200 }),
  );
  const resolver = {
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
  };
  const conversions = new ConversionEventsService(
    h.client,
    new MetaCapiAdapter({}, fetcher as any),
    {} as any,
    resolver as any,
    allowedLicense,
  );
  const jobs = new Map<string, string>();
  const bull = {
    getJob: vi.fn(async () => null),
    add: vi.fn(async (_name: string, data: any, options: any) => {
      jobs.set(data.conversionEventLogId, data.workspaceId);
      return { id: options.jobId };
    }),
  };
  const queue = new ConversionEventsQueueService(bull as any);
  const retrySend = vi.spyOn(queue, "retrySend");
  const webhooks = new PipedriveWebhookService(
    h.client,
    h.adapter as any,
    h.service,
    conversions,
    queue as any,
    allowedLicense,
  );
  webhooks.now = () => h.now;
  const secret = new URL(
    (await webhooks.rotateSecret("workspace-a", c.id, actor)).webhookUrl,
  ).searchParams.get("token")!;
  const receive = async (patch: any = {}) => {
    await webhooks.receive(
      c.id,
      secret,
      payload(h.now, patch),
      "application/json",
    );
    return h.state.pipedriveWebhookEvent!.at(-1)!;
  };
  return {
    ...h,
    webhooks,
    c,
    secret,
    receive,
    conversions,
    queue,
    retrySend,
    jobs,
    fetcher,
    resolver,
    assignment,
    bull,
    get now() {
      return h.now;
    },
  };
}
