"use client";

import type { InboundWebhookChannelDto } from "@wpptrack/shared";
import {
  createKommoConnectionAction,
  createKommoRuleAction,
  deleteKommoRuleAction,
  getKommoConnectionAction,
  listKommoConnectionsAction,
  listKommoEventsAction,
  refreshKommoCatalogAction,
  replaceKommoCredentialAction,
  rotateKommoWebhookTokenAction,
  setKommoChannelBindingsAction,
  setKommoConnectionStatusAction,
  updateKommoRuleAction,
} from "../integrations/kommo-actions";
import type { KommoConnectionDetailDto } from "../integrations/kommo-actions";
import {
  KommoConversionPanel,
  type KommoConnectionsLoadState,
  type KommoConversionPanelProps,
  type KommoUnsettledOperations,
} from "./kommo-conversion-panel";

export const KOMMO_MANAGER_ANCHOR_ID = "crm-configurado";

// Survives unmount/remount inside one browser session (close/reopen, client
// navigation, router.refresh). A full reload clears it on purpose: only a
// reload re-reads the world after an unknown outcome.
const unsettledByScope = new Map<string, KommoUnsettledOperations>();

function unsettledFor(scope: string): KommoUnsettledOperations {
  let entry = unsettledByScope.get(scope);
  if (!entry) {
    entry = { creation: false, connectionIds: new Set<string>() };
    unsettledByScope.set(scope, entry);
  }
  return entry;
}

export type KommoCrmManagerActions = Pick<
  KommoConversionPanelProps,
  | "createConnectionAction"
  | "replaceCredentialAction"
  | "setStatusAction"
  | "setChannelBindingsAction"
  | "rotateWebhookAction"
  | "refreshCatalogAction"
  | "listConnectionsAction"
  | "getConnectionAction"
  | "createRuleAction"
  | "updateRuleAction"
  | "deleteRuleAction"
  | "listEventsAction"
>;

const defaultActions: KommoCrmManagerActions = {
  createConnectionAction: createKommoConnectionAction,
  replaceCredentialAction: replaceKommoCredentialAction,
  setStatusAction: setKommoConnectionStatusAction,
  setChannelBindingsAction: setKommoChannelBindingsAction,
  rotateWebhookAction: rotateKommoWebhookTokenAction,
  refreshCatalogAction: refreshKommoCatalogAction,
  listConnectionsAction: listKommoConnectionsAction,
  getConnectionAction: getKommoConnectionAction,
  createRuleAction: createKommoRuleAction,
  updateRuleAction: updateKommoRuleAction,
  deleteRuleAction: deleteKommoRuleAction,
  listEventsAction: listKommoEventsAction,
};

export type KommoCrmManagerProps = {
  workspaceId: string;
  /** Authenticated account id; a different account never inherits secrets or locks. */
  viewerId: string;
  connections: KommoConnectionDetailDto[];
  loadState: KommoConnectionsLoadState;
  allChannels: InboundWebhookChannelDto[];
  canManage: boolean;
  licenseLocked: boolean;
  actions?: KommoCrmManagerActions;
};

/**
 * Single mount point of the Kommo CRM trigger, rendered once inside the
 * Integrations hub Kommo modal (the modal stays mounted while closed, so
 * unsettled operations and the visible webhook URL survive close/reopen).
 */
export function KommoCrmManager({
  workspaceId,
  viewerId,
  connections,
  loadState,
  allChannels,
  canManage,
  licenseLocked,
  actions = defaultActions,
}: KommoCrmManagerProps) {
  const scope = JSON.stringify([workspaceId, viewerId]);

  return (
    <section
      id={KOMMO_MANAGER_ANCHOR_ID}
      className="kommo-crm-manager"
      data-testid="kommo-crm-manager"
    >
      <div className="trigger-source-body">
        <KommoConversionPanel
          key={scope}
          unsettledOperations={unsettledFor(scope)}
          workspaceId={workspaceId}
          connections={connections}
          loadState={loadState}
          allChannels={allChannels}
          canManage={canManage}
          licenseLocked={licenseLocked}
          {...actions}
        />
      </div>
    </section>
  );
}
