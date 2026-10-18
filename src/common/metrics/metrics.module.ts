import { Module } from "@nestjs/common";
import { MetricsService } from "./metrics.service";
import { MetricsController } from "./metrics.controller";
import { MetricsInterceptor } from "./metrics.interceptor";
import { MetricsScrapeGuard } from "./metrics-scrape.guard";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { ConfigurationModule } from "@/config/configuration.module";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { AdminGuard } from "@/admin/guards/admin.guard";

@Module({
  // ConfigurationModule is listed even though it is @Global, because the guard
  // below injects ConfigurationService: AuthModule and AdminModule name it for
  // the same reason, and a module whose config dependency only holds because
  // something else imported it globally cannot be compiled on its own.
  imports: [PrismaModule, ConfigurationModule],
  controllers: [MetricsController],
  // The two delegate guards are providers here because `MetricsScrapeGuard`
  // injects them. A class passed to another controller's `@UseGuards` is built
  // by Nest's enhancer machinery and never registered as a provider, so
  // AuthModule's and AdminModule's copies are not tokens this module can
  // resolve. Both are stateless, so the extra instances share nothing.
  providers: [
    MetricsService,
    MetricsInterceptor,
    JwtAuthGuard,
    AdminGuard,
    MetricsScrapeGuard,
  ],
  exports: [MetricsService, MetricsInterceptor],
})
export class MetricsModule {}
