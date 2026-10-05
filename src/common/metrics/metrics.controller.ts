import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from "@nestjs/swagger";
import { MetricsService } from "./metrics.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { AdminGuard } from "@/admin/guards/admin.guard";

@ApiTags("Metrics")
@Controller("metrics")
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiBearerAuth()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  @ApiOperation({ summary: "Expose Prometheus metrics in text format" })
  @ApiResponse({
    status: 200,
    description: "Prometheus metrics exposition output",
  })
  async getMetrics(): Promise<string> {
    return this.metricsService.getPrometheusMetrics();
  }
}
