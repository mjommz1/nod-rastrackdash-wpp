import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { MetaReportSyncQueueService } from "./meta-report-sync-queue.service";

type MetaReportAutoSyncClock = {
  now(): Date;
};

type MetaReportAutoSyncResult = {
  enabled: boolean;
  workspacesFound: number;
  enqueued: number;
  failed: number;
  since: string | null;
  until: string | null;
};

export const META_REPORT_AUTO_SYNC_CLOCK = Symbol(
  "META_REPORT_AUTO_SYNC_CLOCK",
);

/**
 * First automatic sync after boot. A redeploy must not hit Meta right away
 * (all installations share the app-level rate limit of the PalmUP Meta app),
 * so the default is a random delay between 10 and 30 minutes. An explicit
 * WPPTRACK_META_AUTO_SYNC_INITIAL_DELAY_SECONDS below the minimum (e.g. the
 * old .env.example value 60) is ignored in favour of the random default.
 */
export const META_AUTO_SYNC_MIN_INITIAL_DELAY_MS = 10 * 60_000;
export const META_AUTO_SYNC_MAX_INITIAL_DELAY_MS = 30 * 60_000;

export function resolveMetaAutoSyncInitialDelayMs(
  configuredSeconds: string | undefined,
  random: () => number = Math.random,
): number {
  const parsed = Number.parseInt(configuredSeconds ?? "", 10);

  if (
    Number.isFinite(parsed) &&
    parsed * 1_000 >= META_AUTO_SYNC_MIN_INITIAL_DELAY_MS
  ) {
    return parsed * 1_000;
  }

  const span =
    META_AUTO_SYNC_MAX_INITIAL_DELAY_MS - META_AUTO_SYNC_MIN_INITIAL_DELAY_MS;
  const factor = Math.min(Math.max(random(), 0), 1);

  return META_AUTO_SYNC_MIN_INITIAL_DELAY_MS + Math.round(span * factor);
}

@Injectable()
export class MetaReportAutoSyncService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MetaReportAutoSyncService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(MetaReportSyncQueueService)
    private readonly queueService: MetaReportSyncQueueService,
    @Optional()
    @Inject(META_REPORT_AUTO_SYNC_CLOCK)
    private readonly clock: MetaReportAutoSyncClock = {
      now: () => new Date(),
    },
  ) {}

  onApplicationBootstrap() {
    const config = this.config();

    if (!this.shouldStartTimer(config.enabled)) {
      return;
    }

    const run = () => {
      void this.syncDueWorkspaces()
        .then((result) => {
          this.logger.log(
            `Meta auto sync checked ${result.workspacesFound} workspaces; enqueued=${result.enqueued}; failed=${result.failed}; period=${result.since ?? "-"}..${result.until ?? "-"}`,
          );
        })
        .catch((error) => {
          this.logger.warn(
            `Meta auto sync failed before enqueueing workspaces: ${this.errorMessage(error)}`,
          );
        });
    };

    this.logger.log(
      `Meta auto sync: first run in ${Math.round(config.initialDelayMs / 60_000)} min, then every ${Math.round(config.intervalMs / 60_000)} min`,
    );
    this.initialTimer = setTimeout(run, config.initialDelayMs);
    this.timer = setInterval(run, config.intervalMs);
  }

  onModuleDestroy() {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async syncDueWorkspaces(): Promise<MetaReportAutoSyncResult> {
    const config = this.config();

    if (!config.enabled) {
      return {
        enabled: false,
        workspacesFound: 0,
        enqueued: 0,
        failed: 0,
        since: null,
        until: null,
      };
    }

    const period = this.period(config.lookbackDays);

    if (this.running) {
      return {
        enabled: true,
        workspacesFound: 0,
        enqueued: 0,
        failed: 0,
        since: period.since,
        until: period.until,
      };
    }

    this.running = true;

    try {
      const workspaces = await this.prisma.workspace.findMany({
        where: {
          operationalStatus: "active",
          OR: [
            {
              metaIntegration: { is: { status: "connected" } },
              metaReportingAccounts: { some: { active: true } },
            },
            {
              metaBusinessConnections: {
                some: {
                  status: "active",
                  credential: { is: { status: "active" } },
                  reportingAccounts: { some: { active: true } },
                },
              },
            },
          ],
        },
        select: {
          id: true,
        },
        take: config.batchLimit,
      });
      let enqueued = 0;
      let failed = 0;

      for (const workspace of workspaces) {
        try {
          await this.queueService.enqueueWorkspaceSync({
            workspaceId: workspace.id,
            since: period.since,
            until: period.until,
          });
          enqueued += 1;
        } catch (error) {
          failed += 1;
          this.logger.warn(
            `Could not enqueue automatic Meta sync for workspace ${workspace.id}: ${this.errorMessage(error)}`,
          );
        }
      }

      return {
        enabled: true,
        workspacesFound: workspaces.length,
        enqueued,
        failed,
        since: period.since,
        until: period.until,
      };
    } finally {
      this.running = false;
    }
  }

  private shouldStartTimer(enabled: boolean): boolean {
    if (!enabled) {
      return false;
    }

    if (
      process.env.NODE_ENV === "test" &&
      process.env.WPPTRACK_META_AUTO_SYNC_ENABLED === undefined
    ) {
      return false;
    }

    return true;
  }

  private config() {
    return {
      enabled: this.booleanEnv("WPPTRACK_META_AUTO_SYNC_ENABLED", true),
      intervalMs:
        this.positiveIntegerEnv(
          "WPPTRACK_META_AUTO_SYNC_INTERVAL_MINUTES",
          180,
        ) * 60_000,
      initialDelayMs: resolveMetaAutoSyncInitialDelayMs(
        process.env.WPPTRACK_META_AUTO_SYNC_INITIAL_DELAY_SECONDS,
      ),
      lookbackDays: this.positiveIntegerEnv(
        "WPPTRACK_META_AUTO_SYNC_LOOKBACK_DAYS",
        7,
      ),
      batchLimit: this.positiveIntegerEnv(
        "WPPTRACK_META_AUTO_SYNC_BATCH_LIMIT",
        100,
      ),
    };
  }

  private booleanEnv(name: string, fallback: boolean): boolean {
    const value = process.env[name]?.trim().toLowerCase();

    if (!value) {
      return fallback;
    }

    return ["1", "true", "yes", "sim", "on"].includes(value);
  }

  private positiveIntegerEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] ?? "", 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private period(lookbackDays: number) {
    const untilDate = this.dateOnlyInReportTimezone(this.clock.now());
    const since = new Date(`${untilDate}T12:00:00.000Z`);
    since.setUTCDate(since.getUTCDate() - (lookbackDays - 1));

    return {
      since: this.dateOnly(since),
      until: untilDate,
    };
  }

  private dateOnlyInReportTimezone(date: Date): string {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: process.env.WPPTRACK_REPORT_TIMEZONE ?? "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = new Map(parts.map((part) => [part.type, part.value]));

    return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
  }

  private dateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "erro desconhecido";
  }
}
