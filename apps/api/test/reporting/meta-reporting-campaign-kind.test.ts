import { describe, expect, it } from "vitest";
import { MetaReportingService } from "../../src/reporting/meta-reporting.service";
import { ReportingMetricsEngine } from "../../src/reporting/reporting-metrics.engine";

// Implatec: tipo de campanha (WhatsApp x formulario Lead Ads) nos relatorios.
// Mesmo Prisma em memoria da suite de leads novos x leads que voltaram.

type Row = Record<string, unknown>;

const WORKSPACE = "workspace_1";

function compare(value: unknown, bound: unknown): number {
  if (value === null || value === undefined) {
    return Number.NaN;
  }

  if (value instanceof Date || bound instanceof Date) {
    return (
      new Date(value as Date).getTime() - new Date(bound as Date).getTime()
    );
  }

  const left = String(value);
  const right = String(bound);

  return left < right ? -1 : left > right ? 1 : 0;
}

function matchesWhere(row: Row, where: unknown): boolean {
  if (!where) {
    return true;
  }

  for (const [key, condition] of Object.entries(where as Row)) {
    if (key === "OR") {
      if (!(condition as unknown[]).some((item) => matchesWhere(row, item))) {
        return false;
      }
      continue;
    }

    if (key === "AND") {
      if (!(condition as unknown[]).every((item) => matchesWhere(row, item))) {
        return false;
      }
      continue;
    }

    const value = row[key] ?? null;

    if (
      condition !== null &&
      typeof condition === "object" &&
      !(condition instanceof Date)
    ) {
      const ops = condition as Row;

      if ("in" in ops && !(ops.in as unknown[]).includes(value)) return false;
      if ("notIn" in ops && (ops.notIn as unknown[]).includes(value)) {
        return false;
      }
      if ("not" in ops && value === ops.not) return false;
      if ("lt" in ops && !(compare(value, ops.lt) < 0)) return false;
      if ("gt" in ops && !(compare(value, ops.gt) > 0)) return false;
      if ("gte" in ops && !(compare(value, ops.gte) >= 0)) return false;
      if ("lte" in ops && !(compare(value, ops.lte) <= 0)) return false;
      continue;
    }

    if (value !== condition) {
      return false;
    }
  }

  return true;
}

function campaign(input: {
  campaignId: string;
  name: string;
  spendCents: number;
  whatsappClassification: string;
  campaignKind: string;
}): Row {
  return {
    workspaceId: WORKSPACE,
    businessId: "business_1",
    adAccountId: "act_123",
    campaignId: input.campaignId,
    name: input.name,
    status: "ACTIVE",
    effectiveStatus: "ACTIVE",
    whatsappClassification: input.whatsappClassification,
    campaignKind: input.campaignKind,
    spendCents: input.spendCents,
    metaConversationsStarted: 0,
    dailyBudgetCents: null,
    lifetimeBudgetCents: null,
  };
}

function createHarness() {
  const db = {
    campaigns: [
      campaign({
        campaignId: "cmp_wpp",
        name: "Campanha WhatsApp",
        spendCents: 30_000,
        whatsappClassification: "auto_whatsapp",
        campaignKind: "whatsapp",
      }),
      campaign({
        campaignId: "cmp_form",
        name: "Campanha Formulario",
        spendCents: 20_000,
        whatsappClassification: "not_whatsapp",
        campaignKind: "lead_form",
      }),
    ],
    leads: [
      {
        id: "lead_wpp",
        workspaceId: WORKSPACE,
        phoneHash: "phone_a",
        campaignId: "cmp_wpp",
        adSetId: "adset_wpp",
        adId: "ad_wpp",
        ctwaClid: "ctwa_1",
        source: "uazapi",
        firstMessageAt: new Date("2026-07-01T12:00:00.000Z"),
        createdAt: new Date("2026-07-01T12:00:00.000Z"),
      },
      {
        // Lead criado pelo servico da Implatec na hora do formulario: sem
        // primeira mensagem, com lead_id da Meta em ctwaClid.
        id: "lead_form",
        workspaceId: WORKSPACE,
        phoneHash: "phone_b",
        campaignId: "cmp_form",
        adSetId: "adset_form",
        adId: "ad_form",
        ctwaClid: "1876991943477144",
        source: "meta_leadgen",
        firstMessageAt: null,
        createdAt: new Date("2026-07-02T12:00:00.000Z"),
      },
    ] as Row[],
    conversionLogs: [] as Row[],
  };
  const tables = (): Record<string, Row[]> => ({
    metaReportingAccount: [
      {
        workspaceId: WORKSPACE,
        businessId: "business_1",
        adAccountId: "act_123",
        active: true,
      },
    ],
    metaCampaign: db.campaigns,
    metaAdSet: [],
    metaAd: [],
    conversionEventLog: db.conversionLogs,
    lead: db.leads,
    metaCampaignDailyInsight: [],
    metaAdSetDailyInsight: [],
    metaAdDailyInsight: [],
  });
  const prisma = new Proxy(
    {},
    {
      get(_target, model: string) {
        const table = tables()[model];

        if (!table) {
          throw new Error(`Unexpected prisma model access: ${model}`);
        }

        return {
          findMany: async (args: { where?: unknown } = {}) =>
            table
              .filter((row) => matchesWhere(row, args.where))
              .map((row) => ({ ...row })),
        };
      },
    },
  );
  const service = new MetaReportingService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new ReportingMetricsEngine(),
    { getConfiguration: async () => ({ stages: [] }) } as never,
  );

  return { db, service };
}

const periodInput = {
  workspaceId: WORKSPACE,
  rangeLabel: "2026-07-01 a 2026-07-02",
  since: "2026-07-01",
  until: "2026-07-02",
  includeSummary: true,
};

describe("meta reporting: tipo de campanha (Implatec)", () => {
  it("sem filtro de tipo continua mostrando so as campanhas de WhatsApp", async () => {
    const { service } = createHarness();

    const report = await service.getCampaignReportOverview(periodInput);

    expect(report.campaigns.map((row) => row.id)).toEqual(["cmp_wpp"]);
    expect(report.campaigns[0]).toMatchObject({ campaignKind: "whatsapp" });
  });

  it("tipo=lead_form mostra so a campanha de formulario e conta o lead do formulario como lead novo", async () => {
    const { service } = createHarness();

    const report = await service.getCampaignReportOverview({
      ...periodInput,
      campaignKind: "lead_form",
    });

    expect(report.campaigns.map((row) => row.id)).toEqual(["cmp_form"]);
    expect(report.campaigns[0]).toMatchObject({
      campaignKind: "lead_form",
      spendCents: 20_000,
      realConversations: 1,
      costPerRealConversationCents: 20_000,
    });
  });

  it("tipo=all junta WhatsApp e formulario, cada linha com o seu tipo", async () => {
    const { service } = createHarness();

    const report = await service.getCampaignReportOverview({
      ...periodInput,
      campaignKind: "all",
    });

    expect(
      report.campaigns.map((row) => [row.id, row.campaignKind]).sort(),
    ).toEqual([
      ["cmp_form", "lead_form"],
      ["cmp_wpp", "whatsapp"],
    ]);
    expect(report.summary).toMatchObject({
      spendCents: 50_000,
      realConversations: 2,
    });
  });

  it("tipo=whatsapp e igual ao padrao", async () => {
    const { service } = createHarness();

    const report = await service.getCampaignReportOverview({
      ...periodInput,
      campaignKind: "whatsapp",
    });

    expect(report.campaigns.map((row) => row.id)).toEqual(["cmp_wpp"]);
  });

  it("classifica o tipo da campanha pelas evidencias", () => {
    const { service } = createHarness();
    const classify = (
      service as unknown as {
        campaignKindFor: (input: {
          objective: string | null;
          whatsappClassification: string;
          adSetDestinationTypes: Array<string | null>;
          hasLeadFormEvidence: boolean;
        }) => { kind: string; source: string };
      }
    ).campaignKindFor.bind(service);

    // Lead vindo do formulario vence qualquer outro sinal.
    expect(
      classify({
        objective: "OUTCOME_LEADS",
        whatsappClassification: "detected_by_leads",
        adSetDestinationTypes: ["WHATSAPP"],
        hasLeadFormEvidence: true,
      }),
    ).toEqual({ kind: "lead_form", source: "lead_evidence:meta_leadgen" });
    // Cadastros com destino no proprio anuncio = formulario instantaneo.
    expect(
      classify({
        objective: "OUTCOME_LEADS",
        whatsappClassification: "not_whatsapp",
        adSetDestinationTypes: ["ON_AD"],
        hasLeadFormEvidence: false,
      }).kind,
    ).toBe("lead_form");
    // Cadastros com destino WhatsApp continua WhatsApp.
    expect(
      classify({
        objective: "OUTCOME_LEADS",
        whatsappClassification: "auto_whatsapp",
        adSetDestinationTypes: ["WHATSAPP"],
        hasLeadFormEvidence: false,
      }).kind,
    ).toBe("whatsapp");
    // Cadastros sem sinal nenhum: formulario (objetivo).
    expect(
      classify({
        objective: "OUTCOME_LEADS",
        whatsappClassification: "not_whatsapp",
        adSetDestinationTypes: [null],
        hasLeadFormEvidence: false,
      }),
    ).toEqual({ kind: "lead_form", source: "objective:leads" });
    // Trafego para site, sem WhatsApp: fora dos dois tipos.
    expect(
      classify({
        objective: "OUTCOME_TRAFFIC",
        whatsappClassification: "not_whatsapp",
        adSetDestinationTypes: ["WEBSITE"],
        hasLeadFormEvidence: false,
      }).kind,
    ).toBe("other");
  });
});
