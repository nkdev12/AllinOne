import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";

export class CreateItineraryItemDto {
  @ApiProperty({ example: 1, description: "Day number of the trip (1, 2, ...)" })
  @IsInt()
  @Min(1)
  dayIndex!: number;

  @ApiPropertyOptional({ example: "2026-11-01T00:00:00.000Z", description: "Date for this day" })
  @IsOptional()
  @IsISO8601()
  date?: string;

  @ApiProperty({ example: "Visit Fushimi Inari Taisha", description: "Activity or plan title" })
  @IsNotEmpty()
  @IsString()
  @MaxLength(150)
  title!: string;

  @ApiPropertyOptional({ example: 500000, description: "Planned cost in minor units" })
  @IsOptional()
  @IsInt()
  @Min(0)
  plannedCostMinor?: number;

  @ApiPropertyOptional({ example: "Early morning hike to avoid crowds", description: "Notes" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ example: 0, description: "Display sort order" })
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
