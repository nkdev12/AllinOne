import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsUUID,
  Max,
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
