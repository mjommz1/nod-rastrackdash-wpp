import { Module } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { LicenseClientModule } from "../licensing-client/license-client.module";
import { INTEGRATION_ENV } from "../integrations/integration.types";
import { ConversionEventsService } from "./conversion-events.service";
import { MetaCapiAdapter } from "./meta-capi.adapter";

@Module({
  imports: [PrismaModule, IntegrationsModule, LicenseClientModule],
  providers: [
    {
      provide: MetaCapiAdapter,
      useFactory: () => new MetaCapiAdapter(),
    },
    {
      provide: INTEGRATION_ENV,
      useValue: process.env,
    },
    ConversionEventsService,
  ],
  exports: [ConversionEventsService],
})
export class ConversionEventsModule {}
