import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  observationHarness,
  ruleInput,
} from "./support/pipedrive-observation-harness";
import { actor } from "./support/pipedrive-harness";
import { hashPhoneIdentity } from "../src/common/phone/phone-identity";

// Anonymized real Webhooks v2 bodies, re-pointed at the synthetic harness
// account (company 1, synthetic.pipedrive.com, pipeline 1, stage 11, person 1).
function body(name: string, at: Date, mutate?: (b: any) => void): Buffer {
  const b = JSON.parse(
    readFileSync(resolve(__dirname, "fixtures/pipedrive", name), "utf8"),
  );
  b.meta.company_id = "1";
  b.meta.host = "synthetic.pipedrive.com";
  b.meta.timestamp = at.toISOString();
  b.data.person_id = 1;
  b.data.pipeline_id = 1;
  b.data.stage_id = 11;
  b.meta.entity_id = String(b.data.id);
  mutate?.(b);
  return Buffer.from(JSON.stringify(b));
}

beforeEach(() => {
  vi.stubEnv(
    "PIPEDRIVE_CRM_ENCRYPTION_KEY",
    Buffer.alloc(32, 7).toString("base64"),
  );
  vi.stubEnv("API_PUBLIC_URL", "https://api.synthetic.example.invalid");
});
afterEach(() => vi.unstubAllEnvs());

const wonRule = {
  name: "Negocio ganho",
  trigger: "deal_won" as const,
  pipelineId: "1",
  eventName: "Purchase" as const,
  mode: "observation" as const,
  active: true,
  valueMode: "deal" as const,
};

async function setup(rules: Array<Record<string, unknown>> = [ruleInput]) {
  const h = observationHarness();
  const c = await h.seed();
  const issued = await h.webhooks.rotateSecret("workspace-a", c.id, actor);
  const token = new URL(issued.webhookUrl).searchParams.get("token")!;
  for (const rule of rules)
    await h.webhooks.createRule("workspace-a", c.id, actor, rule as any);
  const receive = (raw: Buffer) =>
    h.webhooks.receive(c.id, token, raw, "application/json");
  const last = () => h.state.pipedriveWebhookEvent!.at(-1)!;
  return { ...h, c, receive, last };
}

describe("Pipedrive deal change outcomes (stage / won / lost / custom field)", () => {
  it("won -> Purchase with the deal value and currency (no rule currency needed)", async () => {
    const h = await setup([wonRule]);
    await h.receive(body("deal-won.json", h.now));
    expect(h.last()).toMatchObject({
      changeKind: "deal_won",
      dealStatus: "won",
      previousDealStatus: "open",
      status: "received",
    });
    await h.webhooks.process(h.last().id, "workspace-a");
    expect(h.last().status).toBe("observed");
    expect(h.last().results).toEqual([
      expect.objectContaining({
        eventName: "Purchase",
        status: "observed",
        valueCents: 600000,
        currency: "BRL",
      }),
    ]);
    expect(h.adapter.getPerson).toHaveBeenCalledTimes(1);
    expect(h.state.pipedriveConversionDedupe).toHaveLength(1);
  });

  it("won without a won-deal rule is not a conversion", async () => {
    const h = await setup([ruleInput]);
    await h.receive(body("deal-won.json", h.now));
    await h.webhooks.process(h.last().id, "workspace-a");
    expect(h.last()).toMatchObject({
      status: "ignored",
      errorCode: "won_not_selected",
    });
    expect(h.adapter.getPerson).not.toHaveBeenCalled();
  });

  it("lost is recorded only: never processed, no person lookup, no conversion", async () => {
    const h = await setup([ruleInput, wonRule]);
    await h.receive(
      body("deal-won.json", h.now, (b) => {
        b.data.status = "lost";
        b.previous = { status: "open", lost_time: null };
      }),
    );
    expect(h.last()).toMatchObject({
      changeKind: "deal_lost",
      status: "ignored",
      errorCode: "deal_lost_no_conversion",
      nextAttemptAt: null,
    });
    await h.webhooks.sweep();
    expect(h.adapter.getPerson).not.toHaveBeenCalled();
    expect(h.state.pipedriveConversionDedupe).toHaveLength(0);
  });

  it("custom field change only is accepted and dropped (not stored, no person lookup)", async () => {
    const h = await setup([ruleInput, wonRule]);
    await expect(
      h.receive(body("deal-custom-field-only.json", h.now)),
    ).resolves.toEqual({ status: "accepted" });
    expect(h.state.pipedriveWebhookEvent).toHaveLength(0);
    expect(+h.state.pipedriveConnection![0]!.webhookLastReceivedAt).toBe(
      +h.now,
    );
    await h.webhooks.sweep();
    expect(h.adapter.getPerson).not.toHaveBeenCalled();
    expect(h.state.pipedriveConversionDedupe).toHaveLength(0);
  });

  it("stage change -> the stage rule event; a won rule does not fire on it", async () => {
    const h = await setup([ruleInput, wonRule]);
    await h.receive(body("deal-stage-change.json", h.now));
    await h.webhooks.process(h.last().id, "workspace-a");
    expect(h.last().status).toBe("observed");
    expect(h.last().results).toEqual([
      expect.objectContaining({
        eventName: "QualifiedLead",
        status: "observed",
      }),
    ]);
  });

  it("a later won does not cancel an earlier stage change (separate families)", async () => {
    const h = await setup([ruleInput, wonRule]);
    await h.receive(body("deal-stage-change.json", h.now));
    const stage = h.last();
    h.setNow(new Date(+h.now + 1000));
    await h.receive(body("deal-won.json", h.now));
    await h.webhooks.process(stage.id, "workspace-a");
    await h.webhooks.process(h.last().id, "workspace-a");
    expect(h.state.pipedriveWebhookEvent!.map((e) => e.status)).toEqual([
      "observed",
      "observed",
    ]);
    expect(
      h.state.pipedriveConversionDedupe!.map((d) => d.eventName).sort(),
    ).toEqual(["Purchase", "QualifiedLead"]);
  });

  it("caches the person phone identity briefly (hashes only) across deals", async () => {
    const h = await setup([ruleInput]);
    await h.receive(body("deal-stage-change.json", h.now));
    await h.webhooks.process(h.last().id, "workspace-a");
    await h.receive(
      body("deal-stage-change.json", h.now, (b) => {
        b.data.id = 4999;
        b.meta.entity_id = "4999";
      }),
    );
    await h.webhooks.process(h.last().id, "workspace-a");
    expect(h.adapter.getPerson).toHaveBeenCalledTimes(1);
    h.setNow(new Date(+h.now + 61_000));
    await h.receive(
      body("deal-stage-change.json", h.now, (b) => {
        b.data.id = 5000;
        b.meta.entity_id = "5000";
      }),
    );
    await h.webhooks.process(h.last().id, "workspace-a");
    expect(h.adapter.getPerson).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "national mobile with 9th digit vs lead without it",
      ["(11) 98765-4321"],
      "551187654321",
    ],
    [
      "lead with 9th digit vs CRM phone without it",
      ["+55 11 8765-4321"],
      "5511987654321",
    ],
    [
      "mobile + landline, only the mobile is a lead",
      ["11 3333-4444", "11987654321"],
      "5511987654321",
    ],
  ])("matches the lead by phone: %s", async (_label, phones, leadPhone) => {
    const h = await setup([ruleInput]);
    h.state.lead![0]!.phoneHash = hashPhoneIdentity(leadPhone);
    h.adapter.getPerson.mockResolvedValue({ id: "1", phones });
    await h.receive(body("deal-stage-change.json", h.now));
    await h.webhooks.process(h.last().id, "workspace-a");
    expect(h.last()).toMatchObject({
      status: "observed",
      matchedLeadId: "lead-a",
    });
  });

  it("is ambiguous only when the person's phones match two distinct leads", async () => {
    const h = await setup([ruleInput]);
    h.state.lead![0]!.phoneHash = hashPhoneIdentity("5511987654321");
    h.state.lead!.push({
      ...h.state.lead![0]!,
      id: "lead-b",
      phoneHash: hashPhoneIdentity("5521987654321"),
    });
    h.adapter.getPerson.mockResolvedValue({
      id: "1",
      phones: ["11987654321", "21987654321"],
    });
    await h.receive(body("deal-stage-change.json", h.now));
    await h.webhooks.process(h.last().id, "workspace-a");
    expect(h.last()).toMatchObject({
      status: "ignored",
      errorCode: "phone_ambiguous",
    });
  });

  it("allows one won-deal rule per pipeline and validates the pipeline", async () => {
    const h = await setup([wonRule]);
    await expect(
      h.webhooks.createRule("workspace-a", h.c.id, actor, wonRule),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      h.webhooks.createRule("workspace-a", h.c.id, actor, {
        ...wonRule,
        pipelineId: "999",
      }),
    ).rejects.toMatchObject({ status: 400 });
    const rules = await h.webhooks.listRules("workspace-a", h.c.id);
    expect(rules).toEqual([
      expect.objectContaining({
        trigger: "deal_won",
        stageId: null,
        eventName: "Purchase",
      }),
    ]);
  });
});
