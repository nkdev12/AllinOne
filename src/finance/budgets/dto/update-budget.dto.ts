import { PartialType } from "@nestjs/swagger";
import { CreateBudgetDto } from "./create-budget.dto";

/**
 * `currency` is inherited with the same 3-letter rule, and it re-denominates the
 * cap: from the next read the budget is measured against expense rows in the new
 * code. Nothing converts the stored limit — hundredths stay hundredths.
 */
export class UpdateBudgetDto extends PartialType(CreateBudgetDto) {}
