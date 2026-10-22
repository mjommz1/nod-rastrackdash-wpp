import type {
  ConversionAuditDeliveryStateDto,
  ConversionAuditOverviewDto,
  ConversionAuditSourceDto,
} from "@wpptrack/shared";
import {
  AlertTriangle,
  Archive,
  Ban,
  CalendarRange,
  CheckCircle2,
  Clock3,
  Filter,
  History,
  MoonStar,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { PresentationMask } from "../../../components/presentation-mask";
import { getCurrentWorkspace } from "../../../lib/current-workspace";
import { formatDateTime } from "../../../lib/date-time";
import { serverApiFetch } from "../../../lib/server-api";
import { EventAuditDetails } from "./event-audit-details";
import { RetryBlockedEvents } from "./retry-blocked-events";

type EventsSearchParams = Record<string, string | string[] | undefined>;

type AuditFilters = {
  since: string;
  until: string;
  eventName?: string;
  status?: ConversionAuditDeliveryStateDto;
  source?: ConversionAuditSourceDto;
  page: number;
  pageSize: number;
};

type AuditResult =
  | { state: "real" | "empty"; report: ConversionAuditOverviewDto }
  | { state: "error"; report: null };

type AuditEvent = ConversionAuditOverviewDto["events"][number];

const emptySummary = {
  total: 0,
  sent: 0,
  queued: 0,
  blocked: 0,
  failed: 0,
  notEligible: 0,
  shadowObserved: 0,
  historical: 0,
  discarded: 0,
};

function asStringParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function positiveIntegerParam(value: string | undefined, fallback: number) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function dateOnlyInSaoPaulo(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));

  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function defaultPeriod() {
  const until = dateOnlyInSaoPaulo(new Date());
  const sinceDate = new Date(`${until}T12:00:00.000Z`);
  sinceDate.setUTCDate(sinceDate.getUTCDate() - 6);

  return { since: sinceDate.toISOString().slice(0, 10), until };
}

function auditQuery(filters: AuditFilters, page = filters.page): string {
  const params = new URLSearchParams({
    since: filters.since,
    until: filters.until,
    page: String(page),
    pageSize: String(filters.pageSize),
  });

  if (filters.eventName) {
    params.set("eventName", filters.eventName);
  }

  if (filters.status) {
    params.set("status", filters.status);
  }

  if (filters.source) {
    params.set("source", filters.source);
  }

  return params.toString();
}

async function getAudit(filters: AuditFilters): Promise<AuditResult> {
  try {
    const report = await serverApiFetch<ConversionAuditOverviewDto>(
      `/reports/conversions/audit?${auditQuery(filters)}`,
    );

    return {
      state: report.events.length ? "real" : "empty",
      report,
    };
  } catch {
    return { state: "error", report: null };
  }
}

/**
 * Mesma regra da API para reenviar eventos Meta: owner do workspace, ou o
 * platform_owner em modo suporte. Sem workspace legivel, o botao nao aparece.
 */
async function canRetryMetaEvents(): Promise<boolean> {
  try {
    const workspace = await getCurrentWorkspace();

    if (workspace.accessMode === "platform_support") {
      return workspace.platformRole === "platform_owner";
    }

    return workspace.role === "owner";
  } catch {
    return false;
  }
}

function stateChipClass(state: ConversionAuditDeliveryStateDto): string {
  if (state === "failed") {
    return "event-chip bad";
  }

  if (state === "queued" || state === "blocked") {
    return "event-chip warn";
  }

  if (
    state === "not_eligible" ||
    state === "shadow" ||
    state === "historical" ||
    state === "discarded"
  ) {
    return "event-chip neutral";
  }

  return "event-chip";
}

function auditDate(value: string | null): string {
  if (!value) {
    return "-";
  }

  return formatDateTime(value, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function AuditLead({ event }: { event: AuditEvent }) {
  return (
    <div className="audit-context-block">
      <span className="micro-label">Lead</span>
      <strong>
        {event.leadId ? (
          <PresentationMask placeholder="Lead oculto">
            <Link href={`/leads/${event.leadId}`}>
              {event.leadName ?? "Lead sem nome"}
            </Link>
          </PresentationMask>
        ) : (
          "Lead nao vinculado"
        )}
      </strong>
      <span>
        <PresentationMask placeholder="(00) 00000-0000">
          {event.phoneDisplay ?? "Telefone indisponivel"}
        </PresentationMask>
      </span>
    </div>
  );
}

function AuditCampaign({ event }: { event: AuditEvent }) {
  return (
    <div className="audit-context-block audit-campaign-context">
      <span className="micro-label">Campanha</span>
      <strong>
        <PresentationMask placeholder="Campanha oculta">
          {event.campaignName ?? "Campanha nao resolvida"}
        </PresentationMask>
      </strong>
      <span>
        <PresentationMask placeholder="Conjunto oculto">
          {event.adSetName ?? "Conjunto nao resolvido"}
        </PresentationMask>
      </span>
      <span>
        <PresentationMask placeholder="Anuncio oculto">
          {event.adName ?? "Anuncio nao resolvido"}
        </PresentationMask>
      </span>
    </div>
  );
}

function AuditDelivery({ event }: { event: AuditEvent }) {
  return (
    <div className="audit-delivery-copy">
      <span className={stateChipClass(event.deliveryState)}>
        {event.statusLabel}
      </span>
      <span>{event.statusDetail}</span>
      {event.errorMessage ? (
        <span
          className={
            event.deliveryState === "failed" ||
            event.deliveryState === "blocked"
              ? "audit-error-copy"
              : "audit-reason-copy"
          }
        >
          {event.errorMessage}
        </span>
      ) : null}
    </div>
  );
}

function AuditMobileEventCard({ event }: { event: AuditEvent }) {
  return (
    <article className={`audit-mobile-event-card ${event.deliveryState}`}>
      <header>
        <div>
          <span className="micro-label">{event.sourceLabel}</span>
          <h3>{event.eventLabel}</h3>
          <code>{event.eventName}</code>
        </div>
        <span className={stateChipClass(event.deliveryState)}>
          {event.statusLabel}
        </span>
      </header>

      <div className="audit-mobile-event-body">
        <AuditLead event={event} />
        <div className="audit-context-block">
          <span className="micro-label">Ocorrido</span>
          <strong>{auditDate(event.occurredAt)}</strong>
          <span>
            {event.sentAt
              ? `Enviado ${auditDate(event.sentAt)}`
              : "Ainda nao enviado"}
          </span>
        </div>
        <AuditCampaign event={event} />
        <div className="audit-mobile-delivery-detail">
          <span className="micro-label">Entrega</span>
          <AuditDelivery event={event} />
        </div>
      </div>

      <footer>
        <EventAuditDetails
          canRetry={event.canRetry}
          deliveryState={event.deliveryState}
          eventId={event.id}
          eventLabel={event.eventLabel}
        />
      </footer>
    </article>
  );
}

function AuditPrimaryMetric({
  detail,
  icon: Icon,
  label,
  tone,
  value,
}: {
  detail: string;
  icon: LucideIcon;
  label: string;
  tone: string;
  value: number;
}) {
  return (
    <article className={`audit-primary-metric ${tone}`}>
      <div>
        <Icon aria-hidden="true" size={17} strokeWidth={2.1} />
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams?: Promise<EventsSearchParams>;
}) {
  const params = searchParams ? await searchParams : {};
  const period = defaultPeriod();
  const since = asStringParam(params.since) ?? period.since;
  const until = asStringParam(params.until) ?? period.until;
  const eventName = asStringParam(params.eventName);
  const status = asStringParam(params.status) as
    ConversionAuditDeliveryStateDto | undefined;
  const source = asStringParam(params.source) as
    ConversionAuditSourceDto | undefined;
  const page = positiveIntegerParam(asStringParam(params.page), 1);
  const pageSize = Math.min(
    positiveIntegerParam(asStringParam(params.pageSize), 25),
    100,
  );
  const filters: AuditFilters = {
    since,
    until,
    eventName,
    status,
    source,
    page,
    pageSize,
  };
  const [result, canRetryBlocked] = await Promise.all([
    getAudit(filters),
    canRetryMetaEvents(),
  ]);
  const report = result.report;
  const summary = report?.summary ?? emptySummary;
  const pagination = report?.pagination ?? {
    page,
    pageSize,
    totalItems: 0,
    totalPages: 0,
  };
  const hasAttention = summary.blocked + summary.failed > 0;
  const activeFilterCount = [eventName, status, source].filter(Boolean).length;
  const clearFiltersHref = `/events?since=${since}&until=${until}&pageSize=${pageSize}`;
  const primaryMetrics = [
    {
      detail: "Recebidos pela Meta",
      icon: CheckCircle2,
      label: "Enviados",
      tone: "sent",
      value: summary.sent,
    },
    {
      detail: "Aguardando processamento",
      icon: Clock3,
      label: "Na fila",
      tone: "queued",
      value: summary.queued,
    },
    {
      detail: "Dependem de configuracao",
      icon: ShieldAlert,
      label: "Bloqueados",
      tone: "blocked",
      value: summary.blocked,
    },
    {
      detail: "Envio nao concluido",
      icon: AlertTriangle,
      label: "Falhas",
      tone: "failed",
      value: summary.failed,
    },
  ];
  const classifiedMetrics = [
    {
      icon: Ban,
      label: "Nao elegiveis",
      tone: "not_eligible",
      value: summary.notEligible,
    },
    {
      icon: MoonStar,
      label: "Em sombra",
      tone: "shadow",
      value: summary.shadowObserved,
    },
    {
      icon: Archive,
      label: "Historicos",
      tone: "historical",
      value: summary.historical,
    },
    {
      icon: Trash2,
      label: "Descartados",
      tone: "discarded",
      value: summary.discarded,
    },
  ];

  return (
    <section className="page-stack page-wide audit-page">
      <header className="page-header audit-page-header">
        <div>
          <span className="eyebrow">Eventos Meta</span>
          <h1>Auditoria de conversoes</h1>
          <p>
            Acompanhe o que foi enviado, o que esta aguardando e o que precisa
            de atencao antes de chegar a Meta.
          </p>
        </div>
        <div className="header-actions">
          {result.state === "error" ? (
            <span className="status-chip bad">API indisponivel</span>
          ) : hasAttention ? (
            <span className="status-chip warn">Requer atencao</span>
          ) : (
            <span className="status-chip">Fluxo acompanhado</span>
          )}
        </div>
      </header>

      <nav
        className="report-view-tabs audit-view-tabs"
        aria-label="Visoes de eventos Meta"
      >
        <Link className="active" href="/events">
          Conversoes
        </Link>
        <Link href="/events/purchase-reviews">Revisao de compras</Link>
      </nav>

      <section
        className="surface-panel audit-command-panel"
        aria-label="Controles da auditoria Meta"
      >
        <form
          action="/events"
          aria-label="Filtros da auditoria Meta"
          className="audit-filter-form"
        >
          <input type="hidden" name="pageSize" value={pageSize} />
          <div className="audit-period-context">
            <CalendarRange aria-hidden="true" size={18} strokeWidth={2.1} />
            <span>
              <strong>Periodo da auditoria</strong>
              <small>{report?.rangeLabel ?? `${since} a ${until}`}</small>
            </span>
          </div>
          <label className="filter-field">
            <span>Inicio</span>
            <input type="date" name="since" defaultValue={since} />
          </label>
          <label className="filter-field">
            <span>Fim</span>
            <input type="date" name="until" defaultValue={until} />
          </label>
          <button className="button" type="submit">
            <Filter aria-hidden="true" size={16} strokeWidth={2.1} />
            Aplicar
          </button>

          <details
            className="audit-advanced-filters"
            open={activeFilterCount > 0}
          >
            <summary>
              <span>
                <SlidersHorizontal aria-hidden="true" size={15} />
                Filtros
              </span>
              {activeFilterCount > 0 ? (
                <span className="tag">{activeFilterCount} ativo(s)</span>
              ) : (
                <span className="muted">Opcional</span>
              )}
            </summary>
            <div className="audit-filter-grid">
              <label className="filter-field">
                <span>Evento</span>
                <select
                  className="filter-control"
                  name="eventName"
                  defaultValue={eventName ?? ""}
                >
                  <option value="">Todos os eventos</option>
                  <option value="LeadSubmitted">Conversa iniciada</option>
                  <option value="QualifiedLead">Lead qualificado</option>
                  <option value="Purchase">Compra</option>
                </select>
              </label>
              <label className="filter-field">
                <span>Estado da entrega</span>
                <select
                  className="filter-control"
                  name="status"
                  defaultValue={status ?? ""}
                >
                  <option value="">Todos os estados</option>
                  <option value="sent">Enviados</option>
                  <option value="queued">Aguardando envio</option>
                  <option value="blocked">Bloqueados</option>
                  <option value="failed">Falhas</option>
                  <option value="not_eligible">Nao elegiveis</option>
                  <option value="shadow">Observados em sombra</option>
                  <option value="historical">Historicos</option>
                  <option value="discarded">Descartados</option>
                </select>
              </label>
              <label className="filter-field">
                <span>Origem</span>
                <select
                  className="filter-control"
                  name="source"
                  defaultValue={source ?? ""}
                >
                  <option value="">Todas as origens</option>
                  <option value="external_integration">
                    Integracao externa
                  </option>
                  <option value="whatsapp_automation">
                    Automacao do WhatsApp
                  </option>
                  <option value="system">Regra automatica</option>
                  <option value="manual_test">Teste manual</option>
                  <option value="other">Outra origem</option>
                </select>
              </label>
            </div>
            <footer className="audit-filter-footer">
              <span>
                {activeFilterCount > 0
                  ? "A lista esta usando filtros personalizados."
                  : "Todos os tipos, estados e origens estao incluidos."}
              </span>
              {activeFilterCount > 0 ? (
                <Link className="button ghost" href={clearFiltersHref}>
                  Limpar filtros
                </Link>
              ) : null}
            </footer>
          </details>
        </form>
      </section>

      <section
        className="surface-panel audit-health-panel"
        aria-labelledby="audit-health-title"
      >
        <header className="audit-health-heading">
          <div className="audit-heading-copy">
            <span className="audit-heading-icon" aria-hidden="true">
              <ShieldAlert size={18} strokeWidth={2.1} />
            </span>
            <div>
              <span className="eyebrow">Saude da entrega</span>
              <h2 id="audit-health-title">Fluxo para a Meta</h2>
              <p>Estados operacionais primeiro; classificacoes em seguida.</p>
            </div>
          </div>
          <span className="status-chip neutral">
            {summary.total} eventos no periodo
          </span>
        </header>

        <div className="audit-primary-metrics">
          {primaryMetrics.map((metric) => (
            <AuditPrimaryMetric key={metric.tone} {...metric} />
          ))}
        </div>

        <div className="audit-classification-strip">
          <span className="audit-classification-label">
            Fora da fila de envio
          </span>
          <div>
            {classifiedMetrics.map((metric) => {
              const Icon = metric.icon;

              return (
                <span
                  className={`audit-classification-item ${metric.tone}`}
                  key={metric.tone}
                >
                  <Icon aria-hidden="true" size={14} strokeWidth={2.1} />
                  <span>{metric.label}</span>
                  <strong>{metric.value}</strong>
                </span>
              );
            })}
          </div>
        </div>
      </section>

      <div className="audit-section-heading">
        <div className="audit-heading-copy">
          <span className="audit-heading-icon" aria-hidden="true">
            <History size={18} strokeWidth={2.1} />
          </span>
          <div>
            <span className="eyebrow">Historico de entrega</span>
            <h2>Eventos do periodo</h2>
          </div>
        </div>
        <div className="audit-history-context">
          <span className="status-chip neutral">
            {pagination.totalItems} registro(s)
          </span>
          <span className="muted">
            {report?.rangeLabel ?? `${since} a ${until}`}
          </span>
          {canRetryBlocked && result.state !== "error" ? (
            <>
              <RetryBlockedEvents
                blockedCount={summary.blocked}
                filters={{
                  since,
                  until,
                  eventName: eventName ?? "",
                  status: status ?? "",
                  source: source ?? "",
                }}
              />
              <span className="muted">
                Ate 500 por vez, com os filtros atuais. Eventos ja enviados nao
                sao reenviados.
              </span>
            </>
          ) : null}
        </div>
      </div>

      <div className="table-wrap audit-table-scroll audit-desktop-history">
        <table className="audit-table">
          <thead>
            <tr>
              <th>Evento / origem</th>
              <th>Lead e campanha</th>
              <th>Entrega</th>
              <th>Ocorrido / enviado</th>
              <th>Auditoria</th>
            </tr>
          </thead>
          <tbody>
            {report?.events.length ? (
              report.events.map((event) => (
                <tr key={event.id}>
                  <td>
                    <strong>{event.eventLabel}</strong>
                    <span>{event.eventName}</span>
                    <span>{event.sourceLabel}</span>
                  </td>
                  <td>
                    <div className="audit-context-stack">
                      <AuditLead event={event} />
                      <AuditCampaign event={event} />
                    </div>
                  </td>
                  <td>
                    <AuditDelivery event={event} />
                  </td>
                  <td>
                    <strong>{auditDate(event.occurredAt)}</strong>
                    <span>
                      {event.sentAt
                        ? `Enviado ${auditDate(event.sentAt)}`
                        : "Ainda nao enviado"}
                    </span>
                  </td>
                  <td>
                    <EventAuditDetails
                      canRetry={event.canRetry}
                      deliveryState={event.deliveryState}
                      eventId={event.id}
                      eventLabel={event.eventLabel}
                    />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5}>
                  <strong>
                    {result.state === "error"
                      ? "Nao foi possivel carregar a auditoria"
                      : "Nenhum evento encontrado"}
                  </strong>
                  <span>
                    {result.state === "error"
                      ? "A leitura falhou. Tente novamente depois que a API responder."
                      : "Ajuste o periodo ou aguarde a chegada de novos eventos."}
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="audit-mobile-history" role="list">
        {report?.events.length ? (
          report.events.map((event) => (
            <AuditMobileEventCard event={event} key={event.id} />
          ))
        ) : (
          <div className="audit-mobile-empty">
            <strong>
              {result.state === "error"
                ? "Nao foi possivel carregar a auditoria"
                : "Nenhum evento encontrado"}
            </strong>
            <span>
              {result.state === "error"
                ? "A leitura falhou. Tente novamente depois que a API responder."
                : "Ajuste o periodo ou aguarde a chegada de novos eventos."}
            </span>
          </div>
        )}
      </div>

      <nav className="report-pagination" aria-label="Paginacao de eventos Meta">
        <span>
          Pagina {pagination.page} de {Math.max(pagination.totalPages, 1)} /{" "}
          {pagination.totalItems} eventos
        </span>
        <div>
          {pagination.page > 1 ? (
            <Link
              className="button ghost"
              href={`/events?${auditQuery(filters, pagination.page - 1)}`}
            >
              Anterior
            </Link>
          ) : (
            <span className="button ghost disabled" aria-disabled="true">
              Anterior
            </span>
          )}
          {pagination.page < pagination.totalPages ? (
            <Link
              className="button ghost"
              href={`/events?${auditQuery(filters, pagination.page + 1)}`}
            >
              Proxima
            </Link>
          ) : (
            <span className="button ghost disabled" aria-disabled="true">
              Proxima
            </span>
          )}
        </div>
      </nav>
    </section>
  );
}
