import { PartialType, ApiPropertyOptional } from "@nestjs/swagger";
import { CreateTaskDto } from "./create-task.dto";
import { IsBoolean, IsOptional } from "class-validator";

export class UpdateTaskDto extends PartialType(CreateTaskDto) {
  @ApiPropertyOptional({
    example: true,
    description: "Directly set task completion status",
  })
  @IsOptional()
  @IsBoolean()
  isCompleted?: boolean;
}
