import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Logger, Optional } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { JwtService } from "@nestjs/jwt";
import { ConfigurationService } from "@/config/configuration.service";
import { UsersService } from "@/users/users.service";

export interface AuthenticatedSocket extends Socket {
  data: {
    userId: string;
    deviceId?: string;
  };
}

/**
 * No `cors` here on purpose.
 *
 * Decorator metadata is evaluated when this file is imported, long before
 * `ConfigurationService` exists, so any origin list written here would be a
 * literal — and the literal it used to carry was `"*"`, which decided the
 * namespace's policy for every deployment. The policy now lives in
 * `SyncIoAdapter` (src/sync/adapters/sync-io.adapter.ts), which builds the
 * Socket.IO server from `WS_CORS_ORIGINS` / `CORS_ORIGINS` / `CORS_ORIGIN` at
 * boot and overrides whatever options this decorator does pass.
 */
@WebSocketGateway({
  namespace: "/sync",
})
export class SyncGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(SyncGateway.name);

  @WebSocketServer()
  server!: Server;

  /**
   * `@Optional()` so a module compiled without `UsersModule` (a unit test, the
   * queue worker) still constructs this class — but see `revalidate()`: a
   * gateway that cannot revalidate refuses the connection rather than falling
   * back to trusting the signature alone.
   */
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigurationService,
    @Optional() private readonly usersService?: UsersService,
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

      // A signature says who the token was minted for, not who is allowed to be
      // here now. The REST path asks the second question in `JwtStrategy.validate`
      // — account still ACTIVE and not deleted, session still live — and a socket
      // that skips it keeps receiving this account's data for the remaining
      // lifetime of a token its owner has already revoked. So ask it here too,
      // before the room join.
      const rejection = await this.revalidate(userId, payload);
      if (rejection) {
        // The reason only. Never the token: this log line is written on a
        // request that just failed authentication, and the credential in it is
        // still valid for everything else the account can do.
        this.logger.warn(
          `[SyncGateway] Connection rejected from ${client.id} (User: ${userId || "unknown"}): ${rejection}.`,
        );
        client.disconnect(true);
        return;
      }

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

  /**
   * The same two questions `JwtStrategy.validate()` asks, answered the same way,
   * and returning a reason instead of throwing so the one caller decides how to
   * log it.
   *
   * Deliberately tolerant about *which* claims a token carries and strict about
   * what it concludes from them: the session-claim work in `src/auth` is moving
   * under us, so a missing session id is treated the way `JwtStrategy` treats it
   * (a token minted before sessions were stamped, which keeps working), while a
   * missing user, a disabled account or a lookup that could not be answered all
   * refuse the socket.
   */
  private async revalidate(
    userId: string | undefined,
    payload: any,
  ): Promise<string | null> {
    if (!userId) {
      return "Token carries no subject";
    }

    const users = this.usersService;
    if (!users || typeof users.getUserById !== "function") {
      return "Account revalidation is unavailable";
    }

    if (!payload || typeof payload !== "object") {
      return "Token payload is unreadable";
    }

    const user = await users.getUserById(userId);
    if (!user) {
      return "Account not found";
    }
    if (user.status !== "ACTIVE") {
      return "Account is not active";
    }
    if (user.deletedAt) {
      return "Account is deleted";
    }

    // `sessionId` is the claim `JwtStrategy` reads; `sid` and `session` are the
    // names the session-token work in `src/auth` has used for the same thing, so
    // a token minted either way is checked rather than waved through. A token
    // with none of them keeps connecting, exactly as the REST path allows it to.
    const sessionId = readSessionClaim(payload);
    if (sessionId && typeof users.isSessionLive === "function") {
      const live = await users.isSessionLive(userId, sessionId);
      if (!live) {
        return "Session has been revoked or no longer exists";
      }
    }

    return null;
  }

  handleDisconnect(client: AuthenticatedSocket) {
    const userId = client.data?.userId;
    this.logger.log(
      `[SyncGateway] Client disconnected: ${client.id} (User: ${userId || "Unauthenticated"})`,
    );
  }

  /**
   * Broadcast a real-time sync invalidation notification to all active devices
   * for a user.
   *
   * `server.to(room)` is the whole delivery: it reaches every socket in the
   * account's room on every instance, which includes the device that just
   * pushed. `originDeviceId` travels inside the payload so a client can tell its
   * own writes apart if it wants to; filtering sockets here would be a guess
   * about what each device has already read, and the pull that follows is not —
   * it asks from the device's own checkpoint and the version guard decides.
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

    this.server.to(userRoom).emit("sync:invalidation", payload);

    this.logger.log(
      `[SyncGateway] Emitted sync:invalidation signal for User ${userId} (Origin Device: ${originDeviceId || "Server"})`,
    );
  }
}

/**
 * The session id a token names, from whichever claim currently carries it.
 *
 * Reads rather than asserts: `src/auth` owns the token contract and is changing
 * how sessions are stamped into it, and this file must not be the thing that
 * decides a claim is missing when it only moved. A token with no session claim
 * at all is not a defect — `JwtStrategy` lets those through for the same reason
 * — so this returns `undefined` and the caller skips the liveness question.
 */
function readSessionClaim(payload: any): string | undefined {
  for (const claim of ["sessionId", "sid", "session"]) {
    const value = payload[claim];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
