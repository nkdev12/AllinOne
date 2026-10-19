import { ApiProperty } from "@nestjs/swagger";
import { AttendeeStatus } from "@prisma/client";
import { IsEmail, IsIn, IsString } from "class-validator";

/**
 * The legal RSVP answers, read off the schema rather than written out here.
 *
 * `prisma/schema.prisma` enum `AttendeeStatus` is the only source of truth for
 * what `EventAttendee.status` can hold, and a literal list copied into this file
 * would silently fall behind the first member added there. `Object.values` of the
 * generated client enum is that same list, produced at build time.
 */
export const ATTENDEE_STATUS_VALUES = Object.values(
  AttendeeStatus,
) as AttendeeStatus[];

/**
 * `PATCH /events/:id/rsvp`.
 *
 * This route used to read its two values as `@Body("email")` and `@Body("status")`.
 * Nest skips pipes whose `metatype` is a primitive (`toValidate()` is false for
 * `String`/`Number`/`Object`-typed parameters), so neither value was ever
 * class-validated and the app's global `whitelist` / `forbidNonWhitelisted`
 * settings did not apply — even though both go straight into
 * `where: { eventId, email }` and `data: { status }` in
 * `EventsService.updateAttendeeRSVP`, and the 404 echoed the submitted value back
 * to the caller.
 *
 * A DTO is the mechanism that fixes that, not a formality: the class is what
 * makes `ValidationPipe` run at all. Express's body parser hands
 * `{"email": {"$ne": null}}` to a handler with no shape rules as an object no
 * `IsEmail` can be argued out of, and Prisma on MongoDB reads that object as
 * operator syntax — which is how one submitted field could match every attendee
 * row on the event. The ownership check above the query bounds the damage today;
 * this class is what stops the pattern from being the only thing standing between
 * the next partial-body route and the same hole.
 */
export class RsvpDto {
  @ApiProperty({
    example: "colleague@example.com",
    description:
      "Attendee email address, matched exactly against this event's attendee rows. A string — an object here is refused rather than read as a query operator.",
  })
  @IsString()
  @IsEmail()
  email!: string;

  @ApiProperty({
    enum: ATTENDEE_STATUS_VALUES,
    example: AttendeeStatus.ACCEPTED,
    description: "New RSVP status for this attendee",
  })
  @IsIn(ATTENDEE_STATUS_VALUES)
  status!: AttendeeStatus;
}
