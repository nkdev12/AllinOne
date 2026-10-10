import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
} from "class-validator";
import { FinanceTransactionType } from "@prisma/client";

export class CreateTransactionDto {
  @ApiProperty({ description: "Source account UUID" })
  @IsUUID()
  @IsNotEmpty()
  accountId!: string;

  @ApiPropertyOptional({
    description: "Destination account UUID for transfers",
  })
  @IsOptional()
  @IsUUID()
  toAccountId?: string;

  @ApiPropertyOptional({ description: "Category UUID" })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({ enum: FinanceTransactionType })
  @IsEnum(FinanceTransactionType)
  type!: FinanceTransactionType;

  @ApiProperty({
    example: 50000,
    description: "Amount in minor currency units (paise/cents)",
  })
  @IsNumber()
  amountMinor!: number;

  @ApiPropertyOptional({ example: "INR", default: "INR" })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ example: "Supermarket shopping" })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ example: "2026-10-10T10:00:00.000Z" })
  @IsDateString()
  transactionDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiptAttachmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  recurringRuleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  sharedExpenseId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isExcludedFromBudget?: boolean;
}
