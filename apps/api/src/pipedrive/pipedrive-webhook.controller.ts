import { Controller, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { PipedriveWebhookService } from "./pipedrive-webhook.service";

@Controller("webhooks/pipedrive/v1")
export class PipedriveWebhookController {
  constructor(
    @Inject(PipedriveWebhookService)
    private readonly webhooks: PipedriveWebhookService,
  ) {}
  @Post(":connectionId")
  @HttpCode(202)
  receive(
    @Param("connectionId") connectionId: string,
    @Req()
    request: {
      query?: Record<string, unknown>;
      body?: unknown;
      rawBody?: Buffer;
      headers: Record<string, unknown>;
    },
  ) {
    return this.webhooks.receive(
      connectionId,
      request.query?.token,
      request.rawBody ?? request.body,
      request.headers["content-type"],
    );
  }
}
