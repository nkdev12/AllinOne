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
import { TransactionsService } from "./transactions.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";
import { QueryTransactionsDto } from "./dto/query-transaction.dto";

@ApiTags("Finance Transactions")
@Controller("finance/transactions")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post()
  @ApiOperation({ summary: "Create a finance transaction" })
  @ApiResponse({ status: 201, description: "Transaction created successfully" })
  async createTransaction(
    @GetUser("id") userId: string,
    @Body() dto: CreateTransactionDto,
  ) {
    return this.transactionsService.createTransaction(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List and filter transactions" })
  @ApiResponse({ status: 200, description: "Paginated list of transactions" })
  async getTransactions(
    @GetUser("id") userId: string,
    @Query() query: QueryTransactionsDto,
  ) {
    return this.transactionsService.getTransactions(userId, query);
  }

  @Get("summary/cashflow")
  @ApiOperation({ summary: "Get cash flow summary for a date range" })
  @ApiQuery({ name: "startDate", required: false })
  @ApiQuery({ name: "endDate", required: false })
  @ApiResponse({ status: 200, description: "Cash flow summary (income, expense, net)" })
  async getCashFlowSummary(
    @GetUser("id") userId: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    return this.transactionsService.getCashFlowSummary(userId, startDate, endDate);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get transaction details by ID" })
  @ApiResponse({ status: 200, description: "Transaction details" })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  async getTransactionById(
    @Param("id", ParseUUIDPipe) id: string,
    @GetUser("id") userId: string,
  ) {
    return this.transactionsService.getTransactionById(userId, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a finance transaction" })
  @ApiResponse({ status: 200, description: "Transaction updated successfully" })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  async updateTransaction(
    @Param("id", ParseUUIDPipe) id: string,
    @GetUser("id") userId: string,
    @Body() dto: UpdateTransactionDto,
  ) {
    return this.transactionsService.updateTransaction(userId, id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete a finance transaction" })
  @ApiResponse({ status: 200, description: "Transaction deleted" })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  async deleteTransaction(
    @Param("id", ParseUUIDPipe) id: string,
    @GetUser("id") userId: string,
  ) {
    return this.transactionsService.deleteTransaction(userId, id);
  }
}
