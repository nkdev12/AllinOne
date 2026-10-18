import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  Res,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ErrorCode } from "@/common/errors/error-code";
import { forbidden, unauthorized } from "@/common/errors/http-errors";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { ConfigurationService } from "@/config/configuration.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import {
  RefreshTokenDto,
  REFRESH_REQUEST_HEADER,
} from "./dto/refresh-token.dto";
import { VerifyEmailRequestDto, ConfirmEmailDto } from "./dto/verify-email.dto";
import { ForgotPasswordDto, ResetPasswordDto } from "./dto/password-reset.dto";
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

const REFRESH_COOKIE_NAME = "refresh_token";

@ApiTags("Auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigurationService,
  ) {}

  /**
   * Read one cookie out of the raw `Cookie` header.
   *
   * The decode has to be total: this header is attacker-controlled bytes on an
   * unauthenticated route, and `decodeURIComponent("%")` throws `URIError`, which
   * used to leave the handler as a 500 — a free way for anybody to probe the
   * error path of a session endpoint with nothing more than a malformed cookie.
   * A value that cannot be percent-decoded was never written by `cookie()` for a
   * JWT we minted, so it is treated as absent rather than passed on raw: the raw
   * bytes would reach `refreshTokens` as a credential no client could have sent,
   * and the request would then read as a barrier failure (403) instead of the
   * plain "no token" 401 it actually is.
   */
  private extractCookie(
    cookieHeader: string | undefined,
    name: string,
  ): string | undefined {
    if (!cookieHeader) return undefined;
    const match = cookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    if (!match) return undefined;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return undefined;
    }
  }

  private setRefreshTokenCookie(res: Response, token?: string) {
    if (!token) return;
    res.cookie(REFRESH_COOKIE_NAME, token, {
      httpOnly: true,
      // This API is hosted behind HTTPS. Never downgrade a bearer credential
      // because an environment flag was misconfigured.
      secure: true,
      sameSite: "strict",
      path: "/auth/refresh",
      // The cookie and the token it carries expire together. A literal week
      // here kept a browser holding a refresh token the server had already
      // stopped accepting, which reads to a client as a session that ends
      // silently rather than one that was configured to last seven days.
      maxAge: this.configService.jwtRefreshExpiresInSeconds * 1000,
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
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const result = await this.authService.register(dto);
    // Where registration opens a session, the web client's session *is* the
    // cookie: it holds the access token in memory only, so a register-then-
    // navigate flow that got the token in the body but no cookie has nothing to
    // refresh with and silently signs out at the first 401. Returns early when
    // email verification is required, because then there is no session.
    this.setRefreshTokenCookie(res, result.tokens?.refreshToken);
    return result;
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

  @Post("refresh")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Refresh authentication access token" })
  @ApiResponse({ status: 200, description: "Tokens successfully refreshed" })
  @ApiResponse({ status: 401, description: "Invalid or expired refresh token" })
  @ApiResponse({
    status: 403,
    description: `Cookie-only refresh without the ${REFRESH_REQUEST_HEADER} header`,
  })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // `cookie-parser` is not a dependency of this app and no middleware registers
    // it, so `req.cookies` is never populated on a real request: the header parse
    // below is the path a browser's cookie actually travels, and it is the one
    // that has to survive a malformed value. The parsed lookup stays first for a
    // deployment that does add the parser — its `cookie` package hands back an
    // already-decoded string, and anything that is not a string is not a
    // credential.
    const parsedCookie = (req as any).cookies?.[REFRESH_COOKIE_NAME];
    const cookieToken =
      (typeof parsedCookie === "string" ? parsedCookie : undefined) ||
      this.extractCookie(req.headers.cookie, REFRESH_COOKIE_NAME);
    const refreshToken = dto.refreshToken || cookieToken;

    // A body token proves possession and needs nothing else; that is the native
    // path. A cookie proves nothing — the browser attaches it to a cross-site form
    // post on its own, and only `SameSite=strict` stands between that post and a
    // minted access token. SameSite is a deployment property someone can change by
    // accident, and a foreign page cannot add a custom header to the request, so a
    // cookie-only refresh without one is refused rather than trusted.
    if (!dto.refreshToken && cookieToken && !this.hasRefreshBarrier(req)) {
      throw forbidden(
        ErrorCode.TOKEN_INVALID,
        `Refresh with the ambient cookie requires the ${REFRESH_REQUEST_HEADER} header`,
      );
    }

    if (!refreshToken) {
      throw unauthorized(ErrorCode.TOKEN_INVALID, "Refresh token is required");
    }

    const result = await this.authService.refreshTokens({ refreshToken });
    this.setRefreshTokenCookie(res, result.tokens.refreshToken);
    return result;
  }

  /**
   * Express lower-cases header names, so the one this compares against is the
   * spelling the client's own header set uses.
   */
  private hasRefreshBarrier(req: Request): boolean {
    const value = req.headers[REFRESH_REQUEST_HEADER];
    return typeof value === "string" && value.trim().length > 0;
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
    res.clearCookie(REFRESH_COOKIE_NAME, { path: "/auth/refresh" });
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
  @ApiOperation({ summary: "Reset password using an emailed OTP" })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.email, dto.otp, dto.newPassword);
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
