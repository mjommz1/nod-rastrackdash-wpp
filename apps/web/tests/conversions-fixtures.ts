import type {
  InboundWebhookChannelDto,
  ProviderConversionRuleCapabilitiesDto,
  ProviderConversionRuleDto,
} from "@wpptrack/shared";
import type {
  ConversionConnection,
  ConversionNumber,
} from "../src/app/(app)/conversions/conversion-rules-view";

/** Shared fake data for the Conversions screen tests (no real data). */
export const at = "2026-10-14T12:00:00.000Z";

export const connections: ConversionConnection[] = [
  { id: "conn_umbler", provider: "umbler", displayName: "Umbler Recepção", status: "production" },
  { id: "conn_qr_a", provider: "uazapi", displayName: "QR Atendimento", status: "production" },
  { id: "conn_qr_b", provider: "uazapi", displayName: "QR Pós-venda", status: "production" },
  { id: "conn_gupshup", provider: "gupshup", displayName: "Gupshup", status: "production" },
];

function number(
  id: string,
  connectionId: string,
  label: string,
  extra: Partial<ConversionNumber> = {},
): ConversionNumber {
  const connection = connections.find((item) => item.id === connectionId)!;
  return {
    id,
    connectionId,
    provider: connection.provider,
    connectionName: connection.displayName,
    label,
    phone: `+55119876500${id.slice(-2)}`,
    whatsappInstanceId: null,
    routeIds: [`route_${id}`],
    status: "active",
    ...extra,
  };
}

export const numbers: ConversionNumber[] = [
  number("ch_01", "conn_umbler", "Recepção"),
  number("ch_02", "conn_qr_a", "Atendimento", { whatsappInstanceId: "inst_a" }),
  number("ch_03", "conn_qr_b", "Pós-venda", { whatsappInstanceId: "inst_b" }),
  number("ch_05", "conn_gupshup", "Gupshup SP"),
];

/** Mesma matriz de GET /conversion-rules/providers/capabilities desta edição. */
export const capabilities: ProviderConversionRuleCapabilitiesDto = {
  workspaceScopeEnabled: true,
  globalPrecedence: "specific_rule_replaces_global_on_number",
  origins: [
    {
      origin: "message_phrase",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: ["umbler", "uazapi"],
      authorChannelProviders: { team: ["umbler", "uazapi"], contact: ["umbler"] },
      connectionBound: false,
      labelMatch: null,
      unifiable: true,
    },
    {
      origin: "structured_catalog",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: ["umbler", "uazapi"],
      authorChannelProviders: null,
      connectionBound: false,
      labelMatch: null,
      unifiable: true,
    },
    {
      origin: "whatsapp_label",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: ["uazapi"],
      authorChannelProviders: null,
      connectionBound: false,
      labelMatch: "name_across_instances",
      unifiable: true,
    },
    {
      origin: "automation_umbler",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: ["umbler"],
      authorChannelProviders: null,
      connectionBound: true,
      labelMatch: null,
      unifiable: false,
    },
  ],
  unsupportedWhatsappProviders: ["waha", "zapi", "nod_api"],
};

/** Capacidades com a venda da Payt (qualquer número de WhatsApp; carrinho em beta). */
export const capabilitiesWithPayt: ProviderConversionRuleCapabilitiesDto = {
  ...capabilities,
  origins: [
    ...capabilities.origins,
    {
      origin: "automation_payt",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: ["umbler", "gupshup", "uazapi", "meta_cloud", "data_crazy"],
      authorChannelProviders: null,
      connectionBound: false,
      labelMatch: null,
      unifiable: false,
      eventNames: ["Purchase", "InitiateCheckout", "CartAbandoned"],
      betaEventNames: ["CartAbandoned"],
    },
  ],
};

export function channelDto(
  numberView: ConversionNumber,
): InboundWebhookChannelDto {
  return {
    id: numberView.id,
    connectionId: numberView.connectionId,
    organizationId: "org_1",
    providerChannelId: `pc_${numberView.id}`,
    connectedPhone: numberView.phone,
    channelName: numberView.label,
    whatsappInstanceId: numberView.whatsappInstanceId,
    status: "active",
    productionActivatedAt: at,
    firstSeenAt: at,
    lastSeenAt: at,
    routes: numberView.routeIds.map((id) => ({
      id,
      channelId: numberView.id,
      metaBusinessConnectionId: null,
      metaReportingAccountId: null,
      metaConversionDestinationId: null,
      active: true,
      validationStatus: "valid",
      validationErrorCode: null,
      lastValidatedAt: at,
      createdAt: at,
      updatedAt: at,
    })),
    readiness: {
      state: "complete",
      blockers: [],
      routeCount: 1,
      validRouteCount: 1,
      routingSource: "inherit_workspace",
      effectiveRouteEligible: true,
      totalCtwa: 0,
      routedCtwa: 0,
      unresolvedCtwa: 0,
      adUnavailableCtwa: 0,
      retainedCtwa: 0,
      retainedRoutedCtwa: 0,
      payloadUnavailableCtwa: 0,
      alreadyMaterializedCtwa: 0,
      nextPayloadExpiresAt: null,
    },
    createdAt: at,
    updatedAt: at,
  } as InboundWebhookChannelDto;
}

type RuleInput = {
  id: string;
  name?: string;
  triggerType?: "message_phrase" | "structured_catalog" | "provider_automation";
  origin?: ProviderConversionRuleDto["origin"];
  eventName?: ProviderConversionRuleDto["conversionRule"]["eventName"];
  connectionId?: string | null;
  scope?: "all_numbers" | "specific_numbers";
  channelIds?: string[];
  effective?: string[];
  overridden?: string[];
  duplicatePhone?: string[];
  mode?: "observation" | "production";
  active?: boolean;
  unifiedIntoRuleId?: string | null;
  phrases?: string[];
  automationSource?: "payt" | null;
  lastExecution?: ProviderConversionRuleDto["lastExecution"];
};

export function providerRule(input: RuleInput): ProviderConversionRuleDto {
  const scope = input.scope ?? "specific_numbers";
  return {
    id: input.id,
    workspaceId: "workspace_1",
    conversionRule: {
      id: `cr_${input.id}`,
      workspaceId: "workspace_1",
      name: input.name ?? input.id,
      triggerType: input.triggerType ?? "message_phrase",
      triggerValue: "x",
      matchMode: "exact",
      eventName: input.eventName ?? "QualifiedLead",
      pixelId: null,
      defaultValueCents: null,
      defaultCurrency: null,
      defaultContentName: null,
      defaultItems: null,
      active: input.active ?? true,
      createdAt: at,
      updatedAt: at,
    },
    connectionId: input.connectionId ?? null,
    mode: input.mode ?? "observation",
    parserReleaseId: null,
    productionActivatedAt: null,
    scope,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    channelIds: input.channelIds ?? [],
    effectiveChannelIds: input.effective ?? input.channelIds ?? [],
    overriddenChannelIds: input.overridden ?? [],
    duplicatePhoneChannelIds: input.duplicatePhone ?? [],
    globalPrecedence: "specific_rule_replaces_global_on_number",
    unifiedIntoRuleId: input.unifiedIntoRuleId ?? null,
    triggerPhrases: input.phrases ?? ["vou te passar os valores"],
    messageAuthorScope: "team",
    valueMode: "fixed",
    exampleMessage: null,
    ...(input.automationSource === undefined
      ? {}
      : { automationSource: input.automationSource }),
    endpoint: null,
    catalog: null,
    lastExecution: input.lastExecution ?? null,
    createdAt: at,
    updatedAt: at,
  };
}
