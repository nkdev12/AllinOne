import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import {
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { JwtService } from "@nestjs/jwt";
import { ConfigurationService } from "@/config/configuration.service";
import { UsersService, type SocketAccessState } from "@/users/users.service";

interface AuthenticatedSocket extends Socket {
  data: {
    userId: string;
    deviceId?: string;
    sessionId?: string;
  };
}

/**
 * How often every connected socket is asked again what the handshake asked once.
 *
 * The number is a trade, not a constant from a textbook. The window it closes is
 * the access token's lifetime — a revoked session used to keep its room
 * subscription, and so kept receiving `sync:invalidation` payloads that tell a
 * device when to come and pull, until the token expired on its own — and a sweep
 * is what turns "until the token expires" into "until the next sweep". Against
 * that, the sweep's cost is three indexed queries per batch of accounts per
 * instance per interval, whatever the socket count, because
 * `UsersService.getSocketAccessStates()` answers for many accounts at once. At
 * sixty seconds that is three queries a minute: nothing on the database, and
 * nothing on Redis, which this gateway's adapter would rather keep for the
 * pub/sub fan-out it exists for.
 *
 * Fifty times more often than that (a bit under two seconds) would still be only
 * ~150 queries a minute and would cut the window to two seconds — and would also
 * mean a sweep is more likely to overlap itself than to finish, on a deployment
 * whose whole reason for a socket layer is devices on mobile networks. Ten minutes
 * would be cheaper and would leave almost the entire token lifetime unpoliced,
 * which is most of the finding. Sixty seconds is where the two sides are closest
 * to even: a minute of stale entitlement against a query load no operator will
 * ever graph.
 */
export const SESSION_REVALIDATION_INTERVAL_MS = 60_000;

/** Accounts per `getSocketAccessStates()` call, which bounds one `in` list. */
const REVALIDATION_ACCOUNT_BATCH = 200;

/**
 * Why no `sessionId` claim is a refusal rather than a pass.
 *
 * `JwtStrategy.validate()` (`src/auth/strategies/jwt.strategy.ts`) requires the
 * claim now — a token that cannot name a session cannot be revoked, and letting it
 * through was the logout bypass this whole file is meant to close — so an access
 * token in circulation either carries `sessionId` or already authenticates as
 * nothing on the REST path. A gateway that admitted the second kind would be the
 * only door left open to an account's data, which is why `revalidate()` refuses it
 * — and why `revalidateConnectedSockets()` evicts a socket that cannot name a
 * session instead of sweeping past it.
 *
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
export class SyncGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  private readonly logger = new Logger(SyncGateway.name);

  @WebSocketServer()
  server!: Server;

  private sweepTimer?: ReturnType<typeof setInterval>;

  /** A sweep that has not finished blocks the next one rather than stacking. */
  private sweeping = false;

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

  /**
   * Arms the periodic revalidation. Nest calls this on `app.init()`, which both
   * `main.ts` and `SyncIoAdapter`'s boot path reach, and the handle is `unref()`ed
   * so a gateway that is the only thing keeping the process alive — a test run, a
   * worker — is not the reason it does not exit.
   */
  onModuleInit(): void {
    if (this.sweepTimer) return;

    this.sweepTimer = setInterval(() => {
      this.revalidateConnectedSockets().catch((error: any) => {
        // The sweep already fails open on its own errors; this is the guard
        // against a throw it did not expect — an uncaught rejection here would
        // take the interval, and with it every later revalidation, down with it.
        this.logger.error(
          `[SyncGateway] Socket revalidation threw and was skipped: ${error?.message ?? error}`,
        );
      });
    }, SESSION_REVALIDATION_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * Safely rejects an unauthenticated or unauthorized connection.
   *
   * In Socket.IO, `connect_error` is a reserved event name that throws a fatal
   * exception when emitted via `socket.emit()`. We emit standard `error` event
   * instead, which client-side listeners handle, wrapped in a try/catch so an emit
   * failure never crashes the server process.
   */
  private rejectConnection(
    client: AuthenticatedSocket,
    payload: {
      message: string;
      code: string;
      subCode?: string;
      details?: any;
    },
  ): void {
    try {
      client.emit("error", payload);
    } catch (err: any) {
      this.logger.debug(
        `[SyncGateway] Failed to emit error event to ${client.id}: ${err?.message || err}`,
      );
    }
    client.disconnect(true);
  }

  /**
   * Robustly extracts the bearer access token from auth payload, authorization headers,
   * or query string.
   */
  private extractToken(client: AuthenticatedSocket): string | undefined {
    const auth = client.handshake.auth;
    if (
      auth &&
      typeof auth === "object" &&
      typeof auth.token === "string" &&
      auth.token.trim()
    ) {
      return auth.token.trim();
    }

    const authHeader = client.handshake.headers?.authorization;
    if (typeof authHeader === "string") {
      const match = authHeader.match(/^Bearer\s+(.*?)$/i);
      if (match && match[1]) {
        return match[1].trim();
      }
      if (authHeader.trim()) {
        return authHeader.trim();
      }
    }

    const queryToken = client.handshake.query?.token;
    if (typeof queryToken === "string" && queryToken.trim()) {
      return queryToken.trim();
    }

    return undefined;
  }

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const token = this.extractToken(client);

      if (!token) {
        this.logger.warn(
          `[SyncGateway] Connection rejected from ${client.id}: Missing access token.`,
        );
        this.rejectConnection(client, {
          message: "Unauthorized: Missing access token",
          code: "UNAUTHORIZED",
          subCode: "MISSING_TOKEN",
        });
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
      // before the room join, and ask it again on a timer: see
      // `SESSION_REVALIDATION_INTERVAL_MS` and `revalidateConnectedSockets()`,
      // because a revocation that lands after this handshake would otherwise be
      // invisible until the token expired by itself.
      const rejection = await this.revalidate(userId, payload);
      if (rejection) {
        // The reason only. Never the token: this log line is written on a
        // request that just failed authentication, and the credential in it is
        // still valid for everything else the account can do.
        this.logger.warn(
          `[SyncGateway] Connection rejected from ${client.id} (User: ${userId || "unknown"}): ${rejection}.`,
        );
        this.rejectConnection(client, {
          message: `Unauthorized: ${rejection}`,
          code: "UNAUTHORIZED",
          subCode: "SESSION_REJECTED",
        });
        return;
      }

      // `sessionId` is kept on the socket for the same reason the handshake asked
      // for it: the sweep has to answer "is this still the session this socket was
      // admitted under", and a socket that cannot say which session it stands for
      // cannot be revoked at all.
      client.data = { userId, deviceId, sessionId: payload.sessionId };

      const userRoom = `user:${userId}`;
      client.join(userRoom);

      this.logger.log(
        `[SyncGateway] Client connected: ${client.id} (User: ${userId}, Device: ${deviceId || "N/A"}) joined room ${userRoom}`,
      );
    } catch (error: any) {
      const isExpired =
        error?.name === "TokenExpiredError" ||
        error?.message?.toLowerCase().includes("expired");

      this.logger.warn(
        `[SyncGateway] Connection authentication failed from ${client.id}: ${error?.message || error}`,
      );
      this.rejectConnection(client, {
        message: isExpired
          ? "Unauthorized: Token expired"
          : "Unauthorized: Invalid or expired token",
        code: "UNAUTHORIZED",
        subCode: isExpired ? "TOKEN_EXPIRED" : "INVALID_TOKEN",
        details: error?.message,
      });
    }
  }

  /**
   * The same questions `JwtStrategy.validate()` asks of an access token, answered
   * the same way, returning a reason instead of throwing so the one caller decides
   * how to log it.
   *
   * Today's access token is `{ sub, email, sessionId, type: "access" }` (see
   * `AuthService.generateTokens`), and the session claim is one of the answers, not
   * a nicety: `JwtStrategy` refuses a token that cannot name a session, because a
   * token nothing can point at is a token nothing can revoke. This file used to
   * treat the same token as fine — and its comment claimed the REST path did too,
   * which stopped being true when the session-claim work in `src/auth` closed that
   * pass. The skip was a hole rather than tolerance: an account could mint nothing
   * revocable and hold a socket open indefinitely, so the refusal is here now, and
   * the sweep evicts a socket that reaches it without a session rather than letting
   * the absence stand for approval.
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

    if (payload.type !== "access" || payload.purpose) {
      return "Only access tokens may connect to sync gateway";
    }

    if (typeof payload.sessionId !== "string" || !payload.sessionId) {
      return "Token names no session";
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

    if (typeof users.isSessionLive !== "function") {
      return "Session revalidation is unavailable";
    }

    const live = await users.isSessionLive(userId, payload.sessionId);
    if (!live) {
      return "Session has been revoked or no longer exists";
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
   * Asks every connected socket, again, whether it is still allowed to be here, and
   * evicts the ones that are not.
   *
   * The handshake check above decides who may join the account's room; nothing about
   * a socket is re-decided after that, which is why revoking a session
   * (`AuthService`, `UsersService.revokeUserSession`, `DevicesService.revokeDevice`)
   * left the socket connected: those paths write `revokedAt` and stop, and no code in
   * this repo called `disconnectSockets()` or `socketsLeave()`. The revoked or
   * suspended device therefore kept its room subscription and kept receiving the
   * `sync:invalidation` payloads this gateway emits — each one carrying the account's
   * `userId` and `highestCursor`, which tells a device that it has data to come and
   * fetch, and how much of it there is to fetch.
   *
   * Eviction is `leave(room)` before `disconnect(true)`: leaving first means a socket
   * cannot be reached by a `server.to(room)` broadcast that is already in flight on
   * another instance through the Redis adapter, and `disconnect(true)` closes it for
   * good instead of inviting the client's automatic reconnect to walk back in through
   * the handshake — which would refuse it now, but only after it has asked again.
   *
   * A sweep that cannot get an answer keeps its sockets. Refusing to act on a missing
   * lookup is the opposite of the handshake's fail-closed rule, deliberately: the
   * handshake has no connection to protect and should not open one it cannot vet,
   * while a sweep that treats a database blip as a revocation would drop every device
   * in the deployment at once, and the entitlement it is protecting is only ever a
   * minute of `sync:invalidation` payloads. The next sweep asks again.
   *
   * Each instance sweeps the sockets it holds — which is the right scope: rooms are
   * membership on the adapter, but a socket only exists on one process, and this is
   * the only place that can close it.
   *
   * Returns the number of sockets evicted, for the log line and for the tests.
   */
  async revalidateConnectedSockets(): Promise<number> {
    const sockets = this.server?.sockets?.sockets;
    if (!sockets || this.sweeping) return 0;

    const connected = [...sockets.values()].filter(
      (socket) => (socket as AuthenticatedSocket).data?.userId,
    ) as unknown as AuthenticatedSocket[];
    if (connected.length === 0) return 0;

    const users = this.usersService;
    if (!users || typeof users.getSocketAccessStates !== "function") {
      this.logger.warn(
        "[SyncGateway] Cannot revalidate connected sockets: no account-state lookup available.",
      );
      return 0;
    }

    this.sweeping = true;
    let evicted = 0;

    try {
      const accountIds = [
        ...new Set(connected.map((socket) => socket.data.userId)),
      ];
      const states = new Map<string, SocketAccessState>();

      // Batched by distinct account, not per socket: five hundred devices on one
      // account cost one slice of three queries, the same as one device would.
      for (
        let offset = 0;
        offset < accountIds.length;
        offset += REVALIDATION_ACCOUNT_BATCH
      ) {
        const batch = accountIds.slice(
          offset,
          offset + REVALIDATION_ACCOUNT_BATCH,
        );
        const answered = await users.getSocketAccessStates(batch);
        for (const [userId, state] of answered) states.set(userId, state);
      }

      for (const socket of connected) {
        const reason = this.sweepRefusal(
          socket,
          states.get(socket.data.userId),
        );
        if (!reason) continue;

        this.logger.warn(
          `[SyncGateway] Evicting ${socket.id} (User: ${socket.data.userId}): ${reason}.`,
        );
        this.evictSocket(socket, reason);
        evicted += 1;
      }
    } catch (error: any) {
      this.logger.error(
        `[SyncGateway] Socket revalidation could not be answered; connected sockets kept: ${error?.message ?? error}`,
      );
    } finally {
      this.sweeping = false;
    }

    return evicted;
  }

  /**
   * Whether one socket should still be connected, from the batched answer about its
   * account — `null` means keep it.
   *
   * The checks are the handshake's, in the order a reader can verify: is the account
   * still readable, can this socket still name the session it was admitted under, is
   * that session still live, has the device it announced been revoked since. Session
   * and device are matched by id rather than by whether the account was revoked at
   * all, because logging one device out must not be what drops the other four.
   */
  private sweepRefusal(
    socket: AuthenticatedSocket,
    state: SocketAccessState | undefined,
  ): string | null {
    if (!state) {
      // Asked for an account the batch did not report. Keeping the socket is the
      // conservative reading — see the fail-open note on the sweep.
      return null;
    }
    if (!state.accountReadable) {
      return "Account is no longer active";
    }
    if (!socket.data.sessionId) {
      // No skip here, deliberately: a socket that cannot name the session it was
      // admitted under is a socket nothing can revoke, which is the bypass the
      // handshake now refuses. Reaching this line means the token contract
      // changed under this file again, and the safe reading of that is eviction.
      return "Socket carries no session to revalidate";
    }
    if (!state.liveSessionIds.includes(socket.data.sessionId)) {
      return "Session has been revoked or no longer exists";
    }
    if (
      socket.data.deviceId &&
      state.revokedDeviceIds.includes(socket.data.deviceId)
    ) {
      return "Device has been revoked";
    }
    return null;
  }

  private evictSocket(client: AuthenticatedSocket, reason: string): void {
    try {
      client.emit("error", {
        message: `Unauthorized: ${reason}`,
        code: "UNAUTHORIZED",
        subCode: "SESSION_REVOKED",
      });
    } catch {
      // A socket already too far gone to be told why it is being closed is still a
      // socket that must be closed; the emit is courtesy, the disconnect is the fix.
    }

    try {
      client.leave(`user:${client.data.userId}`);
    } catch (err: any) {
      this.logger.debug(
        `[SyncGateway] Could not remove ${client.id} from its room: ${err?.message ?? err}`,
      );
    }

    client.disconnect(true);
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
