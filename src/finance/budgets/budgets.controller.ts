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
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { BudgetsService } from "./budgets.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateBudgetDto } from "./dto/create-budget.dto";
import { UpdateBudgetDto } from "./dto/update-budget.dto";

@ApiTags("Finance Budgets")
@Controller("finance/budgets")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class BudgetsController {
  constructor(private readonly budgetsService: BudgetsService) {}

  @Post()
  @ApiOperation({ summary: "Create a new finance budget" })
  @ApiResponse({ status: 201, description: "Budget created successfully" })
  async createBudget(
    @GetUser("id") userId: string,
    @Body() dto: CreateBudgetDto,
  ) {
    return this.budgetsService.createBudget(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List all budgets or with spending tracking" })
  @ApiQuery({ name: "withSpending", required: false, type: Boolean })
  @ApiQuery({ name: "month", required: false, type: Number })
  @ApiQuery({ name: "year", required: false, type: Number })
  @ApiResponse({ status: 200, description: "List of budgets" })
  async getBudgets(
    @GetUser("id") userId: string,
    @Query("withSpending") withSpending?: string,
    @Query("month") month?: string,
    @Query("year") year?: string,
  ) {
    if (withSpending === "true") {
      const parsedMonth = month !== undefined ? parseInt(month, 10) : undefined;
      const parsedYear = year !== undefined ? parseInt(year, 10) : undefined;
      return this.budgetsService.getBudgetsWithSpending(
        userId,
        parsedMonth,
        parsedYear,
      );
    }
    return this.budgetsService.getBudgets(userId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get budget details by ID" })
  @ApiResponse({ status: 200, description: "Budget details" })
  async getBudgetById(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.budgetsService.getBudgetById(userId, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a budget" })
  @ApiResponse({ status: 200, description: "Budget updated successfully" })
  async updateBudget(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateBudgetDto,
  ) {
    return this.budgetsService.updateBudget(userId, id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft delete a budget" })
  @ApiResponse({ status: 200, description: "Budget deleted successfully" })
  async deleteBudget(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.budgetsService.deleteBudget(userId, id);
  }
}
