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
import { LoansService } from "./loans.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateLoanDto } from "./dto/create-loan.dto";
import { UpdateLoanDto } from "./dto/update-loan.dto";
import { RecordRepaymentDto } from "./dto/record-repayment.dto";
import { FinanceLoanType } from "@prisma/client";

@ApiTags("Finance Loans")
@Controller("finance/loans")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  @Post()
  @ApiOperation({ summary: "Create a new lent or borrowed loan" })
  @ApiResponse({ status: 201, description: "Loan created successfully" })
  async createLoan(@GetUser("id") userId: string, @Body() dto: CreateLoanDto) {
    return this.loansService.createLoan(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List all loans for user with optional filters" })
  @ApiQuery({ name: "type", enum: FinanceLoanType, required: false })
  @ApiQuery({ name: "isSettled", type: Boolean, required: false })
  @ApiResponse({ status: 200, description: "List of loans" })
  async getLoans(
    @GetUser("id") userId: string,
    @Query("type") type?: FinanceLoanType,
    @Query("isSettled") isSettled?: string,
  ) {
    const isSettledBool =
      isSettled === "true" ? true : isSettled === "false" ? false : undefined;
    return this.loansService.getLoans(userId, {
      type,
      isSettled: isSettledBool,
    });
  }

  @Get(":id")
  @ApiOperation({ summary: "Get loan details by ID" })
  @ApiResponse({ status: 200, description: "Loan details" })
  async getLoanById(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.loansService.getLoanById(userId, id);
  }

  @Post(":id/repayment")
  @ApiOperation({ summary: "Record a repayment towards a loan" })
  @ApiResponse({
    status: 200,
    description: "Repayment recorded, balance updated",
  })
  async recordRepayment(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RecordRepaymentDto,
  ) {
    return this.loansService.recordRepayment(userId, id, dto);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update loan details" })
  @ApiResponse({ status: 200, description: "Loan updated successfully" })
  async updateLoan(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateLoanDto,
  ) {
    return this.loansService.updateLoan(userId, id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft delete a loan" })
  @ApiResponse({ status: 200, description: "Loan deleted successfully" })
  async deleteLoan(
    @GetUser("id") userId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.loansService.deleteLoan(userId, id);
  }
}
