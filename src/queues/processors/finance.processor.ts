import { Processor, Process, InjectQueue } from "@nestjs/bull";
import { Logger, Optional } from "@nestjs/common";
import { Job, Queue } from "bull";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  RECURRING_CRON_CATCH_UP_WINDOW_DAYS,
  RecurringService,
} from "@/finance/recurring/recurring.service";
import { BudgetsService } from "@/finance/budgets/budgets.service";

@Processor("finance")
export class FinanceProcessor {
  private readonly logger = new Logger(FinanceProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recurringService: RecurringService,
    private readonly budgetsService: BudgetsService,
    @Optional()
    @InjectQueue("notification")
    private readonly notificationQueue?: Queue,
  ) {}

  @Process("process-recurring")
  async handleProcessRecurring(job: Job) {
    // Catch-up, not generation. The phone owns recurring generation because the
    // app has to work offline (`allmynote_frontend/lib/repositories/
    // finance_recurring_repository.dart` runs the same schedule on a 1-minute
    // ticker), so this tick exists only to pick up a bill that came due while
    // every device was connected but idle. `processAllDueRules` is bounded to
    // `RECURRING_CRON_CATCH_UP_WINDOW_DAYS` for that reason and shares one
    // implementation with `POST /finance/recurring/process-due`, which is
    // idempotent per occurrence: a restart that re-runs the startup job, or a
    // route and a tick racing each other, mints one bill rather than two.
    this.logger.log(
      `[FinanceProcessor] Catching up recurring rules due in the last ${RECURRING_CRON_CATCH_UP_WINDOW_DAYS} day(s)... Job #${job.id}`,
    );
    const result = await this.recurringService.processAllDueRules();
    this.logger.log(
      `[FinanceProcessor] Generated ${result.processed} recurring transaction(s) for job #${job.id}.`,
    );
    return result;
  }

  @Process("check-budget-alerts")
  async handleCheckBudgetAlerts(job: Job) {
    this.logger.log(
      `[FinanceProcessor] Checking budget thresholds... Job #${job.id}`,
    );
    const now = new Date();
    // `BudgetsService.getBudgetsWithSpending` builds its window with `Date.UTC`,
    // so the alert cycle has to start on the UTC first of the month too. Using
    // the local `getMonth()`/`getFullYear()` here made the two disagree either
    // side of a month boundary in a non-UTC zone: in +05:30 the first hours of
    // a UTC month were compared against the previous month's spend window, so a
    // fresh-cycle budget was judged against stale spending and re-alerted.
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    );

    const usersWithBudgets = await this.prisma.financeBudget.findMany({
      where: { deletedAt: null },
      select: { userId: true },
      distinct: ["userId"],
    });

    let alertsGenerated = 0;

    for (const { userId } of usersWithBudgets) {
      const budgetsWithSpending =
        await this.budgetsService.getBudgetsWithSpending(userId);

      for (const b of budgetsWithSpending) {
        const percent = b.percentUsed;
        const alreadyAlertedThisCycle =
          b.alertSentAt && new Date(b.alertSentAt) >= startOfMonth;

        if (!alreadyAlertedThisCycle) {
          let thresholdCrossed: "exceeded" | "warning" | null = null;

          if (b.alertAt100 && percent >= 100) {
            thresholdCrossed = "exceeded";
          } else if (b.alertAt80 && percent >= 80) {
            thresholdCrossed = "warning";
          }

          if (thresholdCrossed) {
            // Spend and limit amounts are financial data and this line ships to
            // the cluster's log aggregator, so only the threshold event plus the
            // ids needed to trace it are logged.
            this.logger.warn(
              `[FinanceProcessor] Budget limit ${thresholdCrossed} for user ${userId}, budget ${b.id}`,
            );
            await this.prisma.financeBudget.update({
              where: { id: b.id },
              data: { alertSentAt: now },
            });
            if (this.notificationQueue) {
              await this.notificationQueue.add(
                "send-notification",
                {
                  userId,
                  title:
                    thresholdCrossed === "exceeded"
                      ? "Budget Exceeded"
                      : "Budget Warning",
                  body:
                    thresholdCrossed === "exceeded"
                      ? "You have exceeded 100% of your budget limit."
                      : `You have reached ${percent}% of your budget limit.`,
                  channel: "NOTIFICATION",
                  metadata: {
                    budgetId: b.id,
                    threshold: thresholdCrossed,
                    percentUsed: percent,
                  },
                },
                {
                  attempts: 3,
                  backoff: { type: "exponential", delay: 3000 },
                  removeOnComplete: true,
                },
              );
            }
            alertsGenerated++;
          }
        }
      }
    }

    return { alertsGenerated };
  }
}
