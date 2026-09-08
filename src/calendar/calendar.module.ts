import { Module } from "@nestjs/common";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { CalendarsService } from "./services/calendars.service";
import { EventsService } from "./services/events.service";
import { CalendarsController } from "./controllers/calendars.controller";
import { EventsController } from "./controllers/events.controller";

@Module({
  imports: [PrismaModule],
  controllers: [CalendarsController, EventsController],
  providers: [CalendarsService, EventsService],
  exports: [CalendarsService, EventsService],
})
export class CalendarModule {}
