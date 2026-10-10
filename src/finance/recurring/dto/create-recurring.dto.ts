import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
} from "class-validator";
import {
  FinanceRecurringFrequency,
  FinanceTransactionType,
} from "@prisma/client";

export class CreateRecurringDto {
  @IsString()
  @IsNotEmpty()
  accountId!: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsEnum(FinanceTransactionType)
  type!: FinanceTransactionType;

  @IsInt()
  @IsPositive()
  @Min(1)
  // The service widens this with `BigInt(Math.round(...))`, which is only exact
  // up to `Number.MAX_SAFE_INTEGER`; above it the stored amount is already wrong
  // before the BigInt conversion.
  @Max(Number.MAX_SAFE_INTEGER)
  amountMinor!: number;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsOptional()
  @IsEnum(FinanceRecurringFrequency)
  frequency?: FinanceRecurringFrequency;

  @IsOptional()
  @IsInt()
  @IsPositive()
  @Min(1)
  @Max(1200)
  interval?: number;

  // `@IsString()` let `new Date(dto.startDate)` write an Invalid Date straight
  // into the rule, after which every due-date comparison silently returns false.
  @IsDateString()
  startDate!: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  autoGenerate?: boolean;
}
