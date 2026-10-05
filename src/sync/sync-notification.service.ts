import { Injectable, Logger, Optional } from "@nestjs/common";
import { SyncGateway } from "./sync.gateway";

/**
 * One mutation a REST write path just committed, in the words the wake-up needs.
 */
export interface SyncMutationNotice {
  userId: string;
  /**
   * The device that made the write, when the request carried one. Every REST
   * write path in this app is device-blind today — no controller, DTO or header
   * names a device — so in practice this is only ever set by `/sync/push`, and
   * leaving it out is what makes the gateway log say "Server" rather than
   * guessing at an id.
   */
  originDeviceId?: string;
  /**
   * End of the caller's change log after its row was appended, i.e. the cursor
   * the other devices have not read yet. `appendChange` hands this back for
   * exactly this purpose; absent, the payload says "0" and a device still pulls
   * from its own checkpoint, so this is a hint and never a permission.
   */
  highestCursor?: string | bigint;
}

/**
 * The one place that wakes the other devices after a write.
 *
 * `SyncGateway.notifySyncInvalidation` had a single caller — `SyncService.pushChanges`
 * — so a change that reached the log through REST (`POST /notes`, `PATCH /tasks/:id`,
 * the calendar writes, all of which append their `Change` row inside their own
 * transaction) woke nobody: every other device learned of it at its next pull,
 * which for a device that is not on a timer is "when the user says so".
 *
 * Every one of those services now calls this after its transaction resolves. The
 * gateway itself stays out of their modules: the notifier wraps it, is optional
 * in both directions, and cannot make a request fail.
 */
@Injectable()
export class SyncNotificationService {
  private readonly logger = new Logger(SyncNotificationService.name);

  /**
   * `@Optional()` because the notifier is exported to modules that do not own a
   * WebSocket server at all (the queue worker compiles no `SyncModule`), and
   * because a module compiled for a unit test has no gateway to inherit.
   */
  constructor(@Optional() private readonly syncGateway?: SyncGateway) {}

  /**
   * Fire-and-forget by design, and synchronous on purpose: nothing on this path
   * may await on a socket, because the caller has already committed the write it
   * is reporting.
   */
  notifyMutation(notice: SyncMutationNotice): void {
    if (!notice?.userId) {
      return;
    }

    if (!this.syncGateway) {
      // Not a failure. The row is in the log, so the next pull still delivers it;
      // what is missing is the push that would have made it arrive now.
      this.logger.debug(
        `[sync-invalidate] No WebSocket gateway bound; skipped the wake-up for user ${notice.userId}. Other devices catch up on their next pull.`,
      );
      return;
    }

    try {
      this.syncGateway.notifySyncInvalidation(
        notice.userId,
        notice.originDeviceId,
        notice.highestCursor === undefined
          ? undefined
          : notice.highestCursor.toString(),
      );
    } catch (error: any) {
      // The gateway's own emit path is not a transaction the caller can roll
      // back, and a user whose note saved successfully must not be shown a 500
      // because the broadcast behind it threw.
      this.logger.warn(
        `[sync-invalidate] Emitting the wake-up for user ${notice.userId} failed: ${error?.message || error}`,
      );
    }
  }
}
