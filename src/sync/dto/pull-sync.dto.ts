import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";

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
    maximum: 500,
    description: "Batch limit of changes to return (default 100, max 500)",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  // The page size is read straight into `take: limit + 1`, so an unbounded
  // `limit` was a request to materialise the whole change log in one response —
  // finance payloads are allowed up to 64 KiB each, so `limit=100000000` is a
  // one-request OOM rather than a page. The service clamps the same ceiling,
  // which is what stops a stale client from being 400-ed by this bound alone.
  @Max(500)
  limit?: number;
}
