import { PartialType } from "@nestjs/swagger";
import { CreateVaultItemDto } from "./create-vault-item.dto";

export class UpdateVaultItemDto extends PartialType(CreateVaultItemDto) {}
