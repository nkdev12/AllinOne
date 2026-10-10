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
import { GroupsService } from "./groups.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateGroupDto } from "./dto/create-group.dto";
import { UpdateGroupDto } from "./dto/update-group.dto";
import { CreateSharedExpenseDto } from "./dto/create-shared-expense.dto";
import { CreateSettlementDto } from "./dto/create-settlement.dto";

@ApiTags("Finance Groups & Split")
@Controller("finance/groups")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @Post()
  @ApiOperation({ summary: "Create a new expense group" })
  @ApiResponse({ status: 201, description: "Group created successfully" })
  async createGroup(
    @GetUser("id") userId: string,
    @Body() dto: CreateGroupDto,
  ) {
    return this.groupsService.createGroup(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List all expense groups for user" })
  @ApiQuery({ name: "includeArchived", required: false, type: Boolean })
  @ApiResponse({ status: 200, description: "List of groups" })
  async getGroups(
    @GetUser("id") userId: string,
    @Query("includeArchived") includeArchived?: string,
  ) {
    return this.groupsService.getGroups(userId, includeArchived === "true");
  }

  @Get(":id")
  @ApiOperation({ summary: "Get expense group details by ID" })
  @ApiResponse({ status: 200, description: "Group details" })
  @ApiResponse({ status: 404, description: "Group not found" })
  async getGroupById(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.groupsService.getGroupById(userId, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update an expense group" })
  @ApiResponse({ status: 200, description: "Group updated successfully" })
  @ApiResponse({ status: 404, description: "Group not found" })
  async updateGroup(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.groupsService.updateGroup(userId, id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete an expense group (soft delete)" })
  @ApiResponse({ status: 204, description: "Group deleted successfully" })
  @ApiResponse({ status: 404, description: "Group not found" })
  async deleteGroup(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.groupsService.deleteGroup(userId, id);
  }

  // -------------------------------------------------------------
  // Shared Expenses
  // -------------------------------------------------------------

  @Post(":id/expenses")
  @ApiOperation({ summary: "Add a shared expense to group" })
  @ApiResponse({ status: 201, description: "Shared expense added" })
  async addSharedExpense(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) groupId: string,
    @Body() dto: CreateSharedExpenseDto,
  ) {
    return this.groupsService.addSharedExpense(userId, groupId, dto);
  }

  @Get(":id/expenses")
  @ApiOperation({ summary: "List shared expenses in group" })
  @ApiResponse({ status: 200, description: "List of shared expenses" })
  async getSharedExpenses(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) groupId: string,
  ) {
    return this.groupsService.getSharedExpenses(userId, groupId);
  }

  @Delete(":id/expenses/:expenseId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete a shared expense" })
  @ApiResponse({ status: 204, description: "Shared expense deleted" })
  async deleteSharedExpense(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) groupId: string,
    @Param("expenseId", ParseUUIDPipe) expenseId: string,
  ) {
    return this.groupsService.deleteSharedExpense(userId, groupId, expenseId);
  }

  // -------------------------------------------------------------
  // Settlements
  // -------------------------------------------------------------

  @Post(":id/settlements")
  @ApiOperation({ summary: "Record a settlement payment between members" })
  @ApiResponse({ status: 201, description: "Settlement recorded" })
  async createSettlement(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) groupId: string,
    @Body() dto: CreateSettlementDto,
  ) {
    return this.groupsService.createSettlement(userId, groupId, dto);
  }

  @Get(":id/settlements")
  @ApiOperation({ summary: "List settlements in group" })
  @ApiResponse({ status: 200, description: "List of settlements" })
  async getSettlements(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) groupId: string,
  ) {
    return this.groupsService.getSettlements(userId, groupId);
  }

  @Delete(":id/settlements/:settlementId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete a settlement" })
  @ApiResponse({ status: 204, description: "Settlement deleted" })
  async deleteSettlement(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) groupId: string,
    @Param("settlementId", ParseUUIDPipe) settlementId: string,
  ) {
    return this.groupsService.deleteSettlement(userId, groupId, settlementId);
  }

  // -------------------------------------------------------------
  // Balances & Debt Simplifier
  // -------------------------------------------------------------

  @Get(":id/balances")
  @ApiOperation({ summary: "Get net balances and Min-Cash-Flow simplified settlements" })
  @ApiResponse({ status: 200, description: "Net balances & simplified debts" })
  async getGroupBalancesAndSimplifiedDebts(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) groupId: string,
  ) {
    return this.groupsService.getGroupBalancesAndSimplifiedDebts(userId, groupId);
  }
}
