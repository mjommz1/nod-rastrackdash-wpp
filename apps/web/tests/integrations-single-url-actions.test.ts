import { afterEach, describe, expect, it, vi } from "vitest";

const { revalidatePath, serverApiFetch, ApiRequestErrorStub, LicenseLockedErrorStub } =
  vi.hoisted(() => {
    class ApiRequestErrorStub extends Error {
      status: number;
      constructor(message: string, status = 409) {
        super(message);
        this.status = status;
      }
    }
    class LicenseLockedErrorStub extends ApiRequestErrorStub {
      constructor(message = "Licença não utilizável") {
        super(message, 423);
      }
    }
    return {
      revalidatePath: vi.fn(),
      serverApiFetch: vi.fn(),
      ApiRequestErrorStub,
      LicenseLockedErrorStub,
    };
  });

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/lib/server-api", () => ({
  serverApiFetch,
  isApiRequestError: (error: unknown) => error instanceof ApiRequestErrorStub,
  isLicenseLockedError: (error: unknown) => error instanceof LicenseLockedErrorStub,
}));

import {
  ensureIntegrationEndpointAction,
  removeIntegrationEndpointAction,
  retryIntegrationEventAction,
  revealIntegrationEndpointAction,
  rotateIntegrationEndpointAction,
  setRulePublicUrlAction,
} from "../src/app/(app)/integrations/single-url/single-url-actions";
import {
  singleUrlForbiddenMessage,
  singleUrlLicenseLockedNote,
} from "../src/app/(app)/integrations/single-url/single-url-copy";
import { licenseLockedActionMessage } from "../src/lib/license-locked-message";
import { at } from "./conversions-fixtures";

afterEach(() => {
  vi.clearAllMocks();
  serverApiFetch.mockReset();
});

const secretUrl =
  "https://api.exemplo.com.br/webhooks/inbound/integrations/ep_1?token=TOKEN_SECRETO_DE_TESTE";

function endpointBody(url: string | null) {
  return {
    endpoint: {
      id: "ep_1",
      provider: "payt",
      kind: "sales_platform",
      eventName: null,
      url,
      secretVersion: 1,
      parserCertified: true,
      lastDeliveryAt: null,
      lastRoutedAt: null,
      rotatedAt: null,
      createdAt: at,
      stats: { received: 0, routed: 0, unattributed: 0, ignored: 0, invalid: 0 },
    },
  };
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe("ações da URL única: texto padrão do aluno", () => {
  it("o aviso de licença da tela é o mesmo texto padrão das ações", () => {
    expect(singleUrlLicenseLockedNote).toBe(licenseLockedActionMessage);
  });
});

describe("ações da URL única: chamadas à API", () => {
  it("gera a URL da Payt sem evento e devolve a URL só ao chamador", async () => {
    serverApiFetch.mockResolvedValueOnce(endpointBody(secretUrl));

    const result = await ensureIntegrationEndpointAction(form({ provider: "payt" }));

    expect(serverApiFetch).toHaveBeenCalledWith("/integrations/endpoints", {
      method: "POST",
      body: JSON.stringify({ provider: "payt" }),
    });
    expect(result.ok).toBe(true);
    expect(result.endpoint?.url).toBe(secretUrl);
    // A mensagem mostrada na tela nunca carrega a URL com a chave.
    expect(result.message).not.toContain("TOKEN_SECRETO");
  });

  it("Unnichat e Umbler exigem o evento; a Payt não aceita evento", async () => {
    expect(
      (await ensureIntegrationEndpointAction(form({ provider: "unnichat" }))).ok,
    ).toBe(false);
    expect(
      (
        await ensureIntegrationEndpointAction(
          form({ provider: "payt", eventName: "Purchase" }),
        )
      ).ok,
    ).toBe(false);
    expect(serverApiFetch).not.toHaveBeenCalled();

    serverApiFetch.mockResolvedValueOnce(endpointBody(secretUrl));
    const ok = await ensureIntegrationEndpointAction(
      form({ provider: "unnichat", eventName: "QualifiedLead" }),
    );
    expect(ok.ok).toBe(true);
    expect(serverApiFetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ provider: "unnichat", eventName: "QualifiedLead" }),
    });
  });

  it("mostrar a URL é um POST em /reveal e não atualiza a página", async () => {
    serverApiFetch.mockResolvedValueOnce(endpointBody(secretUrl));

    const result = await revealIntegrationEndpointAction(form({ endpointId: "ep_1" }));

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/integrations/endpoints/ep_1/reveal",
      { method: "POST" },
    );
    expect(result.endpoint?.url).toBe(secretUrl);
    expect(result.message).toContain("registrada");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("girar e remover usam as rotas certas e atualizam Integrações e Conversões", async () => {
    serverApiFetch.mockResolvedValueOnce(endpointBody(secretUrl));
    const rotated = await rotateIntegrationEndpointAction(form({ endpointId: "ep_1" }));
    expect(serverApiFetch).toHaveBeenLastCalledWith(
      "/integrations/endpoints/ep_1/rotate",
      { method: "POST" },
    );
    expect(rotated.message).toContain("A anterior parou de funcionar");

    serverApiFetch.mockResolvedValueOnce(undefined);
    const removed = await removeIntegrationEndpointAction(form({ endpointId: "ep_1" }));
    expect(serverApiFetch).toHaveBeenLastCalledWith("/integrations/endpoints/ep_1", {
      method: "DELETE",
    });
    expect(removed.ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/integrations");
    expect(revalidatePath).toHaveBeenCalledWith("/conversions");
  });

  it("recusa ids com caracteres perigosos sem chamar a API", async () => {
    const result = await revealIntegrationEndpointAction(
      form({ endpointId: "../../admin" }),
    );
    expect(result.ok).toBe(false);
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("Tentar de novo diz se entregou ou se continua sem atribuição", async () => {
    serverApiFetch.mockResolvedValueOnce({
      eventId: "ev_1",
      status: "routed",
      reasonCode: null,
      providerRuleId: "rule_1",
      deliveryId: "del_1",
    });
    const routed = await retryIntegrationEventAction(form({ eventId: "ev_1" }));
    expect(serverApiFetch).toHaveBeenLastCalledWith(
      "/integrations/endpoints/events/ev_1/retry",
      { method: "POST" },
    );
    expect(routed.message).toContain("Entregue");

    serverApiFetch.mockResolvedValueOnce({
      eventId: "ev_1",
      status: "unattributed",
      reasonCode: "product_without_rule",
      providerRuleId: null,
      deliveryId: null,
    });
    const still = await retryIntegrationEventAction(form({ eventId: "ev_1" }));
    expect(still.message).toContain("Ainda sem atribuição");
  });
});

describe("ações da URL única: desativar e reativar a URL antiga", () => {
  const ruleBody = (publicUrlDisabledAt: string | null) => ({
    id: "rule_1",
    workspaceId: "workspace_1",
    conversionRule: {
      id: "cr_1",
      workspaceId: "workspace_1",
      name: "Venda",
      triggerType: "provider_automation",
      triggerValue: "x",
      matchMode: "exact",
      eventName: "Purchase",
      pixelId: null,
      defaultValueCents: null,
      defaultCurrency: null,
      defaultContentName: null,
      defaultItems: null,
      active: true,
      createdAt: at,
      updatedAt: at,
    },
    connectionId: null,
    mode: "observation",
    parserReleaseId: null,
    productionActivatedAt: null,
    channelIds: [],
    triggerPhrases: [],
    messageAuthorScope: null,
    endpoint: {
      id: "ep_old",
      workspaceId: "workspace_1",
      providerRuleId: "rule_1",
      secretVersion: 1,
      lastDeliveryAt: null,
      lastSuccessfulParseAt: null,
      rotatedAt: null,
      removedAt: null,
      publicUrlDisabledAt,
      createdAt: at,
      updatedAt: at,
    },
    catalog: null,
    lastExecution: null,
    createdAt: at,
    updatedAt: at,
  });

  it("desativar envia a confirmação obrigatória", async () => {
    serverApiFetch.mockResolvedValueOnce(ruleBody(at));

    const result = await setRulePublicUrlAction(
      form({ ruleId: "rule_1", disabled: "true" }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/conversion-rules/providers/rule_1",
      {
        method: "PATCH",
        body: JSON.stringify({
          publicUrlDisabled: true,
          confirmPublicUrlDisable: true,
        }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.publicUrlDisabledAt).toBe(at);
  });

  it("reativar não leva a confirmação", async () => {
    serverApiFetch.mockResolvedValueOnce(ruleBody(null));

    const result = await setRulePublicUrlAction(
      form({ ruleId: "rule_1", disabled: "false" }),
    );

    expect(serverApiFetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ publicUrlDisabled: false }),
    });
    expect(result.publicUrlDisabledAt).toBeNull();
    expect(result.message).toBe("URL antiga reativada.");
  });
});

describe("ações da URL única: erros", () => {
  it("423 mostra a mensagem padrão do aluno e marca licenseLocked", async () => {
    serverApiFetch.mockRejectedValueOnce(new LicenseLockedErrorStub());

    const result = await rotateIntegrationEndpointAction(form({ endpointId: "ep_1" }));

    expect(result).toEqual({
      ok: false,
      licenseLocked: true,
      message: licenseLockedActionMessage,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("423 vale para criar, remover, tentar de novo e desativar", async () => {
    for (const run of [
      () => ensureIntegrationEndpointAction(form({ provider: "payt" })),
      () => removeIntegrationEndpointAction(form({ endpointId: "ep_1" })),
      () => retryIntegrationEventAction(form({ eventId: "ev_1" })),
      () => setRulePublicUrlAction(form({ ruleId: "r", disabled: "true" })),
    ]) {
      serverApiFetch.mockRejectedValueOnce(new LicenseLockedErrorStub());
      const result = await run();
      expect(result.licenseLocked).toBe(true);
      expect(result.message).toBe(licenseLockedActionMessage);
    }
  });

  it("403 diz que falta permissão para gerenciar integrações", async () => {
    serverApiFetch.mockRejectedValueOnce(new ApiRequestErrorStub("Forbidden", 403));

    const result = await revealIntegrationEndpointAction(form({ endpointId: "ep_1" }));

    expect(result).toEqual({ ok: false, message: singleUrlForbiddenMessage });
  });

  it("erro inesperado vira uma frase simples, sem detalhes da API", async () => {
    serverApiFetch.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.1"));

    const result = await rotateIntegrationEndpointAction(form({ endpointId: "ep_1" }));

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("ECONNREFUSED");
  });

  it("resposta fora do contrato não vira sucesso", async () => {
    serverApiFetch.mockResolvedValueOnce({ endpoint: { id: "ep_1" } });

    const result = await revealIntegrationEndpointAction(form({ endpointId: "ep_1" }));

    expect(result.ok).toBe(false);
    expect(result.endpoint).toBeUndefined();
  });
});
