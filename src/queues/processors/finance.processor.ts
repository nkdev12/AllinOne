import { Processor, Process } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RecurringService } from "@/finance/recurring/recurring.service";
import { BudgetsService } from "@/finance/budgets/budgets.service";

@Processor("finance")
export class FinanceProcessor {
  private readonly logger = new Logger(FinanceProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recurringService: RecurringService,
    private readonly budgetsService: BudgetsService,
  ) {}

  @Process("process-recurring")
  async handleProcessRecurring(job: Job) {
    this.logger.log(
      `[FinanceProcessor] Processing due recurring rules... Job #${job.id}`,
    );
    const result = await this.recurringService.processAllDueRules();
    this.logger.log(
      `[FinanceProcessor] Processed ${result.processed} due recurring rules.`,
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
            alertsGenerated++;
          }
        }
      }
    }

    return { alertsGenerated };
  }
}
