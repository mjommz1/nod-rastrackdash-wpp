import "reflect-metadata";
import { UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { APP_GUARD } from "@nestjs/core";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.service";
import { WorkspaceOwnerGuard } from "../src/workspaces/guards/workspace-owner.guard";
import { configureInboundWebhookBodyParser } from "../src/inbound-webhooks/inbound-webhook-body-parser";
import { KommoController } from "../src/kommo/kommo.controller";
import { KommoService } from "../src/kommo/kommo.service";
import { LicenseClientService } from "../src/licensing-client/license-client.service";
import { LicenseSoftlockGuard } from "../src/licensing-client/license-softlock.guard";
import { kommoHarness } from "./support/kommo-stateful-harness";

const apps: NestExpressApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
});
async function appFor(license: any = { getLockState: vi.fn(async () => ({ inert: true, locked: false })) }) {
  const h = kommoHarness();
  const session: any = {
    user: {
      id: "owner-a",
      email: "synthetic@example.invalid",
      platformRole: "user",
    },
    workspaces: [{ id: "workspace-a", role: "owner" }],
  };
  const auth = {
    getSession: vi.fn(async (token: string) => {
      if (token !== "synthetic-session") throw new UnauthorizedException();
      return session;
    }),
  };
  const module = await Test.createTestingModule({
    controllers: [KommoController],
    providers: [
      WorkspaceOwnerGuard,
      { provide: KommoService, useValue: h.service },
      { provide: AuthService, useValue: auth },
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
  // No onModuleInit networking: harness provides synthetic adapters and DB.
  return { ...h, app, session, api: request(app.getHttpServer()) };
}
const webhook = "/webhooks/kommo/v1/connection-a?token=synthetic-capability";
const path = "/workspaces/workspace-a/kommo/connections/connection-a";
const payload = {
  account: { id: "account-a", subdomain: "synthetic" },
  leads: {
    status: [
      {
        id: "deal-a",
        pipeline_id: "p",
        status_id: "142",
        old_status_id: "100",
        updated_at: 1791201600,
        price: 120,
        custom_fields: [{ code: "UNUSED", values: [{ value: "safe" }] }],
      },
      {
        id: "deal-b",
        pipeline_id: "other",
        status_id: "143",
        last_modified: 1791201600,
      },
    ],
  },
};
const form = new URLSearchParams({
  "account[id]": "account-a",
  "account[subdomain]": "synthetic",
  "leads[status][0][id]": "deal-a",
  "leads[status][0][pipeline_id]": "p",
  "leads[status][0][status_id]": "142",
  "leads[status][0][updated_at]": "1791201600",
  "leads[status][0][custom_fields][0][values][0][value]": "safe",
  "leads[status][1][id]": "deal-b",
  "leads[status][1][pipeline_id]": "other",
  "leads[status][1][status_id]": "143",
  "leads[status][1][last_modified]": "1791201600",
}).toString();
const lockedLicense = {
  getLockState: vi.fn(async () => ({
    inert: false,
    locked: true,
    reason: "revoked",
    state: { status: "blocked" },
  })),
};

describe("Kommo real raw middleware/controller/guard/service HTTP path", () => {
  it.each([
    ["application/json; charset=utf-8", JSON.stringify(payload)],
    ["application/x-www-form-urlencoded", form],
  ])("durably accepts every %s batch item", async (type, body) => {
    const h = await appFor();
    await h.api
      .post(webhook)
      .set("Content-Type", type)
      .send(body)
      .expect(202)
      .expect({ status: "accepted", accepted: 2 });
    expect(h.state.kommoWebhookEvent.map((row) => row.dealId)).toEqual([
      "deal-a",
      "deal-b",
    ]);
    expect(h.adapter.getLead).not.toHaveBeenCalled();
  });
  it.each([
    "text/plain",
    "application/xml",
    "application/json; charset=latin1",
  ])("fails closed for %s", async (type) => {
    const h = await appFor();
    await h.api
      .post(webhook)
      .set("Content-Type", type)
      .send(JSON.stringify(payload))
      .expect(404);
    expect(h.state.kommoWebhookEvent).toHaveLength(0);
  });
  it.each([
    JSON.stringify(payload).replace(
      '"safe"',
      '{"__proto__":{"polluted":true}}',
    ),
    JSON.stringify(payload).replace(
      '"safe"',
      '{"constr\\u0075ctor":{"prototype":{"polluted":true}}}',
    ),
  ])("rejects dangerous JSON keys in unused fields", async (body) => {
    const h = await appFor();
    await h.api
      .post(webhook)
      .set("Content-Type", "application/json")
      .send(body)
      .expect(404);
    expect(({} as any).polluted).toBeUndefined();
    expect(h.state.kommoWebhookEvent).toHaveLength(0);
  });
  it("rejects prototype form paths and bounded JSON bytes/depth/item overflows", async () => {
    const h = await appFor();
    await h.api
      .post(webhook)
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(form + "&__proto__[polluted]=yes")
      .expect(404);
    await h.api
      .post(webhook)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ ...payload, unused: Array(5001).fill(0) }))
      .expect(404);
    await h.api
      .post(webhook)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ ...payload, unused: [[[[[[[[[[0]]]]]]]]]] }))
      .expect(404);
    await h.api
      .post(webhook)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ ...payload, unused: "x".repeat(256 * 1024) }))
      .expect(413);
    expect(h.state.kommoWebhookEvent).toHaveLength(0);
    expect(({} as any).polluted).toBeUndefined();
  });
  it("rejects account spoofing, old capability after rotation, and wrong capability", async () => {
    const h = await appFor();
    await h.api
      .post(webhook)
      .send({ ...payload, account: { id: "other" } })
      .expect(404);
    const response = await h.api
      .post(path + "/rotate-webhook-token")
      .set("Authorization", "Bearer synthetic-session")
      .expect(201);
    await h.api.post(webhook).send(payload).expect(404);
    await h.api
      .post(webhook.replace("synthetic-capability", "wrong"))
      .send(payload)
      .expect(404);
    await h.api.post(response.body.webhookUrl).send(payload).expect(202);
    expect(h.state.kommoWebhookEvent).toHaveLength(2);
  });
  it("enforces actual owner guard and tenant IDOR constraints with redacted DTO", async () => {
    const h = await appFor();
    await h.api.get(path).expect(401);
    await h.api
      .get(path.replace("workspace-a", "other"))
      .set("Authorization", "Bearer synthetic-session")
      .expect(403);
    h.session.workspaces.push({ id: "other", role: "owner" });
    await h.api
      .get(path.replace("workspace-a", "other"))
      .set("Authorization", "Bearer synthetic-session")
      .expect(404);
    h.session.workspaces[0].role = "member";
    await h.api
      .get(path)
      .set("Authorization", "Bearer synthetic-session")
      .expect(403);
    h.session.workspaces[0].role = "owner";
    const response = await h.api
      .get(path)
      .set("Authorization", "Bearer synthetic-session")
      .expect(200);
    expect(JSON.stringify(response.body)).not.toMatch(
      /accessToken|synthetic-token|webhookSecret|credentialGeneration/,
    );
    await h.api
      .patch(path + "/channel-bindings")
      .set("Authorization", "Bearer synthetic-session")
      .send({ allowedChannelRouteIds: ["foreign"] })
      .expect(400);
    await h.api
      .patch(path + "/rules/rule-a")
      .set("Authorization", "Bearer synthetic-session")
      .send({ eventName: "QualifiedLead", currency: null })
      .expect(200);
    await h.api
      .patch(path + "/rules/rule-a")
      .set("Authorization", "Bearer synthetic-session")
      .send({ workspaceId: "other" })
      .expect(400);
  });
  it("derives platform support audit actor from the actual guard", async () => {
    const h = await appFor();
    h.session.user.platformRole = "platform_owner";
    h.session.workspaces = [];
    h.session.supportContext = { workspaceId: "workspace-a" };
    await h.api
      .patch(path + "/channel-bindings")
      .set("Authorization", "Bearer synthetic-session")
      .send({ allowedChannelRouteIds: [] })
      .expect(200);
    expect(h.state.auditLog.at(-1)).toMatchObject({
      actorType: "platform_admin",
      actorUserId: "owner-a",
    });
  });
  it("uses the real global license guard: audit GET remains readable while management and public webhook POST lock", async () => {
    const h = await appFor(lockedLicense);
    await h.api
      .get(path + "/events")
      .set("Authorization", "Bearer synthetic-session")
      .expect(200);
    await h.api
      .patch(path + "/channel-bindings")
      .set("Authorization", "Bearer synthetic-session")
      .send({ allowedChannelRouteIds: [] })
      .expect(423);
    await h.api.post(webhook).send(payload).expect(423);
    expect(h.state.kommoWebhookEvent).toHaveLength(0);
  });
  it("permits public webhook POST when the canonical decision is unlocked", async () => {
    const h = await appFor({
      getLockState: vi.fn(async () => ({
        inert: false,
        locked: false,
        reason: null,
        state: { status: "active" },
      })),
    });
    await h.api.post(webhook).send(payload).expect(202);
  });
});
