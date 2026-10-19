import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { FinanceLoanType } from "@prisma/client";

export class CreateLoanDto {
  @IsEnum(FinanceLoanType)
  @IsNotEmpty()
  type!: FinanceLoanType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  counterpartyName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  counterpartyContact?: string;

  /** Minor units (paise) originally lent or borrowed. */
  @IsInt()
  @IsPositive()
  @Max(Number.MAX_SAFE_INTEGER)
  principalAmountMinor!: number;

  /**
   * Still outstanding. Defaults to the principal. It may not go negative and may
   * not exceed the principal: net worth sums this column into
   * `remainingBorrowedMinor`, so an unenforced pair inflated debt by whatever the
   * caller typed.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  remainingAmountMinor?: number;

  /**
   * ISO-8601: a free-form string used to reach `new Date()` and land Invalid Date
   * in a DateTime column as a 500.
   */
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
