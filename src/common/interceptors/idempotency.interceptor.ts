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

    // Vault routes answer with key material — recovery/verify returns the
    // wrapped master key. Storing that body in IdempotencyKey.response would
    // copy it into a table nothing treats as vault data, for a day, so vault
    // traffic is never cached or replayed here.
    //
    // `/sync/push` is not in this list, and that is a constraint worth reading
    // before either adding it or starting to send the header there. `main.ts`
    // already allows `Idempotency-Key` through CORS, and the Flutter client
    // sending no such header on any route is a habit rather than a guarantee.
    // What the cache answers with is `(userId, key)` — not the endpoint: the key
    // is a string the caller chose, and nothing in the row says what the batch
    // *was* (`endpoint` and `method` get recorded, but no lookup uses them, so
    // one key reused across routes replays whichever response came first). So
    // one retry of one batch is exactly what this handles, while a second,
    // different batch sent under a reused key never reaches the handler: the
    // change log stays as it was and the client is handed the first batch's
    // `accepted` — a 201 naming changes it never made, indistinguishable from a
    // queue that landed. Derive the key from the batch, or send none. The
    // executable version of this is the last test in
    // `idempotency.interceptor.spec.ts`.
    if ((request.url ?? "").split("?")[0].split("/").includes("vault")) {
      return next.handle();
    }

    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      return next.handle();
    }

    const key = idempotencyKey.trim();
    if (!key) {
      return next.handle();
    }

    const userId = request.user?.id;
    if (!userId) {
      // Unauthenticated requests (e.g. login, register, refresh) must not be
      // pooled under a shared NIL_UUID bucket, preventing credential and token
      // leakage across distinct callers.
      return next.handle();
    }
    const now = new Date();

    // The row is addressed by the account *and* the key. Addressing by key alone
    // let anybody who held the string read back whoever cached it first, and let a
    // caller reusing an unknown key overwrite that row's userId on the write path
    // below — the pair makes "not mine" simply mean "no cached response", so the
    // handler runs and each account keeps its own row under a shared key.
    try {
      const existing = await this.prisma.idempotencyKey.findUnique({
        where: { userId_key: { userId, key } },
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
              where: { userId_key: { userId, key } },
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
