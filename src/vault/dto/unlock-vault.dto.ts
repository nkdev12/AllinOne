import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, IsOptional, Equals } from "class-validator";

export class UnlockVaultDto {
  @ApiProperty({
    example: "q7L1Z3mYxk1hZ8jH0lYXn0K8pQe1o2uW3r5t7y9b0cA=",
    description:
      "base64(SHA-256(argon2id(master password, keySalt))) — the verifier, not the key",
  })
  @IsString()
  @IsNotEmpty()
  masterKeyHash!: string;

  @IsOptional()
  @Equals(1)
  keyEnvelopeVersion?: number;
}
