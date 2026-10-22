// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import {
  providerConversionRuleCapabilitiesSchema,
  providerConversionRuleIdempotentCreateInputSchema,
  type ProviderConversionRuleCapabilitiesDto,
} from "@wpptrack/shared";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversionScreenActionResult } from "../src/app/(app)/conversions/actions";
import {
  hubProviderForInbound,
  originEventNames,
  providerDisplayName,
  ruleOriginDefinition,
} from "../src/app/(app)/conversions/conversion-origins";
import {
  buildProviderRuleRows,
  connectionsForOrigin,
  numbersForOrigin,
  offeredRuleOrigins,
  type ConversionConnection,
  type ConversionNumber,
} from "../src/app/(app)/conversions/conversion-rules-view";
import { NewRuleFlow } from "../src/app/(app)/conversions/new-rule-flow";
import {
  buildRulePayload,
  emptyRuleDraft,
  resolveRuleConnectionId,
  scopeIssue,
  type RuleDraft,
} from "../src/app/(app)/conversions/rule-draft";
import { RuleEndpoint } from "../src/app/(app)/conversions/rule-endpoint";
import { RuleLogo } from "../src/app/(app)/conversions/rule-logo";
import { ruleManageTabs } from "../src/app/(app)/conversions/rule-manage";
import { ruleEditCapabilities } from "../src/app/(app)/conversions/rule-edit";
import { executionReasonLabel } from "../src/app/(app)/settings/provider-conversion-labels";
import { setupUser } from "./user-shim";
import {
  at,
  capabilitiesWithPayt,
  connections as baseConnections,
  numbers as baseNumbers,
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

const unnichatConnection: ConversionConnection = {
  id: "conn_unnichat",
  provider: "unnichat",
  displayName: "Unnichat Loja",
  status: "production",
};
const connections = [...baseConnections, unnichatConnection];

const unnichatNumber: ConversionNumber = {
  id: "ch_09",
  connectionId: "conn_unnichat",
  provider: "unnichat",
  connectionName: "Unnichat Loja",
  label: "Loja Centro",
  phone: "+5511999990009",
  whatsappInstanceId: null,
  routeIds: [],
  status: "active",
};
const numbers = [...baseNumbers, unnichatNumber];

/** Capacidades como a API informa: automação do Unnichat sem lista de eventos. */
const capabilities: ProviderConversionRuleCapabilitiesDto = {
  ...capabilitiesWithPayt,
  origins: [
    ...capabilitiesWithPayt.origins.map((item) =>
      item.origin === "automation_payt"
        ? {
            ...item,
            channelProviders: [...item.channelProviders, "unnichat"],
          }
        : item,
    ),
    {
      origin: "automation_unnichat",
      scopes: ["all_numbers", "specific_numbers"],
      channelProviders: ["unnichat"],
      authorChannelProviders: null,
      connectionBound: true,
      requiresConnection: true,
      labelMatch: null,
      unifiable: false,
    },
  ],
};

const context = { numbers, connections, capabilities };

function draft(patch: Partial<RuleDraft> = {}): RuleDraft {
  return {
    ...emptyRuleDraft("automation_unnichat"),
    name: "Compra no Unnichat",
    connectionId: "conn_unnichat",
    ...patch,
  };
}

const unnichatRule = providerRule({
  id: "rule_unnichat",
  name: "Compra no Unnichat",
  origin: "automation_unnichat",
  triggerType: "provider_automation",
  eventName: "Purchase",
  connectionId: "conn_unnichat",
  scope: "all_numbers",
  phrases: [],
});

const endpoint = {
  id: "endpoint_unnichat",
  workspaceId: "workspace_1",
  providerRuleId: "rule_unnichat",
  secretVersion: 1,
  lastDeliveryAt: at,
  lastSuccessfulParseAt: at,
  rotatedAt: null,
  removedAt: null,
  createdAt: at,
  updatedAt: at,
};

describe("Unnichat: origem", () => {
  it("é aceita pelo contrato compartilhado de capacidades", () => {
    expect(providerConversionRuleCapabilitiesSchema.safeParse(capabilities).success).toBe(
      true,
    );
  });

  it("é presa à conexão, sem lista de eventos (vale todo o catálogo)", () => {
    const definition = ruleOriginDefinition("automation_unnichat");
    expect(definition).toMatchObject({
      label: "Automação do Unnichat",
      logoProvider: "unnichat",
      connection: "same_provider",
    });
    expect(definition.allowedEvents).toBeUndefined();
    expect(definition.lockedEvent).toBeUndefined();
    expect(originEventNames("automation_unnichat", capabilities)).toBeNull();
  });

  it("só é oferecida com a API informando a origem e uma conexão Unnichat ativa", () => {
    const offered = (input: Partial<Parameters<typeof offeredRuleOrigins>[0]>) =>
      offeredRuleOrigins({
        numbers,
        connections,
        capabilities,
        crm: { kommo: false, pipedrive: false },
        ...input,
      });

    expect(offered({})).toContain("automation_unnichat");
    expect(offered({ capabilities: capabilitiesWithPayt })).not.toContain(
      "automation_unnichat",
    );
    expect(offered({ connections: baseConnections })).not.toContain(
      "automation_unnichat",
    );
    expect(
      offered({
        connections: [...baseConnections, { ...unnichatConnection, status: "paused" }],
      }),
    ).not.toContain("automation_unnichat");
  });

  it("limita conexões e números da regra ao Unnichat", () => {
    expect(
      connectionsForOrigin("automation_unnichat", connections, capabilities).map(
        (item) => item.id,
      ),
    ).toEqual(["conn_unnichat"]);
    expect(
      numbersForOrigin("automation_unnichat", numbers, "conn_unnichat", capabilities).map(
        (item) => item.id,
      ),
    ).toEqual(["ch_09"]);
    expect(
      numbersForOrigin("automation_unnichat", numbers, "conn_umbler", capabilities),
    ).toEqual([]);
  });

  it("usa o cartão e o nome do Unnichat nos avisos", () => {
    expect(hubProviderForInbound("unnichat")).toBe("unnichat");
    expect(providerDisplayName("unnichat")).toBe("Unnichat");
  });

  it("a Payt passa a valer também nos números do Unnichat", () => {
    expect(
      numbersForOrigin("automation_payt", numbers, null, capabilities).map(
        (item) => item.id,
      ),
    ).toContain("ch_09");
    expect(
      resolveRuleConnectionId(
        { origin: "automation_payt", scope: "specific_numbers", channelIds: ["ch_09"], connectionId: null },
        context,
      ),
    ).toBe("conn_unnichat");
  });
});

describe("Unnichat: rascunho e payload", () => {
  it("começa para todos os números da conexão e usa a conexão escolhida", () => {
    expect(emptyRuleDraft("automation_unnichat").scope).toBe("all_numbers");
    expect(resolveRuleConnectionId(draft(), context)).toBe("conn_unnichat");
  });

  it("aceita qualquer evento do catálogo e o contrato compartilhado aceita o que a tela monta", () => {
    for (const eventName of ["QualifiedLead", "InitiateCheckout", "AddToCart", "OrderCreated", "OrderShipped"] as const) {
      const built = buildRulePayload(draft({ eventName, averageValue: "100,00" }), context);
      expect(built).toMatchObject({
        ok: true,
        value: {
          name: "Compra no Unnichat",
          connectionId: "conn_unnichat",
          scope: "all_numbers",
          channelIds: [],
          mode: "observation",
          triggerType: "provider_automation",
          eventName,
        },
      });
      expect(
        providerConversionRuleIdempotentCreateInputSchema.safeParse(
          (built as { value: unknown }).value,
        ).success,
      ).toBe(true);
    }
  });

  it("leva o valor fixo na compra", () => {
    const built = buildRulePayload(
      draft({ eventName: "Purchase", averageValue: "197,00" }),
      context,
    );
    expect(built).toMatchObject({
      ok: true,
      value: { eventName: "Purchase", defaultValueCents: 19700 },
    });
    expect(
      providerConversionRuleIdempotentCreateInputSchema.safeParse(
        (built as { value: unknown }).value,
      ).success,
    ).toBe(true);
  });

  it("não manda frases, etiquetas nem automação da Payt", () => {
    const built = buildRulePayload(draft(), context) as {
      ok: true;
      value: Record<string, unknown>;
    };
    expect(built.value).not.toHaveProperty("automationSource");
    expect(built.value).not.toHaveProperty("triggerPhrases");
    expect(built.value).not.toHaveProperty("perRuleUrl");
  });

  it("exige a conexão e só aceita números dela", () => {
    expect(scopeIssue(draft({ connectionId: null }), context)).toBe(
      "Escolha a conexão que vai chamar o endereço desta regra.",
    );
    expect(
      scopeIssue(
        draft({ scope: "specific_numbers", channelIds: ["ch_01"] }),
        context,
      ),
    ).not.toBeNull();
    expect(
      scopeIssue(
        draft({ scope: "specific_numbers", channelIds: ["ch_09"] }),
        context,
      ),
    ).toBeNull();
  });
});

describe("Unnichat: lista, edição e gerenciar", () => {
  it("mostra a origem, o logo e o detalhe da URL na lista", () => {
    const [row] = buildProviderRuleRows(
      [{ ...unnichatRule, endpoint }],
      numbers,
      connections,
      capabilities,
    );

    expect(row).toMatchObject({
      origin: "automation_unnichat",
      originLabel: "Automação do Unnichat",
      platformLabel: "Unnichat Loja",
      eventLabel: "Compra realizada",
      triggerDetail: "URL da regra criada",
      logo: { src: "/integrations/unnichat.png", surface: "light" },
    });
  });

  it("reconhece a regra do Unnichat pela conexão quando a API não manda a origem", () => {
    const withoutOrigin = { ...unnichatRule };
    delete (withoutOrigin as { origin?: unknown }).origin;
    const [row] = buildProviderRuleRows(
      [withoutOrigin],
      numbers,
      connections,
      capabilities,
    );
    expect(row!.origin).toBe("automation_unnichat");
  });

  it("oferece endereço e eventos recebidos, e valor médio na compra", () => {
    expect(ruleManageTabs("automation_unnichat", unnichatRule).map((tab) => tab.id)).toEqual([
      "edit",
      "endpoint",
      "received",
    ]);
    expect(ruleEditCapabilities(unnichatRule, "automation_unnichat").value).toBe(true);
  });

  it("desenha o logo do Unnichat e um ícone quando não há logo", () => {
    const { container, rerender } = render(
      createElement(RuleLogo, {
        origin: "automation_unnichat",
        logo: { src: "/integrations/unnichat.png", surface: "light", name: "Unnichat" },
      }),
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/integrations/unnichat.png",
    );
    rerender(createElement(RuleLogo, { origin: "automation_unnichat", logo: null }));
    expect(container.querySelector("svg")).toBeTruthy();
  });
});

describe("Unnichat: Nova regra", () => {
  type Action = (formData: FormData) => Promise<ConversionScreenActionResult>;

  function renderFlow(createAction: Action, licenseLocked = false) {
    return render(
      createElement(NewRuleFlow, {
        offeredOrigins: ["message_phrase", "automation_umbler", "automation_unnichat"],
        numbers,
        connections,
        capabilities,
        comingSoonNumbers: [],
        licenseLocked,
        createAction,
        confirmAction: vi.fn(),
        onFinished: () => undefined,
      }),
    );
  }

  it("cria a regra presa à conexão, com qualquer evento, e mostra a URL uma vez com o passo a passo", async () => {
    const user = setupUser();
    const createAction = vi.fn(async (_formData: FormData) => ({
      ok: true,
      ruleId: "rule_unnichat",
      webhookUrl: "https://api.example.test/webhooks/inbound/conversions/e1?token=t",
      message:
        "Regra criada em observação. Copie o endereço agora: ele não é exibido de novo.",
    }));
    renderFlow(createAction);

    await user.click(screen.getByRole("radio", { name: /Automação do Unnichat/ }));
    await user.click(screen.getByRole("button", { name: /Continuar/ }));

    // Evento: todo o catálogo, sem o limite de dois eventos da Umbler.
    const select = screen.getByRole("combobox");
    const options = within(select).getAllByRole("option").map((item) => item.textContent);
    expect(options.length).toBeGreaterThan(4);
    expect(options).toContain("Lead qualificado");
    expect(options).toContain("Compra realizada");
    expect(screen.getByText(/qualquer evento do catálogo/)).toBeTruthy();
    expect(screen.queryByText(/reconhece Lead qualificado e Compra realizada/)).toBeNull();
    await user.selectOptions(select, "Purchase");
    await user.click(screen.getByRole("button", { name: /Continuar/ }));

    // Alcance: a conexão do Unnichat já vem escolhida (é a única).
    expect(screen.getByText("Conexão que chama o endereço")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Continuar/ }));

    // Detalhes: valor e aviso da URL única.
    expect(screen.getByText(/recebe a URL desta regra para colar no fluxo/)).toBeTruthy();
    expect(screen.getByDisplayValue("Automação do Unnichat - Compra realizada")).toBeTruthy();
    // A compra pede o valor fixo (o Unnichat não manda valor).
    await user.type(screen.getByLabelText(/Valor médio/), "197,00");
    await user.click(screen.getByRole("button", { name: "Criar regra" }));

    await screen.findByText("Regra criada");
    const formData = createAction.mock.calls[0]![0] as FormData;
    expect(JSON.parse(String(formData.get("payload")))).toMatchObject({
      triggerType: "provider_automation",
      eventName: "Purchase",
      connectionId: "conn_unnichat",
      scope: "all_numbers",
      mode: "observation",
      defaultValueCents: 19700,
    });
    expect(
      JSON.parse(String(formData.get("payload"))).automationSource,
    ).toBeUndefined();
    // A URL aparece uma única vez, com o passo a passo e o corpo do Unnichat.
    expect(screen.getByText("URL da regra no Unnichat (exibida uma única vez)")).toBeTruthy();
    expect(screen.getByDisplayValue(/token=t/)).toBeTruthy();
    expect(screen.getByText("Configuração no Unnichat")).toBeTruthy();
    expect(screen.getByText(/Automação que marca “Compra realizada”/)).toBeTruthy();
    expect(
      document.querySelector(".unnichat-setup .payload-block")?.textContent,
    ).toContain('"ctwa_clid": "{{ctwa_clid}}"');
    expect(screen.queryByText(/Umbler/)).toBeNull();
  });

  it("mostra o aviso de licença bloqueada quando a API responde 423", async () => {
    const user = setupUser();
    const createAction = vi.fn(async (_formData: FormData) => ({
      ok: false,
      licenseLocked: true,
      message:
        "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.",
    }));
    renderFlow(createAction);

    await user.click(screen.getByRole("radio", { name: /Automação do Unnichat/ }));
    for (let step = 0; step < 3; step += 1) {
      await user.click(screen.getByRole("button", { name: /Continuar/ }));
    }
    await user.click(screen.getByRole("button", { name: "Criar regra" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Licença bloqueada");
  });

  it("desabilita a criação com a licença bloqueada", async () => {
    const user = setupUser();
    renderFlow(vi.fn(), true);

    expect(screen.getByText(/Licença bloqueada/)).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /Automação do Unnichat/ }));
    for (let step = 0; step < 3; step += 1) {
      await user.click(screen.getByRole("button", { name: /Continuar/ }));
    }
    expect(
      (screen.getByRole("button", { name: "Criar regra" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("Unnichat: endereço da regra", () => {
  it("explica como configurar no Unnichat e confirma antes de gerar um novo endereço", async () => {
    const user = setupUser();
    const rotate = vi.fn(async (_formData: FormData) => ({
      ok: true,
      message: "ok",
      oneTimeSecret: {
        ruleId: "rule_unnichat",
        webhookUrl: "https://api.example.test/x?token=novo",
      },
    }));
    const onRotated = vi.fn();
    render(
      createElement(RuleEndpoint, {
        rule: { ...unnichatRule, endpoint },
        origin: "automation_unnichat",
        canManage: true,
        rotateAction: rotate,
        capabilities,
        onRotated,
        onDismiss: () => undefined,
      }),
    );

    expect(
      screen.getByRole("heading", { name: "Como configurar no Unnichat" }),
    ).toBeTruthy();
    expect(screen.getByText(/Automação que marca “Compra realizada”/)).toBeTruthy();
    expect(screen.getByText(/Contato sem/).textContent).toContain("nada é enviado");
    await user.click(screen.getByRole("button", { name: "Gerar novo endereço" }));
    expect(screen.getByText(/cole o novo endereço no Unnichat/)).toBeTruthy();
    expect(rotate).not.toHaveBeenCalled();
  });
});

describe("Unnichat: motivos e recusas em português", () => {
  it.each([
    ["ctwa_missing", /Sem clique do anúncio/],
    ["inbound_webhook_production_unnichat_bind_mismatch", /não confere com a conversa original/],
    ["inbound_webhook_production_unnichat_anything_new", /Envio do Unnichat recusado/],
    ["inbound_webhook_unnichat_channel_binding_missing", /sem o número do cliente/],
    ["unnichat_automation_v1_invalid_payload", /Corpo da automação do Unnichat inválido/],
    ["ctwa_destination_ambiguous", /Mais de um par de página e pixel/],
  ])("traduz %s", (code, expected) => {
    expect(executionReasonLabel(code)).toMatch(expected);
  });
});
