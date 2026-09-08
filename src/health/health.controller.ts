import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import { Response } from "express";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { HealthService } from "./health.service";

@ApiTags("Health")
@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get("health")
  @ApiOperation({ summary: "Overall application health check" })
  @ApiResponse({
    status: 200,
    description: "Application is healthy (Terminus shape)",
  })
  @ApiResponse({ status: 503, description: "Application is unhealthy" })
  async health(@Res() response: Response) {
    const result = await this.healthService.checkTerminusHealth();
    return response
      .status(
        result.status === "ok" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
      )
      .json(result);
  }

  @Get("health/live")
  @ApiOperation({ summary: "Liveness probe - process status" })
  @ApiResponse({ status: 200, description: "Process is alive" })
  async liveness() {
    return { status: "ok" };
  }

  @Get("health/ready")
  @ApiOperation({ summary: "Readiness probe - DB & services ready" })
  @ApiResponse({
    status: 200,
    description: "Application is ready to accept traffic",
  })
  @ApiResponse({ status: 503, description: "Application is not ready" })
  async readiness(@Res() response: Response) {
    const result = await this.healthService.checkTerminusHealth();
    return response
      .status(
        result.status === "ok" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
      )
      .json(result);
  }

  @Get("info")
  @ApiOperation({ summary: "Static build and version metadata" })
  @ApiResponse({ status: 200, description: "Application build metadata" })
  async info() {
    return this.healthService.getInfo();
  }
}
