import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ReminderChannel } from "@prisma/client";
import { Type } from "class-transformer";
import { IsDate, IsEnum, IsOptional } from "class-validator";

export class CreateReminderDto {
  @ApiProperty({
    example: "2026-10-01T09:00:00.000Z",
    description: "Reminder date/time",
  })
  @Type(() => Date)
  @IsDate()
  remindAt!: Date;

  @ApiPropertyOptional({
    enum: ReminderChannel,
    example: ReminderChannel.NOTIFICATION,
    description: "Delivery channel",
  })
  @IsOptional()
  @IsEnum(ReminderChannel)
  channel?: ReminderChannel;
}
