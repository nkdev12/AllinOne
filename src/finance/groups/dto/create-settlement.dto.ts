import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";

export class CreateSettlementDto {
  @ApiProperty({
    example: "user_a",
    description: "User ID paying the settlement",
  })
  @IsNotEmpty()
  @IsString()
  fromUserId!: string;

  @ApiProperty({
    example: "user_b",
    description: "User ID receiving the settlement",
  })
  @IsNotEmpty()
  @IsString()
  toUserId!: string;

  @ApiProperty({
    example: 50000,
    description: "Settlement amount in minor units",
  })
  @IsInt()
  @Min(1)
  amountMinor!: number;

  @ApiPropertyOptional({ example: "INR", default: "INR" })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @ApiProperty({
    example: "2026-10-10T20:00:00.000Z",
    description: "Date of settlement",
  })
  @IsNotEmpty()
  @IsISO8601()
  date!: string;

  @ApiPropertyOptional({
    example: "Settled via GPay",
    description: "Optional notes",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    example: "UPI",
    description: "Payment method (UPI, Cash, etc.)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  paymentMethod?: string;

  @ApiPropertyOptional({
    description: "Optional trip ID if associated with a trip",
  })
  @IsOptional()
  @IsString()
  tripId?: string;
}
