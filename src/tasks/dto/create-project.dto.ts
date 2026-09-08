import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from "class-validator";

export class CreateProjectDto {
  @ApiProperty({ example: "Product Launch", description: "Project name" })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    example: "Tasks related to Q4 release",
    description: "Project description",
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: "#4CAF50",
    description: "Project badge color hex",
  })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({
    example: "rocket-launch",
    description: "Project icon string",
  })
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiPropertyOptional({
    example: 0,
    description: "Display sort order position",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
