import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from "class-validator";

export class SetupVaultDto {
  @ApiProperty({
    example: "$argon2id$v=19$m=65536,t=3,p=4$salt$hash",
    description: "Client derived master key verification hash",
  })
  @IsString()
  @IsNotEmpty()
  masterKeyHash!: string;

  @ApiProperty({
    example: "c2FsdF9iYXNlNjRfc3RyaW5n",
    description: "Base64 encoded client salt for PBKDF2/Argon2",
  })
  @IsString()
  @IsNotEmpty()
  keySalt!: string;

  @ApiPropertyOptional({
    example: 100000,
    description: "KDF iterations or cost factor",
  })
  @IsOptional()
  @IsInt()
  @Min(1000)
  kdfIterations?: number;

  @ApiPropertyOptional({ example: 65536, description: "KDF memory cost in KB" })
  @IsOptional()
  @IsInt()
  @Min(1024)
  kdfMemory?: number;
}
