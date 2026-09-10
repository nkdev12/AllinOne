import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
  IsDateString,
} from "class-validator";
import { Type } from "class-transformer";
import { AuditAction, UserStatus } from "@prisma/client";

export class QueryAdminAuditLogsDto {
  @ApiPropertyOptional({ description: "Filter by user ID" })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({
    enum: AuditAction,
    description: "Filter by audit action",
  })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional({
    description: "Filter by resource type (e.g. User, Session)",
  })
  @IsOptional()
  @IsString()
  resourceType?: string;

  @ApiPropertyOptional({ description: "Filter from ISO datetime" })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: "Filter to ISO datetime" })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class UpdateUserStatusDto {
  @ApiProperty({ enum: UserStatus, example: UserStatus.SUSPENDED })
  @IsEnum(UserStatus)
  @IsNotEmpty()
  status!: UserStatus;

  @ApiPropertyOptional({
    description: "Administrative reason for status change",
  })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class AdminRevokeSessionsDto {
  @ApiPropertyOptional({
    description:
      "Reason for revoking user sessions (e.g., suspected compromise)",
    example: "Security incident response IR-2026-001",
  })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class AdminDisableMfaDto {
  @ApiProperty({
    description: "Required reason for disabling user MFA",
    example:
      "Identity verified via out-of-band video call support ticket #1234",
  })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

export class AdminUnlockUserDto {
  @ApiPropertyOptional({
    description: "Administrative reason for unlocking user account",
    example: "User identity confirmed via out-of-band support verification",
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
