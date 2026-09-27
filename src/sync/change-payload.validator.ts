import { ChangeOperation } from "@prisma/client";
import { ErrorCode } from "@/common/errors/error-code";
import { badRequest } from "@/common/errors/http-errors";
import type { FieldValidationError } from "@/common/errors/validation.pipe";

/**
 * The entity kinds this deployment actually replays. Anything outside this list
 * has no consumer on a device, so storing it would only teach every other
 * device to ignore a row forever.
 */
export const SYNC_ENTITY_TYPES = [
  "note",
  "task",
  "event",
  "habit",
  "habit_log",
  "vault_item",
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

export interface ChangeEnvelope {
  entityType: string;
  operation: ChangeOperation | string;
  payload?: Record<string, any> | null;
}

/**
 * Only DELETE carries no content: everything else has to let another device
 * rebuild the entry, so RESTORE is judged like CREATE/UPDATE even though the
 * client happens not to send it today.
 */
const CONTENT_CARRYING_OPERATIONS: ReadonlySet<string> = new Set([
  ChangeOperation.CREATE,
  ChangeOperation.UPDATE,
  ChangeOperation.RESTORE,
]);

const VAULT_BLOB_STRINGS = ["type", "encryptedData", "iv", "authTag"] as const;

/**
 * The ceiling for one note payload, in the bytes it occupies on the wire.
 *
 * The number is the client's own: `SyncManager._maxPushBytes` budgets a push
 * batch at 64 KiB (`lib/sync_manager.dart:125`), so a first-party device cannot
 * put a note this size on the log at all except as a lone oversized change.
 * The alternative reading — the transport's, at the body parser's 100 kB —
 * would let the 90 kB note this rule exists to refuse through, and the reason to
 * refuse it is not the request but the copy: a stored row is replayed to every
 * device for the life of the log, and a pull page is 100 changes with no byte
 * budget of its own.
 */
const MAX_NOTE_PAYLOAD_BYTES = 64 * 1024;

/**
 * The ceiling for one habit or habit-log payload. A habit is a dozen short
 * fields and a log is four, so nothing that reaches this endpoint legitimately
 * comes close; the number exists to stop a client writing a diary into the
 * `note` column of one day's record, which the log would then replay to every
 * device for the life of the account.
 */
const MAX_HABIT_PAYLOAD_BYTES = 8 * 1024;

/**
 * The schedules a habit can be on, in the client's own words
 * (`lib/services/habit_rules.dart`). A fifth value would be a habit no device
 * knows when to draw, so it is refused here rather than filed and ignored.
 */
const HABIT_FREQUENCIES: readonly string[] = [
  "daily",
  "weekdays",
  "weekly_target",
  "monthly_target",
];

/** `YYYY-MM-DD`, the shape both a habit's start and a log's day travel in. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `HH:MM`, 24-hour — a habit reminder's whole wire format. */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * One column a device reads off a plaintext document payload, and what a wrong
 * value for it costs. `required` is about the *key* being there at all — null is
 * a value such a column legitimately holds, its absence is an erasure.
 */
interface DocumentField {
  key: string;
  required: boolean;
  accepts: (value: unknown) => boolean;
  expected: string;
}

/**
 * The keys `SyncManager._apply` reads off a habit change.
 *
 * A habit payload is a whole-document overwrite, so the failure that matters is
 * the one the note path already knows about: a key that is *absent* arrives as an
 * empty column everywhere else. For a habit that is quieter than an emptied note
 * body but just as destructive — an edit that drops `targetAmount` turns a
 * quantity habit into a checkbox on every other device, and one that drops
 * `frequency` unschedules it entirely.
 */
const HABIT_FIELDS: ReadonlyArray<DocumentField> = [
  {
    key: "name",
    required: true,
    accepts: (value) => isNonEmptyString(value),
    expected: "a non-empty string",
  },
  {
    // The three a habit can legitimately have nothing for, all of which are
    // still columns the receiving side overwrites from this payload.
    key: "emoji",
    required: true,
    accepts: (value) => typeof value === "string",
    expected: "a string",
  },
  {
    key: "color",
    required: true,
    accepts: (value) => typeof value === "string",
    expected: "a string",
  },
  {
    key: "category",
    required: true,
    accepts: (value) => typeof value === "string",
    expected: "a string",
  },
  {
    key: "unitLabel",
    required: true,
    accepts: (value) => typeof value === "string",
    expected: "a string",
  },
  {
    key: "frequency",
    required: true,
    accepts: (value) =>
      typeof value === "string" && HABIT_FREQUENCIES.includes(value),
    expected: `one of ${HABIT_FREQUENCIES.join(", ")}`,
  },
  {
    key: "weekdays",
    required: true,
    accepts: (value) =>
      value === null ||
      (Array.isArray(value) &&
        value.every(
          (day) =>
            Number.isInteger(day) &&
            (day as number) >= 1 &&
            (day as number) <= 7,
        )),
    expected: "null or a list of whole weekdays from 1 to 7",
  },
  {
    key: "targetPerPeriod",
    required: true,
    accepts: (value) =>
      value === null || (Number.isInteger(value) && (value as number) > 0),
    expected: "null or a whole number of completions",
  },
  {
    key: "targetAmount",
    required: true,
    accepts: (value) =>
      value === null || (typeof value === "number" && value > 0),
    expected: "null or an amount greater than zero",
  },
  {
    key: "reminderTime",
    required: true,
    accepts: (value) =>
      value === null || (typeof value === "string" && HHMM.test(value)),
    expected: "null or an HH:MM time",
  },
  {
    key: "streakFreeze",
    required: true,
    accepts: (value) => typeof value === "boolean",
    expected: "a boolean",
  },
  {
    key: "startDate",
    required: true,
    accepts: (value) => typeof value === "string" && ISO_DAY.test(value),
    expected: "a YYYY-MM-DD date",
  },
  {
    key: "sortOrder",
    required: true,
    accepts: (value) => Number.isInteger(value),
    expected: "a whole number",
  },
  {
    // Archiving is a habit's delete, and it travels as a value on the document
    // rather than as a DELETE: the history has to survive to be un-archived.
    key: "archivedAt",
    required: true,
    accepts: (value) => value === null || typeof value === "string",
    expected: "null or a string",
  },
];

/**
 * The keys `SyncManager._apply` reads off a habit_log change. Same overwrite
 * rule as [HABIT_FIELDS], and the same reason to judge it.
 */
const HABIT_LOG_FIELDS: ReadonlyArray<DocumentField> = [
  {
    key: "habitId",
    required: true,
    accepts: (value) => isNonEmptyString(value),
    expected: "a non-empty string",
  },
  {
    // The device's own calendar day, and the half of the pair a receiving device
    // looks the record up by. A log that arrives without one cannot be merged
    // with the same day logged elsewhere, so it would land as a second record.
    key: "day",
    required: true,
    accepts: (value) => typeof value === "string" && ISO_DAY.test(value),
    expected: "a YYYY-MM-DD date",
  },
  {
    key: "amount",
    required: true,
    accepts: (value) =>
      value === null || (typeof value === "number" && value >= 0),
    expected: "null or an amount",
  },
  {
    key: "note",
    required: true,
    accepts: (value) => value === null || typeof value === "string",
    expected: "null or a string",
  },
  {
    key: "completedAt",
    required: true,
    accepts: (value) => isNonEmptyString(value),
    expected: "a non-empty string",
  },
];

/**
 * The three keys `SyncManager._apply` reads off a note change, which is the
 * whole of what a note payload means to a device.
 *
 * The client stringifies whatever it finds (`_text`, `sync_manager.dart:596`),
 * so the two ways a note payload can be wrong are *absent* and *not text*: an
 * absent `content` arrives as an emptied body on every other device, and a
 * number arrives as its digits, permanently.
 */
const NOTE_FIELDS: ReadonlyArray<DocumentField> = [
  {
    key: "title",
    required: true,
    accepts: (value) => typeof value === "string",
    expected: "a string",
  },
  {
    // Null is a value a note really has — `Note.content` is an optional column,
    // and applying `content: null` to such a row is correct. Only the key being
    // *missing* is the destructive case.
    key: "content",
    required: true,
    accepts: (value) => value === null || typeof value === "string",
    expected: "a string or null",
  },
  {
    // Only a CREATE has a birth to announce; a later edit carries none.
    key: "createdAt",
    required: false,
    accepts: (value) => value === null || typeof value === "string",
    expected: "a string or null",
  },
];

/**
 * Most changes a single push may carry. The first-party client stops its own
 * batches far below this (it budgets 64 KiB of JSON per request), so this is a
 * ceiling for anything else that talks to the endpoint rather than a knob the
 * client has to match: every change in a batch is read, numbered and written
 * inside one `$transaction`, so an unbounded array is an unbounded transaction.
 * Enforced by `@ArrayMaxSize` on `PushSyncDto.changes`, not here, because it is
 * a rule about the request rather than about any one change.
 */
export const MAX_CHANGES_PER_PUSH = 500;

/**
 * Length ceiling for the vault blob fields that have a fixed size by
 * construction — `type`, `iv` and `authTag`. A 96-bit nonce base64s to 16
 * characters and a GCM tag to 24, so anything past this is not a larger secret
 * but something else in the field.
 *
 * `encryptedData` is deliberately exempt: it scales with the entry, and the
 * ceiling it really has is the request body limit — currently the body parser's
 * 100 kB default, which is why `SyncManager` stops a push batch at 64 KiB of
 * JSON. Putting a smaller number on the ciphertext would refuse a blob that
 * reaches this endpoint today and succeeds.
 */
const MAX_VAULT_FIXED_FIELD_CHARS = 128;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return `a ${typeof value}`;
}

/**
 * The one judgement every plaintext document type gets: is there a payload, does
 * it carry each key a device would overwrite a column from, and is each value a
 * value that column can hold.
 *
 * A note, a habit and a day's habit log are plaintext on the log, so their shape
 * can be judged the way a vault blob cannot — and the cost of getting it wrong is
 * the same in all three: a stored row is replayed to every device for the life of
 * the log, and an absent key arrives everywhere as an empty column.
 */
function documentViolations(
  payload: unknown,
  fields: ReadonlyArray<DocumentField>,
  field: string,
  label: string,
  maxBytes: number,
): FieldValidationError[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [
      { field, messages: [`a ${label} change must carry an object payload`] },
    ];
  }

  const violations: FieldValidationError[] = [];

  for (const { key, required, accepts, expected } of fields) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      if (required) {
        violations.push({
          field: `${field}.${key}`,
          messages: [
            "must be present, because a device applies an absent key as nothing",
          ],
        });
      }
      continue;
    }

    const value = (payload as Record<string, unknown>)[key];
    if (!accepts(value)) {
      violations.push({
        field: `${field}.${key}`,
        messages: [`must be ${expected}, not ${describeValue(value)}`],
      });
    }
  }

  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes > maxBytes) {
    violations.push({
      field,
      messages: [
        `is ${bytes} bytes, longer than the ${maxBytes} one ${label} can carry`,
      ],
    });
  }

  return violations;
}

/**
 * The columns a device reads off one plaintext type, and the ceiling that type's
 * payload has. `task` and `event` are absent on purpose: their partial shape
 * legitimately varies per client, and judging them here would reject edits the
 * sync log is meant to carry untouched.
 */
const DOCUMENT_SHAPES: Record<
  string,
  { fields: ReadonlyArray<DocumentField>; maxBytes: number }
> = {
  note: { fields: NOTE_FIELDS, maxBytes: MAX_NOTE_PAYLOAD_BYTES },
  habit: { fields: HABIT_FIELDS, maxBytes: MAX_HABIT_PAYLOAD_BYTES },
  habit_log: { fields: HABIT_LOG_FIELDS, maxBytes: MAX_HABIT_PAYLOAD_BYTES },
};

function violationsForChange(
  change: ChangeEnvelope,
  index: number,
): FieldValidationError[] {
  const violations: FieldValidationError[] = [];

  if (!(SYNC_ENTITY_TYPES as readonly string[]).includes(change.entityType)) {
    return [
      {
        field: `changes[${index}].entityType`,
        messages: [
          `unknown entity type "${change.entityType}". Synced types: ${SYNC_ENTITY_TYPES.join(", ")}.`,
        ],
      },
    ];
  }

  if (!CONTENT_CARRYING_OPERATIONS.has(String(change.operation))) {
    return violations;
  }

  const shape = DOCUMENT_SHAPES[change.entityType];
  if (shape) {
    return documentViolations(
      change.payload,
      shape.fields,
      `changes[${index}].payload`,
      change.entityType,
      shape.maxBytes,
    );
  }

  if (change.entityType !== "vault_item") {
    // task / event, and anything the allow-list gains without a shape, are
    // judged only by the entity-type check above.
    return violations;
  }

  const payload = change.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [
      {
        field: `changes[${index}].payload`,
        messages: ["a vault_item change must carry an object payload"],
      },
    ];
  }

  for (const key of VAULT_BLOB_STRINGS) {
    const value = payload[key];
    if (!isNonEmptyString(value)) {
      violations.push({
        field: `changes[${index}].payload.${key}`,
        messages: ["must be a present, non-empty string"],
      });
      continue;
    }

    if (key !== "encryptedData" && value.length > MAX_VAULT_FIXED_FIELD_CHARS) {
      violations.push({
        field: `changes[${index}].payload.${key}`,
        messages: [
          `is ${value.length} characters, longer than the ${MAX_VAULT_FIXED_FIELD_CHARS} a ${key} can be`,
        ],
      });
    }
  }

  if (typeof payload.isEncrypted !== "boolean") {
    violations.push({
      field: `changes[${index}].payload.isEncrypted`,
      messages: ["must be a boolean"],
    });
  }

  return violations;
}

/**
 * Every problem in the batch, in push order, without stopping at the first one:
 * a client that gets a whole batch refused learns about all of its bad rows in
 * one trip instead of one per retry.
 */
export function collectChangeViolations(
  changes: readonly ChangeEnvelope[],
): FieldValidationError[] {
  return changes.flatMap((change, index) => violationsForChange(change, index));
}

/**
 * Rejects a push whose changes could not be replayed on another device. Throwing
 * before any write happens is the point: a stored row is copied to every device
 * for the life of the log and cannot be unsent.
 */
export function assertPushableChanges(
  changes: readonly ChangeEnvelope[],
): void {
  const fields = collectChangeViolations(changes);
  if (fields.length === 0) return;

  throw badRequest(
    ErrorCode.SYNC_PUSH_REJECTED,
    fields.flatMap(({ field, messages }) =>
      messages.map((message) => `${field}: ${message}`),
    ),
    { fields },
  );
}
