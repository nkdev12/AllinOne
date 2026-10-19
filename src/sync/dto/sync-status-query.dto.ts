import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsUUID } from "class-validator";

/**
 * The only query `/sync/status` takes.
 *
 * It exists because a primitive `@Query("deviceId")` never reaches the global
 * `ValidationPipe`, which transforms and whitelists DTO-typed parameters only: the
 * value went to Prisma exactly as the URL spelled it, and an object there
 * (`?deviceId[$ne]=1`, which Express's default query parser does build) turns the
 * `where` clause into an operator query — the lookup then answers for a row nobody
 * named. The ownership check that follows is scoped to the caller, so nothing was
 * ever handed to another account, but a parameter that reaches a query without
 * ever having been typed is not a check, it is a coincidence.
 *
 * `@IsUUID()` and not a looser string rule, for two reasons that point the same
 * way: `Device.id` is `@default(uuid())` (`prisma/schema.prisma`), which is what
 * every other sync DTO already asserts for the same value (`PushSyncDto`,
 * `PullSyncDto`), and a UUID is not a shape a query operator can be written in.
 */
export class SyncStatusQueryDto {
  @ApiProperty({
    example: "123e4567-e89b-12d3-a456-426614174000",
    description: "ID of the device to report sync status for",
  })
  @IsString()
  @IsUUID()
  deviceId!: string;
}
