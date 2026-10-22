import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  wildcardDispatchFixture,
  wildcardFixture,
} from "../support/inbound-wildcard-fixture";
import { inboundParserProductionEligible } from "../../src/inbound-webhooks/inbound-webhook-parser-eligibility";
import { InboundWebhookParserRegistry } from "../../src/inbound-webhooks/providers/inbound-webhook-parser.registry";
import { MetaCloudV1Parser } from "../../src/inbound-webhooks/providers/meta-cloud/meta-cloud-v1.parser";
import { applyInboundWebhookConnectionStatus } from "../../src/inbound-webhooks/inbound-webhook-production-activation";

describe("student built-in Meta Cloud production", () => {
  it("promotes the validated exact v1 even when an older install persisted observation_only", async () => {
    const h = wildcardFixture();
    h.connection.parserRelease.status = "observation_only";
    await h.activate();
    await expect(
      applyInboundWebhookConnectionStatus(h.prisma, {
        workspaceId: "ws",
        connectionId: "connection",
        actorUserId: "actor",
        status: "production",
        requireValidMetaRoute: true,
        seats: h.seats,
        env: { META_APP_SECRET: "synthetic-app-secret" },
      } as any),
    ).resolves.toMatchObject({ status: "production" });
  });
  it("refuses production without the student's own app signing secret", async () => {
    const h = wildcardFixture();
    await h.activate();
    await expect(
      applyInboundWebhookConnectionStatus(h.prisma, {
        workspaceId: "ws",
        connectionId: "connection",
        actorUserId: "actor",
        status: "production",
        requireValidMetaRoute: true,
        seats: h.seats,
        env: {},
      }),
    ).rejects.toThrow("META_APP_SECRET");
  });
  it.each(["v2", "custom", "UNKNOWN"])(
    "rejects an unregistered version %s even marked certified",
    async (version) => {
      const h = wildcardFixture();
      h.connection.parserRelease.version = version;
      await h.activate();
      await expect(h.promote()).rejects.toThrow();
    },
  );
  it("keeps new deliveries moving through intake and worker with old same-version observation status", async () => {
    const h = wildcardDispatchFixture();
    h.connection.parserRelease.status = "observation_only";
    const intake = await h.intake.enqueueDelivery({
      workspaceId: "ws",
      connectionId: "connection",
      deliveryId: "delivery",
    });
    expect(intake.persisted).toBe(1);
    await h.production.processItem({
      workspaceId: "ws",
      productionItemId: "item",
    });
    expect(h.conversionQueue.enqueueSend).toHaveBeenCalledOnce();
  });
  it("does not grant native trust to a different registry implementation that calls itself meta_cloud/v1", () => {
    const native = new MetaCloudV1Parser();
    const custom = {
      provider: native.provider,
      parserVersion: native.parserVersion,
      parse: native.parse.bind(native),
    };
    expect(
      inboundParserProductionEligible(
        { provider: "meta_cloud", version: "v1", status: "certified" },
        new InboundWebhookParserRegistry([custom]),
      ),
    ).toBe(false);
  });
});
