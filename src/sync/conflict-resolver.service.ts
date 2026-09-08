import { Injectable, Logger } from "@nestjs/common";

export interface FieldMergeResult {
  mergedPayload: Record<string, any>;
  hadCollision: boolean;
  resolvedFields: string[];
}

@Injectable()
export class ConflictResolverService {
  private readonly logger = new Logger(ConflictResolverService.name);

  /**
   * Performs field-level Last-Write-Wins (LWW) JSON CRDT merging.
   *
   * Merges non-overlapping fields from incoming payload into existing payload.
   * On field collisions:
   * - Evaluates timestamp precedence (incomingTimestamp vs existingTimestamp).
   * - If timestamps match or are missing, uses incomingVersion vs existingVersion counter.
   */
  resolveLwwFieldMerge(
    existingPayload: Record<string, any>,
    incomingPayload: Record<string, any>,
    existingTimestamp?: Date,
    incomingTimestamp?: Date,
    existingVersion: number = 1,
    incomingVersion: number = 1,
  ): FieldMergeResult {
    const isExistingEncrypted =
      existingPayload && existingPayload.isEncrypted === true;
    const isIncomingEncrypted =
      incomingPayload && incomingPayload.isEncrypted === true;

    // Encrypted payloads cannot undergo internal property merging
    if (isExistingEncrypted || isIncomingEncrypted) {
      if (JSON.stringify(existingPayload) === JSON.stringify(incomingPayload)) {
        return {
          mergedPayload: existingPayload,
          hadCollision: false,
          resolvedFields: [],
        };
      }

      const shouldTakeIncoming = this.evaluateLwwPrecedence(
        existingTimestamp,
        incomingTimestamp,
        existingVersion,
        incomingVersion,
      );

      this.logger.debug(
        `[ConflictResolver] Encrypted payload collision: took ${
          shouldTakeIncoming ? "INCOMING" : "EXISTING"
        } payload blob.`,
      );

      return {
        mergedPayload: shouldTakeIncoming ? incomingPayload : existingPayload,
        hadCollision: true,
        resolvedFields: shouldTakeIncoming ? ["[encryptedPayload]"] : [],
      };
    }

    const mergedPayload = { ...(existingPayload || {}) };
    let hadCollision = false;
    const resolvedFields: string[] = [];

    const incomingKeys = Object.keys(incomingPayload || {});

    for (const key of incomingKeys) {
      const incomingVal = incomingPayload[key];

      if (!(key in mergedPayload)) {
        // Non-overlapping field: add directly
        mergedPayload[key] = incomingVal;
        resolvedFields.push(key);
        continue;
      }

      const existingVal = mergedPayload[key];

      // Deep equal check to avoid false collisions
      if (JSON.stringify(existingVal) === JSON.stringify(incomingVal)) {
        continue;
      }

      // Collision detected on key
      hadCollision = true;

      const shouldTakeIncoming = this.evaluateLwwPrecedence(
        existingTimestamp,
        incomingTimestamp,
        existingVersion,
        incomingVersion,
      );

      if (shouldTakeIncoming) {
        mergedPayload[key] = incomingVal;
        resolvedFields.push(key);
        this.logger.debug(
          `[ConflictResolver] Collision resolved for key '${key}': took INCOMING value.`,
        );
      } else {
        this.logger.debug(
          `[ConflictResolver] Collision resolved for key '${key}': retained EXISTING value.`,
        );
      }
    }

    return {
      mergedPayload,
      hadCollision,
      resolvedFields,
    };
  }

  private evaluateLwwPrecedence(
    existingTimestamp?: Date,
    incomingTimestamp?: Date,
    existingVersion: number = 1,
    incomingVersion: number = 1,
  ): boolean {
    if (incomingTimestamp && existingTimestamp) {
      const incTime = new Date(incomingTimestamp).getTime();
      const extTime = new Date(existingTimestamp).getTime();
      if (incTime !== extTime) {
        return incTime > extTime;
      }
    }

    if (incomingTimestamp && !existingTimestamp) return true;
    if (!incomingTimestamp && existingTimestamp) return false;

    // Version counter fallback
    return incomingVersion >= existingVersion;
  }
}
