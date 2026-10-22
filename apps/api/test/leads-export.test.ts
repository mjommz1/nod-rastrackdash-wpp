import { PassThrough } from "node:stream";
import { UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as ExcelJS from "exceljs";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.service";
import { LeadsController } from "../src/leads/leads.controller";
import {
  formatLeadExportDateTime,
  leadExportExcelDate,
  leadExportFilename,
  leadExportMaxRows,
  neutralizeFormula,
  writeLeadsCsv,
  writeLeadsXlsx,
  type LeadExportRow,
} from "../src/leads/leads-export";
import { LeadsService } from "../src/leads/leads.service";
import { WorkspacesService } from "../src/workspaces/workspaces.service";

const row = (overrides: Partial<LeadExportRow> = {}): LeadExportRow => ({
  name: "Mariana Alves",
  phone: "+55 11 99999-1020",
  // 02/07/2026 00:00:05 in Sao Paulo (UTC-3).
  enteredAt: new Date("2026-07-02T03:00:05.000Z"),
  lastActivityAt: new Date("2026-07-02T15:10:00.000Z"),
  campaign: "Black Friday WhatsApp",
  adSet: "Publico quente",
  ad: "Criativo WhatsApp",
  source: "NOD API",
  stage: "Lead qualificado",
  campaignId: "cmp_1",
  adSetId: "adset_1",
  adId: "ad_1",
  ...overrides,
});

async function* batchesOf(...batches: LeadExportRow[][]) {
  for (const batch of batches) {
    yield batch;
  }
}

async function collect(
  writer: typeof writeLeadsCsv,
  batches: AsyncIterable<LeadExportRow[]>,
): Promise<Buffer> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];

  const ended = new Promise((resolve) => sink.once("end", resolve));

  sink.on("data", (chunk: Buffer) => chunks.push(chunk));
  await writer(sink, batches);
  await ended;

  return Buffer.concat(chunks);
}

describe("lead export formatting", () => {
  it("formats dates as dd/mm/aaaa hh:mm:ss in Sao Paulo time", () => {
    expect(formatLeadExportDateTime(new Date("2026-07-02T03:00:05.000Z"))).toBe(
      "02/07/2026 00:00:05",
    );
    expect(formatLeadExportDateTime(new Date("2026-12-31T23:59:59.000Z"))).toBe(
      "31/12/2026 20:59:59",
    );
    // Midnight is 00, never 24.
    expect(formatLeadExportDateTime(new Date("2026-07-02T03:00:00.000Z"))).toBe(
      "02/07/2026 00:00:00",
    );
    expect(formatLeadExportDateTime(null)).toBe("");
  });

  it("builds Excel dates that show the Sao Paulo wall clock", () => {
    expect(
      leadExportExcelDate(new Date("2026-07-02T03:00:05.000Z"))?.toISOString(),
    ).toBe("2026-07-02T00:00:05.000Z");
    expect(leadExportExcelDate(null)).toBeNull();
  });

  it("neutralizes formula injection but keeps a plain phone readable", () => {
    for (const value of ["=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)"]) {
      expect(neutralizeFormula(value)).toBe(`'${value}`);
    }

    expect(neutralizeFormula("\t=1+1")).toBe("'\t=1+1");
    // Leading spaces do not stop a spreadsheet from evaluating the formula.
    for (const value of [" =1+1", "   +cmd", "  -2+3", " @SUM(A1)"]) {
      expect(neutralizeFormula(value)).toBe(`'${value}`);
    }
    expect(neutralizeFormula("  Mariana")).toBe("  Mariana");
    expect(
      neutralizeFormula(" +55 11 99999-1020", { allowPlainPhone: true }),
    ).toBe(" +55 11 99999-1020");
    expect(neutralizeFormula("Mariana")).toBe("Mariana");
    expect(
      neutralizeFormula("+55 11 99999-1020", { allowPlainPhone: true }),
    ).toBe("+55 11 99999-1020");
    // A "phone" with anything executable still gets neutralized.
    expect(
      neutralizeFormula("+55=HYPERLINK(1)", { allowPlainPhone: true }),
    ).toBe("'+55=HYPERLINK(1)");
  });

  it("names the file leads_<slug>_<periodo>.<ext>", () => {
    expect(
      leadExportFilename({
        workspaceSlug: "Comunidade NOD",
        format: "csv",
        since: "2026-09-01",
        until: "2026-09-24",
      }),
    ).toBe("leads_comunidade-nod_2026-09-01_a_2026-09-24.csv");
    expect(leadExportFilename({ workspaceSlug: "acme", format: "xlsx" })).toBe(
      "leads_acme_todos.xlsx",
    );
    expect(
      leadExportFilename({
        workspaceSlug: "acme",
        format: "xlsx",
        since: "2026-09-01",
      }),
    ).toBe("leads_acme_desde_2026-09-01.xlsx");
    expect(
      leadExportFilename({
        workspaceSlug: '../"evil"\r\n',
        format: "csv",
        until: "2026-09-24",
      }),
    ).toBe("leads_evil_ate_2026-09-24.csv");
  });

  it("leaves the workspace out of the name when data is hidden", () => {
    expect(
      leadExportFilename({
        workspaceSlug: "Cliente Sigiloso",
        format: "xlsx",
        since: "2026-09-01",
        until: "2026-09-24",
        masked: true,
      }),
    ).toBe("leads_2026-09-01_a_2026-09-24.xlsx");
    expect(
      leadExportFilename({
        workspaceSlug: "acme",
        format: "csv",
        masked: true,
      }),
    ).toBe("leads_todos.csv");
  });
});

describe("lead CSV", () => {
  it("writes UTF-8 BOM, ; separator, pt-BR headers and every batch", async () => {
    const output = await collect(
      writeLeadsCsv,
      batchesOf([row()], [row({ name: "José", phone: "" })]),
    );

    expect(output.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));

    const lines = output.toString("utf8").replace(/^﻿/u, "").split("\r\n");

    expect(lines[0]).toBe(
      "Nome;Telefone;Data/hora de entrada;Última atividade;Campanha;Conjunto;Anúncio;Origem/Tipo;Etapa atual;ID da campanha;ID do conjunto;ID do anúncio",
    );
    expect(lines[1]).toBe(
      "Mariana Alves;+55 11 99999-1020;02/07/2026 00:00:05;02/07/2026 12:10:00;Black Friday WhatsApp;Publico quente;Criativo WhatsApp;NOD API;Lead qualificado;cmp_1;adset_1;ad_1",
    );
    expect(lines[2]).toMatch(/^José;;02\/07\/2026 00:00:05;/u);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
  });

  it("quotes separators, quotes and line breaks and blocks formulas", async () => {
    const output = (
      await collect(
        writeLeadsCsv,
        batchesOf([
          row({
            name: '=HYPERLINK("http://evil";"x")',
            campaign: 'Promo; "verao"\nlinha 2',
            ad: "@alvo",
            adSet: "-1",
          }),
        ]),
      )
    ).toString("utf8");

    expect(output).toContain(`"'=HYPERLINK(""http://evil"";""x"")"`);
    expect(output).toContain(`"Promo; ""verao""\nlinha 2"`);
    expect(output).toContain(";'-1;'@alvo;");
  });
});

describe("cancelled download", () => {
  it("stops waiting for drain when the stream closes", async () => {
    // Tiny buffer and nobody reading: write() backs up and waits for drain.
    const sink = new PassThrough({ highWaterMark: 1 });
    const pending = writeLeadsCsv(sink, batchesOf([row()], [row()]));

    setTimeout(() => sink.destroy(), 20);

    await expect(pending).rejects.toThrow();
  });
});

describe("exceljs in the compiled API", () => {
  it("writes an .xlsx from the CommonJS build (no esModuleInterop)", () => {
    // vitest adds a default export to CommonJS modules; tsc (the production
    // build) does not, and exceljs has none. Compile the module like the API
    // build does and run it in a plain Node process.
    const apiRoot = resolve(__dirname, "..");
    const compiled = ts.transpileModule(
      readFileSync(join(apiRoot, "src/leads/leads-export.ts"), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          allowSyntheticDefaultImports: true,
        },
      },
    );
    const isolatedRoot = mkdtempSync(
      join(process.env.TMPDIR ?? tmpdir(), "api-leads-export-runtime-"),
    );

    try {
      writeFileSync(join(isolatedRoot, "leads-export.js"), compiled.outputText);
      mkdirSync(join(isolatedRoot, "node_modules"));
      symlinkSync(
        realpathSync(join(apiRoot, "node_modules", "exceljs")),
        join(isolatedRoot, "node_modules", "exceljs"),
        // Junctions need no symlink privilege on Windows; ignored elsewhere.
        process.platform === "win32" ? "junction" : "dir",
      );
      const script = `
        const { PassThrough } = require("node:stream");
        const { writeLeadsXlsx } = require("./leads-export.js");
        const sink = new PassThrough();
        const chunks = [];
        sink.on("data", (chunk) => chunks.push(chunk));
        async function* batches() {
          yield [{ name: "Ana", phone: "+55 11 99999-0000", enteredAt: new Date(),
            lastActivityAt: null, campaign: "", adSet: "", ad: "", source: "",
            stage: "", campaignId: "", adSetId: "", adId: "" }];
        }
        writeLeadsXlsx(sink, batches()).then(() => {
          process.stdout.write(Buffer.concat(chunks).subarray(0, 2).toString());
        });
      `;
      const childEnv = { ...process.env };
      delete childEnv.NODE_PATH;
      delete childEnv.NODE_OPTIONS;
      const result = spawnSync(process.execPath, ["-e", script], {
        cwd: isolatedRoot,
        env: childEnv,
        encoding: "utf8",
      });

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      // An .xlsx is a zip file.
      expect(result.stdout).toBe("PK");
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });
});

describe("lead XLSX", () => {
  it("writes a real workbook with header, dates, text phone and widths", async () => {
    const output = await collect(
      writeLeadsXlsx,
      batchesOf([row(), row({ name: "=1+1", enteredAt: null })]),
    );

    expect(output.subarray(0, 2).toString("latin1")).toBe("PK");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(output as never);
    const sheet = workbook.getWorksheet("Leads")!;

    expect(sheet.rowCount).toBe(3);
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      "Nome",
      "Telefone",
      "Data/hora de entrada",
      "Última atividade",
      "Campanha",
      "Conjunto",
      "Anúncio",
      "Origem/Tipo",
      "Etapa atual",
      "ID da campanha",
      "ID do conjunto",
      "ID do anúncio",
    ]);
    expect(sheet.getRow(1).font?.bold).toBe(true);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.getColumn(1).width).toBeGreaterThan(20);

    const first = sheet.getRow(2);

    expect(first.getCell(1).value).toBe("Mariana Alves");
    expect(first.getCell(2).value).toBe("+55 11 99999-1020");
    expect(first.getCell(2).numFmt).toBe("@");
    expect(first.getCell(3).value).toBeInstanceOf(Date);
    expect((first.getCell(3).value as Date).toISOString()).toBe(
      "2026-07-02T00:00:05.000Z",
    );
    expect(first.getCell(3).numFmt).toBe("dd/mm/yyyy hh:mm:ss");
    expect((first.getCell(4).value as Date).toISOString()).toBe(
      "2026-07-02T12:10:00.000Z",
    );

    const second = sheet.getRow(3);

    // A string cell is never evaluated as a formula by Excel; the value is
    // stored as text exactly as received.
    expect(second.getCell(1).value).toBe("=1+1");
    expect(second.getCell(1).type).toBe(ExcelJS.ValueType.String);
    expect(second.getCell(3).value).toBeNull();
  });
});

const session = {
  user: {
    id: "user_1",
    email: "owner@wpptrack.com",
    name: "Owner",
    authProvider: "email",
    emailVerifiedAt: null,
  },
  workspaces: [
    {
      id: "workspace_1",
      name: "Comunidade NOD",
      slug: "comunidade-nod",
      role: "owner",
    },
  ],
};

type PrismaLead = Record<string, unknown> & { id: string };

function createLeads(count: number): PrismaLead[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `lead_${String(index).padStart(5, "0")}`,
    workspaceId: "workspace_1",
    name: index === 0 ? "=cmd" : `Lead ${index}`,
    phoneDisplay: "+55 11 99999-1020",
    phoneHash: `hash_${index}`,
    status: "active",
    source: "uazapi",
    labels: [],
    campaignId: "stale",
    adSetId: "stale",
    adId: "ad_1",
    ctwaClid: null,
    ctwaSourceUrl: null,
    ctwaThumbnailUrl: null,
    firstMessageAt: new Date("2026-07-02T03:00:05.000Z"),
    lastMessageAt: new Date("2026-07-02T15:10:00.000Z"),
    createdAt: new Date("2026-07-02T03:00:00.000Z"),
    updatedAt: new Date("2026-07-02T03:00:00.000Z"),
  }));
}

function createPrisma(leads: PrismaLead[]) {
  return {
    lead: {
      count: vi.fn(async () => leads.length),
      findMany: vi.fn(
        async ({
          where,
          select,
          take,
        }: {
          where?: { id?: { in: string[] } };
          select?: { id: true };
          take?: number;
        }) => {
          const ids = where?.id?.in;
          // Mirrors Postgres: `id in (...)` comes back in storage order,
          // not in the order of the list.
          const matched = ids
            ? leads.filter((lead) => ids.includes(lead.id)).reverse()
            : leads;
          const limited = take ? matched.slice(0, take) : matched;

          return select ? limited.map(({ id }) => ({ id })) : limited;
        },
      ),
    },
    conversionEventLog: {
      findMany: vi.fn(async () => [
        { leadId: "lead_00001", eventName: "Purchase" },
      ]),
    },
    metaCampaign: {
      findMany: vi.fn(async () => [
        { campaignId: "cmp_1", name: "Campanha Real" },
      ]),
    },
    metaAdSet: {
      findMany: vi.fn(async () => [
        { adSetId: "adset_1", name: "Conjunto Real" },
      ]),
    },
    metaAd: {
      findMany: vi.fn(async () => [
        {
          adId: "ad_1",
          campaignId: "cmp_1",
          adSetId: "adset_1",
          name: "Anuncio Real",
        },
      ]),
    },
  };
}

async function drain(batches: AsyncIterable<LeadExportRow[]>) {
  const all: LeadExportRow[][] = [];

  for await (const batch of batches) {
    all.push(batch);
  }

  return all;
}

describe("leads service export", () => {
  it("applies the same filters as the list and returns every row in batches", async () => {
    const prisma = createPrisma(createLeads(2500));
    const service = new LeadsService(prisma as never);
    const filters = {
      search: "Mariana",
      status: "active" as const,
      campaignId: "cmp_1",
      since: "2026-07-01",
      until: "2026-07-02",
    };

    const { totalItems, batches } = await service.prepareLeadExport(
      "workspace_1",
      filters,
    );
    const result = await drain(batches);
    // Skips the first-contact lookups of the campaign filter (they select
    // the attribution columns); keeps the snapshot and the batches.
    const exportCalls = (
      prisma.lead.findMany.mock.calls.slice() as unknown as Array<
        [
          {
            where: Record<string, unknown>;
            orderBy?: unknown;
            select?: { campaignId?: true };
          },
        ]
      >
    ).filter(([args]) => !args.select?.campaignId);

    await service.listLeadsPage("workspace_1", { ...filters, pageSize: 25 });

    const listWhere = (
      prisma.lead.findMany.mock.calls.at(-1) as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0].where;

    expect(totalItems).toBe(2500);
    expect(result.map((batch) => batch.length)).toEqual([1000, 1000, 500]);
    // The snapshot of ids uses exactly the where the visible list uses.
    expect(exportCalls[0]![0].where).toEqual(listWhere);
    expect(exportCalls[0]![0].where.workspaceId).toBe("workspace_1");
    expect(prisma.lead.count).toHaveBeenCalledWith({ where: listWhere });
    // Batches are loaded by id and stay inside the workspace.
    for (const [args] of exportCalls.slice(1)) {
      expect(args.where).toMatchObject({
        workspaceId: "workspace_1",
        id: { in: expect.any(Array) },
      });
    }
  });

  it("keeps the snapshot order and never repeats or loses a lead", async () => {
    const leads = createLeads(2300);
    const prisma = createPrisma(leads);
    const service = new LeadsService(prisma as never);
    const { batches } = await service.prepareLeadExport("workspace_1", {});
    const iterator = batches[Symbol.asyncIterator]();
    const first = await iterator.next();

    // A lead gets a new message mid-export and jumps to the top of the list;
    // another one is deleted.
    const [moved] = leads.splice(2000, 1);
    leads.unshift({ ...moved!, lastMessageAt: new Date() });
    leads.splice(
      leads.findIndex((lead) => lead.id === "lead_01500"),
      1,
    );

    const rest: LeadExportRow[][] = [];
    for (
      let next = await iterator.next();
      !next.done;
      next = await iterator.next()
    ) {
      rest.push(next.value);
    }
    const names = [...first.value, ...rest.flat()].map((row) => row.name);

    expect(names.filter((name) => name === "Lead 2000")).toHaveLength(1);
    expect(names).not.toContain("Lead 1500");
    expect(names).toHaveLength(2299);
    expect(new Set(names).size).toBe(2299);
    // Snapshot order is preserved: lead_00000 first, ids ascending after it.
    expect(names.slice(0, 3)).toEqual(["=cmd", "Lead 1", "Lead 2"]);
  });

  it("resolves names, stage and source like the table", async () => {
    const prisma = createPrisma(createLeads(3));
    const service = new LeadsService(prisma as never);
    const { batches } = await service.prepareLeadExport("workspace_1", {});
    const rows = (await drain(batches)).flat();

    expect(rows[0]).toMatchObject({
      name: "=cmd",
      phone: "+55 11 99999-1020",
      campaign: "Campanha Real",
      adSet: "Conjunto Real",
      ad: "Anuncio Real",
      source: "NOD API",
      stage: "Conversa iniciada",
      campaignId: "cmp_1",
      adSetId: "adset_1",
      adId: "ad_1",
    });
    expect(rows[1]?.stage).toBe("Compra atribuida");
    expect(rows[0]?.enteredAt?.toISOString()).toBe("2026-07-02T03:00:05.000Z");
  });

  it("uses the creation date as entry for leads without a message time", async () => {
    const leads = createLeads(1);
    leads[0]!.firstMessageAt = null;
    const prisma = createPrisma(leads);
    const service = new LeadsService(prisma as never);
    const { batches } = await service.prepareLeadExport("workspace_1", {});
    const [row] = (await drain(batches)).flat();

    // Same first-contact rule as the cohort (firstMessageAt ?? createdAt).
    expect(row?.enteredAt).toEqual(leads[0]!.createdAt);
    expect(row?.enteredAt).not.toBeNull();
  });

  it("hides names, phones and campaign data when the privacy toggle is on", async () => {
    const prisma = createPrisma(createLeads(1));
    const service = new LeadsService(prisma as never);
    const { batches } = await service.prepareLeadExport("workspace_1", {
      maskSensitive: true,
    });
    const [row] = (await drain(batches)).flat();

    expect(row).toMatchObject({
      name: "Lead oculto",
      phone: "(00) 00000-0000",
      campaign: "Campanha oculta",
      adSet: "Conjunto oculto",
      ad: "Anúncio oculto",
      campaignId: "",
      adSetId: "",
      adId: "",
    });
    expect(JSON.stringify(row)).not.toContain("99999");
    expect(JSON.stringify(row)).not.toContain("cmp_1");
    expect(JSON.stringify(row)).not.toContain("ad_1");
  });

  it("refuses an export above the limit with a clear message", async () => {
    const prisma = createPrisma([]);
    prisma.lead.count.mockResolvedValue(leadExportMaxRows + 1);
    const service = new LeadsService(prisma as never);

    await expect(
      service.prepareLeadExport("workspace_1", {}),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("50.000"),
    });
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
  });

  it("exports nothing (just the header) when the events filter matches nobody", async () => {
    const prisma = createPrisma([]);
    prisma.conversionEventLog.findMany = vi.fn(async () => []) as never;
    const service = new LeadsService({
      ...prisma,
      lead: { ...prisma.lead, findMany: vi.fn(async () => []) },
    } as never);
    const { totalItems, batches } = await service.prepareLeadExport(
      "workspace_1",
      { eventName: "Purchase" },
    );

    expect(totalItems).toBe(0);
    expect(await drain(batches)).toEqual([]);
  });
});

async function createApp(
  options: { totalItems?: number; reject?: boolean } = {},
) {
  const authService = {
    getSession: vi.fn(async () => {
      if (options.reject) {
        throw new UnauthorizedException();
      }

      return session;
    }),
  };
  const workspacesService = {
    getCurrentWorkspace: vi.fn(() => ({
      ...session.workspaces[0],
      permissions: { canViewReports: true },
    })),
  };
  const leadsService = {
    prepareLeadExport: vi.fn(async () => ({
      totalItems: options.totalItems ?? 1,
      batches: batchesOf([row()]),
    })),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [LeadsController],
    providers: [
      { provide: AuthService, useValue: authService },
      { provide: WorkspacesService, useValue: workspacesService },
      { provide: LeadsService, useValue: leadsService },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();

  return { app, leadsService, authService };
}

describe("GET /leads/export", () => {
  it("downloads a CSV for the current workspace with the active filters", async () => {
    const { app, leadsService } = await createApp();

    const response = await request(app.getHttpServer())
      .get(
        "/leads/export?format=csv&search=mari&status=qualified&eventName=QualifiedLead&attribution=paid&since=2026-09-01&until=2026-09-24&campaignId=cmp_1&maskSensitive=1&page=3&pageSize=25",
      )
      .set("Authorization", "Bearer refresh-token")
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
    // maskSensitive=1: the workspace slug stays out of the file name.
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="leads_2026-09-01_a_2026-09-24.csv"',
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect((response.body as Buffer).toString("utf8")).toContain(
      "Mariana Alves;+55 11 99999-1020",
    );
    // Workspace comes from the session, never from the query; page params
    // are dropped so the file holds every match.
    expect(leadsService.prepareLeadExport).toHaveBeenCalledWith("workspace_1", {
      search: "mari",
      status: "qualified",
      eventName: "QualifiedLead",
      attribution: "paid",
      since: "2026-09-01",
      until: "2026-09-24",
      campaignId: "cmp_1",
      maskSensitive: true,
    });

    await app.close();
  });

  it("downloads a real .xlsx", async () => {
    const { app } = await createApp();

    const response = await request(app.getHttpServer())
      .get("/leads/export?format=xlsx")
      .set("Authorization", "Bearer refresh-token")
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(response.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="leads_comunidade-nod_todos.xlsx"',
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as never);

    expect(workbook.getWorksheet("Leads")?.rowCount).toBe(2);

    await app.close();
  });

  it("rejects a missing or unknown format", async () => {
    const { app, leadsService } = await createApp();

    await request(app.getHttpServer())
      .get("/leads/export")
      .set("Authorization", "Bearer refresh-token")
      .expect(400);
    await request(app.getHttpServer())
      .get("/leads/export?format=pdf")
      .set("Authorization", "Bearer refresh-token")
      .expect(400);
    expect(leadsService.prepareLeadExport).not.toHaveBeenCalled();

    await app.close();
  });

  it("requires a valid session", async () => {
    const { app, leadsService } = await createApp({ reject: true });

    await request(app.getHttpServer())
      .get("/leads/export?format=csv")
      .set("Authorization", "Bearer bad-token")
      .expect(401);
    expect(leadsService.prepareLeadExport).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns the limit message as a normal error instead of a file", async () => {
    const { app, leadsService } = await createApp();
    const { UnprocessableEntityException } = await import("@nestjs/common");
    leadsService.prepareLeadExport.mockRejectedValueOnce(
      new UnprocessableEntityException("Use um periodo menor") as never,
    );

    const response = await request(app.getHttpServer())
      .get("/leads/export?format=csv")
      .set("Authorization", "Bearer refresh-token")
      .expect(422);

    expect(response.body.message).toBe("Use um periodo menor");
    expect(response.headers["content-disposition"]).toBeUndefined();

    await app.close();
  });
});
