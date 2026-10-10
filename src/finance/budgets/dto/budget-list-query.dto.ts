import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsBoolean, IsInt, IsOptional, Max, Min } from "class-validator";

/**
 * `GET /finance/budgets` query string.
 *
 * These params used to be raw strings that the controller ran through
 * `parseInt` and handed straight to `Date.UTC`, so `?month=abc` reached a Prisma
 * date filter as an Invalid Date and `?month=13` rolled into the next January.
 * The window convention is 1-based and UTC: `month=1` is January, which is what
 * an HTTP caller (and the `?month=` this endpoint documents) actually means.
 */
export class BudgetListQueryDto {
  @ApiPropertyOptional({
    description: "Return each budget with its spend for the resolved window.",
    default: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === "true" || value === "1" || value === true)
  @IsBoolean()
  withSpending?: boolean;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 12,
    description: "Calendar month, 1-based and UTC (1 = January).",
  })
  @IsOptional()
  @Transform(({ value }) => (value === "" ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @ApiPropertyOptional({ minimum: 2000, maximum: 2100 })
  @IsOptional()
  @Transform(({ value }) => (value === "" ? undefined : Number(value)))
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
}
