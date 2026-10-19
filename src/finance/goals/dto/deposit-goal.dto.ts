import { IsInt, IsPositive, Max } from "class-validator";

export class DepositGoalDto {
  /**
   * Minor units added to the saved total. The service applies it as an atomic
   * `$inc`, so two of these landing at once both count.
   */
  @IsInt()
  @IsPositive()
  @Max(Number.MAX_SAFE_INTEGER)
  amountMinor!: number;
}
