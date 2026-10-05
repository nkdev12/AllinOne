import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ErrorCode } from "../../errors/error-code";

interface CanonicalErrorResponse {
  statusCode: number;
  code: string;
  message: string | string[];
  /** Structured, developer-facing context: failing fields, a blocked id. */
  details?: Record<string, unknown>;
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
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = this.getErrorCodeForStatus(status);
      const exceptionResponse = exception.getResponse() as any;

      if (typeof exceptionResponse === "object" && exceptionResponse !== null) {
        code = exceptionResponse.code || code;
        message = exceptionResponse.message || message;
        details = exceptionResponse.details;
      } else if (typeof exceptionResponse === "string") {
        message = exceptionResponse;
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Prisma's text names models, columns and sometimes the values that
      // failed, so it stays in the log. The client gets a stable code and the
      // non-sensitive meta the database already reported.
      this.logger.error(`Prisma ${exception.code}: ${exception.message}`, {
        requestId,
        meta: exception.meta,
      });
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = "INTERNAL_ERROR";
      message = "The server could not save that change.";

      switch (exception.code) {
        case "P2002":
          status = HttpStatus.CONFLICT;
          code = ErrorCode.ALREADY_EXISTS;
          message = "That entry already exists.";
          details = { target: exception.meta?.target };
          break;
        case "P2003":
          status = HttpStatus.CONFLICT;
          code = "CONFLICT";
          message = "A record this one depends on is missing or still in use.";
          details = { field: exception.meta?.field };
          break;
        case "P2025":
          status = HttpStatus.NOT_FOUND;
          code = ErrorCode.NOT_FOUND;
          message = "That item no longer exists.";
          break;
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      // A query the code built wrong: a bug to fix here, never a message to
      // show anyone else.
      this.logger.error(
        `Prisma query rejected: ${exception.message}`,
        exception.stack,
      );
      message = "An unexpected error occurred";
    } else if (exception instanceof Error) {
      code = this.getErrorCodeForStatus(status);
      message = "An unexpected error occurred";

      this.logger.error(
        `Unhandled exception: ${exception.message}`,
        exception.stack,
      );
    }

    const canonicalBody: CanonicalErrorResponse = {
      statusCode: status,
      code,
      message,
      ...(details ? { details } : {}),
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
