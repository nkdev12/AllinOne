import { Injectable } from "@nestjs/common";
import { ConfigurationService } from "@/config/configuration.service";

export interface LogContext {
  requestId?: string;
  userId?: string;
  deviceId?: string;
  service?: string;
  action?: string;
  [key: string]: any;
}

@Injectable()
export class LoggerService {
  private logFormat: "json" | "simple";

  constructor(private configService: ConfigurationService) {
    this.logFormat = configService.logFormat;
  }

  /**
   * Log informational message
   */
  log(message: string, context?: string, metadata?: LogContext): void {
    this.formatAndLog("info", message, context, metadata);
  }

  /**
   * Log error message
   */
  error(
    message: string,
    error?: any,
    context?: string,
    metadata?: LogContext,
  ): void {
    const errorData = this.formatError(error);
    this.formatAndLog("error", message, context, {
      ...metadata,
      error: errorData,
    });
  }

  /**
   * Log warning message
   */
  warn(message: string, context?: string, metadata?: LogContext): void {
    this.formatAndLog("warn", message, context, metadata);
  }

  /**
   * Log debug message
   */
  debug(message: string, context?: string, metadata?: LogContext): void {
    this.formatAndLog("debug", message, context, metadata);
  }

  /**
   * Log verbose message
   */
  verbose(message: string, context?: string, metadata?: LogContext): void {
    this.formatAndLog("verbose", message, context, metadata);
  }

  /**
   * Format and output log based on configured format
   */
  private formatAndLog(
    level: string,
    message: string,
    context?: string,
    metadata?: LogContext,
  ): void {
    if (this.logFormat === "json") {
      this.logJson(level, message, context, metadata);
    } else {
      this.logSimple(level, message, context, metadata);
    }
  }

  /**
   * Log as JSON (for production)
   */
  private logJson(
    level: string,
    message: string,
    context?: string,
    metadata?: LogContext,
  ): void {
    const logEntry: Record<string, any> = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: context || "Allinone",
      ...metadata,
    };

    // Never log sensitive data
    delete logEntry.password;
    delete logEntry.token;
    delete logEntry.secret;
    delete logEntry.vaultContents;

    console.log(JSON.stringify(logEntry));
  }

  /**
   * Log as simple text (for development)
   */
  private logSimple(
    level: string,
    message: string,
    context?: string,
    metadata?: LogContext,
  ): void {
    const timestamp = new Date().toISOString();
    const ctx = context || "Allinone";
    const levelUpper = level.toUpperCase();

    let logMessage = `[${timestamp}] [${levelUpper}] [${ctx}] ${message}`;

    if (metadata && Object.keys(metadata).length > 0) {
      logMessage += ` ${JSON.stringify(metadata)}`;
    }

    console.log(logMessage);
  }

  /**
   * Format error for logging (without exposing stack traces in production)
   */
  private formatError(error: any): any {
    if (!error) return null;

    const formatted: any = {
      message: error.message || String(error),
      code: error.code,
      statusCode: error.statusCode,
    };

    // Include stack trace only in development
    if (this.configService.isDevelopment) {
      formatted.stack = error.stack;
    }

    return formatted;
  }
}
