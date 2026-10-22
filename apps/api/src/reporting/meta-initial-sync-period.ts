import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";

export const MAX_INITIAL_LOOKBACK_DAYS = 7;

const WHATSAPP_INSTANCE_PROVIDERS = [
  "uazapi_byo",
  "waha",
  "zapi",
  "nod_api",
] as const;

const INBOUND_WHATSAPP_PROVIDERS = [
  "umbler",
  "gupshup",
  "uazapi",
  "meta_cloud",
  "data_crazy",
  "unnichat",
] as const;

export type MetaInitialSyncAnchorSource =
  "whatsapp_instance" | "inbound_webhook_connection";

export type MetaInitialSyncAnchor = {
  createdAt: Date;
  source: MetaInitialSyncAnchorSource;
};

export type MetaInitialSyncPeriod = {
  since: string;
  until: string;
  anchorSource: MetaInitialSyncAnchorSource | null;
  lookbackDaysApplied: number;
};

export function resolveMetaInitialSyncPeriod(input: {
  anchors: readonly MetaInitialSyncAnchor[];
  now: Date;
  timeZone?: string;
}): MetaInitialSyncPeriod {
  const timeZone = input.timeZone ?? "America/Sao_Paulo";
  const until = reportDate(input.now, timeZone);
  const earliestAnchor = input.anchors.reduce<MetaInitialSyncAnchor | null>(
    (earliest, anchor) =>
      earliest === null || anchor.createdAt < earliest.createdAt
        ? anchor
        : earliest,
    null,
  );

  if (!earliestAnchor) {
    return {
      since: until,
      until,
      anchorSource: null,
      lookbackDaysApplied: 1,
    };
  }

  const earliestAllowed = subtractDateDays(
    until,
    MAX_INITIAL_LOOKBACK_DAYS - 1,
  );
  const anchorDate = reportDate(earliestAnchor.createdAt, timeZone);
  const since = anchorDate < earliestAllowed ? earliestAllowed : anchorDate;

  return {
    since,
    until,
    anchorSource: earliestAnchor.source,
    lookbackDaysApplied: inclusiveDaysBetween(since, until),
  };
}

@Injectable()
export class MetaInitialSyncPeriodService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolve(input: {
    workspaceId: string;
    now?: Date;
  }): Promise<MetaInitialSyncPeriod> {
    const [instances, inboundConnections] = await Promise.all([
      this.prisma.whatsappInstance.findMany({
        where: {
          workspaceId: input.workspaceId,
          provider: { in: [...WHATSAPP_INSTANCE_PROVIDERS] },
          status: "active",
        },
        select: { createdAt: true },
      }),
      this.prisma.inboundWebhookConnection.findMany({
        where: {
          workspaceId: input.workspaceId,
          provider: { in: [...INBOUND_WHATSAPP_PROVIDERS] },
          removedAt: null,
        },
        select: { createdAt: true },
      }),
    ]);

    return resolveMetaInitialSyncPeriod({
      anchors: [
        ...instances.map((instance) => ({
          createdAt: instance.createdAt,
          source: "whatsapp_instance" as const,
        })),
        ...inboundConnections.map((connection) => ({
          createdAt: connection.createdAt,
          source: "inbound_webhook_connection" as const,
        })),
      ],
      now: input.now ?? new Date(),
      timeZone: process.env.WPPTRACK_REPORT_TIMEZONE ?? "America/Sao_Paulo",
    });
  }
}

function reportDate(date: Date, timeZone: string): string {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );

  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function subtractDateDays(date: string, days: number): string {
  const result = new Date(`${date}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() - days);
  return result.toISOString().slice(0, 10);
}

function inclusiveDaysBetween(since: string, until: string): number {
  const start = new Date(`${since}T12:00:00.000Z`).getTime();
  const end = new Date(`${until}T12:00:00.000Z`).getTime();
  return Math.floor((end - start) / 86_400_000) + 1;
}
