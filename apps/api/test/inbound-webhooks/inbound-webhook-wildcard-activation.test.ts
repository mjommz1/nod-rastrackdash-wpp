import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { wildcardFixture } from "../support/inbound-wildcard-fixture";

describe("Meta Cloud BM with three accounts and one destination", () => {
  it("activates one wildcard route and promotes the certified connection", async () => {
    const h = wildcardFixture();
    for (const ad of h.ads) {
      expect(
        await h.reader.previewRoute({
          workspaceId: "ws",
          adId: ad.adId,
          businessConnectionId: "bm",
          conversionDestinationId: "dest",
        }),
      ).toMatchObject({ status: "resolved", conversionDestinationId: "dest" });
    }
    await expect(h.activate()).resolves.toMatchObject({ status: "active" });
    await expect(h.promote()).resolves.toMatchObject({ status: "production" });
    expect(h.channel.routes).toHaveLength(1);
    expect(h.route.metaReportingAccountId).toBeNull();
  });

  it("promotes an already active wildcard channel without filtering it out", async () => {
    const h = wildcardFixture();
    h.channel.status = "active";
    await expect(h.promote()).resolves.toMatchObject({ status: "production" });
  });

  it("supports an optional destination resolved per authorized ad", async () => {
    const h = wildcardFixture();
    h.route.metaConversionDestinationId = null;
    await expect(h.activate()).resolves.toMatchObject({ status: "active" });
  });

  it("keeps an explicit account route working", async () => {
    const h = wildcardFixture();
    h.route.metaReportingAccountId = "account-1";
    await expect(h.activate()).resolves.toMatchObject({ status: "active" });
    await expect(h.promote()).resolves.toMatchObject({ status: "production" });
  });

  it.each(
    [
      "no route",
      "invalid route",
      "inactive route",
      "BM inactive",
      "credential inactive",
      "credential other tenant",
      "other tenant",
      "other BM",
      "account inactive",
      "account other tenant",
      "route other tenant",
      "destination unauthorized",
      "destination other tenant",
      "destination unconfigured",
    ].flatMap((reason) => [
      [reason, "wildcard"],
      [reason, "explicit"],
    ]),
  )("blocks %s on %s route", async (reason, kind) => {
    const h = wildcardFixture();
    if (kind === "explicit") h.route.metaReportingAccountId = "account-1";
    if (reason === "no route") h.channel.routes = [];
    if (reason === "invalid route") h.route.validationStatus = "invalid";
    if (reason === "inactive route") h.route.active = false;
    if (reason === "BM inactive") h.business.status = "inactive";
    if (reason === "credential inactive")
      h.business.credential.status = "revoked";
    if (reason === "credential other tenant")
      h.business.credential.workspaceId = "other";
    if (reason === "other tenant") h.business.workspaceId = "other";
    if (reason === "other BM")
      h.accounts.forEach((a) => (a.businessConnectionId = "other"));
    if (reason === "account inactive")
      h.accounts.forEach((a) => (a.active = false));
    if (reason === "account other tenant")
      h.accounts.forEach((a) => (a.workspaceId = "other"));
    if (reason === "route other tenant") h.route.workspaceId = "other";
    if (reason === "destination unauthorized")
      h.accounts.forEach((a) => (a.allowedDestinations = []));
    if (reason === "destination other tenant")
      h.destination.workspaceId = "other";
    if (reason === "destination unconfigured")
      h.destination.status = "inactive";
    await expect(h.activate()).rejects.toThrow(
      "Configure uma rota Meta valida",
    );
    h.channel.status = "active";
    await expect(h.promote()).rejects.toThrow("Todo canal ativo precisa");
  });

  it("does not promote a connection without active channels", async () => {
    const h = wildcardFixture();
    await expect(h.promote()).rejects.toThrow("Ative ao menos um canal");
  });

  it("keeps an explicitly bound legacy account destination working", async () => {
    const h = wildcardFixture();
    h.accounts[0].allowedDestinations = [];
    h.accounts[0].conversionDestinationId = "dest";
    h.route.metaReportingAccountId = "account-1";
    await expect(h.activate()).resolves.toMatchObject({ status: "active" });
    expect(
      await h.reader.previewRoute({
        workspaceId: "ws",
        adId: "ad-1",
        businessConnectionId: "bm",
        conversionDestinationId: "dest",
      }),
    ).toMatchObject({ status: "resolved" });
  });

  it.each(["observation_only", "retired"])(
    "retains %s parser gate",
    async (status) => {
      const h = wildcardFixture();
      h.channel.status = "active";
      h.connection.parserRelease.status = status;
      if (status === "observation_only") h.connection.parserRelease.version = "v2";
      await expect(h.promote()).rejects.toThrow("Certifique o parser");
    },
  );

  it("denies production while replay is in flight", async () => {
    const h = wildcardFixture();
    h.channel.status = "active";
    h.prisma.inboundWebhookReplayBatch.count.mockResolvedValue(1);
    await expect(h.promote()).rejects.toThrow("Finalize o replay");
  });

  it("does not use BM ownership as authorization for an unassigned account", async () => {
    const h = wildcardFixture();
    h.accounts[0].allowedDestinations = [];
    expect(
      await h.reader.previewRoute({
        workspaceId: "ws",
        adId: "ad-1",
        businessConnectionId: "bm",
        conversionDestinationId: "dest",
      }),
    ).toMatchObject({
      status: "unresolved",
      reason: "conversion_destination_not_authorized",
    });
  });

  it("keeps ambiguous per-ad assignment fail-closed even with explicit route destination", async () => {
    const h = wildcardFixture();
    h.accounts[0].allowedDestinations.push({
      workspaceId: "ws",
      active: true,
      conversionDestinationId: "dest-2",
    });
    expect(
      await h.reader.previewRoute({
        workspaceId: "ws",
        adId: "ad-1",
        businessConnectionId: "bm",
        conversionDestinationId: "dest",
      }),
    ).toMatchObject({
      status: "unresolved",
      reason: "ad_destination_unresolved",
    });
  });
});
