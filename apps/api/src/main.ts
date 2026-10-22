import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { parseDeploymentConfig } from "./config/deployment-config";
import { getApiPort } from "./config/env";
import { loadLocalEnv } from "./config/load-env";
import { PlatformAdminEnvBootstrapService } from "./auth/platform-admin-env-bootstrap.service";
import { configureInboundWebhookBodyParser } from "./inbound-webhooks/inbound-webhook-body-parser";
import { LicenseAutoActivationService } from "./licensing-client/license-auto-activation.service";

async function bootstrap() {
  loadLocalEnv();
  const deploymentConfig = parseDeploymentConfig();
  const { AppModule } = await import("./app.module");
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bodyParser: false,
  });
  configureInboundWebhookBodyParser(app);
  app.enableCors({
    origin: deploymentConfig.webOrigin,
    credentials: true,
  });

  await app.get(LicenseAutoActivationService).activateOnBoot();
  await app.get(PlatformAdminEnvBootstrapService).bootstrap();

  await app.listen(getApiPort());
}

void bootstrap();
