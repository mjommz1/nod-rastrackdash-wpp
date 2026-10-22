import "reflect-metadata";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.service";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { WorkspaceOwnerGuard } from "../src/workspaces/guards/workspace-owner.guard";
import { PipedriveAdapter } from "../src/pipedrive/pipedrive.adapter";
import { PipedriveController } from "../src/pipedrive/pipedrive.controller";
import { PipedriveModule } from "../src/pipedrive/pipedrive.module";
import { PipedriveService } from "../src/pipedrive/pipedrive.service";
import { createInput, pipedriveHarness } from "./support/pipedrive-harness";

beforeEach(() =>
  vi.stubEnv(
    "PIPEDRIVE_CRM_ENCRYPTION_KEY",
    Buffer.alloc(32, 7).toString("base64"),
  ),
);
afterEach(() => vi.unstubAllEnvs());

export async function controllerHarness() {
  const h = pipedriveHarness();
  const session: any = {
    user: {
      id: "owner-a",
      email: "synthetic@example.invalid",
      platformRole: "user",
    },
    workspaces: [{ id: "workspace-a", role: "owner" }],
    supportContext: null,
  };
  const auth = {
    getSession: vi.fn(async (token: string) => {
      if (token !== "synthetic-session")
        throw new UnauthorizedException("Sessao invalida");
      return session;
    }),
  };
  const module = await Test.createTestingModule({ imports: [PipedriveModule] })
    .overrideProvider(PrismaService)
    .useValue(h.client)
    .overrideProvider(AuthService)
    .useValue(auth)
    .overrideProvider(PipedriveAdapter)
    .useValue(h.adapter)
    .compile();
  const controller = module.get(PipedriveController);
  const service = module.get(PipedriveService);
  const guard = module.get(WorkspaceOwnerGuard);
  const req: any = {
    headers: { authorization: "Bearer synthetic-session" },
    params: { workspaceId: "workspace-a" },
    body: {},
  };
  const authorize = () =>
    guard.canActivate({
      switchToHttp: () => ({ getRequest: () => req }),
    } as ExecutionContext);
  return {
    ...h,
    module,
    controller,
    service,
    guard,
    req,
    session,
    auth,
    authorize,
  };
}

describe("Pipedrive authenticated controller and module", () => {
  it("resolves the real module and guards every management route with the existing owner policy", async () => {
    const h = await controllerHarness();
    try {
      expect(Reflect.getMetadata("imports", AppModule)).toContain(
        PipedriveModule,
      );
      expect(Reflect.getMetadata(PATH_METADATA, PipedriveController)).toBe(
        "workspaces/:workspaceId/pipedrive/connections",
      );
      expect(Reflect.getMetadata(GUARDS_METADATA, PipedriveController)).toEqual(
        [WorkspaceOwnerGuard],
      );
      for (const method of [
        "list",
        "get",
        "create",
        "replaceCredential",
        "status",
        "bindings",
        "remove",
        "refresh",
      ] as const)
        expect(
          Reflect.getMetadata(METHOD_METADATA, h.controller[method]),
        ).toBeDefined();
      expect(Reflect.getMetadata(PATH_METADATA, h.controller.refresh)).toBe(
        ":connectionId/refresh-catalog",
      );
      expect(
        Object.getOwnPropertyNames(PipedriveController.prototype),
      ).not.toContain("receive");
      await expect(h.authorize()).resolves.toBe(true);
      const result = await h.controller.create(
        "workspace-a",
        createInput,
        h.req,
      );
      expect(h.state.auditLog![0]).toMatchObject({
        actorUserId: "owner-a",
        actorType: "user",
      });
      expect(await h.controller.list("workspace-a")).toHaveLength(1);
      expect(
        (await h.controller.get("workspace-a", result.id)).pipelines,
      ).toHaveLength(2);
      expect(
        (
          await h.controller.status(
            "workspace-a",
            result.id,
            { status: "paused" },
            h.req,
          )
        ).status,
      ).toBe("paused");
      expect(
        (
          await h.controller.bindings(
            "workspace-a",
            result.id,
            { allowedChannelRouteIds: [] },
            h.req,
          )
        ).allowedChannelRouteIds,
      ).toEqual([]);
      await h.controller.replaceCredential(
        "workspace-a",
        result.id,
        { apiToken: "synthetic-replacement-token" },
        h.req,
      );
      await h.controller.refresh("workspace-a", result.id);
      expect(
        await h.controller.remove("workspace-a", result.id, h.req),
      ).toEqual({ status: "deleted" });
    } finally {
      await h.module.close();
    }
  });

  it.each([
    "missing",
    "expired",
    "foreign",
    "member",
    "admin",
    "operator-support",
    "master-without-support",
    "master-foreign-support",
  ])("denies %s sessions", async (kind) => {
    const h = await controllerHarness();
    try {
      if (kind === "missing") h.req.headers = {};
      if (kind === "expired") h.req.headers.authorization = "Bearer invalid";
      if (kind === "foreign") h.req.params.workspaceId = "workspace-b";
      if (kind === "member" || kind === "admin")
        h.session.workspaces[0].role = kind;
      if (kind.startsWith("master") || kind === "operator-support") {
        h.session.workspaces = [];
        h.session.user.platformRole =
          kind === "operator-support" ? "platform_operator" : "platform_owner";
        h.session.supportContext =
          kind === "master-without-support"
            ? null
            : {
                workspaceId:
                  kind === "master-foreign-support"
                    ? "workspace-b"
                    : "workspace-a",
              };
      }
      await expect(h.authorize()).rejects.toMatchObject({
        status: ["missing", "expired"].includes(kind) ? 401 : 403,
      });
      expect(h.state.pipedriveConnection).toHaveLength(0);
      expect(h.adapter.verify).not.toHaveBeenCalled();
    } finally {
      await h.module.close();
    }
  });

  it("allows platform-owner support only for the target workspace and records the support actor", async () => {
    const h = await controllerHarness();
    try {
      h.session.workspaces = [];
      h.session.user.platformRole = "platform_owner";
      h.session.supportContext = { workspaceId: "workspace-a" };
      await expect(h.authorize()).resolves.toBe(true);
      await h.controller.create("workspace-a", createInput, h.req);
      expect(h.state.auditLog![0]).toMatchObject({
        actorUserId: "owner-a",
        actorType: "platform_admin",
      });
      h.req.params.workspaceId = "workspace-b";
      await expect(h.authorize()).rejects.toMatchObject({ status: 403 });
    } finally {
      await h.module.close();
    }
  });

  it("accepts the existing session cookie", async () => {
    const h = await controllerHarness();
    try {
      h.req.headers = { cookie: "wpptrack_session=synthetic-session" };
      await expect(h.authorize()).resolves.toBe(true);
    } finally {
      await h.module.close();
    }
  });

  it.each([
    ["create", { ...createInput, verifiedAccountId: "1" }],
    ["create", { ...createInput, apiToken: "short" }],
    [
      "create",
      {
        ...createInput,
        accountOrigin: "https://synthetic.pipedrive.com.evil.invalid",
      },
    ],
    [
      "create",
      { ...createInput, allowedChannelRouteIds: ["route-a", "route-a"] },
    ],
    [
      "replaceCredential",
      { apiToken: "synthetic-replacement-token", credentialGeneration: 99 },
    ],
    ["status", { status: "blocked" }],
    ["status", { status: "active", workspaceId: "workspace-b" }],
    ["bindings", { allowedChannelRouteIds: ["route-a", "route-a"] }],
    [
      "bindings",
      {
        allowedChannelRouteIds: [] as string[],
        apiToken: "synthetic-extra-token",
      },
    ],
  ] as const)(
    "rejects strict invalid %s payloads without echoing secrets",
    async (method, body) => {
      const h = await controllerHarness();
      try {
        await h.authorize();
        expect(() =>
          method === "create"
            ? h.controller.create("workspace-a", body, h.req)
            : h.controller[method](
                "workspace-a",
                "synthetic-connection",
                body,
                h.req,
              ),
        ).toThrow("Payload inválido");
        expect(h.adapter.verify).not.toHaveBeenCalled();
        expect(h.state.pipedriveConnection).toHaveLength(0);
      } finally {
        await h.module.close();
      }
    },
  );
});
