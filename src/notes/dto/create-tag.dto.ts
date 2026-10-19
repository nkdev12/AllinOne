import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateTagDto {
  @ApiProperty({ example: "work", description: "Unique tag name per user" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({
    example: "#007ACC",
    description: "Hex color badge code",
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  color?: string;
}
