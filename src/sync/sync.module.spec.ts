import { Module, Optional } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { SyncModule } from "./sync.module";
import { SyncGateway } from "./sync.gateway";
import { SyncNotificationService } from "./sync-notification.service";

/**
 * `ConfigurationService` throws in its constructor when these are absent, and
 * `SyncModule` imports `ConfigurationModule`. `ignoreEnvFile` keeps a developer's
 * real `.env` out of it, so this graph compiles the same on CI.
 */
const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: "mongodb://localhost:27017/sync_module_wiring",
  JWT_ACCESS_SECRET: "test-access-secret",
  JWT_REFRESH_SECRET: "test-refresh-secret",
  OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
  OBJECT_STORAGE_ACCESS_KEY: "key",
  OBJECT_STORAGE_SECRET_KEY: "secret",
  OBJECT_STORAGE_BUCKET: "bucket",
  ENCRYPTION_KEY: "x".repeat(32),
};

/**
 * Stands in for the feature modules the notifier exists for, written the way
 * `NotesModule`, `TasksModule`, `CalendarModule` and `AiModule` actually are:
 * they inject `SyncNotificationService` as `@Optional()` and none of them
 * imports `SyncModule`.
 */
class HostService {
  constructor(
    @Optional() readonly syncNotifications?: SyncNotificationService,
  ) {}
}

// Not `@Global()`: the point is that this host sees the notifier only because
// the module it shares a graph with is.
@Module({ providers: [HostService], exports: [HostService] })
class HostModule {}

/**
 * `AppModule`'s global config, which the real graph always has and an isolated
 * `SyncModule` compile otherwise lacks: `ConfigurationService` injects
 * `ConfigService`, and `ConfigurationModule` does not import it because the root
 * is what supplies it. `ignoreEnvFile` keeps a developer's own `.env` out of the
 * result, so this reads the same on CI.
 */
const ROOT_CONFIG = [
  ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
];

/**
 * The wiring decisions `SyncModule` makes, pinned as behaviour instead of as a
 * comment that can drift.
 *
 * Both properties below are load-bearing and invisible from the tests around
 * them. `SyncNotificationService` reaches those four modules only because this
 * module is `@Global()`; `SyncGateway` refuses a revoked session only because
 * `UsersModule` is in its imports. Neither survives someone tidying the module
 * metadata, and neither shows up in a feature's own tests.
 */
describe("SyncModule wiring", () => {
  let restoreEnv: () => void;

  beforeAll(() => {
    const keys = Object.keys(REQUIRED_ENV);
    const previous = new Map(
      keys.map(
        (key) => [key, process.env[key]] as [string, string | undefined],
      ),
    );
    keys.forEach((key) => (process.env[key] = REQUIRED_ENV[key]));
    restoreEnv = () =>
      keys.forEach((key) => {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
  });

  afterAll(() => restoreEnv());

  it("reaches a host module that never imports SyncModule", async () => {
    // The `@Global()` claim. Drop the decorator and this host's optional
    // injection goes undefined: every write path keeps committing and every
    // other device keeps learning about it at its next pull, which is the exact
    // behaviour the notifier exists to remove. It fails no request, no type and
    // no test around it — so it is asserted here.
    const module = await Test.createTestingModule({
      imports: [...ROOT_CONFIG, SyncModule, HostModule],
    }).compile();

    const host = module.get(HostService);
    expect(host.syncNotifications).toBeInstanceOf(SyncNotificationService);
    // The same instance, not a second notifier holding a second gateway: one
    // choke point is the design.
    expect(host.syncNotifications).toBe(module.get(SyncNotificationService));

    await module.close();
  });

  it("still constructs a host when SyncModule is absent altogether", async () => {
    // The other half of `@Global()`, and the half that has to stay true: the
    // queue worker compiles no `SyncModule`, and its writes must still boot.
    // Global is about resolvability when the module is present, never about
    // making it required.
    const module = await Test.createTestingModule({
      imports: [HostModule],
    }).compile();

    expect(module.get(HostService).syncNotifications).toBeUndefined();

    await module.close();
  });

  it("gives the gateway the account lookups its handshake depends on", async () => {
    // `SyncGateway` injects `UsersService` as `@Optional()` so a graph without
    // users still constructs it — and its revalidation answers "Account
    // revalidation is unavailable", i.e. refuses every connection, when it did
    // not arrive. So a dropped `UsersModule` import here takes the namespace
    // down rather than loosening it, which is the opposite of what the optional
    // injection on the notifier means.
    const module = await Test.createTestingModule({
      imports: [...ROOT_CONFIG, SyncModule],
    }).compile();

    expect(module.get(SyncGateway)["usersService"]).toBeDefined();

    await module.close();
  });
});
