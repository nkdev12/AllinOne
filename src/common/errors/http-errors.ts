import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ErrorCode } from "./error-code";

export interface ErrorBody {
  code: ErrorCode;
  /**
   * What a developer needs to diagnose the case. The client shows its own copy
   * for the code and keeps this for its details view, so name the offending id
   * or field here rather than writing it for end users.
   */
  message: string | string[];
  details?: Record<string, unknown>;
}

export function errorBody(
  code: ErrorCode,
  message: string | string[],
  details?: Record<string, unknown>,
): ErrorBody {
  return { code, message, ...(details ? { details } : {}) };
}

/**
 * Coded failures for the status the caller already means to raise.
 *
 * These return Nest's own exception classes rather than a custom one, so
 * `instanceof UnauthorizedException` checks and the HTTP status stay exactly
 * what a reader of the call site expects; the code rides inside the body, which
 * is what the exception filter forwards to clients.
 */
export function badRequest(
  code: ErrorCode,
  message: string | string[],
  details?: Record<string, unknown>,
) {
  return new BadRequestException(errorBody(code, message, details));
}

export function unauthorized(
  code: ErrorCode,
  message: string | string[],
  details?: Record<string, unknown>,
) {
  return new UnauthorizedException(errorBody(code, message, details));
}

export function forbidden(
  code: ErrorCode,
  message: string | string[],
  details?: Record<string, unknown>,
) {
  return new ForbiddenException(errorBody(code, message, details));
}

export function notFound(
  code: ErrorCode,
  message: string | string[],
  details?: Record<string, unknown>,
) {
  return new NotFoundException(errorBody(code, message, details));
}

export function conflict(
  code: ErrorCode,
  message: string | string[],
  details?: Record<string, unknown>,
) {
  return new ConflictException(errorBody(code, message, details));
}
