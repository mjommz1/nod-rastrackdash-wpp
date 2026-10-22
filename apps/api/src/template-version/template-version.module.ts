import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { readBuildIdentitySha } from "./build-identity";
import {
  BUILD_IDENTITY_FILE,
  TEMPLATE_VERSION_DEPLOYED_SHA,
  TEMPLATE_VERSION_GITHUB_FETCH,
} from "./template-version.constants";
import { TemplateVersionController } from "./template-version.controller";
import { TemplateVersionService } from "./template-version.service";

@Module({
  imports: [AuthModule],
  controllers: [TemplateVersionController],
  providers: [
    TemplateVersionService,
    {
      provide: TEMPLATE_VERSION_GITHUB_FETCH,
      useValue: fetch,
    },
    {
      provide: TEMPLATE_VERSION_DEPLOYED_SHA,
      // The image records its own commit at build time; a runtime GIT_SHA env
      // is ignored so a stale panel value can never claim a newer version.
      useFactory: () => readBuildIdentitySha(BUILD_IDENTITY_FILE),
    },
  ],
})
export class TemplateVersionModule {}
