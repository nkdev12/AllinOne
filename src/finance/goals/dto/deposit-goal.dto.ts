import { IsInt, IsPositive } from "class-validator";

export class DepositGoalDto {
  @IsInt()
  @IsPositive()
  amountMinor!: number;
}
