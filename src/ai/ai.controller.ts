import {
  Controller,
  Post,
  Body,
  Param,
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
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { AiService } from "./ai.service";
import {
  ConvertTasksDto,
  ExtractTasksDto,
  SuggestTagsDto,
  SummarizeTextDto,
} from "./dto/ai.dto";

@ApiTags("AI")
@Controller("ai")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post("summarize")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Generate an intelligent summary of text or a saved note",
  })
  @ApiResponse({ status: 200, description: "Summary generated successfully" })
  @ApiResponse({ status: 400, description: "Missing text or noteId" })
  @ApiResponse({ status: 404, description: "Note not found" })
  async summarize(
    @GetUser("id") userId: string,
    @Body() dto: SummarizeTextDto,
  ) {
    return this.aiService.summarize(userId, dto);
  }

  @Post("extract-tasks")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Extract actionable TODOs and tasks with priority from text or note",
  })
  @ApiResponse({ status: 200, description: "Tasks extracted successfully" })
  @ApiResponse({ status: 404, description: "Note not found" })
  async extractTasks(
    @GetUser("id") userId: string,
    @Body() dto: ExtractTasksDto,
  ) {
    return this.aiService.extractTasks(userId, dto);
  }

  @Post("suggest-tags")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Suggest semantic tags and categories for text or note",
  })
  @ApiResponse({ status: 200, description: "Tags recommended successfully" })
  @ApiResponse({ status: 404, description: "Note not found" })
  async suggestTags(
    @GetUser("id") userId: string,
    @Body() dto: SuggestTagsDto,
  ) {
    return this.aiService.suggestTags(userId, dto);
  }

  @Post("notes/:noteId/convert-tasks")
  @ApiOperation({
    summary:
      "Convert a list of extracted action items directly into Task entities",
  })
  @ApiResponse({ status: 201, description: "Tasks created successfully" })
  @ApiResponse({ status: 404, description: "Note not found" })
  async convertTasksForNote(
    @GetUser("id") userId: string,
    @Param("noteId") noteId: string,
    @Body() dto: ConvertTasksDto,
  ) {
    return this.aiService.convertTasksForNote(userId, noteId, dto);
  }
}
