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
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { VaultItemsService } from "../services/vault-items.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { CreateVaultItemDto } from "../dto/create-vault-item.dto";
import { UpdateVaultItemDto } from "../dto/update-vault-item.dto";
import { QueryVaultItemsDto } from "../dto/query-vault-items.dto";

@ApiTags("Vault Items")
@Controller("vault/items")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class VaultItemsController {
  constructor(private readonly itemsService: VaultItemsService) {}

  @Post()
  @ApiOperation({ summary: "Store a new client-side encrypted vault item" })
  @ApiResponse({
    status: 201,
    description: "Encrypted item stored successfully",
  })
  async createItem(
    @GetUser("id") userId: string,
    @Body() dto: CreateVaultItemDto,
  ) {
    return this.itemsService.createItem(userId, dto);
  }

  @Get()
  @ApiOperation({
    summary: "List and search zero-knowledge encrypted vault items",
  })
  @ApiResponse({
    status: 200,
    description: "Paginated encrypted items list returned",
  })
  async getItems(
    @GetUser("id") userId: string,
    @Query() query: QueryVaultItemsDto,
  ) {
    return this.itemsService.getItems(userId, query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get encrypted item details by ID" })
  @ApiResponse({ status: 200, description: "Encrypted item details returned" })
  @ApiResponse({ status: 404, description: "Item not found" })
  async getItemById(
    @Param("id") itemId: string,
    @GetUser("id") userId: string,
  ) {
    return this.itemsService.getItemById(userId, itemId);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update encrypted vault item payload or metadata" })
  @ApiResponse({ status: 200, description: "Vault item updated successfully" })
  @ApiResponse({ status: 404, description: "Item not found" })
  async updateItem(
    @Param("id") itemId: string,
    @GetUser("id") userId: string,
    @Body() dto: UpdateVaultItemDto,
  ) {
    return this.itemsService.updateItem(userId, itemId, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft delete vault item" })
  @ApiResponse({ status: 200, description: "Vault item deleted" })
  @ApiResponse({ status: 404, description: "Item not found" })
  async deleteItem(@Param("id") itemId: string, @GetUser("id") userId: string) {
    return this.itemsService.deleteItem(userId, itemId);
  }
}
