import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { TaskPriority, TaskStatus } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
} from "class-validator";

export class CreateTaskDto {
  @ApiProperty({
    example: "Finalize Architecture Document",
    description: "Task title",
  })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiPropertyOptional({
    example: "Review diagrams and get sign-off from tech lead",
    description: "Detailed task description",
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: "123e4567-e89b-12d3-a456-426614174000",
    description: "Associated Project UUID",
  })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({
    example: "123e4567-e89b-12d3-a456-426614174001",
    description: "Associated Section UUID",
  })
  @IsOptional()
  @IsUUID()
  sectionId?: string;

  @ApiPropertyOptional({
    example: "123e4567-e89b-12d3-a456-426614174002",
    description: "Parent Task UUID for subtasks",
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({
    enum: TaskPriority,
    example: TaskPriority.P1_URGENT,
    description: "Task priority level",
  })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiPropertyOptional({
    enum: TaskStatus,
    example: TaskStatus.TODO,
    description: "Task status",
  })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({
    example: "2026-10-01T00:00:00.000Z",
    description: "Due date",
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dueDate?: Date;

  @ApiPropertyOptional({
    example: "14:30",
    description: "Due time in HH:mm format",
  })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: "dueTime must be in HH:mm format",
  })
  dueTime?: string;

  @ApiPropertyOptional({
    example: "FREQ=WEEKLY;BYDAY=MO",
    description: "RRULE recurrence rule string",
  })
  @IsOptional()
  @IsString()
  recurrenceRule?: string;

  @ApiPropertyOptional({
    example: ["123e4567-e89b-12d3-a456-426614174003"],
    description: "Tag UUIDs to label task",
  })
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  tagIds?: string[];

  @ApiPropertyOptional({
    example: 0,
    description: "Display sort order position",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
