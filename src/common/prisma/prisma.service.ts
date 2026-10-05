import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { PrismaClient, Prisma } from "@prisma/client";

/**
 * Scalar fields read back as `where: { field: null }` across the codebase.
 * The MongoDB connector only matches such a filter against documents that store
 * an explicit null; an absent field never matches, so every one of those reads
 * would silently return nothing.
 */
const NULLABLE_FILTER_FIELDS = [
  "deletedAt",
  "revokedAt",
  "parentId",
  "completedAt",
  "emailVerifiedAt",
];

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger("PrismaService");
  private readonly nullableFieldsByModel = new Map<string, Set<string>>();

  constructor() {
    super();
    for (const model of Prisma.dmmf.datamodel.models) {
      const fields = new Set(
        model.fields
          .filter(
            (field) =>
              field.kind === "scalar" &&
              !field.isRequired &&
              NULLABLE_FILTER_FIELDS.includes(field.name),
          )
          .map((field) => field.name),
      );
      if (fields.size > 0) this.nullableFieldsByModel.set(model.name, fields);
    }

    this.$use(async (params, next) => {
      const data =
        params.action === "create"
          ? params.args?.data
          : params.action === "upsert"
            ? params.args?.create
            : undefined;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const fields = this.nullableFieldsByModel.get(params.model ?? "");
        if (fields) {
          for (const field of fields) {
            if (!(field in data)) data[field] = null;
          }
        }
      }
      return next(params);
    });
  }

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
