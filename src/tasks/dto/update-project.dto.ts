import { PartialType, ApiPropertyOptional } from "@nestjs/swagger";
import { CreateProjectDto } from "./create-project.dto";
import { IsBoolean, IsOptional } from "class-validator";

export class UpdateProjectDto extends PartialType(CreateProjectDto) {
  @ApiPropertyOptional({
    example: false,
    description: "Archive project status",
  })
  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;
}
