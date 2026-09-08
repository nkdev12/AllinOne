import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { VaultSettingsService } from "../services/vault-settings.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { SetupVaultDto } from "../dto/setup-vault.dto";
import { UnlockVaultDto } from "../dto/unlock-vault.dto";

@ApiTags("Vault Settings")
@Controller("vault/settings")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class VaultSettingsController {
  constructor(private readonly settingsService: VaultSettingsService) {}

  @Post("setup")
  @ApiOperation({
    summary:
      "Configure zero-knowledge master key parameters (salt, KDF iterations, verification hash)",
  })
  @ApiResponse({
    status: 201,
    description: "Vault configuration saved successfully",
  })
  @ApiResponse({
    status: 409,
    description: "Vault is already configured for account",
  })
  async setupVault(@GetUser("id") userId: string, @Body() dto: SetupVaultDto) {
    return this.settingsService.setupVault(userId, dto);
  }

  @Get()
  @ApiOperation({
    summary:
      "Get vault configuration parameters (salt, KDF parameters) for current user",
  })
  @ApiResponse({ status: 200, description: "Vault settings returned" })
  async getVaultSettings(@GetUser("id") userId: string) {
    return this.settingsService.getVaultSettings(userId);
  }

  @Post("unlock")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Verify master password authentication hash prior to client-side decryption",
  })
  @ApiResponse({
    status: 200,
    description: "Master password verification succeeded",
  })
  @ApiResponse({ status: 401, description: "Invalid verification hash" })
  async unlockVault(
    @GetUser("id") userId: string,
    @Body() dto: UnlockVaultDto,
  ) {
    return this.settingsService.unlockVault(userId, dto);
  }
}
