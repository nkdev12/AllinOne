import { Module } from "@nestjs/common";
import { MailService } from "./mail.service";
import { ConfigurationModule } from "@/config/configuration.module";

@Module({
  imports: [ConfigurationModule],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
