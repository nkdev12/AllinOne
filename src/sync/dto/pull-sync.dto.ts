import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, IsUUID, Min } from "class-validator";

export class PullSyncDto {
  @ApiProperty({
    example: "123e4567-e89b-12d3-a456-426614174000",
    description: "ID of requesting device",
  })
  @IsUUID()
  deviceId!: string;

  @ApiPropertyOptional({
    example: "100",
    description: "Last pulled cursor position",
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    example: 100,
    description: "Batch limit of changes to return (default 100)",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}
