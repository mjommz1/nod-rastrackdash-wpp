import { expect, it, vi } from "vitest";
import { InboundWebhookConnectionsController } from "../../src/inbound-webhooks/inbound-webhook-connections.controller";

// Ported from the SaaS (routing-mode part only: the Meta OAuth advanced
// routing toggle is not part of Fase 4b in this edition).
function context(manager: boolean) {
  const session: any = {
    user: { id: "user" },
    currentWorkspaceId: "current",
    workspace: {
      id: "current",
      permissions: { canManageIntegrations: manager },
    },
  };
  const auth: any = { getSession: vi.fn(async () => session) };
  const workspaces: any = {
    getCurrentWorkspace: vi.fn(() => session.workspace),
  };
  return { session, auth, workspaces };
}

it("members cannot choose inherit/override for an Unnichat number", async () => {
  const h = context(false);
  const routes: any = { replaceRoutes: vi.fn() };
  const inbound = new InboundWebhookConnectionsController(
    h.auth,
    h.workspaces,
    {} as never,
    routes,
    {} as never,
  );
  for (const routingMode of ["inherit_workspace", "channel_override"]) {
    await expect(
      inbound.replaceChannelRoutes("session", "foreign-channel", {
        routes: [],
        routingMode,
      }),
    ).rejects.toThrow("Sem permissao");
  }
  expect(routes.replaceRoutes).not.toHaveBeenCalled();
});

it("the routing mode controller uses only the authenticated current workspace", async () => {
  const h = context(true);
  const routes: any = { replaceRoutes: vi.fn(async () => []) };
  await new InboundWebhookConnectionsController(
    h.auth,
    h.workspaces,
    {} as never,
    routes,
    {} as never,
  ).replaceChannelRoutes("session", "channel", {
    workspaceId: "foreign",
    routes: [],
    routingMode: "channel_override",
  });
  expect(routes.replaceRoutes).toHaveBeenCalledWith(
    "current",
    "channel",
    { routes: [], routingMode: "channel_override" },
    "user",
  );
});

it("refuses an unknown routing mode before reaching the service", async () => {
  const h = context(true);
  const routes: any = { replaceRoutes: vi.fn(async () => []) };
  await expect(
    new InboundWebhookConnectionsController(
      h.auth,
      h.workspaces,
      {} as never,
      routes,
      {} as never,
    ).replaceChannelRoutes("session", "channel", {
      routes: [],
      routingMode: "shared_bm_pool",
    }),
  ).rejects.toThrow();
  expect(routes.replaceRoutes).not.toHaveBeenCalled();
});
