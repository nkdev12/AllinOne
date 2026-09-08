import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsDate,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from "class-validator";

export class QueryEventsDto {
  @ApiPropertyOptional({
    example: "2026-10-01T00:00:00.000Z",
    description: "Filter events starting on or after timestamp",
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startFrom?: Date;

  @ApiPropertyOptional({
    example: "2026-10-31T23:59:59.999Z",
    description: "Filter events ending on or before timestamp",
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startTo?: Date;

  @ApiPropertyOptional({
    example: "123e4567-e89b-12d3-a456-426614174000",
    description: "Filter by Calendar UUID",
  })
  @IsOptional()
  @IsUUID()
  calendarId?: string;

  @ApiPropertyOptional({
    example: "Roadmap",
    description: "Search term matching title, description, or location",
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 1, description: "Page number (default 1)" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    example: 50,
    description: "Page item limit (default 50, max 200)",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}
