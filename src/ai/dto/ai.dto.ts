import {
  IsEnum,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsArray,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { SummaryFormat, SummaryLength, TaskPriority } from "../ai.interface";

export class SummarizeTextDto {
  @ApiPropertyOptional({
    example: "Meeting notes about our Q4 product roadmap...",
    description: "Raw text to summarize",
  })
  @IsOptional()
  @IsString()
  text?: string;

  @ApiPropertyOptional({
    example: "note-uuid-123",
    description: "ID of an existing note to summarize",
  })
  @IsOptional()
  @IsString()
  noteId?: string;

  @ApiPropertyOptional({
    enum: ["brief", "detailed", "bullet_points"],
    default: "brief",
  })
  @IsOptional()
  @IsEnum(["brief", "detailed", "bullet_points"])
  length?: SummaryLength = "brief";

  @ApiPropertyOptional({
    enum: ["paragraph", "bullet_points"],
    default: "paragraph",
  })
  @IsOptional()
  @IsEnum(["paragraph", "bullet_points"])
  format?: SummaryFormat = "paragraph";
}

export class ExtractTasksDto {
  @ApiPropertyOptional({
    example: "TODO: Review security checklist before Tuesday.",
    description: "Raw text to extract action items from",
  })
  @IsOptional()
  @IsString()
  text?: string;

  @ApiPropertyOptional({
    example: "note-uuid-123",
    description: "ID of an existing note to extract action items from",
  })
  @IsOptional()
  @IsString()
  noteId?: string;
}

export class SuggestTagsDto {
  @ApiPropertyOptional({
    example:
      "Kubernetes cluster configuration with ingress and TLS certificates",
  })
  @IsOptional()
  @IsString()
  text?: string;

  @ApiPropertyOptional({
    example: "note-uuid-123",
  })
  @IsOptional()
  @IsString()
  noteId?: string;
}

export class ExtractedTaskItemDto {
  @ApiProperty({ example: "Review database backup retention" })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiPropertyOptional({ example: "Follow up with devops team" })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: ["LOW", "MEDIUM", "HIGH"], default: "MEDIUM" })
  @IsOptional()
  @IsEnum(["LOW", "MEDIUM", "HIGH"])
  priority?: TaskPriority = "MEDIUM";

  @ApiPropertyOptional({ example: "2026-10-01T00:00:00.000Z" })
  @IsOptional()
  @IsString()
  dueDate?: string;
}

export class ConvertTasksDto {
  @ApiProperty({ type: [ExtractedTaskItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExtractedTaskItemDto)
  tasks!: ExtractedTaskItemDto[];
}
