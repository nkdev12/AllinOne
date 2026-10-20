import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  NotFoundException,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { Response } from "express";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { UpdateUserProfileDto } from "./dto/update-user-profile.dto";
import { SuggestAccountsQueryDto } from "./dto/suggest-accounts-query.dto";
import { DeleteAccountDto } from "./dto/delete-account.dto";

@ApiTags("Users")
@Controller("users")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth("access-token")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get("suggestions")
  @ApiOperation({
    summary: "Find registered accounts to add to a shared finance group",
  })
  async suggestions(
    @GetUser("id") userId: string,
    @Query() query: SuggestAccountsQueryDto,
  ) {
    return this.usersService.suggestAccounts(userId, query.q ?? "");
  }

  @Get("me")
  @ApiOperation({ summary: "Get profile of current authenticated user" })
  @ApiResponse({ status: 200, description: "Current user profile details" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getProfile(@GetUser("id") userId: string) {
    const user = await this.usersService.getUserById(userId);
    if (!user) {
      throw new NotFoundException("User profile not found");
    }
    return this.usersService.sanitizeUser(user);
  }

  @Patch("me")
  @ApiOperation({
    summary: "Update profile details (displayName, avatar, locale, timezone)",
  })
  @ApiResponse({ status: 200, description: "Updated user profile" })
  async updateProfile(
    @GetUser("id") userId: string,
    @Body() dto: UpdateUserProfileDto,
  ) {
    const updated = await this.usersService.updateProfile(userId, dto);
    return this.usersService.sanitizeUser(updated);
  }

  @Post("me/export")
  @ApiOperation({
    summary:
      "Download this account's data as an NDJSON export bundle (GDPR/CCPA portability)",
  })
  @ApiResponse({
    status: 200,
    description:
      "`application/x-ndjson`: one JSON object per line — a `header`, every `record` this account owns grouped by `collection` markers, and a final `summary` whose counts the erasure is measured against. Bearer credentials (session tokens, the vault verifier and its wrapped keys) are withheld; the vault's content leaves as its own sealed blobs. Streaming starts immediately, so a large account is never buffered whole.",
  })
  @ApiResponse({ status: 404, description: "Account not found" })
  async requestDataExport(
    @GetUser("id") userId: string,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="allinone-account-export.ndjson"`,
    );
    // An export bundle is a copy of somebody's notes, calendar and change log. It
    // must not be cached by a shared proxy or linger in a browser's HTTP cache on
    // a machine the account owner does not control.
    res.setHeader("Cache-Control", "no-store");

    // The service reads the account row before the first line is produced, so a
    // missing account still reaches the exception filter as a normal 404. After
    // that the status line is already on the wire and the only honest way to
    // report a failure is a line inside the stream.
    try {
      await this.usersService.exportAccount(userId, (line) => {
        res.write(`${line}\n`);
      });
    } catch (error: any) {
      if (!res.headersSent) throw error;
      res.write(
        `${JSON.stringify({
          kind: "error",
          message:
            "Export stopped before it finished. No deletion is authorised by this bundle.",
        })}\n`,
      );
    }

    res.end();
  }

  @Delete("me")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Erase the account: its content, grants, vault row and change log, plus its sessions and devices",
  })
  @ApiResponse({
    status: 200,
    description:
      "Account deleted; the response counts the rows removed per collection",
  })
  @ApiResponse({
    status: 400,
    description: "`skipExport` was missing, or no export backs this deletion",
  })
  async deleteAccount(
    @GetUser("id") userId: string,
    @Body() dto: DeleteAccountDto,
  ) {
    return this.usersService.deleteAccount(userId, dto);
  }

  @Get("me/sessions")
  @ApiOperation({ summary: "Get all active sessions for current user" })
  @ApiResponse({ status: 200, description: "List of active user sessions" })
  async getUserSessions(@GetUser("id") userId: string) {
    return this.usersService.getUserSessions(userId);
  }

  @Delete("me/sessions/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoke a specific active session" })
  @ApiResponse({ status: 200, description: "Session revoked" })
  @ApiResponse({ status: 404, description: "Session not found" })
  async revokeSession(
    @GetUser("id") userId: string,
    @Param("id") sessionId: string,
  ) {
    return this.usersService.revokeUserSession(userId, sessionId);
  }
}
