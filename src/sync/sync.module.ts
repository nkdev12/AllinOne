import { Global, Module } from "@nestjs/common";
import { SyncController } from "./sync.controller";
import { SyncService } from "./sync.service";
import { SyncGateway } from "./sync.gateway";
import { SyncNotificationService } from "./sync-notification.service";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { UsersModule } from "@/users/users.module";
import { JwtModule } from "@nestjs/jwt";
import { ConfigurationModule } from "@/config/configuration.module";
import { MetricsModule } from "@/common/metrics/metrics.module";

/**
 * `@Global()` for one reason: `SyncNotificationService` is the choke point every
 * REST write path calls after it appends a `Change` row, and the alternative —
 * `NotesModule`, `TasksModule` and `CalendarModule` each importing `SyncModule`
 * — drags this module's `JwtModule` and `ConfigurationModule` into every unit
 * graph those three compile, which is how a wiring change turns into a test-suite
 * failure with no behaviour behind it. `CollaborationModule` is global for the
 * same shape of reason and `NotesService`'s optional injection already depends on
 * that; `src/sync/sync.module.spec.ts` pins the same property here.
 *
 * Global is about *resolvability*, not about liveliness: the notifier is still
 * `@Optional()` on the caller's side, so a graph that never registers this
 * module (the queue worker) loses the wake-up and nothing else.
 */
@Global()
@Module({
  imports: [
    PrismaModule,
    // `SyncGateway` revalidates a handshake the way `JwtStrategy` does — account
    // status and session liveness — and both reads live on `UsersService`, which
    // `UsersModule` already exports. The edge runs one way: `UsersModule` imports
    // only `PrismaModule`, so nothing here closes a circle back onto `SyncModule`
    // and no `forwardRef()` is needed.
    UsersModule,
    JwtModule.register({}),
    ConfigurationModule,
    MetricsModule,
  ],
  controllers: [SyncController],
  providers: [SyncService, SyncGateway, SyncNotificationService],
  exports: [SyncService, SyncGateway, SyncNotificationService],
})
export class SyncModule {}
