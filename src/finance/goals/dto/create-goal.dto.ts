import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Max,
  Min,
} from "class-validator";

export class CreateGoalDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  /** Minor units (paise). */
  @IsInt()
  @IsPositive()
  @Max(Number.MAX_SAFE_INTEGER)
  targetAmountMinor!: number;

  /**
   * A goal cannot start in debt. Without the floor a negative seed made
   * `percentUsed` negative and let a later deposit "climb back" to zero.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  currentAmountMinor?: number;

  /**
   * ISO-8601 rather than a free-form string: `new Date("tomorrow")` used to be
   * written straight into a DateTime column as Invalid Date and blow up as a 500.
   */
  @IsOptional()
  @IsDateString()
  targetDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  iconKey?: string;
}
