import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { VerifyEmailRequestDto, ConfirmEmailDto } from "./dto/verify-email.dto";
import { ForgotPasswordDto, ResetPasswordDto } from "./dto/password-reset.dto";
import { OAuthLoginDto } from "./dto/oauth.dto";
import {
  EnableMfaDto,
  VerifyMfaLoginDto,
  DisableMfaDto,
  MfaSecretResponseDto,
  MfaEnableResponseDto,
} from "./dto/mfa.dto";
import { AuthResponseDto } from "./dto/auth-response.dto";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { GetUser } from "./decorators/get-user.decorator";

@ApiTags("Auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private extractCookie(
    cookieHeader: string | undefined,
    name: string,
  ): string | undefined {
    if (!cookieHeader) return undefined;
    const match = cookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : undefined;
  }

  private setRefreshTokenCookie(res: Response, token?: string) {
    if (!token) return;
    res.cookie("refresh_token", token, {
      httpOnly: true,
      secure: process.env.APP_ENV === "production",
      sameSite: "strict",
      path: "/auth/refresh",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  @Post("register")
  @Throttle({ default: { limit: 3, ttl: 3600000 } })
  @ApiOperation({ summary: "Register a new user account (Limit: 3/hr)" })
  @ApiResponse({
    status: 201,
    description: "User successfully registered",
    type: AuthResponseDto,
  })
  @ApiResponse({ status: 400, description: "Validation error" })
  @ApiResponse({ status: 409, description: "Email already exists" })
  @ApiResponse({ status: 429, description: "Too many requests" })
  async register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.authService.register(dto);
  }

  @Post("login")
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Authenticate user with email and password" })
  @ApiResponse({
    status: 200,
    description: "Successfully authenticated or 2FA required",
    type: AuthResponseDto,
  })
  @ApiResponse({ status: 401, description: "Invalid credentials" })
  @ApiResponse({ status: 429, description: "Too many requests" })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const ipAddress = req.ip || (req.headers["x-forwarded-for"] as string);
    const userAgent = req.headers["user-agent"];
    const result = await this.authService.login(dto, ipAddress, userAgent);
    this.setRefreshTokenCookie(res, result.tokens?.refreshToken);
    return result;
  }

  // ========================================================================
  // OAuth Integration Endpoints (Google, Apple, Microsoft)
  // ========================================================================

  @Post("oauth/google")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Authenticate using Google OAuth ID token" })
  @ApiResponse({
    status: 200,
    description: "Successfully authenticated via Google",
    type: AuthResponseDto,
  })
  async loginWithGoogle(
    @Body() dto: OAuthLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const ipAddress = req.ip || (req.headers["x-forwarded-for"] as string);
    const userAgent = req.headers["user-agent"];
    const result = await this.authService.loginWithGoogle(
      dto,
      ipAddress,
      userAgent,
    );
    this.setRefreshTokenCookie(res, result.tokens?.refreshToken);
    return result;
  }

  @Post("oauth/apple")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Authenticate using Apple OAuth ID token" })
  async loginWithApple(
    @Body() dto: OAuthLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const ipAddress = req.ip || (req.headers["x-forwarded-for"] as string);
    const userAgent = req.headers["user-agent"];
    const result = await this.authService.loginWithApple(
      dto,
      ipAddress,
      userAgent,
    );
    this.setRefreshTokenCookie(res, result.tokens?.refreshToken);
    return result;
  }

  @Post("oauth/microsoft")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Authenticate using Microsoft OAuth ID token" })
  async loginWithMicrosoft(
    @Body() dto: OAuthLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const ipAddress = req.ip || (req.headers["x-forwarded-for"] as string);
    const userAgent = req.headers["user-agent"];
    const result = await this.authService.loginWithMicrosoft(
      dto,
      ipAddress,
      userAgent,
    );
    this.setRefreshTokenCookie(res, result.tokens?.refreshToken);
    return result;
  }

  @Post("refresh")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Refresh authentication access token" })
  @ApiResponse({ status: 200, description: "Tokens successfully refreshed" })
  @ApiResponse({ status: 401, description: "Invalid or expired refresh token" })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookieToken =
      (req as any).cookies?.refresh_token ||
      this.extractCookie(req.headers.cookie, "refresh_token");
    const refreshToken = dto.refreshToken || cookieToken;

    if (!refreshToken) {
      throw new UnauthorizedException("Refresh token is required");
    }

    const result = await this.authService.refreshTokens({ refreshToken });
    this.setRefreshTokenCookie(res, result.tokens.refreshToken);
    return result;
  }

  @Post("logout")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "Logout and revoke active session" })
  @ApiResponse({ status: 200, description: "Successfully logged out" })
  async logout(
    @GetUser("sessionId") sessionId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.clearCookie("refresh_token", { path: "/auth/refresh" });
    return this.authService.logout(sessionId);
  }

  @Post("verify-email/request")
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Request email verification link" })
  async requestEmailVerification(@Body() dto: VerifyEmailRequestDto) {
    return this.authService.requestEmailVerification(dto.email);
  }

  @Post("verify-email/confirm")
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Confirm email verification token" })
  async confirmEmailVerification(@Body() dto: ConfirmEmailDto) {
    return this.authService.confirmEmailVerification(
      dto.token,
      dto.email,
      dto.otp,
    );
  }

  @Post("forgot-password")
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Request password reset instructions" })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Post("reset-password")
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reset password using token" })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.newPassword);
  }

  // ========================================================================
  // Multi-Factor Authentication Endpoints
  // ========================================================================

  @Post("mfa/generate")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "Generate TOTP MFA secret and QR code" })
  async generateMfaSecret(
    @GetUser("id") userId: string,
  ): Promise<MfaSecretResponseDto> {
    return this.authService.generateMfaSecret(userId);
  }

  @Post("mfa/enable")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "Enable TOTP MFA with code confirmation" })
  async enableMfa(
    @GetUser("id") userId: string,
    @Body() dto: EnableMfaDto,
  ): Promise<MfaEnableResponseDto> {
    return this.authService.enableMfa(userId, dto);
  }

  @Post("mfa/verify")
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Verify 2FA TOTP code or recovery code during login",
  })
  async verifyMfaLogin(
    @Body() dto: VerifyMfaLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const ipAddress = req.ip || (req.headers["x-forwarded-for"] as string);
    const userAgent = req.headers["user-agent"];
    const result = await this.authService.verifyMfaLogin(
      dto,
      ipAddress,
      userAgent,
    );
    this.setRefreshTokenCookie(res, result.tokens?.refreshToken);
    return result;
  }

  @Post("mfa/disable")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth("access-token")
  @ApiOperation({ summary: "Disable TOTP MFA on account" })
  async disableMfa(@GetUser("id") userId: string, @Body() dto: DisableMfaDto) {
    return this.authService.disableMfa(userId, dto);
  }
}
