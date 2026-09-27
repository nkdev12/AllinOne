import { Test, TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bull";
import { WorkerModule } from "./worker.module";
import { PrismaService } from "@/common/prisma/prisma.service";
import { MailService } from "@/common/mail/mail.service";
import { MailProcessor } from "@/queues/processors/mail.processor";
import { NotificationProcessor } from "@/queues/processors/notification.processor";
import { ExportProcessor } from "@/queues/processors/export.processor";
import { MaintenanceProcessor } from "@/queues/processors/maintenance.processor";

/**
 * Compile-time wiring test for the background worker.
 *
 * `Test.createTestingModule({ imports: [WorkerModule] }).compile()` instantiates
 * every provider in the worker's module graph, so this fails loudly at exactly
 * the two places the old `toBeDefined()` test could not see:
 *
 * 1. each `BullQueue_<name>` token must resolve, i.e. `BullModule.registerQueue`
 *    is reachable from WorkerModule and named the queue the same way the
 *    `@Processor()` classes and `worker.ts` ask for it;
 * 2. each `@Processor` class must be constructible from that same container,
 *    i.e. its Prisma/Mail dependencies are actually exported to QueuesModule.
 *
 * Infrastructure is stubbed, never reached: the four Bull queues are replaced
 * with recording doubles (so no ioredis socket is opened), and PrismaService and
 * MailService are replaced before their constructors can connect to Mongo or
 * verify SMTP. No Redis, no MongoDB, no network.
 */

const QUEUE_NAMES = ["maintenance", "mail", "notification", "export"] as const;
type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * WorkerModule boots `ConfigModule.forRoot` with a Joi schema that aborts on a
 * missing required variable, and ConfigurationService re-checks eight of them.
 * Declaring every key here keeps the test independent of whatever `.env` happens
 * to exist on the machine: `@nestjs/config` merges as `{ ...envFile, ...process.env }`,
 * so these values always win.
 */
const WORKER_ENV: Record<string, string> = {
  APP_ENV: "development",
  DATABASE_URL: "mongodb://localhost:27017/worker_wiring_test",
  REDIS_URL: "redis://localhost:6379",
  JWT_ACCESS_SECRET: "test-access-secret",
  JWT_REFRESH_SECRET: "test-refresh-secret",
  OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
  OBJECT_STORAGE_ACCESS_KEY: "test-access-key",
  OBJECT_STORAGE_SECRET_KEY: "test-secret-key",
  OBJECT_STORAGE_BUCKET: "test-bucket",
  ENCRYPTION_KEY: "x".repeat(32),
  SMTP_HOST: "localhost",
  SMTP_PORT: "587",
  SMTP_USER: "",
  SMTP_PASSWORD: "",
  SMTP_FROM: "noreply@localhost",
  SMTP_TLS: "false",
};

/** Stand-in for a Bull `Queue`: records what the module graph hands out. */
interface FakeQueue {
  name: string;
  process: jest.Mock;
  on: jest.Mock;
  add: jest.Mock;
  close: jest.Mock;
}

function createFakeQueue(name: QueueName): FakeQueue {
  return {
    name,
    process: jest.fn(),
    on: jest.fn(),
    add: jest.fn().mockResolvedValue({ id: `${name}-job` }),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function createFakePrisma() {
  return {
    $disconnect: jest.fn().mockResolvedValue(undefined),
    session: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    idempotencyKey: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    change: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    device: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
  };
}

function createFakeMailService() {
  return {
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendPasswordResetOtpEmail: jest.fn().mockResolvedValue(undefined),
  };
}

describe("WorkerModule (queue wiring)", () => {
  const envKeys = Object.keys(WORKER_ENV);
  const originalEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    envKeys.forEach((key) => originalEnv.set(key, process.env[key]));
    Object.entries(WORKER_ENV).forEach(([key, value]) => {
      process.env[key] = value;
    });
  });

  afterAll(() => {
    envKeys.forEach((key) => {
      const previous = originalEnv.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    });
  });

  async function compileWorkerModule(): Promise<{
    module: TestingModule;
    queues: Record<QueueName, FakeQueue>;
  }> {
    const queues = {
      maintenance: createFakeQueue("maintenance"),
      mail: createFakeQueue("mail"),
      notification: createFakeQueue("notification"),
      export: createFakeQueue("export"),
    } as Record<QueueName, FakeQueue>;

    const builder = Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(PrismaService)
      .useValue(createFakePrisma())
      .overrideProvider(MailService)
      .useValue(createFakeMailService());

    // Overrides are applied by token and silently skipped when the token is
    // absent, so the identity assertions below can only pass if the real
    // `BullModule.registerQueue({ name })` provider is in this graph.
    QUEUE_NAMES.forEach((name) => {
      builder.overrideProvider(getQueueToken(name)).useValue(queues[name]);
    });

    return { module: await builder.compile(), queues };
  }

  it("registers all four Bull queue tokens in the worker graph", async () => {
    const { module, queues } = await compileWorkerModule();

    QUEUE_NAMES.forEach((name) => {
      expect(module.get<FakeQueue>(getQueueToken(name))).toBe(queues[name]);
    });

    await module.close();
  });

  it("instantiates every queue processor from the compiled container", async () => {
    const { module } = await compileWorkerModule();

    expect(module.get(MailProcessor)).toBeInstanceOf(MailProcessor);
    expect(module.get(NotificationProcessor)).toBeInstanceOf(
      NotificationProcessor,
    );
    expect(module.get(ExportProcessor)).toBeInstanceOf(ExportProcessor);
    expect(module.get(MaintenanceProcessor)).toBeInstanceOf(
      MaintenanceProcessor,
    );

    await module.close();
  });
});
