import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import {
  integrationEndpointCreateInputSchema,
  integrationEndpointProviderSchema,
  type IntegrationEndpointProviderDto,
} from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { IntegrationEndpointsService } from "./integration-endpoints.service";

/**
 * Fase 5.3: URL única por plataforma (Payt) e URLs por evento (Unnichat,
 * Umbler) do workspace atual. Leitura para qualquer membro; criar, mostrar,
 * girar, remover e "Tentar de novo" só para quem gerencia integrações. Com a
 * licença bloqueada, toda escrita responde 423 (guarda global).
 */
@Controller("integrations/endpoints")
export class IntegrationEndpointsController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(WorkspacesService)
    private readonly workspacesService: WorkspacesService,
    @Inject(IntegrationEndpointsService)
    private readonly endpoints: IntegrationEndpointsService,
  ) {}

  @Get()
  async list(@AuthToken() refreshToken: string) {
    const context = await this.context(refreshToken);
    return this.endpoints.list(
      context.workspaceId,
      context.canManageIntegrations,
    );
  }

  /** Gera a URL (ou devolve a viva, idempotente) já com o token, auditado. */
  @Post()
  @HttpCode(200)
  async ensure(@AuthToken() refreshToken: string, @Body() body: unknown) {
    const context = await this.requireManager(refreshToken);
    const parsed = integrationEndpointCreateInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return {
      endpoint: await this.endpoints.ensure(
        context.workspaceId,
        parsed.data,
        context.userId,
      ),
    };
  }

  /** Produtos detectados nas vendas recebidas (só Payt, por código). */
  @Get("products")
  async products(
    @AuthToken() refreshToken: string,
    @Query("provider") provider: unknown,
  ) {
    const context = await this.context(refreshToken);
    if ((provider ?? "payt") !== "payt") {
      throw new BadRequestException(
        "Produtos detectados só existem para a Payt",
      );
    }
    return this.endpoints.listProducts(context.workspaceId, "payt");
  }

  /** "Vendas sem atribuição": recebidos que não viraram conversão. */
  @Get("unattributed")
  async unattributed(
    @AuthToken() refreshToken: string,
    @Query("provider") provider: unknown,
  ) {
    const context = await this.context(refreshToken);
    let selected: IntegrationEndpointProviderDto | null = null;
    if (provider !== undefined) {
      const parsed = integrationEndpointProviderSchema.safeParse(provider);
      if (!parsed.success) throw new BadRequestException("Plataforma inválida");
      selected = parsed.data;
    }
    return this.endpoints.listUnattributed(context.workspaceId, selected);
  }

  /** "Tentar de novo": roteia outra vez um recibo guardado. */
  @Post("events/:eventId/retry")
  @HttpCode(200)
  async retry(
    @AuthToken() refreshToken: string,
    @Param("eventId") eventId: string,
  ) {
    const context = await this.requireManager(refreshToken);
    return this.endpoints.retryEvent(
      context.workspaceId,
      eventId,
      context.userId,
    );
  }

  /** "Mostrar URL": só gestores de integração, com auditoria. */
  @Post(":id/reveal")
  @HttpCode(200)
  async reveal(
    @AuthToken() refreshToken: string,
    @Param("id") endpointId: string,
  ) {
    const context = await this.requireManager(refreshToken);
    return {
      endpoint: await this.endpoints.reveal(
        context.workspaceId,
        endpointId,
        context.userId,
      ),
    };
  }

  /** Gera um token novo; a URL anterior deixa de funcionar na hora. */
  @Post(":id/rotate")
  @HttpCode(200)
  async rotate(
    @AuthToken() refreshToken: string,
    @Param("id") endpointId: string,
  ) {
    const context = await this.requireManager(refreshToken);
    return {
      endpoint: await this.endpoints.rotate(
        context.workspaceId,
        endpointId,
        context.userId,
      ),
    };
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(
    @AuthToken() refreshToken: string,
    @Param("id") endpointId: string,
  ): Promise<void> {
    const context = await this.requireManager(refreshToken);
    await this.endpoints.remove(context.workspaceId, endpointId, context.userId);
  }

  private async requireManager(refreshToken: string) {
    const context = await this.context(refreshToken);
    if (!context.canManageIntegrations) {
      throw new ForbiddenException("Sem permissao para gerenciar integracoes");
    }
    return context;
  }

  private async context(refreshToken: string): Promise<{
    canManageIntegrations: boolean;
    userId: string;
    workspaceId: string;
  }> {
    const authenticated = await this.authService.getSession(refreshToken);
    const workspace = this.workspacesService.getCurrentWorkspace(authenticated);
    return {
      canManageIntegrations: workspace.permissions.canManageIntegrations,
      userId: authenticated.user.id,
      workspaceId: workspace.id,
    };
  }
}
