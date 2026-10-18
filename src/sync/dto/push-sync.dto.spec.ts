import { BadRequestException } from "@nestjs/common";
import { ErrorCode } from "@/common/errors/error-code";
import { createValidationPipe } from "@/common/errors/validation.pipe";
import { MAX_CHANGES_PER_PUSH } from "../change-payload.validator";
import { PushSyncDto } from "./push-sync.dto";

describe("PushSyncDto", () => {
  const pipe = createValidationPipe();
  const context = { type: "body" as const, metatype: PushSyncDto };

  // class-validator only needs a syntactically valid UUID per change, and a
  // distinct one keeps a mis-indexed error from looking like a passing test.
  const entityId = (n: number) =>
    `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

  const change = (n: number) => ({
    entityType: "note",
    entityId: entityId(n),
    operation: "UPDATE",
    version: 1,
    payload: { title: "Edit" },
  });

  const push = (count: number) =>
    pipe.transform(
      {
        deviceId: entityId(1),
        changes: Array.from({ length: count }, (_, n) => change(n)),
      },
      context,
    );

  it("refuses a batch larger than one transaction may hold", async () => {
    // Every change in a push is read, version-checked and written inside a
    // single `$transaction`, so the array's length is the transaction's size.
    await expect(push(MAX_CHANGES_PER_PUSH + 1)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("names the oversized array instead of describing each change", async () => {
    // Rejected as one request-shaped problem, before the nested changes are
    // judged: a client that sends 501 rows needs to halve the batch, not to
    // hunt for a bad row among it.
    //
    // The pipe's contract (validation.pipe.ts:72-79, and the same shape the
    // pipe-level spec and docs/API_REFERENCE.md assert): the top-level
    // `message` is one fixed summary that never echoes request content, and
    // the per-field truth lives only in `details.fields`. So naming the
    // oversized array is proven there — one entry, whose `field` is `changes`
    // and whose message states the limit.
    const error: any = await push(MAX_CHANGES_PER_PUSH + 1).catch((e) => e);
    const response = error.getResponse();

    // The DTO writes its constraint unpunctuated; the pipe normalises every
    // field message to sentence case with a trailing full stop
    // (validation.pipe.ts:43), so that is the text a client actually receives.
    const limitMessage = `a push may carry at most ${MAX_CHANGES_PER_PUSH} changes.`;

    expect(response.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(response.message).toBe("Please correct the highlighted fields.");

    // Exactly one field, and it is the array — not `changes.0` … `changes.500`.
    expect(response.details.fields).toEqual([
      { field: "changes", messages: [limitMessage] },
    ]);

    // Not a generic placeholder: the message carries the number the client has
    // to get under, which is the only way it can size the retry batch.
    expect(response.details.fields[0].messages[0]).toContain(
      String(MAX_CHANGES_PER_PUSH),
    );
    expect(response.details.fields[0].messages[0]).not.toMatch(
      /needs attention|This field/,
    );
  });

  it("takes a batch of exactly the cap", async () => {
    const value = await push(MAX_CHANGES_PER_PUSH);
    expect(value.changes).toHaveLength(MAX_CHANGES_PER_PUSH);
  });

  it("never caps a batch the shipped client can produce", () => {
    // The client budgets 64 KiB of JSON per request, and the smallest change it
    // emits — an empty-payload delete — is ~150 bytes serialised. A batch that
    // fills the budget therefore holds far fewer than the cap: the byte budget
    // binds first, which is the whole reason the cap is loose. A tighter number
    // would refuse a push that succeeds today, and the client keeps a refused
    // batch plus everything queued behind it.
    const smallestChangeBytes = 150;
    const clientBudgetBytes = 64 * 1024;

    expect(Math.floor(clientBudgetBytes / smallestChangeBytes)).toBeLessThan(
      MAX_CHANGES_PER_PUSH,
    );
  });
});
