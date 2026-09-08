import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from "@nestjs/common";
import { Observable, of } from "rxjs";
import { tap } from "rxjs/operators";
import { PrismaService } from "@/common/prisma/prisma.service";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    // Only apply to state-changing methods
    const method = request.method?.toUpperCase();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      return next.handle();
    }

    const idempotencyKey =
      (request.headers["idempotency-key"] as string) ||
      (request.headers["x-idempotency-key"] as string);

    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      return next.handle();
    }

    const key = idempotencyKey.trim();
    if (!key) {
      return next.handle();
    }

    const userId = request.user?.id || NIL_UUID;
    const now = new Date();

    try {
      const existing = await this.prisma.idempotencyKey.findUnique({
        where: { key },
      });

      if (existing && existing.expiresAt > now) {
        this.logger.debug(`Idempotency hit for key: ${key}`);
        response.status(existing.statusCode);
        return of(existing.response);
      }
    } catch (error) {
      this.logger.warn(`Failed to lookup idempotency key ${key}:`, error);
    }

    return next.handle().pipe(
      tap({
        next: async (responseData) => {
          try {
            const statusCode = response.statusCode || 200;
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

            await this.prisma.idempotencyKey.upsert({
              where: { key },
              create: {
                key,
                userId,
                endpoint: request.url,
                method,
                statusCode,
                response: responseData !== undefined ? responseData : {},
                expiresAt,
              },
              update: {
                userId,
                endpoint: request.url,
                method,
                statusCode,
                response: responseData !== undefined ? responseData : {},
                expiresAt,
              },
            });
            this.logger.debug(`Saved idempotency response for key: ${key}`);
          } catch (error) {
            this.logger.error(`Failed to save idempotency key ${key}:`, error);
          }
        },
      }),
    );
  }
}
