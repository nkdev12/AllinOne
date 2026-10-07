import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { SyncGateway } from "./sync.gateway";
import { JwtService } from "@nestjs/jwt";
import { ConfigurationService } from "@/config/configuration.service";
import { UsersService } from "@/users/users.service";

describe("SyncGateway", () => {
  let gateway: SyncGateway;
  let jwtService: any;
  let configService: any;
  let usersService: { getUserById: jest.Mock; isSessionLive: jest.Mock };
  let mockClient: any;
  let mockOtherClient: any;
  let broadcastEmit: jest.Mock;
  let mockServer: any;

  const ACTIVE_USER = {
    id: "user-uuid-123",
    email: "someone@example.com",
    status: "ACTIVE",
    deletedAt: null,
  };

  beforeEach(async () => {
    jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: "user-uuid-123",
        deviceId: "device-uuid-456",
        type: "access",
      }),
    };

    configService = {
      jwtAccessSecret: "access-secret",
    };

    // The doubles for what `JwtStrategy.validate()` does: the account row and the
    // session behind the token. Live on both, until a test says otherwise.
    usersService = {
      getUserById: jest.fn().mockResolvedValue(ACTIVE_USER),
      isSessionLive: jest.fn().mockResolvedValue(true),
    };

    mockClient = {
      id: "socket-1",
      handshake: {
        auth: { token: "valid-token" },
        headers: {},
        query: {},
      },
      data: {},
      join: jest.fn(),
      disconnect: jest.fn(),
      emit: jest.fn(),
    };

    // A second socket for the same account, on a different device: the case the
    // invalidation exists for.
    mockOtherClient = {
      id: "socket-2",
      handshake: { auth: {}, headers: {}, query: {} },
      data: { userId: "user-uuid-123", deviceId: "device-uuid-777" },
      join: jest.fn(),
      disconnect: jest.fn(),
      emit: jest.fn(),
    };

    broadcastEmit = jest.fn();
    mockServer = {
      to: jest.fn().mockReturnValue({ emit: broadcastEmit }),
      sockets: {
        adapter: {
          rooms: new Map([
            [
              "user:user-uuid-123",
              new Set([mockClient.id, mockOtherClient.id]),
            ],
          ]),
        },
        sockets: new Map([
          [mockClient.id, mockClient],
          [mockOtherClient.id, mockOtherClient],
        ]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncGateway,
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigurationService, useValue: configService },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();

    gateway = module.get<SyncGateway>(SyncGateway);
    gateway.server = mockServer;
  });

  it("should be defined", () => {
    expect(gateway).toBeDefined();
  });

  describe("handleConnection", () => {
    it("should authenticate client and join user room on valid token", async () => {
      await gateway.handleConnection(mockClient);

      expect(jwtService.verifyAsync).toHaveBeenCalledWith("valid-token", {
        secret: "access-secret",
      });
      expect(mockClient.data).toEqual({
        userId: "user-uuid-123",
        deviceId: "device-uuid-456",
      });
      expect(mockClient.join).toHaveBeenCalledWith("user:user-uuid-123");
      expect(mockClient.disconnect).not.toHaveBeenCalled();
    });

    it("should authenticate client when token is in case-insensitive bearer authorization header", async () => {
      mockClient.handshake.auth = {};
      mockClient.handshake.headers.authorization = "bearer valid-header-token";

      await gateway.handleConnection(mockClient);

      expect(jwtService.verifyAsync).toHaveBeenCalledWith(
        "valid-header-token",
        { secret: "access-secret" },
      );
      expect(mockClient.join).toHaveBeenCalledWith("user:user-uuid-123");
    });

    it("should authenticate client when token is in query string", async () => {
      mockClient.handshake.auth = {};
      mockClient.handshake.headers = {};
      mockClient.handshake.query.token = "valid-query-token";

      await gateway.handleConnection(mockClient);

      expect(jwtService.verifyAsync).toHaveBeenCalledWith(
        "valid-query-token",
        { secret: "access-secret" },
      );
      expect(mockClient.join).toHaveBeenCalledWith("user:user-uuid-123");
    });

    it("should emit error event and disconnect client if access token is missing", async () => {
      mockClient.handshake.auth.token = undefined;

      await gateway.handleConnection(mockClient);

      expect(mockClient.emit).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({
          code: "UNAUTHORIZED",
          subCode: "MISSING_TOKEN",
          message: "Unauthorized: Missing access token",
        }),
      );
      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
    });

    it("should emit error event and disconnect client if JWT verification fails", async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error("Invalid token"));

      await gateway.handleConnection(mockClient);

      expect(mockClient.emit).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({
          code: "UNAUTHORIZED",
          subCode: "INVALID_TOKEN",
          message: "Unauthorized: Invalid or expired token",
        }),
      );
      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
    });

    it("should emit TOKEN_EXPIRED error if JWT has expired", async () => {
      const expiredError = new Error("jwt expired");
      expiredError.name = "TokenExpiredError";
      jwtService.verifyAsync.mockRejectedValue(expiredError);

      await gateway.handleConnection(mockClient);

      expect(mockClient.emit).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({
          code: "UNAUTHORIZED",
          subCode: "TOKEN_EXPIRED",
          message: "Unauthorized: Token expired",
          details: "jwt expired",
        }),
      );
      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
    });

    it("should safely disconnect even if client.emit throws an error", async () => {
      mockClient.handshake.auth.token = undefined;
      mockClient.emit.mockImplementationOnce(() => {
        throw new Error("simulated socket emit error");
      });

      await expect(gateway.handleConnection(mockClient)).resolves.not.toThrow();
      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
    });
  });

  /**
   * A signature is not an authorization. `JwtStrategy.validate()` asks two more
   * questions on every REST request — is this account still ACTIVE and not
   * deleted, is the session this token names still live — and until the handshake
   * asked them too, "log out everywhere" and an admin revocation left the socket
   * connected and still receiving this account's invalidations for whatever
   * minutes the access token had left.
   */
  describe("what the handshake asks beyond the signature", () => {
    it("keeps a live session connected", async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: "user-uuid-123",
        sessionId: "session-1",
        type: "access",
      });

      await gateway.handleConnection(mockClient);

      expect(usersService.getUserById).toHaveBeenCalledWith("user-uuid-123");
      expect(usersService.isSessionLive).toHaveBeenCalledWith(
        "user-uuid-123",
        "session-1",
      );
      expect(mockClient.join).toHaveBeenCalledWith("user:user-uuid-123");
      expect(mockClient.disconnect).not.toHaveBeenCalled();
    });

    it("disconnects a token with purpose (e.g. MFA_CHALLENGE)", async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: "user-uuid-123",
        type: "access",
        purpose: "MFA_CHALLENGE",
      });

      await gateway.handleConnection(mockClient);

      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
      expect(mockClient.join).not.toHaveBeenCalled();
    });

    it("disconnects a token whose type is not access", async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: "user-uuid-123",
        type: "mfa_challenge",
      });

      await gateway.handleConnection(mockClient);

      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
      expect(mockClient.join).not.toHaveBeenCalled();
    });

    it("disconnects a revoked session", async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: "user-uuid-123",
        sessionId: "session-gone",
        type: "access",
      });
      usersService.isSessionLive.mockResolvedValue(false);

      await gateway.handleConnection(mockClient);

      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
      expect(mockClient.join).not.toHaveBeenCalled();
    });

    it("disconnects an account that is no longer ACTIVE", async () => {
      usersService.getUserById.mockResolvedValue({
        ...ACTIVE_USER,
        status: "SUSPENDED",
      });

      await gateway.handleConnection(mockClient);

      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
      expect(mockClient.join).not.toHaveBeenCalled();
    });

    it("disconnects an account that is gone, however `getUserById` says so", async () => {
      // `UsersService.getUserById()` filters soft-deleted rows to `null` because
      // MongoDB will not match an absent `deletedAt`; the `deletedAt` branch is
      // the same answer from a read that did not filter. Both refuse the socket.
      usersService.getUserById.mockResolvedValueOnce(null);
      await gateway.handleConnection(mockClient);
      expect(mockClient.disconnect).toHaveBeenCalledWith(true);

      mockClient.disconnect.mockClear();
      usersService.getUserById.mockResolvedValueOnce({
        ...ACTIVE_USER,
        deletedAt: new Date(),
      });
      await gateway.handleConnection(mockClient);
      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
      expect(mockClient.join).not.toHaveBeenCalled();
    });

    it("still admits a token that names no session", async () => {
      // Tokens minted before sessions were stamped, and the paths that use them,
      // are `JwtStrategy`'s documented pass-through. A handshake that asked the
      // liveness question of a token with no answer would lock out devices that
      // did nothing wrong.
      jwtService.verifyAsync.mockResolvedValue({
        sub: "user-uuid-123",
        deviceId: "device-uuid-456",
        type: "access",
      });

      await gateway.handleConnection(mockClient);

      expect(usersService.getUserById).toHaveBeenCalled();
      expect(usersService.isSessionLive).not.toHaveBeenCalled();
      expect(mockClient.join).toHaveBeenCalledWith("user:user-uuid-123");
      expect(mockClient.disconnect).not.toHaveBeenCalled();
    });

    it("reads the session claim from whichever name carries it", async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: "user-uuid-123",
        sid: "session-2",
        type: "access",
      });

      await gateway.handleConnection(mockClient);

      expect(usersService.isSessionLive).toHaveBeenCalledWith(
        "user-uuid-123",
        "session-2",
      );
      expect(mockClient.disconnect).not.toHaveBeenCalled();
    });

    it("refuses the socket rather than skipping a revalidation it could not run", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SyncGateway,
          { provide: JwtService, useValue: jwtService },
          { provide: ConfigurationService, useValue: configService },
        ],
      }).compile();

      const withoutUsers = module.get<SyncGateway>(SyncGateway);
      withoutUsers.server = mockServer;

      await withoutUsers.handleConnection(mockClient);

      // Failing closed is the point: a graph that lost `UsersModule` would
      // otherwise keep the old signature-only behaviour with no symptom at all.
      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
      expect(mockClient.join).not.toHaveBeenCalled();
    });

    it("disconnects when the account lookup itself fails", async () => {
      usersService.getUserById.mockRejectedValue(new Error("db down"));

      await gateway.handleConnection(mockClient);

      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
      expect(mockClient.join).not.toHaveBeenCalled();
    });

    it("logs the reason for a refusal and never the credential", async () => {
      const warned = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => undefined);
      jwtService.verifyAsync.mockResolvedValue({
        sub: "user-uuid-123",
        sessionId: "session-gone",
        type: "access",
      });
      usersService.isSessionLive.mockResolvedValue(false);

      await gateway.handleConnection(mockClient);

      const logged = warned.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("Session has been revoked");
      expect(logged).not.toContain("valid-token");
      warned.mockRestore();
    });
  });

  describe("handleDisconnect", () => {
    it("should handle client disconnect cleanly", () => {
      expect(() => gateway.handleDisconnect(mockClient)).not.toThrow();
    });
  });

  describe("notifySyncInvalidation", () => {
    it("sends one invalidation to the account room, payload and all", () => {
      gateway.notifySyncInvalidation("user-uuid-123", "device-uuid-456", "105");

      expect(mockServer.to).toHaveBeenCalledWith("user:user-uuid-123");
      expect(broadcastEmit).toHaveBeenCalledWith(
        "sync:invalidation",
        expect.objectContaining({
          userId: "user-uuid-123",
          originDeviceId: "device-uuid-456",
          highestCursor: "105",
        }),
      );
    });

    it("delivers each invalidation once per device", () => {
      // `server.to(room)` already reaches every socket of the account, origin
      // included, so no socket may also be emitted to directly. A device that
      // hears the event twice pulls twice, and nothing on the client can tell
      // the second one from a change it has not seen yet.
      gateway.notifySyncInvalidation("user-uuid-123", "device-uuid-456", "105");

      expect(broadcastEmit).toHaveBeenCalledTimes(1);
      expect(mockClient.emit).not.toHaveBeenCalled();
      expect(mockOtherClient.emit).not.toHaveBeenCalled();
    });

    it("names the origin device in the payload rather than filtering sockets", () => {
      gateway.notifySyncInvalidation("user-uuid-789");

      expect(broadcastEmit).toHaveBeenCalledWith(
        "sync:invalidation",
        expect.objectContaining({
          userId: "user-uuid-789",
          highestCursor: "0",
        }),
      );
      expect(mockClient.emit).not.toHaveBeenCalled();
    });

    it("is a no-op before the server is bound", () => {
      const unbound = Object.assign(mockClient, {});
      void unbound;
      gateway.server = undefined as any;

      expect(() =>
        gateway.notifySyncInvalidation("user-uuid-123", "device-uuid-456", "7"),
      ).not.toThrow();
      expect(broadcastEmit).not.toHaveBeenCalled();
    });
  });
});
