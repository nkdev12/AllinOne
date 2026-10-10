import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
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
  interval?: number;

  @IsString()
  @IsNotEmpty()
  startDate!: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  autoGenerate?: boolean;
}
