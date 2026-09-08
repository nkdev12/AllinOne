import { ApiProperty } from "@nestjs/swagger";
import {
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

export class ChangeItemDto {
  @ApiProperty({
    example: "note",
    description: "Type of entity (e.g. note, task, event)",
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
      "Plain object payload OR client-side zero-knowledge encrypted wrapper payload",
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
      "Client timestamp for Last-Write-Wins (LWW) conflict resolution",
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
    description: "Array of change items to push",
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChangeItemDto)
  changes!: ChangeItemDto[];
}
