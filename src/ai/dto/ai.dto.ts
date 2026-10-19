import {
  ArrayMaxSize,
  IsEnum,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsArray,
  IsDateString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { TaskPriority } from "../ai.interface";

/**
 * `convertTasksForNote` writes one `Task` row and one `Change` row per item, all
 * of it inside a single `$transaction`, and each change is replayed to every
 * other device of the account for the life of the log. A capped list keeps one
 * request from allocating that much of both the collection and the change log.
 */
export const MAX_TASKS_PER_CONVERSION = 50;

export class ExtractTasksDto {
  @ApiPropertyOptional({
    example: "TODO: Review security checklist before Tuesday.",
    description: "Raw text to extract action items from",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  text?: string;

  @ApiPropertyOptional({
    example: "note-uuid-123",
    description: "ID of an existing note to extract action items from",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  noteId?: string;
}

export class SuggestTagsDto {
  @ApiPropertyOptional({
    example:
      "Kubernetes cluster configuration with ingress and TLS certificates",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  text?: string;

  @ApiPropertyOptional({
    example: "note-uuid-123",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  noteId?: string;
}

class ExtractedTaskItemDto {
  @ApiProperty({ example: "Review database backup retention" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ example: "Follow up with devops team" })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ enum: ["LOW", "MEDIUM", "HIGH"], default: "MEDIUM" })
  @IsOptional()
  @IsEnum(["LOW", "MEDIUM", "HIGH"])
  priority?: TaskPriority = "MEDIUM";

  @ApiPropertyOptional({ example: "2026-10-01T00:00:00.000Z" })
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

export class ConvertTasksDto {
  @ApiProperty({ type: [ExtractedTaskItemDto] })
  @IsArray()
  @ArrayMaxSize(MAX_TASKS_PER_CONVERSION, {
    message: `a conversion may carry at most ${MAX_TASKS_PER_CONVERSION} tasks`,
  })
  @ValidateNested({ each: true })
  @Type(() => ExtractedTaskItemDto)
  tasks!: ExtractedTaskItemDto[];
}
