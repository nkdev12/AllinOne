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
    const result = await this.recurringService.processDueRules();
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
    const startOfMonth = new Date(
      Date.UTC(now.getFullYear(), now.getMonth(), 1),
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
          let shouldAlert = false;
          let alertMsg = "";

          if (b.alertAt100 && percent >= 100) {
            shouldAlert = true;
            alertMsg = `Budget limit exceeded: you have spent ${b.spentMinor / 100} of your ${b.amountMinor / 100} budget.`;
          } else if (b.alertAt80 && percent >= 80) {
            shouldAlert = true;
            alertMsg = `Budget threshold warning: you have used ${percent.toFixed(1)}% of your budget.`;
          }

          if (shouldAlert) {
            this.logger.warn(
              `[FinanceProcessor] ${alertMsg} for user ${userId}, budget ${b.id}`,
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
