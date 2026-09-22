import { Injectable, Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import {
  TraceContext,
  Span,
  SpanOptions,
  SpanStatus,
  generateTraceId,
  generateSpanId,
  parseTraceParent,
  formatTraceParent,
} from "./tracing.interface";

export type SpanExporter = (span: Span) => void | Promise<void>;

@Injectable()
export class TracingService {
  private readonly logger = new Logger(TracingService.name);
  private readonly asyncLocalStorage = new AsyncLocalStorage<TraceContext>();
  private spanExporter?: SpanExporter;

  /**
   * Configures an external span exporter (e.g., OTLP collector, Jaeger, Zipkin).
   */
  setExporter(exporter: SpanExporter): void {
    this.spanExporter = exporter;
  }

  /**
   * Executes a synchronous or asynchronous callback within the given TraceContext.
   */
  runWithContext<T>(context: TraceContext, fn: () => T): T {
    return this.asyncLocalStorage.run(context, fn);
  }

  /**
   * Returns the current active trace context, if any.
   */
  getCurrentContext(): TraceContext | undefined {
    return this.asyncLocalStorage.getStore();
  }

  /**
   * Returns the current active trace ID, or undefined.
   */
  getCurrentTraceId(): string | undefined {
    return this.getCurrentContext()?.traceId;
  }

  /**
   * Returns the current active span ID, or undefined.
   */
  getCurrentSpanId(): string | undefined {
    return this.getCurrentContext()?.spanId;
  }

  /**
   * Creates a root or child TraceContext from an optional inbound W3C traceparent header.
   */
  createContextFromHeader(header?: string | string[]): TraceContext {
    const parsed = parseTraceParent(header);
    if (parsed) {
      return parsed;
    }

    const traceId = generateTraceId();
    const spanId = generateSpanId();
    return {
      traceId,
      spanId,
      traceFlags: "01",
      sampled: true,
      attributes: {},
    };
  }

  /**
   * Starts a new span. Uses current context as parent if available.
   */
  startSpan(name: string, options?: SpanOptions): Span {
    const parentContext = this.getCurrentContext();
    const traceId = parentContext?.traceId || generateTraceId();
    const parentSpanId = options?.parentSpanId || parentContext?.spanId;
    const spanId = generateSpanId();

    return {
      id: spanId,
      traceId,
      parentSpanId,
      name,
      startTime: Date.now(),
      status: "UNSET",
      attributes: { ...parentContext?.attributes, ...options?.attributes },
    };
  }

  /**
   * Ends a span, computing its duration and notifying the exporter.
   */
  endSpan(span: Span, status: SpanStatus = "OK", error?: Error | string): void {
    span.endTime = Date.now();
    span.durationMs = Math.max(0, span.endTime - span.startTime);
    span.status = status;
    if (error) {
      span.error = error;
      span.status = "ERROR";
    }

    if (this.spanExporter) {
      try {
        const result = this.spanExporter(span);
        if (result && typeof (result as any).catch === "function") {
          (result as any).catch((err: any) =>
            this.logger.debug(`Span exporter error: ${err.message}`),
          );
        }
      } catch (err: any) {
        this.logger.debug(`Span exporter error: ${err.message}`);
      }
    }
  }

  /**
   * Wraps an execution in a tracked span, automatically handling completion and errors.
   */
  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    options?: SpanOptions,
  ): Promise<T> {
    const span = this.startSpan(name, options);
    const childContext: TraceContext = {
      traceId: span.traceId,
      spanId: span.id,
      parentSpanId: span.parentSpanId,
      traceFlags: "01",
      sampled: true,
      attributes: span.attributes,
    };

    return this.runWithContext(childContext, async () => {
      try {
        const result = await fn(span);
        this.endSpan(span, "OK");
        return result;
      } catch (err: any) {
        this.endSpan(span, "ERROR", err);
        throw err;
      }
    });
  }

  /**
   * Formats the current context into a standard W3C 'traceparent' header string.
   */
  getTraceParentHeader(): string | undefined {
    const ctx = this.getCurrentContext();
    if (!ctx) return undefined;
    return formatTraceParent(ctx.traceId, ctx.spanId, ctx.traceFlags || "01");
  }
}
