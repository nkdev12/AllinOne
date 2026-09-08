import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { NotesService } from "../services/notes.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateNoteDto } from "../dto/create-note.dto";
import { UpdateNoteDto } from "../dto/update-note.dto";
import { QueryNotesDto } from "../dto/query-notes.dto";

@ApiTags("Notes")
@Controller("notes")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Post()
  @ApiOperation({ summary: "Create a new note" })
  @ApiResponse({ status: 201, description: "Note created successfully" })
  async createNote(@GetUser("id") userId: string, @Body() dto: CreateNoteDto) {
    return this.notesService.createNote(userId, dto);
  }

  @Get()
  @ApiOperation({
    summary: "List and search user notes with pagination & filters",
  })
  @ApiResponse({ status: 200, description: "Paginated notes returned" })
  async getNotes(@GetUser("id") userId: string, @Query() query: QueryNotesDto) {
    return this.notesService.getNotes(userId, query);
  }

  @Get(":id")
  @ApiOperation({
    summary:
      "Get note details by ID (includes tags, folder, attachments, and history)",
  })
  @ApiResponse({ status: 200, description: "Note details returned" })
  @ApiResponse({ status: 404, description: "Note not found" })
  async getNoteById(
    @Param("id") noteId: string,
    @GetUser("id") userId: string,
  ) {
    return this.notesService.getNoteById(userId, noteId);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Update note content, title, folder, tags, pin/archive status",
  })
  @ApiResponse({ status: 200, description: "Note updated successfully" })
  @ApiResponse({ status: 404, description: "Note not found" })
  async updateNote(
    @Param("id") noteId: string,
    @GetUser("id") userId: string,
    @Body() dto: UpdateNoteDto,
  ) {
    return this.notesService.updateNote(userId, noteId, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft delete note" })
  @ApiResponse({ status: 200, description: "Note deleted" })
  @ApiResponse({ status: 404, description: "Note not found" })
  async deleteNote(@Param("id") noteId: string, @GetUser("id") userId: string) {
    return this.notesService.deleteNote(userId, noteId);
  }

  @Get(":id/history")
  @ApiOperation({ summary: "List version history snapshots for a note" })
  @ApiResponse({ status: 200, description: "Note history list returned" })
  @ApiResponse({ status: 404, description: "Note not found" })
  async getNoteHistory(
    @Param("id") noteId: string,
    @GetUser("id") userId: string,
  ) {
    return this.notesService.getNoteHistory(userId, noteId);
  }

  @Post(":id/history/:historyId/restore")
  @ApiOperation({ summary: "Restore a note to a previous version snapshot" })
  @ApiResponse({
    status: 200,
    description: "Note restored to snapshot version",
  })
  @ApiResponse({
    status: 404,
    description: "Note or history snapshot not found",
  })
  async restoreNoteHistory(
    @Param("id") noteId: string,
    @Param("historyId") historyId: string,
    @GetUser("id") userId: string,
  ) {
    return this.notesService.restoreNoteHistory(userId, noteId, historyId);
  }
}
