// @vitest-environment jsdom

import type {
  LegacyConversionRuleDto,
  ProviderConversionAutomationAuditDto,
  ProviderConversionRuleDto,
} from "@wpptrack/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { setupUser } from "./user-shim";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProviderRuleRows } from "../src/app/(app)/conversions/conversion-rules-view";
import {
  ConversionsScreen,
  type ConversionsScreenProps,
} from "../src/app/(app)/conversions/conversions-screen";
import {
  reprocessConfirmText,
  reprocessSummary,
} from "../src/app/(app)/conversions/received-events";
import {
  buildRuleUpdatePayload,
  ruleEditCapabilities,
  ruleEditDraft,
} from "../src/app/(app)/conversions/rule-edit";
import { deleteConfirmText, ruleManageTabs } from "../src/app/(app)/conversions/rule-manage";
import { WorkspaceCurrencyProvider } from "../src/components/workspace-currency";
import { at, capabilities, connections, numbers, providerRule } from "./conversions-fixtures";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.style.overflow = "";
});

const context = { numbers, connections, capabilities };

function withValue(
  rule: ProviderConversionRuleDto,
  valueCents: number | null,
): ProviderConversionRuleDto {
  return {
    ...rule,
    conversionRule: {
      ...rule.conversionRule,
      defaultValueCents: valueCents,
      defaultCurrency: valueCents ? "BRL" : null,
    },
  };
}

const messageRule = providerRule({
  id: "rule_msg",
  name: "Orçamento enviado",
  origin: "message_phrase",
  channelIds: ["ch_01"],
  phrases: ["vou te passar os valores", "segue o orçamento"],
});

const umblerEndpoint = {
  id: "endpoint_1",
  workspaceId: "workspace_1",
  providerRuleId: "rule_umbler",
  secretVersion: 1,
  lastDeliveryAt: at,
  lastSuccessfulParseAt: at,
  rotatedAt: null,
  removedAt: null,
  createdAt: at,
  updatedAt: at,
};

const umblerRule: ProviderConversionRuleDto = {
  ...providerRule({
    id: "rule_umbler",
    name: "Automação Umbler",
    origin: "automation_umbler",
    triggerType: "provider_automation",
    eventName: "QualifiedLead",
    connectionId: "conn_umbler",
    channelIds: ["ch_01"],
    phrases: [],
  }),
  endpoint: umblerEndpoint,
};

const catalogRule: ProviderConversionRuleDto = {
  ...providerRule({
    id: "rule_catalog",
    name: "Pedido de camas",
    origin: "structured_catalog",
    triggerType: "structured_catalog",
    eventName: "Purchase",
    channelIds: ["ch_01"],
    phrases: ["Resumo do pedido"],
  }),
  catalog: {
    id: "catalog_1",
    name: "Camas",
    productName: "Cama elástica",
    currency: "BRL",
    active: true,
    attributes: [{ id: "attr_1", key: "tamanho", label: "Tamanho", position: 1 }],
    variants: [
      {
        id: "variant_1",
        attributeValues: ["Pequena"],
        aliases: [["P"]],
        valueCents: 39900,
        contentName: null,
        normalizedKey: "pequena",
        active: true,
      },
    ],
  },
};

describe("rule edit payload", () => {
  it("sends only what changed: a rename never touches numbers or phrases", () => {
    const draft = { ...ruleEditDraft(messageRule, "message_phrase"), name: "Orçamento (novo)" };

    expect(buildRuleUpdatePayload(messageRule, draft, context)).toEqual({
      ok: true,
      value: { name: "Orçamento (novo)" },
    });
  });

  it("returns an empty patch when nothing changed", () => {
    const draft = ruleEditDraft(messageRule, "message_phrase");
    expect(buildRuleUpdatePayload(messageRule, draft, context)).toEqual({ ok: true, value: {} });
  });

  it("edits phrases, author, example and numbers of a message rule", () => {
    const draft = {
      ...ruleEditDraft(messageRule, "message_phrase"),
      variationPhrases: "segue o orçamento\nvalor da consulta",
      messageAuthorScope: "both" as const,
      exampleMessage: "Segue o orçamento",
      channelIds: ["ch_01", "ch_02"],
    };

    expect(buildRuleUpdatePayload(messageRule, draft, context)).toEqual({
      ok: true,
      value: {
        channelIds: ["ch_01", "ch_02"],
        triggerPhrases: ["vou te passar os valores", "segue o orçamento", "valor da consulta"],
        messageAuthorScope: "both",
        exampleMessage: "Segue o orçamento",
      },
    });
  });

  it("moves a rule to every number, and back to chosen numbers", () => {
    const toAll = { ...ruleEditDraft(messageRule, "message_phrase"), scope: "all_numbers" as const };
    expect(buildRuleUpdatePayload(messageRule, toAll, context)).toEqual({
      ok: true,
      value: { scope: "all_numbers" },
    });

    const globalRule = providerRule({
      id: "rule_global",
      origin: "message_phrase",
      scope: "all_numbers",
    });
    const toSpecific = {
      ...ruleEditDraft(globalRule, "message_phrase"),
      scope: "specific_numbers" as const,
      channelIds: ["ch_02"],
    };
    expect(buildRuleUpdatePayload(globalRule, toSpecific, context)).toEqual({
      ok: true,
      value: { scope: "specific_numbers", channelIds: ["ch_02"] },
    });
  });

  it("edits the value of a valued rule and refuses to drop a fixed value", () => {
    const rule = withValue(
      providerRule({
        id: "rule_buy",
        origin: "message_phrase",
        eventName: "Purchase",
        channelIds: ["ch_01"],
      }),
      25000,
    );
    const changed = { ...ruleEditDraft(rule, "message_phrase"), averageValue: "1.397,00" };
    expect(buildRuleUpdatePayload(rule, changed, context)).toEqual({
      ok: true,
      value: { defaultValueCents: 139700 },
    });

    const cleared = { ...ruleEditDraft(rule, "message_phrase"), averageValue: "" };
    expect(buildRuleUpdatePayload(rule, cleared, context)).toMatchObject({ ok: false });

    const extracted = {
      ...ruleEditDraft(rule, "message_phrase"),
      valueMode: "message_extracted" as const,
      averageValue: "",
    };
    expect(buildRuleUpdatePayload(rule, extracted, context)).toEqual({
      ok: true,
      value: { valueMode: "message_extracted", defaultValueCents: null },
    });
  });

  it("edits labels by name only on rules without a connection (they match by name)", () => {
    const rule = providerRule({
      id: "rule_label",
      origin: "whatsapp_label",
      triggerType: "provider_automation",
      connectionId: null,
      channelIds: ["ch_02", "ch_03"],
      phrases: ["Venda fechada"],
    });
    // Current labels come pre-filled, one entry each.
    expect(ruleEditDraft(rule, "whatsapp_label").labels).toEqual(["Venda fechada"]);
    const draft = {
      ...ruleEditDraft(rule, "whatsapp_label"),
      labels: ["Venda fechada", " Pagou ", ""],
    };

    expect(buildRuleUpdatePayload(rule, draft, context)).toEqual({
      ok: true,
      value: {
        triggerLabels: [
          { id: "Venda fechada", name: "Venda fechada" },
          { id: "Pagou", name: "Pagou" },
        ],
      },
    });
  });

  it("never edits labels of a connection-bound rule (matched by label id)", () => {
    const rule = providerRule({
      id: "rule_label_bound",
      name: "Etiqueta venda",
      origin: "whatsapp_label",
      triggerType: "provider_automation",
      connectionId: "conn_qr_a",
      channelIds: ["ch_02"],
      phrases: ["Venda fechada"],
    });
    expect(ruleEditCapabilities(rule, "whatsapp_label")).toMatchObject({
      labels: false,
      labelsReadOnly: true,
    });
    const draft = {
      ...ruleEditDraft(rule, "whatsapp_label"),
      name: "Etiqueta venda (QR)",
      labels: ["Outra etiqueta"],
    };
    expect(buildRuleUpdatePayload(rule, draft, context)).toEqual({
      ok: true,
      value: { name: "Etiqueta venda (QR)" },
    });
  });

  it("keeps catalog options and prices and only updates the spellings", () => {
    const draft = {
      ...ruleEditDraft(catalogRule, "structured_catalog"),
      aliases: { variant_1: ["P, pequeno"] },
    };

    const result = buildRuleUpdatePayload(catalogRule, draft, context);
    expect(result).toEqual({
      ok: true,
      value: {
        catalog: {
          name: "Camas",
          productName: "Cama elástica",
          currency: "BRL",
          attributes: [{ key: "tamanho", label: "Tamanho" }],
          variants: [
            {
              attributeValues: ["Pequena"],
              aliases: [["P", "pequeno"]],
              valueCents: 39900,
              contentName: null,
            },
          ],
        },
      },
    });
  });

  it("offers address, received events and catalog test only where they exist", () => {
    expect(ruleManageTabs("message_phrase", messageRule).map((tab) => tab.id)).toEqual(["edit"]);
    expect(ruleManageTabs("automation_umbler", umblerRule).map((tab) => tab.id)).toEqual([
      "edit",
      "endpoint",
      "received",
    ]);
    // Received events (data and reprocess) only for integration managers.
    expect(ruleManageTabs("automation_umbler", umblerRule, false).map((tab) => tab.id)).toEqual([
      "edit",
      "endpoint",
    ]);
    expect(ruleManageTabs("structured_catalog", catalogRule).map((tab) => tab.id)).toEqual([
      "edit",
      "catalog-test",
    ]);
  });

  it("explains reprocess and delete in plain words", () => {
    expect(reprocessConfirmText(2, "observation")).toContain("nada é enviado à Meta");
    expect(reprocessConfirmText(1, "production")).toContain("lead vindo de anúncio");
    expect(
      reprocessSummary({
        providerRuleId: "rule_umbler",
        requested: 3,
        queued: 2,
        blocked: 1,
        skipped: 0,
        items: [],
      }),
    ).toBe("2 encaminhados para envio, 1 continua bloqueado.");
    expect(deleteConfirmText("automation_umbler")).toContain("endereço dela deixa de funcionar");
    for (const text of [deleteConfirmText("message_phrase"), reprocessConfirmText(1, "observation")]) {
      expect(text).not.toMatch(/callback|payload|webhook/iu);
    }
  });
});

const audit: ProviderConversionAutomationAuditDto = {
  providerRuleId: "rule_umbler",
  summary: {
    total: 3,
    observed: 0,
    blocked: 2,
    queued: 0,
    materialized: 1,
    failed: 0,
    invalid: 0,
    recoverable: 2,
  },
  items: [
    {
      deliveryId: "delivery_1",
      executionId: null,
      receivedAt: "2026-10-14T13:00:00.000Z",
      lastReceivedAt: "2026-10-14T13:00:00.000Z",
      providerEventType: "sale_approved",
      eventName: "Purchase",
      automation: null,
      status: "blocked",
      reasonCode: "provider_conversion_paid_lead_missing",
      attemptCount: 1,
      executionAttemptCount: 0,
      channel: { id: "ch_01", name: "Recepção", connectedPhone: "+5511987650001" },
      leadResolved: false,
      payloadAvailable: true,
      payloadExpiresAt: "2026-10-20T13:00:00.000Z",
      reprocessable: true,
    },
    {
      deliveryId: "delivery_2",
      executionId: null,
      receivedAt: "2026-10-14T12:30:00.000Z",
      lastReceivedAt: "2026-10-14T12:30:00.000Z",
      providerEventType: "sale_approved",
      eventName: "Purchase",
      automation: null,
      status: "blocked",
      reasonCode: "provider_conversion_paid_lead_missing",
      attemptCount: 2,
      executionAttemptCount: 0,
      channel: null,
      leadResolved: false,
      payloadAvailable: false,
      payloadExpiresAt: "2026-10-20T12:30:00.000Z",
      reprocessable: true,
    },
    {
      deliveryId: "delivery_3",
      executionId: "execution_3",
      receivedAt: "2026-10-14T12:00:00.000Z",
      lastReceivedAt: "2026-10-14T12:00:00.000Z",
      providerEventType: "sale_approved",
      eventName: "Purchase",
      automation: null,
      status: "materialized",
      reasonCode: null,
      attemptCount: 1,
      executionAttemptCount: 1,
      channel: { id: "ch_01", name: "Recepção", connectedPhone: "+5511987650001" },
      leadResolved: true,
      payloadAvailable: true,
      payloadExpiresAt: "2026-10-20T12:00:00.000Z",
      reprocessable: false,
    },
  ],
};

const legacyRule: LegacyConversionRuleDto = {
  kind: "legacy",
  adaptable: true,
  adaptBlockedReason: null,
  id: "legacy_1",
  workspaceId: "workspace_1",
  name: "Compra por aviso",
  triggerType: "keyword",
  triggerValue: "AVISO DE COMPRA",
  matchMode: "exact",
  eventName: "Purchase",
  pixelId: null,
  defaultValueCents: 9990,
  defaultCurrency: "BRL",
  defaultContentName: "Pedido médio",
  defaultItems: null,
  active: true,
  createdAt: at,
  updatedAt: at,
};

function ok(message = "ok") {
  return vi.fn(async (_formData: FormData) => ({ ok: true, message }));
}

function screenProps(overrides: Partial<ConversionsScreenProps> = {}): ConversionsScreenProps {
  const providerRules = overrides.providerRules ?? [messageRule, umblerRule, catalogRule];
  return {
    rows: buildProviderRuleRows(providerRules, numbers, connections, capabilities),
    numbers,
    connections,
    offeredOrigins: ["message_phrase"],
    capabilities,
    unifyGroups: [],
    canManage: true,
    rulesState: "real",
    numbersPartial: false,
    crmVisible: true,
    crmError: false,
    createAction: vi.fn(),
    confirmCreateAction: vi.fn(),
    unifyAction: vi.fn(),
    updateRuleAction: ok("Regra atualizada."),
    loadExecutionsAction: vi.fn(async () => ({ ok: false, message: "x" })),
    providerRules,
    legacyRules: [],
    legacyRulesState: "real",
    ruleActions: {
      remove: ok("Regra removida."),
      rotateEndpoint: vi.fn(async (_formData: FormData) => ({
        ok: true,
        message: "URL rotacionada.",
        oneTimeSecret: {
          ruleId: "rule_umbler",
          webhookUrl: "https://api.example.test/webhooks/umbler/endpoint_1?token=novo-token",
        },
      })),
      loadReceivedEvents: vi.fn(async (_formData: FormData) => ({
        ok: true,
        message: "ok",
        automationAudit: audit,
      })),
      loadReceivedPayload: vi.fn(async (_formData: FormData) => ({
        ok: true,
        message: "ok",
        automationPayload: {
          providerRuleId: "rule_umbler",
          deliveryId: "delivery_1",
          receivedAt: "2026-10-14T13:00:00.000Z",
          payloadExpiresAt: "2026-10-20T13:00:00.000Z",
          payload: { transaction_id: "tx_fake_1", status: "approved" },
        },
      })),
      reprocessReceivedEvents: vi.fn(async (_formData: FormData) => ({
        ok: true,
        message: "ok",
        automationReprocess: {
          providerRuleId: "rule_umbler",
          requested: 2,
          queued: 2,
          blocked: 0,
          skipped: 0,
          items: [],
        },
      })),
      testCatalogMessage: vi.fn(),
    },
    legacyActions: {
      update: vi.fn(async (_formData: FormData) => ({ ok: true, message: "Regra antiga pausada." })),
      adapt: ok("Regra conectada aos números, em observação."),
    },
    ...overrides,
  };
}

function formOf(action: unknown, call = 0): FormData {
  return (action as ReturnType<typeof vi.fn>).mock.calls[call]![0] as FormData;
}

describe("Gerenciar regra", () => {
  it("edits a rule and sends only the changed fields", async () => {
    const user = setupUser();
    const props = screenProps();
    render(createElement(ConversionsScreen, props));

    await user.click(screen.getByRole("button", { name: "Gerenciar Orçamento enviado" }));
    const dialog = screen.getByRole("dialog", { name: "Gerenciar “Orçamento enviado”" });
    const nameInput = within(dialog).getByLabelText("Nome da regra");
    await user.clear(nameInput);
    await user.type(nameInput, "Orçamento enviado (equipe)");
    await user.selectOptions(within(dialog).getByLabelText("Quem pode enviar"), "both");
    await user.click(within(dialog).getByRole("button", { name: "Salvar alterações" }));

    await waitFor(() => expect(props.updateRuleAction).toHaveBeenCalledTimes(1));
    const formData = formOf(props.updateRuleAction);
    expect(formData.get("ruleId")).toBe("rule_msg");
    expect(JSON.parse(String(formData.get("payload")))).toEqual({
      name: "Orçamento enviado (equipe)",
      messageAuthorScope: "both",
    });
    expect(await screen.findByText("Alterações salvas em “Orçamento enviado (equipe)”.")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /Gerenciar/ })).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("does not send anything when nothing changed", async () => {
    const user = setupUser();
    const props = screenProps();
    render(createElement(ConversionsScreen, props));

    await user.click(screen.getByRole("button", { name: "Gerenciar Orçamento enviado" }));
    await user.click(screen.getByRole("button", { name: "Salvar alterações" }));

    expect(screen.getByText("Nada mudou: não há o que salvar.")).toBeTruthy();
    expect(props.updateRuleAction).not.toHaveBeenCalled();
  });

  it("deletes a rule only after confirming", async () => {
    const user = setupUser();
    const props = screenProps();
    render(createElement(ConversionsScreen, props));

    await user.click(screen.getByRole("button", { name: "Gerenciar Automação Umbler" }));
    await user.click(screen.getByRole("button", { name: "Excluir regra" }));

    const dialog = screen.getByRole("dialog", { name: "Gerenciar “Automação Umbler”" });
    expect(within(dialog).getByText("Excluir “Automação Umbler”?")).toBeTruthy();
    expect(within(dialog).getByText(deleteConfirmText("automation_umbler"))).toBeTruthy();
    expect(props.ruleActions!.remove).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Excluir regra" }));

    await waitFor(() => expect(props.ruleActions!.remove).toHaveBeenCalledTimes(1));
    expect(formOf(props.ruleActions!.remove).get("ruleId")).toBe("rule_umbler");
    expect(
      await screen.findByText("“Automação Umbler” foi excluída. O histórico dela continua salvo."),
    ).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("cancels a delete without calling the API", async () => {
    const user = setupUser();
    const props = screenProps();
    render(createElement(ConversionsScreen, props));

    await user.click(screen.getByRole("button", { name: "Gerenciar Orçamento enviado" }));
    await user.click(screen.getByRole("button", { name: "Excluir regra" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeTruthy();
    expect(props.ruleActions!.remove).not.toHaveBeenCalled();
  });

  it("audits received Umbler events and reprocesses the selected ones", async () => {
    const user = setupUser();
    const props = screenProps();
    render(createElement(ConversionsScreen, props));

    await user.click(screen.getByRole("button", { name: "Ver eventos recebidos de Automação Umbler" }));
    const dialog = screen.getByRole("dialog", { name: "Gerenciar “Automação Umbler”" });
    expect(within(dialog).getByRole("tab", { name: "Eventos recebidos" }).getAttribute("aria-selected")).toBe("true");

    await within(dialog).findByText("Dá para reprocessar", { selector: "dt" });
    expect(formOf(props.ruleActions!.loadReceivedEvents).get("ruleId")).toBe("rule_umbler");
    // Recoverable filter by default: the event that became a conversion is hidden.
    expect(within(dialog).getAllByText("Bloqueado")).toHaveLength(2);
    expect(within(dialog).queryByText("Virou conversão")).toBeNull();

    // See the data received for one of them.
    await user.click(within(dialog).getAllByRole("button", { name: "Ver dados recebidos" })[0]!);
    expect(await within(dialog).findByText(/tx_fake_1/)).toBeTruthy();

    const boxes = within(dialog).getAllByRole("checkbox", { name: /Selecionar evento de/ });
    expect(boxes).toHaveLength(2);
    await user.click(boxes[0]!);
    await user.click(boxes[1]!);
    await user.click(within(dialog).getByRole("button", { name: "Reprocessar 2 selecionados" }));
    expect(within(dialog).getByText(reprocessConfirmText(2, "observation"))).toBeTruthy();
    expect(props.ruleActions!.reprocessReceivedEvents).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Reprocessar" }));

    await waitFor(() => expect(props.ruleActions!.reprocessReceivedEvents).toHaveBeenCalledTimes(1));
    const formData = formOf(props.ruleActions!.reprocessReceivedEvents);
    expect(formData.get("ruleId")).toBe("rule_umbler");
    expect(JSON.parse(String(formData.get("payload")))).toEqual({
      confirmation: "REPROCESSAR_CALLBACKS_SELECIONADOS",
      deliveryIds: ["delivery_1", "delivery_2"],
    });
    expect(
      await within(dialog).findByText("2 encaminhados para envio."),
    ).toBeTruthy();
    // The list is read again after reprocessing.
    await waitFor(() => expect(props.ruleActions!.loadReceivedEvents).toHaveBeenCalledTimes(2));
  });

  it("generates a new automation address after confirming and shows it once", async () => {
    const user = setupUser();
    const props = screenProps();
    render(createElement(ConversionsScreen, props));

    await user.click(screen.getByRole("button", { name: "Gerenciar Automação Umbler" }));
    await user.click(screen.getByRole("tab", { name: "Endereço e configuração" }));
    expect(screen.getByText("Como configurar na Umbler Talk")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Gerar novo endereço" }));
    expect(screen.getByText(/O endereço atual para de funcionar na hora/)).toBeTruthy();
    expect(props.ruleActions!.rotateEndpoint).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Gerar novo endereço" }));

    await waitFor(() => expect(props.ruleActions!.rotateEndpoint).toHaveBeenCalledTimes(1));
    expect(formOf(props.ruleActions!.rotateEndpoint).get("ruleId")).toBe("rule_umbler");
    expect(
      ((await screen.findByLabelText("Novo endereço (exibido uma única vez)")) as HTMLInputElement).value,
    ).toBe("https://api.example.test/webhooks/umbler/endpoint_1?token=novo-token");
  });

  it("never loses a new address before the operator says it was copied", async () => {
    const user = setupUser();
    const props = screenProps();
    const view = render(createElement(ConversionsScreen, props));
    const url = "https://api.example.test/webhooks/umbler/endpoint_1?token=novo-token";
    const shownUrl = () =>
      (screen.queryByLabelText("Novo endereço (exibido uma única vez)") as HTMLInputElement | null)?.value;

    await user.click(screen.getByRole("button", { name: "Gerenciar Automação Umbler" }));
    await user.click(screen.getByRole("tab", { name: "Endereço e configuração" }));
    await user.click(screen.getByRole("button", { name: "Gerar novo endereço" }));
    await user.click(screen.getByRole("button", { name: "Gerar novo endereço" }));
    await waitFor(() => expect(shownUrl()).toBe(url));

    // Switching tabs asks first; going back keeps the address.
    await user.click(screen.getByRole("tab", { name: "Editar" }));
    expect(screen.getByText(/o anterior já parou de funcionar. Copie e cole/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Voltar ao endereço" }));
    expect(shownUrl()).toBe(url);

    // The list refreshes (rule updated): the modal stays and the URL too.
    const refreshed = { ...umblerRule, updatedAt: "2026-10-14T15:00:00.000Z" };
    view.rerender(
      createElement(
        ConversionsScreen,
        { ...props, providerRules: [messageRule, refreshed, catalogRule] },
      ),
    );
    expect(shownUrl()).toBe(url);
    // Even if a refresh no longer lists the rule, the modal does not close.
    view.rerender(
      createElement(ConversionsScreen, {
        ...props,
        rows: buildProviderRuleRows([messageRule], numbers, connections, capabilities),
        providerRules: [messageRule],
      }),
    );
    expect(shownUrl()).toBe(url);

    // Closing (Escape or X) asks first.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Já copiei, fechar" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Voltar e copiar" }));
    expect(shownUrl()).toBe(url);
    await user.click(screen.getByRole("button", { name: "Fechar" }));
    await user.click(screen.getByRole("button", { name: "Já copiei, fechar" }));
    expect(screen.queryByRole("dialog", { name: /Gerenciar/ })).toBeNull();
  });

  it("shows labels of a connection-bound rule read-only and edits them on rules without connection", async () => {
    const user = setupUser();
    const bound = providerRule({
      id: "rule_label_bound",
      name: "Etiqueta QR",
      origin: "whatsapp_label",
      triggerType: "provider_automation",
      connectionId: "conn_qr_a",
      channelIds: ["ch_02"],
      phrases: ["Venda fechada"],
    });
    const global = providerRule({
      id: "rule_label_global",
      name: "Etiqueta todos",
      origin: "whatsapp_label",
      triggerType: "provider_automation",
      scope: "all_numbers",
      phrases: ["Venda fechada", "Pagou"],
    });
    const props = screenProps({ providerRules: [bound, global] });
    render(createElement(ConversionsScreen, props));

    await user.click(screen.getByRole("button", { name: "Gerenciar Etiqueta QR" }));
    expect(screen.getByText(/reconhece as etiquetas pelo código delas/)).toBeTruthy();
    expect(screen.queryByLabelText("Nova etiqueta")).toBeNull();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Gerenciar Etiqueta todos" }));
    expect((screen.getByLabelText("Etiqueta 1") as HTMLInputElement).value).toBe("Venda fechada");
    expect((screen.getByLabelText("Etiqueta 2") as HTMLInputElement).value).toBe("Pagou");
    await user.click(screen.getByRole("button", { name: "Remover etiqueta Pagou" }));
    await user.type(screen.getByLabelText("Nova etiqueta"), "Cliente pagou{Enter}");
    await user.click(screen.getByRole("button", { name: "Salvar alterações" }));

    await waitFor(() => expect(props.updateRuleAction).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(formOf(props.updateRuleAction).get("payload")))).toEqual({
      triggerLabels: [
        { id: "Venda fechada", name: "Venda fechada" },
        { id: "Cliente pagou", name: "Cliente pagou" },
      ],
    });
  });

  it("drops the new address only on “Já copiei”", async () => {
    const user = setupUser();
    render(createElement(ConversionsScreen, screenProps()));

    await user.click(screen.getByRole("button", { name: "Gerenciar Automação Umbler" }));
    await user.click(screen.getByRole("tab", { name: "Endereço e configuração" }));
    await user.click(screen.getByRole("button", { name: "Gerar novo endereço" }));
    await user.click(screen.getByRole("button", { name: "Gerar novo endereço" }));
    await screen.findByLabelText("Novo endereço (exibido uma única vez)");
    await user.click(screen.getByRole("button", { name: "Já copiei" }));

    expect(screen.queryByLabelText("Novo endereço (exibido uma única vez)")).toBeNull();
    // No more guard: tabs and closing work directly.
    await user.click(screen.getByRole("tab", { name: "Editar" }));
    expect(screen.getByRole("button", { name: "Salvar alterações" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /Gerenciar/ })).toBeNull();
  });

  it("offers the catalog test and spellings for catalog rules", async () => {
    const user = setupUser();
    render(createElement(ConversionsScreen, screenProps()));

    await user.click(screen.getByRole("button", { name: "Gerenciar Pedido de camas" }));
    expect(screen.getByLabelText("Outros jeitos de escrever “Pequena”")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Testar pedido" }));
    expect(screen.getByRole("button", { name: /Testar sem enviar/ })).toBeTruthy();
  });

  it("shows details read-only to people who cannot manage", async () => {
    const user = setupUser();
    render(createElement(ConversionsScreen, screenProps({ canManage: false })));

    // Received data and reprocess are for integration managers only.
    expect(
      screen.queryByRole("button", { name: "Ver eventos recebidos de Automação Umbler" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Gerenciar Automação Umbler" }));
    expect(screen.queryByRole("tab", { name: "Eventos recebidos" })).toBeNull();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Gerenciar Orçamento enviado" }));
    expect(screen.getByText("Você pode ver esta regra, mas não alterar.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Excluir regra" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Salvar alterações" })).toBeNull();
  });
});

describe("Regras antigas", () => {
  it("lists old rules with pause, value and connect-to-numbers", async () => {
    const user = setupUser();
    const props = screenProps({ legacyRules: [legacyRule] });
    render(createElement(ConversionsScreen, props));

    const section = screen.getByRole("region", { name: "Regras antigas" });
    expect(within(section).getByText("Compra por aviso")).toBeTruthy();
    expect(within(section).getByText("Pedido médio · R$ 99,90")).toBeTruthy();

    await user.click(within(section).getByRole("button", { name: "Pausar Compra por aviso" }));
    await waitFor(() => expect(props.legacyActions!.update).toHaveBeenCalledTimes(1));
    const formData = formOf(props.legacyActions!.update);
    expect(formData.get("intent")).toBe("status");
    expect(formData.get("active")).toBe("false");
    expect(await within(section).findByText("Regra antiga pausada.")).toBeTruthy();

    await user.click(
      within(section).getByRole("button", { name: "Conectar Compra por aviso aos números" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Conectar regra aos números" });
    // The only number of the first connection comes checked.
    expect(
      (within(dialog).getByRole("checkbox", { name: /Recepção/ }) as HTMLInputElement).checked,
    ).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: /Conectar em observação/ }));

    await waitFor(() => expect(props.legacyActions!.adapt).toHaveBeenCalledTimes(1));
    const adapt = formOf(props.legacyActions!.adapt);
    expect(adapt.get("legacyRuleId")).toBe("legacy_1");
    expect(JSON.parse(String(adapt.get("payload")))).toEqual({
      connectionId: "conn_umbler",
      channelIds: ["ch_01"],
      triggerPhrases: ["AVISO DE COMPRA"],
      messageAuthorScope: "team",
    });
  });

  it("hides the section when there are no old rules", () => {
    render(createElement(ConversionsScreen, screenProps()));
    expect(screen.queryByRole("region", { name: "Regras antigas" })).toBeNull();
  });
});

describe("Gerenciar regra: moeda", () => {
  function inCurrency(currency: "BRL" | "USD" | "EUR", children: ReturnType<typeof createElement>) {
    return createElement(WorkspaceCurrencyProvider, { currency }, children);
  }

  // Compra carrega valor; QualifiedLead (o evento da regra Umbler de base) não.
  const purchaseRule: ProviderConversionRuleDto = {
    ...umblerRule,
    conversionRule: {
      ...umblerRule.conversionRule,
      eventName: "Purchase",
      defaultValueCents: 9_900,
    },
  };

  it("shows 'Padrão do workspace' and saves a currency of its own", async () => {
    const user = setupUser();
    const props = screenProps({
      providerRules: [purchaseRule],
      rows: buildProviderRuleRows([purchaseRule], numbers, connections, capabilities),
    });
    render(inCurrency("USD", createElement(ConversionsScreen, props)));

    await user.click(screen.getByRole("button", { name: "Gerenciar Automação Umbler" }));
    const dialog = screen.getByRole("dialog", { name: "Gerenciar “Automação Umbler”" });
    const currency = within(dialog).getByLabelText(/^Moeda/) as HTMLSelectElement;
    expect(currency.value).toBe("");
    expect(
      within(currency).getByRole("option", { name: "Padrão do workspace (USD)" }),
    ).toBeTruthy();

    await user.selectOptions(currency, "EUR");
    await user.click(within(dialog).getByRole("button", { name: "Salvar alterações" }));

    await waitFor(() => expect(props.updateRuleAction).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(formOf(props.updateRuleAction).get("payload")))).toEqual({
      defaultCurrency: "EUR",
    });
  });

  it("goes back to inheriting the workspace currency by sending null", async () => {
    const user = setupUser();
    const pinned: ProviderConversionRuleDto = {
      ...purchaseRule,
      conversionRule: {
        ...purchaseRule.conversionRule,
        defaultValueCents: 9_900,
        defaultCurrency: "USD",
      },
    };
    const props = screenProps({
      providerRules: [pinned],
      rows: buildProviderRuleRows([pinned], numbers, connections, capabilities),
    });
    render(inCurrency("BRL", createElement(ConversionsScreen, props)));

    await user.click(screen.getByRole("button", { name: "Gerenciar Automação Umbler" }));
    const dialog = screen.getByRole("dialog", { name: "Gerenciar “Automação Umbler”" });
    const currency = within(dialog).getByLabelText(/^Moeda/) as HTMLSelectElement;
    expect(currency.value).toBe("USD");
    await user.selectOptions(currency, "");
    await user.click(within(dialog).getByRole("button", { name: "Salvar alterações" }));

    await waitFor(() => expect(props.updateRuleAction).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(formOf(props.updateRuleAction).get("payload")))).toEqual({
      defaultCurrency: null,
    });
  });

  it("offers no currency on a rule whose event carries no value", async () => {
    const user = setupUser();
    const props = screenProps({
      providerRules: [messageRule],
      rows: buildProviderRuleRows([messageRule], numbers, connections, capabilities),
    });
    render(inCurrency("BRL", createElement(ConversionsScreen, props)));

    await user.click(screen.getByRole("button", { name: "Gerenciar Orçamento enviado" }));
    const dialog = screen.getByRole("dialog", { name: "Gerenciar “Orçamento enviado”" });
    expect(within(dialog).queryByLabelText(/^Moeda/)).toBeNull();
  });
});
