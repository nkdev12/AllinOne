import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { ConfigurationService } from "@/config/configuration.service";
import { ErrorCode } from "@/common/errors/error-code";

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
    const res: any = { cookie: jest.fn(), clearCookie: jest.fn() };
    const result = await controller.register(
      {
        email: "test@example.com",
        password: "Password123!",
        displayName: "Test User",
      },
      res,
    );
    expect(result).toEqual(mockAuthResponse);
    expect(authService.register).toHaveBeenCalled();
  });

  /**
   * The web client keeps the access token in memory and the refresh credential
   * in this cookie, so the two halves of a session arrive together on login and
   * must arrive together here: a registration response that carried the token in
   * the body only left the browser with nothing to refresh, and the account the
   * signup just created signed itself out at the first 401.
   */
  it("sets the refresh cookie for the session registration just opened", async () => {
    const res: any = { cookie: jest.fn(), clearCookie: jest.fn() };
    await controller.register(
      { email: "test@example.com", password: "Password123!" },
      res,
    );

    // Asserted as the whole option set rather than `expect.any(Object)`: the
    // point of routing registration through the shared helper is that it gets
    // the same attributes every other session-opening path already has.
    expect(res.cookie).toHaveBeenCalledWith(
      "refresh_token",
      "mock-refresh-token",
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/auth/refresh",
        maxAge: REFRESH_TTL_SECONDS * 1000,
      }),
    );
  });

  it("sets no cookie when registration cannot open a session", async () => {
    const res: any = { cookie: jest.fn(), clearCookie: jest.fn() };
    authService.register.mockResolvedValueOnce({
      user: mockUser,
      sessionId: undefined,
    });

    await controller.register(
      { email: "test@example.com", password: "Password123!" },
      res,
    );

    expect(res.cookie).not.toHaveBeenCalled();
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
    /** The header the app's client attaches to every request, CSRF barrier. */
    const barrier = { "x-client-version": "1.2.3" };

    it("should refresh tokens using cookie if present", async () => {
      const reqMock: any = {
        cookies: { refresh_token: "cookie-refresh-token" },
        headers: { ...barrier },
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

    /**
     * The request an attacker makes: a cross-origin form post with no header and
     * no body, which the browser nevertheless sends with the ambient cookie
     * attached. Reading the session off the cookie alone is what this refuses.
     */
    it("refuses a cookie-only refresh that carries no client header", async () => {
      const reqMock: any = {
        cookies: { refresh_token: "cookie-refresh-token" },
        headers: {},
      };
      const res: any = { cookie: jest.fn(), clearCookie: jest.fn() };

      await expect(controller.refresh({}, reqMock, res)).rejects.toThrow(
        ForbiddenException,
      );
      expect(authService.refreshTokens).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it("refuses a cookie-only refresh whose client header is blank", async () => {
      const reqMock: any = {
        cookies: { refresh_token: "cookie-refresh-token" },
        headers: { "x-client-version": "   " },
      };

      await expect(controller.refresh({}, reqMock, resMock)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("answers a cookie-only refresh that names its own error code", async () => {
      const reqMock: any = {
        cookies: { refresh_token: "cookie-refresh-token" },
        headers: {},
      };

      await expect(
        controller.refresh({}, reqMock, resMock),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: ErrorCode.TOKEN_INVALID }),
      });
    });

    /**
     * Native clients hold the token themselves and prove possession by sending
     * it, so the barrier would only break their refresh. A form post cannot do
     * this — reading a token out of the app's secure storage is a different
     * attack than riding a browser's cookie jar.
     */
    it("keeps the body-token path working without the client header", async () => {
      const reqMock: any = {
        // Even alongside a cookie this request is answered from the body, and
        // the body is what authenticated it.
        cookies: { refresh_token: "cookie-refresh-token" },
        headers: {},
      };

      const result = await controller.refresh(
        { refreshToken: "native-refresh-token" },
        reqMock,
        resMock,
      );
      expect(authService.refreshTokens).toHaveBeenCalledWith({
        refreshToken: "native-refresh-token",
      });
      expect(result).toEqual({ tokens: mockAuthResponse.tokens });
    });

    it("should reject when neither the body nor the cookie carries a token", async () => {
      const reqMock: any = { cookies: {}, headers: {} };

      await expect(controller.refresh({}, reqMock, resMock)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    /**
     * `Cookie: refresh_token=%` is a malformed percent-escape on an
     * unauthenticated route, and `decodeURIComponent` throws `URIError` on it —
     * which used to leave the handler as a 500. Note that none of these requests
     * carry a `cookies` object: `cookie-parser` is not a dependency of this app
     * and no middleware registers it, so `req.cookies` is never populated and the
     * raw header is the path a browser's cookie really takes to get here.
     */
    const malformedCookies = [
      ["a lone escape", "refresh_token=%"],
      ["an escape in the middle of the list", "theme=dark; refresh_token=%"],
      ["a truncated UTF-8 escape", "refresh_token=%E4%B"],
      ["a bare percent between two cookies", "refresh_token=%; theme=dark"],
    ];

    it.each(malformedCookies)(
      "answers %s with the same 401 as no cookie at all",
      async (_label, cookieHeader) => {
        const reqMock: any = { headers: { cookie: cookieHeader } };
        // A fresh response double: `resMock` is shared across this file and its
        // `cookie` spy keeps every earlier call.
        const res: any = { cookie: jest.fn(), clearCookie: jest.fn() };

        const thrown = (await controller
          .refresh({}, reqMock, res)
          .catch((error: unknown) => error)) as UnauthorizedException;

        expect(thrown).toBeInstanceOf(UnauthorizedException);
        expect(thrown.getResponse()).toEqual({
          code: ErrorCode.TOKEN_INVALID,
          message: "Refresh token is required",
        });
        expect(authService.refreshTokens).not.toHaveBeenCalled();
        expect(res.cookie).not.toHaveBeenCalled();
      },
    );

    it("refuses a malformed cookie that arrives with the client header", async () => {
      const reqMock: any = {
        headers: { ...barrier, cookie: "refresh_token=%" },
      };

      await expect(controller.refresh({}, reqMock, resMock)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("refuses a malformed cookie that a parser left on req.cookies", async () => {
      // Guards the other read at the top of `refresh`: whatever ends up in
      // `req.cookies`, a value that is not a string is not a credential, and the
      // header fallback still has to be the thing that survives.
      const reqMock: any = {
        cookies: { refresh_token: { raw: "%" } },
        headers: { cookie: "refresh_token=%" },
      };

      await expect(controller.refresh({}, reqMock, resMock)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(authService.refreshTokens).not.toHaveBeenCalled();
    });

    it("still reads a cookie that is legitimately percent-encoded", async () => {
      const reqMock: any = {
        headers: { ...barrier, cookie: "refresh_token=header.payload%2Dsig" },
      };

      await controller.refresh({}, reqMock, resMock);

      expect(authService.refreshTokens).toHaveBeenCalledWith({
        refreshToken: "header.payload-sig",
      });
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
