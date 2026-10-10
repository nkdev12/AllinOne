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
import { AccountsService } from "./accounts.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateAccountDto } from "./dto/create-account.dto";
import { UpdateAccountDto } from "./dto/update-account.dto";

@ApiTags("Finance Accounts")
@Controller("finance/accounts")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Post()
  @ApiOperation({ summary: "Create a new finance account" })
  @ApiResponse({ status: 201, description: "Account created successfully" })
  async createAccount(
    @GetUser("id") userId: string,
    @Body() dto: CreateAccountDto,
  ) {
    return this.accountsService.createAccount(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List all finance accounts for user" })
  @ApiQuery({ name: "includeArchived", required: false, type: Boolean })
  @ApiResponse({ status: 200, description: "List of accounts" })
  async getAccounts(
    @GetUser("id") userId: string,
    @Query("includeArchived") includeArchived?: string,
  ) {
    return this.accountsService.getAccounts(userId, includeArchived === "true");
  }

  @Get(":id")
  @ApiOperation({ summary: "Get finance account details by ID" })
  @ApiResponse({ status: 200, description: "Account details returned" })
  @ApiResponse({ status: 404, description: "Account not found" })
  async getAccountById(
    @Param("id", ParseUUIDPipe) id: string,
    @GetUser("id") userId: string,
  ) {
    return this.accountsService.getAccountById(userId, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a finance account" })
  @ApiResponse({ status: 200, description: "Account updated successfully" })
  @ApiResponse({ status: 404, description: "Account not found" })
  async updateAccount(
    @Param("id", ParseUUIDPipe) id: string,
    @GetUser("id") userId: string,
    @Body() dto: UpdateAccountDto,
  ) {
    return this.accountsService.updateAccount(userId, id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft delete a finance account" })
  @ApiResponse({ status: 200, description: "Account deleted" })
  @ApiResponse({ status: 404, description: "Account not found" })
  async deleteAccount(
    @Param("id", ParseUUIDPipe) id: string,
    @GetUser("id") userId: string,
  ) {
    return this.accountsService.deleteAccount(userId, id);
  }
}
