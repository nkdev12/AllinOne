import {
  Controller,
  Post,
  Body,
  UseGuards,
  Ip,
  Headers,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { GetUser } from "@/auth/decorators/get-user.decorator";
import { PasskeysService } from "./passkeys.service";
import {
  LoginOptionsDto,
  LoginVerifyDto,
  RegisterOptionsDto,
  RegisterVerifyDto,
} from "./dto/passkeys.dto";

@ApiTags("Passkeys")
@Controller("auth/passkeys")
export class PasskeysController {
  constructor(private readonly passkeysService: PasskeysService) {}

  @Post("register-options")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary:
      "Generate WebAuthn challenge for registering a new passkey credential",
  })
  @ApiResponse({ status: 200, description: "Registration options generated" })
  async generateRegistrationOptions(
    @GetUser("id") userId: string,
    @Body() dto: RegisterOptionsDto,
  ) {
    return this.passkeysService.generateRegistrationOptions(userId, dto);
  }

  @Post("register-verify")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth("access-token")
  @ApiOperation({
    summary:
      "Verify client WebAuthn registration response and save passkey credential",
  })
  @ApiResponse({ status: 201, description: "Passkey registered successfully" })
  @ApiResponse({
    status: 400,
    description: "Invalid client data or challenge mismatch",
  })
  async verifyRegistration(
    @GetUser("id") userId: string,
    @Body() dto: RegisterVerifyDto,
  ) {
    return this.passkeysService.verifyRegistration(userId, dto);
  }

  @Post("login-options")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Generate WebAuthn challenge for passwordless passkey login",
  })
  @ApiResponse({ status: 200, description: "Login options generated" })
  async generateLoginOptions(@Body() dto: LoginOptionsDto) {
    return this.passkeysService.generateLoginOptions(dto);
  }

  @Post("login-verify")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Verify passkey signature assertion, authenticate user, and issue tokens",
  })
  @ApiResponse({
    status: 200,
    description: "Passkey authentication successful",
  })
  @ApiResponse({
    status: 401,
    description: "Invalid passkey or locked account",
  })
  async verifyLogin(
    @Body() dto: LoginVerifyDto,
    @Ip() ipAddress: string,
    @Headers("user-agent") userAgent: string,
  ) {
    return this.passkeysService.verifyLogin(dto, ipAddress, userAgent);
  }
}
