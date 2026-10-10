import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from "class-validator";
import { FinanceTransactionType } from "@prisma/client";

export class CreateCategoryDto {
  @ApiProperty({ example: "Groceries", description: "Category display name" })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    enum: FinanceTransactionType,
    default: FinanceTransactionType.EXPENSE,
  })
  @IsOptional()
  @IsEnum(FinanceTransactionType)
  type?: FinanceTransactionType;

  @ApiPropertyOptional({ example: "shopping-cart" })
  @IsOptional()
  @IsString()
  iconKey?: string;

  @ApiPropertyOptional({ example: "#FF9800" })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({ description: "Parent category UUID" })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}
