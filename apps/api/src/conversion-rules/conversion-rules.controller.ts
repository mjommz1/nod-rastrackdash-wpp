import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import {
  conversionRuleCreateInputSchema,
  conversionRuleUpdateInputSchema,
  conversionTriggerEvaluationInputSchema,
  funnelConfigurationUpdateInputSchema,
  providerConversionRuleAdaptInputSchema,
  providerConversionRuleCreateInputSchema,
  providerConversionRuleExecutionAuditQuerySchema,
  providerConversionRuleIdempotentCreateInputSchema,
  providerConversionRuleUnifyInputSchema,
  providerConversionRuleUpdateInputSchema,
  providerRuleCreateRequestKeySchema,
  structuredCatalogTestMessageInputSchema,
  RULE_CURRENCY_INVALID_MESSAGE,
  hasRuleCurrencyIssue,
} from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { ConversionCatalogService } from "./conversion-catalog.service";
import { ConversionRulesService } from "./conversion-rules.service";
import { FunnelConfigurationService } from "./funnel-configuration.service";
import { ProviderConversionRulesService } from "./provider-conversion-rules.service";

@Controller("conversion-rules")
export class ConversionRulesController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(ConversionRulesService)
    private readonly conversionRulesService: ConversionRulesService,
    @Inject(FunnelConfigurationService)
    private readonly funnelConfigurationService: FunnelConfigurationService,
    @Inject(ProviderConversionRulesService)
    private readonly providerConversionRulesService: ProviderConversionRulesService,
    @Inject(ConversionCatalogService)
    private readonly conversionCatalogService: ConversionCatalogService,
  ) {}

  @Get()
  async list(@AuthToken() refreshToken: string) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);
    return this.conversionRulesService.listRules(workspaceId);
  }

  /**
   * "Regras antigas" (palavra-chave / etiqueta sem configuracao de provedor)
   * for the Conversions screen. Read-only; edits reuse PATCH /:id and
   * POST providers/adapt/:ruleId.
   */
  @Get("legacy")
  async listLegacy(@AuthToken() refreshToken: string) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);
    return this.conversionRulesService.listLegacyRules(workspaceId);
  }

  @Get("funnel")
  async getFunnelConfiguration(@AuthToken() refreshToken: string) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);
    return this.funnelConfigurationService.getConfiguration(workspaceId);
  }

  @Get("providers")
  async listProviderRules(@AuthToken() refreshToken: string) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);
    return this.providerConversionRulesService.listRules(workspaceId);
  }

  /**
   * Creates a provider rule. With the `Idempotency-Key` header the create is
   * idempotent: a retry with the same key and body returns
   * `{ outcome: "replayed", receipt }`, and an unconfirmed create is
   * reconciled with GET providers/create-receipt.
   */
  @Post("providers")
  async createProviderRule(
    @AuthToken() refreshToken: string,
    @Body() body: unknown,
    @Headers("idempotency-key") requestKey?: string,
  ) {
    const context = await this.requireIntegrationManager(refreshToken);
    if (requestKey !== undefined) this.requireCreateRequestKey(requestKey);
    const parsed = (
      requestKey === undefined
        ? providerConversionRuleCreateInputSchema
        : providerConversionRuleIdempotentCreateInputSchema
    ).safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(
        hasRuleCurrencyIssue(parsed.error)
          ? RULE_CURRENCY_INVALID_MESSAGE
          : parsed.error.flatten(),
      );
    }

    if (requestKey !== undefined) {
      return this.providerConversionRulesService.createRule(
        context.workspaceId,
        parsed.data,
        context.userId,
        requestKey,
      );
    }
    return this.providerConversionRulesService.createRule(
      context.workspaceId,
      parsed.data,
      context.userId,
    );
  }

  @Get("providers/create-receipt")
  async lookupProviderRuleCreateReceipt(
    @AuthToken() refreshToken: string,
    @Query("connectionId") connectionId: string | undefined,
    @Headers("idempotency-key") requestKey: string,
  ) {
    const context = await this.requireIntegrationManager(refreshToken);
    this.requireCreateRequestKey(requestKey);
    // Absent: a rule created without a connection (workspace scope).
    if (
      connectionId !== undefined &&
      (typeof connectionId !== "string" ||
        !connectionId.trim() ||
        connectionId.length > 255)
    ) {
      throw new BadRequestException("Conexao invalida");
    }
    return this.providerConversionRulesService.lookupCreateReceipt(
      context.workspaceId,
      connectionId === undefined ? null : connectionId.trim(),
      requestKey,
    );
  }

  /** Scope options and capability matrix (any workspace member). */
  @Get("providers/capabilities")
  async getProviderRuleCapabilities(@AuthToken() refreshToken: string) {
    await this.getCurrentWorkspaceId(refreshToken);
    return this.providerConversionRulesService.getCapabilities();
  }

  /** Groups of identical specific rules that "Unificar" can merge. */
  @Get("providers/unify-candidates")
  async listProviderRuleUnifyCandidates(@AuthToken() refreshToken: string) {
    const context = await this.requireIntegrationManager(refreshToken);
    return this.providerConversionRulesService.listUnifyCandidates(
      context.workspaceId,
    );
  }

  /**
   * Replaces the given identical rules by one "all numbers" rule (the
   * originals are paused, history kept). Idempotent for the same rule set.
   */
  @Post("providers/unify")
  @HttpCode(200)
  async unifyProviderRules(
    @AuthToken() refreshToken: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireIntegrationManager(refreshToken);
    const parsed = providerConversionRuleUnifyInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(
        hasRuleCurrencyIssue(parsed.error)
          ? RULE_CURRENCY_INVALID_MESSAGE
          : parsed.error.flatten(),
      );
    }

    return this.providerConversionRulesService.unifyRules(
      context.workspaceId,
      parsed.data,
      context.userId,
    );
  }

  private requireCreateRequestKey(
    requestKey: unknown,
  ): asserts requestKey is string {
    if (!providerRuleCreateRequestKeySchema.safeParse(requestKey).success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        code: "provider_rule_create_key_invalid",
        message: "Chave de tentativa invalida",
      });
    }
  }

  @Post("providers/adapt/:ruleId")
  async adaptProviderRule(
    @AuthToken() refreshToken: string,
    @Param("ruleId") ruleId: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireIntegrationManager(refreshToken);
    const parsed = providerConversionRuleAdaptInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(
        hasRuleCurrencyIssue(parsed.error)
          ? RULE_CURRENCY_INVALID_MESSAGE
          : parsed.error.flatten(),
      );
    }

    return this.providerConversionRulesService.adaptLegacyMessageRule(
      context.workspaceId,
      ruleId,
      parsed.data,
      context.userId,
    );
  }

  @Patch("providers/:id")
  async updateProviderRule(
    @AuthToken() refreshToken: string,
    @Param("id") providerRuleId: string,
    @Body() body: unknown,
  ) {
    const context = await this.requireIntegrationManager(refreshToken);
    const parsed = providerConversionRuleUpdateInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(
        hasRuleCurrencyIssue(parsed.error)
          ? RULE_CURRENCY_INVALID_MESSAGE
          : parsed.error.flatten(),
      );
    }

    return this.providerConversionRulesService.updateRule(
      context.workspaceId,
      providerRuleId,
      parsed.data,
      context.userId,
    );
  }

  @Post("providers/:id/rotate-endpoint")
  @HttpCode(200)
  async rotateProviderRuleEndpoint(
    @AuthToken() refreshToken: string,
    @Param("id") providerRuleId: string,
  ) {
    const context = await this.requireIntegrationManager(refreshToken);
    return this.providerConversionRulesService.rotateEndpoint(
      context.workspaceId,
      providerRuleId,
      context.userId,
    );
  }

  @Post("providers/:id/test-message")
  @HttpCode(200)
  async testProviderCatalogMessage(
    @AuthToken() refreshToken: string,
    @Param("id") providerRuleId: string,
    @Body() body: unknown,
  ) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);
    const parsed = structuredCatalogTestMessageInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(
        hasRuleCurrencyIssue(parsed.error)
          ? RULE_CURRENCY_INVALID_MESSAGE
          : parsed.error.flatten(),
      );
    }

    return this.conversionCatalogService.testMessage(
      workspaceId,
      providerRuleId,
      parsed.data,
    );
  }

  @Get("providers/:id/executions")
  async listProviderRuleExecutions(
    @AuthToken() refreshToken: string,
    @Param("id") providerRuleId: string,
    @Query() query: Record<string, unknown>,
  ) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);
    const parsed = providerConversionRuleExecutionAuditQuerySchema.safeParse(query);

    if (!parsed.success) {
      throw new BadRequestException(
        hasRuleCurrencyIssue(parsed.error)
          ? RULE_CURRENCY_INVALID_MESSAGE
          : parsed.error.flatten(),
      );
    }

    return this.providerConversionRulesService.listRuleExecutions(
      workspaceId,
      providerRuleId,
      parsed.data,
    );
  }

  @Delete("providers/:id")
  @HttpCode(204)
  async removeProviderRule(
    @AuthToken() refreshToken: string,
    @Param("id") providerRuleId: string,
  ): Promise<void> {
    const context = await this.requireIntegrationManager(refreshToken);
    await this.providerConversionRulesService.removeRule(
      context.workspaceId,
      providerRuleId,
      context.userId,
    );
  }

  @Put("funnel")
  async updateFunnelConfiguration(
    @AuthToken() refreshToken: string,
    @Body() body: unknown,
  ) {
    const parsed = funnelConfigurationUpdateInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException("Payload invalido");
    }

    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.funnelConfigurationService.updateConfiguration(
      workspace.id,
      parsed.data,
      authenticated.user.id,
    );
  }

  @Post()
  async create(@AuthToken() refreshToken: string, @Body() body: unknown) {
    const parsed = conversionRuleCreateInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(hasRuleCurrencyIssue(parsed.error) ? RULE_CURRENCY_INVALID_MESSAGE : "Payload invalido");
    }

    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.conversionRulesService.createRule(
      workspace.id,
      parsed.data,
      authenticated.user.id,
    );
  }

  @Patch(":id")
  async update(
    @AuthToken() refreshToken: string,
    @Param("id") ruleId: string,
    @Body() body: unknown,
  ) {
    const parsed = conversionRuleUpdateInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(hasRuleCurrencyIssue(parsed.error) ? RULE_CURRENCY_INVALID_MESSAGE : "Payload invalido");
    }

    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.conversionRulesService.updateRule(
      workspace.id,
      ruleId,
      parsed.data,
      authenticated.user.id,
    );
  }

  @Post("evaluate")
  async evaluate(@AuthToken() refreshToken: string, @Body() body: unknown) {
    const parsed = conversionTriggerEvaluationInputSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException("Payload invalido");
    }

    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);
    return this.conversionRulesService.evaluateTriggers(
      workspaceId,
      parsed.data,
    );
  }

  private async getCurrentWorkspaceId(refreshToken: string): Promise<string> {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    return workspace.id;
  }

  private async requireIntegrationManager(refreshToken: string): Promise<{
    userId: string;
    workspaceId: string;
  }> {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return {
      userId: authenticated.user.id,
      workspaceId: workspace.id,
    };
  }
}
