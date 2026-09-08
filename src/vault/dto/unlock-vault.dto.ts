import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class UnlockVaultDto {
  @ApiProperty({
    example: "$argon2id$v=19$m=65536,t=3,p=4$salt$hash",
    description: "Client derived master key verification hash",
  })
  @IsString()
  @IsNotEmpty()
  masterKeyHash!: string;
}
