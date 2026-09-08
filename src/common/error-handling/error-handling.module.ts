import { Module } from "@nestjs/common";
import { AllExceptionsFilter } from "./filters/all-exceptions.filter";
import { APP_FILTER } from "@nestjs/core";

@Module({
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class ErrorHandlingModule {}
