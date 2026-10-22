import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { studentInboundReplayAuthorizeSchema } from "@wpptrack/shared";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { InboundWebhookReplayService } from "./inbound-webhook-replay.service";
import type { StudentReplayActor } from "./student-replay-context";

@Controller(
  "integrations/inbound-webhooks/:connectionId/channels/:channelId/recovery",
)
export class StudentInboundReplayController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(InboundWebhookReplayService)
    private readonly replay: InboundWebhookReplayService,
  ) {}

  @Get("preview")
  async preview(
    @AuthToken() token: string,
    @Param("connectionId") connectionId: string,
    @Param("channelId") channelId: string,
  ) {
    return this.replay.previewStudentReplay(
      await this.owner(token),
      connectionId,
      channelId,
    );
  }

  @Post("authorize")
  @HttpCode(200)
  async authorize(
    @AuthToken() token: string,
    @Param("connectionId") connectionId: string,
    @Param("channelId") channelId: string,
    @Body() body: unknown,
  ) {
    const actor = await this.owner(token);
    const parsed = studentInboundReplayAuthorizeSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("Revise a confirmacao da recuperacao");
    return this.replay.authorizeStudentReplay(
      actor,
      connectionId,
      channelId,
      parsed.data,
    );
  }

  @Get("batches/:batchId")
  async result(
    @AuthToken() token: string,
    @Param("connectionId") connectionId: string,
    @Param("channelId") channelId: string,
    @Param("batchId") batchId: string,
  ) {
    return this.replay.getStudentReplayResult(
      await this.owner(token),
      connectionId,
      channelId,
      batchId,
    );
  }

  private async owner(token: string): Promise<StudentReplayActor> {
    const session = await this.auth.getSession(token);
    const workspace = this.workspaces.getCurrentWorkspace(session);
    if (
      workspace.role !== "owner" ||
      workspace.accessMode !== "member" ||
      !workspace.permissions.canManageIntegrations
    )
      throw new ForbiddenException(
        "Somente o owner do workspace pode recuperar CTWAs anteriores",
      );
    return { id: session.user.id, role: "owner", workspaceId: workspace.id };
  }
}
