import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
} from "class-validator";
import { FinanceBudgetPeriod } from "@prisma/client";

export class CreateBudgetDto {
  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsInt()
  @IsPositive()
  amountMinor!: number;

  @IsOptional()
  @IsEnum(FinanceBudgetPeriod)
  period?: FinanceBudgetPeriod;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  alertAt80?: boolean;

  @IsOptional()
  @IsBoolean()
  alertAt100?: boolean;
}
