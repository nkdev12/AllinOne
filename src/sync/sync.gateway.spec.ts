import { Test, TestingModule } from "@nestjs/testing";
import { SyncGateway } from "./sync.gateway";
import { JwtService } from "@nestjs/jwt";
import { ConfigurationService } from "@/config/configuration.service";

describe("SyncGateway", () => {
  let gateway: SyncGateway;
  let jwtService: any;
  let configService: any;
  let mockClient: any;
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

    mockServer = {
      to: jest.fn().mockReturnValue({
        emit: jest.fn(),
      }),
      sockets: {
        adapter: {
          rooms: new Map([["user:user-uuid-123", new Set(["socket-1"])]]),
        },
        sockets: new Map([["socket-1", mockClient]]),
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
    it("should broadcast sync:invalidation to user room", () => {
      gateway.notifySyncInvalidation("user-uuid-123", undefined, "105");

      expect(mockServer.to).toHaveBeenCalledWith("user:user-uuid-123");
    });

    it("should skip origin device when emitting invalidations", () => {
      gateway.notifySyncInvalidation(
        "user-uuid-123",
        "other-device-789",
        "105",
      );

      expect(mockClient.emit).toHaveBeenCalledWith(
        "sync:invalidation",
        expect.objectContaining({
          userId: "user-uuid-123",
          highestCursor: "105",
        }),
      );
    });
  });
});
