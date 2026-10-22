"use client";

import type { CurrencyCode, MetaAssetsDto } from "@wpptrack/shared";
import { Filter, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AdAccountFilter } from "../../../components/ad-account-filter";
import { usePresentationMode } from "../../../components/presentation-mode-toggle";
import { splitAdAccountIds } from "../../../lib/ad-account-params";

type MetaReportFiltersProps = {
  /** Moeda efetiva por conta (correção manual, Meta, BRL). */
  accountCurrencies?: Record<string, CurrencyCode>;
  /** Contas de anúncio juntas por "," (uma ou várias). */
  adAccountId?: string;
  adId?: string;
  adSetId?: string;
  assets: MetaAssetsDto | null;
  businessId?: string;
  campaignId?: string;
  compareSince?: string;
  compareUntil?: string;
  delivery?: "all" | "had_delivery";
  // Set only while the Insights tab is active; the objective travels with it.
  insightObjective?: string;
  metrics?: "overview" | "traffic" | "funnel" | "revenue";
  nameContains?: string;
  nameScope?: string;
  pageSize?: number;
  since?: string;
  selectedIds?: string;
  sort?: { key: string; direction: string };
  status?: string;
  until?: string;
  view?: "campaigns" | "adsets" | "ads";
  whatsappClassification?: string;
  /** Implatec: tipo de campanha. */
  campaignKind?: string;
};

const nameScopeOptions = [
  ["campaign", "Campanha contem"],
  ["adset", "Conjunto contem"],
  ["ad", "Anuncio contem"],
] as const;

const statusOptions = [
  ["all", "Todos os status"],
  ["active", "Ativas"],
  ["paused", "Pausadas"],
] as const;

const deliveryOptions = [
  ["all", "Com ou sem veiculacao"],
  ["had_delivery", "Teve veiculacao no periodo"],
] as const;

/** Implatec: tipo de campanha (WhatsApp x formulario Lead Ads). */
const campaignKindOptions = [
  ["all", "WhatsApp + Formulario"],
  ["whatsapp", "So WhatsApp"],
  ["lead_form", "So Formulario (Lead Ads)"],
] as const;

const classificationOptions = [
  ["whatsapp", "Campanhas WhatsApp"],
  ["needs_review", "Precisa revisar"],
  ["excluded", "Excluidas"],
  ["all", "Todas as campanhas"],
] as const;

type ReportingAccount = NonNullable<MetaAssetsDto["reportingAccounts"]>[number];
type ReportingBusiness = {
  id: string;
  name: string;
};

function accountsForBusiness(
  reportingAccounts: ReportingAccount[],
  businessId: string,
) {
  return businessId
    ? reportingAccounts.filter((account) => account.businessId === businessId)
    : reportingAccounts;
}

function businessesFromReportingAccounts(
  reportingAccounts: ReportingAccount[],
): ReportingBusiness[] {
  const businesses = new Map<string, string>();

  reportingAccounts.forEach((account) => {
    if (!businesses.has(account.businessId)) {
      businesses.set(account.businessId, account.businessName);
    }
  });

  return Array.from(businesses, ([id, name]) => ({ id, name }));
}

export function MetaReportFilters({
  accountCurrencies,
  adAccountId,
  adId,
  adSetId,
  assets,
  businessId,
  campaignId,
  compareSince,
  compareUntil,
  delivery = "all",
  insightObjective,
  metrics = "overview",
  nameContains,
  nameScope = "campaign",
  pageSize = 10,
  since,
  selectedIds,
  sort,
  status = "all",
  until,
  view = "campaigns",
  whatsappClassification = "whatsapp",
  campaignKind = "all",
}: MetaReportFiltersProps) {
  const reportingAccounts = useMemo(
    () => (assets?.reportingAccounts ?? []).filter((account) => account.active),
    [assets?.reportingAccounts],
  );
  const presentationMode = usePresentationMode();
  const businesses = useMemo(
    () => businessesFromReportingAccounts(reportingAccounts),
    [reportingAccounts],
  );
  const [selectedBusinessId, setSelectedBusinessId] = useState(
    businessId ?? "",
  );
  const accounts = useMemo(
    () => accountsForBusiness(reportingAccounts, selectedBusinessId),
    [reportingAccounts, selectedBusinessId],
  );
  const appliedAdAccountIds = useMemo(
    () => splitAdAccountIds(adAccountId),
    [adAccountId],
  );
  const [selectedAdAccountIds, setSelectedAdAccountIds] =
    useState<string[]>(appliedAdAccountIds);

  useEffect(() => {
    setSelectedBusinessId(businessId ?? "");
    setSelectedAdAccountIds(appliedAdAccountIds);
  }, [appliedAdAccountIds, businessId]);

  function handleBusinessChange(nextBusinessId: string) {
    setSelectedBusinessId(nextBusinessId);
    setSelectedAdAccountIds([]);
  }

  const clearParams = new URLSearchParams();

  if (since) {
    clearParams.set("since", since);
  }

  if (until) {
    clearParams.set("until", until);
  }

  clearParams.set("view", view);
  clearParams.set("pageSize", String(pageSize));

  if (metrics !== "overview") {
    clearParams.set("metrics", metrics);
  }

  if (campaignId) {
    clearParams.set("campaignId", campaignId);
  }

  if (adSetId) {
    clearParams.set("adSetId", adSetId);
  }

  if (adId) {
    clearParams.set("adId", adId);
  }

  // Ordering is a table preference, not a filter, so clearing keeps it.
  if (sort) {
    clearParams.set("sort", sort.key);
    clearParams.set("dir", sort.direction);
  }

  // The Insights tab and its objective are views, not filters, so clearing
  // keeps them too.
  if (insightObjective) {
    clearParams.set("mode", "insights");
    clearParams.set("objective", insightObjective);
  }

  const advancedFilterCount = [
    nameScope !== "campaign",
    status !== "all",
    delivery !== "all",
    whatsappClassification !== "whatsapp",
    Boolean(compareSince && compareUntil),
    pageSize !== 10,
  ].filter(Boolean).length;
  const hasFilters = Boolean(
    selectedBusinessId ||
    selectedAdAccountIds.length > 0 ||
    nameContains ||
    status !== "all" ||
    delivery !== "all" ||
    whatsappClassification !== "whatsapp" ||
    compareSince ||
    compareUntil ||
    pageSize !== 10,
  );

  return (
    <form
      className="report-filter-form"
      aria-label="Filtros Meta de relatorios"
      action="/reports"
    >
      <input type="hidden" name="since" value={since ?? ""} />
      <input type="hidden" name="until" value={until ?? ""} />
      <input type="hidden" name="view" value={view} />
      <input type="hidden" name="metrics" value={metrics} />
      <input type="hidden" name="campaignId" value={campaignId ?? ""} />
      <input type="hidden" name="adSetId" value={adSetId ?? ""} />
      <input type="hidden" name="adId" value={adId ?? ""} />
      <input type="hidden" name="selectedIds" value={selectedIds ?? ""} />
      {sort ? (
        <>
          <input type="hidden" name="sort" value={sort.key} />
          <input type="hidden" name="dir" value={sort.direction} />
        </>
      ) : null}
      {insightObjective ? (
        <>
          <input type="hidden" name="mode" value="insights" />
          <input type="hidden" name="objective" value={insightObjective} />
        </>
      ) : null}
      {presentationMode ? (
        <input type="hidden" name="businessId" value={selectedBusinessId} />
      ) : null}
      <div className="report-filter-primary">
        {presentationMode ? (
          <span className="filter-control presentation-filter-placeholder">
            BM oculto
          </span>
        ) : (
          <select
            className="filter-control"
            name="businessId"
            value={selectedBusinessId}
            onChange={(event) =>
              handleBusinessChange(event.currentTarget.value)
            }
            aria-label="Filtrar por Business Manager"
          >
            <option value="">Todos os BMs</option>
            {businesses.map((business) => (
              <option key={business.id} value={business.id}>
                {business.name}
              </option>
            ))}
          </select>
        )}
        <AdAccountFilter
          accounts={accounts}
          appliedValue={appliedAdAccountIds}
          className="report-ad-account-filter"
          currencies={accountCurrencies}
          label="Filtrar por conta de anúncio"
          onChange={setSelectedAdAccountIds}
          presentationMode={presentationMode}
          value={selectedAdAccountIds}
          variant="control"
        />
        <input
          className="filter-control"
          name="nameContains"
          defaultValue={nameContains ?? ""}
          placeholder="Buscar por nome"
          aria-label="Texto contido no nome"
          data-presentation-sensitive-field="true"
        />
        <button className="button" type="submit">
          <Filter aria-hidden="true" size={15} />
          Aplicar filtros
        </button>

        <details
          className="report-advanced-filters"
          open={advancedFilterCount > 0}
        >
          <summary aria-label="Filtros avancados">
            <span>
              <SlidersHorizontal aria-hidden="true" size={15} />
              Avancados
            </span>
            {advancedFilterCount > 0 ? (
              <span className="tag">{advancedFilterCount}</span>
            ) : null}
          </summary>
          <div className="report-filter-advanced-grid">
            <label className="filter-field">
              <span>Buscar em</span>
              <select
                className="filter-control"
                name="nameScope"
                defaultValue={nameScope}
                aria-label="Tipo de filtro por nome"
              >
                {nameScopeOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span>Status</span>
              <select
                className="filter-control"
                name="status"
                defaultValue={status}
                aria-label="Filtrar por status"
              >
                {statusOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span>Veiculacao</span>
              <select
                className="filter-control"
                name="delivery"
                defaultValue={delivery}
                aria-label="Filtrar por veiculacao no periodo"
              >
                {deliveryOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span>Tipo de campanha</span>
              <select
                className="filter-control"
                name="campaignKind"
                defaultValue={campaignKind}
                aria-label="Filtrar por tipo de campanha"
              >
                {campaignKindOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span>Canal</span>
              <select
                className="filter-control"
                name="whatsappClassification"
                defaultValue={whatsappClassification}
                aria-label="Filtrar por classificacao WhatsApp"
              >
                {classificationOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span>Comparar desde</span>
              <input
                className="filter-control"
                type="date"
                name="compareSince"
                defaultValue={compareSince ?? ""}
              />
            </label>
            <label className="filter-field">
              <span>Comparar ate</span>
              <input
                className="filter-control"
                type="date"
                name="compareUntil"
                defaultValue={compareUntil ?? ""}
              />
            </label>
            <label className="filter-field">
              <span>Itens por pagina</span>
              <select
                className="filter-control"
                name="pageSize"
                defaultValue={String(pageSize)}
              >
                <option value="10">10 itens</option>
                <option value="25">25 itens</option>
                <option value="50">50 itens</option>
                <option value="100">100 itens</option>
              </select>
            </label>
          </div>
          <div className="report-filter-footer">
            <span>
              {hasFilters
                ? "O relatorio esta usando filtros personalizados."
                : "Sem filtros adicionais aplicados."}
            </span>
            {hasFilters ? (
              <Link className="button ghost" href={`/reports?${clearParams}`}>
                Limpar filtros
              </Link>
            ) : null}
          </div>
        </details>
      </div>
    </form>
  );
}
