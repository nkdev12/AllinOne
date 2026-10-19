import { ErrorCode } from "@/common/errors/error-code";
import { createValidationPipe } from "@/common/errors/validation.pipe";
import { SyncStatusQueryDto } from "./sync-status-query.dto";

/**
 * `GET /sync/status` used to read its device id as a bare `@Query("deviceId")`, and
 * a primitive parameter never reaches the global `ValidationPipe` — it transforms
 * and whitelists DTO-typed arguments only. So the value went to
 * `device.findFirst({ where: { id: deviceId } })` exactly as the URL spelled it,
 * and Express's default query parser turns `?deviceId[$ne]=1` into an object, which
 * Prisma reads as Mongo operator syntax.
 *
 * The DTO is the fix, and this file is the proof that the fix is the pipe and not a
 * hopeful comment on the class: the same `createValidationPipe()` the app installs
 * in `src/main.ts` is handed the shapes a query string actually produces.
 */
describe("SyncStatusQueryDto", () => {
  const pipe = createValidationPipe();
  const context = { type: "query" as const, metatype: SyncStatusQueryDto };

  const deviceId = "123e4567-e89b-12d3-a456-426614174000";

  const ask = (value: unknown) => pipe.transform(value as any, context as any);

  const fieldsOf = async (value: unknown) => {
    const error: any = await ask(value).catch((e) => e);
    expect(error.getResponse().code).toBe(ErrorCode.VALIDATION_ERROR);
    // The pipe's contract: one fixed summary in `message`, the truth in
    // `details.fields`, each message humanised the same way every other 400 in
    // this API reads.
    expect(error.getResponse().message).toBe(
      "Please correct the highlighted fields.",
    );
    return error.getResponse().details.fields;
  };

  it("takes a device id that is a uuid", async () => {
    const value = await ask({ deviceId });
    expect(value.deviceId).toBe(deviceId);
  });

  it("refuses the operator object a query string can build", async () => {
    // `?deviceId[$ne]=1` — the shape this route was exposed to. The pipe's
    // `enableImplicitConversion` flattens that object to `"[object Object]"` before
    // the rules run, which is exactly the point: no clause can be assembled from an
    // object any more, and what is left is a string no `Device.id` matches, so the
    // shape rule refuses it and the request never reaches Prisma.
    const fields = await fieldsOf({ deviceId: { $ne: "1" } });

    expect(fields).toEqual([
      { field: "deviceId", messages: ["must be a UUID."] },
    ]);
  });

  it("refuses an array, which is the other thing a repeated key produces", async () => {
    // `?deviceId=a&deviceId=b` arrives as a list, and a list is a Mongo `$in`.
    // Arrays are not flattened by the transformer, so both rules answer.
    const fields = await fieldsOf({ deviceId: [deviceId, deviceId] });

    expect(fields).toEqual([
      { field: "deviceId", messages: ["must be a UUID.", "must be a string."] },
    ]);
  });

  it("refuses a non-uuid string instead of letting it reach the lookup", async () => {
    // `Device.id` is `@default(uuid())`, so anything else can only match a row that
    // does not exist. Asserting the shape here also means no value an operator can
    // be written in ever has a chance of looking like an id.
    const fields = await fieldsOf({ deviceId: "not-a-uuid" });

    expect(fields).toEqual([
      { field: "deviceId", messages: ["must be a UUID."] },
    ]);
  });

  it("refuses the query with no device named", async () => {
    const fields = await fieldsOf({});

    expect(fields).toEqual([
      { field: "deviceId", messages: ["must be a UUID.", "must be a string."] },
    ]);
  });

  it("refuses a key that is not part of the contract", async () => {
    // `forbidNonWhitelisted`, so a caller cannot smuggle a second device id past the
    // one the service reads.
    const fields = await fieldsOf({ deviceId, userId: "somebody-else" });

    expect(fields).toEqual([
      { field: "userId", messages: ["This field is not allowed."] },
    ]);
  });
});
