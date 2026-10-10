import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsArray,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";

export class CreateTripDto {
  @ApiProperty({ example: "Japan Autumn Adventure", description: "Trip title" })
  @IsNotEmpty()
  @IsString()
  @MaxLength(150)
  title!: string;

  @ApiPropertyOptional({ example: ["Tokyo", "Kyoto", "Osaka"], description: "List of destinations" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  destinations?: string[];

  @ApiProperty({ example: "2026-11-01T00:00:00.000Z", description: "Start date of trip" })
  @IsNotEmpty()
  @IsISO8601()
  startDate!: string;

  @ApiProperty({ example: "2026-11-15T00:00:00.000Z", description: "End date of trip" })
  @IsNotEmpty()
  @IsISO8601()
  endDate!: string;

  @ApiPropertyOptional({ example: "JPY", default: "INR", description: "Base currency" })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  baseCurrency?: string;

  @ApiPropertyOptional({ example: 25000000, description: "Planned total budget in minor units" })
  @IsOptional()
  @IsInt()
  @Min(0)
  totalBudgetMinor?: number;

  @ApiPropertyOptional({ example: "Book bullet train tickets in advance", description: "Trip notes" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
