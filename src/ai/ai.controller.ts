import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { AiService } from "./ai.service";
import { ConvertTasksDto, ExtractTasksDto, SuggestTagsDto } from "./dto/ai.dto";

/**
 * Every route here parses a whole note and returns derived text, so one global
 * allowance (100 hits/minute) is an order of magnitude more CPU per user than
 * the reads it shares it with. The tiers below are per-account and deliberately
 * tighter than that default; `convert-tasks` is the tightest because it is the
 * only one that writes.
 */
const AI_READ_THROTTLE = { default: { limit: 20, ttl: 60_000 } };
const AI_WRITE_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@ApiTags("AI")
@Controller("ai")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post("extract-tasks")
  @HttpCode(HttpStatus.OK)
  @Throttle(AI_READ_THROTTLE)
  @ApiOperation({
    summary:
      "Extract actionable TODOs and tasks with priority from text or note",
  })
  @ApiResponse({ status: 200, description: "Tasks extracted successfully" })
  @ApiResponse({ status: 404, description: "Note not found" })
  @ApiResponse({ status: 429, description: "AI rate limit exceeded" })
  async extractTasks(
    @GetUser("id") userId: string,
    @Body() dto: ExtractTasksDto,
  ) {
    return this.aiService.extractTasks(userId, dto);
  }

  @Post("suggest-tags")
  @HttpCode(HttpStatus.OK)
  @Throttle(AI_READ_THROTTLE)
  @ApiOperation({
    summary: "Suggest semantic tags and categories for text or note",
  })
  @ApiResponse({ status: 200, description: "Tags recommended successfully" })
  @ApiResponse({ status: 404, description: "Note not found" })
  @ApiResponse({ status: 429, description: "AI rate limit exceeded" })
  async suggestTags(
    @GetUser("id") userId: string,
    @Body() dto: SuggestTagsDto,
  ) {
    return this.aiService.suggestTags(userId, dto);
  }

  @Post("notes/:noteId/convert-tasks")
  @Throttle(AI_WRITE_THROTTLE)
  @ApiOperation({
    summary:
      "Convert a list of extracted action items directly into Task entities",
  })
  @ApiResponse({ status: 201, description: "Tasks created successfully" })
  @ApiResponse({ status: 404, description: "Note not found" })
  @ApiResponse({ status: 429, description: "AI rate limit exceeded" })
  async convertTasksForNote(
    @GetUser("id") userId: string,
    @Param("noteId") noteId: string,
    @Body() dto: ConvertTasksDto,
  ) {
    return this.aiService.convertTasksForNote(userId, noteId, dto);
  }
}
