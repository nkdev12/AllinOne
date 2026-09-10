import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { finalize, tap } from "rxjs/operators";
import { TracingService } from "./tracing.service";
import { formatTraceParent } from "./tracing.interface";

@Injectable()
export class TracingInterceptor implements NestInterceptor {
  constructor(private readonly tracingService: TracingService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== "http") {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();

    const inboundTraceParent =
      req.headers?.traceparent || req.headers?.["x-trace-id"];
    const traceContext =
      this.tracingService.createContextFromHeader(inboundTraceParent);

    // Populate response headers for upstream client correlation
    const formattedTraceParent = formatTraceParent(
      traceContext.traceId,
      traceContext.spanId,
      traceContext.traceFlags,
    );

    if (res && typeof res.setHeader === "function") {
      res.setHeader("X-Trace-ID", traceContext.traceId);
      res.setHeader("traceparent", formattedTraceParent);
    }

    const method = req.method || "GET";
    const path = req.route?.path || req.url || "/";
    const spanName = `HTTP ${method} ${path}`;

    const span = this.tracingService.startSpan(spanName, {
      parentSpanId: traceContext.parentSpanId,
      attributes: {
        "http.method": method,
        "http.target": req.url,
        "http.route": path,
        "http.user_agent": req.headers?.["user-agent"],
        "http.client_ip": req.ip,
      },
    });

    let hasError = false;
    let caughtError: any;

    return new Observable((subscriber) => {
      this.tracingService.runWithContext(traceContext, () => {
        next
          .handle()
          .pipe(
            tap({
              next: () => {
                span.attributes["http.status_code"] = res.statusCode || 200;
              },
              error: (err) => {
                hasError = true;
                caughtError = err;
                span.attributes["http.status_code"] =
                  err.status || err.statusCode || 500;
                span.attributes["error.message"] = err.message;
              },
            }),
            finalize(() => {
              this.tracingService.endSpan(
                span,
                hasError ? "ERROR" : "OK",
                caughtError,
              );
            }),
          )
          .subscribe(subscriber);
      });
    });
  }
}
