import { afterEach, describe, expect, it, vi } from "vitest";

const { isApiRequestError, isLicenseLockedError, revalidatePath, serverApiFetch } =
  vi.hoisted(() => ({
    isApiRequestError: vi.fn(
      (error: unknown) =>
        error instanceof Error &&
        (error.name === "ApiRequestError" || error.name === "LicenseLockedError"),
    ),
    isLicenseLockedError: vi.fn(
      (error: unknown) => error instanceof Error && error.name === "LicenseLockedError",
    ),
    revalidatePath: vi.fn(),
    serverApiFetch: vi.fn(),
  }));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../src/lib/server-api", () => ({
  isApiRequestError,
  isLicenseLockedError,
  serverApiFetch,
}));

import {
  adaptProviderConversionRuleAction,
  confirmConversionRuleCreateAction,
  createConversionRuleAction,
  loadProviderConversionExecutionAuditAction,
  removeProviderConversionRuleAction,
  rotateProviderConversionRuleEndpointAction,
  unifyConversionRulesAction,
  updateLegacyRuleAction,
  updateProviderConversionRuleAction,
} from "../src/app/(app)/conversions/actions";
import { at, providerRule } from "./conversions-fixtures";

const requestKey = "prc_0123456789abcdef0123456789abcdef";
const globalPayload = {
  name: "Qualificado",
  scope: "all_numbers",
  channelIds: [],
  mode: "observation",
  triggerType: "message_phrase",
  eventName: "QualifiedLead",
  valueMode: "fixed",
  exampleMessage: null,
  triggerPhrases: ["vou te passar os valores"],
  messageAuthorScope: "team",
};

function apiError(status: number, message: string, code?: string) {
  return Object.assign(new Error(message), {
    name: "ApiRequestError",
    status,
    ...(code ? { code } : {}),
  });
}

function licenseLocked() {
  return Object.assign(new Error("Licença bloqueada"), {
    name: "LicenseLockedError",
    status: 423,
  });
}

const lockedMessage =
  "Licença bloqueada: alterações indisponíveis. Verifique /backoffice/license.";

function createForm(payload: unknown = globalPayload, key = requestKey) {
  const formData = new FormData();
  formData.set("requestKey", key);
  formData.set("payload", JSON.stringify(payload));
  return formData;
}

afterEach(() => {
  vi.clearAllMocks();
  serverApiFetch.mockReset();
});

describe("conversions actions: create", () => {
  it("creates a rule without connection and accepts its connection-less receipt", async () => {
    const rule = providerRule({ id: "rule_1", scope: "all_numbers" });
    serverApiFetch.mockResolvedValueOnce({
      outcome: "created",
      receipt: { ruleId: "rule_1", connectionId: null, createdAt: rule.createdAt },
      rule,
      webhookUrl: null,
    });

    const result = await createConversionRuleAction(createForm());

    const [path, init] = serverApiFetch.mock.calls[0]!;
    expect(path).toBe("/conversion-rules/providers");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Idempotency-Key": requestKey },
    });
    // No connection is invented for a rule of every number.
    expect(JSON.parse(init.body)).toEqual(globalPayload);
    expect(result).toMatchObject({ ok: true, ruleId: "rule_1" });
    expect(result.message).toContain("observação");
    expect(revalidatePath).toHaveBeenCalledWith("/conversions");
  });

  it("returns the one-time URL of an automation rule", async () => {
    const payload = {
      name: "Umbler",
      connectionId: "conn_1",
      channelIds: ["ch_1"],
      mode: "observation",
      triggerType: "provider_automation",
      eventName: "QualifiedLead",
    };
    const rule = providerRule({
      id: "rule_umbler",
      triggerType: "provider_automation",
      connectionId: "conn_1",
      channelIds: ["ch_1"],
    });
    serverApiFetch.mockResolvedValueOnce({
      outcome: "created",
      receipt: { ruleId: "rule_umbler", connectionId: "conn_1", createdAt: rule.createdAt },
      rule,
      webhookUrl: "https://api.wpptrack.test/webhooks/inbound/conversions/e1?token=t",
    });

    const result = await createConversionRuleAction(createForm(payload));

    expect(result).toMatchObject({
      ok: true,
      webhookUrl: "https://api.wpptrack.test/webhooks/inbound/conversions/e1?token=t",
    });
  });

  it("creates a Payt sale rule bound to the connection of its numbers and returns the URL once", async () => {
    const payload = {
      name: "Venda Payt",
      connectionId: "conn_1",
      scope: "all_numbers",
      channelIds: [],
      mode: "observation",
      triggerType: "provider_automation",
      eventName: "Purchase",
      automationSource: "payt",
    };
    const rule = providerRule({
      id: "rule_payt",
      triggerType: "provider_automation",
      origin: "automation_payt",
      connectionId: "conn_1",
      scope: "all_numbers",
      automationSource: "payt",
    });
    serverApiFetch.mockResolvedValueOnce({
      outcome: "created",
      receipt: { ruleId: "rule_payt", connectionId: "conn_1", createdAt: rule.createdAt },
      rule,
      webhookUrl: "https://api.wpptrack.test/webhooks/inbound/conversions/p1?token=t",
    });

    const result = await createConversionRuleAction(createForm(payload));

    const [, init] = serverApiFetch.mock.calls[0]!;
    expect(JSON.parse(init.body)).toMatchObject({ automationSource: "payt", eventName: "Purchase" });
    expect(result).toMatchObject({
      ok: true,
      webhookUrl: "https://api.wpptrack.test/webhooks/inbound/conversions/p1?token=t",
    });
  });

  it("shows the license message on a 423 when creating a Payt rule", async () => {
    serverApiFetch.mockRejectedValueOnce(licenseLocked());

    const result = await createConversionRuleAction(
      createForm({
        name: "Venda Payt",
        connectionId: "conn_1",
        scope: "all_numbers",
        channelIds: [],
        mode: "observation",
        triggerType: "provider_automation",
        eventName: "InitiateCheckout",
        automationSource: "payt",
      }),
    );

    expect(result).toMatchObject({ ok: false, licenseLocked: true, message: lockedMessage });
  });

  it("explains the Payt refusals of the API in plain Portuguese", async () => {
    serverApiFetch.mockRejectedValueOnce(
      apiError(400, "Escolha a conexao de WhatsApp dos numeros desta regra"),
    );
    const result = await createConversionRuleAction(
      createForm({
        name: "Venda Payt",
        connectionId: "conn_1",
        scope: "all_numbers",
        channelIds: [],
        mode: "observation",
        triggerType: "provider_automation",
        eventName: "Purchase",
        automationSource: "payt",
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      message: "Escolha números de uma conexão de WhatsApp para esta regra.",
    });
  });

  it("treats a receipt for another connection as uncertain", async () => {
    const rule = providerRule({ id: "rule_1" });
    serverApiFetch.mockResolvedValueOnce({
      outcome: "replayed",
      receipt: { ruleId: "rule_1", connectionId: "conn_other", createdAt: rule.createdAt },
    });

    const result = await createConversionRuleAction(createForm());

    expect(result).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a replayed create without showing a URL", async () => {
    serverApiFetch.mockResolvedValueOnce({
      outcome: "replayed",
      receipt: { ruleId: "rule_1", connectionId: null, createdAt: "2026-10-14T12:00:00.000Z" },
    });

    const result = await createConversionRuleAction(createForm());

    expect(result).toMatchObject({ ok: true, replayed: true, ruleId: "rule_1" });
    expect(result.webhookUrl).toBeUndefined();
  });

  it("shows the license message on a 423 and never treats it as uncertain", async () => {
    serverApiFetch.mockRejectedValueOnce(licenseLocked());

    const result = await createConversionRuleAction(createForm());

    expect(result).toEqual({ ok: false, licenseLocked: true, message: lockedMessage });
    expect(result.outcomeUnknown).toBeUndefined();
    // Recusa definitiva: nada foi criado e nada a conferir.
    expect(serverApiFetch).toHaveBeenCalledTimes(1);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("keeps network failures and 5xx as uncertain, never as refused", async () => {
    serverApiFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await createConversionRuleAction(createForm())).toMatchObject({
      ok: false,
      outcomeUnknown: true,
    });

    serverApiFetch.mockRejectedValueOnce(apiError(502, "Bad gateway"));
    expect(await createConversionRuleAction(createForm())).toMatchObject({
      ok: false,
      outcomeUnknown: true,
    });
  });

  it("treats 503 as unavailable (retry), not as an uncertain create", async () => {
    serverApiFetch.mockRejectedValueOnce(
      apiError(503, "Eventos de conversao por provedor ainda nao estao habilitados"),
    );

    const result = await createConversionRuleAction(createForm());

    expect(result).toEqual({
      ok: false,
      unavailable: true,
      message: "Serviço indisponível no momento. Tente de novo em alguns instantes.",
    });

    serverApiFetch.mockRejectedValueOnce(apiError(503, "down"));
    expect(
      await unifyConversionRulesAction(
        (() => {
          const formData = new FormData();
          formData.append("ruleId", "a");
          formData.append("ruleId", "b");
          return formData;
        })(),
      ),
    ).toMatchObject({ ok: false, unavailable: true });
  });

  it("shows only curated API messages and maps session loss", async () => {
    serverApiFetch.mockRejectedValueOnce(
      apiError(400, "Um ou mais numeros nao suportam esta origem de regra"),
    );
    expect(await createConversionRuleAction(createForm())).toEqual({
      ok: false,
      message: "Um dos números escolhidos ainda não funciona com esta origem de regra.",
    });

    serverApiFetch.mockRejectedValueOnce(apiError(400, "internal detail https://x?token=1"));
    expect(await createConversionRuleAction(createForm())).toEqual({
      ok: false,
      message: "Não foi possível criar a regra.",
    });

    serverApiFetch.mockRejectedValueOnce(apiError(401, "Unauthorized"));
    expect(await createConversionRuleAction(createForm())).toMatchObject({
      ok: false,
      authFailure: true,
    });

    serverApiFetch.mockRejectedValueOnce(
      apiError(409, "Chave de tentativa ja usada com outra solicitacao"),
    );
    expect((await createConversionRuleAction(createForm())).message).toContain(
      "outros dados",
    );
  });

  it("never sends an invalid key or payload", async () => {
    expect(await createConversionRuleAction(createForm(globalPayload, "short"))).toMatchObject({
      ok: false,
    });
    expect(
      await createConversionRuleAction(createForm({ ...globalPayload, extra: true })),
    ).toMatchObject({ ok: false });
    expect(serverApiFetch).not.toHaveBeenCalled();
  });
});

describe("conversions actions: unify", () => {
  function unifyForm(ids: string[], name?: string) {
    const formData = new FormData();
    for (const id of ids) formData.append("ruleId", id);
    if (name) formData.set("name", name);
    return formData;
  }

  it("unifies and reports what changed", async () => {
    const rule = providerRule({
      id: "global",
      name: "Checkout (todos)",
      scope: "all_numbers",
      duplicatePhone: ["ch_03"],
    });
    serverApiFetch.mockResolvedValueOnce({
      outcome: "created",
      rule,
      deactivatedRuleIds: ["a", "b"],
      newlyCoveredChannelIds: ["ch_02"],
    });

    const result = await unifyConversionRulesAction(
      unifyForm(["a", "b"], "Checkout (todos)"),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/conversion-rules/providers/unify",
      {
        method: "POST",
        body: JSON.stringify({ ruleIds: ["a", "b"], name: "Checkout (todos)" }),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      unify: {
        outcome: "created",
        ruleName: "Checkout (todos)",
        deactivatedRuleIds: ["a", "b"],
        newlyCoveredChannelIds: ["ch_02"],
        duplicatePhoneChannelIds: ["ch_03"],
      },
    });
  });

  it("explains replayed and reused outcomes", async () => {
    const rule = providerRule({ id: "global", scope: "all_numbers" });
    serverApiFetch.mockResolvedValueOnce({
      outcome: "replayed",
      rule,
      deactivatedRuleIds: [],
      newlyCoveredChannelIds: [],
    });
    expect((await unifyConversionRulesAction(unifyForm(["a", "b"]))).message).toContain(
      "Nada mudou",
    );

    serverApiFetch.mockResolvedValueOnce({
      outcome: "reused_existing",
      rule,
      deactivatedRuleIds: ["a", "b"],
      newlyCoveredChannelIds: [],
    });
    expect((await unifyConversionRulesAction(unifyForm(["a", "b"]))).message).toContain(
      "Já existia",
    );
  });

  it("refuses fewer than two rules and shows the license lock", async () => {
    expect(await unifyConversionRulesAction(unifyForm(["a"]))).toMatchObject({ ok: false });
    expect(serverApiFetch).not.toHaveBeenCalled();

    serverApiFetch.mockRejectedValueOnce(licenseLocked());
    expect(await unifyConversionRulesAction(unifyForm(["a", "b"]))).toEqual({
      ok: false,
      licenseLocked: true,
      message: lockedMessage,
    });
  });
});

describe("conversions actions: confirm an uncertain create", () => {
  it("asks the receipt endpoint with the same key and finds the rule", async () => {
    serverApiFetch.mockResolvedValueOnce({
      outcome: "found",
      receipt: { ruleId: "rule_1", connectionId: null, createdAt: at },
    });
    const formData = new FormData();
    formData.set("requestKey", requestKey);

    const result = await confirmConversionRuleCreateAction(formData);

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/conversion-rules/providers/create-receipt",
      { headers: { "Idempotency-Key": requestKey } },
    );
    expect(result).toMatchObject({ ok: true, ruleId: "rule_1", replayed: true });
    expect(revalidatePath).toHaveBeenCalledWith("/conversions");
  });

  it("sends the connection when the rule was bound to one", async () => {
    serverApiFetch.mockResolvedValueOnce({
      outcome: "absent",
      code: "provider_rule_create_receipt_absent",
    });
    const formData = new FormData();
    formData.set("requestKey", requestKey);
    formData.set("connectionId", "conn 1");

    const result = await confirmConversionRuleCreateAction(formData);

    expect(serverApiFetch.mock.calls[0]![0]).toBe(
      "/conversion-rules/providers/create-receipt?connectionId=conn%201",
    );
    expect(result).toMatchObject({ ok: false, receiptAbsent: true });
  });

  it("keeps the request uncertain when the lookup itself fails", async () => {
    serverApiFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    const formData = new FormData();
    formData.set("requestKey", requestKey);

    expect(await confirmConversionRuleCreateAction(formData)).toMatchObject({
      ok: false,
      outcomeUnknown: true,
    });
  });

  it("rejects an invalid key without calling the API", async () => {
    const formData = new FormData();
    formData.set("requestKey", "short");

    expect(await confirmConversionRuleCreateAction(formData)).toMatchObject({ ok: false });
    expect(serverApiFetch).not.toHaveBeenCalled();
  });
});

describe("conversions actions: manage, legacy and history", () => {
  function form(values: Record<string, string>) {
    const formData = new FormData();
    for (const [key, value] of Object.entries(values)) formData.set(key, value);
    return formData;
  }

  it("shows the license message on every write", async () => {
    const writes = [
      () =>
        updateProviderConversionRuleAction(
          form({ ruleId: "r1", payload: JSON.stringify({ active: false }) }),
        ),
      () => removeProviderConversionRuleAction(form({ ruleId: "r1" })),
      () => rotateProviderConversionRuleEndpointAction(form({ ruleId: "r1" })),
      () =>
        updateLegacyRuleAction(form({ ruleId: "legacy_1", intent: "status", active: "false" })),
      () =>
        adaptProviderConversionRuleAction(
          form({
            legacyRuleId: "legacy_1",
            payload: JSON.stringify({
              connectionId: "conn_1",
              channelIds: ["ch_1"],
              triggerPhrases: ["aviso de compra"],
              messageAuthorScope: "team",
            }),
          }),
        ),
    ];

    for (const write of writes) {
      serverApiFetch.mockRejectedValueOnce(licenseLocked());
      expect(await write()).toMatchObject({
        ok: false,
        licenseLocked: true,
        message: lockedMessage,
      });
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("patches a provider rule and refreshes the screen", async () => {
    const rule = providerRule({ id: "r1", active: false });
    serverApiFetch.mockResolvedValueOnce(rule);

    const result = await updateProviderConversionRuleAction(
      form({ ruleId: "r1", payload: JSON.stringify({ active: false }) }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith("/conversion-rules/providers/r1", {
      method: "PATCH",
      body: JSON.stringify({ active: false }),
    });
    expect(result).toEqual({ ok: true, message: "Regra pausada." });
    expect(revalidatePath).toHaveBeenCalledWith("/conversions");
  });

  it("connects a legacy rule to numbers", async () => {
    serverApiFetch.mockResolvedValueOnce(providerRule({ id: "legacy_1" }));
    const payload = {
      connectionId: "conn_1",
      channelIds: ["ch_1"],
      triggerPhrases: ["aviso de compra"],
      messageAuthorScope: "team",
    };

    const result = await adaptProviderConversionRuleAction(
      form({ legacyRuleId: "legacy_1", payload: JSON.stringify(payload) }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/conversion-rules/providers/adapt/legacy_1",
      { method: "POST", body: JSON.stringify(payload) },
    );
    expect(result).toEqual({
      ok: true,
      message: "Regra conectada aos números, em observação.",
    });
  });

  it("pauses and edits the value of an old rule", async () => {
    serverApiFetch.mockResolvedValue(undefined);

    await updateLegacyRuleAction(
      form({ ruleId: "legacy_1", intent: "status", active: "false" }),
    );
    expect(serverApiFetch).toHaveBeenLastCalledWith("/conversion-rules/legacy_1", {
      method: "PATCH",
      body: JSON.stringify({ active: false }),
    });

    const result = await updateLegacyRuleAction(
      form({
        ruleId: "legacy_1",
        intent: "value",
        productName: "Consulta",
        defaultValue: "1.397,00",
        defaultCurrency: "BRL",
      }),
    );
    expect(result).toMatchObject({ ok: true, message: "Produto e valor salvos." });
    expect(JSON.parse(serverApiFetch.mock.calls.at(-1)![1].body)).toMatchObject({
      defaultValueCents: 139_700,
      defaultCurrency: "BRL",
      defaultContentName: "Consulta",
    });
    expect(
      await updateLegacyRuleAction(
        form({ ruleId: "legacy_1", intent: "value", defaultValue: "0" }),
      ),
    ).toMatchObject({ ok: false, message: "Informe um valor maior que zero." });
  });

  it("saves a legacy rule without currency as inheriting the workspace currency", async () => {
    serverApiFetch.mockResolvedValue(undefined);

    const inherit = await updateLegacyRuleAction(
      form({
        ruleId: "legacy_1",
        intent: "value",
        productName: "Consulta",
        defaultValue: "250,00",
        defaultCurrency: "",
      }),
    );
    expect(inherit).toMatchObject({ ok: true });
    expect(JSON.parse(serverApiFetch.mock.calls.at(-1)![1].body)).toMatchObject({
      defaultValueCents: 25_000,
      defaultCurrency: null,
    });

    await updateLegacyRuleAction(
      form({
        ruleId: "legacy_1",
        intent: "value",
        defaultValue: "9,90",
        defaultCurrency: "USD",
      }),
    );
    expect(JSON.parse(serverApiFetch.mock.calls.at(-1)![1].body)).toMatchObject({
      defaultValueCents: 990,
      defaultCurrency: "USD",
    });

    serverApiFetch.mockClear();
    expect(
      await updateLegacyRuleAction(
        form({
          ruleId: "legacy_1",
          intent: "value",
          defaultValue: "9,90",
          defaultCurrency: "GBP",
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(serverApiFetch).not.toHaveBeenCalled();
  });

  it("loads the executions scoped to the selected provider rule", async () => {
    serverApiFetch.mockResolvedValueOnce({
      providerRuleId: "provider_rule_1",
      eventName: "QualifiedLead",
      summary: {
        total: 1,
        observed: 1,
        eligible: 0,
        materialized: 0,
        duplicate: 0,
        blocked: 0,
        failed: 0,
      },
      items: [
        {
          executionId: "execution_1",
          sourceDeliveryId: "delivery_1",
          occurredAt: "2026-07-22T18:00:00.000Z",
          status: "observed",
          reasonCode: "message_matched_observation",
          matchedTriggerPhrase: "quero saber mais",
          channel: null,
          leadId: null,
          leadName: null,
          phoneDisplay: null,
          valueCents: null,
          currency: null,
          conversionEventLogId: null,
          purchaseReviewId: null,
          attemptCount: 0,
          processedAt: null,
          technicalDelivery: null,
          lastProductionFailure: null,
        },
      ],
      pagination: { page: 1, pageSize: 50, totalItems: 1, totalPages: 1 },
    });

    const result = await loadProviderConversionExecutionAuditAction(
      form({ ruleId: "provider_rule_1" }),
    );

    expect(serverApiFetch).toHaveBeenCalledWith(
      "/conversion-rules/providers/provider_rule_1/executions?page=1&pageSize=50",
    );
    expect(result).toEqual({
      ok: true,
      message: "Execuções atualizadas.",
      executionAudit: expect.anything(),
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
