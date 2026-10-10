import { PartialType } from "@nestjs/swagger";
import { CreateRecurringDto } from "./create-recurring.dto";

/**
 * Every field is optional, and the validators `CreateRecurringDto` carries —
 * ISO-8601 dates, `amountMinor` inside the safe-integer range, an `interval` of
 * at least one — apply per field that is actually sent.
 *
 * `accountId`/`categoryId` are only ids here: ownership is enforced in
 * `RecurringService.updateRecurringRule`, because the DTO has no way to tell one
 * user's documents from another's.
 */
export class UpdateRecurringDto extends PartialType(CreateRecurringDto) {}
