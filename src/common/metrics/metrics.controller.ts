import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { MetricsService } from "./metrics.service";
import { MetricsScrapeGuard } from "./metrics-scrape.guard";

@ApiTags("Metrics")
@Controller("metrics")
// Not the `JwtAuthGuard, AdminGuard` pair every other admin surface stacks:
// guards run in declaration order, so that pair 401s a scrape before
// `AdminGuard`'s shared-secret branch is reached. `MetricsScrapeGuard` takes
// both presentations itself and delegates to those two guards for a human
// caller — see its decision order.
@UseGuards(MetricsScrapeGuard)
@ApiBearerAuth()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  @ApiOperation({ summary: "Expose Prometheus metrics in text format" })
  @ApiResponse({
    status: 200,
    description:
      "Prometheus metrics exposition output. The bearer credential is either an admin's access token or, for a scrape, the shared `ADMIN_SECRET` value itself.",
  })
  async getMetrics(): Promise<string> {
    return this.metricsService.getPrometheusMetrics();
  }
}
