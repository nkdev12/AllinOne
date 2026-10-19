import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsDefined } from "class-validator";

/**
 * `DELETE /users/me`.
 *
 * One field, required, with no default. That is the whole design: an erasure that
 * removes notes, tasks, events, the vault row and the change log must not be
 * reachable by a request that simply forgot to say anything, and an `@IsOptional()`
 * with `= false` is exactly that — a default doing the deciding.
 *
 * `skipExport: false` means "hand me the copy first", and the service refuses the
 * delete unless a completed export of this account exists
 * (`UsersService.exportAccount`, within `EXPORT_PROOF_WINDOW_MS`).
 * `skipExport: true` means "erase without one", and the account is gone.
 *
 * It is a plain boolean rather than an export id or a signed token because the
 * question the route has to answer is one a client can already answer truthfully,
 * and every cleverer form of the same acknowledgement — a nonce, a hash of the
 * bundle, a two-stage confirm — needs state this schema does not have. There is no
 * `Export` model in `prisma/schema.prisma`, and inventing one is the schema owner's
 * decision.
 */
export class DeleteAccountDto {
  @ApiProperty({
    example: false,
    description:
      "Acknowledge that this deletion proceeds without an export copy having been delivered to this account. Send `false` to delete only after `POST /users/me/export`; send `true` to erase now, with no copy.",
  })
  @IsDefined()
  @IsBoolean()
  skipExport!: boolean;
}
