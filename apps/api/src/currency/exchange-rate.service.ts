import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import type { CurrencyCode } from "@wpptrack/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  RUNTIME_ENV,
  RUNTIME_FETCH,
  type RuntimeEnv,
} from "../common/runtime/runtime.module";
import {
  fetchPtaxClosingRates,
  type ForeignCurrency,
  type PtaxClosingRate,
  type PtaxFetch,
} from "./ptax.client";

const FOREIGN_CURRENCIES: ForeignCurrency[] = ["USD", "EUR"];
/** Sem boletim no dia, usa o último dia útil anterior até N dias antes. */
export const MAX_RATE_FALLBACK_DAYS = 10;
/** Depois de uma falha do BCB, a moeda só é buscada de novo após este tempo. */
const LAZY_FILL_RETRY_MS = 60 * 60_000;
/** A busca sob demanda nunca pede mais que isto de uma vez. */
const MAX_LAZY_FILL_DAYS = 400;
/** Sincronização periódica: a cada 6 h, os últimos dias de USD e EUR. */
export const PTAX_SYNC_INTERVAL_MS = 6 * 60 * 60_000;
const PTAX_SYNC_LOOKBACK_DAYS = 10;
const PTAX_TIMEZONE = "America/Sao_Paulo";

export type ExchangeRateRequest = { currency: CurrencyCode; date: string };

type ExchangeRateRow = {
  date: Date;
  baseCurrency: string;
  rate: { toString(): string } | number | string;
};

export type ExchangeRateClock = { now(): Date };
export const EXCHANGE_RATE_CLOCK = Symbol("EXCHANGE_RATE_CLOCK");
export const PTAX_FETCH = Symbol("PTAX_FETCH");

/** "2026-10-15" + n dias. */
export function shiftIsoDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Dia (America/Sao_Paulo) de um instante: o dia da venda para a PTAX. */
export function saoPauloDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PTAX_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Sábado/domingo -> sexta anterior; dias úteis ficam iguais. */
export function previousWeekday(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 6
    ? shiftIsoDate(date, -1)
    : day === 0
      ? shiftIsoDate(date, -2)
      : date;
}

/**
 * `PTAX_SYNC_ENABLED`: desligada por padrão. Desligada, nada é buscado no
 * Banco Central e nada é convertido (venda em outra moeda fica na moeda
 * original, "sem cotação").
 */
export function isPtaxSyncEnabled(env: RuntimeEnv = process.env): boolean {
  const value = env.PTAX_SYNC_ENABLED?.trim().toLowerCase();
  return Boolean(value && ["1", "true", "yes", "sim", "on"].includes(value));
}

/**
 * Cotações carregadas para um relatório. Converte entre BRL/USD/EUR (USD<->EUR
 * via BRL) pela PTAX do dia ou, sem boletim nesse dia, pela do último dia útil
 * anterior (até MAX_RATE_FALLBACK_DAYS). Sem cotação, `convert` devolve null:
 * o relatório nunca quebra.
 */
export class ExchangeRateTable {
  private readonly rates = new Map<ForeignCurrency, Array<[string, number]>>();

  constructor(
    rows: Array<{ currency: ForeignCurrency; date: string; rate: number }> = [],
  ) {
    for (const row of rows) this.add(row.currency, row.date, row.rate);
  }

  add(currency: ForeignCurrency, date: string, rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    const list = this.rates.get(currency) ?? [];
    const index = list.findIndex(([existing]) => existing === date);
    if (index >= 0) list[index] = [date, rate];
    else list.push([date, rate]);
    list.sort((a, b) => a[0].localeCompare(b[0]));
    this.rates.set(currency, list);
  }

  hasExact(currency: ForeignCurrency, date: string): boolean {
    return (this.rates.get(currency) ?? []).some(([day]) => day === date);
  }

  /** Reais por 1 unidade (BRL = 1), ou null sem cotação. */
  brlRate(currency: CurrencyCode, date: string): number | null {
    if (currency === "BRL") return 1;
    const list = this.rates.get(currency) ?? [];
    const oldest = shiftIsoDate(date, -MAX_RATE_FALLBACK_DAYS);

    for (let index = list.length - 1; index >= 0; index -= 1) {
      const [day, rate] = list[index]!;
      if (day > date) continue;
      return day >= oldest ? rate : null;
    }

    return null;
  }

  /** Taxa from->to (1 from = N to) no dia, ou null sem cotação. */
  rate(from: CurrencyCode, to: CurrencyCode, date: string): number | null {
    if (from === to) return 1;
    const fromBrl = this.brlRate(from, date);
    const toBrl = this.brlRate(to, date);
    return fromBrl === null || toBrl === null ? null : fromBrl / toBrl;
  }

  convert(
    cents: number,
    from: CurrencyCode,
    to: CurrencyCode,
    date: string,
  ): number | null {
    if (from === to) return cents;
    const rate = this.rate(from, to, date);
    return rate === null ? null : Math.round(cents * rate);
  }
}

/** Hora (Brasília) a partir da qual o boletim de fechamento do dia costuma existir. */
const TODAY_CLOSING_AFTER_MINUTES = 13 * 60 + 30;

/** Minutos desde a meia-noite em America/Sao_Paulo. */
function saoPauloMinutes(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: PTAX_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: string) =>
    Number(parts.find((item) => item.type === type)?.value ?? "0");

  return part("hour") * 60 + part("minute");
}

/** Dias úteis (seg-sex) de from a to, inclusive. */
function weekdaysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = shiftIsoDate(day, 1)) {
    if (previousWeekday(day) === day) days.push(day);
  }
  return days;
}

export type ExchangeRateOptions = {
  /** Quanto a leitura de um relatório espera pelo BCB (padrão 1,5 s). */
  lazyFillWaitMs?: number;
};
export const EXCHANGE_RATE_OPTIONS = Symbol("EXCHANGE_RATE_OPTIONS");
export const DEFAULT_LAZY_FILL_WAIT_MS = 1_500;

/**
 * Cotação PTAX (Banco Central) para os relatórios por moeda (Fase 5.2).
 * Mesmo padrão do sync automático da Meta: um timer no processo da API,
 * ligado só por variável de ambiente. Nada aqui envia algo à Meta e nenhum
 * erro do Banco Central sobe para quem chamou: no pior caso, "sem cotação".
 *
 * A leitura de um relatório nunca espera o BCB por mais de ~1,5 s: o que
 * falta é buscado em segundo plano (uma busca por moeda de cada vez, sem
 * duplicar entre pedidos simultâneos) e a tabela sai com o que já se sabe.
 * Cotações buscadas ficam também em memória, para o mesmo relatório não
 * alternar entre convertido e "sem cotação" se o banco não gravar.
 */
@Injectable()
export class ExchangeRateService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ExchangeRateService.name);
  /** Cotações já obtidas do BCB nesta API (moeda -> dia -> reais). */
  private readonly knownRates = new Map<ForeignCurrency, Map<string, number>>();
  /** Dias úteis buscados com sucesso que vieram sem boletim (feriados). */
  private readonly resolvedWithoutBulletin = new Set<string>();
  /** Busca em andamento por moeda (uma só, compartilhada). */
  private readonly inflight = new Map<ForeignCurrency, Promise<void>>();
  /** Depois de uma falha, a moeda só é buscada de novo a partir daqui. */
  private readonly retryAfter = new Map<ForeignCurrency, number>();
  private readonly lazyFillWaitMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject(PTAX_FETCH)
    private readonly ptaxFetch?: PtaxFetch,
    @Optional()
    @Inject(RUNTIME_FETCH)
    private readonly runtimeFetch?: typeof fetch,
    @Optional()
    @Inject(RUNTIME_ENV)
    private readonly env: RuntimeEnv = process.env,
    @Optional()
    @Inject(EXCHANGE_RATE_CLOCK)
    private readonly clock: ExchangeRateClock = { now: () => new Date() },
    @Optional()
    @Inject(EXCHANGE_RATE_OPTIONS)
    options?: ExchangeRateOptions,
  ) {
    this.lazyFillWaitMs = options?.lazyFillWaitMs ?? DEFAULT_LAZY_FILL_WAIT_MS;
  }

  enabled(): boolean {
    return isPtaxSyncEnabled(this.env ?? process.env);
  }

  onApplicationBootstrap() {
    if (!this.enabled()) {
      return;
    }

    const run = () => {
      void this.syncRecentRates()
        .then((result) => {
          this.logger.log(
            `PTAX sync stored=${result.stored} failed=${result.failed.join(",") || "-"}`,
          );
        })
        .catch(() => {
          this.logger.warn("PTAX_SYNC_FAILED");
        });
    };

    this.logger.log(
      "PTAX sync ligada: primeira busca em 1-2 min, depois a cada 6 h",
    );
    this.initialTimer = setTimeout(
      run,
      60_000 + Math.floor(Math.random() * 60_000),
    );
    this.timer = setInterval(run, PTAX_SYNC_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
    this.initialTimer = null;
    this.timer = null;
  }

  /**
   * Sincronização periódica: guarda a PTAX dos últimos dias de USD e EUR (em
   * paralelo). Idempotente (única por dia e par de moedas); falha do BCB só
   * gera log e as cotações já guardadas continuam valendo.
   */
  async syncRecentRates(): Promise<{
    stored: number;
    failed: ForeignCurrency[];
  }> {
    if (!this.enabled() || this.running) {
      return { stored: 0, failed: [] };
    }

    this.running = true;
    const today = saoPauloDate(this.clock.now());
    const from = shiftIsoDate(today, -PTAX_SYNC_LOOKBACK_DAYS);

    try {
      const results = await Promise.all(
        FOREIGN_CURRENCIES.map(async (currency) => {
          try {
            const rates = await this.fetchAndRemember(currency, from, today);
            return {
              currency,
              stored: await this.storeRates(currency, rates),
            };
          } catch {
            this.logger.warn(`PTAX_SYNC_UNAVAILABLE currency=${currency}`);
            return { currency, stored: null };
          }
        }),
      );

      return {
        stored: results.reduce((sum, item) => sum + (item.stored ?? 0), 0),
        failed: results
          .filter((item) => item.stored === null)
          .map((item) => item.currency),
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Cotações para converter vendas nas datas pedidas. Desligada: tabela
   * vazia, sem ler o banco nem a rede. Ligada: lê o que está guardado (e o
   * que esta API já buscou) e, para dias úteis que faltam, dispara a busca no
   * BCB em segundo plano, esperando no máximo ~1,5 s. Nunca lança.
   */
  async loadRateTable(
    requests: ExchangeRateRequest[],
  ): Promise<ExchangeRateTable> {
    const table = new ExchangeRateTable();

    if (!this.enabled()) {
      return table;
    }

    const datesByCurrency = new Map<ForeignCurrency, Set<string>>();

    for (const request of requests) {
      if (request.currency === "BRL") continue;
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(request.date)) continue;
      const dates = datesByCurrency.get(request.currency) ?? new Set<string>();
      dates.add(request.date);
      datesByCurrency.set(request.currency, dates);
    }

    if (datesByCurrency.size === 0) return table;

    const allDates = [...datesByCurrency.values()].flatMap((dates) => [
      ...dates,
    ]);
    const minDate = allDates.reduce((a, b) => (a < b ? a : b));
    const maxDate = allDates.reduce((a, b) => (a > b ? a : b));

    try {
      const rows = (await this.prisma.exchangeRate.findMany({
        where: {
          baseCurrency: { in: [...datesByCurrency.keys()] },
          quoteCurrency: "BRL",
          date: {
            gte: new Date(
              `${shiftIsoDate(minDate, -MAX_RATE_FALLBACK_DAYS)}T00:00:00.000Z`,
            ),
            lte: new Date(`${maxDate}T00:00:00.000Z`),
          },
        },
        select: { date: true, baseCurrency: true, rate: true },
      })) as ExchangeRateRow[];

      for (const row of rows) {
        table.add(
          row.baseCurrency as ForeignCurrency,
          row.date.toISOString().slice(0, 10),
          Number(row.rate.toString()),
        );
      }
    } catch {
      this.logger.warn("EXCHANGE_RATE_READ_FAILED");
    }

    this.addKnownRates(table, datesByCurrency.keys());

    const fills: Promise<void>[] = [];

    for (const [currency, dates] of datesByCurrency) {
      const missing = this.missingBusinessDays(currency, dates, table);
      if (missing.length === 0) continue;
      const fill = this.fillInBackground(currency, missing);
      if (fill) fills.push(fill);
    }

    if (fills.length > 0) {
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(fills),
        new Promise<void>((resolve) => {
          waitTimer = setTimeout(resolve, this.lazyFillWaitMs);
        }),
      ]);
      if (waitTimer) clearTimeout(waitTimer);
      this.addKnownRates(table, datesByCurrency.keys());
    }

    return table;
  }

  /** Resolve quando nenhuma busca em segundo plano está em andamento. */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight.values()]);
    }
  }

  private addKnownRates(
    table: ExchangeRateTable,
    currencies: Iterable<ForeignCurrency>,
  ): void {
    for (const currency of currencies) {
      for (const [date, rate] of this.knownRates.get(currency) ?? []) {
        table.add(currency, date, rate);
      }
    }
  }

  /**
   * Dias úteis ainda sem cotação que valem uma busca: nem guardados, nem já
   * buscados sem boletim (feriado), e hoje só depois das 13h30 de Brasília.
   */
  private missingBusinessDays(
    currency: ForeignCurrency,
    dates: Set<string>,
    table: ExchangeRateTable,
  ): string[] {
    const now = this.clock.now();
    const today = saoPauloDate(now);
    const todayClosed = saoPauloMinutes(now) >= TODAY_CLOSING_AFTER_MINUTES;

    return [...new Set([...dates].map(previousWeekday))]
      .filter(
        (date) =>
          (date < today || (date === today && todayClosed)) &&
          !table.hasExact(currency, date) &&
          !this.resolvedWithoutBulletin.has(`${currency}:${date}`),
      )
      .sort();
  }

  /** Dispara (ou reaproveita) a busca da moeda; null se em espera após falha. */
  private fillInBackground(
    currency: ForeignCurrency,
    missing: string[],
  ): Promise<void> | null {
    const running = this.inflight.get(currency);
    if (running) return running;

    if ((this.retryAfter.get(currency) ?? 0) > this.clock.now().getTime()) {
      return null;
    }

    const to = missing[missing.length - 1]!;
    const earliest = shiftIsoDate(to, -MAX_LAZY_FILL_DAYS);
    const from = shiftIsoDate(
      missing[0]! < earliest ? earliest : missing[0]!,
      -MAX_RATE_FALLBACK_DAYS,
    );
    const fill = (async () => {
      try {
        const rates = await this.fetchAndRemember(currency, from, to);
        await this.storeRates(currency, rates);
        this.retryAfter.delete(currency);
      } catch {
        this.retryAfter.set(
          currency,
          this.clock.now().getTime() + LAZY_FILL_RETRY_MS,
        );
        this.logger.warn(
          `PTAX_LAZY_FILL_UNAVAILABLE currency=${currency} from=${from} to=${to}`,
        );
      } finally {
        this.inflight.delete(currency);
      }
    })();

    this.inflight.set(currency, fill);
    return fill;
  }

  /**
   * Busca no BCB, guarda em memória e marca como resolvidos os dias úteis do
   * intervalo que vieram sem boletim (hoje só depois do fechamento).
   */
  private async fetchAndRemember(
    currency: ForeignCurrency,
    from: string,
    to: string,
  ): Promise<PtaxClosingRate[]> {
    const rates = await this.fetchRates(currency, from, to);
    const known = this.knownRates.get(currency) ?? new Map<string, number>();
    for (const rate of rates) known.set(rate.date, rate.rate);
    this.knownRates.set(currency, known);

    const now = this.clock.now();
    const today = saoPauloDate(now);
    const todayClosed = saoPauloMinutes(now) >= TODAY_CLOSING_AFTER_MINUTES;
    if (this.resolvedWithoutBulletin.size > 5_000) {
      this.resolvedWithoutBulletin.clear();
    }
    for (const day of weekdaysBetween(from, to)) {
      if (known.has(day)) continue;
      if (day > today || (day === today && !todayClosed)) continue;
      this.resolvedWithoutBulletin.add(`${currency}:${day}`);
    }

    return rates;
  }

  private async fetchRates(
    currency: ForeignCurrency,
    from: string,
    to: string,
  ): Promise<PtaxClosingRate[]> {
    const fetchImpl =
      this.ptaxFetch ??
      (this.runtimeFetch as unknown as PtaxFetch | undefined) ??
      (fetch as unknown as PtaxFetch);

    return fetchPtaxClosingRates(fetchImpl, { currency, from, to });
  }

  private async storeRates(
    currency: ForeignCurrency,
    rates: PtaxClosingRate[],
  ): Promise<number> {
    if (rates.length === 0) return 0;

    try {
      const result = await this.prisma.exchangeRate.createMany({
        data: rates.map((rate) => ({
          date: new Date(`${rate.date}T00:00:00.000Z`),
          baseCurrency: currency,
          quoteCurrency: "BRL" as const,
          rate: rate.rate.toFixed(8),
          source: "bcb_ptax",
          bulletinAt: rate.bulletinAt,
          fetchedAt: this.clock.now(),
        })),
        skipDuplicates: true,
      });
      return result.count;
    } catch {
      this.logger.warn(`EXCHANGE_RATE_STORE_FAILED currency=${currency}`);
      return 0;
    }
  }
}
