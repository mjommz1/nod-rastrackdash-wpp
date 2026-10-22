import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Res,
} from "@nestjs/common";
import { leadExportQuerySchema, leadListQuerySchema } from "@wpptrack/shared";
import type { Writable } from "node:stream";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import {
  leadExportContentTypes,
  leadExportFilename,
  writeLeadsCsv,
  writeLeadsXlsx,
} from "./leads-export";
import { LeadsService } from "./leads.service";

type ExportResponse = Writable & {
  setHeader(name: string, value: string): unknown;
};

@Controller("leads")
export class LeadsController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(LeadsService) private readonly leadsService: LeadsService,
  ) {}

  @Get()
  async list(@AuthToken() refreshToken: string, @Query() query: unknown) {
    const parsed = leadListQuerySchema.safeParse(query);

    if (!parsed.success) {
      throw new BadRequestException("Query invalida");
    }

    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    return this.leadsService.listLeads(workspace.id, parsed.data);
  }

  @Get("page")
  async listPage(@AuthToken() refreshToken: string, @Query() query: unknown) {
    const parsed = leadListQuerySchema.safeParse(query);

    if (!parsed.success) {
      throw new BadRequestException("Query invalida");
    }

    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    return this.leadsService.listLeadsPage(workspace.id, parsed.data);
  }

  /**
   * Spreadsheet of every lead matching the current Leads filters (not just a
   * page). Declared before ":leadId" so "export" is never read as a lead id.
   */
  @Get("export")
  async export(
    @AuthToken() refreshToken: string,
    @Query() query: unknown,
    @Res() response: ExportResponse,
  ) {
    const parsed = leadExportQuerySchema.safeParse(query);

    if (!parsed.success) {
      throw new BadRequestException("Query invalida");
    }

    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const { format, ...filters } = parsed.data;
    // Throws (as a normal JSON error) before any byte of the file is sent.
    const { batches } = await this.leadsService.prepareLeadExport(
      workspace.id,
      filters,
    );

    response.setHeader("Content-Type", leadExportContentTypes[format]);
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${leadExportFilename({
        workspaceSlug: workspace.slug,
        format,
        since: filters.since,
        until: filters.until,
        masked: filters.maskSensitive === true,
      })}"`,
    );
    response.setHeader("Cache-Control", "no-store");

    // Stop reading from the database as soon as the download is cancelled.
    let closed = false;
    response.once("close", () => {
      closed = true;
    });
    async function* untilClosed() {
      for await (const batch of batches) {
        if (closed) {
          return;
        }

        yield batch;
      }
    }

    try {
      await (format === "xlsx" ? writeLeadsXlsx : writeLeadsCsv)(
        response,
        untilClosed(),
      );
    } catch (error) {
      if (closed) {
        return;
      }

      // Headers are out: cutting the connection is the only honest signal
      // that the file is incomplete.
      response.destroy(error instanceof Error ? error : undefined);
    }
  }

  @Get(":leadId")
  async detail(
    @AuthToken() refreshToken: string,
    @Param("leadId") leadId: string,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    return this.leadsService.getLeadDetail(workspace.id, leadId);
  }
}
