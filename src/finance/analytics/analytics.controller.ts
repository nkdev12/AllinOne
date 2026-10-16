import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { AnalyticsService } from "./analytics.service";
import {
  CashFlowQueryDto,
  ExportTransactionsQueryDto,
  FinancialCalendarQueryDto,
  HealthCheckQueryDto,
  NetWorthQueryDto,
  SpendingByCategoryQueryDto,
} from "./dto/analytics-query.dto";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";

/**
 * The query objects replace loose `@Query("startDate")` strings, one of which
 * (`year`) the controller ran through `parseInt` before handing it to
 * `new Date(NaN, 0, 1)` — an Invalid Date that the database answered with a 500
 * for what was only a typo in the address bar.
 */
@ApiTags("Finance Analytics & Export")
@Controller("finance/analytics")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get("spending-by-category")
  @ApiOperation({
    summary: "Get spending breakdown by category for a date range",
  })
  @ApiResponse({ status: 200, description: "Category spending breakdown" })
  async getSpendingByCategory(
    @GetUser("id") userId: string,
    @Query() query: SpendingByCategoryQueryDto,
  ) {
    return this.analyticsService.getSpendingByCategory(
      userId,
      query.startDate,
      query.endDate,
      query.currency,
    );
  }

  @Get("cash-flow")
  @ApiOperation({
    summary: "Get monthly income, expense, and net savings for a year",
  })
  @ApiResponse({ status: 200, description: "Monthly cash flow" })
  async getCashFlow(
    @GetUser("id") userId: string,
    @Query() query: CashFlowQueryDto,
  ) {
    return this.analyticsService.getCashFlow(
      userId,
      query.year,
      query.currency,
    );
  }

  @Get("net-worth")
  @ApiOperation({ summary: "Get total net worth, assets, and liabilities" })
  @ApiResponse({ status: 200, description: "Net worth breakdown" })
  async getNetWorth(
    @GetUser("id") userId: string,
    @Query() query: NetWorthQueryDto,
  ) {
    return this.analyticsService.getNetWorth(userId, query.currency ?? "INR");
  }

  @Get("export")
  @ApiOperation({ summary: "Export transactions in CSV or JSON format" })
  @ApiResponse({ status: 200, description: "Exported transactions" })
  async exportTransactions(
    @GetUser("id") userId: string,
    @Query() query: ExportTransactionsQueryDto,
  ) {
    return this.analyticsService.exportTransactions(
      userId,
      query.format ?? "json",
      query.startDate,
      query.endDate,
      query.currency,
    );
  }

  @Get("health-check")
  @ApiOperation({
    summary: "Get comprehensive financial health checkup and indicators",
  })
  @ApiResponse({ status: 200, description: "Financial health overview" })
  async getFinancialHealthCheck(
    @GetUser("id") userId: string,
    @Query() query: HealthCheckQueryDto,
  ) {
    return this.analyticsService.getFinancialHealthCheck(
      userId,
      query.currency ?? "INR",
    );
  }

  @Get("calendar")
  @ApiOperation({
    summary:
      "Get monthly financial calendar with paydays, bills, and running balance",
  })
  @ApiResponse({ status: 200, description: "Financial calendar month schedule" })
  async getFinancialCalendar(
    @GetUser("id") userId: string,
    @Query() query: FinancialCalendarQueryDto,
  ) {
    return this.analyticsService.getFinancialCalendar(
      userId,
      query.year,
      query.month,
      query.currency ?? "INR",
    );
  }
}
