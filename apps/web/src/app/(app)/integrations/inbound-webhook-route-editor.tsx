"use client";

import type {
  InboundWebhookChannelDto,
  MetaManualConfigurationDto,
} from "@wpptrack/shared";
import { Plus, Save, Trash2 } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "../../../components/searchable-select";
import type { InboundWebhookActionResult } from "./inbound-webhook-actions";

type SaveRoutesAction = (
  formData: FormData,
) => Promise<InboundWebhookActionResult>;

export type InboundWebhookRouteEditorProps = {
  channel: InboundWebhookChannelDto;
  metaConfiguration: MetaManualConfigurationDto | null;
  canManage: boolean;
  saveAction: SaveRoutesAction;
  onUpdated: (result: InboundWebhookActionResult) => void;
  /**
   * Modo enviado junto das rotas (só Unnichat; para os demais provedores a
   * API recusa o campo).
   */
  routingMode?: "channel_override";
  /**
   * Bloqueia salvar a lista vazia: rotas manuais sem rota quebram o envio;
   * a pessoa deve voltar para “Herdar do workspace”.
   */
  requireRoute?: boolean;
};

export type InboundWebhookRouteDraft = {
  key: string;
  metaBusinessConnectionId: string;
  metaReportingAccountId: string;
  metaConversionDestinationId: string;
};

export function inboundWebhookRouteDrafts(
  channel: InboundWebhookChannelDto,
): InboundWebhookRouteDraft[] {
  return channel.routes.map((route) => ({
    key: route.id,
    metaBusinessConnectionId: route.metaBusinessConnectionId ?? "",
    metaReportingAccountId: route.metaReportingAccountId ?? "",
    metaConversionDestinationId: route.metaConversionDestinationId ?? "",
  }));
}

export function inboundWebhookReportingAccountOptions(
  configuration: MetaManualConfigurationDto | null,
  businessConnectionId: string,
  selectedAccountId = "",
): SearchableSelectOption[] {
  if (!configuration || !businessConnectionId) {
    return [];
  }

  return configuration.reportingAccounts
    .filter(
      (account) =>
        account.businessConnectionId === businessConnectionId &&
        (account.active || account.id === selectedAccountId),
    )
    .map((account) => ({
      value: account.id,
      label: account.adAccountName,
      description: account.adAccountId,
    }));
}

export function InboundWebhookRouteEditor({
  channel,
  metaConfiguration,
  canManage,
  saveAction,
  onUpdated,
  routingMode,
  requireRoute = false,
}: InboundWebhookRouteEditorProps) {
  const draftSequence = useRef(0);
  const [routes, setRoutes] = useState(() =>
    inboundWebhookRouteDrafts(channel),
  );
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setRoutes(inboundWebhookRouteDrafts(channel));
  }, [channel]);

  const selectedBusinessIds = new Set(
    routes.map((route) => route.metaBusinessConnectionId).filter(Boolean),
  );
  const selectedDestinationIds = new Set(
    routes.map((route) => route.metaConversionDestinationId).filter(Boolean),
  );
  const businessOptions: SearchableSelectOption[] =
    metaConfiguration?.businessConnections
      .filter(
        (connection) =>
          connection.status === "active" ||
          selectedBusinessIds.has(connection.id),
      )
      .map((connection) => ({
        value: connection.id,
        label: connection.businessManagerName,
        description: connection.businessManagerId,
      })) ?? [];
  const destinationOptions: SearchableSelectOption[] =
    metaConfiguration?.destinations
      .filter(
        (destination) =>
          Boolean(destination.id) &&
          (destination.status === "configured" ||
            selectedDestinationIds.has(destination.id ?? "")),
      )
      .map((destination) => ({
        value: destination.id ?? "",
        label:
          destination.label ??
          destination.pixelName ??
          destination.pageName ??
          "Destino Meta",
        description: [destination.pixelId, destination.pageId]
          .filter(Boolean)
          .join(" / "),
      })) ?? [];

  function addRoute() {
    draftSequence.current += 1;
    setRoutes((current) => [
      ...current,
      {
        key: `draft-${draftSequence.current}`,
        metaBusinessConnectionId: "",
        metaReportingAccountId: "",
        metaConversionDestinationId: "",
      },
    ]);
  }

  function updateRoute(key: string, patch: Partial<InboundWebhookRouteDraft>) {
    setRoutes((current) =>
      current.map((route) =>
        route.key === key ? { ...route, ...patch } : route,
      ),
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (pending || !canManage) {
      return;
    }

    const validRoutes = routes.filter(
      (route) => route.metaBusinessConnectionId,
    );
    const formData = new FormData();
    formData.set("channelId", channel.id);
    if (routingMode) {
      formData.set("routingMode", routingMode);
    }
    formData.set(
      "routes",
      JSON.stringify(
        validRoutes.map((route) => ({
          metaBusinessConnectionId: route.metaBusinessConnectionId,
          metaReportingAccountId: route.metaReportingAccountId || null,
          metaConversionDestinationId:
            route.metaConversionDestinationId || null,
        })),
      ),
    );

    setPending(true);
    const result = await saveAction(formData);
    setPending(false);
    onUpdated(result);
  }

  return (
    <form
      className="inbound-route-editor"
      onSubmit={handleSubmit}
      aria-readonly={!canManage}
    >
      <div className="inbound-route-toolbar">
        <div>
          <span className="micro-label">Roteamento Meta</span>
          <p className="muted">
            {canManage
              ? "Associe uma ou mais BMs. Conta e destino são opcionais."
              : "Rotas visiveis em modo somente leitura."}
          </p>
        </div>
        {canManage ? (
          <button
            className="button ghost"
            type="button"
            onClick={addRoute}
            disabled={pending || businessOptions.length === 0}
          >
            <Plus size={15} aria-hidden="true" />
            Adicionar rota
          </button>
        ) : (
          <span className="status-chip neutral">Somente leitura</span>
        )}
      </div>

      {canManage && businessOptions.length === 0 ? (
        <p className="action-note warn">
          Configure ao menos uma conexao Meta ativa antes de criar rotas.
        </p>
      ) : null}

      {canManage && requireRoute && routes.length === 0 ? (
        <p className="action-note warn">
          As rotas manuais precisam de ao menos uma rota. Para não usar rotas
          neste número, volte para “Herdar do workspace”.
        </p>
      ) : null}

      <div className="inbound-route-list">
        {routes.map((route, index) => {
          const accountOptions = inboundWebhookReportingAccountOptions(
            metaConfiguration,
            route.metaBusinessConnectionId,
            route.metaReportingAccountId,
          );

          return (
            <div className="inbound-route-row" key={route.key}>
              <span className="inbound-route-index" aria-hidden="true">
                {index + 1}
              </span>
              <SearchableSelect
                name={`business-${route.key}`}
                value={route.metaBusinessConnectionId}
                options={businessOptions}
                onValueChange={(value) =>
                  updateRoute(route.key, {
                    metaBusinessConnectionId: value,
                    metaReportingAccountId: "",
                  })
                }
                ariaLabel={`BM da rota ${index + 1}`}
                placeholder="Escolher BM"
                sensitive
                presentationPlaceholder="BM oculta"
                disabled={pending || !canManage}
              />
              <SearchableSelect
                name={`account-${route.key}`}
                value={route.metaReportingAccountId}
                options={accountOptions}
                onValueChange={(value) =>
                  updateRoute(route.key, {
                    metaReportingAccountId: value,
                  })
                }
                ariaLabel={`Conta da rota ${index + 1}`}
                placeholder="Qualquer conta da BM"
                emptyMessage="Nenhuma conta ativa nesta BM"
                sensitive
                presentationPlaceholder="Conta oculta"
                disabled={
                  pending || !canManage || !route.metaBusinessConnectionId
                }
              />
              <SearchableSelect
                name={`destination-${route.key}`}
                value={route.metaConversionDestinationId}
                options={destinationOptions}
                onValueChange={(value) =>
                  updateRoute(route.key, {
                    metaConversionDestinationId: value,
                  })
                }
                ariaLabel={`Destino da rota ${index + 1}`}
                placeholder="Destino padrao da BM"
                emptyMessage="Nenhum destino configurado"
                sensitive
                presentationPlaceholder="Pixel e Pagina ocultos"
                disabled={
                  pending || !canManage || !route.metaBusinessConnectionId
                }
              />
              {canManage ? (
                <button
                  className="icon-button danger"
                  type="button"
                  title={`Remover rota ${index + 1}`}
                  aria-label={`Remover rota ${index + 1}`}
                  onClick={() =>
                    setRoutes((current) =>
                      current.filter((item) => item.key !== route.key),
                    )
                  }
                  disabled={pending}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {routes.length === 0 && !canManage ? (
        <p className="muted inbound-route-readonly">
          Nenhuma rota Meta configurada para este canal.
        </p>
      ) : null}

      <div className="inbound-route-footer">
        <span className="muted">
          {routes.length === 0
            ? "Sem rota: candidatos CTWA ficam como nao resolvidos."
            : `${routes.length} rota(s) ${canManage ? "preparada(s)" : "configurada(s)"}.`}
        </span>
        {canManage ? (
          <button
            className="button primary"
            type="submit"
            disabled={
              pending ||
              (requireRoute && routes.length === 0) ||
              routes.some((route) => !route.metaBusinessConnectionId)
            }
          >
            <Save size={15} aria-hidden="true" />
            {pending ? "Salvando..." : "Salvar rotas"}
          </button>
        ) : null}
      </div>
    </form>
  );
}
