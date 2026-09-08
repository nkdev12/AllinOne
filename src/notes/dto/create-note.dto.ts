import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from "class-validator";

export class CreateNoteDto {
  @ApiProperty({ example: "Sprint Planning Notes", description: "Note title" })
  @IsString()
  @IsNotEmpty()
  title!: string;

  @ApiPropertyOptional({
    example: "### Meeting Agenda\n- Discuss features\n- Assign tasks",
    description: "Rich text/markdown content",
  })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({
    example: "123e4567-e89b-12d3-a456-426614174000",
    description: "Folder UUID",
  })
  @IsOptional()
  @IsUUID()
  folderId?: string;

  @ApiPropertyOptional({
    example: ["123e4567-e89b-12d3-a456-426614174001"],
    description: "Array of tag UUIDs to associate",
  })
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  tagIds?: string[];

  @ApiPropertyOptional({
    example: false,
    description: "Pin note to top of list",
  })
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: "Mark payload as client encrypted",
  })
  @IsOptional()
  @IsBoolean()
  isEncrypted?: boolean;
}
