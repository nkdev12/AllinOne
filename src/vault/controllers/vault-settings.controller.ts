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
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary:
      "Verify master password authentication hash prior to client-side decryption",
  })
  @ApiResponse({
    status: 200,
    description: "Master password verification succeeded",
  })
  @ApiResponse({
    status: 401,
    description:
      "Invalid verification hash (`VAULT_MASTER_KEY_MISMATCH`), or the vault is " +
      "cooling down after repeated failures (`RATE_LIMITED`, with " +
      "`details.retryInSeconds`). The cooldown refuses the right password too, " +
      'so a client must not read this as "you mistyped it".',
  })
  @ApiResponse({
    status: 404,
    description: "The account has no vault yet (`VAULT_NOT_CONFIGURED`)",
  })
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
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @ApiOperation({
    summary:
      "Store the re-keyed master password parameters after re-encryption",
  })
  @ApiResponse({ status: 200, description: "Vault master password rotated" })
  @ApiResponse({
    status: 401,
    description:
      "No recovery grant is outstanding, or it expired " +
      "(`VAULT_RECOVERY_NOT_PENDING`). Verify a code again first.",
  })
  @ApiResponse({
    status: 400,
    description:
      "Recovery material is incomplete (`VALIDATION_ERROR` with the missing " +
      "fields) — a rotation that stores no new wrap would leave the previous, " +
      "now useless one in place.",
  })
  async completeRecovery(
    @GetUser("id") userId: string,
    @Body() dto: SetupVaultDto,
  ) {
    return this.settingsService.completeRecovery(userId, dto);
  }
}
