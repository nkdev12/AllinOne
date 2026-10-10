import { PartialType } from "@nestjs/swagger";
import { CreateRecurringDto } from "./create-recurring.dto";

export class UpdateRecurringDto extends PartialType(CreateRecurringDto) {}
