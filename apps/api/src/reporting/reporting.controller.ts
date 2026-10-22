import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import {
  conversionAuditDeliveryStateSchema,
  conversionAuditSourceSchema,
  metaBudgetUpdateInputSchema,
  metaEntityStatusUpdateInputSchema,
  metaWhatsappOverrideInputSchema,
  reportSortSchema,
  type ConversionAuditDeliveryStateDto,
  type ConversionAuditSourceDto,
  type ReportSortDto,
} from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { DiagnosticsService } from "../diagnostics/diagnostics.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { MetaReportSyncQueueService } from "./meta-report-sync-queue.service";
import { MetaInitialSyncPeriodService } from "./meta-initial-sync-period";
import { MetaReportingService } from "./meta-reporting.service";

type HeaderResponse = {
  setHeader(name: string, value: string): void;
};

type ReportPeriod = {
  since: string;
  until: string;
  rangeLabel: string;
};

type ReportPagination = {
  page: number;
  pageSize: number;
};

type WhatsappClassificationFilter =
  "whatsapp" | "needs_review" | "excluded" | "all";
/** Implatec: tipo da campanha (WhatsApp x formulario Lead Ads). */
type CampaignKindFilter = "all" | "whatsapp" | "lead_form";
type ReportNameScope = "campaign" | "adset" | "ad";
type ReportStatusFilter = "all" | "active" | "paused";
type ReportDeliveryFilter = "all" | "had_delivery";

type ReportFilters = {
  businessId?: string;
  adAccountId?: string;
  adAccountIds?: string[];
  campaignId?: string;
  adSetId?: string;
  adId?: string;
  nameScope?: ReportNameScope;
  nameContains?: string;
  status?: ReportStatusFilter;
  delivery?: ReportDeliveryFilter;
  selectedEntityIds?: string[];
  whatsappClassification?: WhatsappClassificationFilter;
  campaignKind?: CampaignKindFilter;
};

@Controller("reports")
export class ReportingController {
  constructor(
    @Inject(MetaReportingService)
    private readonly metaReportingService: MetaReportingService,
    @Inject(MetaReportSyncQueueService)
    private readonly metaReportSyncQueueService: MetaReportSyncQueueService,
    @Inject(MetaInitialSyncPeriodService)
    private readonly metaInitialSyncPeriodService: MetaInitialSyncPeriodService,
    @Inject(AuthService)
    private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(DiagnosticsService)
    private readonly diagnosticsService: DiagnosticsService,
  ) {}

  @Get("campaigns")
  async getCampaignReports(
    @AuthToken() refreshToken: string,
    @Query("since") since?: string,
    @Query("until") until?: string,
    @Query("businessId") businessId?: string | string[],
    @Query("adAccountId") adAccountId?: string | string[],
    @Query("campaignId") campaignId?: string | string[],
    @Query("adSetId") adSetId?: string | string[],
    @Query("adId") adId?: string | string[],
    @Query("nameScope") nameScope?: string | string[],
    @Query("nameContains") nameContains?: string | string[],
    @Query("status") status?: string | string[],
    @Query("delivery") delivery?: string | string[],
    @Query("selectedIds") selectedIds?: string | string[],
    @Query("whatsappClassification") whatsappClassification?: string | string[],
    @Query("includeSummary") includeSummary?: string | string[],
    @Query("includeDaily") includeDaily?: string | string[],
    @Query("page") page?: string | string[],
    @Query("pageSize") pageSize?: string | string[],
    @Query("sort") sort?: unknown,
    @Query("dir") dir?: unknown,
    @Query("adAccountIds") adAccountIds?: string | string[],
    // Implatec: por ultimo para nao deslocar os parametros posicionais.
    @Query("campaignKind") campaignKind?: string | string[],
  ) {
    const workspace = await this.getCurrentWorkspace(refreshToken);

    if (!workspace.permissions.canExportReports) {
      throw new ForbiddenException("Sem permissao para exportar relatorios");
    }

    const workspaceId = workspace.id;
    const period = this.parseReportPeriod(since, until);
    const filters = this.parseReportFilters({
      businessId,
      adAccountId,
      adAccountIds,
      campaignId,
      adSetId,
      adId,
      nameScope,
      nameContains,
      status,
      delivery,
      selectedIds,
      whatsappClassification,
      campaignKind,
    });
    const pagination = this.parseReportPagination(page, pageSize);
    const reportSort = this.parseReportSort(sort, dir);
    const includeWorkspaceSummary = this.parseBooleanFlag(includeSummary);
    const includeDailyComparison = this.parseBooleanFlag(includeDaily);

    return this.metaReportingService.getCampaignReportOverview({
      workspaceId,
      ...period,
      ...filters,
      ...(includeWorkspaceSummary ? { includeSummary: true } : {}),
      ...(includeDailyComparison ? { includeDaily: true } : {}),
      ...pagination,
      ...reportSort,
    });
  }

  @Get("campaigns/export.csv")
  async exportCampaignReports(
    @AuthToken() refreshToken: string,
    @Res({ passthrough: true }) response: HeaderResponse,
    @Query("since") since?: string,
    @Query("until") until?: string,
    @Query("businessId") businessId?: string | string[],
    @Query("adAccountId") adAccountId?: string | string[],
    @Query("campaignId") campaignId?: string | string[],
    @Query("adSetId") adSetId?: string | string[],
    @Query("adId") adId?: string | string[],
    @Query("nameScope") nameScope?: string | string[],
    @Query("nameContains") nameContains?: string | string[],
    @Query("status") status?: string | string[],
    @Query("delivery") delivery?: string | string[],
    @Query("selectedIds") selectedIds?: string | string[],
    @Query("whatsappClassification") whatsappClassification?: string | string[],
    @Query("adAccountIds") adAccountIds?: string | string[],
    // Implatec: por ultimo para nao deslocar os parametros posicionais.
    @Query("campaignKind") campaignKind?: string | string[],
  ) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);
    const period = this.parseReportPeriod(since, until);
    const filters = this.parseReportFilters({
      businessId,
      adAccountId,
      adAccountIds,
      campaignId,
      adSetId,
      adId,
      nameScope,
      nameContains,
      status,
      delivery,
      selectedIds,
      whatsappClassification,
      campaignKind,
    });
    const csv = await this.metaReportingService.getCampaignReportCsv({
      workspaceId,
      ...period,
      ...filters,
    });

    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${csv.filename}"`,
    );

    return csv.content;
  }

  @Get("adsets")
  async getAdSetReports(
    @AuthToken() refreshToken: string,
    @Query("since") since?: string,
    @Query("until") until?: string,
    @Query("businessId") businessId?: string | string[],
    @Query("adAccountId") adAccountId?: string | string[],
    @Query("campaignId") campaignId?: string | string[],
    @Query("adSetId") adSetId?: string | string[],
    @Query("adId") adId?: string | string[],
    @Query("nameScope") nameScope?: string | string[],
    @Query("nameContains") nameContains?: string | string[],
    @Query("status") status?: string | string[],
    @Query("delivery") delivery?: string | string[],
    @Query("selectedIds") selectedIds?: string | string[],
    @Query("whatsappClassification") whatsappClassification?: string | string[],
    @Query("page") page?: string | string[],
    @Query("pageSize") pageSize?: string | string[],
    @Query("sort") sort?: unknown,
    @Query("dir") dir?: unknown,
    @Query("adAccountIds") adAccountIds?: string | string[],
    // Implatec: por ultimo para nao deslocar os parametros posicionais.
    @Query("campaignKind") campaignKind?: string | string[],
  ) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);
    const period = this.parseReportPeriod(since, until);
    const filters = this.parseReportFilters({
      businessId,
      adAccountId,
      adAccountIds,
      campaignId,
      adSetId,
      adId,
      nameScope,
      nameContains,
      status,
      delivery,
      selectedIds,
      whatsappClassification,
      campaignKind,
    });
    const pagination = this.parseReportPagination(page, pageSize);
    const reportSort = this.parseReportSort(sort, dir);

    return this.metaReportingService.getAdSetReportOverview({
      workspaceId,
      ...period,
      ...filters,
      ...pagination,
      ...reportSort,
    });
  }

  @Get("ads")
  async getAdReports(
    @AuthToken() refreshToken: string,
    @Query("since") since?: string,
    @Query("until") until?: string,
    @Query("businessId") businessId?: string | string[],
    @Query("adAccountId") adAccountId?: string | string[],
    @Query("campaignId") campaignId?: string | string[],
    @Query("adSetId") adSetId?: string | string[],
    @Query("adId") adId?: string | string[],
    @Query("nameScope") nameScope?: string | string[],
    @Query("nameContains") nameContains?: string | string[],
    @Query("status") status?: string | string[],
    @Query("delivery") delivery?: string | string[],
    @Query("selectedIds") selectedIds?: string | string[],
    @Query("whatsappClassification") whatsappClassification?: string | string[],
    @Query("page") page?: string | string[],
    @Query("pageSize") pageSize?: string | string[],
    @Query("sort") sort?: unknown,
    @Query("dir") dir?: unknown,
    @Query("adAccountIds") adAccountIds?: string | string[],
    // Implatec: por ultimo para nao deslocar os parametros posicionais.
    @Query("campaignKind") campaignKind?: string | string[],
  ) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);
    const period = this.parseReportPeriod(since, until);
    const filters = this.parseReportFilters({
      businessId,
      adAccountId,
      adAccountIds,
      campaignId,
      adSetId,
      adId,
      nameScope,
      nameContains,
      status,
      delivery,
      selectedIds,
      whatsappClassification,
      campaignKind,
    });
    const pagination = this.parseReportPagination(page, pageSize);
    const reportSort = this.parseReportSort(sort, dir);

    return this.metaReportingService.getAdReportOverview({
      workspaceId,
      ...period,
      ...filters,
      ...pagination,
      ...reportSort,
    });
  }

  @Get("conversions/audit")
  async getConversionEventAudit(
    @AuthToken() refreshToken: string,
    @Query("since") since?: string,
    @Query("until") until?: string,
    @Query("eventName") eventName?: string | string[],
    @Query("status") status?: string | string[],
    @Query("source") source?: string | string[],
    @Query("page") page?: string | string[],
    @Query("pageSize") pageSize?: string | string[],
  ) {
    const workspace = await this.getCurrentWorkspace(refreshToken);

    if (!workspace.permissions.canViewReports) {
      throw new ForbiddenException("Sem permissao para visualizar relatorios");
    }

    const workspaceId = workspace.id;
    const period = this.parseReportPeriod(since, until);
    const eventNameFilter = this.trimOptional(eventName);
    const deliveryState = this.parseConversionAuditStatus(status);
    const sourceFilter = this.parseConversionAuditSource(source);

    const report = await this.metaReportingService.getConversionEventAudit({
      workspaceId,
      ...period,
      ...(eventNameFilter ? { eventName: eventNameFilter } : {}),
      ...(deliveryState ? { deliveryState } : {}),
      ...(sourceFilter ? { source: sourceFilter } : {}),
      page: this.parsePositiveInteger(page, 1, "Pagina invalida"),
      pageSize: this.parsePositiveInteger(
        pageSize,
        25,
        "Tamanho de pagina invalido",
        100,
      ),
    });

    return {
      ...report,
      events: report.events.map((event) => ({
        ...event,
        canRetry: event.canRetry && this.canRetryMetaEvent(workspace),
      })),
    };
  }

  @Get("conversions/audit/:eventId")
  async getConversionEventAuditDetail(
    @AuthToken() refreshToken: string,
    @Param("eventId") eventId: string,
  ) {
    const workspace = await this.getCurrentWorkspace(refreshToken);

    if (!workspace.permissions.canViewReports) {
      throw new ForbiddenException("Sem permissao para visualizar relatorios");
    }

    const detail =
      await this.metaReportingService.getConversionEventAuditDetail({
        workspaceId: workspace.id,
        eventId,
      });

    return {
      ...detail,
      canRetry: detail.canRetry && this.canRetryMetaEvent(workspace),
    };
  }

  @Post("conversions/audit/:eventId/retry")
  async retryConversionEventAudit(
    @AuthToken() refreshToken: string,
    @Param("eventId") eventId: string,
  ) {
    const { authenticated, workspace } =
      await this.getCurrentWorkspaceContext(refreshToken);

    if (!this.canRetryMetaEvent(workspace)) {
      throw new ForbiddenException(
        "Somente o owner pode reenviar eventos Meta",
      );
    }

    return this.diagnosticsService.retryConversionEvent(
      eventId,
      { reason: "Reenvio manual de evento Meta" },
      {
        workspaceId: workspace.id,
        actorUserId: authenticated.user.id,
        actorType:
          workspace.accessMode === "platform_support"
            ? "platform_owner"
            : "workspace_owner",
        transientOnly: true,
        allowConfigurationBlocked: true,
        requesterLabel: "pelo owner do workspace",
      },
    );
  }

  @Post("conversions/audit/retry-blocked")
  async retryBlockedConversionEventAudit(
    @AuthToken() refreshToken: string,
    @Query("since") since?: string,
    @Query("until") until?: string,
    @Query("eventName") eventName?: string | string[],
    @Query("status") status?: string | string[],
    @Query("source") source?: string | string[],
  ) {
    const { authenticated, workspace } =
      await this.getCurrentWorkspaceContext(refreshToken);

    if (!this.canRetryMetaEvent(workspace)) {
      throw new ForbiddenException(
        "Somente o owner pode reenviar eventos Meta",
      );
    }

    const period = this.parseReportPeriod(since, until);
    const eventNameFilter = this.trimOptional(eventName);
    const deliveryState = this.parseConversionAuditStatus(status);
    const sourceFilter = this.parseConversionAuditSource(source);
    const eventIds =
      await this.metaReportingService.getBlockedConversionEventRetryIds({
        workspaceId: workspace.id,
        ...period,
        ...(eventNameFilter ? { eventName: eventNameFilter } : {}),
        ...(deliveryState ? { deliveryState } : {}),
        ...(sourceFilter ? { source: sourceFilter } : {}),
      });

    return this.diagnosticsService.retryBlockedConversionEvents(
      eventIds,
      { reason: "Reenvio manual de eventos Meta bloqueados por configuracao" },
      {
        workspaceId: workspace.id,
        actorUserId: authenticated.user.id,
        actorType:
          workspace.accessMode === "platform_support"
            ? "platform_owner"
            : "workspace_owner",
        requesterLabel: "pelo owner do workspace",
      },
    );
  }

  @Post("meta/sync")
  async syncMetaReports(
    @AuthToken() refreshToken: string,
    @Query("since") since = this.defaultSince(),
    @Query("until") until = this.defaultUntil(),
  ) {
    const workspace = await this.getCurrentWorkspace(refreshToken);
    const period = this.parseReportPeriod(since, until);

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para sincronizar relatorios");
    }

    return this.metaReportSyncQueueService.enqueueWorkspaceSync({
      workspaceId: workspace.id,
      since: period.since as string,
      until: period.until as string,
    });
  }

  @Get("meta/initial-sync-period")
  async getMetaInitialSyncPeriod(@AuthToken() refreshToken: string) {
    const workspace = await this.getCurrentWorkspace(refreshToken);

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para sincronizar relatorios");
    }

    return this.metaInitialSyncPeriodService.resolve({
      workspaceId: workspace.id,
    });
  }

  @Get("meta/structure")
  async getMetaStructure(@AuthToken() refreshToken: string) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);

    return this.metaReportingService.getMetaStructureReport(workspaceId);
  }

  @Put("meta/entity-status")
  async updateMetaEntityStatus(
    @AuthToken() refreshToken: string,
    @Body() body: unknown,
  ) {
    const parsed = metaEntityStatusUpdateInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException("Payload invalido");
    }

    const { authenticated, workspace } =
      await this.getCurrentWorkspaceContext(refreshToken);

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.metaReportingService.updateMetaEntityStatus({
      workspaceId: workspace.id,
      actorUserId: authenticated.user.id ?? null,
      ...parsed.data,
    });
  }

  @Put("meta/budget")
  async updateMetaEntityBudget(
    @AuthToken() refreshToken: string,
    @Body() body: unknown,
  ) {
    const parsed = metaBudgetUpdateInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException("Payload invalido");
    }

    const { authenticated, workspace } =
      await this.getCurrentWorkspaceContext(refreshToken);

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.metaReportingService.updateMetaEntityBudget({
      workspaceId: workspace.id,
      actorUserId: authenticated.user.id ?? null,
      ...parsed.data,
    });
  }

  @Put("meta/whatsapp-classification")
  async saveWhatsappClassificationOverride(
    @AuthToken() refreshToken: string,
    @Body() body: unknown,
  ) {
    const parsed = metaWhatsappOverrideInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException("Payload invalido");
    }

    const { authenticated, workspace } =
      await this.getCurrentWorkspaceContext(refreshToken);

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.metaReportingService.saveWhatsappClassificationOverride({
      workspaceId: workspace.id,
      actorUserId: authenticated.user.id ?? null,
      ...parsed.data,
    });
  }

  private async getCurrentWorkspaceId(refreshToken: string): Promise<string> {
    const workspace = await this.getCurrentWorkspace(refreshToken);

    if (!workspace.permissions.canViewReports) {
      throw new ForbiddenException("Sem permissao para visualizar relatorios");
    }

    return workspace.id;
  }

  private async getCurrentWorkspace(refreshToken: string) {
    const { workspace } = await this.getCurrentWorkspaceContext(refreshToken);

    return workspace;
  }

  private async getCurrentWorkspaceContext(refreshToken: string) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    return { authenticated, workspace };
  }

  private canRetryMetaEvent(
    workspace: ReturnType<WorkspacesService["getCurrentWorkspace"]>,
  ): boolean {
    if (workspace.accessMode === "platform_support") {
      return workspace.platformRole === "platform_owner";
    }

    return workspace.role === "owner";
  }

  private defaultSince(): string {
    const date = new Date(`${this.defaultUntil()}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() - 6);

    return date.toISOString().slice(0, 10);
  }

  private defaultUntil(): string {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: process.env.WPPTRACK_REPORT_TIMEZONE ?? "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const values = new Map(parts.map((part) => [part.type, part.value]));

    return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
  }

  private parseReportPeriod(since?: string, until?: string): ReportPeriod {
    if (!since && !until) {
      return {
        since: this.defaultSince(),
        until: this.defaultUntil(),
        rangeLabel: "Ultimos 7 dias",
      };
    }

    if (!this.isDateOnly(since) || !this.isDateOnly(until)) {
      throw new BadRequestException("Periodo invalido");
    }

    if (since > until) {
      throw new BadRequestException("Periodo invalido");
    }

    return {
      since,
      until,
      rangeLabel: `${since} a ${until}`,
    };
  }

  private parseReportPagination(
    page?: string | string[],
    pageSize?: string | string[],
  ): Partial<ReportPagination> {
    if (page === undefined && pageSize === undefined) {
      return {};
    }

    return {
      page: this.parsePositiveInteger(page, 1, "Pagina invalida"),
      pageSize: this.parsePositiveInteger(
        pageSize,
        10,
        "Tamanho de pagina invalido",
        100,
      ),
    };
  }

  private parseReportSort(
    sort?: unknown,
    dir?: unknown,
  ): { sort?: ReportSortDto } {
    if (
      (sort !== undefined && typeof sort !== "string") ||
      (dir !== undefined && typeof dir !== "string")
    ) {
      throw new BadRequestException("Ordenacao de relatorio invalida");
    }

    if (!sort) {
      if (dir) {
        throw new BadRequestException(
          "Direcao de ordenacao exige campo de ordenacao",
        );
      }

      return {};
    }

    const parsed = reportSortSchema.safeParse({
      key: sort,
      ...(dir ? { direction: dir } : {}),
    });

    if (!parsed.success) {
      throw new BadRequestException("Ordenacao de relatorio invalida");
    }

    return { sort: parsed.data };
  }

  private parsePositiveInteger(
    value: string | string[] | undefined,
    fallback: number,
    message: string,
    max?: number,
  ): number {
    if (Array.isArray(value)) {
      throw new BadRequestException("Filtro de relatorio invalido");
    }

    if (value === undefined || value === "") {
      return fallback;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < 1 || (max && parsed > max)) {
      throw new BadRequestException(message);
    }

    return parsed;
  }

  private parseBooleanFlag(value?: string | string[]): boolean {
    if (Array.isArray(value)) {
      throw new BadRequestException("Filtro de relatorio invalido");
    }

    return value === "true";
  }

  private parseConversionAuditStatus(
    value?: string | string[],
  ): ConversionAuditDeliveryStateDto | undefined {
    const parsed = this.trimOptional(value);

    if (!parsed) {
      return undefined;
    }

    const result = conversionAuditDeliveryStateSchema.safeParse(parsed);

    if (!result.success) {
      throw new BadRequestException("Status de auditoria invalido");
    }

    return result.data;
  }

  private parseConversionAuditSource(
    value?: string | string[],
  ): ConversionAuditSourceDto | undefined {
    const parsed = this.trimOptional(value);

    if (!parsed) {
      return undefined;
    }

    const result = conversionAuditSourceSchema.safeParse(parsed);

    if (!result.success) {
      throw new BadRequestException("Origem de auditoria invalida");
    }

    return result.data;
  }

  private parseReportFilters(input: {
    businessId?: string | string[];
    adAccountId?: string | string[];
    adAccountIds?: string | string[];
    campaignId?: string | string[];
    adSetId?: string | string[];
    adId?: string | string[];
    nameScope?: string | string[];
    nameContains?: string | string[];
    status?: string | string[];
    delivery?: string | string[];
    selectedIds?: string | string[];
    whatsappClassification?: string | string[];
    campaignKind?: string | string[];
  }): ReportFilters {
    const filters: ReportFilters = {};
    const businessId = this.trimOptional(input.businessId);
    const adAccountId = this.trimOptional(input.adAccountId);
    const adAccountIds = this.parseAdAccountIds(input.adAccountIds);
    const campaignId = this.trimOptional(input.campaignId);
    const adSetId = this.trimOptional(input.adSetId);
    const adId = this.trimOptional(input.adId);
    const nameContains = this.trimOptional(input.nameContains);
    const nameScope = this.parseNameScopeFilter(input.nameScope);
    const status = this.parseStatusFilter(input.status);
    const delivery = this.parseDeliveryFilter(input.delivery);
    const selectedEntityIds = this.parseSelectedEntityIds(input.selectedIds);
    const whatsappClassification = this.parseWhatsappClassificationFilter(
      input.whatsappClassification,
    );
    const campaignKind = this.parseCampaignKindFilter(input.campaignKind);

    if (businessId) {
      filters.businessId = businessId;
    }

    if (adAccountId) {
      filters.adAccountId = adAccountId;
    }

    if (adAccountIds.length > 0) {
      filters.adAccountIds = adAccountIds;
    }

    if (campaignId) {
      filters.campaignId = campaignId;
    }

    if (adSetId) {
      filters.adSetId = adSetId;
    }

    if (adId) {
      filters.adId = adId;
    }

    if (nameContains) {
      filters.nameContains = nameContains;
      filters.nameScope = nameScope ?? "campaign";
    }

    if (status) {
      filters.status = status;
    }

    if (delivery) {
      filters.delivery = delivery;
    }

    if (selectedEntityIds.length > 0) {
      filters.selectedEntityIds = selectedEntityIds;
    }

    if (whatsappClassification) {
      filters.whatsappClassification = whatsappClassification;
    }

    if (campaignKind) {
      filters.campaignKind = campaignKind;
    }

    return filters;
  }

  /**
   * `adAccountIds=act_1,act_2` (or the parameter repeated): several ad
   * accounts. Combined with `adAccountId` when both are sent.
   */
  private parseAdAccountIds(value: string | string[] | undefined): string[] {
    const ids = [
      ...new Set(
        (Array.isArray(value) ? value : value === undefined ? [] : [value])
          .flatMap((item) => String(item).split(","))
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];

    if (ids.length > 50 || ids.some((id) => id.length > 120)) {
      throw new BadRequestException("Filtro adAccountIds invalido");
    }

    return ids;
  }

  private trimOptional(value?: string | string[]): string | undefined {
    if (Array.isArray(value)) {
      throw new BadRequestException("Filtro de relatorio invalido");
    }

    const trimmed = value?.trim();

    return trimmed ? trimmed : undefined;
  }

  private isWhatsappClassificationFilter(
    value: string,
  ): value is WhatsappClassificationFilter {
    return ["whatsapp", "needs_review", "excluded", "all"].includes(value);
  }

  private isNameScopeFilter(value: string): value is ReportNameScope {
    return ["campaign", "adset", "ad"].includes(value);
  }

  private isStatusFilter(value: string): value is ReportStatusFilter {
    return ["all", "active", "paused"].includes(value);
  }

  private isDeliveryFilter(value: string): value is ReportDeliveryFilter {
    return ["all", "had_delivery"].includes(value);
  }

  private parseNameScopeFilter(
    value?: string | string[],
  ): ReportNameScope | undefined {
    if (Array.isArray(value)) {
      throw new BadRequestException("Filtro de relatorio invalido");
    }

    const trimmed = value?.trim();

    if (!trimmed) {
      return undefined;
    }

    if (this.isNameScopeFilter(trimmed)) {
      return trimmed;
    }

    throw new BadRequestException("Filtro de nome invalido");
  }

  private parseStatusFilter(
    value?: string | string[],
  ): ReportStatusFilter | undefined {
    if (Array.isArray(value)) {
      throw new BadRequestException("Filtro de relatorio invalido");
    }

    const trimmed = value?.trim();

    if (!trimmed) {
      return undefined;
    }

    if (this.isStatusFilter(trimmed)) {
      return trimmed;
    }

    throw new BadRequestException("Filtro de status invalido");
  }

  private parseDeliveryFilter(
    value?: string | string[],
  ): ReportDeliveryFilter | undefined {
    if (Array.isArray(value)) {
      throw new BadRequestException("Filtro de relatorio invalido");
    }

    const trimmed = value?.trim();

    if (!trimmed) {
      return undefined;
    }

    if (this.isDeliveryFilter(trimmed)) {
      return trimmed;
    }

    throw new BadRequestException("Filtro de veiculacao invalido");
  }

  private parseSelectedEntityIds(value?: string | string[]): string[] {
    if (Array.isArray(value)) {
      throw new BadRequestException("Filtro de selecao invalido");
    }

    const ids = [
      ...new Set(
        (value ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ];

    if (
      ids.length > 200 ||
      ids.some((id) => id.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(id))
    ) {
      throw new BadRequestException("Filtro de selecao invalido");
    }

    return ids;
  }

  private parseWhatsappClassificationFilter(
    value?: string | string[],
  ): WhatsappClassificationFilter | undefined {
    if (Array.isArray(value)) {
      throw new BadRequestException("Filtro de relatorio invalido");
    }

    const trimmed = value?.trim();

    if (!trimmed) {
      return undefined;
    }

    if (this.isWhatsappClassificationFilter(trimmed)) {
      return trimmed;
    }

    throw new BadRequestException("Filtro de classificacao invalido");
  }

  private parseCampaignKindFilter(
    value?: string | string[],
  ): CampaignKindFilter | undefined {
    if (Array.isArray(value)) {
      throw new BadRequestException("Filtro de tipo de campanha invalido");
    }

    const trimmed = value?.trim();

    if (!trimmed) {
      return undefined;
    }

    if (["all", "whatsapp", "lead_form"].includes(trimmed)) {
      return trimmed as CampaignKindFilter;
    }

    throw new BadRequestException("Filtro de tipo de campanha invalido");
  }

  private isDateOnly(value?: string): value is string {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }

    const date = new Date(`${value}T00:00:00.000Z`);

    return (
      !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
    );
  }
}
