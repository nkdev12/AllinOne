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
import { GoalsService } from "./goals.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateGoalDto } from "./dto/create-goal.dto";
import { DepositGoalDto } from "./dto/deposit-goal.dto";
import { UpdateGoalDto } from "./dto/update-goal.dto";

@ApiTags("Finance Goals")
@Controller("finance/goals")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class GoalsController {
  constructor(private readonly goalsService: GoalsService) {}

  @Post()
  @ApiOperation({ summary: "Create a new savings goal" })
  @ApiResponse({
    status: 201,
    description: "Savings goal created successfully",
  })
  async createGoal(@GetUser("id") userId: string, @Body() dto: CreateGoalDto) {
    return this.goalsService.createGoal(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List all savings goals for user" })
  @ApiResponse({ status: 200, description: "List of savings goals" })
  async getGoals(@GetUser("id") userId: string) {
    return this.goalsService.getGoals(userId);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get savings goal details by ID" })
  @ApiResponse({ status: 200, description: "Savings goal details" })
  async getGoalById(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.goalsService.getGoalById(userId, id);
  }

  @Post(":id/deposit")
  @ApiOperation({ summary: "Deposit funds to a savings goal" })
  @ApiResponse({ status: 200, description: "Goal balance updated" })
  async depositToGoal(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: DepositGoalDto,
  ) {
    return this.goalsService.depositToGoal(userId, id, dto);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a savings goal" })
  @ApiResponse({
    status: 200,
    description: "Savings goal updated successfully",
  })
  async updateGoal(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateGoalDto,
  ) {
    return this.goalsService.updateGoal(userId, id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft delete a savings goal" })
  @ApiResponse({ status: 200, description: "Goal deleted successfully" })
  async deleteGoal(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.goalsService.deleteGoal(userId, id);
  }
}
