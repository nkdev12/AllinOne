import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from "class-validator";
import { FinanceLoanType } from "@prisma/client";

export class UpdateLoanDto {
  @IsOptional()
  @IsEnum(FinanceLoanType)
  type?: FinanceLoanType;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  counterpartyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  counterpartyContact?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  principalAmountMinor?: number;

  /** Kept in step with the principal by the service, never above it. */
  @IsOptional()
  @IsInt()
  @Min(0)
  remainingAmountMinor?: number;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  /**
   * Optional override. When it is absent the flag is derived from the balance, so
   * a PATCH that only touches `notes` cannot leave a cleared loan flagged as
   * unpaid.
   */
  @IsOptional()
  @IsBoolean()
  isSettled?: boolean;
}
