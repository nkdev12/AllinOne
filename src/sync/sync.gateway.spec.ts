import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { SESSION_REVALIDATION_INTERVAL_MS, SyncGateway } from "./sync.gateway";
import { JwtService } from "@nestjs/jwt";
import { ConfigurationService } from "@/config/configuration.service";
import { UsersService, type SocketAccessState } from "@/users/users.service";

describe("SyncGateway", () => {
  let gateway: SyncGateway;
  let jwtService: any;
  let configService: any;
  let usersService: {
    getUserById: jest.Mock;
    isSessionLive: jest.Mock;
    getSocketAccessStates: jest.Mock;
  };
  let mockClient: any;
  let mockOtherClient: any;
  let broadcastEmit: jest.Mock;
  let mockServer: any;

  const USER_ID = "user-uuid-123";
  const SESSION_ID = "session-1";

  const ACTIVE_USER = {
    id: USER_ID,
    email: "someone@example.com",
    status: "ACTIVE",
    deletedAt: null,
  };

  /** What `getSocketAccessStates()` answers for an account that is all fine. */
  const liveState = (overrides: Partial<SocketAccessState> = {}) => ({
    accountReadable: true,
    liveSessionIds: [SESSION_ID],
    revokedDeviceIds: [],
    ...overrides,
  });

  /** A socket already inside a room, which is what the sweep iterates. */
  const connectedSocket = (
    id: string,
    data: { userId: string; sessionId?: string; deviceId?: string },
  ) => ({
    id,
    data,
    join: jest.fn(),
    leave: jest.fn(),
    disconnect: jest.fn(),
    emit: jest.fn(),
    handshake: { auth: {}, headers: {}, query: {} },
  });

  beforeEach(async () => {
    jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: USER_ID,
        deviceId: "device-uuid-456",
        sessionId: SESSION_ID,
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
      getSocketAccessStates: jest
        .fn()
        .mockImplementation(
          async (userIds: readonly string[]) =>
            new Map(userIds.map((userId) => [userId, liveState()])),
        ),
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
      leave: jest.fn(),
      disconnect: jest.fn(),
      emit: jest.fn(),
    };

    // A second socket for the same account, on a different device: the case the
    // invalidation exists for.
    mockOtherClient = {
      id: "socket-2",
      handshake: { auth: {}, headers: {}, query: {} },
      data: { userId: USER_ID, deviceId: "device-uuid-777" },
      join: jest.fn(),
      leave: jest.fn(),
      disconnect: jest.fn(),
      emit: jest.fn(),
    };

    broadcastEmit = jest.fn();
    mockServer = {
      to: jest.fn().mockReturnValue({ emit: broadcastEmit }),
      sockets: {
        adapter: {
          rooms: new Map([
            [`user:${USER_ID}`, new Set([mockClient.id, mockOtherClient.id])],
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
      // `sessionId` belongs on the socket: the sweep that evicts a revoked session
      // can only ask the question if the handshake recorded which session it let in.
      expect(mockClient.data).toEqual({
        userId: USER_ID,
        deviceId: "device-uuid-456",
        sessionId: SESSION_ID,
      });
      expect(mockClient.join).toHaveBeenCalledWith(`user:${USER_ID}`);
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
      expect(mockClient.join).toHaveBeenCalledWith(`user:${USER_ID}`);
    });

    it("should authenticate client when token is in query string", async () => {
      mockClient.handshake.auth = {};
      mockClient.handshake.headers = {};
      mockClient.handshake.query.token = "valid-query-token";

      await gateway.handleConnection(mockClient);

      expect(jwtService.verifyAsync).toHaveBeenCalledWith("valid-query-token", {
        secret: "access-secret",
      });
      expect(mockClient.join).toHaveBeenCalledWith(`user:${USER_ID}`);
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
        sub: USER_ID,
        sessionId: SESSION_ID,
        type: "access",
      });

      await gateway.handleConnection(mockClient);

      expect(usersService.getUserById).toHaveBeenCalledWith(USER_ID);
      expect(usersService.isSessionLive).toHaveBeenCalledWith(
        USER_ID,
        SESSION_ID,
      );
      expect(mockClient.join).toHaveBeenCalledWith(`user:${USER_ID}`);
      expect(mockClient.disconnect).not.toHaveBeenCalled();
    });

    it("disconnects a token with purpose (e.g. MFA_CHALLENGE)", async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: USER_ID,
        sessionId: SESSION_ID,
        type: "access",
        purpose: "MFA_CHALLENGE",
      });

      await gateway.handleConnection(mockClient);

      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
      expect(mockClient.join).not.toHaveBeenCalled();
    });

    it("disconnects a token whose type is not access", async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: USER_ID,
        type: "mfa_challenge",
      });

      await gateway.handleConnection(mockClient);

      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
      expect(mockClient.join).not.toHaveBeenCalled();
    });

    it("disconnects a revoked session", async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: USER_ID,
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

    it("refuses a token that names no session instead of skipping the question", async () => {
      // This used to be a documented pass — the comment claimed `JwtStrategy`
      // allowed it — and the claim was stale: `validate()` requires the claim now,
      // because a token nothing can point at is a token nothing can revoke.
      // Admitting it here would leave the gateway the one door still open to an
      // account whose owner cannot revoke what holds it open.
      jwtService.verifyAsync.mockResolvedValue({
        sub: USER_ID,
        deviceId: "device-uuid-456",
        type: "access",
      });

      await gateway.handleConnection(mockClient);

      expect(usersService.getUserById).not.toHaveBeenCalled();
      expect(usersService.isSessionLive).not.toHaveBeenCalled();
      expect(mockClient.join).not.toHaveBeenCalled();
      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
      expect(mockClient.emit).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({
          subCode: "SESSION_REJECTED",
          message: "Unauthorized: Token names no session",
        }),
      );
    });

    it("refuses a session claim that is not a session id", async () => {
      // The claim's name is not a negotiation any more, so a differently shaped
      // one is a token this gateway cannot revalidate rather than a hint to guess.
      jwtService.verifyAsync.mockResolvedValue({
        sub: USER_ID,
        sid: SESSION_ID,
        type: "access",
      });

      await gateway.handleConnection(mockClient);

      expect(usersService.isSessionLive).not.toHaveBeenCalled();
      expect(mockClient.join).not.toHaveBeenCalled();
      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
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
        sub: USER_ID,
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

  /**
   * The handshake answers once; a revocation lands later. Nothing in this repo
   * called `disconnectSockets()` or `socketsLeave()`, so `AuthService` logout,
   * `UsersService.revokeUserSession` and `DevicesService.revokeDevice` all left a
   * socket in `user:<id>` receiving `sync:invalidation` — which names the account
   * and how much data is waiting for it — until the access token expired by
   * itself. `revalidateConnectedSockets()` is what closes that window.
   */
  describe("revalidateConnectedSockets", () => {
    let revoked: any;
    let survivor: any;

    beforeEach(() => {
      revoked = connectedSocket("socket-revoked", {
        userId: USER_ID,
        sessionId: "session-revoked",
        deviceId: "device-uuid-456",
      });
      survivor = connectedSocket("socket-live", {
        userId: USER_ID,
        sessionId: SESSION_ID,
        deviceId: "device-uuid-777",
      });
      mockServer.sockets.sockets = new Map([
        [revoked.id, revoked],
        [survivor.id, survivor],
      ]);
    });

    it("disconnects a socket whose session was revoked after the handshake, and leaves the live one alone", async () => {
      usersService.getSocketAccessStates.mockResolvedValue(
        new Map([[USER_ID, liveState({ liveSessionIds: [SESSION_ID] })]]),
      );

      await expect(gateway.revalidateConnectedSockets()).resolves.toBe(1);

      expect(revoked.leave).toHaveBeenCalledWith(`user:${USER_ID}`);
      expect(revoked.disconnect).toHaveBeenCalledWith(true);
      expect(revoked.emit).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({
          code: "UNAUTHORIZED",
          subCode: "SESSION_REVOKED",
        }),
      );

      expect(survivor.disconnect).not.toHaveBeenCalled();
      expect(survivor.leave).not.toHaveBeenCalled();
    });

    it("evicts by device id, so revoking one device does not drop the account's other sessions", async () => {
      usersService.getSocketAccessStates.mockResolvedValue(
        new Map([
          [
            USER_ID,
            liveState({
              liveSessionIds: [SESSION_ID, "session-revoked"],
              revokedDeviceIds: ["device-uuid-456"],
            }),
          ],
        ]),
      );

      await gateway.revalidateConnectedSockets();

      expect(revoked.disconnect).toHaveBeenCalledWith(true);
      expect(survivor.disconnect).not.toHaveBeenCalled();
    });

    it("evicts a socket whose account stopped being readable", async () => {
      usersService.getSocketAccessStates.mockResolvedValue(
        new Map([
          [
            USER_ID,
            liveState({
              accountReadable: false,
              liveSessionIds: [SESSION_ID, "session-revoked"],
            }),
          ],
        ]),
      );

      await expect(gateway.revalidateConnectedSockets()).resolves.toBe(2);
      expect(revoked.disconnect).toHaveBeenCalledWith(true);
      expect(survivor.disconnect).toHaveBeenCalledWith(true);
    });

    it("evicts a socket that carries no session to check", async () => {
      const orphan = connectedSocket("socket-no-session", { userId: USER_ID });
      mockServer.sockets.sockets = new Map([[orphan.id, orphan]]);

      await expect(gateway.revalidateConnectedSockets()).resolves.toBe(1);
      expect(orphan.disconnect).toHaveBeenCalledWith(true);
    });

    it("asks once per distinct account rather than once per socket", async () => {
      const third = connectedSocket("socket-third", {
        userId: USER_ID,
        sessionId: SESSION_ID,
      });
      mockServer.sockets.sockets = new Map([
        [revoked.id, revoked],
        [survivor.id, survivor],
        [third.id, third],
      ]);

      await gateway.revalidateConnectedSockets();

      expect(usersService.getSocketAccessStates).toHaveBeenCalledTimes(1);
      expect(usersService.getSocketAccessStates).toHaveBeenCalledWith([
        USER_ID,
      ]);
    });

    it("splits many accounts into bounded batches", async () => {
      const sockets = new Map<string, any>();
      for (let index = 0; index < 250; index += 1) {
        const userId = `user-${index}`;
        const socket = connectedSocket(`socket-${index}`, {
          userId,
          sessionId: SESSION_ID,
        });
        sockets.set(socket.id, socket);
      }
      mockServer.sockets.sockets = sockets;

      await gateway.revalidateConnectedSockets();

      const batches = usersService.getSocketAccessStates.mock.calls.map(
        ([ids]) => ids.length,
      );
      expect(batches).toEqual([200, 50]);
    });

    it("keeps every socket when the state lookup cannot be answered", async () => {
      // Fail-open on purpose: a database blip is not a revocation, and treating it
      // as one would drop every device in the deployment at once. The handshake
      // fails closed because it has no connection to protect.
      const errored = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      usersService.getSocketAccessStates.mockRejectedValue(
        new Error("db down"),
      );

      await expect(gateway.revalidateConnectedSockets()).resolves.toBe(0);

      expect(revoked.disconnect).not.toHaveBeenCalled();
      expect(survivor.disconnect).not.toHaveBeenCalled();
      expect(errored).toHaveBeenCalled();
      errored.mockRestore();
    });

    it("does not stack sweeps", async () => {
      let release: (value: Map<string, SocketAccessState>) => void = () => {};
      usersService.getSocketAccessStates.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );

      const first = gateway.revalidateConnectedSockets();
      await expect(gateway.revalidateConnectedSockets()).resolves.toBe(0);
      expect(usersService.getSocketAccessStates).toHaveBeenCalledTimes(1);

      release(new Map([[USER_ID, liveState()]]));
      await expect(first).resolves.toBe(1);
    });

    it("ignores sockets that never authenticated", async () => {
      const anonymous = connectedSocket("socket-anon", { userId: "" });
      mockServer.sockets.sockets = new Map([[anonymous.id, anonymous]]);

      await expect(gateway.revalidateConnectedSockets()).resolves.toBe(0);
      expect(usersService.getSocketAccessStates).not.toHaveBeenCalled();
      expect(anonymous.disconnect).not.toHaveBeenCalled();
    });

    it("says so once, rather than silently keeping sockets, when no state lookup exists", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SyncGateway,
          { provide: JwtService, useValue: jwtService },
          { provide: ConfigurationService, useValue: configService },
        ],
      }).compile();

      const withoutUsers = module.get<SyncGateway>(SyncGateway);
      withoutUsers.server = mockServer;
      const warned = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => undefined);

      await expect(withoutUsers.revalidateConnectedSockets()).resolves.toBe(0);
      expect(warned).toHaveBeenCalled();
      expect(revoked.disconnect).not.toHaveBeenCalled();
      warned.mockRestore();
    });

    it("is a no-op before the server is bound", async () => {
      gateway.server = undefined as any;

      await expect(gateway.revalidateConnectedSockets()).resolves.toBe(0);
      expect(usersService.getSocketAccessStates).not.toHaveBeenCalled();
    });
  });

  describe("the sweep's timer", () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("arms on the documented interval, runs the sweep, and is cleared on destroy", async () => {
      // Cleared first so the assertions below are about this call, whatever the
      // module lifecycle already did with the real timers.
      gateway.onModuleDestroy();

      const timer = { unref: jest.fn() };
      const armed = jest
        .spyOn(globalThis, "setInterval")
        .mockReturnValue(timer as any);
      const cleared = jest
        .spyOn(globalThis, "clearInterval")
        .mockImplementation(() => undefined);
      const sweep = jest
        .spyOn(gateway, "revalidateConnectedSockets")
        .mockResolvedValue(0);

      gateway.onModuleInit();

      expect(armed).toHaveBeenCalledWith(
        expect.any(Function),
        SESSION_REVALIDATION_INTERVAL_MS,
      );
      // An `unref()`ed handle means a gateway that is the only thing holding the
      // process open — a test run, the queue worker — is not the reason it is.
      expect(timer.unref).toHaveBeenCalled();

      (armed.mock.calls[0][0] as () => void)();
      expect(sweep).toHaveBeenCalled();

      // A second init must not stack a second sweep on the same instance.
      gateway.onModuleInit();
      expect(armed).toHaveBeenCalledTimes(1);

      gateway.onModuleDestroy();
      expect(cleared).toHaveBeenCalledWith(timer);
    });

    it("survives a sweep that throws, so one bad minute is not a dead timer", async () => {
      gateway.onModuleDestroy();

      const timer = { unref: jest.fn() };
      const armed = jest
        .spyOn(globalThis, "setInterval")
        .mockReturnValue(timer as any);
      jest
        .spyOn(gateway, "revalidateConnectedSockets")
        .mockRejectedValue(new Error("unexpected"));
      const errored = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);

      gateway.onModuleInit();
      (armed.mock.calls[0][0] as () => void)();
      await Promise.resolve();
      await Promise.resolve();

      // Caught and logged rather than thrown: the interval keeps running, and the
      // failure that would otherwise be a silent gap in revalidation is in the log.
      expect(errored).toHaveBeenCalledWith(
        expect.stringContaining("Socket revalidation threw"),
      );
      expect(timer.unref).toHaveBeenCalled();
    });
  });

  describe("handleDisconnect", () => {
    it("should handle client disconnect cleanly", () => {
      expect(() => gateway.handleDisconnect(mockClient)).not.toThrow();
    });
  });

  describe("notifySyncInvalidation", () => {
    it("sends one invalidation to the account room, payload and all", () => {
      gateway.notifySyncInvalidation(USER_ID, "device-uuid-456", "105");

      expect(mockServer.to).toHaveBeenCalledWith(`user:${USER_ID}`);
      expect(broadcastEmit).toHaveBeenCalledWith(
        "sync:invalidation",
        expect.objectContaining({
          userId: USER_ID,
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
      gateway.notifySyncInvalidation(USER_ID, "device-uuid-456", "105");

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
        gateway.notifySyncInvalidation(USER_ID, "device-uuid-456", "7"),
      ).not.toThrow();
      expect(broadcastEmit).not.toHaveBeenCalled();
    });
  });
});
