import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export class SuggestAccountsQueryDto {
  @ApiPropertyOptional({
    example: "jane",
    description:
      "Partial name to look for, matched literally: regex metacharacters are escaped server-side because the MongoDB connector compiles this into $regex. Shorter than the endpoint's minimum prefix returns an empty list rather than an error.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;
}
