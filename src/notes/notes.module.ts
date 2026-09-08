import { Module } from "@nestjs/common";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { FoldersService } from "./services/folders.service";
import { TagsService } from "./services/tags.service";
import { NotesService } from "./services/notes.service";
import { FoldersController } from "./controllers/folders.controller";
import { TagsController } from "./controllers/tags.controller";
import { NotesController } from "./controllers/notes.controller";

@Module({
  imports: [PrismaModule],
  controllers: [FoldersController, TagsController, NotesController],
  providers: [FoldersService, TagsService, NotesService],
  exports: [FoldersService, TagsService, NotesService],
})
export class NotesModule {}
