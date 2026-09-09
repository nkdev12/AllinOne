import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger("PrismaService");

  async onModuleInit() {
    await this.$connect();
    this.logger.log("Database connected");
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log("Database disconnected");
  }

  // ========================================================================
  // Health check for database
  // ========================================================================
  async checkHealth(): Promise<{ status: string; latency: number }> {
    const start = Date.now();
    try {
      await this.$runCommandRaw({ ping: 1 });
      const latency = Date.now() - start;
      return { status: "healthy", latency };
    } catch (error) {
      this.logger.error("Database health check failed:", error);
      throw error;
    }
  }
}
