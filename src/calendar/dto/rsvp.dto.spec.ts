import { PARAMTYPES_METADATA } from "@nestjs/common/constants";
import { ErrorCode } from "@/common/errors/error-code";
import { createValidationPipe } from "@/common/errors/validation.pipe";
import { AttendeeStatus } from "@prisma/client";
import { EventsController } from "../controllers/events.controller";
import { RsvpDto } from "./rsvp.dto";

/**
 * The mechanism this file exists to pin down.
 *
 * `PATCH /events/:id/rsvp` used to read `@Body("email")` / `@Body("status")`. Nest
 * does not run pipes on a primitive metatype — `ValidationPipe.toValidate()` is
 * false for `String`, `Number` and the bare `Object` a destructured body property
 * reports — so neither value was ever class-validated, and the `whitelist` and
 * `forbidNonWhitelisted` the app installs globally (`src/main.ts`) had nothing to
 * apply to. Both went into `where: { eventId, email }` as typed.
 *
 * `@Body() dto: RsvpDto` gives the pipe a class to work on, which is the whole
 * fix, so the first assertion below is about that metadata and the rest run the
 * same pipe instance the app installs against the shapes a JSON body can hold.
 */
describe("RsvpDto", () => {
  const pipe = createValidationPipe();
  const context = { type: "body" as const, metatype: RsvpDto };

  const ask = (value: unknown) => pipe.transform(value as any, context as any);

  const fieldsOf = async (value: unknown) => {
    const error: any = await ask(value).catch((e) => e);
    expect(error).toBeDefined();
    expect(error.getResponse().code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(error.getResponse().message).toBe(
      "Please correct the highlighted fields.",
    );
    return error.getResponse().details.fields;
  };

  it("is the class the route hands the global pipe", () => {
    // `design:paramtypes`, which is exactly what Nest reads to decide whether a
    // pipe runs on an argument. The third parameter is the body.
    const paramTypes: any[] =
      Reflect.getMetadata(PARAMTYPES_METADATA, EventsController.prototype, "updateRSVP") ??
      [];

    // This is the whole fix, asserted rather than assumed: a parameter whose type
    // is `RsvpDto` is class-validated, whitelisted and stripped of unknown keys by
    // the global pipe, and one whose type is `String` — which is what
    // `@Body("email")` reported — is skipped by `toValidate()` before any rule
    // runs. `@Param` and `@GetUser` stay strings, because they are strings.
    expect(paramTypes[2]).toBe(RsvpDto);
    expect(paramTypes[0]).toBe(String);
  });

  it("takes an email and a status the schema recognises", async () => {
    const value = await ask({
      email: "colleague@example.com",
      status: AttendeeStatus.ACCEPTED,
    });

    expect(value).toEqual({
      email: "colleague@example.com",
      status: AttendeeStatus.ACCEPTED,
    });
  });

  it("refuses the operator object a body can carry, instead of querying with it", async () => {
    // `{"email": {"$ne": null}}` is the shape that used to reach Prisma untouched,
    // where MongoDB reads it as a clause matching every attendee on the event.
    // `enableImplicitConversion` flattens it to a string no email rule accepts.
    const fields = await fieldsOf({
      email: { $ne: null },
      status: AttendeeStatus.ACCEPTED,
    });

    expect(fields).toEqual([
      { field: "email", messages: ["Enter a valid email address."] },
    ]);
  });

  it("refuses an array, which is what a repeated form key decodes to", async () => {
    // Arrays are not flattened by the transformer, so both rules get a say — and
    // a list is a Mongo `$in`, which is the other way one field could stop being
    // one field.
    const fields = await fieldsOf({
      email: ["a@example.com", "b@example.com"],
      status: AttendeeStatus.ACCEPTED,
    });

    expect(fields).toEqual([
      {
        field: "email",
        messages: ["Enter a valid email address.", "must be a string."],
      },
    ]);
  });

  it("refuses a status that is not one of the schema's attendee states", async () => {
    // The legal set is `AttendeeStatus` in `prisma/schema.prisma`; `MAYBE` is
    // invented here precisely because inventing one is what a Mongo write would
    // then have to store.
    const fields = await fieldsOf({
      email: "colleague@example.com",
      status: "MAYBE",
    });

    expect(fields).toEqual([
      {
        field: "status",
        messages: [
          "must be one of the following values: NEEDS_ACTION, ACCEPTED, DECLINED, TENTATIVE.",
        ],
      },
    ]);
  });

  it("refuses a status that is an operator object rather than a value", async () => {
    const fields = await fieldsOf({
      email: "colleague@example.com",
      status: { $in: ["ACCEPTED"] },
    });

    expect(fields).toEqual([
      {
        field: "status",
        messages: [
          "must be one of the following values: NEEDS_ACTION, ACCEPTED, DECLINED, TENTATIVE.",
        ],
      },
    ]);
  });

  it("refuses the RSVP with either half missing", async () => {
    // No defaults on this DTO: an RSVP that names no attendee, or records no
    // answer, is a client bug and must not be silently filled in.
    await expect(
      fieldsOf({ email: "colleague@example.com" }),
    ).resolves.toEqual([
      {
        field: "status",
        messages: [
          "must be one of the following values: NEEDS_ACTION, ACCEPTED, DECLINED, TENTATIVE.",
        ],
      },
    ]);
    await expect(
      fieldsOf({ status: AttendeeStatus.DECLINED }),
    ).resolves.toEqual([
      {
        field: "email",
        messages: ["Enter a valid email address.", "must be a string."],
      },
    ]);
  });

  it("refuses a key that is not part of the contract", async () => {
    // `forbidNonWhitelisted`, so `isOrganizer` cannot ride along into the update.
    const fields = await fieldsOf({
      email: "colleague@example.com",
      status: AttendeeStatus.TENTATIVE,
      isOrganizer: true,
    });

    expect(fields).toEqual([
      { field: "isOrganizer", messages: ["This field is not allowed."] },
    ]);
  });
});
