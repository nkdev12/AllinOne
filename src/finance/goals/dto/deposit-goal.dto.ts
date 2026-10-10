import { IsInt, IsPositive } from "class-validator";

export class DepositGoalDto {
  /**
   * Minor units added to the saved total. The service applies it as an atomic
   * `$inc`, so two of these landing at once both count.
   */
  @IsInt()
  @IsPositive()
  amountMinor!: number;
}
