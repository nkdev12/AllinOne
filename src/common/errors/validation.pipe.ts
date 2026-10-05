import { ValidationPipe } from "@nestjs/common";
import { ValidationError } from "class-validator";
import { ErrorCode } from "./error-code";
import { badRequest } from "./http-errors";

export interface FieldValidationError {
  /** Property path, so `user.address.city` points at the exact input. */
  field: string;
  messages: string[];
}

/**
 * class-validator repeats the property name inside its message
 * ("email must be an email"). The field is labelled separately, so say it once.
 */
function stripProperty(leaf: string, message: string): string {
  return message.startsWith(`${leaf} `)
    ? message.slice(leaf.length + 1)
    : message;
}

function collect(error: ValidationError, prefix = ""): FieldValidationError[] {
  const path = prefix ? `${prefix}.${error.property}` : error.property;
  const own = error.constraints
    ? Object.values(error.constraints).map((message) =>
        stripProperty(error.property, message),
      )
    : [];
  const nested = (error.children ?? []).flatMap((child) =>
    collect(child, path),
  );
  return own.length > 0 ? [{ field: path, messages: own }, ...nested] : nested;
}

function summarise(field: FieldValidationError): string[] {
  return field.messages.map((message) => `${field.field}: ${message}`);
}

/**
 * The one ValidationPipe the app uses. It keeps the whitelist behaviour but
 * reports failures as `details.fields` instead of a bag of sentences, so a
 * client can mark the offending input rather than guess from prose.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: {
      enableImplicitConversion: true,
    },
    exceptionFactory: (errors: ValidationError[]) => {
      const fields = errors.flatMap((error) => collect(error));
      // The same failures, flattened for anyone reading a log line or a curl
      // response. Structured callers use details.fields instead.
      const summary = fields.flatMap(summarise);
      return badRequest(
        ErrorCode.VALIDATION_ERROR,
        summary.length > 0 ? summary : "Some fields need attention.",
        { fields },
      );
    },
  });
}
