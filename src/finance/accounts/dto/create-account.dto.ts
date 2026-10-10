import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { FinanceAccountType } from "@prisma/client";

export class CreateAccountDto {
  @ApiProperty({ example: "HDFC Salary", description: "Account name" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    enum: FinanceAccountType,
    default: FinanceAccountType.BANK,
  })
  @IsOptional()
  @IsEnum(FinanceAccountType)
  type?: FinanceAccountType;

  @ApiPropertyOptional({
    example: "INR",
    default: "INR",
    description:
      "ISO 4217 code. Stored upper-cased, so every money read can match it exactly.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  @Matches(/^[A-Za-z]{3}$/, {
    message: "currency must be a 3-letter ISO 4217 code, e.g. INR.",
  })
  currency?: string;

  @ApiPropertyOptional({
    example: 100000,
    description: "Opening balance in minor currency units (paise/cents)",
  })
  @IsOptional()
  @IsInt()
  @Min(Number.MIN_SAFE_INTEGER)
  @Max(Number.MAX_SAFE_INTEGER)
  openingBalanceMinor?: number;

  @ApiPropertyOptional({ example: "#4CAF50" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;

  @ApiPropertyOptional({ example: "landmark" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  iconKey?: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(-1000000)
  @Max(1000000)
  sortOrder?: number;
}
