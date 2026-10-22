import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash as nodeCreateHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  backofficeWorkspaceCreateInputSchema,
  backofficeWorkspaceDeleteInputSchema,
  type BackofficeWorkspaceCreateInputDto,
} from "@wpptrack/shared";
import { Prisma, type PlatformRole } from "@prisma/client";
import { BackofficeWorkspacesController } from "../src/workspaces/backoffice-workspaces.controller";
import { PlatformWorkspaceAccessService } from "../src/workspaces/platform-workspace-access.service";

type UserState = {
  id: string;
  name: string | null;
  email: string;
  passwordHash: string | null;
  platformRole: PlatformRole | null;
  lastWorkspaceId?: string | null;
};

type State = {
  users: UserState[];
  workspaces: Array<{
    id: string;
    name: string;
    slug: string;
    operationalStatus: "active" | "blocked";
    createdAt: Date;
  }>;
  members: Array<{
    id: string;
    workspaceId: string;
    userId: string;
    role: "owner" | "admin" | "member";
  }>;
  tokens: Array<{
    id: string;
    userId: string;
    workspaceId: string;
    type: "account_activation";
    tokenHash: string;
    usedAt?: Date;
  }>;
  audits: Array<{
    action: string;
    workspaceId: string | null;
    afterSummary?: unknown;
  }>;
  sessions: Array<{
    id: string;
    userId: string;
    activeWorkspaceId: string | null;
    supportWorkspaceId: string | null;
    supportWorkspaceStartedAt: Date | null;
  }>;
  // Deliberately schema-independent fixture rows: the workspace delete
  // consumer must remove these through its Prisma delegates, not through a
  // migration-only cascade assumption.
  kommo: Record<
    | "connection"
    | "pipeline"
    | "rule"
    | "webhookEvent"
    | "dedupe",
    Array<{ id: string; workspaceId: string; connectionId?: string }>
  >;
};

function makeHarness(initialUsers: UserState[] = []) {
  const events: string[] = [];
  const state: State = {
    users: initialUsers,
    workspaces: [],
    members: [],
    tokens: [],
    audits: [],
    sessions: [],
    kommo: {
      connection: [],
      pipeline: [],
      rule: [],
      webhookEvent: [],
      dedupe: [],
    },
  };
  let nextId = 1;
  const id = (prefix: string) => `${prefix}_${nextId++}`;

  const prisma: any = {
    user: {
      findUnique: vi.fn(
        async ({ where }: any) =>
          state.users.find((user) =>
            where.email ? user.email === where.email : user.id === where.id,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        const user = {
          id: id("user"),
          name: data.name ?? null,
          email: data.email,
          passwordHash: data.passwordHash ?? null,
          platformRole: data.platformRole ?? null,
        };
        state.users.push(user);
        return user;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const user = state.users.find(
          (candidate) => candidate.id === where.id,
        )!;
        Object.assign(user, data);
        return user;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const user of state.users) {
          if (user.lastWorkspaceId === where.lastWorkspaceId) {
            Object.assign(user, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
    workspace: {
      findUnique: vi.fn(
        async ({ where }: any) =>
          state.workspaces.find((workspace) =>
            where.slug
              ? workspace.slug === where.slug
              : workspace.id === where.id,
          ) ?? null,
      ),
      findMany: vi.fn(async () =>
        state.workspaces.map((workspace) => ({
          ...workspace,
          members: state.members
            .filter(
              (member) =>
                member.workspaceId === workspace.id && member.role === "owner",
            )
            .slice(0, 1)
            .map((member) => ({
              role: member.role,
              user: state.users.find((user) => user.id === member.userId),
            })),
        })),
      ),
      create: vi.fn(async ({ data }: any) => {
        const workspace = {
          id: id("workspace"),
          name: data.name,
          slug: data.slug,
          operationalStatus: "active" as const,
          createdAt: new Date("2026-08-26T10:00:00.000Z"),
        };
        state.workspaces.push(workspace);
        return workspace;
      }),
      delete: vi.fn(async ({ where }: any) => {
        if (
          Object.values(state.kommo)
            .flat()
            .some((row) => row.workspaceId === where.id)
        )
          throw new Error("workspace Restrict dependency remains");
        const index = state.workspaces.findIndex(
          (workspace) => workspace.id === where.id,
        );
        if (index < 0) throw new Error("workspace not found");
        return state.workspaces.splice(index, 1)[0];
      }),
    },
    workspaceMember: {
      create: vi.fn(async ({ data }: any) => {
        if (prisma.workspaceMember.failCreate) {
          throw new Error("membership failed");
        }
        const member = { id: id("member"), ...data };
        state.members.push(member);
        return member;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        events.push("owner-read");
        const member = state.members.find(
          (candidate) =>
            candidate.workspaceId === where.workspaceId &&
            candidate.userId === where.userId &&
            candidate.role === where.role,
        );
        if (!member) return null;
        return {
          id: member.id,
          workspace: {
            id: member.workspaceId,
            name: state.workspaces.find(
              (workspace) => workspace.id === member.workspaceId,
            )?.name,
          },
          user: state.users.find((user) => user.id === member.userId),
        };
      }),
      failCreate: false,
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = state.members.length;
        state.members = state.members.filter(
          (member) => member.workspaceId !== where.workspaceId,
        );
        return { count: before - state.members.length };
      }),
    },
    authActionToken: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        events.push("token-update");
        let count = 0;
        for (const token of state.tokens) {
          if (
            token.userId === where.userId &&
            token.usedAt == null &&
            token.type === where.type
          ) {
            Object.assign(token, data);
            count += 1;
          }
        }
        return { count };
      }),
      create: vi.fn(async ({ data }: any) => {
        events.push("token-create");
        const token = { id: id("token"), ...data };
        state.tokens.push(token);
        return token;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = state.tokens.length;
        state.tokens = state.tokens.filter(
          (token) => token.workspaceId !== where.workspaceId,
        );
        return { count: before - state.tokens.length };
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        state.audits.push(data);
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = state.audits.length;
        state.audits = state.audits.filter(
          (audit) => audit.workspaceId !== where.workspaceId,
        );
        return { count: before - state.audits.length };
      }),
    },
    authSession: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const session of state.sessions) {
          const activeMatch =
            where.activeWorkspaceId !== undefined &&
            session.activeWorkspaceId === where.activeWorkspaceId;
          const supportMatch =
            where.supportWorkspaceId !== undefined &&
            session.supportWorkspaceId === where.supportWorkspaceId;
          if (activeMatch || supportMatch) {
            Object.assign(session, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
    $queryRaw: vi.fn(async (query: any) => {
      if (query?.sql?.includes("pg_try_advisory_xact_lock")) {
        events.push("lock:kommo-dispatch");
        return [{ acquired: true }];
      }
      return [];
    }),
    $executeRaw: vi.fn(async () => {
      events.push("activation-lock");
      return 1;
    }),
  };
  for (const delegate of [
    "purchaseValueAdjustment",
    "purchaseReviewItem",
    "purchaseReview",
    "providerPurchaseClaim",
    "providerConversionRuleExecution",
    "providerConversionDecisionAudit",
    "providerConversionShadowComparison",
    "providerConversionRuleChannel",
    "providerConversionRuleEndpoint",
    "providerRuleCreateClaim",
    "providerConversionRuleConfig",
    "conversionRule",
    "conversionCatalogVariant",
    "conversionCatalogAttribute",
    "conversionCatalog",
    "kommoConversionDedupe",
    "kommoWebhookEvent",
    "kommoConversionRule",
    "kommoPipelineCatalog",
    "kommoConnection",
    "pipedriveConversionDedupe",
    "pipedriveWebhookEvent",
    "pipedriveConversionRule",
    "pipedriveStageCatalog",
    "pipedrivePipelineCatalog",
    "pipedriveConnection",
    "inboundWebhookReplayItem",
    "inboundWebhookReplayBatch",
    "inboundWebhookProductionItem",
    "inboundWebhookEvent",
    "inboundWebhookDelivery",
    "integrationEndpointEvent",
    "integrationEndpoint",
    "inboundWebhookChannelRoute",
    "inboundWebhookChannel",
    "inboundWebhookConnection",
    "externalIngestionRecord",
    "externalCapiCutover",
    "externalSyncCursor",
    "externalDataConnector",
    "metaAdDestinationAssignment",
    "metaReportingAccountDestination",
    "metaAdDailyInsight",
    "metaAd",
    "metaAdSetDailyInsight",
    "metaAdSet",
    "metaCampaignDailyInsight",
    "metaCampaign",
    "metaReportingAccount",
    "metaConversionDestination",
    "metaAssetSnapshot",
    "metaBusinessConnection",
    "metaCredential",
    "metaIntegration",
    "uazapiChatLabelState",
    "lead",
    "whatsappInstance",
    "conversionEventLog",
    "funnelStageConfiguration",
    "diagnosticEvent",
    "webhookLog",
    "integrationLog",
    "jobAttempt",
    "workspaceOpsAlertDelivery",
    "workspaceOpsAlertSettings",
    "workspaceInvite",
  ]) {
    prisma[delegate] = {
      deleteMany: vi.fn(async () => {
        events.push(`delete:${delegate}`);
        return { count: 0 };
      }),
    };
  }
  prisma.providerConversionDecisionAudit.updateMany = vi.fn(async () => {
    events.push("update:providerConversionDecisionAudit");
    return { count: 0 };
  });
  prisma.providerConversionRuleConfig.updateMany = vi.fn(async () => {
    events.push("update:providerConversionRuleConfig");
    return { count: 0 };
  });
  const deleteKommo = (
    kind: keyof State["kommo"],
    delegate: string,
  ) =>
    vi.fn(async ({ where }: any) => {
      events.push(`delete:${delegate}`);
      const before = state.kommo[kind].length;
      state.kommo[kind] = state.kommo[kind].filter(
        (row) => row.workspaceId !== where.workspaceId,
      );
      return { count: before - state.kommo[kind].length };
    });
  prisma.kommoConversionDedupe.deleteMany = deleteKommo(
    "dedupe",
    "kommoConversionDedupe",
  );
  prisma.kommoWebhookEvent.deleteMany = deleteKommo(
    "webhookEvent",
    "kommoWebhookEvent",
  );
  prisma.kommoConversionRule.deleteMany = deleteKommo(
    "rule",
    "kommoConversionRule",
  );
  prisma.kommoPipelineCatalog.deleteMany = deleteKommo(
    "pipeline",
    "kommoPipelineCatalog",
  );
  prisma.kommoConnection.deleteMany = vi.fn(async ({ where }: any) => {
    events.push("delete:kommoConnection");
    if (
      ["pipeline", "rule", "webhookEvent"].some((kind) =>
        state.kommo[kind as keyof State["kommo"]].some(
          (row) => row.workspaceId === where.workspaceId,
        ),
      )
    )
      throw new Error("KommoConnection Restrict child remains");
    const before = state.kommo.connection.length;
    state.kommo.connection = state.kommo.connection.filter(
      (row) => row.workspaceId !== where.workspaceId,
    );
    return { count: before - state.kommo.connection.length };
  });
  prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => {
    const snapshot = structuredClone(state);
    try {
      return await callback(prisma);
    } catch (error) {
      state.users = snapshot.users;
      state.workspaces = snapshot.workspaces;
      state.members = snapshot.members;
      state.tokens = snapshot.tokens;
      state.audits = snapshot.audits;
      state.sessions = snapshot.sessions;
      state.kommo = snapshot.kommo;
      throw error;
    }
  });

  return { prisma, state, events };
}

const owner = {
  id: "platform-owner",
  email: "owner@example.com",
  role: "platform_owner" as const,
};
const operator = {
  id: "platform-operator",
  email: "operator@example.com",
  role: "platform_operator" as const,
};

function input(overrides: Partial<BackofficeWorkspaceCreateInputDto> = {}) {
  return {
    name: "Cliente Real",
    responsible: {
      name: "Responsavel Real",
      email: "responsavel@example.com",
    },
    reuseExistingUser: false,
    ...overrides,
  } satisfies BackofficeWorkspaceCreateInputDto;
}

describe("backoffice workspace contracts", () => {
  it("rejects extra fields and platformRole in the create payload", () => {
    expect(
      backofficeWorkspaceCreateInputSchema.safeParse({
        ...input(),
        platformRole: "platform_owner",
      }).success,
    ).toBe(false);
    expect(
      backofficeWorkspaceCreateInputSchema.safeParse({
        ...input(),
        responsible: { ...input().responsible, password: "secret" },
      }).success,
    ).toBe(false);
  });

  it("requires an exact, strict deletion confirmation payload", () => {
    expect(
      backofficeWorkspaceDeleteInputSchema.safeParse({
        confirmation: "cliente-real",
      }).success,
    ).toBe(true);
    expect(
      backofficeWorkspaceDeleteInputSchema.safeParse({
        confirmation: "cliente-real",
        workspaceId: "workspace_1",
      }).success,
    ).toBe(false);
  });
});

describe("platform workspace access", () => {
  let emailQueue: {
    isEnabled: ReturnType<typeof vi.fn>;
    enqueue: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    emailQueue = {
      isEnabled: vi.fn(() => true),
      enqueue: vi.fn(async () => ({ status: "queued" })),
    };
  });

  it("creates a real workspace and pending owner in one transaction", async () => {
    const harness = makeHarness();
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    const result = await service.createWorkspace(input(), owner);

    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.responsible).toMatchObject({
      email: "responsavel@example.com",
      role: "owner",
      status: "pending_activation",
    });
    expect(result).not.toHaveProperty("passwordHash");
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("secret");
    expect(result.deliveryStatus).toBe("queued");
    expect(harness.state.workspaces).toHaveLength(1);
    expect(harness.state.members[0]?.role).toBe("owner");
    expect(harness.state.tokens).toHaveLength(1);
    expect(emailQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: result.id,
        envelope: expect.objectContaining({
          template: "client_owner_activation",
        }),
      }),
    );
    expect(harness.state.audits.map((audit) => audit.action)).toEqual([
      "backoffice.workspace_created",
      "backoffice.workspace_responsible_invited",
    ]);
  });

  it("creates a pending owner without SMTP and requires a manual link without exposing its token", async () => {
    const harness = makeHarness();
    emailQueue.isEnabled.mockReturnValue(false);
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );
    const loggerError = vi.spyOn((service as any).logger, "error");

    const result = await service.createWorkspace(input(), owner);

    expect(result.deliveryStatus).toBe("manual_link_required");
    expect(result.responsible?.status).toBe("pending_activation");
    expect(harness.state.workspaces).toHaveLength(1);
    expect(harness.state.members).toHaveLength(1);
    expect(harness.state.tokens).toHaveLength(1);
    expect(harness.state.tokens[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(emailQueue.enqueue).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("activationUrl");
    expect(JSON.stringify(result)).not.toContain("token");
    expect(JSON.stringify(result)).not.toContain(
      harness.state.tokens[0]!.tokenHash,
    );
    expect(JSON.stringify(harness.state.audits)).not.toContain("token");
    expect(JSON.stringify(harness.state.audits)).not.toContain(
      harness.state.tokens[0]!.tokenHash,
    );
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("does not reuse an existing user without explicit confirmation", async () => {
    const harness = makeHarness([
      {
        id: "existing-user",
        name: "Existing",
        email: "responsavel@example.com",
        passwordHash: "bcrypt-hash",
        platformRole: null,
      },
    ]);
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    await expect(
      service.createWorkspace(input(), owner),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.state.workspaces).toHaveLength(0);
  });

  it("returns an explicit delivery failure without exposing the activation token", async () => {
    const harness = makeHarness();
    emailQueue.enqueue.mockRejectedValueOnce(new Error("queue failed"));
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    const result = await service.createWorkspace(input(), owner);

    expect(result.deliveryStatus).toBe("failed");
    expect(result).not.toHaveProperty("token");
    expect(harness.state.workspaces).toHaveLength(1);
    expect(harness.state.members).toHaveLength(1);
    expect(harness.state.tokens).toHaveLength(1);
    expect(harness.state.audits.at(-1)?.action).toBe(
      "backoffice.workspace_responsible_delivery_failed",
    );
  });

  it("retries a slug collision without returning the database error", async () => {
    const harness = makeHarness();
    harness.prisma.workspace.create.mockRejectedValueOnce(
      knownUniqueConstraint(["slug"]),
    );
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    const result = await service.createWorkspace(input(), owner);

    expect(result.slug).toBe("cliente-real");
    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("maps a raced responsible email insert to a controlled conflict and rolls back", async () => {
    const harness = makeHarness();
    harness.prisma.user.create.mockRejectedValueOnce(
      knownUniqueConstraint(["email"]),
    );
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    await expect(service.createWorkspace(input(), owner)).rejects.toMatchObject(
      {
        constructor: ConflictException,
        message: "Email ja cadastrado",
      },
    );
    expect(harness.state.workspaces).toHaveLength(0);
    expect(harness.state.users).toHaveLength(0);
  });

  it("rotates a pending owner activation, queues it, and never returns its token", async () => {
    const harness = makeHarness();
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );
    const created = await service.createWorkspace(input(), owner);
    const ownerUserId = harness.state.users[0]!.id;
    const previousToken = harness.state.tokens[0]!;

    const result = await service.reissueClientOwnerActivation(
      created.id,
      ownerUserId,
      owner,
    );

    expect(result).toEqual({ accepted: true, deliveryStatus: "queued" });
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("activationUrl");
    expect(previousToken.usedAt).toBeInstanceOf(Date);
    expect(harness.state.tokens).toHaveLength(2);
    expect(harness.state.tokens[1]?.usedAt).toBeUndefined();
    expect(emailQueue.enqueue).toHaveBeenCalledTimes(2);
    expect(harness.state.audits.map((audit) => audit.action)).toContain(
      "backoffice.workspace_owner_activation_reissued",
    );
    expect(harness.state.audits.map((audit) => audit.action)).toContain(
      "backoffice.workspace_owner_activation_delivery_queued",
    );
    expect(JSON.stringify(harness.state.audits)).not.toContain(
      harness.state.tokens[1]?.tokenHash,
    );
  });

  it("returns a manual activation link without SMTP and persists only its hash", async () => {
    const harness = makeHarness();
    emailQueue.isEnabled.mockReturnValue(false);
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
      { WEB_ORIGIN: "https://console.example.com" },
    );
    const created = await service.createWorkspace(input(), owner);
    const previousToken = harness.state.tokens[0]!;

    expect(created.deliveryStatus).toBe("manual_link_required");
    expect(emailQueue.enqueue).not.toHaveBeenCalled();

    const result = await service.createClientOwnerActivationLink(
      created.id,
      harness.state.users[0]!.id,
      owner,
    );
    const activationUrl = new URL(result.activationUrl);
    const rawToken = activationUrl.searchParams.get("token");

    expect(result).toMatchObject({
      ok: true,
      mode: "activation",
      delivery: "link_only",
      expiresAt: expect.any(String),
      emailAttempted: false,
    });
    expect(activationUrl.origin).toBe("https://console.example.com");
    expect(activationUrl.pathname).toBe("/login/activate");
    expect(rawToken).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.state.tokens).toHaveLength(2);
    expect(previousToken.usedAt).toBeInstanceOf(Date);
    expect(harness.state.tokens[1]?.tokenHash).toBe(createHash(rawToken!));
    expect(emailQueue.enqueue).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.state.audits)).not.toContain(rawToken);
    expect(JSON.stringify(harness.state.audits)).not.toContain(
      result.activationUrl,
    );
  });

  it("takes the canonical activation lock before reading and rotating the owner token", async () => {
    const harness = makeHarness();
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
      { WEB_ORIGIN: "https://console.example.com" },
    );
    const created = await service.createWorkspace(input(), owner);
    harness.events.length = 0;

    await service.createClientOwnerActivationLink(
      created.id,
      harness.state.users[0]!.id,
      owner,
    );

    expect(harness.events.indexOf("activation-lock")).toBe(0);
    expect(harness.events.indexOf("activation-lock")).toBeLessThan(
      harness.events.indexOf("owner-read"),
    );
    expect(harness.events.indexOf("activation-lock")).toBeLessThan(
      harness.events.indexOf("token-update"),
    );
  });

  it("fails closed instead of falling back to localhost when WEB_ORIGIN is absent", async () => {
    const harness = makeHarness();
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
      { NODE_ENV: "production" },
    );
    const created = await service.createWorkspace(input(), owner);
    const tokenStateBeforeRequest = structuredClone(harness.state.tokens);

    await expect(
      service.createClientOwnerActivationLink(
        created.id,
        harness.state.users[0]!.id,
        owner,
      ),
    ).rejects.toThrow("Invalid WEB_ORIGIN");

    expect(harness.state.tokens).toEqual(tokenStateBeforeRequest);
    expect(harness.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(harness.prisma.authActionToken.updateMany).toHaveBeenCalledTimes(1);
    expect(harness.prisma.authActionToken.create).toHaveBeenCalledTimes(1);
  });

  it("keeps manual activation scoped to the exact pending client owner", async () => {
    const harness = makeHarness([
      {
        id: "platform-user",
        name: "Platform",
        email: "platform@example.com",
        passwordHash: null,
        platformRole: "platform_owner",
      },
    ]);
    harness.state.workspaces.push({
      id: "workspace-1",
      name: "Cliente Real",
      slug: "cliente-real",
      operationalStatus: "active",
      createdAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    harness.state.members.push({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "platform-user",
      role: "owner",
    });
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
      { WEB_ORIGIN: "https://console.example.com" },
    );

    await expect(
      service.createClientOwnerActivationLink(
        "other-workspace",
        "platform-user",
        owner,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.createClientOwnerActivationLink(
        "workspace-1",
        "platform-user",
        owner,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.state.tokens).toHaveLength(0);
  });

  it("does not issue a manual link for an already activated owner", async () => {
    const harness = makeHarness([
      {
        id: "active-user",
        name: "Active",
        email: "active@example.com",
        passwordHash: "bcrypt-hash",
        platformRole: null,
      },
    ]);
    harness.state.workspaces.push({
      id: "workspace-1",
      name: "Cliente Real",
      slug: "cliente-real",
      operationalStatus: "active",
      createdAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    harness.state.members.push({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "active-user",
      role: "owner",
    });
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
      { WEB_ORIGIN: "https://console.example.com" },
    );

    await expect(
      service.createClientOwnerActivationLink(
        "workspace-1",
        "active-user",
        owner,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.state.tokens).toHaveLength(0);
  });

  it("rejects an IDOR and platform-admin owner before issuing a token", async () => {
    const harness = makeHarness([
      {
        id: "platform-user",
        name: "Platform",
        email: "platform@example.com",
        passwordHash: null,
        platformRole: "platform_owner",
      },
    ]);
    harness.state.workspaces.push({
      id: "workspace-1",
      name: "Cliente Real",
      slug: "cliente-real",
      operationalStatus: "active",
      createdAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    harness.state.members.push({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "platform-user",
      role: "owner",
    });
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    await expect(
      service.reissueClientOwnerActivation(
        "other-workspace",
        "platform-user",
        owner,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.reissueClientOwnerActivation(
        "workspace-1",
        "platform-user",
        owner,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.state.tokens).toHaveLength(0);
  });

  it("makes enqueue failure explicit and audits the failure while keeping reissue durable", async () => {
    const harness = makeHarness();
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );
    const created = await service.createWorkspace(input(), owner);
    emailQueue.enqueue.mockRejectedValueOnce(new Error("queue failed"));

    await expect(
      service.reissueClientOwnerActivation(
        created.id,
        harness.state.users[0]!.id,
        owner,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(harness.state.tokens.at(-1)?.usedAt).toBeUndefined();
    expect(harness.state.audits.at(-1)?.action).toBe(
      "backoffice.workspace_owner_activation_delivery_failed",
    );
  });

  it("reuses an existing client user only with confirmation and never promotes it", async () => {
    const harness = makeHarness([
      {
        id: "existing-user",
        name: "Existing",
        email: "responsavel@example.com",
        passwordHash: "bcrypt-hash",
        platformRole: null,
      },
    ]);
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    const result = await service.createWorkspace(
      input({ reuseExistingUser: true }),
      owner,
    );

    expect(result.reusedExistingUser).toBe(true);
    expect(result.deliveryStatus).toBe("not_required");
    expect(result.responsible?.status).toBe("active");
    expect(harness.state.users[0]?.platformRole).toBeNull();
    expect(harness.state.tokens).toHaveLength(0);
    expect(harness.state.audits.at(-1)?.action).toBe(
      "backoffice.workspace_responsible_reused",
    );
  });

  it("rolls back workspace and user state when membership creation fails", async () => {
    const harness = makeHarness();
    harness.prisma.workspaceMember.failCreate = true;
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    await expect(service.createWorkspace(input(), owner)).rejects.toThrow(
      "membership failed",
    );
    expect(harness.state.workspaces).toHaveLength(0);
    expect(harness.state.users).toHaveLength(0);
    expect(harness.state.members).toHaveLength(0);
    expect(harness.state.audits).toHaveLength(0);
  });

  it("lists only persisted workspace data without credentials", async () => {
    const harness = makeHarness([
      {
        id: "existing-user",
        name: "Existing",
        email: "responsavel@example.com",
        passwordHash: "bcrypt-hash",
        platformRole: null,
      },
    ]);
    harness.state.workspaces.push({
      id: "workspace-1",
      name: "Cliente Real",
      slug: "cliente-real",
      operationalStatus: "active",
      createdAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    harness.state.members.push({
      id: "member-1",
      workspaceId: "workspace-1",
      userId: "existing-user",
      role: "owner",
    });
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    const result = await service.listWorkspaces();

    expect(result).toEqual([
      expect.objectContaining({
        id: "workspace-1",
        responsible: expect.objectContaining({ status: "active" }),
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("bcrypt-hash");
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("permanently deletes only the route workspace, clears context, and retains global users", async () => {
    const harness = makeHarness([
      {
        id: "workspace-user",
        name: "Workspace User",
        email: "member@example.com",
        passwordHash: "bcrypt-hash",
        platformRole: null,
        lastWorkspaceId: "workspace-delete",
      },
      {
        id: "outside-user",
        name: "Outside User",
        email: "outside@example.com",
        passwordHash: "bcrypt-hash-outside",
        platformRole: null,
        lastWorkspaceId: "workspace-keep",
      },
    ]);
    harness.state.workspaces.push(
      {
        id: "workspace-delete",
        name: "Delete Me",
        slug: "delete-me",
        operationalStatus: "active",
        createdAt: new Date("2026-08-26T10:00:00.000Z"),
      },
      {
        id: "workspace-keep",
        name: "Keep Me",
        slug: "keep-me",
        operationalStatus: "active",
        createdAt: new Date("2026-08-26T10:00:00.000Z"),
      },
    );
    harness.state.members.push({
      id: "member-delete",
      workspaceId: "workspace-delete",
      userId: "workspace-user",
      role: "owner",
    });
    harness.state.sessions.push({
      id: "session-owner",
      userId: owner.id,
      activeWorkspaceId: "workspace-delete",
      supportWorkspaceId: "workspace-delete",
      supportWorkspaceStartedAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    harness.state.audits.push({
      action: "old-workspace-audit",
      workspaceId: "workspace-delete",
    });
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    const result = await service.deleteWorkspace(
      "workspace-delete",
      { confirmation: "delete-me" },
      owner,
    );

    expect(result).toEqual({ deleted: true, workspaceId: "workspace-delete" });
    expect(harness.state.workspaces.map((workspace) => workspace.id)).toEqual([
      "workspace-keep",
    ]);
    expect(harness.state.users.map((user) => user.id)).toEqual([
      "workspace-user",
      "outside-user",
    ]);
    expect(harness.state.users[0]?.lastWorkspaceId).toBeNull();
    expect(harness.state.users[1]?.lastWorkspaceId).toBe("workspace-keep");
    expect(harness.state.sessions[0]).toMatchObject({
      activeWorkspaceId: null,
      supportWorkspaceId: null,
      supportWorkspaceStartedAt: null,
    });
    expect(harness.state.audits).toEqual([
      expect.objectContaining({
        workspaceId: null,
        actorUserId: owner.id,
        action: "backoffice.workspace_deleted",
        targetId: "workspace-delete",
        afterSummary: { slug: "delete-me" },
      }),
    ]);
  });

  it("deletes Restrict dependents before their workspace-scoped parents", async () => {
    const harness = makeHarness();
    harness.state.workspaces.push({
      id: "workspace-delete",
      name: "Delete Me",
      slug: "delete-me",
      operationalStatus: "active",
      createdAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    await service.deleteWorkspace(
      "workspace-delete",
      { confirmation: "delete-me" },
      owner,
    );

    const before = (first: string, second: string) => {
      expect(harness.events.indexOf(first)).toBeGreaterThanOrEqual(0);
      expect(harness.events.indexOf(second)).toBeGreaterThanOrEqual(0);
      expect(harness.events.indexOf(first)).toBeLessThan(
        harness.events.indexOf(second),
      );
    };

    before(
      "delete:providerPurchaseClaim",
      "delete:providerConversionRuleExecution",
    );
    before("delete:providerPurchaseClaim", "delete:conversionEventLog");
    before("delete:conversionCatalogVariant", "delete:conversionCatalog");
    before("delete:conversionCatalogAttribute", "delete:conversionCatalog");
    before("delete:conversionCatalog", "delete:providerConversionRuleConfig");
    before(
      "delete:providerRuleCreateClaim",
      "delete:providerConversionRuleConfig",
    );
    before(
      "update:providerConversionRuleConfig",
      "delete:providerConversionRuleConfig",
    );
    before("delete:diagnosticEvent", "delete:conversionEventLog");
    before(
      "update:providerConversionDecisionAudit",
      "delete:providerConversionDecisionAudit",
    );
    before("delete:kommoConversionDedupe", "delete:conversionEventLog");
    before("delete:kommoConversionDedupe", "delete:inboundWebhookChannelRoute");
    before("delete:kommoWebhookEvent", "delete:kommoConnection");
    before("delete:kommoConversionRule", "delete:kommoConnection");
    before("delete:kommoPipelineCatalog", "delete:kommoConnection");
    before("delete:kommoConnection", "delete:inboundWebhookChannelRoute");
    before("delete:kommoConnection", "delete:lead");
    before("delete:kommoConnection", "delete:metaConversionDestination");
    // Pipedrive Restrict children before their parents.
    before("delete:pipedriveConversionDedupe", "delete:pipedriveWebhookEvent");
    before("delete:pipedriveConversionDedupe", "delete:conversionEventLog");
    before("delete:pipedriveWebhookEvent", "delete:pipedriveConnection");
    before("delete:pipedriveWebhookEvent", "delete:lead");
    before("delete:pipedriveConversionRule", "delete:pipedriveConnection");
    before("delete:pipedriveStageCatalog", "delete:pipedrivePipelineCatalog");
    before("delete:pipedrivePipelineCatalog", "delete:pipedriveConnection");
    // Fase 5.3: receipts before their URL, both before the workspace.
    before("delete:integrationEndpointEvent", "delete:integrationEndpoint");
    before("delete:inboundWebhookDelivery", "delete:integrationEndpoint");
  });

  it("removes populated Kommo Restrict rows once, scoped to the confirmed workspace", async () => {
    const harness = makeHarness();
    harness.state.workspaces.push(
      {
        id: "workspace-delete",
        name: "Delete Me",
        slug: "delete-me",
        operationalStatus: "active",
        createdAt: new Date("2026-08-26T10:00:00.000Z"),
      },
      {
        id: "workspace-keep",
        name: "Keep Me",
        slug: "keep-me",
        operationalStatus: "active",
        createdAt: new Date("2026-08-26T10:00:00.000Z"),
      },
    );
    for (const workspaceId of ["workspace-delete", "workspace-keep"]) {
      const suffix = workspaceId === "workspace-delete" ? "delete" : "keep";
      harness.state.kommo.connection.push({
        id: `connection-${suffix}`,
        workspaceId,
      });
      harness.state.kommo.pipeline.push({
        id: `pipeline-${suffix}`,
        workspaceId,
        connectionId: `connection-${suffix}`,
      });
      harness.state.kommo.rule.push({
        id: `rule-${suffix}`,
        workspaceId,
        connectionId: `connection-${suffix}`,
      });
      harness.state.kommo.webhookEvent.push({
        id: `event-${suffix}`,
        workspaceId,
        connectionId: `connection-${suffix}`,
      });
      harness.state.kommo.dedupe.push({
        id: `dedupe-${suffix}`,
        workspaceId,
      });
    }
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    await service.deleteWorkspace(
      "workspace-delete",
      { confirmation: "delete-me" },
      owner,
    );

    expect(harness.state.kommo).toEqual({
      connection: [{ id: "connection-keep", workspaceId: "workspace-keep" }],
      pipeline: [
        {
          id: "pipeline-keep",
          workspaceId: "workspace-keep",
          connectionId: "connection-keep",
        },
      ],
      rule: [
        {
          id: "rule-keep",
          workspaceId: "workspace-keep",
          connectionId: "connection-keep",
        },
      ],
      webhookEvent: [
        {
          id: "event-keep",
          workspaceId: "workspace-keep",
          connectionId: "connection-keep",
        },
      ],
      dedupe: [{ id: "dedupe-keep", workspaceId: "workspace-keep" }],
    });
    for (const delegate of [
      "kommoConversionDedupe",
      "kommoWebhookEvent",
      "kommoConversionRule",
      "kommoPipelineCatalog",
      "kommoConnection",
    ]) {
      expect(harness.prisma[delegate].deleteMany).toHaveBeenCalledTimes(1);
      expect(harness.prisma[delegate].deleteMany).toHaveBeenCalledWith({
        where: { workspaceId: "workspace-delete" },
      });
    }
  });

  it("takes the sender lock before reads and rolls all scoped work back on a child wipe failure", async () => {
    const harness = makeHarness();
    harness.state.workspaces.push({
      id: "workspace-delete",
      name: "Delete Me",
      slug: "delete-me",
      operationalStatus: "active",
      createdAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    harness.state.kommo.connection.push({
      id: "connection-delete",
      workspaceId: "workspace-delete",
    });
    harness.state.kommo.dedupe.push({
      id: "dedupe-delete",
      workspaceId: "workspace-delete",
    });
    harness.prisma.kommoConnection.deleteMany.mockRejectedValueOnce(
      new Error("synthetic child wipe failure"),
    );
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    await expect(
      service.deleteWorkspace(
        "workspace-delete",
        { confirmation: "delete-me" },
        owner,
      ),
    ).rejects.toThrow("synthetic child wipe failure");

    expect(harness.events[0]).toBe("lock:kommo-dispatch");
    // Kommo and Pipedrive connection row locks, both before any read.
    expect(harness.prisma.$queryRaw).toHaveBeenCalledTimes(3);
    for (const order of harness.prisma.$queryRaw.mock.invocationCallOrder)
      expect(order).toBeLessThan(
        harness.prisma.workspace.findUnique.mock.invocationCallOrder[0],
      );
    expect(harness.state.workspaces).toHaveLength(1);
    expect(harness.state.kommo.connection).toEqual([
      { id: "connection-delete", workspaceId: "workspace-delete" },
    ]);
    expect(harness.state.kommo.dedupe).toEqual([
      { id: "dedupe-delete", workspaceId: "workspace-delete" },
    ]);
    expect(harness.state.audits).toEqual([]);
  });

  it("fails before reads or success audit when the shared sender lock is unavailable", async () => {
    const harness = makeHarness();
    harness.prisma.$queryRaw.mockResolvedValueOnce([{ acquired: false }]);
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    await expect(
      service.deleteWorkspace(
        "workspace-delete",
        { confirmation: "delete-me" },
        owner,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(harness.state.audits).toEqual([]);
  });

  it("rejects a wrong confirmation and an unknown route id without deleting another workspace", async () => {
    const harness = makeHarness();
    harness.state.workspaces.push({
      id: "workspace-keep",
      name: "Keep Me",
      slug: "keep-me",
      operationalStatus: "active",
      createdAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    const service = new PlatformWorkspaceAccessService(
      harness.prisma as never,
      emailQueue as never,
    );

    await expect(
      service.deleteWorkspace(
        "workspace-keep",
        { confirmation: "different-workspace" },
        owner,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.deleteWorkspace(
        "workspace-missing",
        { confirmation: "keep-me" },
        owner,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(harness.state.workspaces.map((workspace) => workspace.id)).toEqual([
      "workspace-keep",
    ]);
  });
});

function knownUniqueConstraint(target: readonly string[]) {
  return new Prisma.PrismaClientKnownRequestError("unique constraint", {
    code: "P2002",
    clientVersion: "test",
    meta: { target },
  });
}

describe("backoffice workspace controller authorization", () => {
  it("permits only owners to delete, while preserving auth and payload failures", async () => {
    const access = {
      listWorkspaces: vi.fn(async () => []),
      createWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(async () => ({
        deleted: true,
        workspaceId: "workspace-1",
      })),
      createClientOwnerActivationLink: vi.fn(async () => ({
        ok: true,
        mode: "activation",
        delivery: "link_only",
        activationUrl: "https://console.example.com/login/activate?token=token",
        expiresAt: "2026-08-26T10:00:00.000Z",
        emailAttempted: false,
      })),
      reissueClientOwnerActivation: vi.fn(async () => ({
        accepted: true,
        deliveryStatus: "queued",
      })),
    };
    const admin = {
      assertPlatformAdmin: vi.fn(async (token: string) => {
        if (token === "common") throw new ForbiddenException();
        return token === "operator" ? operator : owner;
      }),
      assertPlatformOwner: vi.fn(async (token: string) => {
        if (token === "unauthenticated") {
          throw new UnauthorizedException();
        }
        if (token !== "owner") throw new ForbiddenException();
        return owner;
      }),
    };
    const controller = new BackofficeWorkspacesController(
      admin as never,
      access as never,
    );

    await controller.list("owner");
    await controller.list("operator");
    await expect(controller.list("common")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(controller.create("operator", input())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      controller.create("owner", { ...input(), extra: true } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await controller.delete("owner", "workspace-1", {
      confirmation: "workspace-1",
    });
    expect(access.deleteWorkspace).toHaveBeenCalledWith(
      "workspace-1",
      { confirmation: "workspace-1" },
      owner,
    );
    await expect(
      controller.delete("operator", "workspace-1", {
        confirmation: "workspace-1",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.delete("unauthenticated", "workspace-1", {
        confirmation: "workspace-1",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller.delete("owner", "workspace-1", {
        confirmation: "workspace-1",
        workspaceId: "workspace-2",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await controller.createActivationLink("owner", "workspace-1", "user-1");
    expect(access.createClientOwnerActivationLink).toHaveBeenCalledWith(
      "workspace-1",
      "user-1",
      owner,
    );
    await controller.resendActivationEmail("owner", "workspace-1", "user-1");
    expect(access.reissueClientOwnerActivation).toHaveBeenCalledWith(
      "workspace-1",
      "user-1",
      owner,
    );
    await expect(
      controller.createActivationLink("operator", "workspace-1", "user-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.resendActivationEmail("operator", "workspace-1", "user-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

function createHash(value: string): string {
  return nodeCreateHash("sha256").update(value).digest("hex");
}
