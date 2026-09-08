import { ApiPropertyOptional } from "@nestjs/swagger";
import { ReminderChannel } from "@prisma/client";
import { IsEnum, IsInt, IsOptional, Min } from "class-validator";

export class CreateEventReminderDto {
  @ApiPropertyOptional({
    example: 15,
    description: "Minutes before event start time",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  minutesBefore?: number;

  @ApiPropertyOptional({
    enum: ReminderChannel,
    example: ReminderChannel.NOTIFICATION,
    description: "Notification channel",
  })
  @IsOptional()
  @IsEnum(ReminderChannel)
  channel?: ReminderChannel;
}
