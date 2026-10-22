import { vi } from "vitest";
import { ExchangeRateService } from "../../src/currency/exchange-rate.service";
import type { PtaxFetch } from "../../src/currency/ptax.client";

// PTAX test helpers (Fase 5.2): real ExchangeRateService, fake BCB, no network.

export type StoredRate = {
  date: Date;
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
};

export const storedRate = (
  date: string,
  baseCurrency: string,
  rate: string,
): StoredRate => ({
  date: new Date(`${date}T00:00:00.000Z`),
  baseCurrency,
  quoteCurrency: "BRL",
  rate,
});

/** Olinda payload (BCB) with opening and closing bulletins. */
export function bcbPayload(
  rows: Array<{ date: string; rate: number; bulletin?: string }>,
) {
  return {
    value: rows.map((row) => ({
      cotacaoVenda: row.rate,
      dataHoraCotacao: `${row.date} 13:08:16.814`,
      tipoBoletim: row.bulletin ?? "Fechamento",
    })),
  };
}

/**
 * Real ExchangeRateService on an in-memory ExchangeRate table, a fake BCB
 * (never the network) and a fixed clock (15/10/2026 15:00 in Sao Paulo).
 */
export function ptaxHarness(options: {
  enabled: boolean;
  rows?: StoredRate[];
  fetchImpl?: PtaxFetch;
  now?: string;
  lazyFillWaitMs?: number;
  failStore?: boolean;
}) {
  const rows: StoredRate[] = [...(options.rows ?? [])];
  const prisma = {
    exchangeRate: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            baseCurrency: { in: string[] };
            date: { gte: Date; lte: Date };
          };
        }) =>
          rows.filter(
            (row) =>
              where.baseCurrency.in.includes(row.baseCurrency) &&
              row.date.getTime() >= where.date.gte.getTime() &&
              row.date.getTime() <= where.date.lte.getTime(),
          ),
      ),
      createMany: vi.fn(async ({ data }: { data: StoredRate[] }) => {
        if (options.failStore) throw new Error("db down");
        let count = 0;
        for (const item of data) {
          if (
            !rows.some(
              (row) =>
                row.date.getTime() === item.date.getTime() &&
                row.baseCurrency === item.baseCurrency,
            )
          ) {
            rows.push(item);
            count += 1;
          }
        }
        return { count };
      }),
    },
  };
  const fetchImpl =
    options.fetchImpl ??
    vi.fn<PtaxFetch>(async () => {
      throw new Error("unexpected BCB call");
    });
  // Mutable clock: tests move it forward.
  const clock = { now: new Date(options.now ?? "2026-10-15T18:00:00.000Z") };
  const service = new ExchangeRateService(
    prisma as never,
    fetchImpl,
    undefined,
    options.enabled ? { PTAX_SYNC_ENABLED: "true" } : {},
    { now: () => clock.now },
    options.lazyFillWaitMs === undefined
      ? undefined
      : { lazyFillWaitMs: options.lazyFillWaitMs },
  );

  return { service, prisma, fetchImpl, rows, clock };
}
