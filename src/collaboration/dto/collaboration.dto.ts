import {
  IsEnum,
  IsNotEmpty,
  IsString,
  IsEmail,
  IsOptional,
  IsInt,
  Min,
  Max,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ShareRole, ResourceType } from "../collaboration.interface";

export class CreateShareDto {
  @ApiProperty({
    enum: ["NOTE", "PROJECT", "CALENDAR"],
    example: "NOTE",
    description: "The type of resource being shared",
  })
  @IsEnum(["NOTE", "PROJECT", "CALENDAR"])
  @IsNotEmpty()
  resourceType!: ResourceType;

  @ApiProperty({
    example: "c7b3d8e0-5e8a-4b9c-8a1d-2e3f4a5b6c7d",
    description: "Unique identifier of the resource",
  })
  @IsString()
  @IsNotEmpty()
  resourceId!: string;

  @ApiProperty({
    example: "collaborator@example.com",
    description: "Email of the collaborator to share with",
  })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiProperty({
    enum: ["VIEWER", "EDITOR", "ADMIN"],
    example: "EDITOR",
    description: "Granted permission role",
  })
  @IsEnum(["VIEWER", "EDITOR", "ADMIN"])
  @IsNotEmpty()
  role!: ShareRole;
}

export class UpdateShareDto {
  @ApiProperty({
    enum: ["VIEWER", "EDITOR", "ADMIN"],
    example: "VIEWER",
    description: "New permission role for collaborator",
  })
  @IsEnum(["VIEWER", "EDITOR", "ADMIN"])
  @IsNotEmpty()
  role!: ShareRole;
}

export class QuerySharedResourcesDto {
  @ApiPropertyOptional({
    enum: ["NOTE", "PROJECT", "CALENDAR"],
    description: "Filter shared items by resource type",
  })
  @IsOptional()
  @IsEnum(["NOTE", "PROJECT", "CALENDAR"])
  resourceType?: ResourceType;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
