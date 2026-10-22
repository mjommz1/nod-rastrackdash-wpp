import {
  integrationProvider,
  integrationTabForCategory,
  integrationTabFromQuery,
  isIntegrationProviderId,
  type IntegrationProviderId,
  type IntegrationTabId,
} from "./integration-registry";

export type IntegrationsHubSearchParams = {
  aba?: string;
  /** Provider id whose modal opens on load (`?abrir=kommo`). */
  abrir?: string;
  meta?: string;
  notice?: string;
};

/**
 * Server-side starting point of the hub: `?aba=` picks the tab, and the
 * redirects that come back from a Meta or WhatsApp action reopen the modal
 * where that action happened so its result is in view. `?abrir=<provider>`
 * opens that provider's modal from the server render, so links from other
 * pages (Settings -> Kommo) do not depend on the URL hash being applied
 * after a client-side navigation.
 */
export function integrationsHubInitialState(
  searchParams: IntegrationsHubSearchParams,
): { tab: IntegrationTabId; provider: IntegrationProviderId | null } {
  const notice = searchParams.notice ?? "";

  if (searchParams.meta === "connected" || searchParams.meta === "error") {
    return { tab: "ads", provider: "meta" };
  }

  if (notice.startsWith("meta-")) {
    return { tab: "ads", provider: "meta" };
  }

  const open = (searchParams.abrir ?? "").trim().toLowerCase();

  if (isIntegrationProviderId(open)) {
    return {
      tab: integrationTabForCategory(integrationProvider(open).category),
      provider: open,
    };
  }

  return {
    tab: integrationTabFromQuery(searchParams.aba) ?? "whatsapp",
    provider: null,
  };
}
