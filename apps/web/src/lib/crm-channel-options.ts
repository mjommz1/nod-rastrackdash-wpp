import type {
  CrmChannelBindingFailure,
  InboundWebhookChannelDto,
} from "@wpptrack/shared";

/**
 * One authorizable WhatsApp number of the workspace (any provider) for a
 * CRM-only integration (Kommo, Pipedrive). The value is the number's valid
 * route id or, when the number inherits the verified workspace page/pixel,
 * its channel id.
 */
export type CrmChannelOption = {
  routeId: string;
  label: string;
  eligible: boolean;
  statusDetail: string;
  /** Plain-language reason shown when the number cannot be authorized. */
  reason: string | null;
  /** Pre-selected on a new connection (first eligible entry of its number). */
  preselect: boolean;
};

type Messages = Record<CrmChannelBindingFailure, string>;

function numberReason(
  channel: InboundWebhookChannelDto,
  messages: Messages,
): string | null {
  if (
    channel.status === "paused" ||
    channel.readiness.blockers.includes("channel_paused") ||
    channel.readiness.blockers.includes("connection_paused")
  )
    return messages.number_paused;
  if (channel.status !== "active" || !channel.productionActivatedAt)
    return messages.number_not_in_production;
  return null;
}

/** Whether the number may be bound by its channel id: the CRM destination
 * readiness of its provider (Uazapi, Gupshup, Umbler, Data Crazy, Cloud API...). */
export function crmInheritsVerifiedDestination(
  channel: InboundWebhookChannelDto,
): boolean {
  return channel.readiness.crmDestinationReadiness?.status === "verified";
}

export function crmChannelOptionsFor(
  channels: InboundWebhookChannelDto[],
  messages: Messages,
): CrmChannelOption[] {
  return channels.flatMap((channel): CrmChannelOption[] => {
    const label = channel.channelName ?? channel.connectedPhone;
    const blocked = numberReason(channel, messages);
    const validRoutes = channel.routes.filter(
      (route) => route.active && route.validationStatus === "valid",
    );
    const inheritsVerified = crmInheritsVerifiedDestination(channel);
    const unverified = messages.meta_destination_unverified;
    const options: CrmChannelOption[] = channel.routes.map((route) => {
      const valid = route.active && route.validationStatus === "valid";
      const reason = blocked ?? (valid ? null : unverified);
      return {
        routeId: route.id,
        label,
        eligible: reason === null,
        statusDetail: route.active
          ? route.validationStatus
          : `${route.validationStatus}, rota inativa`,
        reason,
        preselect: reason === null && route.id === validRoutes[0]?.id,
      };
    });
    // No valid route: the number may still inherit the verified workspace
    // page/pixel destination, authorized by the number (channel) itself.
    if (!validRoutes.length) {
      const reason = blocked ?? (inheritsVerified ? null : unverified);
      // An inheriting number is listed once, by itself, not by unusable routes.
      if (reason === null) options.length = 0;
      if (reason === null || !options.length)
        options.push({
          routeId: channel.id,
          label,
          eligible: reason === null,
          statusDetail: reason === null ? "destino herdado verificado" : reason,
          reason,
          preselect: reason === null,
        });
    }
    return options;
  });
}
