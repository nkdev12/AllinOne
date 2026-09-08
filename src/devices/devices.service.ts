import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AuditLogService } from "@/common/audit/audit-log.service";
import { AuditAction } from "@prisma/client";
import { CreateDeviceDto } from "./dto/create-device.dto";
import { UpdateDeviceDto } from "./dto/update-device.dto";

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly auditLogService?: AuditLogService,
  ) {}

  async getDevicesByUser(userId: string) {
    return this.prisma.device.findMany({
      where: {
        userId,
        revokedAt: null,
      },
      orderBy: {
        lastSeenAt: "desc",
      },
    });
  }

  async getDeviceById(deviceId: string, userId: string) {
    const device = await this.prisma.device.findFirst({
      where: {
        id: deviceId,
        userId,
        revokedAt: null,
      },
    });

    if (!device) {
      throw new NotFoundException("Device not found or has been revoked");
    }

    return device;
  }

  async registerDevice(userId: string, dto: CreateDeviceDto) {
    const device = await this.prisma.device.create({
      data: {
        userId,
        name: dto.name,
        platform: dto.platform,
        appVersion: dto.appVersion,
        osVersion: dto.osVersion || null,
        publicKey: dto.publicKey || "",
        lastSeenAt: new Date(),
      },
    });

    await this.auditLogService?.recordAuditLog({
      userId,
      action: AuditAction.DEVICE_ADDED,
      resourceType: "Device",
      resourceId: device.id,
      metadata: { name: device.name, platform: device.platform },
    });

    return device;
  }

  async updateDevice(deviceId: string, userId: string, dto: UpdateDeviceDto) {
    await this.getDeviceById(deviceId, userId);

    return this.prisma.device.update({
      where: { id: deviceId },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.appVersion ? { appVersion: dto.appVersion } : {}),
        ...(dto.publicKey !== undefined ? { publicKey: dto.publicKey } : {}),
        lastSeenAt: new Date(),
      },
    });
  }

  async revokeDevice(deviceId: string, userId: string) {
    const device = await this.getDeviceById(deviceId, userId);

    // Revoke device and revoke all active sessions associated with this device
    const revokedDevice = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.device.update({
        where: { id: device.id },
        data: { revokedAt: new Date() },
      });

      await tx.session.updateMany({
        where: { deviceId: device.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      return updated;
    });

    await this.auditLogService?.recordAuditLog({
      userId,
      action: AuditAction.DEVICE_REVOKED,
      resourceType: "Device",
      resourceId: deviceId,
    });

    return revokedDevice;
  }
}
