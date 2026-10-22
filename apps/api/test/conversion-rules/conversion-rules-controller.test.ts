import "reflect-metadata";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import { ConversionCatalogService } from "../../src/conversion-rules/conversion-catalog.service";
import { ConversionRulesController } from "../../src/conversion-rules/conversion-rules.controller";
import { ConversionRulesService } from "../../src/conversion-rules/conversion-rules.service";
import { FunnelConfigurationService } from "../../src/conversion-rules/funnel-configuration.service";
import { ProviderConversionRulesService } from "../../src/conversion-rules/provider-conversion-rules.service";
import { providerRuleCapabilities } from "../../src/conversion-rules/provider-rule-scope";
import { LicenseClientService } from "../../src/licensing-client/license-client.service";
import { LicenseSoftlockGuard } from "../../src/licensing-client/license-softlock.guard";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";

type Role = "owner" | "admin" | "member";
const requestKey = "attempt_0123456789abcdef";

async function createApp(
  role: Role = "owner",
  options: { licenseLocked?: boolean } = {},
) {
  const authService = {
    getSession: vi.fn(async () => ({
      user: { id: "user_1", email: "owner@example.test", name: "Owner" },
      workspaces: [{ id: "workspace_1", name: "W", slug: "w", role }],
    })),
  };
  const workspacesService = {
    getCurrentWorkspace: vi.fn(() => ({
      id: "workspace_1",
      name: "W",
      slug: "w",
      role,
      permissions: {
        canManageIntegrations: role === "owner" || role === "admin",
      },
    })),
  };
  const conversionRulesService = {
    listRules: vi.fn(async () => []),
    listLegacyRules: vi.fn(async () => [
      {
        id: "legacy_1",
        kind: "legacy",
        adaptable: true,
        adaptBlockedReason: null,
      },
    ]),
    createRule: vi.fn(async () => ({ id: "rule_1" })),
    updateRule: vi.fn(async () => ({ id: "rule_1", active: false })),
    evaluateTriggers: vi.fn(async () => []),
  };
  const providerConversionRulesService = {
    listRules: vi.fn(async () => []),
    createRule: vi.fn(async (...args: unknown[]) =>
      args.length === 4
        ? {
            outcome: "replayed",
            receipt: {
              ruleId: "provider_rule_1",
              connectionId: null,
              createdAt: "2026-10-15T12:00:00.000Z",
            },
          }
        : { rule: { id: "provider_rule_1" }, webhookUrl: null },
    ),
    lookupCreateReceipt: vi.fn(async () => ({
      outcome: "absent",
      code: "provider_rule_create_receipt_absent",
    })),
    getCapabilities: vi.fn(() => providerRuleCapabilities()),
    listUnifyCandidates: vi.fn(async () => ({ groups: [] })),
    unifyRules: vi.fn(async () => ({
      outcome: "created",
      rule: { id: "global_1" },
      deactivatedRuleIds: ["rule_a", "rule_b"],
      newlyCoveredChannelIds: [],
    })),
    adaptLegacyMessageRule: vi.fn(async () => ({ id: "provider_rule_1" })),
    updateRule: vi.fn(async () => ({ id: "provider_rule_1" })),
    removeRule: vi.fn(async () => undefined),
    listRuleExecutions: vi.fn(async () => ({ items: [] })),
  };
  const licenseClientService = {
    getLockState: vi.fn(async () => ({
      inert: false,
      locked: options.licenseLocked === true,
      reason: options.licenseLocked ? "expired" : null,
      state: {
        status: options.licenseLocked ? "blocked" : "active",
        usable: !options.licenseLocked,
      },
    })),
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [ConversionRulesController],
    providers: [
      { provide: AuthService, useValue: authService },
      { provide: WorkspacesService, useValue: workspacesService },
      { provide: ConversionRulesService, useValue: conversionRulesService },
      { provide: FunnelConfigurationService, useValue: {} },
      {
        provide: ProviderConversionRulesService,
        useValue: providerConversionRulesService,
      },
      { provide: ConversionCatalogService, useValue: {} },
      ...(options.licenseLocked !== undefined
        ? [
            { provide: LicenseClientService, useValue: licenseClientService },
            { provide: APP_GUARD, useClass: LicenseSoftlockGuard },
          ]
        : []),
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return {
    app,
    server: app.getHttpServer(),
    conversionRulesService,
    providerConversionRulesService,
  };
}

const messageRule = {
  name: "Pix confirmado",
  scope: "all_numbers",
  triggerType: "message_phrase",
  eventName: "Purchase",
  triggerPhrases: ["pix confirmado"],
  messageAuthorScope: "team",
  valueMode: "fixed",
  defaultValueCents: 10_000,
};

describe("conversion rules controller: Conversoes (Fase 3)", () => {
  it("tells any workspace member the scope capability matrix", async () => {
    const { app, server, providerConversionRulesService } =
      await createApp("member");

    await request(server)
      .get("/conversion-rules/providers/capabilities")
      .set("Authorization", "Bearer refresh-token")
      .expect(200)
      .expect(({ body }) => {
        expect(body.workspaceScopeEnabled).toBe(true);
        expect(body.unsupportedWhatsappProviders).toEqual([
          "waha",
          "zapi",
          "nod_api",
        ]);
      });

    expect(providerConversionRulesService.getCapabilities).toHaveBeenCalledTimes(
      1,
    );
    expect(providerConversionRulesService.updateRule).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates an all-numbers rule without connection and forwards the scope", async () => {
    const { app, server, providerConversionRulesService } = await createApp();

    await request(server)
      .post("/conversion-rules/providers")
      .set("Authorization", "Bearer refresh-token")
      .send(messageRule)
      .expect(201);

    expect(providerConversionRulesService.createRule).toHaveBeenCalledWith(
      "workspace_1",
      expect.objectContaining({
        scope: "all_numbers",
        channelIds: [],
        mode: "observation",
      }),
      "user_1",
    );
    await app.close();
  });

  it("rejects channels on an all-numbers rule and a specific rule without numbers", async () => {
    const { app, server, providerConversionRulesService } = await createApp();

    await request(server)
      .post("/conversion-rules/providers")
      .set("Authorization", "Bearer refresh-token")
      .send({ ...messageRule, channelIds: ["channel_1"] })
      .expect(400);
    await request(server)
      .post("/conversion-rules/providers")
      .set("Authorization", "Bearer refresh-token")
      .send({ ...messageRule, scope: "specific_numbers" })
      .expect(400);

    expect(providerConversionRulesService.createRule).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a rule currency outside BRL/USD/EUR with a clear 400 (Fase 5.1)", async () => {
    const { app, server, providerConversionRulesService, conversionRulesService } =
      await createApp();

    for (const [path, method, body] of [
      ["/conversion-rules/providers", "post", { ...messageRule, defaultCurrency: "GBP" }],
      ["/conversion-rules/providers/provider_rule_1", "patch", { defaultCurrency: "ars" }],
      [
        "/conversion-rules",
        "post",
        {
          name: "Compra",
          triggerType: "keyword",
          triggerValue: "paguei",
          eventName: "Purchase",
          defaultValueCents: 100,
          defaultCurrency: "GBP",
        },
      ],
      ["/conversion-rules/legacy_1", "patch", { defaultCurrency: "GBP" }],
    ] as const) {
      const response = await (request(server) as any)
        [method](path)
        .set("Authorization", "Bearer refresh-token")
        .send(body)
        .expect(400);
      expect(response.body.message).toBe("Moeda inválida: use BRL, USD ou EUR");
    }

    await request(server)
      .post("/conversion-rules/providers")
      .set("Authorization", "Bearer refresh-token")
      .send({ ...messageRule, defaultCurrency: "usd" })
      .expect(201);
    expect(providerConversionRulesService.createRule).toHaveBeenCalledTimes(1);
    expect(conversionRulesService.createRule).not.toHaveBeenCalled();
    await app.close();
  });

  it("routes Idempotency-Key creates to the idempotent service call", async () => {
    const { app, server, providerConversionRulesService } = await createApp();

    await request(server)
      .post("/conversion-rules/providers")
      .set("Authorization", "Bearer refresh-token")
      .set("Idempotency-Key", requestKey)
      .send(messageRule)
      .expect(201)
      .expect(({ body }) => expect(body.outcome).toBe("replayed"));

    expect(providerConversionRulesService.createRule).toHaveBeenCalledWith(
      "workspace_1",
      expect.objectContaining({ scope: "all_numbers" }),
      "user_1",
      requestKey,
    );

    // Unknown fields are refused only on keyed requests (exact intent hash).
    await request(server)
      .post("/conversion-rules/providers")
      .set("Authorization", "Bearer refresh-token")
      .set("Idempotency-Key", requestKey)
      .send({ ...messageRule, extra: true })
      .expect(400);
    await request(server)
      .post("/conversion-rules/providers")
      .set("Authorization", "Bearer refresh-token")
      .set("Idempotency-Key", "short")
      .send(messageRule)
      .expect(400)
      .expect(({ body }) =>
        expect(body.code).toBe("provider_rule_create_key_invalid"),
      );
    await app.close();
  });

  it("looks up a create receipt with or without connection", async () => {
    const { app, server, providerConversionRulesService } = await createApp();

    await request(server)
      .get("/conversion-rules/providers/create-receipt")
      .set("Authorization", "Bearer refresh-token")
      .set("Idempotency-Key", requestKey)
      .expect(200)
      .expect(({ body }) => expect(body.outcome).toBe("absent"));
    await request(server)
      .get("/conversion-rules/providers/create-receipt?connectionId=connection_1")
      .set("Authorization", "Bearer refresh-token")
      .set("Idempotency-Key", requestKey)
      .expect(200);
    await request(server)
      .get("/conversion-rules/providers/create-receipt")
      .set("Authorization", "Bearer refresh-token")
      .expect(400);

    expect(
      providerConversionRulesService.lookupCreateReceipt.mock.calls,
    ).toEqual([
      ["workspace_1", null, requestKey],
      ["workspace_1", "connection_1", requestKey],
    ]);
    await app.close();
  });

  it("lists unify candidates and unifies for integration managers only", async () => {
    const owner = await createApp("admin");
    await request(owner.server)
      .get("/conversion-rules/providers/unify-candidates")
      .set("Authorization", "Bearer refresh-token")
      .expect(200);
    await request(owner.server)
      .post("/conversion-rules/providers/unify")
      .set("Authorization", "Bearer refresh-token")
      .send({ ruleIds: ["rule_a", "rule_b"] })
      .expect(200)
      .expect(({ body }) => expect(body.outcome).toBe("created"));
    await request(owner.server)
      .post("/conversion-rules/providers/unify")
      .set("Authorization", "Bearer refresh-token")
      .send({ ruleIds: ["rule_a"] })
      .expect(400);
    expect(owner.providerConversionRulesService.unifyRules).toHaveBeenCalledWith(
      "workspace_1",
      { ruleIds: ["rule_a", "rule_b"] },
      "user_1",
    );
    await owner.app.close();

    const member = await createApp("member");
    await request(member.server)
      .get("/conversion-rules/providers/unify-candidates")
      .set("Authorization", "Bearer refresh-token")
      .expect(403);
    await request(member.server)
      .post("/conversion-rules/providers/unify")
      .set("Authorization", "Bearer refresh-token")
      .send({ ruleIds: ["rule_a", "rule_b"] })
      .expect(403);
    expect(
      member.providerConversionRulesService.unifyRules,
    ).not.toHaveBeenCalled();
    await member.app.close();
  });

  it("lists old keyword/label rules for any member (read-only)", async () => {
    const { app, server, conversionRulesService } = await createApp("member");

    await request(server)
      .get("/conversion-rules/legacy")
      .set("Authorization", "Bearer refresh-token")
      .expect(200)
      .expect(({ body }) => expect(body[0].kind).toBe("legacy"));

    expect(conversionRulesService.listLegacyRules).toHaveBeenCalledWith(
      "workspace_1",
    );
    await app.close();
  });

  it("forwards scope changes on update and refuses channels on all numbers", async () => {
    const { app, server, providerConversionRulesService } = await createApp();

    await request(server)
      .patch("/conversion-rules/providers/provider_rule_1")
      .set("Authorization", "Bearer refresh-token")
      .send({ scope: "all_numbers" })
      .expect(200);
    await request(server)
      .patch("/conversion-rules/providers/provider_rule_1")
      .set("Authorization", "Bearer refresh-token")
      .send({ scope: "all_numbers", channelIds: ["channel_1"] })
      .expect(400);

    expect(providerConversionRulesService.updateRule).toHaveBeenCalledTimes(1);
    expect(providerConversionRulesService.updateRule).toHaveBeenCalledWith(
      "workspace_1",
      "provider_rule_1",
      { scope: "all_numbers" },
      "user_1",
    );
    await app.close();
  });

  it("answers 423 to every new write while the license is locked, reads stay open", async () => {
    const { app, server, providerConversionRulesService, conversionRulesService } =
      await createApp("owner", { licenseLocked: true });

    const writes = [
      () => request(server).post("/conversion-rules/providers").send(messageRule),
      () =>
        request(server)
          .post("/conversion-rules/providers")
          .set("Idempotency-Key", requestKey)
          .send(messageRule),
      () =>
        request(server)
          .post("/conversion-rules/providers/unify")
          .send({ ruleIds: ["rule_a", "rule_b"] }),
      () =>
        request(server)
          .patch("/conversion-rules/providers/provider_rule_1")
          .send({ scope: "all_numbers" }),
      () =>
        request(server)
          .post("/conversion-rules/providers/adapt/legacy_1")
          .send({
            connectionId: "connection_1",
            channelIds: ["channel_1"],
            triggerPhrases: ["pix confirmado"],
            messageAuthorScope: "team",
          }),
      () =>
        request(server).patch("/conversion-rules/legacy_1").send({ active: false }),
    ];
    for (const write of writes) {
      await write()
        .set("Authorization", "Bearer refresh-token")
        .expect(423)
        .expect(({ body }) => expect(body.error).toBe("License Locked"));
    }
    expect(providerConversionRulesService.createRule).not.toHaveBeenCalled();
    expect(providerConversionRulesService.unifyRules).not.toHaveBeenCalled();
    expect(providerConversionRulesService.updateRule).not.toHaveBeenCalled();
    expect(conversionRulesService.updateRule).not.toHaveBeenCalled();

    for (const path of [
      "/conversion-rules/providers/capabilities",
      "/conversion-rules/providers/unify-candidates",
      "/conversion-rules/legacy",
    ]) {
      await request(server)
        .get(path)
        .set("Authorization", "Bearer refresh-token")
        .expect(200);
    }
    await request(server)
      .get("/conversion-rules/providers/create-receipt")
      .set("Authorization", "Bearer refresh-token")
      .set("Idempotency-Key", requestKey)
      .expect(200);
    await app.close();
  });
});
