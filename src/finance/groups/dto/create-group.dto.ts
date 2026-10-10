import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsBoolean, ArrayMaxSize, ValidateNested, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class GroupMemberDto {
  @IsString() @IsNotEmpty() @MaxLength(100) id!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) name!: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateGroupDto {
  @ApiPropertyOptional({ type: [GroupMemberDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true })
  @Type(() => GroupMemberDto)
  members?: GroupMemberDto[];

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
