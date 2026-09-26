import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { VaultSettingsService } from "../services/vault-settings.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { SetupVaultDto, VerifyVaultRecoveryDto } from "../dto/setup-vault.dto";
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

  @Post("recovery/request")
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Email a single-use code that unlocks the vault recovery blob",
  })
  @ApiResponse({ status: 200, description: "Recovery code sent" })
  async requestRecovery(@GetUser("id") userId: string) {
    return this.settingsService.requestRecoveryOtp(userId);
  }

  @Post("recovery/verify")
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Spend a recovery code and return the wrapped master key",
  })
  @ApiResponse({ status: 200, description: "Recovery material returned" })
  @ApiResponse({ status: 401, description: "Invalid or expired recovery code" })
  async verifyRecovery(
    @GetUser("id") userId: string,
    @Body() dto: VerifyVaultRecoveryDto,
  ) {
    return this.settingsService.verifyRecoveryOtp(userId, dto.otp);
  }

  @Post("recovery/complete")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Store the re-keyed master password parameters after re-encryption",
  })
  @ApiResponse({ status: 200, description: "Vault master password rotated" })
  async completeRecovery(
    @GetUser("id") userId: string,
    @Body() dto: SetupVaultDto,
  ) {
    return this.settingsService.completeRecovery(userId, dto);
  }
}
