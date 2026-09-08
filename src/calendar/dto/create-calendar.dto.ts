import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { CalendarProvider } from "@prisma/client";
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from "class-validator";

export class CreateCalendarDto {
  @ApiProperty({
    example: "Personal Calendar",
    description: "Calendar display name",
  })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    example: "My main personal events calendar",
    description: "Calendar description",
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: "#4285F4", description: "Hex color badge" })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({
    example: "America/New_York",
    description: "Default timezone string",
  })
  @IsOptional()
  @IsString()
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
