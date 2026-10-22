import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ProviderConversionDecisionDto,
  ProviderConversionPaidLeadResolutionDto,
} from "@wpptrack/shared";
import { describe, expect, it, vi } from "vitest";
import { ProviderConversionDecisionEngine } from "../../src/conversion-rules/provider-conversion-decision.engine";
import { ProviderConversionObservationService } from "../../src/conversion-rules/provider-conversion-observation.service";
import {
  channelPhoneKey,
  providerRuleCandidateWhere,
  providerRuleCapabilities,
  providerRuleCoversChannel,
  providerRuleOrigin,
  PROVIDER_RULE_SCOPE_CHANNEL_LIMIT,
  resolveApplicableProviderRules,
  resolveProviderRuleScopeChannelIds,
  selectApplicableProviderRules,
  type ScopedChannel,
  type ScopedProviderRule,
} from "../../src/conversion-rules/provider-rule-scope";
import { UmblerV1Parser } from "../../src/inbound-webhooks/providers/umbler/umbler-v1.parser";
import { UazapiProviderConversionService } from "../../src/inbound-webhooks/uazapi-provider-conversion.service";

const workspaceId = "workspace_1";
const env = {
  NODE_ENV: "test",
  API_PUBLIC_URL: "http://localhost:3333",
  INBOUND_WEBHOOKS_ENABLED: "true",
  INBOUND_WEBHOOK_PRODUCTION_ENABLED: "true",
  INBOUND_CONVERSION_RULES_ENABLED: "true",
  INBOUND_CONVERSION_PRODUCTION_ENABLED: "true",
  INBOUND_WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

/** First argument of the first call of a mock (untyped Prisma args). */
function firstCallArg(fn: { mock: { calls: unknown[][] } }): any {
  return fn.mock.calls[0]![0];
}

function scopedRule(
  overrides: Partial<ScopedProviderRule> & { id: string },
): ScopedProviderRule {
  return {
    scope: "specific_numbers",
    connectionId: null,
    removedAt: null,
    messageAuthorScope: "team",
    conversionRule: {
      triggerType: "message_phrase",
      eventName: "Purchase",
      active: true,
    },
    parserRelease: null,
    connection: null,
    channels: [],
    ...overrides,
  };
}

const umblerChannel: ScopedChannel = {
  id: "channel_umbler",
  connectionId: "connection_umbler",
  provider: "umbler",
};
const qrChannel: ScopedChannel = {
  id: "channel_qr",
  connectionId: "connection_qr",
  provider: "uazapi",
};
const gupshupChannel: ScopedChannel = {
  id: "channel_gupshup",
  connectionId: "connection_gupshup",
  provider: "gupshup",
};

describe("provider rule workspace scope: precedence", () => {
  it("keeps a specific-only rule set exactly as the historical channel filter", () => {
    const first = scopedRule({
      id: "rule_a",
      connectionId: "connection_umbler",
      channels: [{ channelId: "channel_umbler" }],
    });
    const second = scopedRule({
      id: "rule_b",
      connectionId: "connection_umbler",
      channels: [{ channelId: "channel_other" }],
    });
    const third = scopedRule({
      id: "rule_c",
      connectionId: "connection_umbler",
      conversionRule: {
        triggerType: "message_phrase",
        eventName: "QualifiedLead",
        active: true,
      },
      channels: [{ channelId: "channel_umbler" }],
    });

    const result = selectApplicableProviderRules(
      [first, second, third],
      umblerChannel,
    );

    expect(result.applicable.map((rule) => rule.id)).toEqual([
      "rule_a",
      "rule_c",
    ]);
    expect(result.overridden).toEqual([]);
    expect(result.duplicatePhone).toEqual([]);
  });

  it("lets a specific rule of the same origin and event replace the global one on its number only", () => {
    const global = scopedRule({ id: "global", scope: "all_numbers" });
    const specific = scopedRule({
      id: "specific",
      connectionId: "connection_umbler",
      channels: [{ channelId: "channel_umbler" }],
    });

    const onSpecificNumber = selectApplicableProviderRules(
      [global, specific],
      umblerChannel,
    );
    expect(onSpecificNumber.applicable.map((rule) => rule.id)).toEqual([
      "specific",
    ]);
    expect(onSpecificNumber.overridden).toEqual([
      { rule: global, bySpecificRuleIds: ["specific"] },
    ]);

    // Every other compatible number keeps the global rule.
    const elsewhere = selectApplicableProviderRules(
      [global, specific],
      qrChannel,
    );
    expect(elsewhere.applicable.map((rule) => rule.id)).toEqual(["global"]);
  });

  it("does not let a specific rule of another event or origin override the global rule", () => {
    const global = scopedRule({ id: "global", scope: "all_numbers" });
    const otherEvent = scopedRule({
      id: "other_event",
      conversionRule: {
        triggerType: "message_phrase",
        eventName: "QualifiedLead",
        active: true,
      },
      channels: [{ channelId: "channel_umbler" }],
    });
    const otherOrigin = scopedRule({
      id: "catalog",
      conversionRule: {
        triggerType: "structured_catalog",
        eventName: "Purchase",
        active: true,
      },
      channels: [{ channelId: "channel_umbler" }],
    });

    expect(
      selectApplicableProviderRules(
        [global, otherEvent, otherOrigin],
        umblerChannel,
      ).applicable.map((rule) => rule.id),
    ).toEqual(["global", "other_event", "catalog"]);
  });

  it("ignores paused or removed specific rules for precedence", () => {
    const global = scopedRule({ id: "global", scope: "all_numbers" });
    const paused = scopedRule({
      id: "paused",
      conversionRule: {
        triggerType: "message_phrase",
        eventName: "Purchase",
        active: false,
      },
      channels: [{ channelId: "channel_umbler" }],
    });
    const removed = scopedRule({
      id: "removed",
      removedAt: new Date(),
      channels: [{ channelId: "channel_umbler" }],
    });

    expect(
      selectApplicableProviderRules(
        [global, paused, removed],
        umblerChannel,
      ).applicable.map((rule) => rule.id),
    ).toEqual(["global"]);
  });

  it("includes numbers connected later dynamically, filtered by the student capability matrix", () => {
    const teamMessage = scopedRule({ id: "message", scope: "all_numbers" });
    const contactMessage = scopedRule({
      id: "contact",
      scope: "all_numbers",
      messageAuthorScope: "contact",
    });
    const catalog = scopedRule({
      id: "catalog",
      scope: "all_numbers",
      conversionRule: {
        triggerType: "structured_catalog",
        eventName: "Purchase",
        active: true,
      },
    });
    const label = scopedRule({
      id: "label",
      scope: "all_numbers",
      messageAuthorScope: null,
      conversionRule: {
        triggerType: "provider_automation",
        eventName: "Purchase",
        active: true,
      },
    });
    const brandNewQr: ScopedChannel = {
      id: "channel_connected_tomorrow",
      connectionId: "connection_new",
      provider: "uazapi",
    };

    // Team messages: Umbler and Uazapi (fromMe) — also numbers added later.
    expect(providerRuleCoversChannel(teamMessage, brandNewQr)).toBe(true);
    expect(providerRuleCoversChannel(teamMessage, umblerChannel)).toBe(true);
    expect(providerRuleCoversChannel(teamMessage, gupshupChannel)).toBe(false);
    // Contact messages are only evaluated on Umbler in this edition.
    expect(providerRuleCoversChannel(contactMessage, umblerChannel)).toBe(true);
    expect(providerRuleCoversChannel(contactMessage, brandNewQr)).toBe(false);
    expect(providerRuleCoversChannel(contactMessage, gupshupChannel)).toBe(
      false,
    );
    // Structured catalog: Umbler and Uazapi team messages (as the SaaS).
    expect(providerRuleCoversChannel(catalog, umblerChannel)).toBe(true);
    expect(providerRuleCoversChannel(catalog, brandNewQr)).toBe(true);
    expect(providerRuleCoversChannel(catalog, gupshupChannel)).toBe(false);
    // Tags only exist on numbers with WhatsApp labels (Uazapi).
    expect(providerRuleOrigin(label)).toBe("whatsapp_label");
    expect(providerRuleCoversChannel(label, brandNewQr)).toBe(true);
    expect(providerRuleCoversChannel(label, umblerChannel)).toBe(false);
    for (const provider of ["meta_cloud", "data_crazy", "gupshup"]) {
      expect(
        providerRuleCoversChannel(teamMessage, { ...gupshupChannel, provider }),
      ).toBe(false);
    }
  });

  it("never puts WAHA, Z-API or NOD API numbers in a global rule", () => {
    const rules = [
      scopedRule({ id: "message", scope: "all_numbers" }),
      scopedRule({
        id: "label",
        scope: "all_numbers",
        conversionRule: {
          triggerType: "provider_automation",
          eventName: "Purchase",
          active: true,
        },
      }),
    ];
    for (const provider of ["waha", "zapi", "nod_api"]) {
      const channel = {
        id: `channel_${provider}`,
        connectionId: `connection_${provider}`,
        provider,
      };
      for (const rule of rules) {
        expect(providerRuleCoversChannel(rule, channel)).toBe(false);
      }
      expect(
        selectApplicableProviderRules(rules, channel).applicable,
      ).toEqual([]);
    }
    expect(providerRuleCapabilities().unsupportedWhatsappProviders).toEqual([
      "waha",
      "zapi",
      "nod_api",
    ]);
  });

  it("keeps the Umbler automation on its own connection", () => {
    const umblerAutomation = scopedRule({
      id: "umbler_automation",
      scope: "all_numbers",
      connectionId: "connection_umbler",
      conversionRule: {
        triggerType: "provider_automation",
        eventName: "Purchase",
        active: true,
      },
      parserRelease: { provider: "umbler" },
    });

    expect(providerRuleOrigin(umblerAutomation)).toBe("automation_umbler");
    expect(providerRuleCoversChannel(umblerAutomation, umblerChannel)).toBe(
      true,
    );
    expect(
      providerRuleCoversChannel(umblerAutomation, {
        ...umblerChannel,
        id: "channel_other_umbler",
        connectionId: "connection_other",
      }),
    ).toBe(false);
    expect(providerRuleCoversChannel(umblerAutomation, qrChannel)).toBe(false);
  });

  it("loads bound rules of the connection plus unbound ones, scoped or global", () => {
    expect(
      providerRuleCandidateWhere({
        connectionId: "connection_umbler",
        channelIds: ["channel_umbler"],
      }),
    ).toEqual({
      AND: [
        {
          OR: [{ connectionId: "connection_umbler" }, { connectionId: null }],
        },
        {
          OR: [
            { channels: { some: { channelId: "channel_umbler" } } },
            { scope: "all_numbers" },
          ],
        },
      ],
    });
  });

  it("treats the Uazapi bridge placeholder as an unknown phone", () => {
    expect(
      channelPhoneKey({
        provider: "uazapi",
        connectedPhone: "provider_b",
        providerChannelId: "provider_b",
        organizationId: "instance_b",
      }),
    ).toBeNull();
    // A numeric provider instance id is still a placeholder, never a phone.
    expect(
      channelPhoneKey({
        provider: "uazapi",
        connectedPhone: "5511987654321",
        providerChannelId: "5511987654321",
        organizationId: "instance_b",
      }),
    ).toBeNull();
    // The number reported by "Testar conexao" is a phone (BR forms match).
    expect(
      channelPhoneKey({
        provider: "uazapi",
        connectedPhone: "551187654321",
        providerChannelId: "provider_b",
        organizationId: "instance_b",
      }),
    ).toBe(
      channelPhoneKey({
        provider: "umbler",
        connectedPhone: "+55 (11) 98765-4321",
      }),
    );
  });

  it("pages through large workspaces and skips deleted WhatsApp instances", async () => {
    const page = (start: number, size: number) =>
      Array.from({ length: size }, (_, index) => ({
        id: `channel_${String(start + index).padStart(4, "0")}`,
        connectionId: "connection_umbler",
        organizationId: "org",
        providerChannelId: `pc_${start + index}`,
        status: "active",
        createdAt: new Date("2026-07-18T00:00:00.000Z"),
        connectedPhone: "",
        connection: { provider: "umbler" },
      }));
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(page(0, 500))
      .mockResolvedValueOnce(page(500, 12));
    const ids = await resolveProviderRuleScopeChannelIds(
      { inboundWebhookChannel: { findMany } } as never,
      workspaceId,
      scopedRule({ id: "global", scope: "all_numbers" }),
    );

    expect(ids).toHaveLength(512);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        workspaceId,
        connection: { is: { workspaceId, removedAt: null } },
        OR: [
          { whatsappInstanceId: null },
          { whatsappInstance: { is: { status: { not: "suspended" } } } },
        ],
      },
    });
    expect(findMany.mock.calls[1]![0]).toMatchObject({
      skip: 1,
      cursor: { id: "channel_0499" },
    });
  });
});

describe("provider rule workspace scope: channel limit", () => {
  function hugeWorkspace() {
    const total = PROVIDER_RULE_SCOPE_CHANNEL_LIMIT + 1;
    const rows = Array.from({ length: total }, (_, index) => ({
      id: `channel_${String(index).padStart(5, "0")}`,
      connectionId: "connection_umbler",
      organizationId: "org",
      providerChannelId: `pc_${index}`,
      status: "active",
      createdAt: new Date("2026-07-18T00:00:00.000Z"),
      connectedPhone: "",
      connection: { provider: "umbler", status: "production" },
    }));
    let page = 0;
    return vi.fn(async () => rows.slice(page * 500, ++page * 500));
  }

  it("does not throw past the limit: specific rules run, global rules are skipped", async () => {
    const global = scopedRule({ id: "global", scope: "all_numbers" });
    const specificOther = scopedRule({
      id: "specific_other_event",
      conversionRule: {
        triggerType: "message_phrase",
        eventName: "QualifiedLead",
        active: true,
      },
      channels: [{ channelId: "channel_umbler" }],
    });
    const client = {
      inboundWebhookChannel: { findMany: hugeWorkspace() },
      providerConversionRuleConfig: { findMany: vi.fn(async () => []) },
    };

    const result = await resolveApplicableProviderRules(client as never, {
      workspaceId,
      rules: [global, specificOther],
      channel: umblerChannel,
    });

    expect(result.applicable.map((rule) => rule.id)).toEqual([
      "specific_other_event",
    ]);
    expect(result.skippedGlobal).toEqual([
      { rule: global, reason: "scope_channel_limit" },
    ]);
    expect(client.providerConversionRuleConfig.findMany).not.toHaveBeenCalled();
  });

  it("resolves no channel for a global rule past the limit (never a partial scope)", async () => {
    await expect(
      resolveProviderRuleScopeChannelIds(
        { inboundWebhookChannel: { findMany: hugeWorkspace() } } as never,
        workspaceId,
        scopedRule({ id: "global", scope: "all_numbers" }),
      ),
    ).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Umbler message observation
// ---------------------------------------------------------------------------

function umblerTeamEvent(text: string) {
  const body = JSON.parse(
    readFileSync(
      resolve(__dirname, "fixtures", "umbler-message-with-ctwa.json"),
      "utf8",
    ),
  );
  body.Payload.Content.LastMessage.Source = "Bot";
  body.Payload.Content.LastMessage.BotInstance = { Id: "bot_1" };
  body.Payload.Content.LastMessage.SentByOrganizationMember = null;
  body.Payload.Content.LastMessage.Content = text;
  return new UmblerV1Parser().parse(body).events[0]!;
}

const activatedAt = new Date("2026-07-18T00:00:00.000Z");
const certifiedUmblerRelease = {
  id: "release_umbler_v1",
  provider: "umbler",
  version: "v1",
  status: "certified",
};

function messageRule(input: {
  id: string;
  scope: "all_numbers" | "specific_numbers";
  bound: boolean;
  channelIds?: string[];
  eventName?: string;
  phrase?: string;
  authorScope?: "team" | "contact" | "both";
}) {
  return {
    id: input.id,
    workspaceId,
    connectionId: input.bound ? "connection_umbler" : null,
    parserReleaseId: input.bound ? certifiedUmblerRelease.id : null,
    scope: input.scope,
    unifiedIntoProviderRuleId: null,
    mode: "production",
    productionActivatedAt: activatedAt,
    removedAt: null,
    createdAt: activatedAt,
    updatedAt: activatedAt,
    conversionRuleId: `conversion_${input.id}`,
    createdByUserId: "user_1",
    messageTriggerPhrases: [input.phrase ?? "vou te passar os valores"],
    messageAuthorScope: input.authorScope ?? "both",
    conversionRule: {
      id: `conversion_${input.id}`,
      workspaceId,
      name: input.id,
      triggerType: "message_phrase",
      triggerValue: input.phrase ?? "vou te passar os valores",
      matchMode: "exact",
      eventName: input.eventName ?? "QualifiedLead",
      pixelId: null,
      defaultValueCents: null,
      defaultCurrency: null,
      defaultContentName: null,
      defaultItems: null,
      active: true,
      createdAt: activatedAt,
      updatedAt: activatedAt,
    },
    connection: input.bound
      ? {
          id: "connection_umbler",
          workspaceId,
          provider: "umbler",
          status: "production",
          removedAt: null,
          parserReleaseId: certifiedUmblerRelease.id,
          parserRelease: certifiedUmblerRelease,
        }
      : null,
    parserRelease: input.bound ? certifiedUmblerRelease : null,
    channels: (input.channelIds ?? []).map((channelId, index) => ({
      id: `scope_${input.id}_${index}`,
      channelId,
      channel: {
        id: channelId,
        status: "active",
        productionActivatedAt: activatedAt,
        conversionEngineMode: "canonical",
      },
    })),
    catalog: null,
  };
}

type PhoneWorld = {
  workspaceChannels?: Array<Record<string, any>>;
  peerRules?: Array<Record<string, any>>;
};

const paidLead: ProviderConversionPaidLeadResolutionDto = {
  status: "resolved",
  reasonCode: "paid_lead_resolved",
  lead: {
    id: "lead_1",
    phoneHash: "phone_hash_1",
    campaignId: "campaign_1",
    adSetId: "adset_1",
    adId: "ad_1",
    ctwaClid: "ctwa_1",
  },
};

function observationHarness(
  rules: Array<Record<string, any>>,
  world: PhoneWorld = {},
) {
  const channel = {
    id: "channel_umbler",
    organizationId: "org_fixture_001",
    providerChannelId: "channel_fixture_001",
    status: "active",
    productionActivatedAt: activatedAt,
    conversionEngineMode: "canonical",
  };
  const prisma = {
    inboundWebhookChannel: {
      // Workspace scan (scope) vs. the delivery's own channel lookup.
      findMany: vi.fn(async (args: any) =>
        args?.where?.connection && world.workspaceChannels
          ? world.workspaceChannels
          : [channel],
      ),
    },
    providerConversionRuleConfig: {
      findMany: vi.fn(async (args: any) =>
        args?.where?.scope === "specific_numbers"
          ? (world.peerRules ?? [])
          : rules,
      ),
      findFirst: vi.fn(),
    },
    inboundWebhookConnection: {
      findFirst: vi.fn(async () => ({
        id: "connection_umbler",
        status: "production",
        removedAt: null,
        parserReleaseId: certifiedUmblerRelease.id,
        parserRelease: certifiedUmblerRelease,
      })),
    },
  };
  const recorded: ProviderConversionDecisionDto[] = [];
  const decisions = {
    findLatestByOccurrence: vi.fn(async () => null),
    recordInitial: vi.fn(
      async ({ decision }: { decision: ProviderConversionDecisionDto }) => {
        recorded.push(decision);
        return {
          id: `decision_${recorded.length}`,
          workspaceId,
          providerRuleId: decision.rule.providerRuleId,
          decision,
          decisionCode: decision.decisionCode,
          reasonCode: decision.reasonCode,
          occurrenceKey: decision.occurrence.occurrenceKey,
          created: true,
        };
      },
    ),
  };
  const engine = new ProviderConversionDecisionEngine();
  const engineRollout = {
    evaluate: vi.fn(async ({ decisionInput }: any) =>
      engine.evaluate(decisionInput),
    ),
  };
  const orchestrator = {
    orchestrate: vi.fn(async ({ persistedDecision, disposition }: any) => ({
      executionId: `execution_${persistedDecision.providerRuleId}`,
      eligibleExecutionId:
        disposition.state === "eligible"
          ? `execution_${persistedDecision.providerRuleId}`
          : null,
      reviewId: null,
    })),
  };
  const service = new ProviderConversionObservationService(
    prisma as never,
    engineRollout as never,
    decisions as never,
    { resolve: vi.fn(async () => paidLead) } as never,
    orchestrator as never,
    env,
  );
  return { service, prisma, recorded, orchestrator };
}

async function observe(
  harness: ReturnType<typeof observationHarness>,
  text = "Vou te passar os valores do procedimento",
) {
  return harness.service.observeDelivery({
    workspaceId,
    connectionId: "connection_umbler",
    deliveryId: "delivery_1",
    externalDeliveryId: "external_1",
    deliveryReceivedAt: new Date("2026-07-20T12:00:00.000Z"),
    events: [umblerTeamEvent(text)],
  });
}

describe("provider rule workspace scope: Umbler message evaluation", () => {
  it("evaluates a global message rule on a number it never listed, gated by the delivery connection", async () => {
    const harness = observationHarness([
      messageRule({ id: "global", scope: "all_numbers", bound: false }),
    ]);

    const result = await observe(harness);

    expect(result.eligibleExecutionIds).toEqual(["execution_global"]);
    expect(harness.recorded).toHaveLength(1);
    expect(harness.recorded[0]).toMatchObject({
      decisionCode: "eligible",
      // The rule has no parser of its own: the delivery connection's parser.
      parserVersion: "v1",
      occurrence: {
        connectionId: "connection_umbler",
        channelId: "channel_umbler",
      },
    });
    expect(
      harness.prisma.inboundWebhookConnection.findFirst,
    ).toHaveBeenCalled();
    expect(
      firstCallArg(harness.prisma.providerConversionRuleConfig.findMany).where,
    ).toMatchObject({
      workspaceId,
      removedAt: null,
      AND: [
        { OR: [{ connectionId: "connection_umbler" }, { connectionId: null }] },
        expect.anything(),
      ],
    });
  });

  it("evaluates a specific rule whose numbers span connections", async () => {
    const harness = observationHarness([
      messageRule({
        id: "cross_connection",
        scope: "specific_numbers",
        bound: false,
        channelIds: ["channel_umbler", "channel_qr_elsewhere"],
      }),
    ]);

    const result = await observe(harness);

    expect(result.eligibleExecutionIds).toEqual(["execution_cross_connection"]);
  });

  it("never evaluates the global rule where a specific rule of the same event owns the number (no double fire)", async () => {
    const harness = observationHarness([
      messageRule({ id: "global", scope: "all_numbers", bound: false }),
      messageRule({
        id: "specific",
        scope: "specific_numbers",
        bound: true,
        channelIds: ["channel_umbler"],
      }),
    ]);

    const result = await observe(harness);

    expect(result.eligibleExecutionIds).toEqual(["execution_specific"]);
    expect(
      harness.recorded.map((decision) => decision.rule.providerRuleId),
    ).toEqual(["specific"]);
    expect(harness.orchestrator.orchestrate).toHaveBeenCalledTimes(1);
  });

  it("keeps a global rule of another event alongside the specific one", async () => {
    const harness = observationHarness([
      messageRule({
        id: "global_view",
        scope: "all_numbers",
        bound: false,
        eventName: "ViewContent",
      }),
      messageRule({
        id: "specific_ql",
        scope: "specific_numbers",
        bound: true,
        channelIds: ["channel_umbler"],
      }),
    ]);

    await observe(harness);

    expect(
      harness.recorded.map((decision) => decision.rule.providerRuleId).sort(),
    ).toEqual(["global_view", "specific_ql"]);
  });

  it("leaves existing bound specific rules untouched (no connection or channel scan)", async () => {
    const harness = observationHarness([
      messageRule({
        id: "legacy",
        scope: "specific_numbers",
        bound: true,
        channelIds: ["channel_umbler"],
      }),
    ]);

    const result = await observe(harness);

    expect(result.eligibleExecutionIds).toEqual(["execution_legacy"]);
    expect(
      harness.prisma.inboundWebhookConnection.findFirst,
    ).not.toHaveBeenCalled();
    // Only the delivery channel lookup; no workspace scan for global rules.
    expect(harness.prisma.inboundWebhookChannel.findMany).toHaveBeenCalledTimes(
      1,
    );
    expect(harness.recorded[0]).toMatchObject({
      parserVersion: "v1",
      occurrence: {
        businessDedupePolicy: {
          mode: "lifetime",
          scopeKey: "QualifiedLead:workspace_1:lead_1",
        },
      },
    });
  });

  it("blocks a global rule when the delivering connection is not in production", async () => {
    const harness = observationHarness([
      messageRule({ id: "global", scope: "all_numbers", bound: false }),
    ]);
    harness.prisma.inboundWebhookConnection.findFirst.mockResolvedValue({
      id: "connection_umbler",
      status: "observation",
      removedAt: null,
      parserReleaseId: certifiedUmblerRelease.id,
      parserRelease: certifiedUmblerRelease,
    });

    const result = await observe(harness);

    expect(result.eligibleExecutionIds).toEqual([]);
    expect(harness.orchestrator.orchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: {
          state: "blocked",
          reasonCode: "production_context_invalid",
        },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Uazapi (QR / uazapi_byo) team messages and labels
// ---------------------------------------------------------------------------

function uazapiHarness(
  rules: Array<Record<string, any>>,
  world: PhoneWorld = {},
) {
  const prisma = {
    uazapiChatLabelState: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
    inboundWebhookChannel: {
      findMany: vi.fn(
        async () =>
          world.workspaceChannels ?? [
            {
              id: "channel_qr_b",
              connectionId: "connection_qr_b",
              organizationId: "instance_b",
              providerChannelId: "provider_b",
              status: "active",
              createdAt: activatedAt,
              connectedPhone: "provider_b",
              connection: { provider: "uazapi" },
            },
          ],
      ),
      findFirst: vi.fn(async () => ({
        status: "active",
        productionActivatedAt: activatedAt,
        connection: {
          status: "production",
          removedAt: null,
          parserReleaseId: "release_uazapi",
          parserRelease: {
            provider: "uazapi",
            version: "v1",
            status: "certified",
          },
        },
      })),
    },
    inboundWebhookDelivery: {
      findUnique: vi.fn(async () => ({ id: "delivery_1" })),
      create: vi.fn(),
    },
    providerConversionRuleConfig: {
      findMany: vi.fn(async (args: any) =>
        args?.where?.scope === "specific_numbers"
          ? (world.peerRules ?? [])
          : rules,
      ),
      findFirst: vi.fn(),
    },
  };
  const engine = new ProviderConversionDecisionEngine();
  const evaluated: any[] = [];
  const decisionEngine = {
    evaluate: vi.fn((input: any) => {
      const decision = engine.evaluate(input);
      evaluated.push({ input, decision });
      return decision;
    }),
  };
  const decisions = {
    findLatestByOccurrence: vi.fn(async () => null),
    recordInitial: vi.fn(async ({ decision }: any) => ({
      id: `decision_${decision.rule.providerRuleId}`,
      workspaceId,
      providerRuleId: decision.rule.providerRuleId,
      decision,
      decisionCode: decision.decisionCode,
      reasonCode: decision.reasonCode,
    })),
    findById: vi.fn(),
  };
  const orchestrator = {
    orchestrate: vi.fn(async ({ persistedDecision, disposition }: any) => ({
      executionId: `execution_${persistedDecision.providerRuleId}`,
      eligibleExecutionId:
        disposition.state === "eligible"
          ? `execution_${persistedDecision.providerRuleId}`
          : null,
      reviewId: null,
    })),
  };
  const productionQueue = { enqueueProviderConversion: vi.fn(async () => ({})) };
  const service = new UazapiProviderConversionService(
    prisma as never,
    env as never,
    {
      ensureBridge: vi.fn(async () => ({
        connectionId: "connection_qr_b",
        channelId: "channel_qr_b",
      })),
    } as never,
    decisionEngine as never,
    decisions as never,
    orchestrator as never,
    { resolve: vi.fn(async () => paidLead) } as never,
    productionQueue as never,
    {
      require: vi.fn(() => ({
        // Instance B numbers its labels differently from instance A.
        listLabels: vi.fn(async () => ({
          labels: [
            { id: "3", name: "Lead frio" },
            { id: "7", name: "Comprou" },
          ],
        })),
      })),
    } as never,
    { decrypt: vi.fn() } as never,
  );
  return { service, prisma, evaluated, orchestrator, productionQueue };
}

function labelRule(input: {
  id: string;
  scope: "all_numbers" | "specific_numbers";
  bound?: boolean;
}) {
  return {
    id: input.id,
    workspaceId,
    connectionId: input.bound ? "connection_qr_b" : null,
    parserReleaseId: input.bound ? "release_uazapi" : null,
    scope: input.scope,
    conversionRuleId: `conversion_${input.id}`,
    mode: "production",
    productionActivatedAt: activatedAt,
    removedAt: null,
    createdAt: activatedAt,
    updatedAt: activatedAt,
    messageTriggerPhrases: ["Comprou"],
    messageAuthorScope: null,
    conversionRule: {
      id: `conversion_${input.id}`,
      active: true,
      triggerType: "provider_automation",
      eventName: "QualifiedLead",
      defaultValueCents: null,
      defaultCurrency: null,
      defaultContentName: null,
      // Created on instance A, where "Comprou" was label 3.
      defaultItems: {
        uazapiLabels: [
          {
            id: "3",
            labelId: "3",
            matchKeys: input.bound ? ["3"] : [],
            name: "Comprou",
          },
        ],
      },
      updatedAt: activatedAt,
    },
    connection: input.bound
      ? {
          provider: "uazapi",
          status: "production",
          removedAt: null,
          parserReleaseId: "release_uazapi",
          parserRelease: {
            provider: "uazapi",
            version: "v1",
            status: "certified",
          },
        }
      : null,
    parserRelease: input.bound
      ? { provider: "uazapi", version: "v1", status: "certified" }
      : null,
    catalog: null,
  };
}

const instanceB = {
  id: "instance_b",
  workspaceId,
  name: "Numero B",
  providerInstanceId: "provider_b",
};

describe("provider rule workspace scope: Uazapi evaluation", () => {
  it("matches a workspace-wide tag rule by name on another instance, never by the instance-local id", async () => {
    const harness = uazapiHarness([
      labelRule({ id: "global_tag", scope: "all_numbers" }),
    ]);

    // Label 3 on instance B is "Lead frio": must NOT fire.
    await expect(
      harness.service.evaluateLabels({
        workspaceId,
        instance: instanceB,
        phone: "5511999990000",
        labelIds: ["3"],
        externalEventId: "label_event_1",
      }),
    ).resolves.toEqual({ evaluated: false, eligibleExecutionId: null });

    // Label 7 on instance B is "Comprou": fires.
    const fired = await harness.service.evaluateLabels({
      workspaceId,
      instance: instanceB,
      phone: "5511999990001",
      labelIds: ["7"],
      externalEventId: "label_event_2",
    });
    expect(fired).toEqual({
      evaluated: true,
      eligibleExecutionId: "execution_global_tag",
    });
    expect(harness.evaluated.at(-1)!.input.occurrence).toMatchObject({
      channelId: "channel_qr_b",
      connectionId: "connection_qr_b",
      labels: ["Comprou"],
    });
    expect(harness.evaluated.at(-1)!.input.rule.triggerPhrases).toEqual([
      "Comprou",
    ]);
  });

  it("keeps id matching for an existing rule bound to its own instance", async () => {
    const harness = uazapiHarness([
      labelRule({ id: "bound_tag", scope: "specific_numbers", bound: true }),
    ]);
    harness.prisma.providerConversionRuleConfig.findMany.mockImplementation(
      async () => [
        {
          ...labelRule({
            id: "bound_tag",
            scope: "specific_numbers",
            bound: true,
          }),
          channels: [{ channelId: "channel_qr_b" }],
        },
      ],
    );

    // Same instance: label 3 is the configured id, matched by id as before.
    const fired = await harness.service.evaluateLabels({
      workspaceId,
      instance: instanceB,
      phone: "5511999990002",
      labelIds: ["3"],
      externalEventId: "label_event_3",
    });
    expect(fired.evaluated).toBe(true);
    expect(harness.evaluated.at(-1)!.input.occurrence.labels).toEqual(["3"]);
    // No workspace channel scan for a set without global rules.
    expect(harness.prisma.inboundWebhookChannel.findMany).not.toHaveBeenCalled();
  });

  it("applies precedence to QR team messages", async () => {
    const harness = uazapiHarness([
      messageRule({ id: "global", scope: "all_numbers", bound: false }),
      messageRule({ id: "specific", scope: "specific_numbers", bound: false }),
    ]);

    const result = await harness.service.evaluateTeamMessage({
      workspaceId,
      instance: instanceB,
      phone: "5511999990000",
      messageText: "vou te passar os valores",
      externalMessageId: "msg_1",
    });

    expect(result.evaluated).toBe(true);
    expect(
      harness.evaluated.map((entry) => entry.input.rule.providerRuleId),
    ).toEqual(["specific"]);
    expect(
      firstCallArg(harness.prisma.providerConversionRuleConfig.findMany).where,
    ).toMatchObject({
      AND: [
        { OR: [{ connectionId: "connection_qr_b" }, { connectionId: null }] },
        {
          OR: [
            { channels: { some: { channelId: "channel_qr_b" } } },
            { scope: "all_numbers" },
          ],
        },
      ],
    });
  });

  it("does not run a contact-only global phrase on Uazapi team messages", async () => {
    const harness = uazapiHarness([
      messageRule({
        id: "global_contact",
        scope: "all_numbers",
        bound: false,
        authorScope: "contact",
      }),
    ]);

    const result = await harness.service.evaluateTeamMessage({
      workspaceId,
      instance: instanceB,
      phone: "5511999990000",
      messageText: "vou te passar os valores",
      externalMessageId: "msg_contact",
    });

    expect(result).toEqual({ evaluated: false, eligibleExecutionId: null });
    expect(harness.evaluated).toEqual([]);
  });

  it("gates an unbound rule by the bridged connection", async () => {
    const harness = uazapiHarness([
      messageRule({ id: "global", scope: "all_numbers", bound: false }),
    ]);
    harness.prisma.inboundWebhookChannel.findFirst.mockResolvedValue({
      status: "active",
      productionActivatedAt: activatedAt,
      connection: {
        status: "observation",
        removedAt: null,
        parserReleaseId: "release_uazapi",
        parserRelease: { provider: "uazapi", version: "v1", status: "certified" },
      },
    });

    const result = await harness.service.evaluateTeamMessage({
      workspaceId,
      instance: instanceB,
      phone: "5511999990000",
      messageText: "vou te passar os valores",
      externalMessageId: "msg_gate",
    });

    expect(result).toEqual({ evaluated: true, eligibleExecutionId: null });
    expect(harness.orchestrator.orchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: {
          state: "blocked",
          reasonCode: "connection_not_production",
        },
      }),
    );
    expect(harness.productionQueue.enqueueProviderConversion).not.toHaveBeenCalled();
  });
});

describe("provider rule workspace scope: Uazapi structured catalog (as the SaaS)", () => {
  function catalogRule(input: {
    id: string;
    scope: "all_numbers" | "specific_numbers";
  }) {
    const base = messageRule({
      id: input.id,
      scope: input.scope,
      bound: false,
      eventName: "Purchase",
      phrase: "pedido confirmado",
      authorScope: "team",
    });
    return {
      ...base,
      channels:
        input.scope === "specific_numbers" ? [{ channelId: "channel_qr_b" }] : [],
      conversionRule: {
        ...base.conversionRule,
        triggerType: "structured_catalog",
        defaultCurrency: "BRL",
        defaultContentName: "Cama elastica",
      },
      catalog: {
        id: "catalog_1",
        name: "Camas",
        productName: "Cama elastica",
        currency: "BRL",
        active: true,
        attributes: [
          { id: "attribute_1", position: 1, key: "tamanho", label: "Tamanho" },
        ],
        variants: [
          {
            id: "variant_1",
            normalizedKey: "4,90",
            attributeValues: ["4,90"],
            aliases: [],
            valueCents: 359_700,
            contentName: null,
            active: true,
          },
        ],
      },
    };
  }

  it("evaluates a catalog rule on a Uazapi team message with its catalog snapshot", async () => {
    const harness = uazapiHarness([
      catalogRule({ id: "catalog_qr", scope: "specific_numbers" }),
    ]);

    const result = await harness.service.evaluateTeamMessage({
      workspaceId,
      instance: instanceB,
      phone: "5511999990000",
      messageText: "Pedido confirmado\nTamanho: 4,90",
      externalMessageId: "msg_catalog",
    });

    expect(result.evaluated).toBe(true);
    const evaluated = harness.evaluated.at(-1)!;
    expect(evaluated.input.rule).toMatchObject({
      providerRuleId: "catalog_qr",
      triggerType: "structured_catalog",
      valueMode: "fixed",
    });
    expect(evaluated.input.catalog).toMatchObject({
      version: expect.stringMatching(/^catalog-v1:/),
      catalog: { id: "catalog_1", productName: "Cama elastica" },
    });
    expect(
      firstCallArg(harness.prisma.providerConversionRuleConfig.findMany).where
        .conversionRule,
    ).toEqual({
      active: true,
      triggerType: { in: ["structured_catalog", "message_phrase"] },
    });
  });

  it("keeps phrase rules on Uazapi with the same snapshot as before (no catalog)", async () => {
    const harness = uazapiHarness([
      messageRule({ id: "phrase", scope: "specific_numbers", bound: false }),
    ]);

    await harness.service.evaluateTeamMessage({
      workspaceId,
      instance: instanceB,
      phone: "5511999990000",
      messageText: "vou te passar os valores",
      externalMessageId: "msg_phrase",
    });

    expect(harness.evaluated.at(-1)!.input).toMatchObject({
      catalog: null,
      rule: { triggerType: "message_phrase" },
    });
  });
});

// ---------------------------------------------------------------------------
// Same phone connected through two providers (Umbler + Uazapi)
// ---------------------------------------------------------------------------

/** One line (11 98765-4321) on Umbler and on a Uazapi instance. */
function samePhoneWorkspace() {
  return [
    {
      id: "channel_umbler",
      connectionId: "connection_umbler",
      organizationId: "org_fixture_001",
      providerChannelId: "channel_fixture_001",
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      connectedPhone: "+55 (11) 98765-4321",
      connection: { provider: "umbler" },
    },
    {
      id: "channel_qr_b",
      connectionId: "connection_qr_b",
      organizationId: "instance_b",
      providerChannelId: "provider_b",
      status: "active",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      // Reported by "Testar conexao" (BR form without the 9th digit).
      connectedPhone: "551187654321",
      connection: { provider: "uazapi" },
    },
  ];
}

describe("provider rule workspace scope: same phone on two channels", () => {
  it("fires a global message rule exactly once when Umbler and the Uazapi instance both see the message", async () => {
    const global = messageRule({
      id: "global",
      scope: "all_numbers",
      bound: false,
    });
    const workspaceChannels = samePhoneWorkspace();
    const umbler = observationHarness([global], { workspaceChannels });
    const qr = uazapiHarness([global], { workspaceChannels });

    const umblerResult = await observe(umbler);
    const qrResult = await qr.service.evaluateTeamMessage({
      workspaceId,
      instance: instanceB,
      phone: "5511999990000",
      messageText: "Vou te passar os valores do procedimento",
      externalMessageId: "msg_same_line",
    });

    // Umbler is the canonical (oldest active) channel of that phone.
    expect(umblerResult.eligibleExecutionIds).toEqual(["execution_global"]);
    expect(qrResult).toEqual({ evaluated: false, eligibleExecutionId: null });
    expect(qr.evaluated).toEqual([]);
    const eligible = [
      ...umbler.orchestrator.orchestrate.mock.calls,
      ...qr.orchestrator.orchestrate.mock.calls,
    ].filter(([call]: any[]) => call.disposition.state === "eligible");
    expect(eligible).toHaveLength(1);
  });

  it("lets a specific rule on one channel of the phone replace the global rule on every channel of that phone", async () => {
    const global = messageRule({
      id: "global",
      scope: "all_numbers",
      bound: false,
    });
    const specificOnQr = {
      id: "specific_qr",
      scope: "specific_numbers",
      connectionId: "connection_qr_b",
      removedAt: null,
      messageAuthorScope: "team",
      conversionRule: {
        triggerType: "message_phrase",
        eventName: "QualifiedLead",
        active: true,
      },
      parserRelease: { provider: "uazapi" },
      connection: { provider: "uazapi" },
      channels: [{ channelId: "channel_qr_b" }],
    };
    const umbler = observationHarness([global], {
      workspaceChannels: samePhoneWorkspace(),
      peerRules: [specificOnQr],
    });

    const result = await observe(umbler);

    expect(result.eligibleExecutionIds).toEqual([]);
    expect(umbler.recorded).toEqual([]);
    const peerQuery = umbler.prisma.providerConversionRuleConfig.findMany.mock
      .calls as any[][];
    expect(
      peerQuery.find(([args]) => args.where.scope === "specific_numbers")![0]
        .where,
    ).toMatchObject({
      channels: { some: { channelId: { in: ["channel_qr_b"] } } },
    });
  });

  it("keeps channels without a verifiable phone independent", async () => {
    const global = messageRule({
      id: "global",
      scope: "all_numbers",
      bound: false,
    });
    const workspaceChannels = samePhoneWorkspace().map((channel) => ({
      ...channel,
      // Bridge placeholder: no phone known for the Uazapi instance.
      connectedPhone:
        channel.id === "channel_qr_b" ? "provider_b" : channel.connectedPhone,
    }));
    const qr = uazapiHarness([global], { workspaceChannels });

    const result = await qr.service.evaluateTeamMessage({
      workspaceId,
      instance: instanceB,
      phone: "5511999990000",
      messageText: "vou te passar os valores",
      externalMessageId: "msg_unknown_phone",
    });
    expect(result.eligibleExecutionId).toBe("execution_global");
  });
});
