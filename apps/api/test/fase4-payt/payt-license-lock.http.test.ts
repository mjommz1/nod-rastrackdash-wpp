import "reflect-metadata";
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
import {
  createHarness,
  paytFixture,
  secret,
} from "./payt-ingestion-harness";

const apps: NestExpressApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function appFor(locked: boolean) {
  const harness = createHarness({ eventName: "Purchase", payt: true });
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
        useValue: harness.service,
      },
      { provide: IntegrationEndpointsService, useValue: { ingest: vi.fn() } },
      { provide: InboundWebhookIngestionService, useValue: { ingest: vi.fn() } },
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
  return { harness, api: request(app.getHttpServer()) };
}

const postback = `/webhooks/inbound/conversions/endpoint_1?token=${secret}`;

describe("Payt postback with a blocked license", () => {
  it("answers 423 on the public postback and records nothing", async () => {
    const { harness, api } = await appFor(true);
    const ingest = vi.spyOn(harness.service, "ingest");

    const response = await api
      .post(postback)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(paytFixture("order-paid.sanitized.json")))
      .expect(423);

    expect(response.body).toMatchObject({
      statusCode: 423,
      error: "License Locked",
    });
    expect(ingest).not.toHaveBeenCalled();
    expect(harness.deliveries.size).toBe(0);
    expect(harness.executions.size).toBe(0);
    expect(harness.decisions.size).toBe(0);
    expect(
      harness.conversionObservation.observeAutomation,
    ).not.toHaveBeenCalled();
    expect(harness.prisma.inboundWebhookDelivery.create).not.toHaveBeenCalled();
  });

  it("accepts the same postback once the license is unlocked", async () => {
    const { harness, api } = await appFor(false);

    await api
      .post(postback)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(paytFixture("order-paid.sanitized.json")))
      .expect(202);

    expect(harness.deliveries.size).toBe(1);
  });
});
