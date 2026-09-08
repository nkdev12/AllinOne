import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export class UpdateDeviceDto {
  @ApiPropertyOptional({
    example: "My Work Laptop",
    description: "Updated device name",
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: "1.0.1", description: "Updated app version" })
  @IsOptional()
  @IsString()
  appVersion?: string;

  @ApiPropertyOptional({
    example: "updated_pubkey_xyz...",
    description: "Updated device public key",
  })
  @IsOptional()
  @IsString()
  publicKey?: string;
}
