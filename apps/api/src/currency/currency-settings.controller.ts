import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
} from "@nestjs/common";
import {
  adAccountCurrencyOverrideInputSchema,
  workspaceCurrencyUpdateInputSchema,
} from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { CurrencySettingsService } from "./currency-settings.service";

/**
 * Configurações -> Moeda (workspace atual da sessão). As leituras valem para
 * qualquer membro; as escritas (PATCH) exigem dono/admin e recebem 423 do
 * guard global de licença quando a licença está bloqueada.
 */
@Controller("workspaces/current/currency")
export class CurrencySettingsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(CurrencySettingsService)
    private readonly settings: CurrencySettingsService,
  ) {}

  @Get()
  async get(@AuthToken() token: string) {
    const { workspace } = await this.context(token);
    return this.settings.getSettings(workspace);
  }

  @Patch()
  async update(@AuthToken() token: string, @Body() body: unknown) {
    const parsed = workspaceCurrencyUpdateInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Moeda inválida");
    const { authenticated, workspace } = await this.context(token);
    return this.settings.updateSettings(authenticated, workspace, parsed.data);
  }

  @Get("ad-accounts")
  async listAdAccounts(@AuthToken() token: string) {
    const { workspace } = await this.context(token);
    return this.settings.listAdAccounts(workspace);
  }

  @Patch("ad-accounts/:accountId")
  async updateAdAccount(
    @AuthToken() token: string,
    @Param("accountId") accountId: string,
    @Body() body: unknown,
  ) {
    const parsed = adAccountCurrencyOverrideInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Moeda inválida");
    const { authenticated, workspace } = await this.context(token);
    return this.settings.updateAdAccountOverride(
      authenticated,
      workspace,
      accountId,
      parsed.data,
    );
  }

  private async context(token: string) {
    const authenticated = await this.auth.getSession(token);
    const workspace = this.workspaces.getCurrentWorkspace(authenticated);
    return { authenticated, workspace };
  }
}
