import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app/app.module";
import { getQueueToken } from "@nestjs/bull";
import { Queue } from "bull";

/**
 * Distributed Background Worker Process
 *
 * Backed by Redis & BullMQ Distributed Job Queues:
 * - Mail Queue ('mail')
 * - Notification Queue ('notification')
 * - Export Processing Queue ('export')
 * - Maintenance & Cleanup Queue ('maintenance')
 *
 * Run with: npm run start (in worker container or process)
 */

async function bootstrap() {
  const logger = new Logger("Worker");

  const app = await NestFactory.create(AppModule, {
    logger: ["log", "error", "warn"],
  });

  logger.log("🔄 Allinone BullMQ Distributed Background Worker starting...");

  await app.init();

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
    logger.warn(
      `Worker queue scheduling warning (Redis connection may be mock/offline): ${err.message}`,
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
}

bootstrap().catch((error) => {
  console.error("Failed to start BullMQ worker:", error);
  process.exit(1);
});
