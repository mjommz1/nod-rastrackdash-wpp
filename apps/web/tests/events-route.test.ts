import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import EventsPage from "../src/app/(app)/events/page";
import { retryBlockedMetaEventsAction } from "../src/app/(app)/events/actions";
import { initialBackofficeActionState } from "../src/components/backoffice-action-form";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
});

function auditEvent(overrides: Record<string, unknown>) {
  return {
    id: "event_1",
    eventName: "Purchase",
    eventLabel: "Compras",
    deliveryState: "sent",
    statusLabel: "Enviado",
    statusDetail: "Recebido pela Meta",
    source: "external_integration",
    sourceLabel: "Integracao externa",
    leadId: null,
    leadName: null,
    phoneDisplay: null,
    campaignId: null,
    campaignName: null,
    adSetId: null,
    adSetName: null,
    adId: null,
    adName: null,
    pixelId: null,
    pageId: null,
    occurredAt: "2026-07-12T15:00:00.000Z",
    sentAt: "2026-07-12T15:01:00.000Z",
    status: "sent",
    canRetry: false,
    providerResponseSummary: null,
    errorCode: null,
    errorMessage: null,
    valueSource: null,
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockAuditApi({
  audit,
  role,
}: {
  audit: ReturnType<typeof auditResponse>;
  role: "owner" | "member";
}) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.endsWith("/workspaces/current")) {
        return json({ id: "workspace_1", role, accessMode: "member" });
      }

      if (url.includes("/reports/conversions/audit?")) {
        return json(audit);
      }

      return json({ message: "not found" }, 404);
    });
}

function blockedAudit(canRetry: boolean) {
  const audit = auditResponse([
    auditEvent({
      id: "event_blocked",
      deliveryState: "blocked",
      statusLabel: "Bloqueado",
      statusDetail: "Depende de configuracao",
      sentAt: null,
      status: "not_configured",
      canRetry,
      errorCode: "MissingAccessToken",
      errorMessage: "Conexao com a Meta sem acesso",
    }),
  ]);

  return {
    ...audit,
    summary: { ...audit.summary, sent: 0, blocked: 1 },
  };
}

function auditResponse(events: unknown[]) {
  return {
    workspaceId: "workspace_1",
    rangeLabel: "2026-07-06 a 2026-07-12",
    summary: {
      total: events.length,
      sent: 1,
      queued: 0,
      blocked: 0,
      failed: events.length > 1 ? 1 : 0,
      notEligible: 0,
      shadowObserved: 0,
      historical: 0,
      discarded: 0,
    },
    pagination: {
      page: 1,
      pageSize: 25,
      totalItems: events.length,
      totalPages: events.length ? 1 : 0,
    },
    events,
  };
}

describe("events route", () => {
  it("renders a filtered customer-facing Meta event audit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          auditResponse([
            {
              id: "event_1",
              eventName: "Purchase",
              eventLabel: "Compras",
              deliveryState: "sent",
              statusLabel: "Enviado",
              statusDetail: "Recebido pela Meta",
              source: "external_integration",
              sourceLabel: "Integracao externa",
              leadId: "lead_1",
              leadName: "Mariana Alves",
              phoneDisplay: "+55 11 99999-1020",
              campaignId: "cmp_1",
              campaignName: "Campanha WhatsApp",
              adSetId: "adset_1",
              adSetName: "Conjunto aberto",
              adId: "ad_1",
              adName: "Anuncio 1",
              pixelId: "pixel_1",
              pageId: "page_1",
              occurredAt: "2026-07-12T15:00:00.000Z",
              sentAt: "2026-07-12T15:01:00.000Z",
              status: "sent",
              canRetry: false,
              providerResponseSummary: "Meta confirmou o recebimento",
              errorCode: null,
              errorMessage: null,
              valueSource: "configured_average",
            },
          ]),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await EventsPage({
      searchParams: Promise.resolve({
        since: "2026-07-06",
        until: "2026-07-12",
        eventName: "Purchase",
        status: "sent",
        source: "external_integration",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3333/reports/conversions/audit?since=2026-07-06&until=2026-07-12&page=1&pageSize=25&eventName=Purchase&status=sent&source=external_integration",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(html).toContain("Auditoria de conversoes");
    expect(html).toContain("Periodo da auditoria");
    expect(html).toContain('class="audit-advanced-filters"');
    expect(html).toContain("Saude da entrega");
    expect(html).toContain("Fluxo para a Meta");
    expect(html.indexOf("Periodo da auditoria")).toBeLessThan(
      html.indexOf("Fluxo para a Meta"),
    );
    expect(html.indexOf("Fluxo para a Meta")).toBeLessThan(
      html.indexOf("Eventos do periodo"),
    );
    expect(html).toContain("audit-mobile-event-card");
    expect(html).toContain("Em sombra");
    expect(html).toContain("Mariana Alves");
    expect(html).toContain("+55 11 99999-1020");
    expect(html).toContain("Campanha WhatsApp");
    expect(html).toContain("Recebido pela Meta");
    expect(html).toContain("Auditoria");
    expect(html).toContain("Inspecionar");
    expect(html).toContain("Auditoria do evento");
    expect(html).toContain('href="/leads/lead_1"');
    expect(html).toContain('name="status"');
    expect(html).toContain('name="source"');
    expect(html).not.toContain("phone_hash");
    expect(html).not.toContain("access_token");
  });

  it("shows safe failure copy without raw provider details", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          auditResponse([
            {
              id: "event_error",
              eventName: "QualifiedLead",
              eventLabel: "Lead qualificado",
              deliveryState: "failed",
              statusLabel: "Falhou",
              statusDetail: "O envio nao foi concluido",
              source: "whatsapp_automation",
              sourceLabel: "Automacao do WhatsApp",
              leadId: null,
              leadName: null,
              phoneDisplay: null,
              campaignId: null,
              campaignName: null,
              adSetId: null,
              adSetName: null,
              adId: null,
              adName: null,
              pixelId: null,
              pageId: null,
              occurredAt: "2026-07-12T15:00:00.000Z",
              sentAt: null,
              status: "error",
              canRetry: false,
              providerResponseSummary: null,
              errorCode: "MetaCapiRejected",
              errorMessage: "A Meta recusou o evento",
              valueSource: null,
            },
          ]),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await EventsPage({
      searchParams: Promise.resolve({
        since: "2026-07-06",
        until: "2026-07-12",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("A Meta recusou o evento");
    expect(html).toContain("Lead nao vinculado");
    expect(html).toContain("Ainda nao enviado");
    expect(html).not.toContain("Reenviar");
  });

  it("shows retry only for an authorized transient Meta network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          auditResponse([
            {
              id: "event_network_error",
              eventName: "LeadSubmitted",
              eventLabel: "Conversas reais iniciadas",
              deliveryState: "failed",
              statusLabel: "Falhou",
              statusDetail: "O envio nao foi concluido",
              source: "external_integration",
              sourceLabel: "Integracao externa",
              leadId: "lead_1",
              leadName: "Mariana Alves",
              phoneDisplay: "+55 11 99999-1020",
              campaignId: "cmp_1",
              campaignName: "Campanha WhatsApp",
              adSetId: null,
              adSetName: null,
              adId: "ad_1",
              adName: "Anuncio 1",
              pixelId: "pixel_1",
              pageId: "page_1",
              occurredAt: "2026-07-12T15:00:00.000Z",
              sentAt: null,
              status: "error",
              canRetry: true,
              providerResponseSummary: null,
              errorCode: "MetaCapiNetworkError",
              errorMessage: "Falha de comunicacao com a Meta",
              valueSource: null,
            },
          ]),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const element = await EventsPage({
      searchParams: Promise.resolve({
        since: "2026-07-06",
        until: "2026-07-12",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Falha de comunicacao com a Meta");
    expect(html).toContain("Reenviar");
    expect(html).toContain('name="eventId"');
    expect(html).toContain('value="event_network_error"');
  });

  it("offers the owner a retry on a row blocked by configuration with honest copy", async () => {
    mockAuditApi({ audit: blockedAudit(true), role: "owner" });

    const element = await EventsPage({
      searchParams: Promise.resolve({
        since: "2026-07-06",
        until: "2026-07-12",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Bloqueado");
    expect(html).toContain('value="event_blocked"');
    expect(html).toContain(
      'title="Tentar enviar de novo com a conexao Meta atual"',
    );
    expect(html).not.toContain("Reenviar falha de comunicacao com a Meta");
  });

  it("hides every retry action from a member on blocked rows", async () => {
    mockAuditApi({ audit: blockedAudit(false), role: "member" });

    const element = await EventsPage({
      searchParams: Promise.resolve({
        since: "2026-07-06",
        until: "2026-07-12",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("Bloqueado");
    expect(html).not.toContain("Reenviar");
    expect(html).not.toContain('name="eventId"');
    expect(html).not.toContain("audit-retry-blocked-form");
  });

  it("lets the owner retry blocked events for the current period and filters", async () => {
    mockAuditApi({ audit: blockedAudit(true), role: "owner" });

    const element = await EventsPage({
      searchParams: Promise.resolve({
        since: "2026-07-06",
        until: "2026-07-12",
        eventName: "Purchase",
        status: "blocked",
        source: "external_integration",
        page: "2",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));
    const formStart = html.indexOf('class="audit-retry-blocked-form"');
    const form = html.slice(formStart, html.indexOf("</form>", formStart));

    expect(formStart).toBeGreaterThan(-1);
    expect(form).toContain("Reenviar bloqueados");
    expect(form).toContain('name="since" value="2026-07-06"');
    expect(form).toContain('name="until" value="2026-07-12"');
    expect(form).toContain('name="eventName" value="Purchase"');
    expect(form).toContain('name="status" value="blocked"');
    expect(form).toContain('name="source" value="external_integration"');
    expect(form).not.toContain('name="page"');
    expect(form).not.toContain("disabled");
    expect(html).toContain("Eventos ja enviados nao sao reenviados.");
  });

  it("disables the bulk retry when the period has no blocked events", async () => {
    mockAuditApi({ audit: auditResponse([auditEvent({})]), role: "owner" });

    const element = await EventsPage({
      searchParams: Promise.resolve({
        since: "2026-07-06",
        until: "2026-07-12",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));
    const formStart = html.indexOf('class="audit-retry-blocked-form"');
    const form = html.slice(formStart, html.indexOf("</form>", formStart));

    expect(formStart).toBeGreaterThan(-1);
    expect(form).toContain("Reenviar bloqueados");
    expect(form).toContain('disabled=""');
  });

  it("posts retry-blocked with the submitted filters and reports the returned counts", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        json({ claimed: 4, enqueued: 3, skipped: 2, failed: 1 }),
      );
    const formData = new FormData();
    formData.set("since", "2026-07-06");
    formData.set("until", "2026-07-12");
    formData.set("eventName", "Purchase");
    formData.set("status", "");
    formData.set("source", "external_integration");

    const state = await retryBlockedMetaEventsAction(
      initialBackofficeActionState,
      formData,
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3333/reports/conversions/audit/retry-blocked?since=2026-07-06&until=2026-07-12&eventName=Purchase&source=external_integration",
      expect.objectContaining({ method: "POST" }),
    );
    expect(state.status).toBe("success");
    expect(state.message).toBe(
      "3 eventos enfileirados para nova tentativa. 2 ja nao estavam bloqueados e ficaram de fora. 1 nao pode ser enfileirado agora; tente de novo em instantes.",
    );
  });

  it("says nothing was resent when no blocked event was eligible", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ claimed: 0, enqueued: 0, skipped: 0, failed: 0 }),
    );
    const formData = new FormData();
    formData.set("since", "2026-07-06");
    formData.set("until", "2026-07-12");

    const state = await retryBlockedMetaEventsAction(
      initialBackofficeActionState,
      formData,
    );

    expect(state.status).toBe("success");
    expect(state.message).toBe(
      "Nenhum evento bloqueado para reenviar neste periodo.",
    );
  });

  it("reports an error when the bulk retry is refused", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ message: "Somente o owner pode reenviar eventos Meta" }, 403),
    );
    const formData = new FormData();
    formData.set("since", "2026-07-06");
    formData.set("until", "2026-07-12");

    const state = await retryBlockedMetaEventsAction(
      initialBackofficeActionState,
      formData,
    );

    expect(state.status).toBe("error");
    expect(state.message).not.toContain("BM");
  });

  it("renders an unavailable state without invented events", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const element = await EventsPage({
      searchParams: Promise.resolve({
        since: "2026-07-06",
        until: "2026-07-12",
      }),
    });
    const html = renderToStaticMarkup(createElement("div", null, element));

    expect(html).toContain("API indisponivel");
    expect(html).toContain("Nao foi possivel carregar a auditoria");
    expect(html).not.toContain("Mariana Alves");
  });

  it("replaces the desktop audit table with readable event cards on mobile", () => {
    const css = readFileSync(
      new URL("../src/styles/layout-system.css", import.meta.url),
      "utf8",
    );
    const auditStylesStart = css.indexOf(
      "Wave 4: Meta Events becomes a layered delivery audit.",
    );
    const auditMobileStart = css.indexOf(
      "@media (max-width: 760px)",
      auditStylesStart,
    );
    const nextMediaStart = css.indexOf("@media", auditMobileStart + 1);
    const auditMobileBlock = css.slice(
      auditMobileStart,
      nextMediaStart === -1 ? undefined : nextMediaStart,
    );

    expect(auditStylesStart).toBeGreaterThan(-1);
    expect(css).toContain(".audit-primary-metrics");
    expect(css).toContain(".audit-mobile-history {\n  display: none;");
    expect(auditMobileBlock).toContain(
      ".audit-desktop-history {\n    display: none;",
    );
    expect(auditMobileBlock).toContain(
      ".audit-mobile-history {\n    display: grid;",
    );
    expect(auditMobileBlock).toContain(".audit-mobile-event-card");
    expect(auditMobileBlock).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr));",
    );
  });

  it("keeps the Meta audit controls compact with dark date fields", () => {
    const css = readFileSync(
      new URL("../src/styles/layout-system.css", import.meta.url),
      "utf8",
    );
    const auditStylesStart = css.indexOf(
      "Wave 4: Meta Events becomes a layered delivery audit.",
    );
    const nextWaveStart = css.indexOf("/* Wave 5:", auditStylesStart);
    const auditStyles = css.slice(auditStylesStart, nextWaveStart);

    expect(auditStyles).toContain(".audit-filter-form {");
    expect(auditStyles).toContain("padding: 12px 14px;");
    expect(auditStyles).toContain('.audit-filter-form input[type="date"] {');
    expect(auditStyles).toContain("rgba(5, 8, 7, 0.92)");
    expect(auditStyles).toContain("color-scheme: dark;");
    expect(auditStyles).toContain(".audit-advanced-filters[open] {");
    expect(auditStyles).toContain("grid-column: 1 / -1;");
  });
});
