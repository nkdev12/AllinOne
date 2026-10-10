import { PartialType } from "@nestjs/swagger";
import { CreateAccountDto } from "./create-account.dto";
import { IsBoolean, IsOptional } from "class-validator";

export class UpdateAccountDto extends PartialType(CreateAccountDto) {
  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;
}
