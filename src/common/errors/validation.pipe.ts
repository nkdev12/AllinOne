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

/** Turn class-validator's implementation-oriented copy into UI-safe text. */
function humaniseConstraint(leaf: string, message: string): string {
  const stripped = stripProperty(leaf, message).trim();
  const lower = stripped.toLowerCase();

  if (
    leaf.toLowerCase().endsWith("email") &&
    (lower.includes("invalid email") || lower.includes("must be an email"))
  ) {
    return "Enter a valid email address.";
  }
  if (lower.includes("should not exist")) {
    return "This field is not allowed.";
  }
  if (
    lower.includes("should not be empty") ||
    lower.includes("must not be empty")
  ) {
    return "This field is required.";
  }
  if (!stripped) return "This field needs attention.";
  return stripped.endsWith(".") ? stripped : `${stripped}.`;
}

function collect(error: ValidationError, prefix = ""): FieldValidationError[] {
  const path = prefix ? `${prefix}.${error.property}` : error.property;
  const own = error.constraints
    ? Object.values(error.constraints).map((message) =>
        humaniseConstraint(error.property, message),
      )
    : [];
  const nested = (error.children ?? []).flatMap((child) =>
    collect(child, path),
  );
  return own.length > 0 ? [{ field: path, messages: own }, ...nested] : nested;
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
      return badRequest(
        ErrorCode.VALIDATION_ERROR,
        "Please correct the highlighted fields.",
        { fields },
      );
    },
  });
}
