import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
} from "class-validator";
import { FinanceBudgetPeriod } from "@prisma/client";

export class CreateBudgetDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  /** Minor units (paise), never a float amount. */
  @IsInt()
  @IsPositive()
  @Max(Number.MAX_SAFE_INTEGER)
  amountMinor!: number;

  /**
   * The currency the cap is written in. Same strict rule as
   * `create-account.dto.ts`: an ISO 4217 code is three letters, so `"RUPEES"` or
   * `"EURODOLLAR"` is a typo and not a budget. `BudgetsService` upper-cases it on
   * write and sums spend only over expense rows carrying that code, so an omitted
   * value means the schema default (`INR`) rather than "any currency".
   */
  @IsOptional()
  @IsString()
  @MaxLength(3)
  @Matches(/^[A-Za-z]{3}$/, {
    message: "currency must be a 3-letter ISO 4217 code, e.g. INR.",
  })
  currency?: string;

  @IsOptional()
  @IsEnum(FinanceBudgetPeriod)
  period?: FinanceBudgetPeriod;

  /**
   * ISO-8601, validated rather than handed to `new Date()`: a junk string used
   * to become an Invalid Date column and a 500. For CUSTOM the pair is the
   * budget's window; for every other period it clamps the derived cycle.
   */
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  alertAt80?: boolean;

  @IsOptional()
  @IsBoolean()
  alertAt100?: boolean;
}
