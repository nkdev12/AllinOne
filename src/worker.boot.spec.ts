import { NestFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { bootstrap } from "./worker";
import { WorkerModule } from "./worker.module";
import { PrismaService } from "@/common/prisma/prisma.service";
import { MailService } from "@/common/mail/mail.service";
import { MailProcessor } from "@/queues/processors/mail.processor";
import { NotificationProcessor } from "@/queues/processors/notification.processor";
import { ExportProcessor } from "@/queues/processors/export.processor";
import { MaintenanceProcessor } from "@/queues/processors/maintenance.processor";
import { FinanceProcessor } from "@/queues/processors/finance.processor";

/**
 * Boot tests for the background worker.
 *
 * Part 1 pins the process entry point: `worker.ts` must hand WorkerModule to a
 * headless Nest context (no HTTP server, no `listen()`), schedule its startup
 * maintenance job on the resolved `BullQueue_maintenance` token, and report a
 * scheduling failure instead of swallowing it.
 *
 * Part 2 pins what a real Nest boot does with that graph: `init()` runs
 * `onModuleInit`, which is where @nestjs/bull's explorer binds every `@Process`
 * handler to its queue. Registering all four handlers is only possible when the
 * queue providers and the processor providers live in one instantiated graph —
 * exactly the property that silently broke when the worker bootstrapped
 * AppModule. Handlers are then invoked against recording doubles, so the whole
 * file needs neither Redis nor MongoDB.
 */

const QUEUE_NAMES = [
  "maintenance",
  "mail",
  "notification",
  "export",
  "finance",
] as const;
type QueueName = (typeof QUEUE_NAMES)[number];

/** See the note in worker.module.spec.ts: process.env shadows any `.env` file. */
const WORKER_ENV: Record<string, string> = {
  APP_ENV: "development",
  DATABASE_URL: "mongodb://localhost:27017/worker_boot_test",
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
    add: jest.fn().mockResolvedValue({ id: `${name}-job-1` }),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function createFakeQueues(): Record<QueueName, FakeQueue> {
  return {
    maintenance: createFakeQueue("maintenance"),
    mail: createFakeQueue("mail"),
    notification: createFakeQueue("notification"),
    export: createFakeQueue("export"),
    finance: createFakeQueue("finance"),
  };
}

function createFakePrisma() {
  return {
    onModuleDestroy: jest.fn().mockResolvedValue(undefined),
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

/** Compiles WorkerModule with Bull/Prisma/SMTP infrastructure replaced. */
async function compileHeadlessWorker() {
  const queues = createFakeQueues();
  const prisma = createFakePrisma();

  const builder = Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .overrideProvider(MailService)
    .useValue(createFakeMailService());

  QUEUE_NAMES.forEach((name) => {
    builder.overrideProvider(getQueueToken(name)).useValue(queues[name]);
  });

  return { module: await builder.compile(), queues, prisma };
}

/** Job names each processor exposes through its @Process decorators. */
function registeredJobs(queue: FakeQueue): Array<[string, jest.Mock]> {
  return queue.process.mock.calls.map((call: any[]) => [
    call[0] as string,
    call[call.length - 1],
  ]);
}

describe("Worker bootstrap (entry point)", () => {
  const envKeys = Object.keys(WORKER_ENV);
  const originalEnv = new Map<string, string | undefined>();
  const signalNames = ["SIGTERM", "SIGINT"] as const;
  const signalBaseline = new Map<string, number>();

  beforeAll(() => {
    envKeys.forEach((key) => originalEnv.set(key, process.env[key]));
    Object.entries(WORKER_ENV).forEach(([key, value]) => {
      process.env[key] = value;
    });
    signalNames.forEach((signal) =>
      signalBaseline.set(signal, process.listenerCount(signal)),
    );
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
    // bootstrap() installs its own signal handlers; drop just those.
    signalNames.forEach((signal) => {
      const listeners = process.listeners(signal as NodeJS.Signals);
      listeners
        .slice(signalBaseline.get(signal) ?? 0)
        .forEach((listener) =>
          process.removeListener(signal as NodeJS.Signals, listener),
        );
    });
    jest.restoreAllMocks();
  });

  it("bootstraps WorkerModule headlessly and never starts an HTTP server", async () => {
    const queues = createFakeQueues();
    const context = {
      get: jest.fn((token: string) =>
        token === getQueueToken("maintenance") ? queues.maintenance : undefined,
      ),
      close: jest.fn().mockResolvedValue(undefined),
      listen: jest.fn(),
    };
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const createContextSpy = jest
      .spyOn(NestFactory, "createApplicationContext")
      .mockResolvedValue(context as never);
    const httpCreateSpy = jest.spyOn(NestFactory, "create");

    await bootstrap();

    // The queue owners live in WorkerModule; AppModule has no Bull providers.
    expect(createContextSpy).toHaveBeenCalledTimes(1);
    expect(createContextSpy.mock.calls[0][0]).toBe(WorkerModule);
    // A headless context means there is no adapter to bind a port to.
    expect(httpCreateSpy).not.toHaveBeenCalled();
    expect(context.listen).not.toHaveBeenCalled();

    expect(queues.maintenance.add).toHaveBeenCalledWith(
      "cleanup-expired",
      {},
      expect.objectContaining({ attempts: 3 }),
    );
    expect(queues.maintenance.add).toHaveBeenCalledWith(
      "cleanup-expired",
      {},
      expect.objectContaining({ repeat: { every: 60 * 60 * 1000 } }),
    );

    // Graceful shutdown is wired to the process signals the containers send.
    const sigTerm = process
      .listeners("SIGTERM")
      .slice(signalBaseline.get("SIGTERM") ?? 0);
    expect(sigTerm.length).toBeGreaterThan(0);
    await (sigTerm[sigTerm.length - 1] as () => Promise<void>)();
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("logs an error when the maintenance queue cannot be scheduled", async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    jest.spyOn(NestFactory, "createApplicationContext").mockResolvedValue({
      get: jest.fn(() => {
        throw new Error("Queue does not exist");
      }),
      close: jest.fn().mockResolvedValue(undefined),
    } as never);

    await bootstrap();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("maintenance"),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });
});

describe("Worker graph lifecycle (queue/processor binding)", () => {
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

  it("binds every @Process handler to its queue when the context initialises", async () => {
    const { module, queues } = await compileHeadlessWorker();

    // NestApplicationContext.init() is what createApplicationContext() calls, and
    // @nestjs/bull registers handlers during onModuleInit.
    await module.init();

    // All five processors are live instances of this container...
    expect(module.get(MailProcessor)).toBeInstanceOf(MailProcessor);
    expect(module.get(NotificationProcessor)).toBeInstanceOf(
      NotificationProcessor,
    );
    expect(module.get(ExportProcessor)).toBeInstanceOf(ExportProcessor);
    expect(module.get(MaintenanceProcessor)).toBeInstanceOf(
      MaintenanceProcessor,
    );
    expect(module.get(FinanceProcessor)).toBeInstanceOf(FinanceProcessor);

    // ...and every one of their @Process handlers reached its own queue.
    const maintenanceJobs = registeredJobs(queues.maintenance);
    const mailJobs = registeredJobs(queues.mail);
    const notificationJobs = registeredJobs(queues.notification);
    const exportJobs = registeredJobs(queues.export);
    const financeJobs = registeredJobs(queues.finance);

    expect(maintenanceJobs).toHaveLength(1);
    expect(mailJobs).toHaveLength(2);
    expect(notificationJobs).toHaveLength(1);
    expect(exportJobs).toHaveLength(1);
    expect(financeJobs).toHaveLength(2);

    expect(maintenanceJobs.map(([name]) => name)).toEqual(["cleanup-expired"]);
    expect(mailJobs.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        "send-verification-email",
        "send-password-reset-email",
      ]),
    );
    expect(notificationJobs.map(([name]) => name)).toEqual([
      "send-notification",
    ]);
    expect(exportJobs.map(([name]) => name)).toEqual(["process-export"]);
    expect(financeJobs.map(([name]) => name)).toEqual(
      expect.arrayContaining(["process-recurring", "check-budget-alerts"]),
    );

    await module.close();
  });

  it("runs the maintenance handler that the queue was given, against the container's Prisma", async () => {
    const { module, queues, prisma } = await compileHeadlessWorker();

    await module.init();

    const [jobName, handler] = registeredJobs(queues.maintenance)[0];
    expect(jobName).toBe("cleanup-expired");
    // The explorer binds the method to the instance resolved from the container,
    // so this is the same MaintenanceProcessor the worker will invoke on a job.
    expect(typeof handler).toBe("function");

    await handler({ id: "boot-test-job", data: {} });

    expect(prisma.session.deleteMany).toHaveBeenCalled();
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalled();
    expect(prisma.change.groupBy).toHaveBeenCalled();

    await module.close();

    // Shutdown drains module destroy hooks — PrismaService.$disconnect lives here.
    expect(prisma.onModuleDestroy).toHaveBeenCalled();
  });
});
