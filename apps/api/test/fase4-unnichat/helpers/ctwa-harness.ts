import { vi } from "vitest";

// Adapted to this edition: the SaaS WABA/dataset binding is not ported, so the
// default CTWA harness is the page/pixel one (the only CTWA destination here).
// baseCtwaHarness keeps the SaaS shape (a destination carrying a WABA binding)
// to prove that such a binding is ignored.
export function ctwaHarness() {
  return pagePixelHarness(baseCtwaHarness());
}

export function baseCtwaHarness() {
  const channel: any = {
    id: "ch",
    workspaceId: "w",
    connectionId: "c",
    organizationId: "w",
    providerChannelId: "551100001020",
    connectedPhone: "551100001020",
    metaRoutingMode: "inherit_workspace",
    conversionEngineMode: "canonical",
    status: "active",
    routes: [],
    connection: {
      id: "c",
      workspaceId: "w",
      provider: "unnichat",
      status: "production",
    },
  };
  const binding: any = {
    version: 1,
    wabaId: "synthetic_waba",
    datasetId: "synthetic_dataset",
    businessConnectionId: "bm",
    credentialId: "cred",
    credentialFingerprint: "synthetic_fingerprint",
    channels: [
      {
        connectionId: "c",
        organizationId: "w",
        providerChannelId: channel.providerChannelId,
      },
    ],
    verifiedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    provenance: "synthetic offline verification",
    permissions: [
      "whatsapp_business_management",
      "whatsapp_business_manage_events",
    ],
  };
  const credential: any = {
    id: "cred",
    workspaceId: "w",
    status: "active",
    fingerprint: binding.credentialFingerprint,
    scopes: binding.permissions,
    lastValidatedAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    encryptedAccessToken: "synthetic",
    tokenIv: "synthetic",
    tokenTag: "synthetic",
  };
  const business: any = {
    id: "bm",
    workspaceId: "w",
    credentialId: "cred",
    status: "active",
    credential,
  };
  const destination: any = {
    id: "dest",
    workspaceId: "w",
    status: "configured",
    pixelId: "unrelated_pixel",
    pageId: "unrelated_page",
    whatsappBinding: binding,
  };
  const prisma: any = {
    metaReportingAccount: { findMany: vi.fn(async () => []) },
    metaBusinessConnection: {
      count: vi.fn(async () => 4),
      findFirst: vi.fn(async () => business),
    },
    metaIntegration: {
      findUnique: vi.fn(async () => ({ advancedRoutingEnabled: true })),
    },
    metaConversionDestination: {
      findFirst: vi.fn(async () => destination),
      findMany: vi.fn(async () => [destination]),
    },
    inboundWebhookChannelRoute: { findMany: vi.fn(async () => []) },
    auditLog: { findMany: vi.fn(async () => []) },
  };
  return { channel, binding, credential, business, destination, prisma };
}

// Existing workspace configuration, already validated by the Meta setup flow.
// Four BMs/eight accounts are credential candidates for ONE logical destination.
export function pagePixelHarness(h = baseCtwaHarness()) {
  h.destination.whatsappBinding = null;
  Object.assign(h.destination, {
    pixelId: "synthetic_pixel",
    pageId: "synthetic_page",
    lastValidatedAt: new Date(Date.now() - 2000),
    validationError: null,
  });
  Object.assign(h.credential, {
    source: "manual",
    scopes: ["business_management", "ads_management"],
    validationError: null,
  });
  Object.assign(h.business, {
    defaultConversionDestinationId: "dest",
    lastValidatedAt: new Date(Date.now() - 1000),
    validationError: null,
  });
  const businesses = [
    h.business,
    ...[2, 3, 4].map((n) => ({
      ...h.business,
      id: `bm${n}`,
    })),
  ];
  const accounts = businesses.flatMap((b, n) =>
    [1, 2].map((i) => ({
      id: `account${n}_${i}`,
      workspaceId: "w",
      active: true,
      businessConnectionId: b.id,
      conversionDestinationId: null,
      allowedDestinations: [],
    })),
  );
  h.prisma.metaReportingAccount.findMany.mockImplementation(
    async () => accounts,
  );
  h.prisma.metaBusinessConnection.findFirst.mockImplementation(
    async ({ where }: any) =>
      businesses.find(
        (b) => b.id === where.id && b.workspaceId === where.workspaceId,
      ) ?? null,
  );
  return { ...h, businesses, accounts };
}
