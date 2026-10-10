import { IsInt, IsPositive } from "class-validator";

export class RecordRepaymentDto {
  @IsInt()
  @IsPositive()
  amountMinor!: number;
}
