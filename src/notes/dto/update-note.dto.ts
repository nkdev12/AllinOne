import { PartialType, ApiPropertyOptional } from "@nestjs/swagger";
import { CreateNoteDto } from "./create-note.dto";
import { IsBoolean, IsOptional } from "class-validator";

export class UpdateNoteDto extends PartialType(CreateNoteDto) {
  @ApiPropertyOptional({ example: false, description: "Archive note" })
  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;
}
