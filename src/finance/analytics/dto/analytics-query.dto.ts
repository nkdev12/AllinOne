import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

/**
 * `GET /finance/analytics/*` query strings.
 *
 * Every parameter used to be a bare string the controller forwarded straight
 * into `new Date(...)` and `parseInt(...)`: `?startDate=now` became an Invalid
 * Date and reached the database as a 500, `?year=1e9` survived `parseInt`, and
 * `?limit=`-style oversize values had no ceiling anywhere. The DTO is where the
 * shape is decided once, so the service only has to defend its own arithmetic.
 */

const MAX_DATE_LENGTH = 40;

export class SpendingByCategoryQueryDto {
  @ApiPropertyOptional({ description: "ISO 8601 lower bound, UTC." })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_DATE_LENGTH)
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    description: "ISO 8601 upper bound, UTC. A bare date covers its whole day.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_DATE_LENGTH)
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({
    description:
      "Restrict the report to one ISO 4217 code. Omit it to get every currency the user has, per currency.",
    example: "INR",
  })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;
}

export class CashFlowQueryDto {
  @ApiPropertyOptional({
    minimum: 1970,
    maximum: 2100,
    description: "Calendar year, UTC (1 January 00:00Z to 31 December).",
  })
  @IsOptional()
  @Transform(({ value }) => (value === "" ? undefined : Number(value)))
  @IsInt()
  @Min(1970)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({ description: "ISO 4217 code filter, optional." })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;
}

export class NetWorthQueryDto {
  @ApiPropertyOptional({ description: "ISO 4217 code, defaults to INR." })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;
}

export class ExportTransactionsQueryDto extends SpendingByCategoryQueryDto {
  @ApiPropertyOptional({
    enum: ["json", "csv"],
    description: "Payload shape of the export (default json).",
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsIn(["json", "csv"])
  format?: "json" | "csv";
}

export class HealthCheckQueryDto {
  @ApiPropertyOptional({ description: "ISO 4217 code, defaults to INR." })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;
}

export class FinancialCalendarQueryDto {
  @ApiPropertyOptional({
    minimum: 1970,
    maximum: 2100,
    description: "Calendar year, defaults to current year.",
  })
  @IsOptional()
  @Transform(({ value }) => (value === "" ? undefined : Number(value)))
  @IsInt()
  @Min(1970)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 12,
    description: "Calendar month (1-12), defaults to current month.",
  })
  @IsOptional()
  @Transform(({ value }) => (value === "" ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @ApiPropertyOptional({ description: "ISO 4217 code, defaults to INR." })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;
}
