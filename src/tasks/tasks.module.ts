import { Module } from "@nestjs/common";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { ProjectsService } from "./services/projects.service";
import { TasksService } from "./services/tasks.service";
import { RemindersService } from "./services/reminders.service";
import { ProjectsController } from "./controllers/projects.controller";
import { TasksController } from "./controllers/tasks.controller";

@Module({
  imports: [PrismaModule],
  controllers: [ProjectsController, TasksController],
  providers: [ProjectsService, TasksService, RemindersService],
  exports: [ProjectsService, TasksService, RemindersService],
})
export class TasksModule {}
