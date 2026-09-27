import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ChangeOperation } from "@prisma/client";
import {
  MAX_CHANGES_PER_PUSH,
  SYNC_ENTITY_TYPES,
} from "../change-payload.validator";

export class ChangeItemDto {
  @ApiProperty({
    example: "note",
    enum: SYNC_ENTITY_TYPES,
    description:
      "Synced entity kind. Anything outside this list is refused on push, because a row nothing replays is copied to every device for the life of the log.",
  })
  @IsString()
  @IsNotEmpty()
  entityType!: string;

  @ApiProperty({
    example: "123e4567-e89b-12d3-a456-426614174000",
    description: "UUID of the entity",
  })
  @IsUUID()
  entityId!: string;

  @ApiProperty({
    enum: ChangeOperation,
    example: ChangeOperation.CREATE,
    description: "Operation type",
  })
  @IsEnum(ChangeOperation)
  operation!: ChangeOperation;

  @ApiProperty({
    example: 1,
    description: "Entity version for optimistic locking",
  })
  @IsInt()
  version!: number;

  @ApiProperty({
    example: { title: "My Note", content: "Hello World" },
    description:
      "Document for note, task, event, habit and habit_log. A note CREATE/UPDATE must carry {title, content} — title a string, content a string or null — and may carry createdAt (a string), tags (a list of strings or null) and color (a string or null), which a device that has not learned the last two simply omits; a habit must carry all fourteen of the columns a device overwrites from it, and a habit_log {habitId, day, amount, note, completedAt}; a vault_item UPDATE/CREATE must carry {type, encryptedData, iv, authTag, isEncrypted} with the same key names the client encrypts under. A DELETE is exempt from all of them: it announces an end rather than a body.",
  })
  @IsObject()
  payload!: Record<string, any>;

  @ApiProperty({
    example: true,
    description: "Indicates whether payload is end-to-end encrypted",
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  isEncrypted?: boolean;

  @ApiProperty({
    example: "2026-09-07T12:00:00.000Z",
    description:
      "When the device made the edit, on the device's own clock. Stored on the " +
      "change and echoed back on pull, so a client's list can order by the edit " +
      "rather than by when this server received it — `createdAt` is the arrival. " +
      "Never used to decide conflicts: refusal is by `version` alone, so a device " +
      "with a fast clock cannot push its way past a newer write.",
    required: false,
  })
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  clientTimestamp?: Date;
}

export class PushSyncDto {
  @ApiProperty({
    example: "123e4567-e89b-12d3-a456-426614174000",
    description: "ID of the pushing device",
  })
  @IsUUID()
  deviceId!: string;

  @ApiProperty({
    type: [ChangeItemDto],
    description: `Array of change items to push. At most ${MAX_CHANGES_PER_PUSH} per request: the whole batch is written inside one \`$transaction\`.`,
  })
  @IsArray()
  @ArrayMaxSize(MAX_CHANGES_PER_PUSH, {
    message: `a push may carry at most ${MAX_CHANGES_PER_PUSH} changes`,
  })
  @ValidateNested({ each: true })
  @Type(() => ChangeItemDto)
  changes!: ChangeItemDto[];
}
