import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from "class-validator";
import { FinanceAccountType } from "@prisma/client";

export class CreateAccountDto {
  @ApiProperty({ example: "HDFC Salary", description: "Account name" })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    enum: FinanceAccountType,
    default: FinanceAccountType.BANK,
  })
  @IsOptional()
  @IsEnum(FinanceAccountType)
  type?: FinanceAccountType;

  @ApiPropertyOptional({ example: "INR", default: "INR" })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({
    example: 100000,
    description: "Opening balance in minor currency units (paise/cents)",
  })
  @IsOptional()
  @IsNumber()
  openingBalanceMinor?: number;

  @ApiPropertyOptional({ example: "#4CAF50" })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({ example: "landmark" })
  @IsOptional()
  @IsString()
  iconKey?: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsNumber()
  sortOrder?: number;
}
