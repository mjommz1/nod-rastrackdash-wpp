import { describe, expect, it, vi } from "vitest";
import { ConversionEventsService } from "../src/conversion-events/conversion-events.service";
import { MetaConnectionResolverService } from "../src/integrations/meta/meta-connection-resolver.service";
import { MetaTokenEncryptionService } from "../src/integrations/meta/meta-token-encryption.service";

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object") {
      const condition = value as Row;
      if ("not" in condition) return row[key] !== condition.not;
      if ("is" in condition) {
        return matches(row[key] as Row, condition.is as Row);
      }
    }
    return row[key] === value;
  });
}

function harness(
  input: {
    source?: "manual" | "oauth";
    advancedRoutingEnabled?: boolean;
    connectionStatus?: string;
    credentialStatus?: string;
    connectionWorkspaceId?: string;
    noConnections?: boolean;
    noAccount?: boolean;
    noLegacy?: boolean;
    duplicateAccount?: boolean;
    destinationStatus?: string;
    legacyToken?: string;
  } = {},
) {
  const encryption = new MetaTokenEncryptionService({
    META_TOKEN_ENCRYPTION_KEY: "test-only-encryption-key",
  });
  const credential = {
    id: "credential-a",
    workspaceId: input.connectionWorkspaceId ?? "workspace-a",
    source: input.source ?? "manual",
    status: input.credentialStatus ?? "active",
    ...encryption.encrypt("connection-token"),
  };
  const connection = {
    id: "connection-a",
    workspaceId: input.connectionWorkspaceId ?? "workspace-a",
    status: input.connectionStatus ?? "active",
    credentialId: credential.id,
    credential,
    defaultConversionDestinationId: "destination-a",
  };
  const connections = input.noConnections ? [] : [connection];
  const account = {
    id: "account-a",
    workspaceId: connection.workspaceId,
    active: true,
    adAccountId: "act-a",
    businessConnectionId: connection.id,
    conversionDestinationId: null,
  };
  const accounts = input.noAccount ? [] : [account];
  if (input.duplicateAccount) {
    accounts.push({ ...account, id: "account-b", adAccountId: "act-b" });
  }
  const destination = {
    id: "destination-a",
    workspaceId: connection.workspaceId,
    status: input.destinationStatus ?? "configured",
    pixelId: "pixel-a",
    pageId: "page-a",
  };
  const capiToken = encryption.encrypt(input.legacyToken ?? "");
  const legacy = {
    workspaceId: "workspace-a",
    status: "connected",
    advancedRoutingEnabled: input.advancedRoutingEnabled ?? false,
    ...encryption.encrypt("legacy-reporting-token"),
    capiAccessTokenEncrypted: capiToken.encryptedAccessToken,
    capiTokenIv: capiToken.tokenIv,
    capiTokenTag: capiToken.tokenTag,
    selectedAdAccountId: "act-legacy",
    selectedPixelId: "pixel-legacy",
    primaryConversionDestinationId: null,
  };
  const prisma = {
    metaBusinessConnection: {
      count: vi.fn(
        async ({ where }: { where: Row }) =>
          connections.filter((row) => matches(row, where)).length,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Row }) =>
          connections.find((row) => matches(row, where)) ?? null,
      ),
    },
    metaIntegration: {
      findUnique: vi.fn(async ({ where }: { where: Row }) =>
        !input.noLegacy && matches(legacy, where) ? legacy : null,
      ),
    },
    metaReportingAccount: {
      findFirst: vi.fn(
        async ({ where }: { where: Row }) =>
          accounts.find((row) => matches(row, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        accounts.filter((row) => matches(row, where)),
      ),
    },
    metaReportingAccountDestination: { findMany: vi.fn(async () => []) },
    metaConversionDestination: {
      findFirst: vi.fn(async ({ where }: { where: Row }) =>
        matches(destination, where) ? destination : null,
      ),
    },
  };
  return {
    encryption,
    prisma,
    service: new MetaConnectionResolverService(prisma as never, encryption),
  };
}

describe("Meta CAPI connection routing", () => {
  it("resolves the matching manual BM token instead of the empty legacy token", async () => {
    const { service, prisma, encryption } = harness({
      advancedRoutingEnabled: false,
      legacyToken: "",
    });
    const resolveCapiRoute = vi.spyOn(service, "resolveCapiRoute");
    const sender = new ConversionEventsService(
      prisma as never,
      {} as never,
      encryption,
      service,
      {} as never,
    );

    await expect(
      (sender as any).resolveDeliveryRoute({
        workspaceId: "workspace-a",
        metaAccountId: "act-a",
        pixelId: "pixel-a",
        pageId: "page-a",
      }),
    ).resolves.toMatchObject({
      source: "manual",
      accessToken: "connection-token",
      businessConnectionId: "connection-a",
      pixelId: "pixel-a",
      pageId: "page-a",
      routeError: null,
    });
    expect(resolveCapiRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        metaAccountId: "act-a",
      }),
    );
  });

  it.each([false])(
    "resolves sender delivery on legacy CAPI without BM connections (flag %s)",
    async (advancedRoutingEnabled) => {
      const { service, prisma, encryption } = harness({
        noConnections: true,
        advancedRoutingEnabled,
        legacyToken: "legacy-capi-token",
      });
      const resolveCapiRoute = vi.spyOn(service, "resolveCapiRoute");
      const sender = new ConversionEventsService(
        prisma as never,
        {} as never,
        encryption,
        service,
        {} as never,
      );

      await expect(
        (sender as any).resolveDeliveryRoute({
          workspaceId: "workspace-a",
          metaAccountId: "act-legacy",
          pixelId: "pixel-legacy",
        }),
      ).resolves.toMatchObject({
        source: "legacy_oauth",
        accessToken: "legacy-capi-token",
        businessConnectionId: null,
        routeError: null,
      });
      expect(resolveCapiRoute).toHaveBeenCalled();
    },
  );

  it.each(["act-a"])(
    "uses the active manual BM token and destination with legacy routing disabled (account %s)",
    async (metaAccountId) => {
      const { service } = harness();
      await expect(
        service.resolveCapiRoute({ workspaceId: "workspace-a", metaAccountId }),
      ).resolves.toEqual({
        source: "manual",
        workspaceId: "workspace-a",
        accessToken: "connection-token",
        reportingAccountId: "account-a",
        adAccountId: "act-a",
        businessConnectionId: "connection-a",
        credentialId: "credential-a",
        conversionDestinationId: "destination-a",
        pixelId: "pixel-a",
        pageId: "page-a",
      });
    },
  );

  it.each([false, true])(
    "uses an active OAuth BM credential when advancedRoutingEnabled is %s",
    async (advancedRoutingEnabled) => {
      const { service } = harness({ source: "oauth", advancedRoutingEnabled });
      await expect(
        service.resolveCapiRoute({
          workspaceId: "workspace-a",
          metaAccountId: "act-a",
        }),
      ).resolves.toMatchObject({
        source: "legacy_oauth",
        accessToken: "connection-token",
        businessConnectionId: "connection-a",
        conversionDestinationId: "destination-a",
      });
    },
  );

  it.each([false])(
    "preserves legacy CAPI routing without BM connections (flag %s)",
    async (advancedRoutingEnabled) => {
      const { service } = harness({
        noConnections: true,
        advancedRoutingEnabled,
        legacyToken: "legacy-capi-token",
      });
      await expect(
        service.resolveCapiRoute({ workspaceId: "workspace-a" }),
      ).resolves.toMatchObject({
        source: "legacy_oauth",
        accessToken: "legacy-capi-token",
        businessConnectionId: null,
        credentialId: null,
        pixelId: "pixel-legacy",
      });
    },
  );

  it("ignores active BM connections from another workspace", async () => {
    const { service } = harness({
      connectionWorkspaceId: "workspace-b",
      legacyToken: "legacy-capi-token",
    });
    await expect(
      service.resolveCapiRoute({
        workspaceId: "workspace-a",
        metaAccountId: "act-a",
      }),
    ).resolves.toMatchObject({
      accessToken: "legacy-capi-token",
      businessConnectionId: null,
    });
  });

  it.each([{ connectionStatus: "paused" }, { credentialStatus: "paused" }])(
    "rejects an inactive normalized route: %s",
    async (input) => {
      const { service } = harness({ ...input, advancedRoutingEnabled: true });
      await expect(
        service.resolveCapiRoute({
          workspaceId: "workspace-a",
          metaAccountId: "act-a",
        }),
      ).rejects.toThrow("pausad");
    },
  );

  it.each([
    { noAccount: true },
    { duplicateAccount: true },
    { destinationStatus: "pending" },
  ])(
    "rejects an unresolved normalized route without legacy fallback: %s",
    async (input) => {
      const { service } = harness({ ...input, noLegacy: true });
      await expect(
        service.resolveCapiRoute({ workspaceId: "workspace-a" }),
      ).rejects.toThrow();
    },
  );

  it("rejects a business connection that differs from the account route", async () => {
    const { service } = harness();
    await expect(
      service.resolveCapiRoute({
        workspaceId: "workspace-a",
        metaAccountId: "act-a",
        businessConnectionId: "connection-b",
      }),
    ).rejects.toThrow("Rota Meta nao encontrada");
  });
});

// An explicit advanced choice remains fail-closed, even on incomplete setup.
describe("event-specific CAPI routing guards", () => {
  it("blocks advanced routing with no BM rather than silently using legacy", async () => {
    const { service } = harness({
      noConnections: true,
      noAccount: true,
      advancedRoutingEnabled: true,
      legacyToken: "dedicated-token",
    });
    await expect(
      service.resolveCapiRoute({
        workspaceId: "workspace-a",
        metaAccountId: "act-legacy",
      }),
    ).rejects.toThrow();
  });
  it.each(["revoked", "paused"])(
    "blocks a matching %s credential even with advanced off and valid legacy",
    async (credentialStatus) => {
      const { service } = harness({
        credentialStatus,
        legacyToken: "dedicated-token",
      });
      await expect(
        service.resolveCapiRoute({
          workspaceId: "workspace-a",
          metaAccountId: "act-a",
        }),
      ).rejects.toThrow();
    },
  );
  it("allows a sole manual account without legacy configuration and without empty legacy token fallback", async () => {
    const { service } = harness({ noLegacy: true });
    expect(
      await service.resolveCapiRoute({ workspaceId: "workspace-a" }),
    ).toMatchObject({
      accessToken: "connection-token",
      businessConnectionId: "connection-a",
    });
  });
});
