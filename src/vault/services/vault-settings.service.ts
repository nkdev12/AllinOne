import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SetupVaultDto } from "../dto/setup-vault.dto";
import { UnlockVaultDto } from "../dto/unlock-vault.dto";

@Injectable()
export class VaultSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async setupVault(userId: string, dto: SetupVaultDto) {
    const existing = await this.prisma.vaultSetting.findUnique({
      where: { userId },
    });

    if (existing && existing.isVaultConfigured) {
      throw new ConflictException(
        "Password vault is already configured for this account.",
      );
    }

    const vaultSetting = await this.prisma.vaultSetting.upsert({
      where: { userId },
      create: {
        userId,
        masterKeyHash: dto.masterKeyHash,
        keySalt: dto.keySalt,
        kdfIterations: dto.kdfIterations ?? 100000,
        kdfMemory: dto.kdfMemory ?? 65536,
        isVaultConfigured: true,
      },
      update: {
        masterKeyHash: dto.masterKeyHash,
        keySalt: dto.keySalt,
        kdfIterations: dto.kdfIterations ?? 100000,
        kdfMemory: dto.kdfMemory ?? 65536,
        isVaultConfigured: true,
      },
    });

    return {
      isVaultConfigured: vaultSetting.isVaultConfigured,
      keySalt: vaultSetting.keySalt,
      kdfIterations: vaultSetting.kdfIterations,
      kdfMemory: vaultSetting.kdfMemory,
      updatedAt: vaultSetting.updatedAt,
    };
  }

  async getVaultSettings(userId: string) {
    const setting = await this.prisma.vaultSetting.findUnique({
      where: { userId },
    });

    if (!setting) {
      return {
        isVaultConfigured: false,
        keySalt: null,
        kdfIterations: null,
        kdfMemory: null,
      };
    }

    return {
      isVaultConfigured: setting.isVaultConfigured,
      keySalt: setting.keySalt,
      kdfIterations: setting.kdfIterations,
      kdfMemory: setting.kdfMemory,
      updatedAt: setting.updatedAt,
    };
  }

  async unlockVault(userId: string, dto: UnlockVaultDto) {
    const setting = await this.prisma.vaultSetting.findUnique({
      where: { userId },
    });

    if (!setting || !setting.isVaultConfigured) {
      throw new NotFoundException(
        "Password vault has not been configured yet.",
      );
    }

    if (setting.masterKeyHash !== dto.masterKeyHash) {
      throw new UnauthorizedException(
        "Invalid master password verification key.",
      );
    }

    return {
      success: true,
      unlockedAt: new Date(),
    };
  }
}
