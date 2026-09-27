import { BadRequestException } from "@nestjs/common";
import { ChangeOperation } from "@prisma/client";
import { ErrorCode } from "@/common/errors/error-code";
import {
  SYNC_ENTITY_TYPES,
  type ChangeEnvelope,
  assertPushableChanges,
  collectChangeViolations,
} from "./change-payload.validator";

describe("change-payload validator", () => {
  const vaultPayload = {
    type: "LOGIN",
    encryptedData: "aGVsbG8=",
    iv: "ZEZtWjlKVE5hY3ZzT2FnYg==",
    authTag: "b0RVMU56ZzBOVFEwTlRBMg==",
    isEncrypted: true,
  };

  function vaultChange(overrides: Record<string, unknown> = {}) {
    return {
      entityType: "vault_item",
      operation: ChangeOperation.CREATE,
      payload: { ...vaultPayload, ...overrides },
    };
  }

  describe("entity type allow-list", () => {
    it("accepts every entity kind the client queues", () => {
      expect(SYNC_ENTITY_TYPES).toEqual(
        expect.arrayContaining([
          "note",
          "task",
          "event",
          "habit",
          "habit_log",
          "vault_item",
        ]),
      );

      expect(() =>
        assertPushableChanges(
          SYNC_ENTITY_TYPES.map((entityType) => ({
            entityType,
            operation: ChangeOperation.DELETE,
            payload: {},
          })),
        ),
      ).not.toThrow();
    });

    it("rejects an entity type nothing replays", () => {
      expect(() =>
        assertPushableChanges([
          {
            entityType: "attachment",
            operation: ChangeOperation.CREATE,
            payload: { anything: true },
          },
        ]),
      ).toThrow(BadRequestException);

      expect(
        collectChangeViolations([
          {
            entityType: "vaultEntry",
            operation: ChangeOperation.CREATE,
            payload: vaultPayload,
          },
        ])[0].field,
      ).toBe("changes[0].entityType");
    });
  });

  describe("vault_item payloads", () => {
    it("accepts the encrypted blob the client sends", () => {
      expect(() => assertPushableChanges([vaultChange()])).not.toThrow();
      expect(() =>
        assertPushableChanges([
          vaultChange({ operation: ChangeOperation.UPDATE }),
        ]),
      ).not.toThrow();
    });

    it("tolerates extra keys, such as the version the client hoists", () => {
      expect(() =>
        assertPushableChanges([vaultChange({ version: 4 })]),
      ).not.toThrow();
    });

    it("accepts a delete, whose payload is legitimately empty", () => {
      expect(() =>
        assertPushableChanges([
          {
            entityType: "vault_item",
            operation: ChangeOperation.DELETE,
            payload: {},
          },
        ]),
      ).not.toThrow();
    });

    it.each([
      ["type", ""],
      ["encryptedData", ""],
      ["iv", null],
      ["authTag", undefined],
      ["isEncrypted", "true"],
    ])("rejects a blob missing or holding a bad %s", (key, value) => {
      const payload: Record<string, unknown> = { ...vaultPayload };
      if (value === undefined) delete payload[key];
      else payload[key] = value;

      const fields = collectChangeViolations([
        {
          entityType: "vault_item",
          operation: ChangeOperation.CREATE,
          payload,
        },
      ]);

      expect(fields.map((field) => field.field)).toEqual([
        `changes[0].payload.${key}`,
      ]);
    });

    it("rejects a content-carrying change with no payload at all", () => {
      expect(() =>
        assertPushableChanges([
          {
            entityType: "vault_item",
            operation: ChangeOperation.CREATE,
            payload: null,
          },
        ]),
      ).toThrow(BadRequestException);
    });
  });

  describe("task / event payloads", () => {
    it.each(["task", "event"])(
      "leaves a partial %s edit exactly as permissive as it was",
      (entityType) => {
        expect(() =>
          assertPushableChanges([
            { entityType, operation: ChangeOperation.UPDATE, payload: {} },
            {
              entityType,
              operation: ChangeOperation.UPDATE,
              payload: { title: "Only a title" },
            },
            {
              entityType,
              operation: ChangeOperation.CREATE,
              payload: { nested: [1, 2, { deep: true }] },
            },
          ]),
        ).not.toThrow();
      },
    );
  });

  describe("note payloads", () => {
    const note = (
      payload: unknown,
      operation: ChangeOperation = ChangeOperation.CREATE,
    ) => ({
      entityType: "note",
      operation,
      payload: payload as ChangeEnvelope["payload"],
    });

    const fieldsOf = (payload: unknown, operation?: ChangeOperation) =>
      collectChangeViolations([note(payload, operation)]).map(
        (violation) => violation.field,
      );

    it("accepts every shape a real writer produces", () => {
      expect(() =>
        assertPushableChanges([
          // The client's queue entries, verbatim from `notes_repository.dart`.
          note({
            title: "Draft",
            content: "text",
            version: 1,
            createdAt: "2026-09-26T10:00:00.000Z",
          }),
          note(
            { title: "Draft", content: "text", version: 2 },
            ChangeOperation.UPDATE,
          ),
          // A REST note whose content column is unset: null is the value the row
          // holds, so it is the value a device should be given.
          note({ title: "Title only", content: null }),
          // A blanked note — item H's whole point is that empty is a real edit.
          note({ title: "", content: "" }),
        ]),
      ).not.toThrow();
    });

    it("refuses the empty-payload create that used to pass", () => {
      expect(fieldsOf({})).toEqual([
        "changes[0].payload.title",
        "changes[0].payload.content",
      ]);
      expect(fieldsOf(null)).toEqual(["changes[0].payload"]);
      expect(fieldsOf(["a", "b"])).toEqual(["changes[0].payload"]);
      expect(fieldsOf(undefined)).toEqual(["changes[0].payload"]);
    });

    it("refuses an update that omits content, the shape that blanks a body", () => {
      // `SyncManager._apply` reads `_text(payload, 'content')`, and no key is
      // null: a payload naming only a title rewrites every other device's note
      // to that title with an emptied body.
      const fields = collectChangeViolations([
        note({ title: "Renamed" }, ChangeOperation.UPDATE),
      ]);

      expect(fields.map((field) => field.field)).toEqual([
        "changes[0].payload.content",
      ]);
      expect(fields[0].messages[0]).toContain("must be present");
    });

    it("refuses a field that is not text, because a device stringifies it", () => {
      // `_text` calls `toString()`, so these would land as "42" and
      // "[object Object]" on every device and could not be unsent.
      expect(
        fieldsOf({ title: "Ok", content: 42, createdAt: 1730000000000 }),
      ).toEqual(["changes[0].payload.content", "changes[0].payload.createdAt"]);
      expect(fieldsOf({ title: null, content: "body" })).toEqual([
        "changes[0].payload.title",
      ]);
      expect(
        collectChangeViolations([note({ title: null, content: "x" })])[0]
          .messages[0],
      ).toContain("not null");
    });

    it("tolerates keys no device reads", () => {
      expect(() =>
        assertPushableChanges([
          note({
            title: "Draft",
            content: "text",
            version: 3,
            isPinned: true,
            folderId: null,
          }),
        ]),
      ).not.toThrow();
    });

    it("leaves a delete alone, and keeps the size rule on the body only", () => {
      expect(() =>
        assertPushableChanges([
          note({ version: 4 }, ChangeOperation.DELETE),
          note({}, ChangeOperation.DELETE),
        ]),
      ).not.toThrow();
    });

    it("refuses the 90 kB note and accepts one that only looks large", () => {
      const fields = collectChangeViolations([
        note({ title: "Long", content: "a".repeat(90 * 1024) }),
      ]);

      expect(fields.map((field) => field.field)).toEqual([
        "changes[0].payload",
      ]);
      expect(fields[0].messages[0]).toContain("bytes, longer than the 65536");

      expect(() =>
        assertPushableChanges([
          note({ title: "Long", content: "a".repeat(40 * 1024) }),
        ]),
      ).not.toThrow();
    });

    it("counts bytes, not characters", () => {
      // The client sizes its batches in UTF-8 for the same reason: a note of
      // two-byte characters measured in units is half its real size.
      const payload = { title: "Note", content: "é".repeat(30 * 1024) };
      expect(payload.content.length).toBeLessThan(64 * 1024);
      expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(
        64 * 1024,
      );
      expect(fieldsOf(payload)).toEqual([]);

      const over = { title: "Note", content: "é".repeat(40 * 1024) };
      expect(over.content.length).toBeLessThan(64 * 1024);
      expect(fieldsOf(over)).toEqual(["changes[0].payload"]);
    });
  });

  describe("habit payloads", () => {
    /** Verbatim from `lib/repositories/habit_repository.dart`'s `_habitPayload`. */
    const habitPayload = {
      name: "Morning Run",
      emoji: "🏃",
      color: "#42A5F5",
      category: "health",
      frequency: "daily",
      weekdays: null,
      targetPerPeriod: null,
      targetAmount: null,
      unitLabel: "",
      reminderTime: "07:00",
      streakFreeze: false,
      startDate: "2026-09-01",
      sortOrder: 0,
      archivedAt: null,
    };

    const habit = (
      payload: unknown,
      operation: ChangeOperation = ChangeOperation.CREATE,
    ) => ({
      entityType: "habit",
      operation,
      payload: payload as ChangeEnvelope["payload"],
    });

    const fieldsOf = (payload: unknown, operation?: ChangeOperation) =>
      collectChangeViolations([habit(payload, operation)]).map(
        (violation) => violation.field,
      );

    it("accepts the shape a real habit writer produces", () => {
      expect(() =>
        assertPushableChanges([
          habit({
            ...habitPayload,
            version: 1,
            createdAt: "2026-09-01T04:00:00Z",
          }),
          habit(
            {
              ...habitPayload,
              frequency: "weekdays",
              weekdays: [1, 3, 5],
              version: 2,
            },
            ChangeOperation.UPDATE,
          ),
          habit({
            ...habitPayload,
            frequency: "weekly_target",
            targetPerPeriod: 3,
            targetAmount: 30,
            unitLabel: "min",
            reminderTime: null,
          }),
          // Archiving is a habit's delete, and it travels as a value on the
          // document — so an archive update has to be as pushable as a rename.
          habit({
            ...habitPayload,
            archivedAt: "2026-09-27T09:00:00Z",
            version: 3,
          }),
          // A habit with no emoji, colour or category is a habit a user filled in
          // the minimum: empty is a value, only absence is an erasure.
          habit({ ...habitPayload, emoji: "", color: "", category: "" }),
        ]),
      ).not.toThrow();
    });

    it("refuses the edit that drops a column, whichever column it is", () => {
      // A device applies an absent key as nothing, so each of these would land as
      // a silently degraded habit everywhere else: no target, no schedule, an
      // un-archived archive.
      const without = (key: string) => {
        const payload: Record<string, unknown> = { ...habitPayload };
        delete payload[key];
        return payload;
      };

      expect(fieldsOf(without("targetAmount"))).toEqual([
        "changes[0].payload.targetAmount",
      ]);
      expect(fieldsOf(without("frequency"))).toEqual([
        "changes[0].payload.frequency",
      ]);
      expect(fieldsOf(without("archivedAt"))).toEqual([
        "changes[0].payload.archivedAt",
      ]);
      expect(fieldsOf({})).toHaveLength(14);
    });

    it("refuses the values a device cannot draw a schedule from", () => {
      expect(fieldsOf({ ...habitPayload, frequency: "yearly" })).toEqual([
        "changes[0].payload.frequency",
      ]);
      // A weekday of 0 or 8 is a day that does not exist, and `bool` lands on the
      // row as the string "true" the streak maths cannot compare against 1..7.
      expect(fieldsOf({ ...habitPayload, weekdays: [1, 8] })).toEqual([
        "changes[0].payload.weekdays",
      ]);
      expect(fieldsOf({ ...habitPayload, weekdays: [1, "2"] })).toEqual([
        "changes[0].payload.weekdays",
      ]);
      expect(fieldsOf({ ...habitPayload, reminderTime: "7am" })).toEqual([
        "changes[0].payload.reminderTime",
      ]);
      expect(fieldsOf({ ...habitPayload, startDate: "2026-09" })).toEqual([
        "changes[0].payload.startDate",
      ]);
      expect(fieldsOf({ ...habitPayload, streakFreeze: "true" })).toEqual([
        "changes[0].payload.streakFreeze",
      ]);
      // A quota of zero or a target of nothing is a habit that is always done,
      // which no user means and no client can undo once it is on the log.
      expect(fieldsOf({ ...habitPayload, targetPerPeriod: 0 })).toEqual([
        "changes[0].payload.targetPerPeriod",
      ]);
      expect(fieldsOf({ ...habitPayload, targetAmount: -5 })).toEqual([
        "changes[0].payload.targetAmount",
      ]);
      expect(fieldsOf({ ...habitPayload, name: "  " })).toEqual([
        "changes[0].payload.name",
      ]);
    });

    it("leaves an archive-shaped delete alone, like every other type", () => {
      expect(() =>
        assertPushableChanges([habit({ version: 4 }, ChangeOperation.DELETE)]),
      ).not.toThrow();
    });

    it("refuses a habit payload that has outgrown one", () => {
      const fields = collectChangeViolations([
        habit({ ...habitPayload, category: "a".repeat(9 * 1024) }),
      ]);

      expect(fields.map((field) => field.field)).toEqual([
        "changes[0].payload",
      ]);
      expect(fields[0].messages[0]).toContain("longer than the 8192");
    });
  });

  describe("habit_log payloads", () => {
    const logPayload = {
      habitId: "6f1f0c1e-3a5b-4c2d-9e8f-1a2b3c4d5e6f",
      day: "2026-09-27",
      amount: null,
      note: "Felt great, added an extra mile",
      completedAt: "2026-09-27T06:12:03",
    };

    const log = (
      payload: unknown,
      operation: ChangeOperation = ChangeOperation.CREATE,
    ) => ({
      entityType: "habit_log",
      operation,
      payload: payload as ChangeEnvelope["payload"],
    });

    const fieldsOf = (payload: unknown, operation?: ChangeOperation) =>
      collectChangeViolations([log(payload, operation)]).map(
        (violation) => violation.field,
      );

    it("accepts a checked day and a measured one alike", () => {
      expect(() =>
        assertPushableChanges([
          log({ ...logPayload, version: 1 }),
          log({ ...logPayload, amount: 6, note: null, version: 2 }),
          // An un-done day is a delete of the record, and carries nothing else.
          log({ version: 3 }, ChangeOperation.DELETE),
        ]),
      ).not.toThrow();
    });

    it("refuses the log a device could not merge with the same day elsewhere", () => {
      // `SyncManager._apply` files a log by (habitId, day), so either half going
      // missing lands the record on no habit at all, or as a second record for a
      // day the user already checked off.
      const missing = (key: string) => {
        const payload: Record<string, unknown> = { ...logPayload };
        delete payload[key];
        return payload;
      };

      expect(fieldsOf(missing("day"))).toEqual(["changes[0].payload.day"]);
      expect(fieldsOf(missing("habitId"))).toEqual([
        "changes[0].payload.habitId",
      ]);
      expect(fieldsOf({ ...logPayload, day: "27-09-2026" })).toEqual([
        "changes[0].payload.day",
      ]);
      expect(fieldsOf({ ...logPayload, amount: "6" })).toEqual([
        "changes[0].payload.amount",
      ]);
    });
  });

  describe("blob size", () => {
    it("refuses a fixed-size blob field that has outgrown its name", () => {
      const fields = collectChangeViolations([
        vaultChange({ iv: "A".repeat(5000) }),
      ]);

      expect(fields.map((field) => field.field)).toEqual([
        "changes[0].payload.iv",
      ]);
      expect(fields[0].messages[0]).toContain("longer than the 128");
    });

    it("still stores a ciphertext that is merely large", () => {
      // `encryptedData` scales with the entry, and the ceiling that bounds it
      // is the request body limit. Refusing a big blob here would break a vault
      // entry that reaches this endpoint and is written today.
      expect(() =>
        assertPushableChanges([
          vaultChange({ encryptedData: "Q".repeat(60 * 1024) }),
        ]),
      ).not.toThrow();
    });
  });

  it("names every bad change in one refusal so a retry is not blind", () => {
    const fields = collectChangeViolations([
      vaultChange({ authTag: "" }),
      { entityType: "ghost", operation: ChangeOperation.CREATE, payload: {} },
      vaultChange({ isEncrypted: 1 }),
    ]);

    expect(fields.map((field) => field.field)).toEqual([
      "changes[0].payload.authTag",
      "changes[1].entityType",
      "changes[2].payload.isEncrypted",
    ]);
  });

  it("throws the repo's coded 400 rather than a bespoke envelope", () => {
    let thrown: any;
    try {
      assertPushableChanges([vaultChange({ iv: "" })]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(thrown.getResponse()).toEqual({
      code: ErrorCode.SYNC_PUSH_REJECTED,
      message: ["changes[0].payload.iv: must be a present, non-empty string"],
      details: {
        fields: [
          {
            field: "changes[0].payload.iv",
            messages: ["must be a present, non-empty string"],
          },
        ],
      },
    });
  });
});
