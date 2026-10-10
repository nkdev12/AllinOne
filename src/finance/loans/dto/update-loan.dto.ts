import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from "class-validator";
import { FinanceLoanType } from "@prisma/client";

export class UpdateLoanDto {
  @IsOptional()
  @IsEnum(FinanceLoanType)
  type?: FinanceLoanType;

  @IsOptional()
  @IsString()
  counterpartyName?: string;

  @IsOptional()
  @IsString()
  counterpartyContact?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  principalAmountMinor?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  remainingAmountMinor?: number;

  @IsOptional()
  @IsString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isSettled?: boolean;
}
