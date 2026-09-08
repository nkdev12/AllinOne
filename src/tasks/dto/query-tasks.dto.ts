import { ApiPropertyOptional } from "@nestjs/swagger";
import { TaskPriority, TaskStatus } from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from "class-validator";

export class QueryTasksDto {
  @ApiPropertyOptional({
    example: "architecture",
    description: "Search term matching task title or description",
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    example: "123e4567-e89b-12d3-a456-426614174000",
    description: "Filter by Project UUID",
  })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({
    example: "123e4567-e89b-12d3-a456-426614174001",
    description: "Filter by Section UUID",
  })
  @IsOptional()
  @IsUUID()
  sectionId?: string;

  @ApiPropertyOptional({
    enum: TaskPriority,
    example: TaskPriority.P1_URGENT,
    description: "Filter by priority",
  })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiPropertyOptional({
    enum: TaskStatus,
    example: TaskStatus.TODO,
    description: "Filter by status",
  })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({
    example: false,
    description: "Filter by completion status",
  })
  @IsOptional()
  @Transform(({ value }) => value === "true" || value === true)
  @IsBoolean()
  isCompleted?: boolean;

  @ApiPropertyOptional({
    example: "2026-12-31T23:59:59.999Z",
    description: "Filter tasks due before timestamp",
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dueBefore?: Date;

  @ApiPropertyOptional({
    example: "2026-01-01T00:00:00.000Z",
    description: "Filter tasks due after timestamp",
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dueAfter?: Date;

  @ApiPropertyOptional({
    example: "123e4567-e89b-12d3-a456-426614174003",
    description: "Filter by Tag UUID",
  })
  @IsOptional()
  @IsUUID()
  tagId?: string;

  @ApiPropertyOptional({ example: 1, description: "Page number (default 1)" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    example: 20,
    description: "Page item limit (default 20, max 100)",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
