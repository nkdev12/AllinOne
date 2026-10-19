import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { EventStatus } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ArrayMaxSize,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { AddAttendeeDto } from "./add-attendee.dto";

export class CreateEventDto {
  @ApiProperty({
    example: "123e4567-e89b-12d3-a456-426614174000",
    description: "Calendar UUID",
  })
  @IsUUID()
  calendarId!: string;

  @ApiProperty({
    example: "Q4 Product Roadmap Sync",
    description: "Event title",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({
    example: "Review quarterly goals and deliverables",
    description: "Event description",
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({
    example: "Conference Room B / Google Meet",
    description: "Location string or URL",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @ApiProperty({
    example: "2026-10-15T14:00:00.000Z",
    description: "Event start timestamp",
  })
  @Type(() => Date)
  @IsDate()
  startAt!: Date;

  @ApiProperty({
    example: "2026-10-15T15:00:00.000Z",
    description: "Event end timestamp",
  })
  @Type(() => Date)
  @IsDate()
  endAt!: Date;

  @ApiPropertyOptional({ example: false, description: "All-day event flag" })
  @IsOptional()
  @IsBoolean()
  isAllDay?: boolean;

  @ApiPropertyOptional({
    example: "FREQ=MONTHLY;BYDAY=3TH",
    description: "RRULE recurrence rule string",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  recurrenceRule?: string;

  @ApiPropertyOptional({
    enum: EventStatus,
    example: EventStatus.CONFIRMED,
    description: "Event status",
  })
  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;

  @ApiPropertyOptional({
    example: "#EA4335",
    description: "Custom event badge color hex",
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;

  @ApiPropertyOptional({
    type: [AddAttendeeDto],
    description: "List of attendees to invite",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AddAttendeeDto)
  attendees?: AddAttendeeDto[];
}
