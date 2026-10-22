import { studentReplayFixture } from "../support/student-replay-fixture";
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  wildcardDispatchFixture,
} from "../support/inbound-wildcard-fixture";

describe("wildcard CTWA dispatch and retained history", () => {
  it.each(["wildcard", "optional destination", "explicit"])(
    "selects a historical %s canary through the existing authorization service",
    async (kind) => {
      const h = studentReplayFixture();
      if (kind === "optional destination")
        h.route.metaConversionDestinationId = null;
      if (kind === "explicit") h.route.metaReportingAccountId = "account-1";
      expect(
        await h.authorize(),
      ).toMatchObject({ state: "pending", total: 1 });
      expect(h.prisma.inboundWebhookReplayItem.createMany).toHaveBeenCalledWith(
        {
          data: [
            {
              workspaceId: "ws",
              batchId: expect.any(String),
              eventId: "event",
              status: "queued",
            },
          ],
          skipDuplicates: true,
        },
      );
      expect(h.replayQueue.enqueueBatch).toHaveBeenCalledWith({
        workspaceId: "ws",
        batchId: expect.any(String),
      });
      await expect(
        h.authorize(),
      ).rejects.toThrow("andamento");
    },
  );

  it("refuses a historical canary after destination authorization is revoked", async () => {
    const h = studentReplayFixture();
    h.route.metaReportingAccountId = "account-1";
    h.accounts[0].allowedDestinations = [];
    await expect(
      h.authorize(),
    ).rejects.toThrow(
      "Nenhum evento possui rota completa e payload disponivel",
    );
    expect(h.replayQueue.enqueueBatch).not.toHaveBeenCalled();
  });

  it("rejects a canary when the duplicate insert claims no event", async () => {
    const h = studentReplayFixture();
    h.prisma.inboundWebhookReplayItem.createMany.mockResolvedValue({
      count: 0,
    });
    await expect(
      h.authorize(),
    ).rejects.toThrow("Os eventos elegiveis ja pertencem a outro replay");
    expect(h.replayQueue.enqueueBatch).not.toHaveBeenCalled();
  });
  it.each(["wildcard", "optional destination", "explicit"])(
    "materializes %s through production with concrete authorized IDs",
    async (kind) => {
      const h = wildcardDispatchFixture();
      if (kind === "optional destination")
        h.route.metaConversionDestinationId = null;
      if (kind === "explicit") h.route.metaReportingAccountId = "account-1";
      await expect(
        h.production.processItem({
          workspaceId: "ws",
          productionItemId: "item",
        }),
      ).resolves.toEqual({ status: "materialized" });
      expect(h.conversions.recordExternalConversion).toHaveBeenCalledWith(
        expect.objectContaining({
          metaBusinessConnectionId: "bm",
          metaAccountId: "act-1",
          metaConversionDestinationId: "dest",
          dedupeKey: `inbound-webhook:connection:${h.event.dedupeKey}`,
        }),
      );
      await expect(
        h.production.processItem({
          workspaceId: "ws",
          productionItemId: "item",
        }),
      ).resolves.toEqual({ status: "unchanged" });
      expect(h.conversions.recordExternalConversion).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts explicitly authorized retained pre-activation CTWA in the existing replay worker, once", async () => {
    const h = studentReplayFixture();
    const batch = await h.authorize();
    await h.replay.processBatch({ workspaceId: "ws", batchId: batch.batchId });
    expect(h.items[0].status).toBe("materialized");
    await h.replay.processBatch({ workspaceId: "ws", batchId: batch.batchId });
    expect(h.conversions.recordExternalConversion).toHaveBeenCalledTimes(1);
  });

  it("reevaluates retained CTWA after activation without creating historical sends", async () => {
    const h = wildcardDispatchFixture();
    h.delivery.firstReceivedAt = new Date(Date.now() - 120_000);
    expect(await h.routes.reevaluateOpenEvents("ws", "channel")).toMatchObject({
      resolvedCount: 1,
    });
    expect(h.channel.routes).toHaveLength(1);
    expect(
      await h.intake.enqueueDelivery({
        workspaceId: "ws",
        connectionId: "connection",
        deliveryId: "delivery",
      }),
    ).toMatchObject({ eligible: 0, persisted: 0 });
    expect(
      h.prisma.inboundWebhookProductionItem.createMany,
    ).not.toHaveBeenCalled();
    expect(h.conversionQueue.enqueueSend).not.toHaveBeenCalled();
    expect(await h.intake.recoverPendingItems()).toMatchObject({ eligible: 0 });
  });

  it("recovers an existing queued production item through the existing queue", async () => {
    const h = wildcardDispatchFixture();
    h.prisma.inboundWebhookProductionItem.findMany.mockResolvedValue([
      { id: "item", workspaceId: "ws" },
    ]);
    expect(await h.intake.recoverPendingItems()).toMatchObject({
      eligible: 1,
      queued: 1,
    });
    expect(h.queue.enqueueItem).toHaveBeenCalledWith({
      productionItemId: "item",
      workspaceId: "ws",
    });
  });

  it.each(["production", "replay"])(
    "%s refuses revoked authorization even with a retained resolved event",
    async (mode) => {
      const h = mode === "replay" ? studentReplayFixture() : { ...wildcardDispatchFixture(), authorize: async () => ({ batchId: "unused" }), items: [] as any[] };
      const approved = await h.authorize();
      h.route.metaReportingAccountId = "account-1";
      h.accounts[0].allowedDestinations = [];
      if (mode === "replay")
        h.delivery.firstReceivedAt = new Date(Date.now() - 120_000);
      if (mode === "production")
        await expect(
          h.production.processItem({
            workspaceId: "ws",
            productionItemId: "item",
          }),
        ).rejects.toMatchObject({
          code: "inbound_webhook_production_route_invalid",
        });
      else {
        await h.replay.processBatch({ workspaceId: "ws", batchId: approved.batchId });
        expect(h.items[0].errorCode).toBe("inbound_webhook_replay_route_invalid");
      }
      expect(h.leads.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
      expect(h.conversionQueue.enqueueSend).not.toHaveBeenCalled();
    },
  );

  it("readiness rechecks asset eligibility instead of trusting stale validation", async () => {
    const h = wildcardDispatchFixture();
    h.business.credential.status = "revoked";
    const [channel] = await h.routes.listChannels("ws", "connection");
    expect(channel.readiness).toMatchObject({
      validRouteCount: 0,
      state: "blocked",
    });
  });

  it("preview counts the authorized historical wildcard but rejects revoked access", async () => {
    const h = wildcardDispatchFixture();
    h.delivery.firstReceivedAt = new Date(Date.now() - 120_000);
    expect(await h.replay.getPreview("connection")).toMatchObject({
      counts: { routeResolved: 1, eligible: 1 },
    });
    h.accounts[0].allowedDestinations = [];
    expect(await h.replay.getPreview("connection")).toMatchObject({
      counts: { routeResolved: 0, eligible: 0 },
    });
  });

  it("keeps the student replay flag disabled and its authorization closed", async () => {
    const h = studentReplayFixture();
    const preview = await h.preview();
    h.env.INBOUND_WEBHOOK_REPLAY_ENABLED = "false";
    await expect(
      h.authorize("canary_1", preview.previewToken!),
    ).rejects.toThrow("Replay controlado desativado neste ambiente");
    expect(h.leads.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
  });

  it("does not learn extra routes when an operator route restricts the destination", async () => {
    const h = wildcardDispatchFixture();
    h.route.metaConversionDestinationId = "unconfigured-other";
    expect(await h.routes.reevaluateOpenEvents("ws", "channel")).toMatchObject({
      resolvedCount: 0,
      unresolvedCount: 1,
    });
    expect(h.channel.routes).toHaveLength(1);
    expect(h.prisma.inboundWebhookChannelRoute.findMany).not.toHaveBeenCalled();
  });

  it.each([
    "BM inactive",
    "credential inactive",
    "credential other tenant",
    "account inactive",
    "account other BM",
    "destination inactive",
    "destination other tenant",
    "ambiguous destination",
    "inactive route",
    "invalid route",
    "explicit account mismatch",
    "route other tenant",
    "parser observation",
    "parser retired",
    "payload expired",
  ])(
    "blocks dispatch and replay for %s before materializing",
    async (reason) => {
      for (const mode of ["production", "replay"]) {
        const h = wildcardDispatchFixture();
        if (mode === "replay")
          h.delivery.firstReceivedAt = new Date(Date.now() - 120_000);
        if (reason === "BM inactive") h.business.status = "inactive";
        if (reason === "credential inactive")
          h.business.credential.status = "revoked";
        if (reason === "credential other tenant")
          h.business.credential.workspaceId = "other";
        if (reason === "account inactive") h.accounts[0].active = false;
        if (reason === "account other BM")
          h.accounts[0].businessConnectionId = "other";
        if (reason === "destination inactive")
          h.destination.status = "inactive";
        if (reason === "destination other tenant")
          h.destination.workspaceId = "other";
        if (reason === "ambiguous destination")
          h.accounts[0].allowedDestinations.push({
            workspaceId: "ws",
            active: true,
            conversionDestinationId: "dest-2",
          });
        if (reason === "inactive route") h.route.active = false;
        if (reason === "invalid route") h.route.validationStatus = "invalid";
        if (reason === "explicit account mismatch")
          h.route.metaReportingAccountId = "account-2";
        if (reason === "route other tenant") h.route.workspaceId = "other";
        if (reason === "parser observation")
          { h.connection.parserRelease.status = "observation_only"; h.connection.parserRelease.version = "v2"; }
        if (reason === "parser retired")
          h.connection.parserRelease.status = "retired";
        if (reason === "payload expired")
          h.delivery.payloadExpiresAt = new Date(Date.now() - 1);
        if (mode === "production")
          await expect(
            h.production.processItem({
              workspaceId: "ws",
              productionItemId: "item",
            }),
          ).rejects.toHaveProperty("code");
        else {
          await (h.replay as any).processItem("batch", "ws", "item");
          expect(h.item.status).toBe("failed");
        }
        expect(h.leads.upsertFromWhatsappWebhook).not.toHaveBeenCalled();
        expect(h.conversions.recordExternalConversion).not.toHaveBeenCalled();
        expect(h.conversionQueue.enqueueSend).not.toHaveBeenCalled();
      }
    },
  );

  it("reuses the same conversion dedupe identity across live and historical workers", async () => {
    const live = wildcardDispatchFixture();
    const historical = studentReplayFixture();
    const approved = await historical.authorize();
    historical.conversions.recordExternalConversion.mockResolvedValue({
      status: "duplicate",
      conversionEventLogId: "conversion",
      deliveryStatus: "sent",
    });
    await live.production.processItem({
      workspaceId: "ws",
      productionItemId: "item",
    });
    await historical.replay.processBatch({ workspaceId: "ws", batchId: approved.batchId });
    expect(historical.items[0].status).toBe("duplicate");
    expect(
      historical.conversions.recordExternalConversion.mock.calls[0][0],
    ).toMatchObject({
      dedupeKey:
        live.conversions.recordExternalConversion.mock.calls[0][0].dedupeKey,
      eventId:
        live.conversions.recordExternalConversion.mock.calls[0][0].eventId,
    });
    expect(historical.conversionQueue.enqueueSend).not.toHaveBeenCalled();
  });
});
