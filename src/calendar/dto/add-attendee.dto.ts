import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { AttendeeStatus } from "@prisma/client";
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

export class AddAttendeeDto {
  @ApiProperty({
    example: "colleague@example.com",
    description: "Attendee email address",
  })
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional({
    example: "Jane Doe",
    description: "Attendee display name",
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({
    enum: AttendeeStatus,
    example: AttendeeStatus.NEEDS_ACTION,
    description: "RSVP status",
  })
  @IsOptional()
  @IsEnum(AttendeeStatus)
  status?: AttendeeStatus;

  @ApiPropertyOptional({
    example: false,
    description: "Mark as event organizer",
  })
  @IsOptional()
  @IsBoolean()
  isOrganizer?: boolean;
}
