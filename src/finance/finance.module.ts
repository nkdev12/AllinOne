import { Module } from "@nestjs/common";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { AccountsController } from "./accounts/accounts.controller";
import { AccountsService } from "./accounts/accounts.service";
import { CategoriesController } from "./categories/categories.controller";
import { CategoriesService } from "./categories/categories.service";
import { TransactionsController } from "./transactions/transactions.controller";
import { TransactionsService } from "./transactions/transactions.service";
import { BudgetsController } from "./budgets/budgets.controller";
import { BudgetsService } from "./budgets/budgets.service";
import { GoalsController } from "./goals/goals.controller";
import { GoalsService } from "./goals/goals.service";
import { RecurringController } from "./recurring/recurring.controller";
import { RecurringService } from "./recurring/recurring.service";
import { GroupsController } from "./groups/groups.controller";
import { GroupsService } from "./groups/groups.service";
import { TripsController } from "./trips/trips.controller";
import { TripsService } from "./trips/trips.service";
import { LoansController } from "./loans/loans.controller";
import { LoansService } from "./loans/loans.service";
import { AnalyticsController } from "./analytics/analytics.controller";
import { AnalyticsService } from "./analytics/analytics.service";
import { SyncNotificationService } from "@/sync/sync-notification.service";

@Module({
  imports: [PrismaModule],
  controllers: [
    AccountsController,
    CategoriesController,
    TransactionsController,
    BudgetsController,
    GoalsController,
    RecurringController,
    GroupsController,
    TripsController,
    LoansController,
    AnalyticsController,
  ],
  providers: [
    AccountsService,
    CategoriesService,
    TransactionsService,
    BudgetsService,
    GoalsService,
    RecurringService,
    GroupsService,
    TripsService,
    LoansService,
    AnalyticsService,
    SyncNotificationService,
  ],
  exports: [
    AccountsService,
    CategoriesService,
    TransactionsService,
    BudgetsService,
    GoalsService,
    RecurringService,
    GroupsService,
    TripsService,
    LoansService,
    AnalyticsService,
  ],
})
export class FinanceModule {}
