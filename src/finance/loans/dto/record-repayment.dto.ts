import { IsInt, IsPositive } from "class-validator";

export class RecordRepaymentDto {
  /**
   * Minor units paid back. Applied as an atomic `$dec` on the outstanding
   * balance, and rejected outright when it is larger than that balance: the old
   * code clamped the result to zero and the surplus disappeared.
   */
  @IsInt()
  @IsPositive()
  amountMinor!: number;
}
