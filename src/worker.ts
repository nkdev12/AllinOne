import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bull";
import { Queue } from "bull";
import { WorkerModule } from "./worker.module";

/**
 * Distributed Background Worker Process
 *
 * Backed by Redis & Bull distributed job queues, all owned by WorkerModule:
 * - Mail Queue ('mail')
 * - Notification Queue ('notification')
 * - Export Processing Queue ('export')
 * - Maintenance & Cleanup Queue ('maintenance')
 *
 * WorkerModule — not AppModule — is the root here on purpose: `BullModule.forRoot`,
 * the four `registerQueue` calls and every `@Processor` class live inside
 * QueuesModule, which only WorkerModule imports. Bootstrapping AppModule instead
 * leaves the processors uninstantiated and the queue tokens unresolvable, so the
 * process idles without consuming anything.
 *
 * This is a headless context (`createApplicationContext`), so no HTTP adapter is
 * created and the process never binds a port.
 *
 * Run with: node dist/worker.js (see Dockerfile.worker)
 */

export async function bootstrap() {
  const logger = new Logger("Worker");

  // Lifecycle hooks (`onModuleInit`, `onApplicationBootstrap`) have already run
  // by the time this resolves — that is what registers each `@Process` handler
  // against its Bull queue. A queue missing from this graph makes Nest throw
  // here rather than quietly doing nothing.
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ["log", "error", "warn"],
  });

  logger.log("🔄 Allinone BullMQ Distributed Background Worker starting...");
  logger.log("✓ Worker application context initialized");

  try {
    const maintenanceQueue = app.get<Queue>(getQueueToken("maintenance"));

    // Enqueue startup maintenance job with retry configuration
    await maintenanceQueue.add(
      "cleanup-expired",
      {},
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: true,
      },
    );

    // Schedule repeatable maintenance queue job (hourly)
    await maintenanceQueue.add(
      "cleanup-expired",
      {},
      {
        repeat: { every: 60 * 60 * 1000 },
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: true,
      },
    );

    logger.log(
      "✓ BullMQ Maintenance Queue initialized with repeatable hourly scheduled cleanup.",
    );
  } catch (err: any) {
    // The queue itself is guaranteed to exist at this point (Nest would have
    // failed to boot otherwise), so this is a Redis transport problem: the
    // worker still consumes jobs already on the queue, it just cannot schedule.
    logger.error(
      "Failed to schedule startup maintenance on the 'maintenance' queue. " +
        `Redis may be unreachable: ${err?.message}`,
      err?.stack,
    );
  }

  logger.log("Worker ready and listening for BullMQ distributed jobs.");

  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}. Gracefully closing background worker...`);
    await app.close();
    logger.log("Worker shutdown complete.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return app;
}

// Only start when this file is the process entry point (`node dist/worker.js`).
// Guarded so the boot spec can drive bootstrap() explicitly.
if (require.main === module) {
  bootstrap().catch((error) => {
    console.error("Failed to start BullMQ worker:", error);
    process.exit(1);
  });
}
