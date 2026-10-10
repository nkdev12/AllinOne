import { ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { CreateTripDto } from "./create-trip.dto";
import { IsBoolean, IsOptional } from "class-validator";

export class UpdateTripDto extends PartialType(CreateTripDto) {
  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isArchived?: boolean;
}
