import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { studentReplayFixture } from "../support/student-replay-fixture";

describe("student historical recovery safety", () => {
  it("denies remaining without a successful delivered canary", async () => {
    const h = studentReplayFixture();
    await expect(h.authorize("remaining")).rejects.toThrow("Envie um de teste");
    expect(h.replayQueue.enqueueBatch).not.toHaveBeenCalled();
  });
  it("excludes events outside Meta's historical window even when encrypted payload is retained", async () => {
    const h = studentReplayFixture();
    h.event.occurredAt = new Date(Date.now() - 8 * 86400_000);
    expect((await h.preview()).eligible).toBe(0);
    expect(h.replayQueue.enqueueBatch).not.toHaveBeenCalled();
  });
  it("rejects actor from another workspace", async () => {
    const h = studentReplayFixture();
    await expect(
      h.replay.previewStudentReplay(
        { ...h.actor, workspaceId: "other" },
        "connection",
        "channel",
      ),
    ).rejects.toThrow();
  });

  it("previews metadata, authorizes one, polls pending, then allows remaining only after confirmed delivery", async () => {
    const h = studentReplayFixture();
    h.addEvent(2, 1);
    const p = await h.preview();
    expect(p).toMatchObject({ eligible: 2, canSendRemaining: false });
    expect(JSON.stringify(p)).not.toContain(h.delivery.encryptedPayload);
    expect(JSON.stringify(p)).not.toContain("15550000002");
    expect(JSON.stringify(p)).not.toContain("synthetic-clid");
    const batch = await h.authorize("canary_1", p.previewToken!);
    expect(batch).toMatchObject({ state: "pending", total: 1, delivered: 0 });
    await h.replay.processBatch({ workspaceId: "ws", batchId: batch.batchId });
    expect(
      await h.replay.getStudentReplayResult(
        h.actor,
        "connection",
        "channel",
        batch.batchId,
      ),
    ).toMatchObject({ state: "pending", delivered: 0 });
    expect((await h.preview()).canSendRemaining).toBe(false);
    Object.assign(h.logs[0], { status: "sent", sentAt: new Date() });
    const next = await h.preview();
    expect(next).toMatchObject({
      eligible: 1,
      canSendRemaining: true,
      latestBatch: { state: "delivered", delivered: 1 },
    });
    const rest = await h.authorize("remaining", next.previewToken!);
    expect(rest).toMatchObject({ state: "pending", total: 1, delivered: 0 });
    expect(h.replayQueue.enqueueBatch).toHaveBeenCalledTimes(2);
    expect(
      h.audits.filter((a) => a.action === "inbound_webhook.replay.authorize"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: "actor",
          actorType: "owner",
          workspaceId: "ws",
        }),
      ]),
    );
  });

  it.each([
    "non CTWA",
    "expired payload",
    "missing payload",
    "different parser",
    "duplicate log",
    "sent log",
    "unknown log",
    "wrong identity",
    "other workspace",
    "other channel",
  ])("excludes %s from the preview", async (reason) => {
    const h = studentReplayFixture();
    if (reason === "non CTWA") h.event.hasCtwa = false;
    if (reason === "expired payload")
      h.delivery.payloadExpiresAt = new Date(Date.now() - 1);
    if (reason === "missing payload")
      (h.delivery as any).encryptedPayload = null;
    if (reason === "different parser") h.delivery.parserVersion = "v2";
    if (reason === "wrong identity")
      (h.channel as any).providerChannelId = "other";
    if (reason === "other workspace") h.event.workspaceId = "other";
    if (reason === "other channel") h.event.channelId = "other";
    if (reason.endsWith("log"))
      h.logs.push({
        id: "log",
        workspaceId: "ws",
        status:
          reason === "sent log"
            ? "sent"
            : reason === "unknown log"
              ? "delivery_unknown"
              : "ready_to_send",
        dedupeKey: `inbound-webhook:connection:${h.event.dedupeKey}`,
      });
    expect((await h.preview()).eligible).toBe(0);
    expect(h.replayQueue.enqueueBatch).not.toHaveBeenCalled();
  });

  it.each([
    "route",
    "credential",
    "destination permission",
    "owner",
    "retired",
    "connection",
    "expired preview",
  ])("revokes authorization when %s changes after preview", async (reason) => {
    const h = studentReplayFixture();
    const p = await h.preview();
    expect(p.previewToken).toBeTruthy();
    if (reason === "route") h.route.active = false;
    if (reason === "credential") h.business.credential.status = "revoked";
    if (reason === "destination permission")
      h.accounts[0].allowedDestinations = [];
    if (reason === "owner") h.owner.role = "admin";
    if (reason === "retired") h.connection.parserRelease.status = "retired";
    if (reason === "connection") h.connection.status = "paused";
    if (reason === "expired preview") {
      const ticket = (h.replay as any).readStudentPreview(p.previewToken);
      ticket.expires = Date.now() - 1;
      p.previewToken = (h.replay as any).signStudentPreview(ticket);
    }
    await expect(h.authorize("canary_1", p.previewToken!)).rejects.toThrow();
    expect(h.replayQueue.enqueueBatch).not.toHaveBeenCalled();
  });

  it.each(["owner", "route", "flag", "license"])(
    "blocks the worker after %s revocation",
    async (reason) => {
      const h = studentReplayFixture();
      const batch = await h.authorize();
      if (reason === "owner") h.owner.role = "admin";
      if (reason === "route") h.route.active = false;
      if (reason === "flag") h.env.INBOUND_WEBHOOK_REPLAY_ENABLED = "false";
      if (reason === "license")
        h.license.getLockState.mockResolvedValue({
          inert: false,
          locked: true,
        });
      await h.replay.processBatch({
        workspaceId: "ws",
        batchId: batch.batchId,
      });
      expect(h.leads.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
      expect(h.conversionQueue.enqueueSend).not.toHaveBeenCalled();
    },
  );

  it("rejects concurrent approvals and an active batch", async () => {
    const h = studentReplayFixture();
    const p = await h.preview();
    const settled = await Promise.allSettled([
      h.authorize("canary_1", p.previewToken!),
      h.authorize("canary_1", p.previewToken!),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(h.batches).toHaveLength(1);
    expect(h.replayQueue.enqueueBatch).toHaveBeenCalledOnce();
    expect((await h.preview()).unavailableReason).toContain("andamento");
  });

  it("reports disabled replay and missing signing configuration without bypassing flags", async () => {
    const h = studentReplayFixture();
    h.env.INBOUND_WEBHOOK_REPLAY_ENABLED = "false";
    expect(await h.preview()).toMatchObject({
      previewToken: null,
      unavailableReason: expect.stringContaining(
        "INBOUND_WEBHOOK_REPLAY_ENABLED",
      ),
    });
    h.env.INBOUND_WEBHOOK_REPLAY_ENABLED = "true";
    h.env.META_APP_SECRET = "";
    expect(await h.preview()).toMatchObject({
      previewToken: null,
      unavailableReason: expect.stringContaining("META_APP_SECRET"),
    });
  });

  it("does not reuse a preview or allow another channel/owner to consume it", async () => {
    const h = studentReplayFixture();
    const p = await h.preview();
    await expect(
      h.replay.authorizeStudentReplay(h.actor, "connection", "other", {
        selection: "canary_1",
        confirmation: "fixture",
        previewToken: p.previewToken!,
      }),
    ).rejects.toThrow();
    await h.authorize("canary_1", p.previewToken!);
    await expect(h.authorize("canary_1", p.previewToken!)).rejects.toThrow();
    expect(h.batches).toHaveLength(1);
  });

  it("reports UNKNOWN and blocks remaining on an uncertain canary", async () => {
    const h = studentReplayFixture();
    h.addEvent(2);
    const batch = await h.authorize();
    await h.replay.processBatch({ workspaceId: "ws", batchId: batch.batchId });
    h.logs[0].status = "delivery_unknown";
    expect(
      await h.replay.getStudentReplayResult(
        h.actor,
        "connection",
        "channel",
        batch.batchId,
      ),
    ).toMatchObject({ state: "delivery_unknown", unknown: 1, delivered: 0 });
    expect((await h.preview()).canSendRemaining).toBe(false);
    await expect(h.authorize("remaining")).rejects.toThrow();
  });
  it("caps remaining at 500 events from the immutable preview", async () => {
    const h = studentReplayFixture();
    const canary = await h.authorize();
    await h.replay.processBatch({ workspaceId: "ws", batchId: canary.batchId });
    Object.assign(h.logs[0], { status: "sent", sentAt: new Date() });
    for (let i = 2; i <= 503; i++) h.addEvent(i, i % 3);
    const preview = await h.preview();
    expect(preview).toMatchObject({
      eligible: 502,
      batchLimit: 500,
      canSendRemaining: true,
    });
    const rest = await h.authorize("remaining", preview.previewToken!);
    expect(rest.total).toBe(500);
    expect(h.items.filter((i) => i.batchId === rest.batchId)).toHaveLength(500);
    expect(h.replayQueue.enqueueBatch).toHaveBeenCalledTimes(2);
  });

  it.each([
    "fingerprint",
    "credential id",
    "token updated",
    "payload",
    "event time",
  ])("rejects %s changes after preview, before approval", async (reason) => {
    const h = studentReplayFixture();
    const preview = await h.preview();
    if (reason === "fingerprint")
      (h.business.credential as any).fingerprint = "rotation";
    if (reason === "credential id")
      (h.business as any).credentialId = "replacement";
    if (reason === "token updated")
      h.prisma.metaIntegration.findUnique.mockResolvedValue({
        id: "integration",
        updatedAt: new Date(),
      });
    if (reason === "payload") h.delivery.encryptedPayload = "changed";
    if (reason === "event time")
      h.event.occurredAt = new Date(Date.now() - 1000);
    await expect(
      h.authorize("canary_1", preview.previewToken!),
    ).rejects.toThrow();
    expect(h.replayQueue.enqueueBatch).not.toHaveBeenCalled();
  });

  it("revalidates owner before conversion creation and queue dispatch after the lead boundary", async () => {
    const h = studentReplayFixture();
    const batch = await h.authorize();
    h.leads.upsertFromWhatsappWebhook.mockImplementationOnce(async () => {
      h.owner.role = "analyst";
      return { id: "lead" };
    });
    await h.replay.processBatch({ workspaceId: "ws", batchId: batch.batchId });
    expect(h.conversions.recordExternalConversion).not.toHaveBeenCalled();
    expect(h.conversionQueue.enqueueSend).not.toHaveBeenCalled();
    expect(h.items[0]).toMatchObject({
      status: "failed",
      errorCode: "inbound_webhook_replay_authorization_changed",
    });
  });
});
