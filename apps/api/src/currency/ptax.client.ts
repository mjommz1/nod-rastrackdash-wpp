import type { CurrencyCode } from "@wpptrack/shared";

/**
 * Cliente da API Olinda do Banco Central (PTAX), usado só quando
 * PTAX_SYNC_ENABLED está ligada. Lê CotacaoMoedaPeriodo e guarda, por dia, a
 * cotação de VENDA do último boletim "Fechamento". Dias sem boletim de
 * fechamento (fim de semana, feriado, dia ainda aberto) não aparecem.
 */
export const PTAX_BASE_URL =
  "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)";

export const PTAX_TIMEOUT_MS = 8_000;

export type ForeignCurrency = Exclude<CurrencyCode, "BRL">;

export type PtaxFetch = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type PtaxClosingRate = {
  /** AAAA-MM-DD (dia do boletim). */
  date: string;
  /** Reais por 1 unidade da moeda (cotacaoVenda). */
  rate: number;
  bulletinAt: Date | null;
};

export class PtaxUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`PTAX_UNAVAILABLE:${reason}`);
  }
}

/** "2026-10-08" -> "10-08-2026" (a Olinda pede MM-DD-AAAA). */
function olindaDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${month}-${day}-${year}`;
}

export function buildPtaxUrl(input: {
  currency: ForeignCurrency;
  from: string;
  to: string;
}): string {
  const quoted = (value: string) => `%27${encodeURIComponent(value)}%27`;

  return (
    `${PTAX_BASE_URL}?@moeda=${quoted(input.currency)}` +
    `&@dataInicial=${quoted(olindaDate(input.from))}` +
    `&@dataFinalCotacao=${quoted(olindaDate(input.to))}` +
    "&$top=10000&$format=json&$select=cotacaoVenda,dataHoraCotacao,tipoBoletim"
  );
}

function isClosingBulletin(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .trim()
      .toLowerCase()
      .startsWith("fechamento")
  );
}

/** Cotação de fechamento de cada dia (último boletim de fechamento do dia). */
export function parsePtaxResponse(payload: unknown): PtaxClosingRate[] {
  const items =
    payload && typeof payload === "object" && "value" in payload
      ? (payload as { value: unknown }).value
      : null;

  if (!Array.isArray(items)) {
    throw new PtaxUnavailableError("invalid_payload");
  }

  const byDate = new Map<string, PtaxClosingRate>();

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (!isClosingBulletin(record.tipoBoletim)) continue;
    const rate = Number(record.cotacaoVenda);
    const stamp =
      typeof record.dataHoraCotacao === "string"
        ? record.dataHoraCotacao.trim()
        : "";
    const date = /^(\d{4}-\d{2}-\d{2})/u.exec(stamp)?.[1];
    if (!date || !Number.isFinite(rate) || rate <= 0) continue;
    // dataHoraCotacao vem no horário de Brasília (UTC-3, sem horário de verão).
    const parsed = Date.parse(`${stamp.replace(" ", "T").slice(0, 23)}-03:00`);
    const bulletinAt = Number.isFinite(parsed) ? new Date(parsed) : null;
    const current = byDate.get(date);

    if (
      !current ||
      (bulletinAt &&
        (!current.bulletinAt ||
          bulletinAt.getTime() >= current.bulletinAt.getTime()))
    ) {
      byDate.set(date, { date, rate, bulletinAt });
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Busca as cotações de um período. Falha vira PtaxUnavailableError. */
export async function fetchPtaxClosingRates(
  fetchImpl: PtaxFetch,
  input: { currency: ForeignCurrency; from: string; to: string },
  timeoutMs = PTAX_TIMEOUT_MS,
): Promise<PtaxClosingRate[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(buildPtaxUrl(input), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new PtaxUnavailableError(`http_${response.status}`);
    }

    return parsePtaxResponse(await response.json());
  } catch (error) {
    if (error instanceof PtaxUnavailableError) throw error;
    throw new PtaxUnavailableError(
      controller.signal.aborted ? "timeout" : "network",
    );
  } finally {
    clearTimeout(timer);
  }
}
