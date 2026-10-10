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
import { CategoriesService } from "./categories.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { UpdateCategoryDto } from "./dto/update-category.dto";
import { FinanceTransactionType } from "@prisma/client";

@ApiTags("Finance Categories")
@Controller("finance/categories")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: "List all finance categories for user" })
  @ApiQuery({ name: "type", enum: FinanceTransactionType, required: false })
  @ApiResponse({ status: 200, description: "List of categories" })
  async getCategories(
    @GetUser("id") userId: string,
    @Query("type") type?: FinanceTransactionType,
  ) {
    return this.categoriesService.getCategories(userId, type);
  }

  @Post()
  @ApiOperation({ summary: "Create a custom finance category" })
  @ApiResponse({ status: 201, description: "Category created successfully" })
  async createCategory(
    @GetUser("id") userId: string,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.categoriesService.createCategory(userId, dto);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get category details by ID" })
  @ApiResponse({ status: 200, description: "Category details" })
  @ApiResponse({ status: 404, description: "Category not found" })
  async getCategoryById(
    @Param("id", ParseUUIDPipe) id: string,
    @GetUser("id") userId: string,
  ) {
    return this.categoriesService.getCategoryById(userId, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a finance category" })
  @ApiResponse({ status: 200, description: "Category updated successfully" })
  @ApiResponse({ status: 404, description: "Category not found" })
  async updateCategory(
    @Param("id", ParseUUIDPipe) id: string,
    @GetUser("id") userId: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categoriesService.updateCategory(userId, id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete a finance category" })
  @ApiResponse({ status: 200, description: "Category deleted" })
  @ApiResponse({ status: 400, description: "Cannot delete system categories" })
  @ApiResponse({ status: 404, description: "Category not found" })
  async deleteCategory(
    @Param("id", ParseUUIDPipe) id: string,
    @GetUser("id") userId: string,
  ) {
    return this.categoriesService.deleteCategory(userId, id);
  }
}
