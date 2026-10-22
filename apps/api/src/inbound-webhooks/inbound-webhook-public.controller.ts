import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  RawBody,
  UnauthorizedException,
} from "@nestjs/common";
import { InboundWebhookIngestionService } from "./inbound-webhook-ingestion.service";
import { InboundConversionAutomationIngestionService } from "./inbound-conversion-automation-ingestion.service";
import { InboundWebhookMetaCloudVerificationService } from "./inbound-webhook-meta-cloud-verification.service";
import { IntegrationEndpointsService } from "./integration-endpoints.service";

@Controller("webhooks/inbound")
export class InboundWebhookPublicController {
  private readonly logger = new Logger(InboundWebhookPublicController.name);

  constructor(
    @Inject(InboundWebhookIngestionService)
    private readonly ingestion: InboundWebhookIngestionService,
    @Inject(InboundConversionAutomationIngestionService)
    private readonly conversionAutomationIngestion: InboundConversionAutomationIngestionService,
    @Inject(InboundWebhookMetaCloudVerificationService)
    private readonly metaCloudVerification: InboundWebhookMetaCloudVerificationService,
    @Inject(IntegrationEndpointsService)
    private readonly integrationEndpoints: IntegrationEndpointsService,
  ) {}

  @Get(":connectionId")
  @Header("Content-Type", "text/plain; charset=utf-8")
  async verifyMetaCloudWebhook(
    @Param("connectionId") connectionId: string,
    @Query("hub.mode") mode: unknown,
    @Query("hub.verify_token") verifyToken: unknown,
    @Query("hub.challenge") challenge: unknown,
  ): Promise<string> {
    if (
      mode !== "subscribe" ||
      typeof challenge !== "string" ||
      !(await this.metaCloudVerification.matches(connectionId, verifyToken))
    ) {
      throw new UnauthorizedException("Nao autorizado");
    }

    return challenge;
  }

  /**
   * Fase 5.3: URL única da plataforma de venda (Payt) ou URL por evento
   * (Unnichat/Umbler) do workspace. O roteador escolhe a regra dona e entrega
   * o callback ao mesmo processamento da URL da regra.
   */
  @Post("integrations/:endpointId")
  @HttpCode(202)
  async receiveIntegrationEndpoint(
    @Param("endpointId") endpointId: string,
    @Query("token") token: unknown,
    @Headers("content-type") contentType: string | undefined,
    @Headers("x-attempt") providerAttempt: unknown,
    @RawBody() rawBody: Buffer | undefined,
  ) {
    return this.integrationEndpoints.ingest({
      endpointId,
      token,
      contentType,
      providerAttempt,
      rawBody,
    });
  }

  @Post("conversions/:endpointId")
  @HttpCode(202)
  async receiveConversionAutomation(
    @Param("endpointId") endpointId: string,
    @Query("token") token: unknown,
    @Headers("content-type") contentType: string | undefined,
    @Headers("x-attempt") providerAttempt: unknown,
    @RawBody() rawBody: Buffer | undefined,
  ) {
    return this.conversionAutomationIngestion.ingest({
      endpointId,
      token,
      contentType,
      providerAttempt,
      rawBody,
    });
  }

  @Post(":connectionId")
  @HttpCode(202)
  async receive(
    @Param("connectionId") connectionId: string,
    @Query("token") token: unknown,
    @Headers("content-type") contentType: string | undefined,
    @Headers("x-attempt") providerAttempt: unknown,
    @Headers("x-hub-signature-256") metaCloudSignature256: unknown,
    @RawBody() rawBody: Buffer | undefined,
  ) {
    const startedAt = Date.now();

    try {
      const result = await this.ingestion.ingest({
        connectionId,
        token,
        contentType,
        providerAttempt,
        metaCloudSignature256,
        rawBody,
      });
      const durationMs = Date.now() - startedAt;

      if (durationMs >= 1_000) {
        this.logger.warn(
          JSON.stringify({
            event: "inbound_webhook.accepted_slow",
            connectionId,
            durationMs,
            bodyBytes: rawBody?.length ?? 0,
            queueStatus: result.queueStatus,
          }),
        );
      }

      return result;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "inbound_webhook.rejected",
          connectionId,
          statusCode: error instanceof HttpException ? error.getStatus() : 500,
          durationMs: Date.now() - startedAt,
          bodyBytes: rawBody?.length ?? 0,
          contentType: contentType?.split(";", 1)[0] ?? null,
        }),
      );
      throw error;
    }
  }
}
