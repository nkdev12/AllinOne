import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { CalendarProvider } from "@prisma/client";
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

export class CreateCalendarDto {
  @ApiProperty({
    example: "Personal Calendar",
    description: "Calendar display name",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    example: "My main personal events calendar",
    description: "Calendar description",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ example: "#4285F4", description: "Hex color badge" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;

  @ApiPropertyOptional({
    example: "America/New_York",
    description: "Default timezone string",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  timeZone?: string;

  @ApiPropertyOptional({
    example: false,
    description: "Set as primary default calendar",
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional({
    enum: CalendarProvider,
    example: CalendarProvider.LOCAL,
    description: "External integration provider",
  })
  @IsOptional()
  @IsEnum(CalendarProvider)
  externalProvider?: CalendarProvider;
}
