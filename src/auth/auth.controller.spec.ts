import { Test, TestingModule } from "@nestjs/testing";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { ConfigurationService } from "@/config/configuration.service";

describe("AuthController", () => {
  let controller: AuthController;
  let authService: any;

  /**
   * Deliberately not a week. The cookie used to carry `7 * 24 * 60 * 60 * 1000`
   * regardless of what `JWT_REFRESH_EXPIRATION` said, so a test that asserted
   * 604800000 would pass either way.
   */
  const REFRESH_TTL_SECONDS = 3600;

  const mockUser = {
    id: "user-uuid-123",
    email: "test@example.com",
    displayName: "Test User",
  };

  const mockAuthResponse = {
    user: mockUser,
    tokens: {
      accessToken: "mock-access-token",
      refreshToken: "mock-refresh-token",
      expiresIn: 900,
    },
    sessionId: "session-uuid-123",
  };

  const resMock: any = {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  };

  beforeEach(async () => {
    authService = {
      register: jest.fn().mockResolvedValue(mockAuthResponse),
      login: jest.fn().mockResolvedValue(mockAuthResponse),
      loginWithGoogle: jest.fn().mockResolvedValue(mockAuthResponse),
      loginWithApple: jest.fn().mockResolvedValue(mockAuthResponse),
      loginWithMicrosoft: jest.fn().mockResolvedValue(mockAuthResponse),
      refreshTokens: jest
        .fn()
        .mockResolvedValue({ tokens: mockAuthResponse.tokens }),
      logout: jest.fn().mockResolvedValue({ success: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        {
          provide: ConfigurationService,
          useValue: { jwtRefreshExpiresInSeconds: REFRESH_TTL_SECONDS },
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  it("should authenticate user via login", async () => {
    const reqMock: any = { ip: "127.0.0.1", headers: {} };
    const res = await controller.login(
      { email: "test@example.com", password: "Password123!" },
      reqMock,
      resMock,
    );
    expect(res).toEqual(mockAuthResponse);
    expect(authService.login).toHaveBeenCalled();
  });

  it("should register a new user", async () => {
    const result = await controller.register({
      email: "test@example.com",
      password: "Password123!",
      displayName: "Test User",
    });
    expect(result).toEqual(mockAuthResponse);
    expect(authService.register).toHaveBeenCalled();
  });

  it("should authenticate user via Google OAuth", async () => {
    const reqMock: any = { ip: "127.0.0.1", headers: {} };
    const res = await controller.loginWithGoogle(
      { idToken: "google-token" },
      reqMock,
      resMock,
    );
    expect(res).toEqual(mockAuthResponse);
    expect(authService.loginWithGoogle).toHaveBeenCalled();
  });

  it("should authenticate user via Apple OAuth", async () => {
    const reqMock: any = { ip: "127.0.0.1", headers: {} };
    const res = await controller.loginWithApple(
      { idToken: "apple-token" },
      reqMock,
      resMock,
    );
    expect(res).toEqual(mockAuthResponse);
    expect(authService.loginWithApple).toHaveBeenCalled();
  });

  it("should authenticate user via Microsoft OAuth", async () => {
    const reqMock: any = { ip: "127.0.0.1", headers: {} };
    const res = await controller.loginWithMicrosoft(
      { idToken: "microsoft-token" },
      reqMock,
      resMock,
    );
    expect(res).toEqual(mockAuthResponse);
    expect(authService.loginWithMicrosoft).toHaveBeenCalled();
  });

  describe("refresh", () => {
    it("should refresh tokens using cookie if present", async () => {
      const reqMock: any = {
        cookies: { refresh_token: "cookie-refresh-token" },
        headers: {},
      };

      const result = await controller.refresh({}, reqMock, resMock);
      expect(authService.refreshTokens).toHaveBeenCalledWith({
        refreshToken: "cookie-refresh-token",
      });
      // The whole option set, not `expect.any(Object)`: `maxAge` is the reason
      // this controller reads configuration at all, and an assertion that
      // accepted any object would not notice it going back to a literal week.
      expect(resMock.cookie).toHaveBeenCalledWith(
        "refresh_token",
        "mock-refresh-token",
        expect.objectContaining({
          httpOnly: true,
          sameSite: "strict",
          path: "/auth/refresh",
          maxAge: REFRESH_TTL_SECONDS * 1000,
        }),
      );
      expect(result).toEqual({ tokens: mockAuthResponse.tokens });
    });

    it("should refresh tokens using dto if cookie is missing", async () => {
      const reqMock: any = { cookies: {}, headers: {} };

      const result = await controller.refresh(
        { refreshToken: "dto-refresh-token" },
        reqMock,
        resMock,
      );
      expect(authService.refreshTokens).toHaveBeenCalledWith({
        refreshToken: "dto-refresh-token",
      });
      expect(result).toEqual({ tokens: mockAuthResponse.tokens });
    });
  });

  describe("logout", () => {
    it("should revoke session and clear cookie", async () => {
      const result = await controller.logout("session-uuid-123", resMock);
      expect(authService.logout).toHaveBeenCalledWith("session-uuid-123");
      expect(resMock.clearCookie).toHaveBeenCalledWith(
        "refresh_token",
        expect.any(Object),
      );
      expect(result).toEqual({ success: true });
    });
  });
});
