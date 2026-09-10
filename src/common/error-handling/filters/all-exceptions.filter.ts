import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

interface CanonicalErrorResponse {
  statusCode: number;
  code: string;
  message: string | string[];
  requestId: string;
  traceId?: string;
  timestamp: string;
  path: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("ExceptionFilter");

  private getErrorCodeForStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return "VALIDATION_ERROR";
      case HttpStatus.UNAUTHORIZED:
        return "UNAUTHORIZED";
      case HttpStatus.FORBIDDEN:
        return "FORBIDDEN";
      case HttpStatus.NOT_FOUND:
        return "NOT_FOUND";
      case HttpStatus.CONFLICT:
        return "CONFLICT";
      case HttpStatus.TOO_MANY_REQUESTS:
        return "RATE_LIMITED";
      default:
        return status >= 500 ? "INTERNAL_ERROR" : "ERROR";
    }
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const inboundRequestId = request.headers["x-request-id"];
    const requestId =
      typeof inboundRequestId === "string" && inboundRequestId
        ? inboundRequestId
        : uuidv4();

    const inboundTraceId =
      (request as any)?.traceId ||
      (request as any)?.traceContext?.traceId ||
      (typeof request.headers["x-trace-id"] === "string"
        ? request.headers["x-trace-id"]
        : undefined);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = "INTERNAL_ERROR";
    let message: string | string[] = "An unexpected error occurred";

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = this.getErrorCodeForStatus(status);
      const exceptionResponse = exception.getResponse() as any;

      if (typeof exceptionResponse === "object" && exceptionResponse !== null) {
        code = exceptionResponse.code || code;
        message = exceptionResponse.message || message;
      } else if (typeof exceptionResponse === "string") {
        message = exceptionResponse;
      }
    } else if (exception instanceof Error) {
      code = this.getErrorCodeForStatus(status);
      message = exception.message || "An unexpected error occurred";

      this.logger.error(
        `Unhandled exception: ${exception.message}`,
        exception.stack,
      );
    }

    const canonicalBody: CanonicalErrorResponse = {
      statusCode: status,
      code,
      message,
      requestId,
      ...(inboundTraceId ? { traceId: inboundTraceId } : {}),
      timestamp: new Date().toISOString(),
      path: request.url || request.originalUrl,
    };

    if (status >= 500) {
      this.logger.error(
        `[${request.method}] ${request.url} - ${status} - ${code}`,
        {
          requestId,
          traceId: inboundTraceId,
          method: request.method,
          url: request.url,
          statusCode: status,
          errorCode: code,
        },
      );
    } else {
      this.logger.warn(
        `[${request.method}] ${request.url} - ${status} - ${code}`,
        {
          requestId,
          traceId: inboundTraceId,
          method: request.method,
          url: request.url,
          statusCode: status,
          errorCode: code,
        },
      );
    }

    const res = response.status(status).header("X-Request-ID", requestId);
    if (inboundTraceId) {
      res.header("X-Trace-ID", inboundTraceId);
    }
    res.json(canonicalBody);
  }
}
