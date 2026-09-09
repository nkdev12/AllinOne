import { Module } from "@nestjs/common";
import { LoggerService } from "./logger.service";
import { ConfigurationModule } from "@/config/configuration.module";

@Module({
  imports: [ConfigurationModule],
  providers: [LoggerService],
  exports: [LoggerService],
})
export class LoggingModule {}
