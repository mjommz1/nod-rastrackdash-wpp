import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import {
  metaAdDestinationInputSchema,
  metaAssetSelectionInputSchema,
  metaCapiTokenInputSchema,
  metaConversionDestinationInputSchema,
  metaManualAccountDestinationInputSchema,
  metaManualBusinessConnectionInputSchema,
  metaManualBusinessConnectionRemovalInputSchema,
  metaManualBusinessConnectionStatusInputSchema,
  metaManualCredentialInputSchema,
  metaManualCredentialRotationInputSchema,
  metaOAuthDisconnectInputSchema,
  metaReportingAccountInputSchema,
  metaReportingAccountStatusInputSchema,
} from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { IntegrationsService } from "./integrations.service";
import {
  MetaPalmupConnectService,
  metaPalmupConnectCompleteSchema,
} from "./meta/meta-palmup-connect.service";


@Controller("integrations")
export class IntegrationsController {
  constructor(
    @Inject(IntegrationsService)
    private readonly integrationsService: IntegrationsService,
    @Inject(AuthService)
    private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(MetaPalmupConnectService)
    private readonly metaPalmupConnectService: MetaPalmupConnectService,
  ) {}

  @Get("health")
  getHealth() {
    return this.integrationsService.getHealthSummary();
  }

  @Get("pipeline")
  async getPipeline(@AuthToken() refreshToken: string) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);

    return this.integrationsService.getPipelineOverview(workspaceId);
  }

  @Get("whatsapp/source")
  async getWhatsappSource(@AuthToken() refreshToken: string) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);

    return this.integrationsService.getWhatsappDataSource(workspaceId);
  }

  @Get("whatsapp/webhook-status")
  async getWhatsappWebhookStatus(@AuthToken() refreshToken: string) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);

    return this.integrationsService.getWhatsappWebhookReceiptStatus(
      workspaceId,
    );
  }


  @Get("meta/connection")
  async getMetaConnection(@AuthToken() refreshToken: string) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);

    return this.integrationsService.getMetaConnection(workspaceId);
  }

  @Post("meta/oauth/disconnect")
  async disconnectMetaOAuth(
    @AuthToken() refreshToken: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const input = this.parseBody(
      metaOAuthDisconnectInputSchema.safeParse(body),
    );

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    if (input.expectedWorkspaceId !== workspace.id) {
      throw new ConflictException(
        "O workspace da sessao mudou. Recarregue a pagina antes de desconectar a Meta",
      );
    }

    return this.integrationsService.disconnectMetaOAuth(
      workspace.id,
      input,
      authenticated.user.id,
    );
  }

  @Get("meta/capabilities")
  async getMetaCapabilities(@AuthToken() refreshToken: string) {
    await this.getCurrentWorkspaceId(refreshToken);
    return this.integrationsService.getMetaConnectionCapabilities();
  }


  @Get("meta/manual")
  async getMetaManualConfiguration(@AuthToken() refreshToken: string) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);
    return this.integrationsService.getMetaManualConfiguration(workspaceId);
  }

  @Post("meta/manual/credentials")
  async createMetaManualCredential(
    @AuthToken() refreshToken: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const input = this.parseBody(
      metaManualCredentialInputSchema.safeParse(body),
    );

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.integrationsService.createMetaManualCredential(
      workspace.id,
      input,
      authenticated.user.id,
    );
  }

  @Post("meta/manual/palmup-connect/start")
  async startMetaPalmupConnect(@AuthToken() refreshToken: string) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    if (
      workspace.role !== "owner" ||
      !workspace.permissions.canManageIntegrations
    ) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }
    return this.metaPalmupConnectService.start(workspace.id);
  }

  @Post("meta/manual/palmup-connect/complete")
  async completeMetaPalmupConnect(
    @AuthToken() refreshToken: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    if (
      workspace.role !== "owner" ||
      !workspace.permissions.canManageIntegrations
    ) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }
    const input = this.parseBody(metaPalmupConnectCompleteSchema.safeParse(body));
    return this.metaPalmupConnectService.complete(
      workspace.id,
      input.pairingId,
      authenticated.user.id,
    );
  }

  @Get("meta/manual/credentials/:id/assets")
  async discoverMetaManualAssets(
    @AuthToken() refreshToken: string,
    @Param("id") credentialId: string,
    @Query("businessId") businessId?: string,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.integrationsService.discoverMetaManualAssets(
      workspace.id,
      credentialId,
      businessId?.trim() || null,
    );
  }

  @Post("meta/manual/connections")
  async createMetaManualBusinessConnection(
    @AuthToken() refreshToken: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const input = this.parseBody(
      metaManualBusinessConnectionInputSchema.safeParse(body),
    );

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.integrationsService.createMetaManualBusinessConnection(
      workspace.id,
      input,
      authenticated.user.id,
    );
  }

  @Put("meta/manual/credentials/:id/rotate")
  async rotateMetaManualCredential(
    @AuthToken() refreshToken: string,
    @Param("id") credentialId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const input = this.parseBody(
      metaManualCredentialRotationInputSchema.safeParse(body),
    );

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.integrationsService.rotateMetaManualCredential(
      workspace.id,
      credentialId,
      input,
      authenticated.user.id,
    );
  }

  @Put("meta/manual/connections/:id/status")
  async setMetaManualBusinessConnectionStatus(
    @AuthToken() refreshToken: string,
    @Param("id") connectionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const input = this.parseBody(
      metaManualBusinessConnectionStatusInputSchema.safeParse(body),
    );

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.integrationsService.setMetaManualBusinessConnectionStatus(
      workspace.id,
      connectionId,
      input,
      authenticated.user.id,
    );
  }

  @Post("meta/manual/connections/:id/test")
  async testMetaManualBusinessConnection(
    @AuthToken() refreshToken: string,
    @Param("id") connectionId: string,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.integrationsService.testMetaManualBusinessConnection(
      workspace.id,
      connectionId,
      authenticated.user.id,
    );
  }

  @Delete("meta/manual/connections/:id")
  async removeMetaManualBusinessConnection(
    @AuthToken() refreshToken: string,
    @Param("id") connectionId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const input = this.parseBody(
      metaManualBusinessConnectionRemovalInputSchema.safeParse(body),
    );

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.integrationsService.removeMetaManualBusinessConnection(
      workspace.id,
      connectionId,
      input,
      authenticated.user.id,
    );
  }

  @Put("meta/manual/reporting-accounts/:id/destination")
  async setMetaManualReportingDestination(
    @AuthToken() refreshToken: string,
    @Param("id") reportingAccountId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const input = this.parseBody(
      metaManualAccountDestinationInputSchema.safeParse(body),
    );

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.integrationsService.setMetaManualReportingDestination(
      workspace.id,
      reportingAccountId,
      input,
      authenticated.user.id,
    );
  }

  @Get("meta/manual/reporting-accounts/:id/ad-routing")
  async getMetaManualAdRouting(
    @AuthToken() refreshToken: string,
    @Param("id") reportingAccountId: string,
  ) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);

    return this.integrationsService.getMetaManualAdRouting(
      workspaceId,
      reportingAccountId,
    );
  }

  @Put("meta/manual/reporting-accounts/:id/ads/:adId/destination")
  async setMetaManualAdDestination(
    @AuthToken() refreshToken: string,
    @Param("id") reportingAccountId: string,
    @Param("adId") adId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const input = this.parseBody(metaAdDestinationInputSchema.safeParse(body));

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.integrationsService.setMetaManualAdDestination(
      workspace.id,
      reportingAccountId,
      adId,
      input,
      authenticated.user.id,
    );
  }

  @Get("meta/assets")
  async getMetaAssets(
    @AuthToken() refreshToken: string,
    @Query("businessId") businessId?: string,
  ) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);
    const requestedBusinessId =
      typeof businessId === "string" && businessId.trim()
        ? businessId.trim()
        : null;

    return requestedBusinessId
      ? this.integrationsService.getMetaAssets(workspaceId, requestedBusinessId)
      : this.integrationsService.getMetaAssets(workspaceId);
  }

  @Post("meta/assets/refresh")
  async refreshMetaAssets(
    @AuthToken() refreshToken: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const businessId =
      typeof body.businessId === "string" && body.businessId.trim()
        ? body.businessId.trim()
        : null;

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    const assets = await this.integrationsService.refreshMetaAssets(
      workspace.id,
      businessId,
      authenticated.user.id,
    );

    if (assets.status === "not_connected") {
      throw new ConflictException(
        "Conecte uma conta Meta neste workspace antes de atualizar os ativos",
      );
    }

    if (assets.status === "needs_reconnect") {
      throw new ConflictException(
        "Reconecte a conta Meta deste workspace antes de atualizar os ativos",
      );
    }

    if (assets.status === "error") {
      throw new BadGatewayException(
        assets.syncError ?? "A Meta nao permitiu atualizar os ativos",
      );
    }

    return assets;
  }

  @Put("meta/assets/selection")
  async saveMetaAssetSelection(
    @AuthToken() refreshToken: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const input = this.parseBody(metaAssetSelectionInputSchema.safeParse(body));

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.integrationsService.saveMetaAssetSelection(
      workspace.id,
      input,
      authenticated.user.id,
    );
  }

  @Put("meta/capi-token")
  async saveMetaCapiToken(
    @AuthToken() refreshToken: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const input = this.parseBody(metaCapiTokenInputSchema.safeParse(body));

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.integrationsService.saveMetaCapiToken(
      workspace.id,
      input,
      authenticated.user.id,
    );
  }

  @Get("meta/conversion-destination")
  async getMetaConversionDestination(@AuthToken() refreshToken: string) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);

    return this.integrationsService.getMetaConversionDestination(workspaceId);
  }

  @Put("meta/conversion-destination")
  async saveMetaConversionDestination(
    @AuthToken() refreshToken: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const input = this.parseBody(
      metaConversionDestinationInputSchema.safeParse(body),
    );

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.integrationsService.saveMetaConversionDestination(
      workspace.id,
      input,
      authenticated.user.id,
    );
  }

  @Get("meta/reporting-accounts")
  async getMetaReportingAccounts(@AuthToken() refreshToken: string) {
    const workspaceId = await this.getCurrentWorkspaceId(refreshToken);

    return this.integrationsService.getMetaReportingAccounts(workspaceId);
  }

  @Post("meta/reporting-accounts")
  async saveMetaReportingAccount(
    @AuthToken() refreshToken: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const input = this.parseBody(
      metaReportingAccountInputSchema.safeParse(body),
    );

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.integrationsService.saveMetaReportingAccount(
      workspace.id,
      input,
      authenticated.user.id,
    );
  }

  @Put("meta/reporting-accounts/:id/status")
  async setMetaReportingAccountActive(
    @AuthToken() refreshToken: string,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    const input = this.parseBody(
      metaReportingAccountStatusInputSchema.safeParse(body),
    );

    if (!workspace.permissions.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }

    return this.integrationsService.setMetaReportingAccountActive(
      workspace.id,
      id,
      input.active,
      authenticated.user.id,
    );
  }

  @Get("uazapi/start")
  startUazapi() {
    return this.integrationsService.getUazapiStartAction();
  }


  private parseBody<T>(
    result: { success: true; data: T } | { success: false },
  ): T {
    if (!result.success) {
      throw new BadRequestException("Payload invalido");
    }

    return result.data;
  }

  private async getCurrentWorkspaceId(refreshToken: string): Promise<string> {
    const workspace = await this.getCurrentWorkspace(refreshToken);

    return workspace.id;
  }

  private async getCurrentWorkspace(refreshToken: string) {
    const authenticated = await this.authService.getSession(refreshToken);
    return this.workspacesService.getCurrentWorkspace(authenticated);
  }

}
