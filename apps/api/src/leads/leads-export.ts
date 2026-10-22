import type { Writable } from "node:stream";
// Namespace import: the API compiles to CommonJS without esModuleInterop and
// exceljs has no default export, so a default import is undefined at runtime.
import * as ExcelJS from "exceljs";
import type { LeadExportFormat } from "@wpptrack/shared";

/** Above this the export is refused with a message instead of truncated. */
export const leadExportMaxRows = 50_000;

export const leadExportTimezone = "America/Sao_Paulo";

export const leadExportDateFormat = "dd/mm/yyyy hh:mm:ss";

export const leadExportContentTypes: Record<LeadExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** One spreadsheet row, already resolved and (when asked) masked. */
export type LeadExportRow = {
  name: string;
  phone: string;
  enteredAt: Date | null;
  lastActivityAt: Date | null;
  campaign: string;
  adSet: string;
  ad: string;
  source: string;
  stage: string;
  campaignId: string;
  adSetId: string;
  adId: string;
};

type LeadExportColumn = {
  key: keyof LeadExportRow;
  header: string;
  width: number;
  kind: "text" | "phone" | "date";
};

/** Table order first, then the ids for whoever needs to cross-check Meta. */
export const leadExportColumns: readonly LeadExportColumn[] = [
  { key: "name", header: "Nome", width: 28, kind: "text" },
  { key: "phone", header: "Telefone", width: 20, kind: "phone" },
  {
    key: "enteredAt",
    header: "Data/hora de entrada",
    width: 22,
    kind: "date",
  },
  {
    key: "lastActivityAt",
    header: "Última atividade",
    width: 22,
    kind: "date",
  },
  { key: "campaign", header: "Campanha", width: 36, kind: "text" },
  { key: "adSet", header: "Conjunto", width: 30, kind: "text" },
  { key: "ad", header: "Anúncio", width: 30, kind: "text" },
  { key: "source", header: "Origem/Tipo", width: 20, kind: "text" },
  { key: "stage", header: "Etapa atual", width: 22, kind: "text" },
  { key: "campaignId", header: "ID da campanha", width: 22, kind: "text" },
  { key: "adSetId", header: "ID do conjunto", width: 22, kind: "text" },
  { key: "adId", header: "ID do anúncio", width: 22, kind: "text" },
];

export const maskedLeadName = "Lead oculto";
export const maskedLeadPhone = "(00) 00000-0000";
export const maskedLeadCampaign = "Campanha oculta";
export const maskedLeadAdSet = "Conjunto oculto";
export const maskedLeadAd = "Anúncio oculto";

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: leadExportTimezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function saoPauloParts(date: Date) {
  const parts: Record<string, string> = {};

  for (const part of dateTimeFormatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }

  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** dd/mm/aaaa hh:mm:ss in Sao Paulo time, whatever the server timezone. */
export function formatLeadExportDateTime(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) {
    return "";
  }

  const p = saoPauloParts(date);

  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * Excel dates carry no timezone. A Date whose UTC clock equals the Sao Paulo
 * wall clock makes the cell show the same time as the CSV and the app.
 */
export function leadExportExcelDate(date: Date | null): Date | null {
  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }

  const p = saoPauloParts(date);

  return new Date(
    Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    ),
  );
}

// A phone is data we format ourselves; one made only of digits and phone
// punctuation cannot be a formula that does anything, so it keeps its "+".
const plainPhonePattern = /^\+?[\d\s().-]+$/u;

/**
 * Spreadsheet programs run text that starts with = + - @ (or a tab/CR) as a
 * formula. Lead names and campaign names come from outside, so those cells get
 * a leading apostrophe and stay plain text.
 */
export function neutralizeFormula(
  value: string,
  options: { allowPlainPhone?: boolean } = {},
): string {
  // Spreadsheet programs skip leading spaces before evaluating, so " =1+1"
  // is as dangerous as "=1+1".
  if (!/^[=+\-@\t\r]/u.test(value.trimStart())) {
    return value;
  }

  if (options.allowPlainPhone && plainPhonePattern.test(value.trim())) {
    return value;
  }

  return `'${value}`;
}

const csvSeparator = ";";

export function csvCell(value: string): string {
  return /[";\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

function csvLine(cells: string[]): string {
  return `${cells.map(csvCell).join(csvSeparator)}\r\n`;
}

function rowToCsvCells(row: LeadExportRow): string[] {
  return leadExportColumns.map((column) => {
    const value = row[column.key];

    if (column.kind === "date") {
      return formatLeadExportDateTime(value as Date | null);
    }

    return neutralizeFormula(String(value ?? ""), {
      allowPlainPhone: column.kind === "phone",
    });
  });
}

async function write(sink: Writable, chunk: string): Promise<void> {
  if (!sink.write(chunk)) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        sink.off("drain", onDrain);
        sink.off("error", onError);
        sink.off("close", onClose);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      // A cancelled download closes the stream without ever draining it.
      const onClose = () => {
        cleanup();
        reject(new Error("Download cancelado"));
      };

      sink.once("drain", onDrain);
      sink.once("error", onError);
      sink.once("close", onClose);
    });
  }
}

/** UTF-8 with BOM and ";" so Excel in pt-BR opens accents and columns right. */
export async function writeLeadsCsv(
  sink: Writable,
  batches: AsyncIterable<LeadExportRow[]>,
): Promise<void> {
  await write(
    sink,
    `﻿${csvLine(leadExportColumns.map((column) => column.header))}`,
  );

  for await (const batch of batches) {
    await write(sink, batch.map((row) => csvLine(rowToCsvCells(row))).join(""));
  }

  sink.end();
}

/** Streams a real .xlsx; only one batch of rows is held in memory. */
export async function writeLeadsXlsx(
  sink: Writable,
  batches: AsyncIterable<LeadExportRow[]>,
): Promise<void> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: sink,
    useStyles: true,
    useSharedStrings: false,
  });
  const sheet = workbook.addWorksheet("Leads", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = leadExportColumns.map((column) => ({
    key: column.key,
    width: column.width,
  }));

  const header = sheet.addRow(leadExportColumns.map((column) => column.header));
  header.font = { bold: true };
  header.alignment = { vertical: "middle" };
  header.commit();

  for await (const batch of batches) {
    for (const lead of batch) {
      const row = sheet.addRow(
        leadExportColumns.map((column) =>
          column.kind === "date"
            ? leadExportExcelDate(lead[column.key] as Date | null)
            : String(lead[column.key] ?? ""),
        ),
      );

      leadExportColumns.forEach((column, index) => {
        const cell = row.getCell(index + 1);

        if (column.kind === "date") {
          cell.numFmt = leadExportDateFormat;
        } else if (column.kind === "phone") {
          // Text, never a number: no scientific notation, no lost "+".
          cell.numFmt = "@";
        }
      });
      row.commit();
    }
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: leadExportColumns.length },
  };
  sheet.commit();
  await workbook.commit();
}

function filenameSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return slug || "workspace";
}

/**
 * leads_<workspace-slug>_<periodo>.csv|xlsx; with "Ocultar dados" on the
 * workspace is left out (leads_<periodo>.csv|xlsx), like the rest of the file.
 */
export function leadExportFilename(input: {
  workspaceSlug: string;
  format: LeadExportFormat;
  since?: string;
  until?: string;
  masked?: boolean;
}): string {
  const period =
    input.since && input.until
      ? `${input.since}_a_${input.until}`
      : input.since
        ? `desde_${input.since}`
        : input.until
          ? `ate_${input.until}`
          : "todos";

  return input.masked
    ? `leads_${period}.${input.format}`
    : `leads_${filenameSlug(input.workspaceSlug)}_${period}.${input.format}`;
}
