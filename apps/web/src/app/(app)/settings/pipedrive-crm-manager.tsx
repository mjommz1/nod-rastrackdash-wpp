"use client";

import type { InboundWebhookChannelDto } from "@wpptrack/shared";
import {
  createPipedriveConnectionAction,
  createPipedriveRuleAction,
  deletePipedriveConnectionAction,
  deletePipedriveRuleAction,
  getPipedriveCapabilitiesAction,
  getPipedriveConnectionAction,
  listPipedriveConnectionsAction,
  listPipedriveEventsAction,
  refreshPipedriveCatalogAction,
  replacePipedriveCredentialAction,
  retryPipedriveEventAction,
  revokePipedriveWebhookSecretAction,
  rotatePipedriveWebhookSecretAction,
  setPipedriveChannelBindingsAction,
  setPipedriveConnectionStatusAction,
  updatePipedriveRuleAction,
} from "../integrations/pipedrive-actions";
import type { PipedriveConnectionDetailDto } from "../integrations/pipedrive-actions";
import {
  PipedriveConversionPanel,
  type PipedriveConnectionsLoadState,
  type PipedriveConversionPanelProps,
} from "./pipedrive-conversion-panel";

export const PIPEDRIVE_MANAGER_ANCHOR_ID = "crm-configurado-pipedrive";

type UnsettledOperations = { creation: boolean; connectionIds: Set<string> };

// Survives unmount/remount inside one browser session (close/reopen, client
// navigation, router.refresh). A full reload clears it on purpose: only a
// reload re-reads the world after an unknown outcome.
const unsettledByScope = new Map<string, UnsettledOperations>();

function unsettledFor(scope: string): UnsettledOperations {
  let entry = unsettledByScope.get(scope);
  if (!entry) {
    entry = { creation: false, connectionIds: new Set<string>() };
    unsettledByScope.set(scope, entry);
  }
  return entry;
}

export type PipedriveCrmManagerActions = Pick<
  PipedriveConversionPanelProps,
  | "createConnectionAction"
  | "replaceCredentialAction"
  | "setStatusAction"
  | "setChannelBindingsAction"
  | "refreshCatalogAction"
  | "deleteConnectionAction"
  | "rotateWebhookAction"
  | "revokeWebhookAction"
  | "listConnectionsAction"
  | "getConnectionAction"
  | "getCapabilitiesAction"
  | "createRuleAction"
  | "updateRuleAction"
  | "deleteRuleAction"
  | "listEventsAction"
  | "retryEventAction"
>;

const defaultActions: PipedriveCrmManagerActions = {
  createConnectionAction: createPipedriveConnectionAction,
  replaceCredentialAction: replacePipedriveCredentialAction,
  setStatusAction: setPipedriveConnectionStatusAction,
  setChannelBindingsAction: setPipedriveChannelBindingsAction,
  refreshCatalogAction: refreshPipedriveCatalogAction,
  deleteConnectionAction: deletePipedriveConnectionAction,
  rotateWebhookAction: rotatePipedriveWebhookSecretAction,
  revokeWebhookAction: revokePipedriveWebhookSecretAction,
  listConnectionsAction: listPipedriveConnectionsAction,
  getConnectionAction: getPipedriveConnectionAction,
  getCapabilitiesAction: getPipedriveCapabilitiesAction,
  createRuleAction: createPipedriveRuleAction,
  updateRuleAction: updatePipedriveRuleAction,
  deleteRuleAction: deletePipedriveRuleAction,
  listEventsAction: listPipedriveEventsAction,
  retryEventAction: retryPipedriveEventAction,
};

export type PipedriveCrmManagerProps = {
  workspaceId: string;
  /** Authenticated account id; a different account never inherits secrets or locks. */
  viewerId: string;
  connections: PipedriveConnectionDetailDto[];
  loadState: PipedriveConnectionsLoadState;
  allChannels: InboundWebhookChannelDto[];
  canManage: boolean;
  licenseLocked: boolean;
  actions?: PipedriveCrmManagerActions;
};

/**
 * Single mount point of the Pipedrive CRM trigger, rendered once inside the
 * Integrations hub Pipedrive modal (the modal stays mounted while closed, so
 * unsettled operations and the visible webhook URL survive close/reopen).
 */
export function PipedriveCrmManager({
  workspaceId,
  viewerId,
  connections,
  loadState,
  allChannels,
  canManage,
  licenseLocked,
  actions = defaultActions,
}: PipedriveCrmManagerProps) {
  const scope = JSON.stringify([workspaceId, viewerId]);

  return (
    <section
      id={PIPEDRIVE_MANAGER_ANCHOR_ID}
      className="pipedrive-crm-manager kommo-crm-manager"
      data-testid="pipedrive-crm-manager"
    >
      <div className="trigger-source-body">
        <PipedriveConversionPanel
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
