import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateGroupDto {
  @ApiProperty({ example: "Goa Trip 2026", description: "Name of the group" })
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    example: "Expenses shared for Goa vacation",
    description: "Optional description",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: "INR", default: "INR" })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @ApiPropertyOptional({ example: "palmtree", description: "Icon identifier" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  iconKey?: string;
}
