import "reflect-metadata";
import { UnauthorizedException } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";
import { StudentInboundReplayController } from "../../src/inbound-webhook-replay/student-inbound-replay.controller";
import { InboundWebhookReplayService } from "../../src/inbound-webhook-replay/inbound-webhook-replay.service";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { studentReplayFixture } from "../support/student-replay-fixture";

const apps: NestExpressApplication[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
const base = "/integrations/inbound-webhooks/connection/channels/channel/recovery";
async function fixture(locked = false) {
  const h = studentReplayFixture();
  const session: any = { user: { id: "actor", platformRole: "user" }, activeWorkspaceId: "ws", workspaces: [{ id: "ws", name: "synthetic", slug: "synthetic", role: "owner", operationalStatus: "active" }] };
  const auth = { getSession: vi.fn(async (token: string) => { if (token !== "synthetic-session") throw new UnauthorizedException(); return session; }) };
  const license = { getLockState: vi.fn(async () => ({ inert: false, locked, reason: "revoked", state: { status: "blocked" } })) };
  const module = await Test.createTestingModule({ controllers: [StudentInboundReplayController], providers: [
    { provide: AuthService, useValue: auth },
    { provide: WorkspacesService, useValue: new WorkspacesService(h.prisma) },
    { provide: InboundWebhookReplayService, useValue: h.replay },
    { provide: LicenseClientService, useValue: license },
    { provide: APP_GUARD, useClass: LicenseSoftlockGuard },
  ] }).compile();
  const app = module.createNestApplication<NestExpressApplication>(); apps.push(app); await app.init();
  return { ...h, session, app, api: request(app.getHttpServer()) };
}
const bearer = "Bearer synthetic-session";
describe("student replay authenticated HTTP/controller/service flow", () => {
  it("wires preview, explicit canary authorization, result polling and remaining", async () => {
    const h = await fixture(); h.addEvent(2);
    const p = await h.api.get(`${base}/preview`).set("Authorization", bearer).expect(200);
    expect(p.body).toMatchObject({ eligible: 2, canSendRemaining: false });
    expect(JSON.stringify(p.body)).not.toMatch(/encryptedPayload|payloadIv|ctwaClid|phoneNumber|secretHash/);
    const auth = await h.api.post(`${base}/authorize`).set("Authorization", bearer).send({ selection: "canary_1", confirmation: "fixture", previewToken: p.body.previewToken }).expect(200);
    expect(auth.body).toMatchObject({ delivered: 0, total: 1, state: "pending" });
    await h.api.get(`${base}/batches/${auth.body.batchId}`).set("Authorization", bearer).expect(200);
    await h.replay.processBatch({ workspaceId: "ws", batchId: auth.body.batchId });
    Object.assign(h.logs[0], { status: "sent", sentAt: new Date() });
    const next = await h.api.get(`${base}/preview`).set("Authorization", bearer).expect(200);
    expect(next.body.canSendRemaining).toBe(true);
    await h.api.post(`${base}/authorize`).set("Authorization", bearer).send({ selection: "remaining", confirmation: "fixture", previewToken: next.body.previewToken }).expect(200);
    expect(h.replayQueue.enqueueBatch).toHaveBeenCalledTimes(2);
  });

  it.each(["admin", "analyst"])("denies %s on preview, authorization and polling", async (role) => {
    const h = await fixture(); h.session.workspaces[0].role = role;
    await h.api.get(`${base}/preview`).set("Authorization", bearer).expect(403);
    await h.api.post(`${base}/authorize`).set("Authorization", bearer).send({}).expect(403);
    await h.api.get(`${base}/batches/any`).set("Authorization", bearer).expect(403);
    expect(h.replayQueue.enqueueBatch).not.toHaveBeenCalled();
  });
  it("denies missing authentication, another workspace/channel and support impersonation", async () => {
    const h = await fixture();
    await h.api.get(`${base}/preview`).expect(401);
    await h.api.get(base.replace("/channel/", "/foreign/") + "/preview").set("Authorization", bearer).expect(404);
    await h.api.get(base.replace("/connection/", "/foreign/") + "/preview").set("Authorization", bearer).expect(404);
    h.session.activeWorkspaceId = "other"; h.session.workspaces = [{ id: "other", role: "owner", operationalStatus: "active" }];
    await h.api.get(`${base}/preview`).set("Authorization", bearer).expect(403);
    h.session.supportContext = { workspaceId: "ws", workspaceName: "synthetic", workspaceSlug: "synthetic", operationalStatus: "active" };
    h.session.user.platformRole = "platform_owner";
    await h.api.get(`${base}/preview`).set("Authorization", bearer).expect(403);
  });
  it("ignores no request-supplied actor/workspace: strict input denies forged scope", async () => {
    const h = await fixture(); const p = await h.preview();
    await h.api.post(`${base}/authorize`).set("Authorization", bearer).send({ selection: "canary_1", confirmation: "fixture", previewToken: p.previewToken, actor: { id: "other" }, workspaceId: "other" }).expect(400);
    expect(h.replayQueue.enqueueBatch).not.toHaveBeenCalled();
  });
  it("preserves the real license soft-lock guard and read access", async () => {
    const h = await fixture(true);
    const p = await h.api.get(`${base}/preview`).set("Authorization", bearer).expect(200);
    await h.api.post(`${base}/authorize`).set("Authorization", bearer).send({ selection: "canary_1", confirmation: "fixture", previewToken: p.body.previewToken }).expect(423);
    expect(h.replayQueue.enqueueBatch).not.toHaveBeenCalled();
  });
  it("denies result lookup in another channel and exposes no retry/send-all endpoint", async () => {
    const h = await fixture(); const batch = await h.authorize();
    await h.api.get(base.replace("/channel/", "/foreign/") + `/batches/${batch.batchId}`).set("Authorization", bearer).expect(404);
    await h.api.post(`${base}/retry`).set("Authorization", bearer).send({}).expect(404);
    await h.api.post(`${base}/authorize`).set("Authorization", bearer).send({ selection: "canary_10", confirmation: "fixture", previewToken: "invalid" }).expect(400);
  });
});
