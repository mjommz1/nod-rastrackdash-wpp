import { vi } from "vitest";

/**
 * In-memory Meta setup of one workspace with a single verified page/pixel
 * destination, enough for the CTWA page/pixel resolver. Every query filters
 * by the same fields the production code passes.
 */
export const past = new Date(Date.now() - 60 * 60_000);

export function ctwaWorld(
  overrides: {
    provider?: string;
    metaRoutingMode?: "inherit_workspace" | "channel_override" | null;
    scopes?: string[];
    secondDestination?: boolean;
  } = {},
) {
  const workspaceId = "ws1";
  const credential = {
    id: "cred1",
    workspaceId,
    status: "active",
    validationError: null,
    lastValidatedAt: past,
    rotatedAt: null,
    fingerprint: "fp1",
    encryptedAccessToken: "enc",
    tokenIv: "iv",
    tokenTag: "tag",
    scopes: overrides.scopes ?? [
      "ads_read",
      "ads_management",
      "business_management",
      "pages_show_list",
      "pages_read_engagement",
    ],
    expiresAt: null,
  };
  const business = {
    id: "bm1",
    workspaceId,
    status: "active",
    validationError: null,
    lastValidatedAt: past,
    credentialId: "cred1",
    defaultConversionDestinationId: "dest1",
    credential,
  };
  const destinations = [
    {
      id: "dest1",
      workspaceId,
      status: "configured",
      validationError: null,
      lastValidatedAt: past,
      pixelId: "pixel1",
      pageId: "page1",
    },
    ...(overrides.secondDestination
      ? [
          {
            id: "dest2",
            workspaceId,
            status: "configured",
            validationError: null,
            lastValidatedAt: past,
            pixelId: "pixel2",
            pageId: "page2",
          },
        ]
      : []),
  ];
  const accounts = [
    {
      id: "acc1",
      workspaceId,
      active: true,
      businessConnectionId: "bm1",
      conversionDestinationId: null,
      allowedDestinations: overrides.secondDestination
        ? [
            {
              active: true,
              workspaceId,
              reportingAccountId: "acc1",
              conversionDestinationId: "dest1",
              updatedAt: past,
            },
            {
              active: true,
              workspaceId,
              reportingAccountId: "acc1",
              conversionDestinationId: "dest2",
              updatedAt: past,
            },
          ]
        : [],
    },
  ];
  const channel = {
    id: "ch1",
    workspaceId,
    connectionId: "conn1",
    organizationId: "org1",
    providerChannelId: "5511999990000",
    whatsappInstanceId: null,
    status: "active",
    metaRoutingMode:
      overrides.metaRoutingMode === undefined
        ? "inherit_workspace"
        : overrides.metaRoutingMode,
    routes: [] as unknown[],
    connection: {
      id: "conn1",
      workspaceId,
      provider: overrides.provider ?? "unnichat",
      status: "production",
      removedAt: null,
    },
  };
  const client = {
    metaBusinessConnection: {
      count: vi.fn(async () => 1),
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === business.id && where.workspaceId === workspaceId
          ? business
          : null,
      ),
    },
    metaIntegration: { findUnique: vi.fn(async () => null) },
    inboundWebhookChannelRoute: { findMany: vi.fn(async () => []) },
    auditLog: { findMany: vi.fn(async () => []) },
    metaReportingAccount: {
      findMany: vi.fn(async () =>
        accounts.map((account) => ({
          ...account,
          allowedDestinations: account.allowedDestinations,
        })),
      ),
    },
    metaConversionDestination: {
      findMany: vi.fn(async () => destinations),
      findFirst: vi.fn(
        async ({ where }: any) =>
          destinations.find((d) => d.id === where.id) ?? null,
      ),
    },
    metaCredential: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === credential.id ? credential : null,
      ),
    },
    inboundWebhookChannel: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === channel.id && where.workspaceId === workspaceId
          ? channel
          : null,
      ),
    },
  };
  const intent = {
    kind: "authorized_ctwa_destination" as const,
    deliveryKind: "page_pixel" as const,
    workspaceId,
    channelId: "ch1",
    connectionId: "conn1",
    organizationId: "org1",
    providerChannelId: "5511999990000",
    destinationId: "dest1",
    businessConnectionId: "bm1",
    credentialId: "cred1",
    credentialFingerprint: "fp1",
    pixelId: "pixel1",
    pageId: "page1",
  };
  return { workspaceId, client, channel, credential, intent };
}
