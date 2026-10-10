import { PartialType } from "@nestjs/swagger";
import { CreateItineraryItemDto } from "./create-itinerary-item.dto";

export class UpdateItineraryItemDto extends PartialType(CreateItineraryItemDto) {}
