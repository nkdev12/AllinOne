import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { JwtService } from "@nestjs/jwt";
import { ConfigurationService } from "@/config/configuration.service";

export interface AuthenticatedSocket extends Socket {
  data: {
    userId: string;
    deviceId?: string;
  };
}

@WebSocketGateway({
  namespace: "/sync",
  cors: {
    origin: "*",
  },
})
export class SyncGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(SyncGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigurationService,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace("Bearer ", "") ||
        (client.handshake.query?.token as string);

      if (!token) {
        this.logger.warn(
          `[SyncGateway] Connection rejected from ${client.id}: Missing access token.`,
        );
        client.disconnect(true);
        return;
      }

      const payload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.jwtAccessSecret,
      });

      const userId = payload.sub;
      const deviceId =
        payload.deviceId || (client.handshake.query?.deviceId as string);

      client.data = { userId, deviceId };

      const userRoom = `user:${userId}`;
      client.join(userRoom);

      this.logger.log(
        `[SyncGateway] Client connected: ${client.id} (User: ${userId}, Device: ${deviceId || "N/A"}) joined room ${userRoom}`,
      );
    } catch (error: any) {
      this.logger.warn(
        `[SyncGateway] Connection authentication failed from ${client.id}: ${error?.message || error}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    const userId = client.data?.userId;
    this.logger.log(
      `[SyncGateway] Client disconnected: ${client.id} (User: ${userId || "Unauthenticated"})`,
    );
  }

  /**
   * Broadcast a real-time sync invalidation notification to all active devices for a user.
   * Optionally skips the originating device.
   */
  notifySyncInvalidation(
    userId: string,
    originDeviceId?: string,
    highestCursor?: string,
  ) {
    if (!this.server) {
      this.logger.warn(
        "[SyncGateway] WebSocket server instance not initialized.",
      );
      return;
    }

    const payload = {
      userId,
      originDeviceId,
      highestCursor: highestCursor || "0",
      timestamp: new Date().toISOString(),
    };

    const userRoom = `user:${userId}`;

    // Broadcast across instances to user room via Socket.IO adapter
    this.server.to(userRoom).emit("sync:invalidation", payload);

    // Also dispatch directly to local non-origin sockets
    if (originDeviceId) {
      const roomSockets = this.server.sockets?.adapter?.rooms?.get(userRoom);
      if (roomSockets) {
        for (const socketId of roomSockets) {
          const socket = this.server.sockets?.sockets?.get(
            socketId,
          ) as AuthenticatedSocket;
          if (socket && socket.data?.deviceId !== originDeviceId) {
            socket.emit("sync:invalidation", payload);
          }
        }
      }
    }

    this.logger.log(
      `[SyncGateway] Emitted sync:invalidation signal for User ${userId} (Origin Device: ${originDeviceId || "Server"})`,
    );
  }
}
