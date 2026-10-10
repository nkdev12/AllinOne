import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from "class-validator";
import { FinanceLoanType } from "@prisma/client";

export class CreateLoanDto {
  @IsEnum(FinanceLoanType)
  @IsNotEmpty()
  type!: FinanceLoanType;

  @IsString()
  @IsNotEmpty()
  counterpartyName!: string;

  @IsOptional()
  @IsString()
  counterpartyContact?: string;

  @IsInt()
  @IsPositive()
  principalAmountMinor!: number;

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
}
