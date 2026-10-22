import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  pipedriveConversionRuleCreateInputSchema,
  pipedriveConversionRuleUpdateInputSchema,
  pipedriveConnectionCreateInputSchema,
  pipedriveConnectionCredentialReplaceInputSchema,
  pipedriveConnectionChannelBindingsInputSchema,
  pipedriveConnectionStatusUpdateInputSchema,
  RULE_CURRENCY_INVALID_MESSAGE,
  hasRuleCurrencyIssue,
} from "@wpptrack/shared";
import { WorkspaceOwnerGuard } from "../workspaces/guards/workspace-owner.guard";
import { PipedriveService, type PipedriveActor } from "./pipedrive.service";

import { PipedriveWebhookService } from "./pipedrive-webhook.service";

type AuthorizedRequest = {
  user: { id: string; actorType: "user" | "platform_admin" };
};

/**
 * Owner-only management of the Pipedrive CRM integration (WorkspaceOwnerGuard,
 * same as Kommo). Every write is a POST/PATCH/DELETE and therefore refused
 * with 423 by the global license guard while the license is locked.
 */
@Controller("workspaces/:workspaceId/pipedrive/connections")
@UseGuards(WorkspaceOwnerGuard)
export class PipedriveController {
  constructor(
    @Inject(PipedriveService) private readonly pipedrive: PipedriveService,
    @Inject(PipedriveWebhookService)
    private readonly webhooks: PipedriveWebhookService,
  ) {}

  @Get()
  list(@Param("workspaceId") workspaceId: string) {
    return this.pipedrive.list(workspaceId);
  }

  @Get(":connectionId/capabilities")
  async capabilities(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
  ) {
    await this.pipedrive.get(workspaceId, connectionId);
    return {
      // No environment opt-in in the student edition: production is per rule.
      productionEnabled: true,
      modes: ["observation", "production"],
      activationRequirements: [
        "verified_account",
        "fresh_catalog",
        "configured_webhook",
        "authorized_certified_channel",
        "existing_lead_attribution",
      ],
      historicalReplay: false,
      unknownDeliveryRetry: false,
    };
  }

  @Get(":connectionId")
  get(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
  ) {
    return this.pipedrive.get(workspaceId, connectionId);
  }

  @Post()
  create(
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ) {
    const parsed = pipedriveConnectionCreateInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Payload inválido");
    return this.pipedrive.create(workspaceId, this.actor(request), parsed.data);
  }

  @Post(":connectionId/credentials")
  replaceCredential(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ) {
    const parsed =
      pipedriveConnectionCredentialReplaceInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Payload inválido");
    return this.pipedrive.replaceCredential(
      workspaceId,
      connectionId,
      this.actor(request),
      parsed.data,
    );
  }

  @Patch(":connectionId/status")
  status(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ) {
    const parsed = pipedriveConnectionStatusUpdateInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Payload inválido");
    return this.pipedrive.setStatus(
      workspaceId,
      connectionId,
      this.actor(request),
      parsed.data.status,
    );
  }

  @Patch(":connectionId/channel-bindings")
  bindings(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ) {
    const parsed =
      pipedriveConnectionChannelBindingsInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Payload inválido");
    return this.pipedrive.setChannelBindings(
      workspaceId,
      connectionId,
      this.actor(request),
      parsed.data.allowedChannelRouteIds,
    );
  }

  @Delete(":connectionId")
  remove(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @Req() request: AuthorizedRequest,
  ) {
    return this.pipedrive.remove(
      workspaceId,
      connectionId,
      this.actor(request),
    );
  }

  @Post(":connectionId/refresh-catalog")
  refresh(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
  ) {
    return this.pipedrive.refreshCatalog(workspaceId, connectionId);
  }

  @Post(":connectionId/webhook-secret/rotate")
  @Header("Cache-Control", "no-store")
  @Header("Pragma", "no-cache")
  rotateSecret(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @Req() request: AuthorizedRequest,
  ) {
    return this.webhooks.rotateSecret(
      workspaceId,
      connectionId,
      this.actor(request),
    );
  }
  @Delete(":connectionId/webhook-secret")
  revokeSecret(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @Req() request: AuthorizedRequest,
  ) {
    return this.webhooks.revokeSecret(
      workspaceId,
      connectionId,
      this.actor(request),
    );
  }
  @Get(":connectionId/rules")
  rules(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
  ) {
    return this.webhooks.listRules(workspaceId, connectionId);
  }
  @Post(":connectionId/rules")
  createRule(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ) {
    const parsed = pipedriveConversionRuleCreateInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(hasRuleCurrencyIssue(parsed.error) ? RULE_CURRENCY_INVALID_MESSAGE : "Payload inválido");
    return this.webhooks.createRule(
      workspaceId,
      connectionId,
      this.actor(request),
      parsed.data,
    );
  }
  @Patch(":connectionId/rules/:ruleId")
  updateRule(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @Param("ruleId") ruleId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ) {
    const parsed = pipedriveConversionRuleUpdateInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(hasRuleCurrencyIssue(parsed.error) ? RULE_CURRENCY_INVALID_MESSAGE : "Payload inválido");
    return this.webhooks.updateRule(
      workspaceId,
      connectionId,
      ruleId,
      this.actor(request),
      parsed.data,
    );
  }
  @Delete(":connectionId/rules/:ruleId")
  removeRule(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @Param("ruleId") ruleId: string,
    @Req() request: AuthorizedRequest,
  ) {
    return this.webhooks.removeRule(
      workspaceId,
      connectionId,
      ruleId,
      this.actor(request),
    );
  }
  @Get(":connectionId/events")
  events(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
  ) {
    return this.webhooks.listEvents(workspaceId, connectionId);
  }
  @Post(":connectionId/events/:eventId/retry")
  retryEvent(
    @Param("workspaceId") workspaceId: string,
    @Param("connectionId") connectionId: string,
    @Param("eventId") eventId: string,
    @Req() request: AuthorizedRequest,
  ) {
    return this.webhooks.retryEvent(
      workspaceId,
      connectionId,
      eventId,
      this.actor(request),
    );
  }

  private actor(request: AuthorizedRequest): PipedriveActor {
    return { userId: request.user.id, type: request.user.actorType };
  }
}
