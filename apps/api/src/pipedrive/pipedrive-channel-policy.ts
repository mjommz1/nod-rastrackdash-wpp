import {
  pipedriveChannelBindingMessages,
  type PipedriveChannelBindingFailure,
} from "@wpptrack/shared";
import {
  authorizedCrmRoute,
  crmBoundChannelIds,
  crmLeadEntryChannelIds,
  inspectCrmBinding,
  type CrmAuthorizedRoute,
  type CrmBindingInspection,
  type CrmRouteIntent,
} from "../crm-channels/crm-channel-policy";

/**
 * Pipedrive is only a CRM: its authorized channels are the workspace's own
 * production WhatsApp numbers of any provider. The policy is shared with Kommo
 * (see crm-channels/crm-channel-policy.ts); these are its Pipedrive names.
 */

/** Ad-attributed publication intent. An official-API number has no WhatsApp
 * instance (null). */
export type PipedriveRouteIntent = CrmRouteIntent;

/** The route row (with channel/Meta includes) of an authorized binding. */
export type PipedriveAuthorizedRoute = CrmAuthorizedRoute;

export type PipedriveBindingInspection = CrmBindingInspection;

export function pipedriveBindingMessage(
  reason: PipedriveChannelBindingFailure,
): string {
  return pipedriveChannelBindingMessages[reason];
}

export const inspectPipedriveBinding = inspectCrmBinding;
export const authorizedPipedriveRoute = authorizedCrmRoute;
export const pipedriveBoundChannelIds = crmBoundChannelIds;
export const pipedriveLeadEntryChannelIds = crmLeadEntryChannelIds;
