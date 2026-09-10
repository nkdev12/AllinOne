import * as crypto from "crypto";

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags?: string;
  sampled?: boolean;
  attributes?: Record<string, any>;
}

export type SpanStatus = "OK" | "ERROR" | "UNSET";

export interface Span {
  id: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: Record<string, any>;
  error?: Error | string;
}

export interface SpanOptions {
  parentSpanId?: string;
  attributes?: Record<string, any>;
}

/**
 * Generates a valid W3C 32-character hex trace ID (16 bytes).
 */
export function generateTraceId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Generates a valid W3C 16-character hex span ID (8 bytes).
 */
export function generateSpanId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Parses a standard W3C 'traceparent' header (e.g., '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
 */
export function parseTraceParent(
  header?: string | string[],
): TraceContext | null {
  if (!header || typeof header !== "string") {
    return null;
  }

  const parts = header.trim().split("-");
  if (parts.length < 4) {
    return null;
  }

  const [version, traceId, parentSpanId, flags] = parts;

  // Validate version: only '00' is currently standard
  if (version !== "00" && version.length !== 2) {
    return null;
  }

  // Validate 32-hex trace ID (not all zeroes)
  if (!/^[0-9a-f]{32}$/i.test(traceId) || /^0{32}$/.test(traceId)) {
    return null;
  }

  // Validate 16-hex parent span ID (not all zeroes)
  if (!/^[0-9a-f]{16}$/i.test(parentSpanId) || /^0{16}$/.test(parentSpanId)) {
    return null;
  }

  const traceFlags = flags || "01";
  const sampled = (parseInt(traceFlags, 16) & 0x01) === 1;

  return {
    traceId: traceId.toLowerCase(),
    spanId: generateSpanId(),
    parentSpanId: parentSpanId.toLowerCase(),
    traceFlags,
    sampled,
  };
}

/**
 * Formats a TraceContext into a standard W3C 'traceparent' header.
 */
export function formatTraceParent(
  traceId: string,
  spanId: string,
  flags: string = "01",
): string {
  return `00-${traceId}-${spanId}-${flags}`;
}
