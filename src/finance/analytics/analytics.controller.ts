import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { AnalyticsService } from "./analytics.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";

@ApiTags("Finance Analytics & Export")
@Controller("finance/analytics")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @ApiQuery({ name: "currency", required: false, example: "INR" })
  @Get("spending-by-category")
  @ApiOperation({
    summary: "Get spending breakdown by category for a date range",
  })
  @ApiQuery({ name: "startDate", required: false, type: String })
  @ApiQuery({ name: "endDate", required: false, type: String })
  @ApiResponse({ status: 200, description: "Category spending breakdown" })
  async getSpendingByCategory(
    @GetUser("id") userId: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("currency") currency = "INR",
  ) {
    return this.analyticsService.getSpendingByCategory(
      userId,
      startDate,
      endDate,
      currency,
    );
  }

  @ApiQuery({ name: "currency", required: false, example: "INR" })
  @Get("cash-flow")
  @ApiOperation({
    summary: "Get monthly income, expense, and net savings for a year",
  })
  @ApiQuery({ name: "year", required: false, type: Number })
  @ApiResponse({ status: 200, description: "Monthly cash flow" })
  async getCashFlow(
    @GetUser("id") userId: string,
    @Query("year") year?: string,
    @Query("currency") currency = "INR",
  ) {
    const parsedYear = year ? parseInt(year, 10) : undefined;
    return this.analyticsService.getCashFlow(userId, parsedYear, currency);
  }

  @ApiQuery({ name: "currency", required: false, example: "INR" })
  @Get("net-worth")
  @ApiOperation({ summary: "Get total net worth, assets, and liabilities" })
  @ApiResponse({ status: 200, description: "Net worth breakdown" })
  async getNetWorth(
    @GetUser("id") userId: string,
    @Query("currency") currency = "INR",
  ) {
    return this.analyticsService.getNetWorth(userId, currency);
  }

  @Get("export")
  @ApiOperation({ summary: "Export transactions in CSV or JSON format" })
  @ApiQuery({ name: "format", required: false, enum: ["json", "csv"] })
  @ApiQuery({ name: "startDate", required: false, type: String })
  @ApiQuery({ name: "endDate", required: false, type: String })
  @ApiResponse({ status: 200, description: "Exported transactions" })
  async exportTransactions(
    @GetUser("id") userId: string,
    @Query("format") format: "json" | "csv" = "json",
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    return this.analyticsService.exportTransactions(
      userId,
      format,
      startDate,
      endDate,
    );
  }
}
