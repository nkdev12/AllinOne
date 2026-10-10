import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
} from "class-validator";

export class CreateGoalDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsInt()
  @IsPositive()
  targetAmountMinor!: number;

  @IsOptional()
  @IsInt()
  currentAmountMinor?: number;

  @IsOptional()
  @IsString()
  targetDate?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsString()
  iconKey?: string;
}
