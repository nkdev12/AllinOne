import { Test, TestingModule } from "@nestjs/testing";
import { SyncGateway } from "./sync.gateway";
import { JwtService } from "@nestjs/jwt";
import { ConfigurationService } from "@/config/configuration.service";

describe("SyncGateway", () => {
  let gateway: SyncGateway;
  let jwtService: any;
  let configService: any;
  let mockClient: any;
  let mockOtherClient: any;
  let broadcastEmit: jest.Mock;
  let mockServer: any;

  beforeEach(async () => {
    jwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: "user-uuid-123",
        deviceId: "device-uuid-456",
      }),
    };

    configService = {
      jwtAccessSecret: "access-secret",
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

    it("should disconnect client if access token is missing", async () => {
      mockClient.handshake.auth.token = undefined;

      await gateway.handleConnection(mockClient);

      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
    });

    it("should disconnect client if JWT verification fails", async () => {
      jwtService.verifyAsync.mockRejectedValue(new Error("Invalid token"));

      await gateway.handleConnection(mockClient);

      expect(mockClient.disconnect).toHaveBeenCalledWith(true);
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
  });
});
