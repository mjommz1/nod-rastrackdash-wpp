/**
 * Ad account selection <-> URL, shared by Visao Geral and Relatorios (server
 * pages and client filter bars). Same contract as the campaign selection:
 * - 0 selected: no param (all accounts)
 * - 1 selected: `adAccountId=<id>` (every pre-multi link stays identical)
 * - 2+ selected: `adAccountIds=<id>,<id>` in selection order
 *
 * The API accepts both (`adAccountIds` comma separated or repeated, combined
 * with `adAccountId`), so the same params travel to `/reports/*`.
 */

/** Same limit as the API (`reportFiltersSchema.adAccountIds`). */
export const maxAdAccountFilter = 50;

function splitIds(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];

  return values.flatMap((item) =>
    typeof item === "string"
      ? item
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : [],
  );
}

/**
 * Legacy `adAccountId` first, then the `adAccountIds` list; deduped, keeping
 * the first occurrence. Comma lists in either param are accepted, so a form
 * that posts the joined value under `adAccountId` reads the same.
 */
export function parseAdAccountIdsParam(
  adAccountId: unknown,
  adAccountIds?: unknown,
): string[] {
  return [
    ...new Set([...splitIds(adAccountId), ...splitIds(adAccountIds)]),
  ].slice(0, maxAdAccountFilter);
}

export function setAdAccountParams(
  params: URLSearchParams,
  ids: readonly string[],
): URLSearchParams {
  params.delete("adAccountId");
  params.delete("adAccountIds");

  if (ids.length === 1) {
    params.set("adAccountId", ids[0]!);
  } else if (ids.length > 1) {
    params.set("adAccountIds", ids.join(","));
  }

  return params;
}

/** Joined form used by filter state that keeps one string per filter. */
export function joinAdAccountIds(ids: readonly string[]): string {
  return ids.join(",");
}

export function splitAdAccountIds(value: string | null | undefined): string[] {
  return parseAdAccountIdsParam(value ?? "");
}
