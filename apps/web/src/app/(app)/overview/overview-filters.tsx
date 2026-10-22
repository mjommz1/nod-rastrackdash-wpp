"use client";

import type { CurrencyCode, MetaReportingAccountDto } from "@wpptrack/shared";
import { Filter, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AdAccountFilter } from "../../../components/ad-account-filter";
import { usePresentationMode } from "../../../components/presentation-mode-toggle";

type OverviewFiltersProps = {
  /** Contas de anúncio selecionadas (na URL: `adAccountId` ou `adAccountIds`). */
  adAccountIds?: string[];
  /** Moeda efetiva por conta (correção manual, Meta, BRL). */
  accountCurrencies?: Record<string, CurrencyCode>;
  businessId?: string;
  hasActiveFilter: boolean;
  reportingAccounts: MetaReportingAccountDto[];
  since?: string;
  until?: string;
};

function businessesFromAccounts(accounts: MetaReportingAccountDto[]) {
  const businesses = new Map<string, string>();

  for (const account of accounts) {
    businesses.set(account.businessId, account.businessName);
  }

  return Array.from(businesses, ([id, name]) => ({ id, name }));
}

export function OverviewFilters({
  accountCurrencies,
  adAccountIds,
  businessId,
  hasActiveFilter,
  reportingAccounts,
  since,
  until,
}: OverviewFiltersProps) {
  const businesses = useMemo(
    () => businessesFromAccounts(reportingAccounts),
    [reportingAccounts],
  );
  const presentationMode = usePresentationMode();
  const [selectedBusinessId, setSelectedBusinessId] = useState(
    businessId ?? "",
  );
  const appliedAdAccountIds = useMemo(() => adAccountIds ?? [], [adAccountIds]);
  const appliedKey = appliedAdAccountIds.join(",");
  const [selectedAdAccountIds, setSelectedAdAccountIds] =
    useState<string[]>(appliedAdAccountIds);
  const accounts = useMemo(
    () =>
      selectedBusinessId
        ? reportingAccounts.filter(
            (account) => account.businessId === selectedBusinessId,
          )
        : reportingAccounts,
    [reportingAccounts, selectedBusinessId],
  );

  useEffect(() => {
    setSelectedBusinessId(businessId ?? "");
    setSelectedAdAccountIds(appliedKey ? appliedKey.split(",") : []);
  }, [appliedKey, businessId]);

  function handleBusinessChange(nextBusinessId: string) {
    setSelectedBusinessId(nextBusinessId);
    setSelectedAdAccountIds([]);
  }

  const showBusinessFilter = businesses.length > 1;
  const showAccountFilter = reportingAccounts.length > 1;

  return (
    <form
      action="/overview"
      className="overview-filter-bar"
      aria-label="Filtros da visao geral"
    >
      <div className="overview-filter-heading">
        <span className="micro-label">Recorte da analise</span>
        <strong>Periodo e contas</strong>
      </div>

      <label className="filter-field">
        <span>Inicio</span>
        <input type="date" name="since" defaultValue={since} />
      </label>
      <label className="filter-field">
        <span>Fim</span>
        <input type="date" name="until" defaultValue={until} />
      </label>

      {showBusinessFilter ? (
        <label className="filter-field overview-scope-filter">
          <span>Business Manager</span>
          {presentationMode ? (
            <>
              <input
                type="hidden"
                name="businessId"
                value={selectedBusinessId}
              />
              <span className="presentation-filter-placeholder">BM oculto</span>
            </>
          ) : (
            <select
              name="businessId"
              value={selectedBusinessId}
              onChange={(event) =>
                handleBusinessChange(event.currentTarget.value)
              }
            >
              <option value="">Todos os BMs</option>
              {businesses.map((business) => (
                <option key={business.id} value={business.id}>
                  {business.name}
                </option>
              ))}
            </select>
          )}
        </label>
      ) : null}

      {showAccountFilter ? (
        <AdAccountFilter
          accounts={accounts}
          appliedValue={appliedAdAccountIds}
          className="overview-ad-account-filter"
          currencies={accountCurrencies}
          label="Conta de anúncio"
          onChange={setSelectedAdAccountIds}
          presentationMode={presentationMode}
          value={selectedAdAccountIds}
        />
      ) : null}

      <div className="overview-filter-actions">
        <button className="button primary" type="submit">
          <Filter size={15} aria-hidden="true" />
          Aplicar
        </button>
        {hasActiveFilter ? (
          <Link
            className="button ghost icon-button"
            href="/overview"
            aria-label="Limpar filtros"
            title="Limpar filtros"
          >
            <RotateCcw size={15} aria-hidden="true" />
          </Link>
        ) : null}
      </div>
    </form>
  );
}
