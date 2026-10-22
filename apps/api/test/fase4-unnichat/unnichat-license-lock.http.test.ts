import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP_GUARD } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboundConversionAutomationIngestionService } from "../../src/inbound-webhooks/inbound-conversion-automation-ingestion.service";
import { configureInboundWebhookBodyParser } from "../../src/inbound-webhooks/inbound-webhook-body-parser";
import { InboundWebhookIngestionService } from "../../src/inbound-webhooks/inbound-webhook-ingestion.service";
import { InboundWebhookMetaCloudVerificationService } from "../../src/inbound-webhooks/inbound-webhook-meta-cloud-verification.service";
import { InboundWebhookPublicController } from "../../src/inbound-webhooks/inbound-webhook-public.controller";
import { IntegrationEndpointsService } from "../../src/inbound-webhooks/integration-endpoints.service";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import { createHarness, secret } from "../fase4-payt/payt-ingestion-harness";

// Blocked license: the global soft-lock guard answers 423 on both public
// Unnichat URLs (entry webhook of the connection and automation URL of the
// rule) before anything is recorded. Nothing new bypasses it.
const apps: NestExpressApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

const entry = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/entry-with-ctwa.json"), "utf8"),
);

async function appFor(locked: boolean) {
  const automation = createHarness({ eventName: "QualifiedLead", unnichat: true });
  const entryIngestion = {
    ingest: vi.fn(async () => ({ status: "accepted", duplicate: false })),
  };
  const license = {
    getLockState: vi.fn(async () =>
      locked
        ? {
            inert: false,
            locked: true,
            reason: "revoked",
            state: { status: "blocked" },
          }
        : {
            inert: false,
            locked: false,
            reason: null,
            state: { status: "active" },
          },
    ),
  };
  const module = await Test.createTestingModule({
    controllers: [InboundWebhookPublicController],
    providers: [
      {
        provide: InboundConversionAutomationIngestionService,
        useValue: automation.service,
      },
      { provide: IntegrationEndpointsService, useValue: { ingest: vi.fn() } },
      { provide: InboundWebhookIngestionService, useValue: entryIngestion },
      {
        provide: InboundWebhookMetaCloudVerificationService,
        useValue: { matches: vi.fn(async () => false) },
      },
      { provide: LicenseClientService, useValue: license },
      { provide: APP_GUARD, useClass: LicenseSoftlockGuard },
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureInboundWebhookBodyParser(app);
  apps.push(app);
  await app.init();
  return { automation, entryIngestion, api: request(app.getHttpServer()) };
}

const entryUrl = `/webhooks/inbound/connection_unnichat_1?token=${secret}`;
const automationUrl = `/webhooks/inbound/conversions/endpoint_1?token=${secret}`;

describe("Unnichat public URLs with a blocked license", () => {
  it("answers 423 on the entry webhook and never ingests it", async () => {
    const { entryIngestion, api } = await appFor(true);
    const response = await api
      .post(entryUrl)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(entry))
      .expect(423);
    expect(response.body).toMatchObject({
      statusCode: 423,
      error: "License Locked",
    });
    expect(entryIngestion.ingest).not.toHaveBeenCalled();
  });

  it("answers 423 on the automation URL and records nothing", async () => {
    const { automation, api } = await appFor(true);
    const ingest = vi.spyOn(automation.service, "ingest");
    await api
      .post(automationUrl)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(entry))
      .expect(423);
    expect(ingest).not.toHaveBeenCalled();
    expect(automation.deliveries.size).toBe(0);
    expect(automation.executions.size).toBe(0);
    expect(
      automation.conversionObservation.observeAutomation,
    ).not.toHaveBeenCalled();
  });

  it("accepts both once the license is unlocked", async () => {
    const { automation, entryIngestion, api } = await appFor(false);
    await api
      .post(entryUrl)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(entry))
      .expect(202);
    expect(entryIngestion.ingest).toHaveBeenCalledTimes(1);
    await api
      .post(automationUrl)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(entry))
      .expect(202);
    expect(automation.deliveries.size).toBe(1);
  });
});
