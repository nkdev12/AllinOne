import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { FinanceSplitType } from "@prisma/client";

export class ExpenseShareItemDto {
  @ApiProperty({ example: "user_uuid_or_name", description: "User ID or participant identifier" })
  @IsNotEmpty()
  @IsString()
  userId!: string;

  @ApiProperty({ example: 50000, description: "Owed amount in minor units" })
  @IsInt()
  @Min(0)
  owedAmountMinor!: number;

  @ApiPropertyOptional({ example: 1.0, description: "Share units or weight" })
  @IsOptional()
  @IsNumber()
  shareUnits?: number;
}

export class CreateSharedExpenseDto {
  @ApiProperty({ example: "Dinner at Fisherman's Wharf", description: "Title of shared expense" })
  @IsNotEmpty()
  @IsString()
  @MaxLength(150)
  title!: string;

  @ApiProperty({ example: 150000, description: "Total amount in minor units" })
  @IsInt()
  @Min(1)
  totalAmountMinor!: number;

  @ApiPropertyOptional({ example: "INR", default: "INR" })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @ApiProperty({ example: "user_uuid_payer", description: "User ID who paid" })
  @IsNotEmpty()
  @IsString()
  paidByUserId!: string;

  @ApiPropertyOptional({ example: "account_uuid", description: "Account used to pay" })
  @IsOptional()
  @IsString()
  payerAccountId?: string;

  @ApiPropertyOptional({ enum: FinanceSplitType, default: FinanceSplitType.EQUAL })
  @IsOptional()
  @IsEnum(FinanceSplitType)
  splitType?: FinanceSplitType;

  @ApiProperty({ example: "2026-10-10T19:30:00.000Z", description: "ISO Date" })
  @IsNotEmpty()
  @IsISO8601()
  date!: string;

  @ApiPropertyOptional({ example: "Seafood dinner", description: "Optional notes" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ description: "Receipt attachment ID" })
  @IsOptional()
  @IsString()
  receiptAttachmentId?: string;

  @ApiPropertyOptional({ description: "Optional trip ID if associated with a trip" })
  @IsOptional()
  @IsString()
  tripId?: string;

  @ApiProperty({ type: [ExpenseShareItemDto], description: "List of participant shares" })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExpenseShareItemDto)
  shares!: ExpenseShareItemDto[];
}
