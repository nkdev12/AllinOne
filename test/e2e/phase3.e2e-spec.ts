import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { CollaborationController } from "@/collaboration/collaboration.controller";
import { CollaborationService } from "@/collaboration/collaboration.service";
import { AiController } from "@/ai/ai.controller";
import { AiService } from "@/ai/ai.service";
import { PasskeysController } from "@/auth/passkeys/passkeys.controller";
import { PasskeysService } from "@/auth/passkeys/passkeys.service";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { TracingModule } from "@/common/tracing/tracing.module";
import { TracingInterceptor } from "@/common/tracing/tracing.interceptor";
import { ErrorHandlingModule } from "@/common/error-handling/error-handling.module";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { UnauthorizedException, BadRequestException } from "@nestjs/common";

describe("Phase 3: Product Capabilities (E2E)", () => {
  let app: INestApplication;
  let collaborationServiceMock: any;
  let aiServiceMock: any;
  let passkeysServiceMock: any;

  const mockUser = {
    id: "user-1234-uuid",
    email: "owner@example.com",
    displayName: "Owner User",
  };

  const validAuthHeader = "Bearer valid-token-123";

  beforeAll(async () => {
    collaborationServiceMock = {
      shareResource: jest.fn().mockImplementation(async (userId, dto) => ({
        id: "share-abc-123",
        resourceType: dto.resourceType,
        resourceId: dto.resourceId,
        ownerId: userId,
        granteeEmail: dto.email,
        granteeId: "grantee-uuid-456",
        role: dto.role,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),

      getSharesForResource: jest
        .fn()
        .mockImplementation(async (_userId, resourceType, resourceId) => [
          {
            id: "share-abc-123",
            resourceType,
            resourceId,
            ownerId: mockUser.id,
            granteeEmail: "collab@example.com",
            role: "EDITOR",
            createdAt: new Date().toISOString(),
          },
        ]),

      updateShareRole: jest
        .fn()
        .mockImplementation(async (_userId, shareId, dto) => ({
          id: shareId,
          role: dto.role,
          updatedAt: new Date().toISOString(),
        })),

      revokeShare: jest.fn().mockResolvedValue({ success: true }),

      getResourcesSharedWithUser: jest
        .fn()
        .mockImplementation(async (_userId, email, query) => ({
          data: [
            {
              id: "share-abc-123",
              resourceType: query.resourceType || "NOTE",
              resourceId: "note-123",
              ownerId: "owner-999",
              granteeEmail: email,
              role: "VIEWER",
            },
          ],
          total: 1,
          limit: query.limit || 50,
          offset: query.offset || 0,
        })),
    };

    aiServiceMock = {
      summarize: jest.fn().mockImplementation(async (_userId, dto) => {
        if (!dto.text && !dto.noteId) {
          throw new BadRequestException(
            "Either 'text' or 'noteId' must be provided.",
          );
        }
        return {
          summary: "This is a concise executive summary of the document.",
          originalLength: (dto.text || "Sample content").length,
          summaryLength: 52,
          compressionRatio: 0.35,
          format: dto.format || "paragraph",
          provider: "heuristic",
        };
      }),

      extractTasks: jest.fn().mockImplementation(async (_userId, _dto) => ({
        tasks: [
          {
            title: "Implement passkey authentication",
            priority: "HIGH",
          },
          {
            title: "Deploy Redis cluster to staging",
            priority: "MEDIUM",
          },
        ],
        totalFound: 2,
        provider: "heuristic",
      })),

      suggestTags: jest.fn().mockImplementation(async (_userId, _dto) => ({
        tags: ["auth", "security", "passkeys", "token"],
        suggestedCategories: ["Security", "Infrastructure"],
        provider: "heuristic",
      })),

      convertTasksForNote: jest
        .fn()
        .mockImplementation(async (userId, noteId, dto) => ({
          createdCount: dto.tasks.length,
          tasks: dto.tasks.map((t: any, idx: number) => ({
            id: `task-id-${idx + 1}`,
            userId,
            title: t.title,
            priority: t.priority || "MEDIUM",
            extractedFromNoteId: noteId,
          })),
        })),
    };

    passkeysServiceMock = {
      generateRegistrationOptions: jest
        .fn()
        .mockImplementation(async (userId, _dto) => ({
          challenge: "base64url-challenge-registration-12345",
          rp: { name: "AllinOne Workspace", id: "localhost" },
          user: {
            id: userId,
            name: mockUser.email,
            displayName: mockUser.displayName,
          },
          pubKeyCredParams: [{ alg: -7, type: "public-key" }],
          timeout: 60000,
          attestation: "none",
        })),

      verifyRegistration: jest.fn().mockImplementation(async (_userId, dto) => {
        if (dto.id === "invalid-credential") {
          throw new BadRequestException("Invalid WebAuthn attestation");
        }
        return {
          verified: true,
          credentialId: dto.id,
          deviceName: dto.deviceName || "WebAuthn Device",
        };
      }),

      generateLoginOptions: jest.fn().mockImplementation(async (dto) => ({
        challenge: "base64url-challenge-login-67890",
        rpId: "localhost",
        timeout: 60000,
        userVerification: "preferred",
        allowCredentials: dto.email
          ? [{ id: "mock-cred-id", type: "public-key" }]
          : [],
      })),

      verifyLogin: jest.fn().mockImplementation(async (dto) => {
        if (dto.id === "unknown-cred") {
          throw new UnauthorizedException(
            "Passkey credential not recognized or has been revoked.",
          );
        }
        return {
          user: mockUser,
          tokens: {
            accessToken: "mock.passkey.jwt.access.token",
            refreshToken: "mock.passkey.jwt.refresh.token",
            expiresIn: 900,
          },
          sessionId: "passkey-session-987",
        };
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TracingModule, ErrorHandlingModule],
      controllers: [CollaborationController, AiController, PasskeysController],
      providers: [
        { provide: CollaborationService, useValue: collaborationServiceMock },
        { provide: AiService, useValue: aiServiceMock },
        { provide: PasskeysService, useValue: passkeysServiceMock },
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

  // ==========================================
  // Subsystem 1: Collaboration & Resource Sharing
  // ==========================================
  describe("Subsystem 1: Multi-User Collaboration & Sharing", () => {
    it("POST /collaboration/shares - should reject unauthorized requests", async () => {
      await request(app.getHttpServer())
        .post("/collaboration/shares")
        .send({
          resourceType: "NOTE",
          resourceId: "note-123",
          email: "collab@example.com",
          role: "EDITOR",
        })
        .expect(401);
    });

    it("POST /collaboration/shares - should reject invalid payload (bad email)", async () => {
      await request(app.getHttpServer())
        .post("/collaboration/shares")
        .set("Authorization", validAuthHeader)
        .send({
          resourceType: "NOTE",
          resourceId: "note-123",
          email: "not-an-email",
          role: "EDITOR",
        })
        .expect(400);
    });

    it("POST /collaboration/shares - should share a note successfully", async () => {
      const response = await request(app.getHttpServer())
        .post("/collaboration/shares")
        .set("Authorization", validAuthHeader)
        .send({
          resourceType: "NOTE",
          resourceId: "note-123",
          email: "collab@example.com",
          role: "EDITOR",
        })
        .expect(201);

      expect(response.body.id).toBe("share-abc-123");
      expect(response.body.resourceType).toBe("NOTE");
      expect(response.body.role).toBe("EDITOR");
      expect(response.body.granteeEmail).toBe("collab@example.com");
    });

    it("GET /collaboration/shares/:resourceType/:resourceId - should list resource shares", async () => {
      const response = await request(app.getHttpServer())
        .get("/collaboration/shares/NOTE/note-123")
        .set("Authorization", validAuthHeader)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(1);
      expect(response.body[0].resourceId).toBe("note-123");
    });

    it("PATCH /collaboration/shares/:shareId - should update collaborator role", async () => {
      const response = await request(app.getHttpServer())
        .patch("/collaboration/shares/share-abc-123")
        .set("Authorization", validAuthHeader)
        .send({ role: "VIEWER" })
        .expect(200);

      expect(response.body.role).toBe("VIEWER");
    });

    it("GET /collaboration/shared-with-me - should list shared resources for user", async () => {
      const response = await request(app.getHttpServer())
        .get("/collaboration/shared-with-me?resourceType=NOTE")
        .set("Authorization", validAuthHeader)
        .expect(200);

      expect(response.body.data).toBeDefined();
      expect(response.body.data.length).toBe(1);
      expect(response.body.total).toBe(1);
    });

    it("DELETE /collaboration/shares/:shareId - should revoke collaborator access", async () => {
      await request(app.getHttpServer())
        .delete("/collaboration/shares/share-abc-123")
        .set("Authorization", validAuthHeader)
        .expect(204);

      expect(collaborationServiceMock.revokeShare).toHaveBeenCalledWith(
        mockUser.id,
        "share-abc-123",
      );
    });
  });

  // ==========================================
  // Subsystem 2: AI & Semantic Capabilities
  // ==========================================
  describe("Subsystem 2: AI & Semantic Capabilities", () => {
    it("POST /ai/summarize - should generate document summary", async () => {
      const response = await request(app.getHttpServer())
        .post("/ai/summarize")
        .set("Authorization", validAuthHeader)
        .send({
          text: "AllinOne provides notes, projects, tasks, and calendar sync.",
          length: "brief",
          format: "paragraph",
        })
        .expect(200);

      expect(response.body.summary).toBeDefined();
      expect(response.body.compressionRatio).toBeDefined();
      expect(response.body.provider).toBe("heuristic");
    });

    it("POST /ai/extract-tasks - should extract tasks from text", async () => {
      const response = await request(app.getHttpServer())
        .post("/ai/extract-tasks")
        .set("Authorization", validAuthHeader)
        .send({
          text: "TODO: Implement passkey authentication ASAP\nDeploy Redis cluster to staging",
        })
        .expect(200);

      expect(response.body.totalFound).toBe(2);
      expect(response.body.tasks[0].priority).toBe("HIGH");
      expect(response.body.tasks[1].priority).toBe("MEDIUM");
    });

    it("POST /ai/suggest-tags - should suggest semantic tags and categories", async () => {
      const response = await request(app.getHttpServer())
        .post("/ai/suggest-tags")
        .set("Authorization", validAuthHeader)
        .send({
          text: "OAuth security tokens and redis database cache",
        })
        .expect(200);

      expect(response.body.tags).toBeDefined();
      expect(response.body.suggestedCategories).toContain("Security");
      expect(response.body.suggestedCategories).toContain("Infrastructure");
    });

    it("POST /ai/notes/:noteId/convert-tasks - should convert extracted tasks to entities", async () => {
      const response = await request(app.getHttpServer())
        .post("/ai/notes/note-123/convert-tasks")
        .set("Authorization", validAuthHeader)
        .send({
          tasks: [
            { title: "Review PR #42", priority: "HIGH" },
            { title: "Run migration", priority: "MEDIUM" },
          ],
        })
        .expect(201);

      expect(response.body.createdCount).toBe(2);
      expect(response.body.tasks.length).toBe(2);
      expect(response.body.tasks[0].title).toBe("Review PR #42");
    });
  });

  // ==========================================
  // Subsystem 3: FIDO2 / WebAuthn Passkeys
  // ==========================================
  describe("Subsystem 3: FIDO2 / WebAuthn Passkeys", () => {
    it("POST /auth/passkeys/register-options - should return registration challenge", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/passkeys/register-options")
        .set("Authorization", validAuthHeader)
        .send({ deviceName: "MacBook TouchID" })
        .expect(200);

      expect(response.body.challenge).toBe(
        "base64url-challenge-registration-12345",
      );
      expect(response.body.rp.name).toBe("AllinOne Workspace");
      expect(response.body.user.id).toBe(mockUser.id);
    });

    it("POST /auth/passkeys/register-verify - should verify registration response", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/passkeys/register-verify")
        .set("Authorization", validAuthHeader)
        .send({
          id: "credential-id-xyz",
          clientDataJSON: "base64-client-data",
          attestationObject: "base64-attestation-obj",
          deviceName: "MacBook TouchID",
        })
        .expect(201);

      expect(response.body.verified).toBe(true);
      expect(response.body.credentialId).toBe("credential-id-xyz");
    });

    it("POST /auth/passkeys/login-options - should return public login challenge", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/passkeys/login-options")
        .send({ email: "owner@example.com" })
        .expect(200);

      expect(response.body.challenge).toBe("base64url-challenge-login-67890");
      expect(response.body.allowCredentials.length).toBe(1);
    });

    it("POST /auth/passkeys/login-verify - should authenticate passkey assertion and issue JWT", async () => {
      const response = await request(app.getHttpServer())
        .post("/auth/passkeys/login-verify")
        .send({
          id: "credential-id-xyz",
          clientDataJSON: "base64-client-data",
          authenticatorData: "base64-auth-data",
          signature: "base64-signature",
        })
        .expect(200);

      expect(response.body.user.id).toBe(mockUser.id);
      expect(response.body.tokens.accessToken).toBe(
        "mock.passkey.jwt.access.token",
      );
      expect(response.body.sessionId).toBe("passkey-session-987");
    });

    it("POST /auth/passkeys/login-verify - should reject unrecognized passkey credential", async () => {
      await request(app.getHttpServer())
        .post("/auth/passkeys/login-verify")
        .send({
          id: "unknown-cred",
          clientDataJSON: "base64-client-data",
          authenticatorData: "base64-auth-data",
          signature: "base64-signature",
        })
        .expect(401);
    });
  });
});
