// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { providerConversionRuleIdempotentCreateInputSchema } from "@wpptrack/shared";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversionScreenActionResult } from "../src/app/(app)/conversions/actions";
import {
  originBetaEvents,
  originEventNames,
} from "../src/app/(app)/conversions/conversion-origins";
import {
  buildProviderRuleRows,
  ineligibleNumbers,
  offeredRuleOrigins,
} from "../src/app/(app)/conversions/conversion-rules-view";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ruleEventFilterLabel,
  ruleEventLabelForOrigin,
} from "../src/app/(app)/conversions/event-copy";
import { NewRuleFlow } from "../src/app/(app)/conversions/new-rule-flow";
import {
  ReceivedEvents,
  reprocessSummary,
} from "../src/app/(app)/conversions/received-events";
import { ruleManageTabs } from "../src/app/(app)/conversions/rule-manage";
import { RuleEndpoint } from "../src/app/(app)/conversions/rule-endpoint";
import {
  buildRulePayload,
  emptyRuleDraft,
  resolveRuleConnectionId,
  scopeIssue,
  type RuleDraft,
} from "../src/app/(app)/conversions/rule-draft";
import { executionReasonLabel } from "../src/app/(app)/settings/provider-conversion-labels";
import { setupUser } from "./user-shim";
import {
  at,
  capabilities,
  capabilitiesWithPayt,
  connections,
  numbers,
  providerRule,
} from "./conversions-fixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.style.overflow = "";
});

const context = { numbers, connections, capabilities: capabilitiesWithPayt };

function paytDraft(patch: Partial<RuleDraft> = {}): RuleDraft {
  return { ...emptyRuleDraft("automation_payt"), name: "Venda Payt", ...patch };
}

const paytRule = providerRule({
  id: "rule_payt",
  name: "Venda aprovada",
  origin: "automation_payt",
  triggerType: "provider_automation",
  eventName: "Purchase",
  connectionId: "conn_umbler",
  scope: "all_numbers",
  phrases: [],
  automationSource: "payt",
});

describe("Payt: origem e eventos", () => {
  it("é oferecida quando a API de capacidades a informa e há um número de WhatsApp compatível", () => {
    expect(
      offeredRuleOrigins({
        numbers,
        connections,
        capabilities: capabilitiesWithPayt,
        crm: { kommo: false, pipedrive: false },
      }),
    ).toContain("automation_payt");
    // Um número Gupshup basta: a venda da Payt roda em qualquer WhatsApp.
    expect(
      offeredRuleOrigins({
        numbers: numbers.filter((item) => item.provider === "gupshup"),
        connections: connections.filter((item) => item.provider === "gupshup"),
        capabilities: capabilitiesWithPayt,
        crm: { kommo: false, pipedrive: false },
      }),
    ).toEqual(["automation_payt"]);
    // Sem a origem nas capacidades (ou sem número), nada de Payt.
    expect(
      offeredRuleOrigins({ numbers, connections, capabilities, crm: { kommo: false, pipedrive: false } }),
    ).not.toContain("automation_payt");
    expect(
      offeredRuleOrigins({
        numbers: [],
        connections: [],
        capabilities: capabilitiesWithPayt,
        crm: { kommo: false, pipedrive: false },
      }),
    ).toEqual([]);
  });

  it("lê eventos e selo beta da API, com a tabela da origem como reserva", () => {
    expect(originEventNames("automation_payt", capabilitiesWithPayt)).toEqual([
      "Purchase",
      "InitiateCheckout",
      "CartAbandoned",
    ]);
    expect(originBetaEvents("automation_payt", capabilitiesWithPayt)).toEqual([
      "CartAbandoned",
    ]);
    expect(originBetaEvents("automation_payt", null)).toEqual(["CartAbandoned"]);
    expect(originBetaEvents("message_phrase", capabilitiesWithPayt)).toEqual([]);
  });

  it("dá rótulos de venda aos eventos da Payt, sem trocar os das outras origens", () => {
    expect(ruleEventLabelForOrigin("automation_payt", "Purchase")).toBe("Compra aprovada");
    expect(ruleEventLabelForOrigin("automation_payt", "InitiateCheckout")).toBe(
      "Pix/boleto gerado",
    );
    expect(ruleEventLabelForOrigin("automation_payt", "CartAbandoned")).toBe(
      "Carrinho abandonado",
    );
    expect(ruleEventLabelForOrigin("message_phrase", "InitiateCheckout")).not.toBe(
      "Pix/boleto gerado",
    );
  });

  it("não conta a Payt como origem que avalia o número na nota 'pelo webhook'", () => {
    const gupshup = numbers.filter((item) => item.provider === "gupshup");
    expect(
      ineligibleNumbers(numbers, capabilitiesWithPayt).map((item) => item.id),
    ).toEqual(gupshup.map((item) => item.id));
    // Dentro da regra da Payt, o Gupshup é um número válido.
    expect(ineligibleNumbers(numbers, capabilitiesWithPayt, "automation_payt")).toEqual(
      [],
    );
  });
});

describe("Payt: rascunho e payload", () => {
  it("começa em Compra aprovada, para todos os números", () => {
    const draft = emptyRuleDraft("automation_payt");
    expect(draft.eventName).toBe("Purchase");
    expect(draft.scope).toBe("all_numbers");
  });

  it("prende a regra à conexão do primeiro número compatível em 'todos os números'", () => {
    expect(resolveRuleConnectionId(paytDraft(), context)).toBe("conn_umbler");
    const built = buildRulePayload(paytDraft({ eventName: "CartAbandoned" }), context);
    expect(built).toEqual({
      ok: true,
      value: {
        name: "Venda Payt",
        connectionId: "conn_umbler",
        scope: "all_numbers",
        channelIds: [],
        mode: "observation",
        triggerType: "provider_automation",
        eventName: "CartAbandoned",
        automationSource: "payt",
      },
    });
    // O que a tela monta é aceito pelo contrato compartilhado com a API.
    expect(
      providerConversionRuleIdempotentCreateInputSchema.safeParse(
        (built as { value: unknown }).value,
      ).success,
    ).toBe(true);
  });

  it("usa a conexão dos números escolhidos e aceita os três eventos", () => {
    for (const eventName of ["Purchase", "InitiateCheckout", "CartAbandoned"] as const) {
      const built = buildRulePayload(
        paytDraft({ eventName, scope: "specific_numbers", channelIds: ["ch_02"] }),
        context,
      );
      expect(built).toMatchObject({
        ok: true,
        value: {
          connectionId: "conn_qr_a",
          channelIds: ["ch_02"],
          eventName,
          automationSource: "payt",
        },
      });
      expect(
        providerConversionRuleIdempotentCreateInputSchema.safeParse(
          (built as { value: unknown }).value,
        ).success,
      ).toBe(true);
    }
  });

  it("não manda valor, frases nem etiquetas: o valor vem da venda", () => {
    const built = buildRulePayload(
      paytDraft({ averageValue: "250,00", primaryPhrase: "x", labelNames: "y" }),
      context,
    );
    expect(built.ok && Object.keys(built.value).sort()).toEqual(
      [
        "automationSource",
        "channelIds",
        "connectionId",
        "eventName",
        "mode",
        "name",
        "scope",
        "triggerType",
      ].sort(),
    );
  });

  it("recusa números de conexões diferentes e eventos que a Payt não envia", () => {
    expect(
      scopeIssue(
        paytDraft({ scope: "specific_numbers", channelIds: ["ch_01", "ch_02"] }),
        context,
      ),
    ).toBe(
      "As vendas da Payt ficam ligadas à conexão dos números escolhidos: escolha números de uma mesma conexão.",
    );
    expect(buildRulePayload(paytDraft({ eventName: "QualifiedLead" }), context)).toEqual({
      ok: false,
      message: "Esta origem não reconhece o evento escolhido.",
    });
    expect(
      scopeIssue(paytDraft({ scope: "specific_numbers", channelIds: [] }), context),
    ).toBe("Escolha ao menos um número.");
  });

  it("pede um número de WhatsApp quando não há nenhum compatível", () => {
    expect(buildRulePayload(paytDraft(), { ...context, numbers: [] })).toEqual({
      ok: false,
      message: "Conecte um número de WhatsApp antes de criar esta regra.",
    });
  });
});

describe("Payt: lista de regras", () => {
  it("mostra a origem, o logo, o rótulo de venda e o selo beta", () => {
    const cart = providerRule({
      id: "rule_cart",
      name: "Carrinho",
      origin: "automation_payt",
      triggerType: "provider_automation",
      eventName: "CartAbandoned",
      connectionId: "conn_umbler",
      scope: "all_numbers",
      phrases: [],
      automationSource: "payt",
    });
    const pix = {
      ...cart,
      id: "rule_pix",
      conversionRule: { ...cart.conversionRule, eventName: "InitiateCheckout" as const },
    };
    const [purchaseRow, cartRow, pixRow] = buildProviderRuleRows(
      [paytRule, cart, pix],
      numbers,
      connections,
      capabilitiesWithPayt,
    );

    expect(purchaseRow).toMatchObject({
      origin: "automation_payt",
      originLabel: "Venda na Payt",
      platformLabel: "Payt",
      eventLabel: "Compra aprovada",
      eventBeta: false,
      logo: { src: "/integrations/payt.svg" },
    });
    expect(cartRow).toMatchObject({ eventLabel: "Carrinho abandonado", eventBeta: true });
    expect(pixRow).toMatchObject({ eventLabel: "Pix/boleto gerado", eventBeta: false });
  });

  it("reconhece a regra da Payt pelo automationSource quando a API não manda a origem", () => {
    const withoutOrigin = { ...paytRule };
    delete (withoutOrigin as { origin?: unknown }).origin;
    const [row] = buildProviderRuleRows(
      [withoutOrigin],
      numbers,
      connections,
      capabilitiesWithPayt,
    );
    expect(row!.origin).toBe("automation_payt");
  });

  it("oferece endereço e eventos recebidos no Gerenciar", () => {
    expect(ruleManageTabs("automation_payt", paytRule).map((tab) => tab.id)).toEqual([
      "edit",
      "endpoint",
      "received",
    ]);
  });
});

describe("Payt: Nova regra", () => {
  type Action = (formData: FormData) => Promise<ConversionScreenActionResult>;

  function renderFlow(createAction: Action, licenseLocked = false) {
    return render(
      createElement(NewRuleFlow, {
        offeredOrigins: ["message_phrase", "automation_payt"],
        numbers,
        connections,
        capabilities: capabilitiesWithPayt,
        comingSoonNumbers: [],
        licenseLocked,
        createAction,
        confirmAction: vi.fn(),
        onFinished: () => undefined,
      }),
    );
  }

  it("mostra o selo beta no carrinho abandonado e cria a regra presa à conexão", async () => {
    const user = setupUser();
    const createAction = vi.fn(async (_formData: FormData) => ({
      ok: true,
      ruleId: "rule_payt",
      webhookUrl: "https://api.example.test/webhooks/inbound/conversions/e1?token=t",
      message:
        "Regra criada em observação. Copie o endereço agora: ele não é exibido de novo.",
    }));
    renderFlow(createAction);

    await user.click(screen.getByRole("radio", { name: /Venda na Payt/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));

    // Evento: os três eventos de venda, com “beta” só no carrinho abandonado.
    const purchase = screen.getByRole("radio", { name: /Compra aprovada/ });
    expect((purchase as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("radio", { name: /Pix\/boleto gerado/ })).toBeTruthy();
    const cart = screen.getByRole("radio", { name: /Carrinho abandonado/ });
    expect(within(cart.closest("label")!).getByText("beta")).toBeTruthy();
    expect(within(purchase.closest("label")!).queryByText("beta")).toBeNull();
    await user.click(cart);
    await user.click(screen.getByRole("button", { name: /Continuar/ }));

    // Alcance: a regra fica presa à conexão dos números.
    expect(
      screen.getByText(/ficam ligadas à conexão dos números escolhidos/),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Continuar/ }));

    // Detalhes: sem valor médio; o valor vem da venda.
    expect(screen.queryByText("Valor médio (opcional)")).toBeNull();
    expect(screen.getByText(/O valor de cada venda vem da própria Payt/)).toBeTruthy();
    expect(screen.getByDisplayValue("Venda na Payt - Carrinho abandonado")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Criar regra" }));

    await screen.findByText("Regra criada");
    const formData = createAction.mock.calls[0]![0] as FormData;
    expect(JSON.parse(String(formData.get("payload")))).toMatchObject({
      triggerType: "provider_automation",
      automationSource: "payt",
      eventName: "CartAbandoned",
      connectionId: "conn_umbler",
      scope: "all_numbers",
      mode: "observation",
    });
    // A URL aparece uma única vez, com o passo a passo da Payt.
    expect(screen.getByText("URL de postback da Payt (exibida uma única vez)")).toBeTruthy();
    expect(screen.getByText("Configuração na Payt")).toBeTruthy();
    expect(screen.getByText(/abra Postback/)).toBeTruthy();
    expect(screen.queryByText(/Umbler/)).toBeNull();
  });

  it("mostra o aviso de licença bloqueada quando a API responde 423", async () => {
    const user = setupUser();
    const message =
      "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.";
    const createAction = vi.fn(async (_formData: FormData) => ({
      ok: false,
      licenseLocked: true,
      message,
    }));
    renderFlow(createAction);

    await user.click(screen.getByRole("radio", { name: /Venda na Payt/ }));
    for (let step = 0; step < 3; step += 1) {
      await user.click(screen.getByRole("button", { name: /Continuar/ }));
    }
    await user.click(screen.getByRole("button", { name: "Criar regra" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Licença bloqueada");
    expect(screen.queryByRole("button", { name: "Conferir e concluir" })).toBeNull();
  });

  it("desabilita a criação com a licença bloqueada", async () => {
    const user = setupUser();
    renderFlow(vi.fn(), true);

    expect(screen.getByText(/Licença bloqueada/)).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /Venda na Payt/ }));
    for (let step = 0; step < 3; step += 1) {
      await user.click(screen.getByRole("button", { name: /Continuar/ }));
    }
    expect(
      (screen.getByRole("button", { name: "Criar regra" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("avisa quando os números escolhidos são de conexões diferentes", async () => {
    const user = setupUser();
    renderFlow(vi.fn());

    await user.click(screen.getByRole("radio", { name: /Venda na Payt/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));
    await user.click(screen.getByRole("radio", { name: /Números específicos/ }));
    // Gupshup é um número válido para a Payt (qualquer WhatsApp).
    await user.click(screen.getByRole("checkbox", { name: /Gupshup SP/ }));
    await user.click(screen.getByRole("checkbox", { name: /Recepção/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "de uma mesma conexão",
    );
  });
});

describe("Payt: endereço e eventos recebidos", () => {
  it("explica como colar a URL na Payt e gera uma nova só depois de confirmar", async () => {
    const user = setupUser();
    const rotate = vi.fn(async (_formData: FormData) => ({
      ok: true,
      message: "ok",
      oneTimeSecret: {
        ruleId: "rule_payt",
        webhookUrl: "https://api.example.test/x?token=novo",
      },
    }));
    const onRotated = vi.fn();
    render(
      createElement(RuleEndpoint, {
        rule: {
          ...paytRule,
          endpoint: {
            id: "endpoint_payt",
            workspaceId: "workspace_1",
            providerRuleId: "rule_payt",
            secretVersion: 1,
            lastDeliveryAt: at,
            lastSuccessfulParseAt: at,
            rotatedAt: null,
            removedAt: null,
            createdAt: at,
            updatedAt: at,
          },
        },
        origin: "automation_payt",
        canManage: true,
        rotateAction: rotate,
        capabilities: capabilitiesWithPayt,
        onRotated,
        onDismiss: () => undefined,
      }),
    );

    expect(screen.getByRole("heading", { name: "Como configurar na Payt" })).toBeTruthy();
    // The setup steps appear once (only in the Payt panel).
    expect(screen.getAllByText(/abra Postback/)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Gerar novo endereço" }));
    expect(screen.getByText(/cole o novo endereço na Payt/)).toBeTruthy();
    expect(rotate).not.toHaveBeenCalled();
    await user.click(screen.getAllByRole("button", { name: "Gerar novo endereço" })[0]!);
    await waitFor(() =>
      expect(onRotated).toHaveBeenCalledWith("https://api.example.test/x?token=novo"),
    );
  });

  it("lista os eventos Payt com nome de venda e reavalia em observação", async () => {
    const user = setupUser();
    const item = (
      deliveryId: string,
      eventName: string,
      status: string,
      reprocessable: boolean,
    ) => ({
      deliveryId,
      executionId: null,
      receivedAt: "2026-10-14T13:00:00.000Z",
      lastReceivedAt: "2026-10-14T13:00:00.000Z",
      providerEventType: "payt_postback",
      eventName,
      automation: null,
      status,
      reasonCode: reprocessable ? "payt_channel_missing_or_ambiguous" : "rule_in_observation",
      attemptCount: 1,
      executionAttemptCount: 0,
      channel: null,
      leadResolved: false,
      payloadAvailable: false,
      payloadExpiresAt: "2026-10-20T13:00:00.000Z",
      reprocessable,
    });
    const audit = {
      providerRuleId: "rule_payt",
      summary: {
        total: 2,
        observed: 1,
        blocked: 1,
        queued: 0,
        materialized: 0,
        failed: 0,
        invalid: 0,
        recoverable: 1,
      },
      items: [
        item("d1", "InitiateCheckout", "blocked", true),
        item("d2", "Purchase", "observed", false),
      ],
    };
    const loadAction = vi.fn(async (_formData: FormData) => ({
      ok: true,
      message: "ok",
      automationAudit: audit,
    }));
    const reprocessAction = vi.fn(async (_formData: FormData) => ({
      ok: true,
      message: "ok",
      automationReprocess: {
        providerRuleId: "rule_payt",
        requested: 1,
        queued: 0,
        blocked: 0,
        skipped: 0,
        observed: 1,
        items: [],
      },
    }));
    render(
      createElement(ReceivedEvents, {
        ruleId: "rule_payt",
        origin: "automation_payt",
        mode: "observation",
        canManage: true,
        loadAction: loadAction as never,
        loadPayloadAction: vi.fn() as never,
        reprocessAction: reprocessAction as never,
      }),
    );

    await screen.findByText("Pix/boleto gerado");
    expect(screen.getByText(/Número da venda não identificado ou ambíguo/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Reprocessar evento de/ }));
    expect(
      screen.getByText(
        "Reavaliar 1 evento recebido? A regra está em observação: nada é enviado à Meta.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reprocessar" }));
    expect(await screen.findByText("1 reavaliado em observação.")).toBeTruthy();
  });

  it("resume reprocessamentos reavaliados em observação e traduz os motivos da venda", () => {
    expect(
      reprocessSummary({
        providerRuleId: "rule_payt",
        requested: 3,
        queued: 0,
        blocked: 1,
        skipped: 0,
        observed: 2,
        items: [],
      }),
    ).toBe("2 reavaliados em observação, 1 continua bloqueado.");
    expect(executionReasonLabel("payt_lead_other_channel")).toContain("Lead de outro número");
    expect(executionReasonLabel("purchase_duplicate")).toContain("Venda repetida");
    expect(executionReasonLabel("payt_automation_v1_not_purchase")).toBe(
      "Status da Payt não gera conversão",
    );
    expect(executionReasonLabel("payt_automation_v1_event_not_in_rule")).toBe(
      "Evento da Payt fora desta regra",
    );
    expect(executionReasonLabel("automation_matched_payt_observation")).toBe(
      "Reconhecido em observação",
    );
  });

  it("mostra postbacks de outro status como ignorados, em tom neutro", async () => {
    const user = setupUser();
    const audit = {
      providerRuleId: "rule_payt",
      summary: {
        total: 1,
        observed: 0,
        blocked: 0,
        queued: 0,
        materialized: 0,
        failed: 0,
        invalid: 0,
        recoverable: 0,
      },
      items: [
        {
          deliveryId: "d_refund",
          executionId: null,
          receivedAt: "2026-10-14T13:00:00.000Z",
          lastReceivedAt: "2026-10-14T13:00:00.000Z",
          providerEventType: "automation_callback",
          eventName: null,
          automation: "automation_callback",
          status: "ignored",
          reasonCode: "payt_automation_v1_not_purchase",
          attemptCount: 1,
          executionAttemptCount: 0,
          channel: null,
          leadResolved: false,
          payloadAvailable: false,
          payloadExpiresAt: "2026-10-20T13:00:00.000Z",
          reprocessable: false,
        },
      ],
    };
    render(
      createElement(ReceivedEvents, {
        ruleId: "rule_payt",
        origin: "automation_payt",
        mode: "observation",
        canManage: true,
        loadAction: vi.fn(async () => ({
          ok: true,
          message: "ok",
          automationAudit: audit,
        })) as never,
        loadPayloadAction: vi.fn() as never,
        reprocessAction: vi.fn() as never,
      }),
    );

    // Nothing to reprocess: opens on "Todos" without a click.
    expect(await screen.findByText(/Status da Payt não gera conversão/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Todos" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    const chip = screen.getByText("Ignorado");
    expect(chip.className).toContain("status-chip");
    expect(chip.className).toContain("neutral");
    expect(chip.className).not.toContain("bad");
    expect(screen.queryByText("Dados fora do padrão")).toBeNull();
    // An ignored event says nothing about number, lead or the 24h reprocess window.
    expect(screen.queryByText(/Número não identificado/)).toBeNull();
    expect(screen.queryByText(/Lead vindo de anúncio/)).toBeNull();
    expect(screen.queryByText(/reprocessados por 24 horas/)).toBeNull();
    void user;
  });
});

describe("rótulo do evento Payt e layout (Fase 4a)", () => {
  it("filtro de evento: só Payt usa o rótulo da Payt; mistura não confunde", () => {
    expect(ruleEventFilterLabel("InitiateCheckout", ["automation_payt"])).toBe(
      "Pix/boleto gerado",
    );
    expect(
      ruleEventFilterLabel("InitiateCheckout", ["message_phrase", "automation_payt"]),
    ).toBe("Checkout iniciado (Payt: Pix/boleto gerado)");
    expect(ruleEventFilterLabel("InitiateCheckout", ["message_phrase"])).toBe(
      ruleEventLabelForOrigin("message_phrase", "InitiateCheckout"),
    );
  });

  it("CSS: ações da regra quebram em colunas mínimas e o painel da Payt ocupa a largura", () => {
    const css = readFileSync(
      resolve(__dirname, "../src/styles/layout-system.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.conversion-rule-actions \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(1[0-9]{2}px, 1fr\)\)/,
    );
    expect(css).toMatch(
      /\.conversion-webhook-url \.provider-conversion-payload-helper \{[^}]*width: 100%/,
    );
  });
});

