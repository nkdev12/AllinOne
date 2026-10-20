import { PartialType } from "@nestjs/swagger";
import { CreateSettlementDto } from "./create-settlement.dto";

/**
 * A settlement is money that already moved, so the editable surface is the
 * bookkeeping around it — the date it was recorded, the method, the notes, and
 * the amount/method corrections a phone makes when it miscoded a payment. The
 * same overdraft rule the CREATE applies is re-checked against the balances with
 * *this* row left out, so editing one payment cannot draw a debt below zero.
 */
export class UpdateSettlementDto extends PartialType(CreateSettlementDto) {}
