import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from "class-validator";

export class CreateSectionDto {
  @ApiProperty({
    example: "123e4567-e89b-12d3-a456-426614174000",
    description: "Parent Project UUID",
  })
  @IsUUID()
  projectId!: string;

  @ApiProperty({ example: "In Progress", description: "Section column title" })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ example: 0, description: "Column sort position" })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
