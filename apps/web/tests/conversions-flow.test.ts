// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { setupUser } from "./user-shim";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversionScreenActionResult } from "../src/app/(app)/conversions/actions";
import { buildProviderRuleRows } from "../src/app/(app)/conversions/conversion-rules-view";
import {
  ConversionsScreen,
  type ConversionsScreenProps,
} from "../src/app/(app)/conversions/conversions-screen";
import { NewRuleFlow } from "../src/app/(app)/conversions/new-rule-flow";
import { capabilities, connections, numbers, providerRule } from "./conversions-fixtures";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.style.overflow = "";
});

type Action = (formData: FormData) => Promise<ConversionScreenActionResult>;

function renderFlow(
  createAction: Action,
  options: {
    confirmAction?: Action;
    licenseLocked?: boolean;
    offeredOrigins?: Array<"message_phrase" | "automation_umbler" | "kommo">;
  } = {},
) {
  return render(
    createElement(NewRuleFlow, {
      offeredOrigins: options.offeredOrigins ?? ["message_phrase", "automation_umbler", "kommo"],
      numbers,
      connections,
      capabilities,
      comingSoonNumbers: [
        { id: "wc_1", provider: "waha", label: "WAHA Loja", phone: null },
      ],
      licenseLocked: options.licenseLocked ?? false,
      createAction,
      confirmAction: options.confirmAction ?? vi.fn(),
      onFinished: () => undefined,
    }),
  );
}

function sentPayload(action: ReturnType<typeof vi.fn>, call = 0) {
  const formData = action.mock.calls[call]![0] as FormData;
  return {
    key: formData.get("requestKey"),
    payload: JSON.parse(String(formData.get("payload"))),
  };
}

async function goToDetails(user: ReturnType<typeof setupUser>) {
  await user.click(screen.getByRole("button", { name: /Continuar/ }));
  await user.click(screen.getByRole("button", { name: /Continuar/ }));
  await user.click(screen.getByRole("button", { name: /Continuar/ }));
}

describe("Nova regra flow", () => {
  it("creates a message rule for every number in four steps", async () => {
    const user = setupUser();
    const createAction = vi.fn(async () => ({
      ok: true,
      ruleId: "rule_1",
      message: "Regra criada em observação.",
    }));
    renderFlow(createAction);

    await user.click(screen.getByRole("radio", { name: /Frase na conversa/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));
    // Evento
    await user.selectOptions(screen.getByLabelText("Evento"), "QualifiedLead");
    await user.click(screen.getByRole("button", { name: /Continuar/ }));
    // Alcance: "Todos os números" is the default.
    expect((screen.getByRole("radio", { name: /Todos os números/ }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("button", { name: /Continuar/ }));
    // Detalhes
    await user.type(
      screen.getByPlaceholderText("Ex.: A sua consulta está agendada"),
      "vou te passar os valores",
    );
    await user.click(screen.getByRole("button", { name: "Criar regra" }));

    await screen.findByText("Regra criada");
    const { key, payload } = sentPayload(createAction);
    expect(key).toMatch(/^prc_[0-9a-f]{48}$/u);
    expect(payload).toMatchObject({
      scope: "all_numbers",
      channelIds: [],
      triggerType: "message_phrase",
      eventName: "QualifiedLead",
      triggerPhrases: ["vou te passar os valores"],
      mode: "observation",
      name: "Frase na conversa - Lead qualificado",
    });
    expect(payload.connectionId).toBeUndefined();
  });

  it("lets numbers of any connection be picked and shows the ones not eligible as Em breve", async () => {
    const user = setupUser();
    renderFlow(vi.fn());

    await user.click(screen.getByRole("radio", { name: /Frase na conversa/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));
    await user.click(screen.getByRole("radio", { name: /Números específicos/ }));

    await user.click(screen.getByRole("checkbox", { name: /Recepção/ }));
    await user.click(screen.getByRole("checkbox", { name: /Atendimento/ }));
    expect((screen.getByRole("checkbox", { name: /Atendimento/ }) as HTMLInputElement).checked).toBe(true);
    // WAHA is "Em breve"; Gupshup works, it only receives conversions by webhook.
    const soon = screen.getByLabelText("Números sem regras");
    expect(within(soon).getByText("WAHA Loja")).toBeTruthy();
    expect(within(soon).getByText("WAHA · Em breve")).toBeTruthy();
    expect(within(soon).getByText("Gupshup SP")).toBeTruthy();
    expect(within(soon).getByText("Gupshup · pelo webhook")).toBeTruthy();
    expect(within(soon).getByText(/Conversões chegam pelo webhook do provedor/)).toBeTruthy();
    expect(within(soon).queryByText("Gupshup · Em breve")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Gupshup SP/ })).toBeNull();
  });

  it("only offers Umbler numbers for messages from the contact", async () => {
    const user = setupUser();
    renderFlow(vi.fn());

    await user.click(screen.getByRole("radio", { name: /Frase na conversa/ }));
    await goToDetails(user);
    await user.selectOptions(
      screen.getByLabelText("Quem pode enviar"),
      "contact",
    );
    await user.click(screen.getByRole("button", { name: /Voltar/ }));
    await user.click(screen.getByRole("radio", { name: /Números específicos/ }));

    expect(screen.getByRole("checkbox", { name: /Recepção/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Atendimento/ })).toBeNull();
    expect(screen.getByText(/Mensagens do contato só são lidas na Umbler/)).toBeTruthy();
  });

  it("checks an uncertain create against the receipt before resending", async () => {
    const user = setupUser();
    const createAction = vi.fn(async () => ({
      ok: false,
      outcomeUnknown: true,
      message: "Não deu para confirmar se a regra foi criada.",
    }));
    const confirmAction = vi.fn(async (_formData: FormData) => ({
      ok: true,
      replayed: true,
      ruleId: "rule_1",
      message: "A regra foi criada.",
    }));
    renderFlow(createAction, { confirmAction });

    await user.click(screen.getByRole("radio", { name: /Automação da Umbler/ }));
    await goToDetails(user);
    await user.click(screen.getByRole("button", { name: "Criar regra" }));

    const retry = await screen.findByRole("button", { name: "Conferir e concluir" });
    // Locked while uncertain: no going back to edit the request.
    expect(screen.queryByRole("button", { name: /Voltar/ })).toBeNull();
    await user.click(retry);

    await screen.findByText("Regra já existia");
    // The lookup carries the same key and the bound connection; nothing is resent.
    const confirmed = confirmAction.mock.calls[0]![0] as FormData;
    expect(confirmed.get("requestKey")).toBe(sentPayload(createAction).key);
    expect(confirmed.get("connectionId")).toBe("conn_umbler");
    expect(createAction).toHaveBeenCalledTimes(1);
  });

  it("resends the same request when the receipt is absent", async () => {
    const user = setupUser();
    const createAction = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        outcomeUnknown: true,
        message: "Não deu para confirmar se a regra foi criada.",
      })
      .mockResolvedValueOnce({ ok: true, ruleId: "rule_1", message: "Regra criada." });
    const confirmAction = vi.fn(async () => ({
      ok: false,
      receiptAbsent: true,
      message: "A regra não foi criada. Você pode tentar de novo com segurança.",
    }));
    renderFlow(createAction, { confirmAction });

    await user.click(screen.getByRole("radio", { name: /Automação da Umbler/ }));
    await goToDetails(user);
    await user.click(screen.getByRole("button", { name: "Criar regra" }));
    await user.click(await screen.findByRole("button", { name: "Conferir e concluir" }));
    await user.click(await screen.findByRole("button", { name: "Tentar de novo" }));

    await screen.findByText("Regra criada");
    expect(sentPayload(createAction, 1)).toEqual(sentPayload(createAction, 0));
  });

  it("retries an unavailable create with the same request", async () => {
    const user = setupUser();
    const createAction = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        unavailable: true,
        message: "Serviço indisponível no momento. Tente de novo em alguns instantes.",
      })
      .mockResolvedValueOnce({ ok: true, ruleId: "rule_1", message: "Regra criada." });
    const confirmAction = vi.fn();
    renderFlow(createAction, { confirmAction });

    await user.click(screen.getByRole("radio", { name: /Automação da Umbler/ }));
    await goToDetails(user);
    await user.click(screen.getByRole("button", { name: "Criar regra" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Serviço indisponível");
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await screen.findByText("Regra criada");
    expect(sentPayload(createAction, 1)).toEqual(sentPayload(createAction, 0));
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it("shows the license message on a 423 without checking the receipt", async () => {
    const user = setupUser();
    const createAction = vi.fn(async () => ({
      ok: false,
      licenseLocked: true,
      message: "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.",
    }));
    const confirmAction = vi.fn();
    renderFlow(createAction, { confirmAction });

    await user.click(screen.getByRole("radio", { name: /Automação da Umbler/ }));
    await goToDetails(user);
    await user.click(screen.getByRole("button", { name: "Criar regra" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Licença bloqueada");
    // A definite refusal: back to a normal create, no "Conferir e concluir".
    expect(screen.queryByRole("button", { name: "Conferir e concluir" })).toBeNull();
    expect(screen.getByRole("button", { name: "Criar regra" })).toBeTruthy();
    expect(confirmAction).not.toHaveBeenCalled();
  });

  it("disables creating while the license is locked", async () => {
    const user = setupUser();
    const createAction = vi.fn();
    renderFlow(createAction, { licenseLocked: true });

    expect(screen.getByText(/Licença bloqueada/)).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /Frase na conversa/ }));
    await goToDetails(user);
    expect((screen.getByRole("button", { name: "Criar regra" }) as HTMLButtonElement).disabled).toBe(true);
    expect(createAction).not.toHaveBeenCalled();
  });

  it("points CRM origins to the Kommo window in the hub instead of creating here", async () => {
    const user = setupUser();
    renderFlow(vi.fn());

    await user.click(screen.getByRole("radio", { name: /Etapa no Kommo/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));

    expect(
      screen.getByRole("link", { name: /Abrir Kommo em Integrações/ }).getAttribute("href"),
    ).toBe("/integrations?abrir=kommo");
    expect(screen.queryByRole("button", { name: /Continuar/ })).toBeNull();
  });
});

describe("Conversions screen", () => {
  const rows = buildProviderRuleRows(
    [
      providerRule({
        id: "rule_1",
        name: "Qualificado Recepção",
        connectionId: "conn_umbler",
        channelIds: ["ch_01"],
      }),
    ],
    numbers,
    connections,
    capabilities,
  );

  function props(overrides: Partial<ConversionsScreenProps> = {}): ConversionsScreenProps {
    return {
      rows,
      numbers,
      connections,
      offeredOrigins: ["message_phrase"],
      capabilities,
      unifyGroups: [
        {
          key: "group_1",
          origin: "message_phrase",
          eventName: "InitiateCheckout",
          mode: "production",
          name: "Checkout iniciado",
          triggerPhrases: ["segue o link"],
          ruleIds: ["r1", "r2"],
          channelIds: ["ch_01", "ch_02"],
          newlyCoveredChannelIds: ["ch_03"],
          overriddenChannelIds: ["ch_05"],
          duplicatePhoneChannelIds: ["ch_04"],
          existingGlobalRuleId: null,
        },
      ],
      canManage: true,
      rulesState: "real",
      numbersPartial: false,
      crmVisible: true,
      crmError: false,
      createAction: vi.fn(),
      confirmCreateAction: vi.fn(),
      unifyAction: vi.fn(async () => ({
        ok: true,
        message: "Pronto: agora uma regra vale para todos os números.",
        unify: {
          outcome: "created" as const,
          ruleId: "global",
          ruleName: "Checkout iniciado",
          deactivatedRuleIds: ["r1", "r2"],
          newlyCoveredChannelIds: ["ch_03"],
          duplicatePhoneChannelIds: ["ch_04"],
        },
      })),
      updateRuleAction: vi.fn(async () => ({ ok: true, message: "ok" })),
      loadExecutionsAction: vi.fn(async () => ({ ok: false, message: "x" })),
      ...overrides,
    };
  }

  it("reviews a unify group listing covered, new, kept and same-phone numbers", async () => {
    const user = setupUser();
    const screenProps = props();
    render(createElement(ConversionsScreen, screenProps));

    await user.click(screen.getByRole("button", { name: "Revisar e unificar" }));
    const dialog = screen.getByRole("dialog", { name: "Unificar regras iguais" });

    expect(within(dialog).getByText("Já cobertos hoje (2)")).toBeTruthy();
    expect(within(dialog).getByText("Passam a ser cobertos (1)")).toBeTruthy();
    expect(within(dialog).getByText("Estes números começam a enviar este evento para a Meta.")).toBeTruthy();
    expect(within(dialog).getByText("Continuam com a regra própria (1)")).toBeTruthy();
    expect(within(dialog).getByText("Mesmo telefone em duas conexões (1)")).toBeTruthy();
    expect(within(dialog).getByText("Pós-venda")).toBeTruthy();

    await user.type(within(dialog).getByLabelText("Nome da regra unificada"), "Checkout (todos)");
    await user.click(within(dialog).getByRole("button", { name: "Unificar" }));

    expect(await within(dialog).findByText("Regras unificadas")).toBeTruthy();
    const formData = (screenProps.unifyAction as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as FormData;
    expect(formData.getAll("ruleId")).toEqual(["r1", "r2"]);
    expect(formData.get("name")).toBe("Checkout (todos)");

    await user.click(within(dialog).getByRole("button", { name: "Concluir" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("keeps an uncertain create open until it is confirmed", async () => {
    const user = setupUser();
    const createAction = vi.fn().mockResolvedValueOnce({
      ok: false,
      outcomeUnknown: true,
      message: "Não deu para confirmar se a regra foi criada.",
    });
    const confirmCreateAction = vi.fn(async (_formData: FormData) => ({
      ok: true,
      replayed: true,
      ruleId: "rule_9",
      message: "A regra foi criada.",
    }));
    render(
      createElement(
        ConversionsScreen,
        props({ offeredOrigins: ["automation_umbler"], createAction, confirmCreateAction }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Nova regra" }));
    await user.click(screen.getByRole("radio", { name: /Automação da Umbler/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));
    await user.click(screen.getByRole("button", { name: "Criar regra" }));
    await screen.findByRole("button", { name: "Conferir e concluir" });

    // Escape and the close button do not drop the pending request.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Fechar" }));
    expect(screen.getByRole("dialog", { name: "Nova regra" })).toBeTruthy();
    expect(screen.getByText(/Este pedido ainda não foi confirmado/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Conferir e concluir" }));
    await screen.findByText("Regra já existia");
    expect(confirmCreateAction.mock.calls[0]![0].get("requestKey")).toBe(
      createAction.mock.calls[0]![0].get("requestKey"),
    );
    await user.click(screen.getByRole("button", { name: "Concluir" }));
    expect(screen.queryByRole("dialog", { name: "Nova regra" })).toBeNull();
  });

  it("asks before turning on automatic sending", async () => {
    const user = setupUser();
    const screenProps = props();
    render(createElement(ConversionsScreen, screenProps));

    await user.click(
      screen.getByRole("button", { name: "Ativar envio automático de Qualificado Recepção" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Ativar envio automático" });
    await user.click(within(dialog).getByRole("button", { name: "Ativar envio" }));

    await waitFor(() => expect(screenProps.updateRuleAction).toHaveBeenCalledTimes(1));
    const formData = (screenProps.updateRuleAction as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as FormData;
    expect(formData.get("ruleId")).toBe("rule_1");
    expect(JSON.parse(String(formData.get("payload")))).toEqual({ mode: "production" });
    expect((await screen.findByRole("status")).textContent).toContain("envia o evento para a Meta");
  });

  it("resumes a paused rule in observation, saying nothing is sent", async () => {
    const user = setupUser();
    const paused = buildProviderRuleRows(
      [
        providerRule({
          id: "rule_2",
          name: "Etiqueta Pagou",
          connectionId: "conn_umbler",
          channelIds: ["ch_01"],
          active: false,
        }),
      ],
      numbers,
      connections,
      capabilities,
    );
    const screenProps = props({ rows: paused });
    render(createElement(ConversionsScreen, screenProps));

    expect(screen.queryByRole("button", { name: /^Reativar/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retomar observação de Etiqueta Pagou" }));
    const dialog = screen.getByRole("dialog", { name: "Retomar observação" });
    expect(dialog.textContent).toContain("nada é enviado à Meta");
    await user.click(within(dialog).getByRole("button", { name: "Retomar observação" }));

    await waitFor(() => expect(screenProps.updateRuleAction).toHaveBeenCalledTimes(1));
    const formData = (screenProps.updateRuleAction as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as FormData;
    expect(JSON.parse(String(formData.get("payload")))).toEqual({ active: true });
  });

  it("filters the list by number", async () => {
    const user = setupUser();
    render(createElement(ConversionsScreen, props()));

    await user.selectOptions(screen.getByLabelText("Número"), "ch_02");
    expect(screen.getByText("Nenhuma regra com estes filtros")).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Limpar filtros" })[0]!);
    expect(screen.getByRole("article", { name: "Qualificado Recepção" })).toBeTruthy();
  });

  it("offers every status in the filter, unified included", () => {
    render(createElement(ConversionsScreen, props()));

    const status = screen.getByLabelText("Status") as HTMLSelectElement;
    expect([...status.options].map((option) => option.textContent)).toEqual([
      "Todos",
      "Envio automático",
      "Observação",
      "Pausadas",
      "Unificadas",
    ]);
  });

  it("warns in the unify review when the global rule would observe a number that already sends", async () => {
    const user = setupUser();
    const base = props();
    const group = {
      ...base.unifyGroups[0]!,
      observationCanonicalChannels: [
        { canonicalChannelId: "ch_03", productionChannelIds: ["ch_02"] },
      ],
    };
    render(createElement(ConversionsScreen, { ...base, unifyGroups: [group] }));

    await user.click(screen.getByRole("button", { name: "Revisar e unificar" }));
    const dialog = screen.getByRole("dialog", { name: "Unificar regras iguais" });
    expect(within(dialog).getByText("Canal em observação (1)")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Em Pós-venda: a regra global roda no canal em observação; outro canal do mesmo número está em produção.",
      ),
    ).toBeTruthy();
  });

  it("explains that unifying can be undone and is never forced", async () => {
    const user = setupUser();
    render(createElement(ConversionsScreen, props()));

    await user.click(screen.getByRole("button", { name: "Revisar e unificar" }));
    const dialog = screen.getByRole("dialog", { name: "Unificar regras iguais" });
    expect(dialog.textContent).toContain("Dá para desfazer");
    expect(dialog.textContent).toContain("nunca é obrigatório");
  });

  it("links CRM rules to the Kommo window in the hub", () => {
    const kommoRow = {
      ...rows[0]!,
      key: "kommo:kr_1",
      kind: "crm" as const,
      id: "kr_1",
      name: "Proposta enviada",
      origin: "kommo" as const,
      originLabel: "Etapa no Kommo",
      manageHref: "/integrations?abrir=kommo",
    };
    render(createElement(ConversionsScreen, props({ rows: [kommoRow] })));

    const link = screen.getByRole("link", { name: /Gerenciar no Hub/ });
    expect(link.getAttribute("href")).toBe("/integrations?abrir=kommo");
    expect(screen.queryByRole("button", { name: "Pausar Proposta enviada" })).toBeNull();
  });

  it("tells non-owners that CRM rules are the account owner's", () => {
    render(createElement(ConversionsScreen, props({ crmVisible: false })));

    expect(screen.getByText(/As regras de CRM \(Kommo, Pipedrive\) aparecem só para o responsável da/)).toBeTruthy();
  });

  it("disables every write control while the license is locked", () => {
    render(createElement(ConversionsScreen, props({ licenseLocked: true })));

    expect(screen.getAllByText(/Licença bloqueada/).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Nova regra" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Revisar e unificar" })).toBeNull();
    for (const name of [
      "Ativar envio automático de Qualificado Recepção",
      "Pausar Qualificado Recepção",
    ]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    // Reading stays available.
    expect((screen.getByRole("button", { name: "Ver execuções de Qualificado Recepção" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Nova regra when the capabilities could not be read", () => {
    render(createElement(ConversionsScreen, props({ capabilities: null })));

    expect((screen.getByRole("button", { name: "Nova regra" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Não deu para confirmar quais origens de regra/)).toBeTruthy();
  });
});
