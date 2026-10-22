// Shared by the overview page and its tests: page modules may only export the
// page itself.

export type OverviewLeadsScope = {
  adAccountId?: string;
  businessId?: string;
};

/**
 * The Leads list that reproduces an overview number, or null when the Leads
 * page cannot. The overview counts leads de anúncio, so the link carries that
 * origin.
 * - The Leads page has no BM/conta filter: with one applied, no link.
 * - "returning" needs a period start (without one nobody came "back") and
 *   "repeat" a period (conversations inside it).
 */
export function overviewLeadsHref(
  scope: OverviewLeadsScope,
  period: { since?: string | null; until?: string | null },
  base: "new" | "returning" | "repeat",
  attribution: "paid" | "organic" = "paid",
): string | null {
  if (scope.businessId || scope.adAccountId) {
    return null;
  }

  const since = period.since ?? undefined;
  const until = period.until ?? undefined;

  if (base !== "new" && !since) {
    return null;
  }

  // Same key order as the Leads page builds its own links.
  const params = new URLSearchParams();

  params.set("attribution", attribution);

  if (since) {
    params.set("since", since);
  }

  if (until) {
    params.set("until", until);
  }

  if (base !== "new") {
    params.set("base", base);
  }

  return `/leads?${params.toString()}`;
}
