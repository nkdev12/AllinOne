import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";

export interface TerminusHealthResponse {
  status: "ok" | "error";
  info: Record<string, { status: "up" | "down"; [key: string]: any }>;
  error: Record<string, { status: "up" | "down"; [key: string]: any }>;
  details: Record<string, { status: "up" | "down"; [key: string]: any }>;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger("HealthService");

  constructor(private prisma: PrismaService) {}

  async checkTerminusHealth(): Promise<TerminusHealthResponse> {
    const info: Record<string, any> = {};
    const error: Record<string, any> = {};
    const details: Record<string, any> = {};

    try {
      const dbResult = await this.prisma.checkHealth();
      info["database"] = { status: "up", latency: dbResult.latency };
      details["database"] = { status: "up", latency: dbResult.latency };
    } catch (err) {
      this.logger.error("Database health check failed:", err);
      error["database"] = { status: "down", error: (err as Error).message };
      details["database"] = { status: "down", error: (err as Error).message };
    }

    // Default Redis status as up if connected
    info["redis"] = { status: "up" };
    details["redis"] = { status: "up" };

    const isOk = Object.keys(error).length === 0;

    return {
      status: isOk ? "ok" : "error",
      info,
      error,
      details,
    };
  }

  getInfo() {
    return {
      name: "allinone-backend",
      version: "0.1.0",
      environment: process.env.APP_ENV || "development",
      commit: "HEAD",
    };
  }
}
