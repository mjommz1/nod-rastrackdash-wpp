// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type {
  IntegrationDetectedProductDto,
  IntegrationEndpointDto,
  IntegrationLegacyUrlDto,
  IntegrationUnattributedEventListDto,
} from "@wpptrack/shared";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SingleUrlActionResult } from "../src/app/(app)/integrations/single-url/single-url-actions";
import {
  disableLegacyUrlConfirmText,
  findEventEndpoint,
  legacyUrlState,
  mergeEndpoints,
  normalizeManualProductCode,
  productCodeSeen,
  productFilterOptions,
  rotateConfirmText,
  singleUrlSetupSteps,
  statsSummary,
  supportedEvents,
} from "../src/app/(app)/integrations/single-url/single-url-copy";
import {
  AutomationEventUrlsPanel,
  IntegrationUrlBox,
  PaytSingleUrlPanel,
  ProductFilterPicker,
  UnattributedSalesList,
  type SingleUrlActions,
} from "../src/app/(app)/integrations/single-url/single-url-panels";
import { buildIntegrationCards } from "../src/app/(app)/integrations/hub/integration-cards";
import {
  buildRulePayload,
  emptyRuleDraft,
} from "../src/app/(app)/conversions/rule-draft";
import {
  buildRuleUpdatePayload,
  ruleEditCapabilities,
  ruleEditDraft,
} from "../src/app/(app)/conversions/rule-edit";
import { RuleEndpoint } from "../src/app/(app)/conversions/rule-endpoint";
import { setupUser } from "./user-shim";
import {
  at,
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

const secretUrl =
  "https://api.exemplo.com.br/webhooks/inbound/integrations/ep_payt?token=TOKEN_SECRETO_DE_TESTE";

function endpoint(
  patch: Partial<IntegrationEndpointDto> = {},
): IntegrationEndpointDto {
  return {
    id: "ep_payt",
    provider: "payt",
    kind: "sales_platform",
    eventName: null,
    url: null,
    secretVersion: 1,
    parserCertified: true,
    lastDeliveryAt: "2026-10-18T13:00:00.000Z",
    lastRoutedAt: "2026-10-18T12:00:00.000Z",
    rotatedAt: null,
    createdAt: at,
    stats: { received: 12, routed: 9, unattributed: 2, ignored: 1, invalid: 0 },
    ...patch,
  };
}

function actions(patch: Partial<SingleUrlActions> = {}): SingleUrlActions {
  const none = vi.fn(
    async (): Promise<SingleUrlActionResult> => ({ ok: false, message: "x" }),
  );
  return {
    ensure: none,
    reveal: none,
    rotate: none,
    remove: none,
    retry: none,
    setPublicUrl: none,
    ...patch,
  };
}

const unattributed: IntegrationUnattributedEventListDto = {
  total: 2,
  items: [
    {
      id: "ev_1",
      provider: "payt",
      eventName: "Purchase",
      productCode: "4O9J39",
      productName: "Curso Avançado",
      offerCode: null,
      valueCents: 19700,
      currency: "BRL",
      reasonCode: "product_without_rule",
      reasonLabel: "Produto sem regra",
      attemptCount: 2,
      firstReceivedAt: at,
      lastReceivedAt: at,
      retryable: true,
    },
    {
      id: "ev_2",
      provider: "payt",
      eventName: "InitiateCheckout",
      productCode: null,
      productName: null,
      offerCode: null,
      valueCents: null,
      currency: null,
      reasonCode: "buyer_not_whatsapp_lead",
      reasonLabel: "Comprador não é lead do WhatsApp",
      attemptCount: 1,
      firstReceivedAt: at,
      lastReceivedAt: at,
      retryable: false,
    },
  ],
};

const products: IntegrationDetectedProductDto[] = [
  {
    provider: "payt",
    productCode: "4O9J39",
    productName: "Curso Avançado",
    offerCode: "OFR123",
    offerName: "Oferta de lançamento",
    lastSeenAt: at,
  },
];

const legacyUrls: IntegrationLegacyUrlDto[] = [
  {
    providerRuleId: "rule_old",
    ruleName: "Compra aprovada (antiga)",
    eventName: "Purchase",
    provider: "payt",
    scope: "all_numbers",
    channelIds: [],
    lastDeliveryAt: "2026-10-17T10:00:00.000Z",
    publicUrlDisabledAt: null,
  },
  {
    providerRuleId: "rule_off",
    ruleName: "Pix gerado (antiga)",
    eventName: "InitiateCheckout",
    provider: "payt",
    scope: "specific_numbers",
    channelIds: ["canal_a"],
    lastDeliveryAt: null,
    publicUrlDisabledAt: at,
  },
];

describe("URL única: decisões puras", () => {
  it("lista os eventos de cada plataforma", () => {
    expect(supportedEvents("payt")).toEqual([
      "Purchase",
      "InitiateCheckout",
      "CartAbandoned",
    ]);
    expect(supportedEvents("umbler")).toEqual(["QualifiedLead", "Purchase"]);
    expect(supportedEvents("unnichat")).toContain("ViewContent");
  });

  it("achar a URL: a Payt é uma só; Unnichat e Umbler são por evento", () => {
    const list = [
      endpoint(),
      endpoint({ id: "ep_u1", provider: "unnichat", eventName: "Purchase", kind: "automation_event" }),
    ];
    expect(findEventEndpoint(list, "payt", null)?.id).toBe("ep_payt");
    expect(findEventEndpoint(list, "unnichat", "Purchase")?.id).toBe("ep_u1");
    expect(findEventEndpoint(list, "unnichat", "QualifiedLead")).toBeNull();
    expect(findEventEndpoint(list, "umbler", "Purchase")).toBeNull();
  });

  it("junta a lista do servidor com a URL recém-criada sem perder a URL", () => {
    const created = endpoint({ url: secretUrl });
    const fresh = endpoint({ stats: { ...endpoint().stats, received: 13 } });

    const merged = mergeEndpoints([fresh], [created]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.url).toBe(secretUrl);
    expect(merged[0]?.stats.received).toBe(13);
    expect(mergeEndpoints([], [created])[0]?.id).toBe("ep_payt");
    expect(mergeEndpoints([fresh], [], ["ep_payt"])).toEqual([]);
  });

  it("normaliza o código de produto digitado", () => {
    expect(normalizeManualProductCode(" 4o9j39 ")).toBe("4O9J39");
    expect(normalizeManualProductCode("com espaço")).toBeNull();
    expect(normalizeManualProductCode("")).toBeNull();
  });

  it("sabe se um código já apareceu em uma venda", () => {
    expect(productCodeSeen("4o9j39", products)).toBe(true);
    expect(productCodeSeen("ofr123", products)).toBe(true);
    expect(productCodeSeen("ZZZ999", products)).toBe(false);
    expect(productFilterOptions(products).map((option) => option.code)).toEqual([
      "4O9J39",
      "OFR123",
    ]);
  });

  it("estado da URL antiga", () => {
    expect(legacyUrlState({ publicUrlDisabledAt: at, lastDeliveryAt: null }).label).toBe(
      "URL antiga desativada",
    );
    expect(legacyUrlState({ publicUrlDisabledAt: null, lastDeliveryAt: at }).tone).toBe(
      "warn",
    );
    expect(
      legacyUrlState({ publicUrlDisabledAt: null, lastDeliveryAt: null }).label,
    ).toBe("URL antiga ativa (sem recebimentos)");
  });

  it("textos de confirmação avisam o que acontece", () => {
    expect(rotateConfirmText("payt")).toContain("para de funcionar na hora");
    expect(disableLegacyUrlConfirmText("payt")).toContain("Dá para reativar");
    expect(disableLegacyUrlConfirmText("unnichat")).toContain("o Unnichat");
    expect(statsSummary(endpoint().stats)).toBe(
      "12 recebidos: 9 com regra, 2 sem atribuição, 1 ignorado, 0 inválidos",
    );
  });

  it("o passo a passo de cada plataforma fala do evento certo", () => {
    expect(singleUrlSetupSteps("payt").join(" ")).toContain("URL única");
    expect(singleUrlSetupSteps("umbler", "QualifiedLead").join(" ")).toContain(
      "channel.phone",
    );
    expect(singleUrlSetupSteps("unnichat", "Purchase").join(" ")).toContain(
      "ctwa_clid",
    );
  });
});

describe("IntegrationUrlBox: mostrar, copiar, girar e remover", () => {
  it("a listagem não traz a URL: mostrar é auditado e a URL só aparece depois do clique", async () => {
    const user = setupUser();
    const reveal = vi.fn(async () => ({
      ok: true,
      message: "URL exibida.",
      endpoint: endpoint({ url: secretUrl }),
    }));
    render(
      createElement(IntegrationUrlBox, {
        endpoint: endpoint(),
        label: "URL única",
        canManage: true,
        actions: actions({ reveal }),
      }),
    );

    expect(document.body.textContent).not.toContain("TOKEN_SECRETO");
    expect(screen.getByText(/registra quem viu e quando/u)).toBeTruthy();
    expect(screen.getByText("12 recebidos: 9 com regra, 2 sem atribuição, 1 ignorado, 0 inválidos")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Mostrar URL/u }));

    await waitFor(() =>
      expect((screen.getByLabelText("URL única") as HTMLInputElement).value).toBe(secretUrl),
    );
    const sent = reveal.mock.calls[0] as unknown as [FormData];
    expect(sent[0].get("endpointId")).toBe("ep_payt");
    expect(screen.getByRole("button", { name: /Copiar URL/u })).toBeTruthy();

    // Ocultar tira a URL da tela.
    await user.click(screen.getByRole("button", { name: /Ocultar URL/u }));
    expect(document.body.textContent).not.toContain("TOKEN_SECRETO");
    expect(screen.getByRole("button", { name: /Mostrar URL/u })).toBeTruthy();
  });

  it("nunca guarda a URL no armazenamento do navegador nem no endereço da página", async () => {
    const user = setupUser();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(
      createElement(IntegrationUrlBox, {
        endpoint: endpoint({ url: secretUrl }),
        label: "URL única",
        canManage: true,
        actions: actions(),
      }),
    );
    await user.click(screen.getByRole("button", { name: /Gerar nova URL/u }));

    expect(setItem).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain("TOKEN_SECRETO");
    expect(window.location.search).toBe("");
    setItem.mockRestore();
  });

  it("girar pede confirmação, avisa que a antiga para e mostra a nova", async () => {
    const user = setupUser();
    const rotate = vi.fn(async () => ({
      ok: true,
      message: "Nova URL gerada. A anterior parou de funcionar: cole a nova na plataforma.",
      endpoint: endpoint({ url: secretUrl, secretVersion: 2 }),
    }));
    render(
      createElement(IntegrationUrlBox, {
        endpoint: endpoint(),
        label: "URL única",
        canManage: true,
        actions: actions({ rotate }),
      }),
    );

    await user.click(screen.getByRole("button", { name: /Gerar nova URL/u }));
    expect(rotate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("para de funcionar na hora");

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(rotate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Gerar nova URL/u }));
    await user.click(screen.getAllByRole("button", { name: "Gerar nova URL" }).at(-1)!);

    await waitFor(() =>
      expect((screen.getByLabelText("URL única") as HTMLInputElement).value).toBe(secretUrl),
    );
    expect(screen.getByText(/A anterior parou de funcionar/u)).toBeTruthy();
  });

  it("remover pede confirmação e avisa o ponto pai", async () => {
    const user = setupUser();
    const remove = vi.fn(async () => ({ ok: true, message: "URL removida." }));
    const onRemoved = vi.fn();
    render(
      createElement(IntegrationUrlBox, {
        endpoint: endpoint(),
        label: "URL única",
        canManage: true,
        actions: actions({ remove }),
        onRemoved,
      }),
    );

    await user.click(screen.getByRole("button", { name: /Remover URL/u }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("deixa de funcionar na hora");
    await user.click(screen.getAllByRole("button", { name: "Remover URL" }).at(-1)!);

    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith("ep_payt"));
  });

  it("423 na revelação mostra a mensagem padrão e não revela nada", async () => {
    const user = setupUser();
    const reveal = vi.fn(async () => ({
      ok: false,
      licenseLocked: true,
      message: "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.",
    }));
    render(
      createElement(IntegrationUrlBox, {
        endpoint: endpoint(),
        label: "URL única",
        canManage: true,
        actions: actions({ reveal }),
      }),
    );
    await user.click(screen.getByRole("button", { name: /Mostrar URL/u }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Licença bloqueada"),
    );
    expect(screen.queryByLabelText("URL única")).toBeNull();
  });

  it("com a licença bloqueada os controles de escrita ficam desabilitados", () => {
    render(
      createElement(IntegrationUrlBox, {
        endpoint: endpoint(),
        label: "URL única",
        canManage: true,
        licenseLocked: true,
        actions: actions(),
      }),
    );

    expect(
      (screen.getByRole("button", { name: /Mostrar URL/u }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /Gerar nova URL/u }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Licença bloqueada/u)).toBeTruthy();
  });

  it("membro sem permissão só lê: contadores e datas, sem botões de escrita", () => {
    render(
      createElement(IntegrationUrlBox, {
        endpoint: endpoint(),
        label: "URL única",
        canManage: false,
        actions: actions(),
      }),
    );

    expect(screen.getByText(/Só quem gerencia integrações/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mostrar URL/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Gerar nova URL/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remover URL/u })).toBeNull();
    expect(screen.getByText("Último recebimento")).toBeTruthy();
  });
});

describe("Vendas sem atribuição", () => {
  it("mostra o motivo e permite tentar de novo só quando o corpo ainda existe", async () => {
    const user = setupUser();
    const retry = vi.fn(async () => ({
      ok: true,
      message: "Entregue à regra do número de origem.",
    }));
    render(
      createElement(UnattributedSalesList, {
        list: unattributed,
        canManage: true,
        retry,
      }),
    );

    expect(screen.getByText("Produto sem regra")).toBeTruthy();
    expect(screen.getByText("Comprador não é lead do WhatsApp")).toBeTruthy();
    const retries = screen.getAllByRole("button", { name: /Tentar de novo/u });
    expect(retries).toHaveLength(1);
    expect(screen.getByText(/não dá para tentar de novo/u)).toBeTruthy();

    await user.click(retries[0]!);

    await waitFor(() =>
      expect(screen.getByText("Entregue à regra do número de origem.")).toBeTruthy(),
    );
    expect((retry.mock.calls[0] as unknown as [FormData])[0].get("eventId")).toBe("ev_1");
  });

  it("membro não vê o botão e a lista vazia explica", () => {
    const { rerender } = render(
      createElement(UnattributedSalesList, {
        list: unattributed,
        canManage: false,
        retry: vi.fn(),
      }),
    );
    expect(screen.queryByRole("button", { name: /Tentar de novo/u })).toBeNull();

    rerender(
      createElement(UnattributedSalesList, {
        list: { total: 0, items: [] },
        canManage: true,
        retry: vi.fn(),
      }),
    );
    expect(screen.getByText(/Nada sem atribuição/u)).toBeTruthy();

    rerender(
      createElement(UnattributedSalesList, {
        list: null,
        canManage: true,
        retry: vi.fn(),
      }),
    );
    expect(screen.getByText(/Não deu para ler esta lista/u)).toBeTruthy();
  });
});

describe("Modal da Payt", () => {
  function paytPanel(props: Partial<Parameters<typeof PaytSingleUrlPanel>[0]> = {}) {
    return createElement(PaytSingleUrlPanel, {
      endpoint: endpoint(),
      products,
      unattributed,
      legacyUrls,
      ruleEvents: ["Purchase"],
      canManage: true,
      actions: actions(),
      numberNames: { canal_a: "Atendimento 1" },
      ...props,
    });
  }

  it("mostra a URL única, os produtos detectados, as vendas sem atribuição e as URLs antigas", () => {
    render(paytPanel());

    expect(screen.getByText("URL única da Payt")).toBeTruthy();
    expect(screen.getByText("Produtos detectados")).toBeTruthy();
    expect(screen.getByText("Curso Avançado")).toBeTruthy();
    expect(screen.getByText("Vendas sem atribuição")).toBeTruthy();
    expect(screen.getByText("URLs antigas")).toBeTruthy();
    expect(screen.getByText("Compra aprovada (antiga)")).toBeTruthy();
    expect(screen.getByText("Com regra ativa")).toBeTruthy();
    expect(screen.getAllByText("Sem regra (não é enviado)")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("TOKEN_SECRETO");
  });

  it("sem URL ainda, quem gerencia vê o botão de gerar e membro vê o aviso", () => {
    const { unmount } = render(paytPanel({ endpoint: null }));
    expect(screen.getByRole("button", { name: /Gerar URL única/u })).toBeTruthy();
    unmount();

    render(paytPanel({ endpoint: null, canManage: false }));
    expect(screen.queryByRole("button", { name: /Gerar URL única/u })).toBeNull();
    expect(screen.getByText(/Peça a quem gerencia integrações/u)).toBeTruthy();
  });

  it("desativar a URL antiga exige confirmação e envia o pedido da regra", async () => {
    const user = setupUser();
    const setPublicUrl = vi.fn(async () => ({
      ok: true,
      message: "URL antiga desativada. A regra continua recebendo pela URL nova.",
      publicUrlDisabledAt: at,
    }));
    render(paytPanel({ actions: actions({ setPublicUrl }) }));

    expect(screen.getAllByText(/último recebimento pela URL antiga/u)).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Desativar URL antiga" }));
    expect(setPublicUrl).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Dá para reativar");

    await user.click(
      within(screen.getByRole("alert")).getByRole("button", { name: "Desativar URL antiga" }),
    );

    await waitFor(() => expect(setPublicUrl).toHaveBeenCalledTimes(1));
    const sent = (setPublicUrl.mock.calls[0] as unknown as [FormData])[0];
    expect(sent.get("ruleId")).toBe("rule_old");
    expect(sent.get("disabled")).toBe("true");
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Reativar URL antiga" })).toHaveLength(2),
    );
  });

  it("reativar a URL antiga não pede confirmação", async () => {
    const user = setupUser();
    const setPublicUrl = vi.fn(async () => ({
      ok: true,
      message: "URL antiga reativada.",
      publicUrlDisabledAt: null,
    }));
    render(paytPanel({ actions: actions({ setPublicUrl }) }));

    await user.click(screen.getByRole("button", { name: "Reativar URL antiga" }));

    await waitFor(() => expect(setPublicUrl).toHaveBeenCalledTimes(1));
    expect(
      (setPublicUrl.mock.calls[0] as unknown as [FormData])[0].get("disabled"),
    ).toBe("false");
  });

  it("membro vê as URLs antigas mas não os botões", () => {
    render(paytPanel({ canManage: false }));
    expect(screen.getByText("Compra aprovada (antiga)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /URL antiga/u })).toBeNull();
  });
});

describe("Modal do Unnichat: URLs por evento", () => {
  const unnichatEndpoints = [
    endpoint({
      id: "ep_u_q",
      provider: "unnichat",
      kind: "automation_event",
      eventName: "QualifiedLead",
    }),
  ];

  function panel(props: Partial<Parameters<typeof AutomationEventUrlsPanel>[0]> = {}) {
    return createElement(AutomationEventUrlsPanel, {
      provider: "unnichat",
      endpoints: unnichatEndpoints,
      unattributed: { total: 0, items: [] },
      legacyUrls: [],
      ruleEvents: ["QualifiedLead", "Purchase"],
      canManage: true,
      actions: actions(),
      ...props,
    });
  }

  it("lista um bloco por evento com regra: URL existente e botão de gerar para o que falta", () => {
    render(panel());

    expect(screen.getByText("URLs por evento")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Mostrar URL/u })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Gerar URL de/u })).toHaveLength(1);
    expect(screen.getByText("Eventos sem atribuição")).toBeTruthy();
    expect(screen.getByText(/Nenhuma regra tem URL própria/u)).toBeTruthy();
  });

  it("gerar a URL de um evento chama a ação com o evento e mostra a URL", async () => {
    const user = setupUser();
    const ensure = vi.fn(async () => ({
      ok: true,
      message: "URL pronta.",
      endpoint: endpoint({
        id: "ep_u_p",
        provider: "unnichat",
        kind: "automation_event",
        eventName: "Purchase",
        url: secretUrl,
      }),
    }));
    render(panel({ actions: actions({ ensure }) }));

    await user.click(screen.getByRole("button", { name: /^Gerar URL de/u }));

    await waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
    const sent = (ensure.mock.calls[0] as unknown as [FormData])[0];
    expect(sent.get("provider")).toBe("unnichat");
    expect(sent.get("eventName")).toBe("Purchase");
    await waitFor(() =>
      expect(
        screen.getAllByDisplayValue(secretUrl).length,
      ).toBe(1),
    );
  });

  it("outro evento exige confirmação antes de gerar", async () => {
    const user = setupUser();
    const ensure = vi.fn(async () => ({ ok: false, message: "x" }));
    render(panel({ ruleEvents: ["QualifiedLead"], actions: actions({ ensure }) }));

    await user.click(screen.getByText("Gerar URL de outro evento"));
    await user.click(screen.getByRole("button", { name: "Compra realizada" }));
    expect(ensure).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Ela só envia algo à Meta");
  });

  it("Umbler só oferece Lead qualificado e Compra", () => {
    render(panel({ provider: "umbler", endpoints: [], ruleEvents: [] }));
    expect(screen.getByText("Gerar URL de outro evento")).toBeTruthy();
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });
});

describe("Filtro de produto", () => {
  it("marca produtos detectados e adiciona código digitado com aviso de não visto", async () => {
    const user = setupUser();
    const onChange = vi.fn();
    const { rerender } = render(
      createElement(ProductFilterPicker, { products, selected: [], onChange }),
    );

    expect(screen.getByText("Produtos (opcional)")).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: /Curso Avançado/u }));
    expect(onChange).toHaveBeenLastCalledWith(["4O9J39"]);

    await user.type(screen.getByLabelText("Código digitado"), "zzz999");
    await user.click(screen.getByRole("button", { name: "Adicionar código" }));
    expect(onChange).toHaveBeenLastCalledWith(["ZZZ999"]);

    rerender(
      createElement(ProductFilterPicker, {
        products,
        selected: ["ZZZ999"],
        onChange,
      }),
    );
    expect(screen.getByText(/Código ainda não visto em nenhuma venda/u)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remover" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("recusa código com caracteres inválidos", async () => {
    const user = setupUser();
    const onChange = vi.fn();
    render(createElement(ProductFilterPicker, { products: [], selected: [], onChange }));

    expect(screen.getByText(/Nenhum produto visto ainda/u)).toBeTruthy();
    await user.type(screen.getByLabelText("Código digitado"), "abc def");
    await user.click(screen.getByRole("button", { name: "Adicionar código" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Digite só o código");
  });
});

describe("Regra da Payt: filtro de produto e URL nova", () => {
  const draft = {
    ...emptyRuleDraft("automation_payt"),
    name: "Venda Payt",
  };
  const context = { numbers, connections, capabilities: capabilitiesWithPayt };

  it("envia os códigos do filtro e, com a URL única ativa, cria a regra sem URL própria", () => {
    const withFilter = buildRulePayload(
      { ...draft, productCodes: ["4O9J39"] },
      { ...context, singleUrl: true },
    );
    expect(withFilter.ok && withFilter.value).toMatchObject({
      productFilterCodes: ["4O9J39"],
      perRuleUrl: false,
    });

    const plain = buildRulePayload(draft, context);
    expect(plain.ok && "productFilterCodes" in plain.value).toBe(false);
    expect(plain.ok && "perRuleUrl" in plain.value).toBe(false);
  });

  it("a edição só manda o filtro quando ele mudou e [] volta a aceitar todos", () => {
    const rule = {
      ...providerRule({
        id: "rule_payt",
        name: "Venda aprovada",
        origin: "automation_payt",
        triggerType: "provider_automation",
        eventName: "Purchase",
        connectionId: "conn_umbler",
        scope: "all_numbers",
        phrases: [],
        automationSource: "payt",
      }),
      productFilterCodes: ["4O9J39"],
    };
    expect(ruleEditCapabilities(rule, "automation_payt").productFilter).toBe(true);
    const base = ruleEditDraft(rule, "automation_payt");
    expect(base.productCodes).toEqual(["4O9J39"]);

    const unchanged = buildRuleUpdatePayload(rule, base, context);
    expect(unchanged.ok && unchanged.value).toEqual({});

    const cleared = buildRuleUpdatePayload(rule, { ...base, productCodes: [] }, context);
    expect(cleared.ok && cleared.value).toEqual({ productFilterCodes: [] });

    const changed = buildRuleUpdatePayload(
      rule,
      { ...base, productCodes: ["4o9j39", "ofr123"] },
      context,
    );
    expect(changed.ok && changed.value).toEqual({
      productFilterCodes: ["4O9J39", "OFR123"],
    });
  });

  it("dentro da regra: mostra a URL única e a URL antiga com a opção de desativar", async () => {
    const user = setupUser();
    const rule = {
      ...providerRule({
        id: "rule_payt",
        name: "Venda aprovada",
        origin: "automation_payt",
        triggerType: "provider_automation",
        eventName: "Purchase",
        connectionId: "conn_umbler",
        scope: "all_numbers",
        phrases: [],
        automationSource: "payt",
      }),
      endpoint: {
        id: "ep_old",
        workspaceId: "workspace_1",
        providerRuleId: "rule_payt",
        secretVersion: 1,
        lastDeliveryAt: at,
        lastSuccessfulParseAt: at,
        rotatedAt: null,
        removedAt: null,
        publicUrlDisabledAt: null,
        createdAt: at,
        updatedAt: at,
      },
    };
    const setPublicUrl = vi.fn(async () => ({
      ok: true,
      message: "URL antiga desativada. A regra continua recebendo pela URL nova.",
      publicUrlDisabledAt: at,
    }));
    render(
      createElement(RuleEndpoint, {
        rule,
        origin: "automation_payt",
        canManage: true,
        rotateAction: vi.fn(),
        onRotated: () => undefined,
        onDismiss: () => undefined,
        integrationEndpoint: endpoint(),
        singleUrlActions: actions({ setPublicUrl }),
      }),
    );

    expect(screen.getByRole("heading", { name: "URL única" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Mostrar URL/u })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "URL antiga desta regra" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Desativar URL antiga" }));
    await user.click(
      within(screen.getByRole("alert")).getByRole("button", { name: "Desativar URL antiga" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reativar URL antiga" })).toBeTruthy(),
    );
    expect(
      (setPublicUrl.mock.calls[0] as unknown as [FormData])[0].get("disabled"),
    ).toBe("true");
  });
});

describe("Card da Payt no Hub", () => {
  it("URL criada e nenhuma regra ainda fica ativo com aviso", () => {
    const cards = buildIntegrationCards({
      inbound: null,
      whatsapp: { loaded: true, connections: [], legacyUazapiInstances: 0 },
      payt: { loaded: true, ruleCount: 0, activeRuleCount: 0, integrationUrl: true },
      crm: {
        kommo: { loadState: "empty", statuses: [] },
        pipedrive: { loadState: "empty", statuses: [] },
      },
      meta: { connected: false, needsAttention: false, statusLabel: "Pendente" },
    });
    const payt = cards.find((card) => card.id === "payt");

    expect(payt?.status.label).toBe("URL criada, sem regras");
  });
});
