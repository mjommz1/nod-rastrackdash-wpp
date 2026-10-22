import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspaceOwnerGuard } from "../workspaces/guards/workspace-owner.guard";
import {
  kommoConnectionChannelBindingsInputSchema,
  kommoConnectionCreateInputSchema,
  kommoConnectionCredentialReplaceInputSchema,
  kommoConnectionStatusUpdateInputSchema,
  kommoConversionRuleCreateInputSchema,
  kommoConversionRuleUpdateInputSchema,
  RULE_CURRENCY_INVALID_MESSAGE,
  hasRuleCurrencyIssue,
} from "@wpptrack/shared";
import { decodeKommoBody, parseKommoStageEvents } from "./kommo-webhook.parser";
import { KommoService } from "./kommo.service";

@Controller()
export class KommoController {
  constructor(
    @Inject(KommoService) private readonly kommo: KommoService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}
  @Post("webhooks/kommo/v1/:connectionId")
  @HttpCode(202)
  receive(
    @Param("connectionId") id: string,
    @Query("token") token: unknown,
    @Body() body: unknown,
    @Req() request: { headers: Record<string, unknown> },
  ) {
    const parsed = decodeKommoBody(body, request.headers["content-type"]);
    return this.kommo.receive(id, token, parseKommoStageEvents(parsed));
  }
  @Get("workspaces/:workspaceId/kommo/connections")
  @UseGuards(WorkspaceOwnerGuard)
  list(@Param("workspaceId") workspaceId: string) {
    return this.kommo.list(workspaceId);
  }
  @Get("workspaces/:workspaceId/kommo/connections/:connectionId")
  @UseGuards(WorkspaceOwnerGuard)
  get(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
  ) {
    return this.kommo.get(workspaceId, connectionId);
  }
  @Get("workspaces/:workspaceId/kommo/connections/:connectionId/events")
  @UseGuards(WorkspaceOwnerGuard)
  events(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @Query("cursor") cursor: unknown,
  ) {
    if (
      cursor !== undefined &&
      (typeof cursor !== "string" || !cursor || cursor.length > 255)
    )
      throw new BadRequestException("Payload invalido");
    return this.kommo.listEvents(
      workspaceId,
      connectionId,
      cursor as string | undefined,
    );
  }
  @Post("workspaces/:workspaceId/kommo/connections")
  @UseGuards(WorkspaceOwnerGuard)
  async create(
    @Param("workspaceId") workspaceId: string,
    @AuthToken() token: string,
    @Body() body: unknown,
    @Req() request: any,
  ) {
    const parsed = kommoConnectionCreateInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Payload invalido");
    return this.kommo.create(
      workspaceId,
      (await this.auth.getSession(token)).user.id,
      parsed.data,
      this.actorType(request),
    );
  }
  @Post("workspaces/:workspaceId/kommo/connections/:connectionId/credentials")
  @UseGuards(WorkspaceOwnerGuard)
  async replaceCredential(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @AuthToken() token: string,
    @Body() body: unknown,
    @Req() request: any,
  ) {
    const parsed = kommoConnectionCredentialReplaceInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Payload invalido");
    return this.kommo.replaceCredential(
      workspaceId,
      connectionId,
      (await this.auth.getSession(token)).user.id,
      parsed.data,
      this.actorType(request),
    );
  }
  @Patch("workspaces/:workspaceId/kommo/connections/:connectionId/status")
  @UseGuards(WorkspaceOwnerGuard)
  async status(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @AuthToken() token: string,
    @Body() body: unknown,
    @Req() request: any,
  ) {
    const parsed = kommoConnectionStatusUpdateInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Payload invalido");
    return this.kommo.setStatus(
      workspaceId,
      connectionId,
      (await this.auth.getSession(token)).user.id,
      parsed.data.status,
      this.actorType(request),
    );
  }
  @Patch(
    "workspaces/:workspaceId/kommo/connections/:connectionId/channel-bindings",
  )
  @UseGuards(WorkspaceOwnerGuard)
  async bindings(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @AuthToken() token: string,
    @Body() body: unknown,
    @Req() request: any,
  ) {
    const parsed = kommoConnectionChannelBindingsInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Payload invalido");
    return this.kommo.setChannelBindings(
      workspaceId,
      connectionId,
      (await this.auth.getSession(token)).user.id,
      parsed.data.allowedChannelRouteIds,
      this.actorType(request),
    );
  }
  @Delete("workspaces/:workspaceId/kommo/connections/:connectionId")
  @UseGuards(WorkspaceOwnerGuard)
  async remove(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @AuthToken() token: string,
    @Req() request: any,
  ) {
    return this.kommo.remove(
      workspaceId,
      connectionId,
      (await this.auth.getSession(token)).user.id,
      this.actorType(request),
    );
  }
  @Post(
    "workspaces/:workspaceId/kommo/connections/:connectionId/rotate-webhook-token",
  )
  @UseGuards(WorkspaceOwnerGuard)
  async rotate(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @AuthToken() token: string,
    @Req() request: any,
  ) {
    return this.kommo.rotateSecret(
      workspaceId,
      connectionId,
      (await this.auth.getSession(token)).user.id,
      this.actorType(request),
    );
  }
  @Post(
    "workspaces/:workspaceId/kommo/connections/:connectionId/refresh-catalog",
  )
  @UseGuards(WorkspaceOwnerGuard)
  refresh(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
  ) {
    return this.kommo.refreshCatalog(workspaceId, connectionId);
  }
  @Post("workspaces/:workspaceId/kommo/connections/:connectionId/health")
  @UseGuards(WorkspaceOwnerGuard)
  health(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
  ) {
    return this.kommo.checkHealth(workspaceId, connectionId);
  }
  @Post("workspaces/:workspaceId/kommo/connections/:connectionId/recover")
  @UseGuards(WorkspaceOwnerGuard)
  async recover(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @AuthToken() token: string,
    @Req() request: any,
  ) {
    return this.kommo.recover(
      workspaceId,
      connectionId,
      (await this.auth.getSession(token)).user.id,
      this.actorType(request),
    );
  }
  @Post("workspaces/:workspaceId/kommo/connections/:connectionId/rules")
  @UseGuards(WorkspaceOwnerGuard)
  async createRule(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @AuthToken() token: string,
    @Body() body: unknown,
    @Req() request: any,
  ) {
    const parsed = kommoConversionRuleCreateInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(hasRuleCurrencyIssue(parsed.error) ? RULE_CURRENCY_INVALID_MESSAGE : "Payload invalido");
    return this.kommo.createRule(
      workspaceId,
      connectionId,
      (await this.auth.getSession(token)).user.id,
      parsed.data,
      this.actorType(request),
    );
  }
  @Patch(
    "workspaces/:workspaceId/kommo/connections/:connectionId/rules/:ruleId",
  )
  @UseGuards(WorkspaceOwnerGuard)
  async updateRule(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @Param("ruleId") ruleId: string,
    @AuthToken() token: string,
    @Body() body: unknown,
    @Req() request: any,
  ) {
    const parsed = kommoConversionRuleUpdateInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(hasRuleCurrencyIssue(parsed.error) ? RULE_CURRENCY_INVALID_MESSAGE : "Payload invalido");
    return this.kommo.updateRule(
      workspaceId,
      connectionId,
      ruleId,
      (await this.auth.getSession(token)).user.id,
      parsed.data,
      this.actorType(request),
    );
  }
  @Delete(
    "workspaces/:workspaceId/kommo/connections/:connectionId/rules/:ruleId",
  )
  @UseGuards(WorkspaceOwnerGuard)
  async deleteRule(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @Param("ruleId") ruleId: string,
    @AuthToken() token: string,
    @Req() request: any,
  ) {
    return this.kommo.deleteRule(
      workspaceId,
      connectionId,
      ruleId,
      (await this.auth.getSession(token)).user.id,
      this.actorType(request),
    );
  }
  @Post("workspaces/:workspaceId/kommo/events/:eventId/reprocess")
  @UseGuards(WorkspaceOwnerGuard)
  async reprocess(
    @Param("workspaceId") workspaceId: string,
    @Param("eventId") eventId: string,
    @AuthToken() token: string,
    @Req() request: any,
  ) {
    return this.kommo.reprocess(
      workspaceId,
      eventId,
      (await this.auth.getSession(token)).user.id,
      this.actorType(request),
    );
  }
  private actorType(request: {
    user?: { actorType?: unknown };
  }): "user" | "platform_admin" {
    return request.user?.actorType === "platform_admin"
      ? "platform_admin"
      : "user";
  }
}
