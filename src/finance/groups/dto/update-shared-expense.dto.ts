import { PartialType } from "@nestjs/swagger";
import { CreateSharedExpenseDto } from "./create-shared-expense.dto";

/**
 * Every key is optional, which is what a split edit needs: the phone that only
 * moves one participant's amount must not resend — and so must not be forced to
 * guess — the title, the date or the payer.
 *
 * `shares` replaces the *live* split, not the row history: participants the list
 * no longer names are tombstoned, the ones it keeps are edited in place so their
 * ids and their `isSettled` flag survive, and only genuinely new participants
 * get a row. There is no `isSettled`/`settledAt` here on purpose — marking your
 * own share paid is a fact about the person who owes it, and an edit made by
 * somebody else's device must never be able to un-settle it.
 */
export class UpdateSharedExpenseDto extends PartialType(
  CreateSharedExpenseDto,
) {}
