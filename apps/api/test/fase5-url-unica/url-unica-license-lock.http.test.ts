import "reflect-metadata";
import { APP_GUARD } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import { InboundConversionAutomationIngestionService } from "../../src/inbound-webhooks/inbound-conversion-automation-ingestion.service";
import { configureInboundWebhookBodyParser } from "../../src/inbound-webhooks/inbound-webhook-body-parser";
import { InboundWebhookIngestionService } from "../../src/inbound-webhooks/inbound-webhook-ingestion.service";
import { InboundWebhookMetaCloudVerificationService } from "../../src/inbound-webhooks/inbound-webhook-meta-cloud-verification.service";
import { InboundWebhookPublicController } from "../../src/inbound-webhooks/inbound-webhook-public.controller";
import { IntegrationEndpointsController } from "../../src/inbound-webhooks/integration-endpoints.controller";
import { IntegrationEndpointsService } from "../../src/inbound-webhooks/integration-endpoints.service";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";
import {
  jeanChannels,
  jeanLeads,
  paytSale,
  world,
  type Rule,
} from "./url-unica-world";

/**
 * Fase 5.3 with a blocked license (student rule: 423, not the SaaS 404):
 * the URL única and every write of /integrations/endpoints answer 423 from
 * the global guard and store nothing; reads keep working.
 */
const apps: NestExpressApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

const rules: Rule[] = [
  {
    id: "payt_global",
    provider: "payt",
    eventName: "Purchase",
    scope: "all_numbers",
    connectionId: "conn_unnichat_a",
    channelIds: [],
  },
];

async function appFor(locked: boolean) {
  const w = world({ channels: jeanChannels, rules, leads: jeanLeads });
  const { endpoint, token } = await w.connect("payt");
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
  const auth = {
    getSession: vi.fn(async () => ({ user: { id: "operator" } })),
  };
  const workspaces = {
    getCurrentWorkspace: vi.fn(() => ({
      id: "workspace_jean",
      permissions: { canManageIntegrations: true },
    })),
  };
  const module = await Test.createTestingModule({
    controllers: [InboundWebhookPublicController, IntegrationEndpointsController],
    providers: [
      { provide: IntegrationEndpointsService, useValue: w.service },
      {
        provide: InboundConversionAutomationIngestionService,
        useValue: w.ingestion,
      },
      { provide: InboundWebhookIngestionService, useValue: { ingest: vi.fn() } },
      {
        provide: InboundWebhookMetaCloudVerificationService,
        useValue: { matches: vi.fn(async () => false) },
      },
      { provide: AuthService, useValue: auth },
      { provide: WorkspacesService, useValue: workspaces },
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
  return { w, endpoint, token, api: request(app.getHttpServer()) };
}

describe("URL única with a blocked license", () => {
  it("answers 423 on the public URL and records nothing", async () => {
    const { w, endpoint, token, api } = await appFor(true);
    const ingest = vi.spyOn(w.service, "ingest");
    const response = await api
      .post(`/webhooks/inbound/integrations/${endpoint.id}?token=${token}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(paytSale({ order: "LOCK1" })))
      .expect(423);
    expect(response.body).toMatchObject({ statusCode: 423 });
    expect(ingest).not.toHaveBeenCalled();
    expect(w.receipts.size).toBe(0);
    expect(w.deliveries.size).toBe(0);
    expect(w.observed).toHaveLength(0);
  });

  it("answers 423 on every management write and keeps the reads", async () => {
    const { w, endpoint, api } = await appFor(true);
    const auth = { Authorization: "Bearer session" };
    await api.get("/integrations/endpoints").set(auth).expect(200);
    await api.get("/integrations/endpoints/unattributed").set(auth).expect(200);
    await api.get("/integrations/endpoints/products").set(auth).expect(200);
    const auditsBefore = w.audit.length;
    for (const path of [
      "/integrations/endpoints",
      `/integrations/endpoints/${endpoint.id}/reveal`,
      `/integrations/endpoints/${endpoint.id}/rotate`,
      "/integrations/endpoints/events/any/retry",
    ]) {
      await api
        .post(path)
        .set(auth)
        .send({ provider: "payt" })
        .expect(423);
    }
    await api
      .delete(`/integrations/endpoints/${endpoint.id}`)
      .set(auth)
      .expect(423);
    expect(w.audit.length).toBe(auditsBefore);
    expect(w.integrationEndpoints.get(endpoint.id).removedAt).toBeNull();
  });

  it("accepts the same postback once the license is unlocked (202, routed)", async () => {
    const { w, endpoint, token, api } = await appFor(false);
    const response = await api
      .post(`/webhooks/inbound/integrations/${endpoint.id}?token=${token}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(paytSale({ order: "LOCK2" })))
      .expect(202);
    expect(response.body).toMatchObject({ status: "accepted", routing: "routed" });
    expect(w.receipts.size).toBe(1);
  });

  it("answers the same 404 for a wrong token and an unknown URL over HTTP", async () => {
    const { endpoint, api } = await appFor(false);
    const wrong = await api
      .post(`/webhooks/inbound/integrations/${endpoint.id}?token=wrong`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(paytSale({})))
      .expect(404);
    const unknown = await api
      .post(`/webhooks/inbound/integrations/unknown?token=wrong`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(paytSale({})))
      .expect(404);
    expect(wrong.body).toEqual(unknown.body);
  });
});
