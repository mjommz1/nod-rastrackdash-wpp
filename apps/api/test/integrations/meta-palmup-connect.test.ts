import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/auth.service";
import {
  INTEGRATION_ENV,
  type IntegrationEnv,
} from "../../src/integrations/integration.types";
import { IntegrationsController } from "../../src/integrations/integrations.controller";
import { IntegrationsService } from "../../src/integrations/integrations.service";
import { MetaManualConnectionsService } from "../../src/integrations/meta/meta-manual-connections.service";
import { MetaPalmupConnectService } from "../../src/integrations/meta/meta-palmup-connect.service";
import { MetaPalmupPairingStore } from "../../src/integrations/meta/meta-palmup-pairing.store";
import { WorkspacesService } from "../../src/workspaces/workspaces.service";

const broker = "https://broker.example.test";
const accessToken = "test-meta-token-for-broker-redemption";
const discovery = { credential: { id: "credential-1" }, businesses: [] };

function setup(env: IntegrationEnv = { PALMUP_META_BROKER_URL: broker }) {
  const pending = new Map<string, string>();
  const pairings = {
    save: vi.fn(async (workspace: string, id: string, challenge: string) => {
      pending.set(`${workspace}:${id}`, challenge);
    }),
    consume: vi.fn(async (workspace: string, id: string) => {
      const key = `${workspace}:${id}`;
      const challenge = pending.get(key) ?? null;
      pending.delete(key);
      return challenge;
    }),
  };
  const createCredential = vi.fn().mockResolvedValue(discovery);
  const service = new MetaPalmupConnectService(
    env,
    pairings as unknown as MetaPalmupPairingStore,
    { createCredential } as unknown as MetaManualConnectionsService,
  );
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        accessToken,
        tokenType: "bearer",
        expiresAt: "2026-12-01T00:00:00.000Z",
        scopes: ["ads_read"],
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { service, pairings, createCredential, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe("PalmUP student Meta broker consumer", () => {
  it("builds the authorize URL and stores a random challenge in the student's API", async () => {
    const { service, pairings, fetchMock } = setup();
    const start = await service.start("workspace-1");
    const url = new URL(start.authorizeUrl);
    expect(start.pairingId).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(start.challenge).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(start.pairingId).not.toBe(start.challenge);
    expect(url.origin).toBe(broker);
    expect(url.pathname).toBe("/integrations/meta/student-connect/start");
    expect([...url.searchParams.keys()].sort()).toEqual([
      "challenge",
      "pairingId",
    ]);
    expect(url.searchParams.get("pairingId")).toBe(start.pairingId);
    expect(url.searchParams.get("challenge")).toBe(start.challenge);
    expect(pairings.save).toHaveBeenCalledWith(
      "workspace-1",
      start.pairingId,
      start.challenge,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const second = await service.start("workspace-1");
    expect(second.pairingId).not.toBe(start.pairingId);
    expect(second.challenge).not.toBe(start.challenge);
  });

  it("redeems once using the stored challenge and reuses createCredential without exposing the token", async () => {
    const { service, fetchMock, createCredential } = setup();
    const start = await service.start("workspace-1");
    const result = await service.complete(
      "workspace-1",
      start.pairingId,
      "owner-1",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${broker}/integrations/meta/student-connect/redeem`,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairingId: start.pairingId,
          challenge: start.challenge,
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(createCredential).toHaveBeenCalledWith(
      "workspace-1",
      { label: "Login social PalmUP", accessToken },
      "owner-1",
    );
    expect(result).toEqual(discovery);
    expect(JSON.stringify(result)).not.toContain(accessToken);
    await expect(
      service.complete("workspace-1", start.pairingId, "owner-1"),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createCredential).toHaveBeenCalledTimes(1);
  });

  it("prevents concurrent completions from redeeming the same pairing twice", async () => {
    const { service, fetchMock, createCredential } = setup();
    const start = await service.start("workspace-1");
    const results = await Promise.allSettled([
      service.complete("workspace-1", start.pairingId, "owner-1"),
      service.complete("workspace-1", start.pairingId, "owner-1"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createCredential).toHaveBeenCalledTimes(1);
  });

  it("binds pairings to a workspace and rejects unknown or expired pairings", async () => {
    const { service, fetchMock } = setup();
    const start = await service.start("workspace-1");
    await expect(
      service.complete("workspace-2", start.pairingId, "owner-2"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.complete("workspace-1", "a".repeat(32), "owner-1"),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      service.complete("workspace-1", start.pairingId, "owner-1"),
    ).resolves.toEqual(discovery);
  });

  it.each([undefined, "", "  "])(
    "returns honest 503 for an unset/empty broker (%s)",
    async (value) => {
      const { service, pairings, fetchMock } = setup({
        PALMUP_META_BROKER_URL: value,
      });
      for (const action of [
        () => service.start("workspace-1"),
        () => service.complete("workspace-1", "a".repeat(32), "owner-1"),
      ]) {
        await expect(action()).rejects.toMatchObject({
          status: 503,
          message: "Login social PalmUP nao configurado",
        });
      }
      expect(pairings.save).not.toHaveBeenCalled();
      expect(pairings.consume).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://broker.example.test",
    "https://broker.example.test/path",
    "https://user:password@broker.example.test",
    "https://broker.example.test?x=1",
    "https://broker.example.test#fragment",
    "not a url",
  ])(
    "rejects broker configuration that is not an HTTPS origin (%s)",
    async (value) => {
      const { service, pairings, fetchMock } = setup({
        PALMUP_META_BROKER_URL: value,
      });
      await expect(service.start("workspace-1")).rejects.toMatchObject({
        status: 503,
      });
      expect(pairings.save).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("accepts an HTTPS origin with a trailing slash", async () => {
    const { service } = setup({ PALMUP_META_BROKER_URL: `${broker}/` });
    expect((await service.start("workspace-1")).authorizeUrl).toContain(
      `${broker}/integrations/meta/student-connect/start?`,
    );
  });

  it.each([
    "",
    "a".repeat(31),
    "a".repeat(129),
    "a".repeat(32) + "/",
    "a".repeat(32) + "\n",
  ])(
    "rejects invalid pairingId before contacting the broker (%s)",
    async (pairingId) => {
      const { service, pairings, fetchMock } = setup();
      await expect(
        service.complete("workspace-1", pairingId, "owner-1"),
      ).rejects.toMatchObject({ status: 400 });
      expect(pairings.consume).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("maps broker 404 to a sanitized error and does not retry a consumed pairing", async () => {
    const { service, fetchMock, createCredential } = setup();
    fetchMock.mockResolvedValue(
      new Response(`private broker body ${accessToken}`, { status: 404 }),
    );
    const start = await service.start("workspace-1");
    await expect(
      service.complete("workspace-1", start.pairingId, "owner-1"),
    ).rejects.toMatchObject({
      status: 400,
      message:
        "Conexao PalmUP expirada, invalida ou ja utilizada. Inicie novamente",
    });
    await expect(
      service.complete("workspace-1", start.pairingId, "owner-1"),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createCredential).not.toHaveBeenCalled();
  });

  it.each(["network", "upstream", "malformed", "invalid-token"])(
    "sanitizes %s failure without saving a credential",
    async (failure) => {
      const { service, fetchMock, createCredential } = setup();
      if (failure === "network")
        fetchMock.mockRejectedValue(new Error(`request failed ${accessToken}`));
      if (failure === "upstream")
        fetchMock.mockResolvedValue(new Response(accessToken, { status: 500 }));
      if (failure === "malformed")
        fetchMock.mockResolvedValue(new Response(accessToken, { status: 200 }));
      if (failure === "invalid-token")
        fetchMock.mockResolvedValue(
          new Response(JSON.stringify({ accessToken: "too short" }), {
            status: 200,
          }),
        );
      const start = await service.start("workspace-1");
      await expect(
        service.complete("workspace-1", start.pairingId, "owner-1"),
      ).rejects.toMatchObject({
        status: 502,
        message:
          "Nao foi possivel concluir o login social PalmUP. Inicie novamente",
      });
      expect(createCredential).not.toHaveBeenCalled();
    },
  );

  it("preserves the existing manual credential validation errors", async () => {
    const { service, createCredential } = setup();
    const validationError = new Error("Missing required Meta scopes");
    createCredential.mockRejectedValue(validationError);
    const start = await service.start("workspace-1");
    await expect(
      service.complete("workspace-1", start.pairingId, "owner-1"),
    ).rejects.toBe(validationError);
  });
});

describe("PalmUP connect HTTP endpoints", () => {
  async function appFor(role: string) {
    const { service, ...mocks } = setup();
    const auth = {
      getSession: vi.fn().mockResolvedValue({ user: { id: "owner-1" } }),
    };
    const workspace = {
      id: "workspace-1",
      role,
      permissions: { canManageIntegrations: role !== "member" },
    };
    const module = await Test.createTestingModule({
      controllers: [IntegrationsController],
      providers: [
        { provide: IntegrationsService, useValue: {} },
        { provide: AuthService, useValue: auth },
        {
          provide: WorkspacesService,
          useValue: { getCurrentWorkspace: () => workspace },
        },
        { provide: MetaPalmupConnectService, useValue: service },
      ],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    return { app, auth, ...mocks };
  }

  it("exposes start and complete for the owner using the authenticated workspace", async () => {
    const { app, auth, createCredential } = await appFor("owner");
    try {
      const start = await request(app.getHttpServer())
        .post("/integrations/meta/manual/palmup-connect/start")
        .set("Authorization", "Bearer session-token")
        .expect(201);
      const complete = await request(app.getHttpServer())
        .post("/integrations/meta/manual/palmup-connect/complete")
        .set("Authorization", "Bearer session-token")
        .send({ pairingId: start.body.pairingId })
        .expect(201);
      expect(auth.getSession).toHaveBeenCalledWith("session-token");
      expect(createCredential).toHaveBeenCalledWith(
        "workspace-1",
        { label: "Login social PalmUP", accessToken },
        "owner-1",
      );
      expect(complete.body).toEqual(discovery);
      expect(JSON.stringify(complete.body)).not.toContain(accessToken);
    } finally {
      await app.close();
    }
  });

  it.each(["admin", "member"])(
    "rejects %s with 403 before any broker/state work",
    async (role) => {
      const { app, pairings, fetchMock } = await appFor(role);
      try {
        await request(app.getHttpServer())
          .post("/integrations/meta/manual/palmup-connect/start")
          .set("Authorization", "Bearer session-token")
          .expect(403);
        await request(app.getHttpServer())
          .post("/integrations/meta/manual/palmup-connect/complete")
          .set("Authorization", "Bearer session-token")
          .send({ pairingId: "a".repeat(32) })
          .expect(403);
        expect(pairings.save).not.toHaveBeenCalled();
        expect(pairings.consume).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it("requires authentication", async () => {
    const { app, auth, pairings } = await appFor("owner");
    try {
      await request(app.getHttpServer())
        .post("/integrations/meta/manual/palmup-connect/start")
        .expect(401);
      await request(app.getHttpServer())
        .post("/integrations/meta/manual/palmup-connect/complete")
        .send({ pairingId: "a".repeat(32) })
        .expect(401);
      expect(auth.getSession).not.toHaveBeenCalled();
      expect(pairings.save).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    {},
    { pairingId: 123 },
    { pairingId: "invalid" },
    { pairingId: "a".repeat(32), challenge: "b".repeat(32) },
  ])("rejects malformed complete bodies (%j)", async (body) => {
    const { app, pairings, fetchMock } = await appFor("owner");
    try {
      await request(app.getHttpServer())
        .post("/integrations/meta/manual/palmup-connect/complete")
        .set("Authorization", "Bearer session-token")
        .send(body)
        .expect(400);
      expect(pairings.consume).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
