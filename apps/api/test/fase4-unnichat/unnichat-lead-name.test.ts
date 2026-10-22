import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { offline } from "./helpers/first-entry-offline";
import { InboundWebhookObservationService } from "../../src/inbound-webhooks/inbound-webhook-observation.service";
import { parseUnnichatAutomationV1 } from "../../src/inbound-webhooks/providers/unnichat/unnichat-automation-v1.parser";
import {
  UnnichatV1Parser,
  parseUnnichatV1Payload,
} from "../../src/inbound-webhooks/providers/unnichat/unnichat-v1.parser";
import type { InboundWebhookEventNormalizedSummary } from "../../src/inbound-webhooks/providers/inbound-webhook-parser";
import { LeadsService } from "../../src/leads/leads.service";
import { hashPhoneIdentity } from "../../src/common/phone/phone-identity";

const parser = new UnnichatV1Parser();
const context = {
  organizationId: "workspace_synthetic_001",
  connectedPhone: "+5500000000999",
};
const base = JSON.parse(
  readFileSync(
    resolve(__dirname, "fixtures/entry-with-ctwa.json"),
    "utf8",
  ),
) as Record<string, unknown>;

function parse(extra: Record<string, unknown>) {
  const result = parser.parse({ ...base, ...extra }, context);
  expect(result.error).toBeNull();
  return result.events[0]!;
}

describe("Unnichat CTWA entry: contact name parsing", () => {
  it("reads name, trimming and collapsing whitespace", () => {
    expect(parse({ name: "  Maria \t  da\n Silva  " }).contact.name).toBe(
      "Maria da Silva",
    );
  });

  it("falls back to first_name when name is absent or unusable", () => {
    expect(parse({ first_name: "Joao" }).contact.name).toBe("Joao");
    expect(parse({ name: "", first_name: "Joao" }).contact.name).toBe("Joao");
    expect(parse({ name: "{{name}}", first_name: "Joao" }).contact.name).toBe(
      "Joao",
    );
    expect(parse({ name: "Ana", first_name: "Joao" }).contact.name).toBe("Ana");
  });

  it("is null when neither field is present", () => {
    expect(parse({}).contact.name).toBeNull();
  });

  it("rejects unsubstituted template placeholders and empty values", () => {
    for (const value of ["{{name}}", "{{ firstName }}", "Oi {{name}}", "  ", ""])
      expect(parse({ name: value, first_name: value }).contact.name).toBeNull();
  });

  it("rejects non-string values without invalidating the event", () => {
    expect(parse({ name: 123, first_name: ["x"] }).contact.name).toBeNull();
    expect(parse({ name: { a: 1 } }).contact.name).toBeNull();
  });

  it("rejects values above the bounded length", () => {
    expect(parse({ name: "a".repeat(120) }).contact.name).toBe("a".repeat(120));
    expect(parse({ name: "a".repeat(121) }).contact.name).toBeNull();
  });

  it("rejects values that are just the phone number", () => {
    const phone = String(base.phone);
    for (const value of [
      phone,
      `+${phone}`,
      "+55 (00) 00000-0000",
      "55 00 000000000",
    ])
      expect(parse({ name: value, first_name: value }).contact.name).toBeNull();
  });

  it("strips control characters", () => {
    expect(parse({ name: "Ma\u0000ria\u0007" }).contact.name).toBe("Ma ria");
  });

  it("does not change identity, dedupe, routing or the persisted summary", () => {
    // The provider sends no timestamp (parse time is used): freeze the clock
    // so both parses share it under a loaded suite.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
    const without = parse({});
    const withName = parse({ name: "Maria da Silva", first_name: "Maria" });
    vi.useRealTimers();
    expect(withName.dedupeKey).toBe(without.dedupeKey);
    expect(withName.externalEventId).toBe(without.externalEventId);
    expect(withName.classification).toBe(without.classification);
    expect(withName.classificationReason).toBe(without.classificationReason);
    expect(withName.adId).toBe(without.adId);
    expect(withName.normalizedSummary.ctwaEntryIdentityHash).toBeTruthy();
    expect(withName.normalizedSummary).toEqual(without.normalizedSummary);
    const delivery = parser.parse({ ...base, name: "Maria da Silva" }, context);
    expect(JSON.stringify(delivery.normalizedSummary)).not.toContain("Maria");
    expect(JSON.stringify(withName.normalizedSummary)).not.toContain("Maria");
    // Only the contact view carries it (re-parsed from the encrypted payload).
    expect(withName.contact.name).toBe("Maria da Silva");
  });

  it("does not change the automation execution key", () => {
    const a = parseUnnichatAutomationV1({ ...base });
    const b = parseUnnichatAutomationV1({ ...base, name: "Maria" });
    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && b.ok && a.value.externalExecutionKey).toBe(
      a.ok && b.ok && b.value.externalExecutionKey,
    );
    expect(parseUnnichatV1Payload({ ...base, name: "Maria" })?.contactName).toBe(
      "Maria",
    );
  });

  it("persists a summary without the name through the observation path", () => {
    const observation = Object.create(
      InboundWebhookObservationService.prototype,
    ) as {
      eventSummary(
        value: InboundWebhookEventNormalizedSummary,
      ): InboundWebhookEventNormalizedSummary;
    };
    const event = parse({ name: "Maria da Silva" });
    expect(
      JSON.stringify(observation.eventSummary(event.normalizedSummary)),
    ).not.toContain("Maria");
  });
});

/** In-memory lead updateMany honoring the `name` is empty guard. */
function nameAwareLeads(h: ReturnType<typeof offline>) {
  h.prisma.lead.updateMany = async ({ where, data }: any) => {
    const lead = h.leads.find((l: any) => l.id === where.id);
    const emptyGuard = Array.isArray(where.OR)
      ? where.OR.some((c: any) => "name" in c)
      : false;
    if (!lead || (emptyGuard && lead.name)) return { count: 0 };
    if (data.name !== undefined) lead.name = data.name;
    return { count: 1 };
  };
}

async function materialize(h: ReturnType<typeof offline>) {
  return h.production.processItem({
    workspaceId: "w",
    productionItemId: "item",
  });
}

describe("Unnichat CTWA entry: lead name materialization", () => {
  it("sets the lead name when the lead has none", async () => {
    const h = offline();
    nameAwareLeads(h);
    h.payload.name = "Maria da Silva";
    await expect(materialize(h)).resolves.toEqual({ status: "materialized" });
    expect(h.leads).toHaveLength(1);
    expect(h.leads[0].name).toBe("Maria da Silva");
  });

  it("does not overwrite an existing lead name", async () => {
    const h = offline();
    nameAwareLeads(h);
    // Lead already known (e.g. named manually or by another source).
    h.leads.push({
      id: "lead",
      workspaceId: "w",
      phoneHash: hashPhoneIdentity(String(h.payload.phone)),
      name: "Nome Manual",
    });
    h.payload.name = "Outro Nome";
    await expect(materialize(h)).resolves.toEqual({ status: "materialized" });
    expect(h.leads).toHaveLength(1);
    expect(h.leads[0].name).toBe("Nome Manual");
  });

  it("keeps the lead name null when the payload has only a placeholder", async () => {
    const h = offline();
    nameAwareLeads(h);
    h.payload.name = "{{name}}";
    h.payload.first_name = "{{firstName}}";
    await expect(materialize(h)).resolves.toEqual({ status: "materialized" });
    expect(h.leads[0].name ?? null).toBeNull();
  });

  it("keeps the name out of the conversion log payload and Meta CAPI body", async () => {
    const h = offline();
    nameAwareLeads(h);
    h.payload.name = "Maria da Silva";
    await materialize(h);
    expect(JSON.stringify(h.logs)).not.toContain("Maria");
    expect(await h.processor.process(h.jobs[0])).toMatchObject({
      status: "sent",
    });
    expect(JSON.stringify(h.calls[0].body)).not.toContain("Maria");
  });

  it("produces the same conversion dedupe key with and without a name", async () => {
    const a = offline();
    nameAwareLeads(a);
    await materialize(a);
    const b = offline();
    nameAwareLeads(b);
    b.payload.name = "Maria da Silva";
    await materialize(b);
    expect(b.logs[0].dedupeKey).toBe(a.logs[0].dedupeKey);
    expect(b.logs[0].eventId).toBe(a.logs[0].eventId);
  });
});

describe("LeadsService.upsertFromWhatsappWebhook preserveExistingName", () => {
  function harness() {
    const upsert = async (args: any) => ({ id: "lead_1", args });
    const calls: any[] = [];
    const updateMany = async (args: any) => {
      calls.push(args);
      return { count: 1 };
    };
    const upserts: any[] = [];
    const prisma = {
      lead: {
        upsert: async (args: any) => {
          upserts.push(args);
          return upsert(args);
        },
        updateMany,
      },
    } as any;
    return { service: new LeadsService(prisma), calls, upserts };
  }
  const input = {
    workspaceId: "w",
    phone: "+55 (31) 97710-4300",
    name: "Maria",
  };

  it("never overwrites on update and only fills an empty name", async () => {
    const { service, calls, upserts } = harness();
    await service.upsertFromWhatsappWebhook({
      ...input,
      preserveExistingName: true,
    });
    expect(upserts[0].create.name).toBe("Maria");
    expect(upserts[0].update.name).toBeUndefined();
    expect(calls).toEqual([
      {
        where: {
          id: "lead_1",
          workspaceId: "w",
          OR: [{ name: null }, { name: "" }],
        },
        data: { name: "Maria" },
      },
    ]);
  });

  it("keeps the previous overwrite behavior without the flag", async () => {
    const { service, calls, upserts } = harness();
    await service.upsertFromWhatsappWebhook(input);
    expect(upserts[0].update.name).toBe("Maria");
    expect(calls).toEqual([]);
  });

  it("does not touch the name when none is provided", async () => {
    const { service, calls, upserts } = harness();
    await service.upsertFromWhatsappWebhook({
      workspaceId: "w",
      phone: input.phone,
      preserveExistingName: true,
    });
    expect(upserts[0].update.name).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
