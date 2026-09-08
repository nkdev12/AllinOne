import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { MetricsService } from "./metrics.service";

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== "http") {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const startTime = process.hrtime();

    return next.handle().pipe(
      tap(() => {
        const diff = process.hrtime(startTime);
        const durationSeconds = diff[0] + diff[1] / 1e9;

        const method = req.method || "GET";
        const route = req.route?.path || req.url || "unknown";
        const statusCode = res.statusCode || 200;

        // Ignore scraping /metrics requests from self-recording to keep histograms clean
        if (route === "/metrics" || route === "/metrics/") {
          return;
        }

        this.metricsService.recordHttpRequest({
          method,
          route,
          statusCode,
          durationSeconds,
        });
      }),
    );
  }
}
