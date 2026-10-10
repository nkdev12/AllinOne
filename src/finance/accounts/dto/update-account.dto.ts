import { PartialType } from "@nestjs/swagger";
import { CreateAccountDto } from "./create-account.dto";
import { IsBoolean, IsOptional } from "class-validator";

/**
 * `currency` is inherited, but `AccountsService.updateAccount` only lets it
 * change while the account is still empty and at its opening balance — see the
 * re-denomination guard there.
 */
export class UpdateAccountDto extends PartialType(CreateAccountDto) {
  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;
}
