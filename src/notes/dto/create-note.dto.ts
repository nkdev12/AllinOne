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
    example: ["reading", "someday"],
    description:
      "Free-text label list, under the same key the sync payload uses. Distinct " +
      "from `tagIds`: those name rows in the account's `Tag` collection, while " +
      "these are the strings a device typed onto the note and no tag needs to " +
      "exist for. Neither is derived from the other.",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({
    example: "#FFD54F",
    description: "Note colour hex code",
  })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({
    example: "shopping",
    description:
      "Which of the desktop app's note formats this note is, by its stable key " +
      "(`normal`, `diary`, `shopping`, `bucket`, `quotes`) rather than the label " +
      "shown for it, so renaming one in the app is not a change here. Unknown " +
      "keys are accepted and render as a normal note, which is what lets a newer " +
      "app add a format without this server refusing its notes.",
  })
  @IsOptional()
  @IsString()
  noteType?: string;

  @ApiPropertyOptional({
    example:
      '{"rows":[{"id":"r1","item":"Bread","quantity":"1","purchased":false}]}',
    description:
      "The note's table as the client serialises it — JSON text, stored opaque. " +
      "Deliberately not parsed or re-shaped server-side: the shape belongs to " +
      "the app and evolves with it. Null and an empty document are different " +
      "values here (`a note with no table` and `a table the user cleared`), so " +
      "an omitted key means this caller is saying nothing about it.",
  })
  @IsOptional()
  @IsString()
  structured?: string;

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
