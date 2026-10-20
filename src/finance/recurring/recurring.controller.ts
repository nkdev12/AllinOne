import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { RecurringService } from "./recurring.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateRecurringDto } from "./dto/create-recurring.dto";
import { UpdateRecurringDto } from "./dto/update-recurring.dto";

@ApiTags("Finance Recurring Rules")
@Controller("finance/recurring")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class RecurringController {
  constructor(private readonly recurringService: RecurringService) {}

  @Post()
  @ApiOperation({ summary: "Create a new recurring rule" })
  @ApiResponse({
    status: 201,
    description: "Recurring rule created successfully",
  })
  async createRecurringRule(
    @GetUser("id") userId: string,
    @Body() dto: CreateRecurringDto,
  ) {
    return this.recurringService.createRecurringRule(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List all recurring rules for user" })
  @ApiResponse({ status: 200, description: "List of recurring rules" })
  async getRecurringRules(@GetUser("id") userId: string) {
    return this.recurringService.getRecurringRules(userId);
  }

  @Post("process-due")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Catch up this user's due recurring rules",
    description:
      "The explicit, per-user counterpart of the worker's daily catch-up tick, " +
      "and the one that may reach further back: it walks up to " +
      "MAX_CATCH_UP_OCCURRENCES occurrences per rule instead of stopping at the " +
      "cron's lookback window. Idempotent per (rule, due date), so calling it " +
      "twice — or while the worker is running — mints one transaction per " +
      "occurrence. `processed` counts the bills this call generated.",
  })
  @ApiResponse({ status: 200, description: "Processed count returned" })
  async processDueRules(@GetUser("id") userId: string) {
    return this.recurringService.processDueRulesForUser(userId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get recurring rule details by ID" })
  @ApiResponse({ status: 200, description: "Recurring rule details" })
  async getRecurringRuleById(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.recurringService.getRecurringRuleById(userId, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a recurring rule" })
  @ApiResponse({
    status: 200,
    description: "Recurring rule updated successfully",
  })
  async updateRecurringRule(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateRecurringDto,
  ) {
    return this.recurringService.updateRecurringRule(userId, id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft delete a recurring rule" })
  @ApiResponse({
    status: 200,
    description: "Recurring rule deleted successfully",
  })
  async deleteRecurringRule(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.recurringService.deleteRecurringRule(userId, id);
  }
}
