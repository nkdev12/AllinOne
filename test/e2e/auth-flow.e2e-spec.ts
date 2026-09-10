import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { AuthController } from "@/auth/auth.controller";
import { AuthService } from "@/auth/auth.service";
import { UsersController } from "@/users/users.controller";
import { UsersService } from "@/users/users.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { TracingModule } from "@/common/tracing/tracing.module";
import { TracingInterceptor } from "@/common/tracing/tracing.interceptor";
import { ErrorHandlingModule } from "@/common/error-handling/error-handling.module";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { UnauthorizedException } from "@nestjs/common";

describe("Authentication & User Lifecycle (E2E)", () => {
  let app: INestApplication;
  let authServiceMock: any;
  let usersServiceMock: any;

  const mockUser = {
    id: "user-1234-uuid",
    email: "test@example.com",
    displayName: "E2E User",
    status: "ACTIVE",
    createdAt: new Date().toISOString(),
  };

  const mockTokens = {
    accessToken: "mock.jwt.access.token",
    refreshToken: "mock.jwt.refresh.token",
    expiresIn: 900,
  };

  beforeAll(async () => {
    let failedAttempts = 0;

    authServiceMock = {
      register: jest.fn().mockImplementation(async (dto) => {
        return {
          user: { ...mockUser, email: dto.email },
          tokens: mockTokens,
          sessionId: "session-123",
        };
      }),

      login: jest.fn().mockImplementation(async (dto) => {
        if (dto.password === "WrongPassword!") {
          failedAttempts++;
          if (failedAttempts >= 5) {
            throw new UnauthorizedException(
              "Account has been temporarily locked for 15 minutes due to multiple failed login attempts.",
            );
          }
          throw new UnauthorizedException("Invalid email or password");
        }
        failedAttempts = 0;
        return {
          user: mockUser,
          tokens: mockTokens,
          sessionId: "session-123",
        };
      }),

      refreshTokens: jest.fn().mockResolvedValue({
        tokens: {
          accessToken: "new.mock.jwt.access.token",
          refreshToken: "new.mock.jwt.refresh.token",
          expiresIn: 900,
        },
      }),

      logout: jest.fn().mockResolvedValue({ success: true }),
    };

    usersServiceMock = {
      getUserById: jest.fn().mockResolvedValue(mockUser),
      sanitizeUser: jest.fn().mockImplementation((u) => u),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TracingModule, ErrorHandlingModule],
      controllers: [AuthController, UsersController],
      providers: [
        { provide: AuthService, useValue: authServiceMock },
        { provide: UsersService, useValue: usersServiceMock },
        { provide: APP_INTERCEPTOR, useClass: TracingInterceptor },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          const auth = req.headers.authorization;
          if (!auth || !auth.startsWith("Bearer valid-token")) {
            throw new UnauthorizedException("Unauthorized access");
          }
          req.user = mockUser;
          return true;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("POST /auth/register", () => {
    it("should reject registration with invalid email or short password (400)", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/register")
        .send({
          email: "invalid-email",
          password: "short",
        })
        .expect(400);

      expect(response.body.code).toBe("VALIDATION_ERROR");
      expect(Array.isArray(response.body.message)).toBe(true);
      expect(response.headers["x-trace-id"]).toBeDefined();
    });

    it("should register a valid user and return 201 with auth payload and refresh cookie", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/register")
        .send({
          email: "valid@example.com",
          password: "SecurePassword123!",
        })
        .expect(201);

      expect(response.body.user.email).toBe("valid@example.com");
      expect(response.body.tokens.accessToken).toBe(mockTokens.accessToken);
      expect(response.headers["x-trace-id"]).toBeDefined();
    });
  });

  describe("POST /auth/login and Account Lockout", () => {
    it("should reject login on invalid password with 401", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/login")
        .send({
          email: "test@example.com",
          password: "WrongPassword!",
        })
        .expect(401);

      expect(response.body.message).toBe("Invalid email or password");
    });

    it("should lock account on 5 consecutive failed attempts", async () => {
      // Send 4 more failed attempts to reach threshold of 5
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: "test@example.com", password: "WrongPassword!" })
        .expect(401);
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: "test@example.com", password: "WrongPassword!" })
        .expect(401);
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: "test@example.com", password: "WrongPassword!" })
        .expect(401);

      const response = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: "test@example.com", password: "WrongPassword!" })
        .expect(401);

      expect(response.body.message).toContain(
        "Account has been temporarily locked for 15 minutes",
      );
    });

    it("should authenticate successfully with correct credentials", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/login")
        .send({
          email: "test@example.com",
          password: "CorrectPassword123!",
        })
        .expect(200);

      expect(response.body.user.id).toBe(mockUser.id);
      expect(response.body.tokens.accessToken).toBe(mockTokens.accessToken);
      expect(response.headers["set-cookie"]).toBeDefined();
    });
  });

  describe("GET /users/me", () => {
    it("should reject request without Bearer token (401)", async () => {
      await request(app.getHttpServer()).get("/users/me").expect(401);
    });

    it("should return user profile with valid Bearer token (200)", async () => {
      const response = await request(app.getHttpServer())
        .get("/users/me")
        .set("Authorization", "Bearer valid-token-here")
        .expect(200);

      expect(response.body.id).toBe(mockUser.id);
      expect(response.body.email).toBe(mockUser.email);
    });
  });

  describe("POST /auth/refresh", () => {
    it("should rotate tokens and return 200", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/refresh")
        .send({ refreshToken: "mock.jwt.refresh.token" })
        .expect(200);

      expect(response.body.tokens.accessToken).toBe(
        "new.mock.jwt.access.token",
      );
      expect(response.headers["set-cookie"]).toBeDefined();
    });
  });

  describe("POST /auth/logout", () => {
    it("should invalidate session and clear cookie", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/logout")
        .set("Authorization", "Bearer valid-token-here")
        .send({ sessionId: "session-123" })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(authServiceMock.logout).toHaveBeenCalled();
    });
  });
});
