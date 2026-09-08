import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString } from "class-validator";

export class CreateTagDto {
  @ApiProperty({ example: "work", description: "Unique tag name per user" })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    example: "#007ACC",
    description: "Hex color badge code",
  })
  @IsOptional()
  @IsString()
  color?: string;
}
