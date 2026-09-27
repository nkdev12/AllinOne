import { Module } from "@nestjs/common";
import { AiService } from "./ai.service";
import { AiController } from "./ai.controller";
import { GeminiClient } from "./gemini.client";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { ConfigurationModule } from "@/config/configuration.module";

@Module({
  imports: [PrismaModule, ConfigurationModule],
  controllers: [AiController],
  // GeminiClient owns every outbound call and every GEMINI_* config read, so
  // AiService stays about notes, tasks and tags rather than HTTP plumbing.
  providers: [AiService, GeminiClient],
  exports: [AiService],
})
export class AiModule {}
