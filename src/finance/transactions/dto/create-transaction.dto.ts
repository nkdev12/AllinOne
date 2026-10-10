import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
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
    description:
      "Amount in minor currency units (paise/cents). Whole number, never a float or Infinity — those would break the BigInt column.",
  })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountMinor!: number;

  @ApiPropertyOptional({
    example: "INR",
    default: "INR",
    description:
      "ISO 4217 code; must equal the account's. Stored upper-cased so money reads can match it exactly.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  @Matches(/^[A-Za-z]{3}$/, {
    message: "currency must be a 3-letter ISO 4217 code, e.g. INR.",
  })
  currency?: string;

  @ApiProperty({ example: "Supermarket shopping" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
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
