import { PartialType, ApiPropertyOptional } from "@nestjs/swagger";
import { CreateNoteDto } from "./create-note.dto";
import { IsBoolean, IsOptional, IsInt, Min } from "class-validator";

export class UpdateNoteDto extends PartialType(CreateNoteDto) {
  @ApiPropertyOptional({
    description: "Version being edited; stale edits return 409",
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @ApiPropertyOptional({ example: false, description: "Archive note" })
  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;
}
