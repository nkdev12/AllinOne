import { ApiPropertyOptional } from "@nestjs/swagger";
import { VaultItemType } from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";

export class QueryVaultItemsDto {
  @ApiPropertyOptional({
    example: "GitHub",
    description: "Search term matching item name or category",
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    enum: VaultItemType,
    example: VaultItemType.LOGIN,
    description: "Filter by item type",
  })
  @IsOptional()
  @IsEnum(VaultItemType)
  type?: VaultItemType;

  @ApiPropertyOptional({
    example: "Developer Tools",
    description: "Filter by category name",
  })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ example: true, description: "Filter favorites" })
  @IsOptional()
  @Transform(({ value }) => value === "true" || value === true)
  @IsBoolean()
  isFavorite?: boolean;

  @ApiPropertyOptional({ example: 1, description: "Page number (default 1)" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    example: 50,
    description: "Page item limit (default 50, max 200)",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}
