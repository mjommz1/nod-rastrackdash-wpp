import { providerConversionRuleIdempotentCreateInputSchema } from "@wpptrack/shared";
import { describe, expect, it } from "vitest";
import type { KommoConnectionDetailDto } from "../src/app/(app)/integrations/kommo-actions";
import type { PipedriveConnectionDetailDto } from "../src/app/(app)/integrations/pipedrive-actions";
import {
  buildCrmRuleRows,
  buildProviderRuleRows,
  emptyRuleFilters,
  filterRuleRows,
  ineligibleNumbers,
  numbersForOrigin,
  offeredRuleOrigins,
  sortRuleRows,
  toConversionNumbers,
} from "../src/app/(app)/conversions/conversion-rules-view";
import {
  buildRulePayload,
  emptyRuleDraft,
  resolveRuleConnectionId,
  scopeIssue,
  type RuleDraft,
} from "../src/app/(app)/conversions/rule-draft";
import {
  at,
  capabilities,
  channelDto,
  connections,
  numbers,
  providerRule,
} from "./conversions-fixtures";

const context = { numbers, connections, capabilities };

function draft(
  origin: RuleDraft["origin"],
  patch: Partial<RuleDraft> = {},
): RuleDraft {
  return {
    ...emptyRuleDraft(origin),
    name: "Regra de teste",
    ...patch,
  };
}

describe("conversions view: provider rules", () => {
  it("explains where a global rule is replaced or runs once per phone", () => {
    const rules = [
      providerRule({
        id: "global",
        name: "Qualificado (todos)",
        origin: "message_phrase",
        scope: "all_numbers",
        effective: ["ch_01"],
        overridden: ["ch_02"],
        duplicatePhone: ["ch_03"],
        mode: "production",
      }),
      providerRule({
        id: "specific",
        name: "Qualificado Atendimento",
        origin: "message_phrase",
        connectionId: "conn_qr_a",
        channelIds: ["ch_02"],
      }),
    ];

    const [global, specific] = buildProviderRuleRows(rules, numbers, connections, capabilities);

    expect(global).toMatchObject({
      scope: "all_numbers",
      scopeLabel: "Todos os números",
      status: "production",
      statusLabel: "Envio automático",
      numberIds: ["ch_01", "ch_02", "ch_03"],
      // Message rules for every number span several platforms.
      platformLabel: "Vários canais",
      logo: null,
    });
    expect(global!.notes).toEqual([
      "Substituída em Atendimento: ali vale a regra específica do número.",
      "Pós-venda tem o mesmo telefone de outro número conectado: o evento sai uma vez só.",
    ]);
    expect(specific).toMatchObject({
      scopeLabel: "Atendimento",
      status: "observation",
      platformLabel: "Uazapi",
      logo: { src: "/integrations/uazapi.svg" },
    });
    expect(specific!.notes).toEqual([
      "Vale no lugar da regra para todos os números em Atendimento.",
    ]);
  });

  it("derives the origin for answers without it and labels unified rules", () => {
    const rules = [
      providerRule({ id: "global", name: "Global", scope: "all_numbers", origin: "message_phrase" }),
      providerRule({
        id: "umbler",
        triggerType: "provider_automation",
        eventName: "Purchase",
        connectionId: "conn_umbler",
        scope: "all_numbers",
        effective: ["ch_01"],
      }),
      providerRule({
        id: "label",
        triggerType: "provider_automation",
        scope: "all_numbers",
        effective: ["ch_02"],
      }),
      providerRule({
        id: "old",
        connectionId: "conn_umbler",
        channelIds: ["ch_01"],
        active: false,
        unifiedIntoRuleId: "global",
      }),
    ];

    const rows = buildProviderRuleRows(rules, numbers, connections, capabilities);

    expect(rows.map((row) => row.origin)).toEqual([
      "message_phrase",
      "automation_umbler",
      "whatsapp_label",
      "message_phrase",
    ]);
    expect(rows[1]).toMatchObject({
      scopeLabel: "Todos os números de Umbler Recepção",
      platformLabel: "Umbler Recepção",
    });
    expect(rows[3]).toMatchObject({ status: "unified", statusLabel: "Unificada" });
    expect(rows[3]!.notes).toEqual([
      "Unificada em “Global”, que vale para todos os números.",
    ]);
  });

  it("warns when an active rule covers no number", () => {
    const [empty, covered] = buildProviderRuleRows(
      [
        providerRule({ id: "empty", scope: "specific_numbers", channelIds: [] }),
        providerRule({ id: "covered", channelIds: ["ch_01"] }),
      ],
      numbers,
      connections,
      capabilities,
    );

    expect(empty!.warnings).toEqual([
      "Esta regra não vale em nenhum número agora: conecte um número compatível ou ajuste o alcance.",
    ]);
    expect(covered!.warnings).toEqual([]);
  });

  it("warns when a global rule runs on a channel still in observation", () => {
    const [row] = buildProviderRuleRows(
      [
        {
          ...providerRule({
            id: "global",
            scope: "all_numbers",
            origin: "message_phrase",
            effective: ["ch_01", "ch_02"],
            mode: "production",
          }),
          observationCanonicalChannels: [
            { canonicalChannelId: "ch_01", productionChannelIds: ["ch_02"] },
          ],
        },
      ],
      numbers,
      connections,
      capabilities,
    );

    expect(row!.warnings).toEqual([
      "Em Recepção: a regra global roda no canal em observação; outro canal do mesmo número está em produção.",
    ]);
    // Pausada: sem aviso.
    const [paused] = buildProviderRuleRows(
      [
        {
          ...providerRule({ id: "g2", scope: "all_numbers", active: false, effective: ["ch_01"] }),
          observationCanonicalChannels: [
            { canonicalChannelId: "ch_01", productionChannelIds: ["ch_02"] },
          ],
        },
      ],
      numbers,
      connections,
      capabilities,
    );
    expect(paused!.warnings).toEqual([]);
  });

  it("names removed numbers and shortens long scopes", () => {
    const [row] = buildProviderRuleRows(
      [
        providerRule({
          id: "many",
          channelIds: ["ch_01", "ch_02", "ch_03", "ch_05", "ch_gone"],
        }),
      ],
      numbers,
      connections,
      capabilities,
    );

    expect(row!.scopeLabel).toBe("Recepção, Atendimento, Pós-venda e mais 2");
  });

  it("maps channels to numbers with their routes", () => {
    const [mapped] = toConversionNumbers([
      {
        connection: connections[0]!,
        channels: [channelDto(numbers[0]!)],
      },
    ]);

    expect(mapped).toEqual(numbers[0]);
  });
});

describe("conversions view: CRM rules, sorting and filters", () => {
  const kommo = {
    id: "kommo_1",
    workspaceId: "workspace_1",
    displayName: "Kommo Comercial",
    status: "active",
    verifiedAccountId: null,
    accountSubdomain: null,
    accountOrigin: "https://loja.kommo.com",
    // Authorized by route id (ch_02) or by channel id (ch_01).
    allowedChannelRouteIds: ["route_ch_02", "ch_01"],
    credentialHealthy: true,
    catalogState: "fresh",
    catalogRefreshedAt: at,
    lastErrorCode: null,
    createdAt: at,
    updatedAt: at,
    pipelines: [
      {
        id: "p1",
        name: "Funil",
        sort: 1,
        status: { id: "s1", name: "Proposta", type: null },
        available: true,
      },
    ],
    rules: [
      {
        id: "kr_1",
        connectionId: "kommo_1",
        name: "Proposta enviada",
        pipelineId: "p1",
        statusId: "s1",
        eventName: "InitiateCheckout",
        mode: "observation",
        valueMode: "lead_price",
        fixedValueCents: null,
        currency: null,
        contentName: null,
        active: true,
        createdAt: at,
        updatedAt: at,
      },
    ],
  } as unknown as KommoConnectionDetailDto;
  const crmRows = buildCrmRuleRows({ kommo: [kommo], pipedrive: [] }, numbers);

  it("lists CRM rules read-only, with authorized numbers and a manage link", () => {
    expect(crmRows[0]).toMatchObject({
      kind: "crm",
      origin: "kommo",
      triggerDetail: "Etapa “Proposta” em Funil",
      scopeLabel: "Recepção e Atendimento",
      numberIds: ["ch_01", "ch_02"],
      manageHref: "/integrations?abrir=kommo",
      status: "observation",
    });
  });

  const pipedrive = {
    id: "pipedrive_1",
    workspaceId: "workspace_1",
    displayName: "Pipedrive Comercial",
    status: "active",
    verifiedAccountId: "account_1",
    accountSubdomain: "loja",
    accountOrigin: "https://loja.pipedrive.com",
    allowedChannelRouteIds: ["route_ch_02"],
    credentialHealthy: true,
    catalogState: "fresh",
    catalogRefreshedAt: at,
    lastErrorCode: null,
    createdAt: at,
    updatedAt: at,
    pipelines: [
      {
        id: "pd1",
        name: "Vendas",
        sort: 1,
        stages: [{ id: "st1", name: "Proposta enviada", sort: 1 }],
      },
    ],
    rules: [
      {
        id: "pr_1",
        connectionId: "pipedrive_1",
        name: "Proposta",
        trigger: "stage_change",
        pipelineId: "pd1",
        stageId: "st1",
        eventName: "InitiateCheckout",
        mode: "production",
        productionActivatedAt: at,
        valueMode: "deal",
        fixedValueCents: null,
        currency: "BRL",
        contentName: null,
        active: true,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "pr_2",
        connectionId: "pipedrive_1",
        name: "Negócio ganho",
        trigger: "deal_won",
        pipelineId: "pd1",
        stageId: null,
        eventName: "Purchase",
        mode: "observation",
        productionActivatedAt: null,
        valueMode: "deal",
        fixedValueCents: null,
        currency: "BRL",
        contentName: null,
        active: false,
        createdAt: at,
        updatedAt: at,
      },
    ],
  } as unknown as PipedriveConnectionDetailDto;

  it("lists Pipedrive rules read-only, with the stage, the won deal and a manage link to the hub", () => {
    const rows = buildCrmRuleRows({ kommo: [], pipedrive: [pipedrive] }, numbers);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "crm",
      origin: "pipedrive",
      originLabel: "Etapa ou negócio ganho no Pipedrive",
      platformLabel: "Pipedrive Comercial",
      triggerDetail: "Etapa “Proposta enviada” em Vendas",
      scopeLabel: "Atendimento",
      numberIds: ["ch_02"],
      manageHref: "/integrations?abrir=pipedrive",
      status: "production",
      logo: expect.objectContaining({ src: "/integrations/pipedrive.svg" }),
    });
    expect(rows[1]).toMatchObject({
      triggerDetail: "Negócio ganho",
      status: "paused",
      eventName: "Purchase",
    });
  });

  it("pauses the Pipedrive rules of a paused connection", () => {
    const rows = buildCrmRuleRows(
      { kommo: [], pipedrive: [{ ...pipedrive, status: "paused" }] },
      numbers,
    );
    expect(rows.map((row) => row.status)).toEqual(["paused", "paused"]);
  });

  it("offers Pipedrive in Nova regra only with a connection, pointing to the hub", () => {
    expect(
      offeredRuleOrigins({ numbers, connections, capabilities: null, crm: { kommo: false, pipedrive: true } }),
    ).toEqual(["pipedrive"]);
    expect(
      offeredRuleOrigins({ numbers, connections, capabilities: null, crm: { kommo: false, pipedrive: false } }),
    ).toEqual([]);
  });

  it("filters by origin, number, event and status", () => {
    const rows = sortRuleRows([
      ...buildProviderRuleRows(
        [
          providerRule({ id: "a", channelIds: ["ch_01"], mode: "production" }),
          providerRule({ id: "b", channelIds: ["ch_02"], active: false }),
          providerRule({
            id: "c",
            channelIds: ["ch_03"],
            active: false,
            unifiedIntoRuleId: "x",
          }),
        ],
        numbers,
        connections,
        capabilities,
      ),
      ...crmRows,
    ]);

    // Live rules first.
    expect(rows.map((row) => row.id)).toEqual(["a", "kr_1", "b", "c"]);
    const byNumber = filterRuleRows(rows, { ...emptyRuleFilters, numberId: "ch_02" });
    expect(byNumber.map((row) => row.id)).toEqual(["kr_1", "b"]);
    // Pausadas e unificadas são filtros separados.
    expect(
      filterRuleRows(rows, { ...emptyRuleFilters, status: "paused" }).map((row) => row.id),
    ).toEqual(["b"]);
    expect(
      filterRuleRows(rows, { ...emptyRuleFilters, status: "unified" }).map((row) => row.id),
    ).toEqual(["c"]);
    expect(
      filterRuleRows(rows, { ...emptyRuleFilters, status: "production" }).map((row) => row.id),
    ).toEqual(["a"]);
    expect(
      filterRuleRows(rows, { ...emptyRuleFilters, status: "observation" }).map((row) => row.id),
    ).toEqual(["kr_1"]);
    expect(
      filterRuleRows(rows, { ...emptyRuleFilters, origin: "kommo" }).map((row) => row.id),
    ).toEqual(["kr_1"]);
    expect(
      filterRuleRows(rows, { ...emptyRuleFilters, eventName: "InitiateCheckout" }).map(
        (row) => row.id,
      ),
    ).toEqual(["kr_1"]);
  });
});

describe("conversions view: origins offered in Nova regra", () => {
  it("offers only origins the capabilities endpoint supports and an active integration backs", () => {
    expect(
      offeredRuleOrigins({ numbers, connections, capabilities, crm: { kommo: true, pipedrive: false } }),
    ).toEqual([
      "message_phrase",
      "whatsapp_label",
      "structured_catalog",
      "automation_umbler",
      "kommo",
    ]);

    // Só um número Gupshup: nenhuma origem de regra roda nele ainda.
    expect(
      offeredRuleOrigins({
        numbers: numbers.filter((item) => item.provider === "gupshup"),
        connections: connections.filter((item) => item.provider === "gupshup"),
        capabilities,
        crm: { kommo: false, pipedrive: false },
      }),
    ).toEqual([]);
    expect(
      offeredRuleOrigins({ numbers: [], connections: [], capabilities, crm: { kommo: true, pipedrive: false } }),
    ).toEqual(["kommo"]);
  });

  it("follows the capabilities, never a hardcoded list", () => {
    // A API aceita catálogo também na Uazapi (o fixture reflete isso); se a
    // matriz mudar, a tela segue a API e não uma lista fixa.
    const narrowed = {
      ...capabilities,
      origins: capabilities.origins.map((origin) =>
        origin.origin === "structured_catalog"
          ? { ...origin, channelProviders: ["umbler"] }
          : origin,
      ),
    };
    const uazapiNumbers = numbers.filter((item) => item.provider === "uazapi");
    const uazapiConnections = connections.filter((item) => item.provider === "uazapi");

    expect(
      offeredRuleOrigins({
        numbers: uazapiNumbers,
        connections: uazapiConnections,
        capabilities: narrowed,
        crm: { kommo: false, pipedrive: false },
      }),
    ).not.toContain("structured_catalog");
    expect(
      offeredRuleOrigins({
        numbers: uazapiNumbers,
        connections: uazapiConnections,
        capabilities,
        crm: { kommo: false, pipedrive: false },
      }),
    ).toContain("structured_catalog");
    expect(
      numbersForOrigin("structured_catalog", numbers, null, capabilities).map((item) => item.id),
    ).toEqual(["ch_01", "ch_02", "ch_03"]);
    expect(
      numbersForOrigin("structured_catalog", numbers, null, narrowed).map((item) => item.id),
    ).toEqual(["ch_01"]);
  });

  it("offers only the CRM pointer without the capabilities answer", () => {
    expect(
      offeredRuleOrigins({ numbers, connections, capabilities: null, crm: { kommo: true, pipedrive: false } }),
    ).toEqual(["kommo"]);
  });

  it("lists numbers no origin evaluates yet as not eligible", () => {
    expect(ineligibleNumbers(numbers, capabilities).map((item) => item.id)).toEqual(["ch_05"]);
    expect(ineligibleNumbers(numbers, null)).toEqual([]);
  });

  it("limits contact messages to the providers that read them", () => {
    expect(
      numbersForOrigin("message_phrase", numbers, null, capabilities, "contact").map(
        (item) => item.id,
      ),
    ).toEqual(["ch_01"]);
    expect(
      numbersForOrigin("message_phrase", numbers, null, capabilities, "team").map(
        (item) => item.id,
      ),
    ).toEqual(["ch_01", "ch_02", "ch_03"]);
  });
});

describe("rule draft: scope and payload", () => {
  it("defaults to all numbers", () => {
    expect(emptyRuleDraft("message_phrase").scope).toBe("all_numbers");
    expect(emptyRuleDraft("automation_umbler").eventName).toBe("QualifiedLead");
    expect(emptyRuleDraft("structured_catalog").eventName).toBe("Purchase");
  });

  it("sends a message rule for all numbers without connection", () => {
    const result = buildRulePayload(
      draft("message_phrase", { primaryPhrase: "Vou te passar os valores" }),
      context,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        name: "Regra de teste",
        scope: "all_numbers",
        channelIds: [],
        mode: "observation",
        triggerType: "message_phrase",
        eventName: "QualifiedLead",
        valueMode: "fixed",
        exampleMessage: null,
        triggerPhrases: ["Vou te passar os valores"],
        messageAuthorScope: "team",
      },
    });
    expect(
      providerConversionRuleIdempotentCreateInputSchema.safeParse(
        result.ok ? result.value : null,
      ).success,
    ).toBe(true);
  });

  it("keeps the bound shape for numbers of one connection", () => {
    const input = draft("message_phrase", {
      scope: "specific_numbers",
      channelIds: ["ch_02"],
      primaryPhrase: "segue o link",
      eventName: "InitiateCheckout",
      averageValue: "1.397,00",
    });

    expect(resolveRuleConnectionId(input, context)).toBe("conn_qr_a");
    const result = buildRulePayload(input, context);
    expect(result).toMatchObject({
      ok: true,
      value: {
        connectionId: "conn_qr_a",
        channelIds: ["ch_02"],
        defaultValueCents: 139_700,
        // Sem moeda escolhida a regra herda a do workspace (nada é gravado).
      },
    });
    expect(result.ok && "scope" in result.value).toBe(false);
    expect(result.ok && "defaultCurrency" in result.value).toBe(false);
  });

  it("sends numbers of several connections as an unbound rule", () => {
    const spanning = draft("message_phrase", {
      scope: "specific_numbers",
      channelIds: ["ch_01", "ch_02"],
      primaryPhrase: "segue o link",
    });

    expect(scopeIssue(spanning, context)).toBeNull();
    expect(buildRulePayload(spanning, context)).toMatchObject({
      ok: true,
      value: { channelIds: ["ch_01", "ch_02"] },
    });
    expect(resolveRuleConnectionId(spanning, context)).toBeNull();
  });

  it("rejects numbers that cannot run the origin", () => {
    expect(
      scopeIssue(
        draft("whatsapp_label", { scope: "specific_numbers", channelIds: ["ch_01"] }),
        context,
      ),
    ).toBe("Um dos números escolhidos ainda não funciona com esta origem.");
    expect(
      scopeIssue(
        draft("message_phrase", { scope: "specific_numbers", channelIds: ["ch_05"] }),
        context,
      ),
    ).toBe("Um dos números escolhidos ainda não funciona com esta origem.");
    expect(scopeIssue(draft("message_phrase", { scope: "specific_numbers" }), context)).toBe(
      "Escolha ao menos um número.",
    );
  });

  it("refuses contact messages on numbers that do not read them", () => {
    expect(
      scopeIssue(
        draft("message_phrase", {
          scope: "specific_numbers",
          channelIds: ["ch_02"],
          messageAuthorScope: "contact",
        }),
        context,
      ),
    ).toContain("Mensagens do contato só são lidas na Umbler");
    expect(
      scopeIssue(
        draft("message_phrase", {
          scope: "specific_numbers",
          channelIds: ["ch_01"],
          messageAuthorScope: "contact",
        }),
        context,
      ),
    ).toBeNull();
  });

  it("requires the connection of Umbler automations and limits its numbers", () => {
    expect(scopeIssue(draft("automation_umbler"), context)).toBe(
      "Escolha a conexão que vai chamar o endereço desta regra.",
    );
    const umbler = draft("automation_umbler", { connectionId: "conn_umbler" });
    expect(buildRulePayload(umbler, context)).toEqual({
      ok: true,
      value: {
        name: "Regra de teste",
        connectionId: "conn_umbler",
        scope: "all_numbers",
        channelIds: [],
        mode: "observation",
        triggerType: "provider_automation",
        eventName: "QualifiedLead",
      },
    });
    expect(
      scopeIssue(
        draft("automation_umbler", {
          connectionId: "conn_umbler",
          scope: "specific_numbers",
          channelIds: ["ch_02"],
        }),
        context,
      ),
    ).toBe("Um dos números escolhidos ainda não funciona com esta origem.");
    expect(
      buildRulePayload(
        draft("automation_umbler", { connectionId: "conn_umbler", eventName: "ViewContent" }),
        context,
      ),
    ).toEqual({ ok: false, message: "Esta origem não reconhece o evento escolhido." });
  });

  it("sends label ids only for a rule bound to one WhatsApp instance", () => {
    const labels = [{ id: "inst_a:3", name: "Pagou" }];
    const bound = buildRulePayload(
      draft("whatsapp_label", {
        scope: "specific_numbers",
        channelIds: ["ch_02"],
        triggerLabels: labels,
        eventName: "Purchase",
        averageValue: "100",
      }),
      context,
    );
    expect(bound).toMatchObject({
      ok: true,
      value: {
        connectionId: "conn_qr_a",
        triggerPhrases: ["Pagou"],
        triggerLabels: labels,
        defaultValueCents: 10_000,
      },
    });

    const global = buildRulePayload(
      draft("whatsapp_label", { triggerLabels: labels, labelNames: "Pagou\nVenda" }),
      context,
    );
    expect(global).toMatchObject({
      ok: true,
      value: { scope: "all_numbers", triggerPhrases: ["Pagou", "Venda"] },
    });
    expect(global.ok && "triggerLabels" in global.value).toBe(false);
  });

  it("builds a catalog rule and checks every option", () => {
    const base = draft("structured_catalog", {
      primaryPhrase: "Resumo do pedido",
      catalog: {
        name: "Camas",
        productName: "Cama elástica",
        attributes: ["Tamanho"],
        variants: [
          { values: ["3,05"], price: "1.990,00" },
          { values: ["4,30"], price: "2.590,00" },
        ],
      },
    });
    const result = buildRulePayload(base, context);

    expect(result).toMatchObject({
      ok: true,
      value: {
        triggerType: "structured_catalog",
        eventName: "Purchase",
        catalog: {
          attributes: [{ key: "tamanho", label: "Tamanho" }],
          variants: [
            { attributeValues: ["3,05"], aliases: [], valueCents: 199_000 },
            { attributeValues: ["4,30"], aliases: [], valueCents: 259_000 },
          ],
        },
      },
    });
    expect(
      providerConversionRuleIdempotentCreateInputSchema.safeParse(
        result.ok ? result.value : null,
      ).success,
    ).toBe(true);
    expect(
      buildRulePayload(
        { ...base, catalog: { ...base.catalog, variants: [{ values: ["3,05"], price: "" }] } },
        context,
      ),
    ).toEqual({
      ok: false,
      message: "Preencha cada opção do catálogo com as características e o preço.",
    });
  });

  it("asks for a name, a phrase and a valid value", () => {
    expect(buildRulePayload({ ...draft("message_phrase"), name: " " }, context)).toEqual({
      ok: false,
      message: "Dê um nome para a regra.",
    });
    expect(buildRulePayload(draft("message_phrase"), context)).toEqual({
      ok: false,
      message: "Informe a frase que dispara a regra.",
    });
    expect(
      buildRulePayload(
        draft("message_phrase", { primaryPhrase: "pago", eventName: "Purchase" }),
        context,
      ),
    ).toEqual({ ok: false, message: "Informe um valor médio válido." });
  });
});
